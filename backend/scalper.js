// ================================================================
// scalper.js — Moteur de scalping v1.4 (bugfixes)
// Architecture: boucles SÉPARÉES pour TP/SL (rapide) et analyse (lent)
// ================================================================
const binance = require('./binance-futures');
const { scalpAnalyze } = require('./scalp-strategy');
const { logger, tradeLogger } = require('./logger');

class Scalper {
  constructor() {
    this.pairs        = (process.env.TRADE_PAIRS || 'BTCUSDT,ETHUSDT').split(',').map(s => s.trim());
    this.amount       = parseFloat(process.env.TRADE_AMOUNT_USDT || 20);
    this.maxPositions = parseInt(process.env.MAX_POSITIONS || 3);
    this.tpPct        = parseFloat(process.env.TAKE_PROFIT_PCT || 0.4) / 100;
    this.slPct        = parseFloat(process.env.STOP_LOSS_PCT   || 0.25) / 100;
    this.trailingStop = process.env.TRAILING_STOP === 'true';
    this.trailActPct  = parseFloat(process.env.TRAILING_ACTIVATION_PCT || 0.2) / 100;
    this.trailDistPct = parseFloat(process.env.TRAILING_DISTANCE_PCT   || 0.15) / 100;
    this.scanInterval = parseInt(process.env.SCAN_INTERVAL_MS || 5000);
    this.maxDailyLoss = parseFloat(process.env.MAX_DAILY_LOSS  || 50);
    this.cooldownMs   = parseInt(process.env.TRADE_COOLDOWN_MS || 20000);
    this.maxHourly    = parseInt(process.env.MAX_TRADES_PER_HOUR || 10);

    // État
    this.isRunning     = false;
    this._starting     = false;
    this.positions     = new Map();
    this.trades        = [];
    this.pairData      = {};
    this.lastTradeTime = {};
    this.hourlyTrades  = {};
    this.pairErrors    = {};
    this.pairBlacklist = {};
    this.dailyPnl      = 0;
    this.dailyReset    = new Date().setHours(0,0,0,0);
    this.balance       = 0;
    this.startBalance  = 0;
    this._posCounter   = 0;
    this.stats = { totalPnl:0, wins:0, losses:0, bestTrade:0, worstTrade:0, totalTrades:0, longTrades:0, shortTrades:0, totalDuration:0, avgDuration:0 };

    // ── FIX: Verrou par paire pour éviter les doubles ouvertures (race condition) ──
    this._openingPairs = new Set();

    // Timers séparés
    this._priceTimer  = null;
    this._scanTimer   = null;
    this._candleTimer = null;

    this.wsListeners = new Set();
  }

  // ================================================================
  // START / STOP
  // ================================================================
  async start() {
    if (this.isRunning) return { success: false, message: 'Déjà en marche' };
    try {
      logger.info(`🚀 Scalper démarrage | Paires: ${this.pairs.join(',')} | MaxPos: ${this.maxPositions}`);

      await binance.syncTime();
      const conn = await binance.testConnection();
      if (!conn.success) throw new Error(conn.error);

      this.balance = conn.balance.available;
      this.startBalance = this.balance;

      for (const pair of this.pairs) {
        try { await binance.setLeverage(pair, parseInt(process.env.LEVERAGE || 3)); } catch {}
        try { await binance.setMarginType(pair, 'ISOLATED'); } catch {}
        this.lastTradeTime[pair] = 0;
        this.hourlyTrades[pair]  = [];
        this.pairData[pair]      = { candles: [], price: 0, orderBook: null, analysis: null };
      }

      await this._loadCandles();
      await this._fetchPrices();

      this.isRunning = true;
      this._broadcast({ type: 'STATUS', data: { running: true, balance: this.balance } });
      logger.info(`✅ Scalper prêt | Balance: ${this.balance.toFixed(2)} USDT`);

      this._priceTimer  = setInterval(() => this._priceAndTPSLLoop(), 1500);
      this._scanTimer   = setInterval(() => this._analysisLoop(), this.scanInterval);
      this._candleTimer = setInterval(() => this._loadCandles(), 30000);

      await this._analysisLoop();

      return { success: true, balance: this.balance };
    } catch (err) {
      logger.error(`❌ Start: ${err.message}`);
      this.isRunning = false;
      return { success: false, error: err.message };
    }
  }

  async stop() {
    this.isRunning = false;
    clearInterval(this._priceTimer);
    clearInterval(this._scanTimer);
    clearInterval(this._candleTimer);
    logger.info(`🛑 Scalper arrêté | P&L: ${this.stats.totalPnl >= 0 ? '+' : ''}${this.stats.totalPnl.toFixed(4)}$`);
    this._broadcast({ type: 'STATUS', data: { running: false } });
    return { success: true };
  }

  async emergencyClose() {
    logger.warn('🚨 FERMETURE URGENCE de toutes les positions');
    for (const pos of this.positions.values()) {
      try { await this._closePosition(pos, pos.currentPrice || pos.entryPrice, 'EMERGENCY'); }
      catch (e) { logger.error(`Urgence close ${pos.symbol}: ${e.message}`); }
    }
  }

  // ================================================================
  // BOUCLE 1 — PRIX + TP/SL (1.5s)
  // ================================================================
  async _priceAndTPSLLoop() {
    if (!this.isRunning) return;
    try {
      await this._fetchPrices();

      // ── FIX: Itérer sur une copie des valeurs pour éviter les mutations pendant l'itération ──
      const openPositions = [...this.positions.values()];

      for (const pos of openPositions) {
        // ── FIX: Re-vérifier que la position existe toujours (peut avoir été fermée en parallèle) ──
        if (!this.positions.has(pos.id)) continue;

        const price = this.pairData[pos.symbol]?.price;
        if (!price || price <= 0) continue;

        pos.currentPrice = price;

        const leverage = parseInt(process.env.LEVERAGE || 3);
        pos.currentPnl = pos.side === 'LONG'
          ? (price - pos.entryPrice) / pos.entryPrice * pos.amount * leverage
          : (pos.entryPrice - price) / pos.entryPrice * pos.amount * leverage;

        // TAKE PROFIT
        const tpHit = pos.side === 'LONG' ? price >= pos.tpPrice : price <= pos.tpPrice;
        if (tpHit) {
          logger.info(`🎯 TP ${pos.symbol} ${pos.side} @ ${price} | TP: ${pos.tpPrice}`);
          await this._closePosition(pos, price, 'TAKE_PROFIT');
          continue;
        }

        // STOP LOSS
        const slHit = pos.side === 'LONG' ? price <= pos.slPrice : price >= pos.slPrice;
        if (slHit) {
          logger.warn(`🛡️ SL ${pos.symbol} ${pos.side} @ ${price} | SL: ${pos.slPrice}`);
          await this._closePosition(pos, price, 'STOP_LOSS');
          continue;
        }

        // TRAILING STOP
        if (this.trailingStop) {
          if (pos.side === 'LONG' && price > pos.highestPrice) {
            pos.highestPrice = price;
            if ((price - pos.entryPrice) / pos.entryPrice >= this.trailActPct) {
              const newSL = price * (1 - this.trailDistPct);
              if (newSL > pos.trailSL) {
                pos.trailSL = newSL;
                logger.info(`📈 Trail SL mis à jour ${pos.symbol}: ${pos.trailSL.toFixed(4)}`);
              }
            }
          }
          if (pos.side === 'SHORT' && price < pos.lowestPrice) {
            pos.lowestPrice = price;
            if ((pos.entryPrice - price) / pos.entryPrice >= this.trailActPct) {
              const newSL = price * (1 + this.trailDistPct);
              if (newSL < pos.trailSL) {
                pos.trailSL = newSL;
                logger.info(`📉 Trail SL mis à jour ${pos.symbol}: ${pos.trailSL.toFixed(4)}`);
              }
            }
          }
          const trailHit = pos.side === 'LONG'
            ? (pos.trailSL > pos.slPrice && price <= pos.trailSL)
            : (pos.trailSL < pos.slPrice && price >= pos.trailSL);
          if (trailHit) {
            logger.info(`📈 TRAIL SL ${pos.symbol} @ ${price}`);
            await this._closePosition(pos, price, 'TRAILING_SL');
            continue;
          }
        }

        // TIMEOUT: 10min en profit → fermer | 15min force
        const age = Date.now() - pos.openTime;
        if (age > 600000 && pos.currentPnl > 0) {
          logger.info(`⏱️ TIMEOUT PROFIT ${pos.symbol} | ${Math.floor(age/60000)}min | +${pos.currentPnl.toFixed(4)}$`);
          await this._closePosition(pos, price, 'TIMEOUT');
          continue;
        }
        if (age > 900000) {
          logger.warn(`⏱️ TIMEOUT FORCE ${pos.symbol} | ${Math.floor(age/60000)}min`);
          await this._closePosition(pos, price, 'TIMEOUT_FORCE');
          continue;
        }
      }

      this._broadcast({ type: 'PRICES', data: this._getPriceSnapshot() });

    } catch (err) {
      logger.error(`PriceLoop: ${err.message}`);
    }
  }

  // ================================================================
  // BOUCLE 2 — ANALYSE TECHNIQUE + NOUVELLES ENTRÉES
  // ================================================================
  async _analysisLoop() {
    if (!this.isRunning) return;
    try {
      const todayStart = new Date().setHours(0,0,0,0);
      if (todayStart > this.dailyReset) { this.dailyPnl = 0; this.dailyReset = todayStart; }

      if (this.dailyPnl <= -this.maxDailyLoss) {
        logger.warn(`🛑 Perte quotidienne max (${this.dailyPnl.toFixed(2)}$) — arrêt`);
        await this.stop(); return;
      }

      try {
        const bal = await binance.getBalance();
        this.balance = bal.available;
      } catch {}

      if (this.positions.size < this.maxPositions) {
        await this._findEntries();
      } else {
        logger.info(`⏸ Max positions (${this.positions.size}/${this.maxPositions})`);
      }

      this._broadcastState();
    } catch (err) {
      logger.error(`AnalysisLoop: ${err.message}`);
    }
  }

  // ================================================================
  // RÉCUPÉRER LES PRIX
  // ================================================================
  async _fetchPrices() {
    await Promise.allSettled(
      this.pairs.map(async pair => {
        try {
          const price = await Promise.race([
            binance.getPrice(pair),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
          ]);
          if (price > 0) this.pairData[pair].price = price;
        } catch { /* utilise le dernier prix connu */ }
      })
    );
  }

  // ================================================================
  // CHERCHER DE NOUVELLES ENTRÉES
  // ================================================================
  async _findEntries() {
    const candidates = [];

    await Promise.allSettled(
      this.pairs.map(async pair => {
        try {
          const result = await this._analyzePair(pair);
          if (result && result.action === 'OPEN') {
            candidates.push({ pair, ...result });
          }
        } catch {}
      })
    );

    candidates.sort((a, b) => b.confidence - a.confidence);

    // ── FIX: Traitement séquentiel (pas parallèle) pour éviter le race condition ──
    for (const cand of candidates) {
      if (this.positions.size >= this.maxPositions) break;
      await this._openPosition(cand.pair, cand.side, cand.confidence, cand.tpPct, cand.slPct);
    }
  }

  // ================================================================
  // ANALYSER UNE PAIRE
  // ================================================================
  async _analyzePair(pair) {
    const data = this.pairData[pair];
    if (!data.candles || data.candles.length < 20) return null;

    if (this.pairBlacklist[pair] && Date.now() < this.pairBlacklist[pair]) return null;
    if (this.pairBlacklist[pair] && Date.now() >= this.pairBlacklist[pair]) {
      delete this.pairBlacklist[pair]; this.pairErrors[pair] = 0;
      logger.info(`✅ ${pair} retiré de la blacklist`);
    }

    if (Date.now() - (this.lastTradeTime[pair] || 0) < this.cooldownMs) return null;

    this._cleanHourlyTrades(pair);
    if ((this.hourlyTrades[pair] || []).length >= this.maxHourly) return null;

    if ([...this.positions.values()].find(p => p.symbol === pair)) return null;

    // ── FIX: Vérifier le verrou d'ouverture ──
    if (this._openingPairs.has(pair)) return null;

    let orderBook = null;
    try {
      orderBook = await Promise.race([
        binance.getOrderBook(pair, 10),
        new Promise((_, rej) => setTimeout(() => rej(), 2000)),
      ]);
    } catch {}

    const analysis = scalpAnalyze(data.candles, orderBook);
    this.pairData[pair].analysis = analysis;

    const p = this.pairData[pair].price || 0;
    logger.info(`📊 ${pair} @ ${p.toFixed(2)} | L:${analysis.longScore} S:${analysis.shortScore} | ${analysis.action}${analysis.side?' '+analysis.side:''} (${analysis.confidence}%)`);

    return analysis;
  }

  // ================================================================
  // OUVRIR UNE POSITION
  // ================================================================
  async _openPosition(symbol, side, confidence, tpPct, slPct) {
    // ── FIX: Vérifications atomiques renforcées ──
    if (this.positions.size >= this.maxPositions) return;
    if ([...this.positions.values()].find(p => p.symbol === symbol)) return;

    // ── FIX: Verrou par paire — empêche deux ouvertures simultanées ──
    if (this._openingPairs.has(symbol)) {
      logger.warn(`⚠️ Ouverture déjà en cours pour ${symbol}, skip`);
      return;
    }
    this._openingPairs.add(symbol);

    // ── FIX: Re-vérifier après avoir posé le verrou ──
    if (this.positions.size >= this.maxPositions || [...this.positions.values()].find(p => p.symbol === symbol)) {
      this._openingPairs.delete(symbol);
      return;
    }

    try {
      if (this.balance < this.amount * 1.02) {
        logger.warn(`⛔ Solde insuffisant: ${this.balance.toFixed(2)} USDT`);
        return;
      }

      const order = side === 'LONG'
        ? await binance.openLong(symbol, this.amount)
        : await binance.openShort(symbol, this.amount);

      const entryPrice = order.entryPrice;
      const qty        = order.qty;

      const tpRatio = tpPct > 0.1 ? tpPct / 100 : tpPct;
      const slRatio = slPct > 0.1 ? slPct / 100 : slPct;

      const tpPrice = side === 'LONG'
        ? entryPrice * (1 + tpRatio)
        : entryPrice * (1 - tpRatio);
      const slPrice = side === 'LONG'
        ? entryPrice * (1 - slRatio)
        : entryPrice * (1 + slRatio);

      const posId = `${symbol}_${side}_${++this._posCounter}`;
      const position = {
        id: posId, symbol, side, entryPrice, qty,
        amount: order.usdtAmount || this.amount,
        tpPrice, slPrice, tpRatio, slRatio,
        openTime: Date.now(), currentPrice: entryPrice, currentPnl: 0,
        highestPrice: entryPrice, lowestPrice: entryPrice, trailSL: slPrice,
        confidence,
      };

      this.positions.set(posId, position);
      this.lastTradeTime[symbol] = Date.now();
      if (!this.hourlyTrades[symbol]) this.hourlyTrades[symbol] = [];
      this.hourlyTrades[symbol].push(Date.now());
      this.pairErrors[symbol] = 0;
      delete this.pairBlacklist[symbol];

      const emoji = side === 'LONG' ? '🟢' : '🔴';
      const sign  = side === 'LONG' ? '+' : '-';
      logger.info(`${emoji} OPEN ${side} ${symbol} @ ${entryPrice} | TP:${tpPrice.toFixed(4)} (${sign}${(tpRatio*100).toFixed(2)}%) SL:${slPrice.toFixed(4)} (-${(slRatio*100).toFixed(2)}%) | conf:${confidence}%`);

      tradeLogger.info({ event:'OPEN', id:posId, symbol, side, entryPrice, qty, amount:this.amount, tpPrice, slPrice, confidence, timestamp:new Date().toISOString() });

      this._broadcast({ type:'POSITION_OPEN', data:position, positions:[...this.positions.values()] });

    } catch (err) {
      logger.error(`❌ Open ${side} ${symbol}: ${err.message}`);
      this.pairErrors[symbol] = (this.pairErrors[symbol] || 0) + 1;

      if (err.message.includes('notional') || err.message.includes('Notionnel') || err.message.includes('notionnel')) {
        this.pairBlacklist[symbol] = Date.now() + 600000;
        logger.warn(`🚫 ${symbol} blacklisté 10min — notionnel insuffisant avec ${this.amount}$`);
      } else if (this.pairErrors[symbol] >= 3) {
        this.pairBlacklist[symbol] = Date.now() + 300000;
        logger.warn(`🚫 ${symbol} blacklisté 5min (${this.pairErrors[symbol]} erreurs)`);
        this.pairErrors[symbol] = 0;
      }

      this.lastTradeTime[symbol] = Date.now();
    } finally {
      // ── FIX: Toujours libérer le verrou ──
      this._openingPairs.delete(symbol);
    }
  }

  // ================================================================
  // FERMER UNE POSITION
  // ================================================================
  async _closePosition(pos, exitPrice, reason) {
    // ── FIX: Retirer atomiquement de la Map — évite les doubles fermetures ──
    if (!this.positions.has(pos.id)) return;
    this.positions.delete(pos.id);

    try {
      // ── FIX: Utiliser la quantité stockée dans la position (pas recalculée) ──
      if (pos.side === 'LONG') await binance.closeLong(pos.symbol, pos.qty);
      else                     await binance.closeShort(pos.symbol, pos.qty);

      const leverage = parseInt(process.env.LEVERAGE || 3);
      const pnl = pos.side === 'LONG'
        ? (exitPrice - pos.entryPrice) / pos.entryPrice * pos.amount * leverage
        : (pos.entryPrice - exitPrice) / pos.entryPrice * pos.amount * leverage;
      const pnlPct = pnl / pos.amount * 100;
      const duration = Date.now() - pos.openTime;

      this.stats.totalPnl += pnl;
      this.dailyPnl += pnl;
      this.stats.totalTrades++;
      this.stats.totalDuration += duration;
      this.stats.avgDuration = this.stats.totalDuration / this.stats.totalTrades;
      if (pos.side === 'LONG') this.stats.longTrades++; else this.stats.shortTrades++;
      if (pnl > 0) { this.stats.wins++; if (pnl > this.stats.bestTrade) this.stats.bestTrade = pnl; }
      else { this.stats.losses++; if (pnl < this.stats.worstTrade) this.stats.worstTrade = pnl; }

      const trade = {
        id: pos.id, symbol: pos.symbol, side: pos.side,
        entryPrice: pos.entryPrice, exitPrice,
        qty: pos.qty, amount: pos.amount,
        pnl: parseFloat(pnl.toFixed(4)),
        pnlPct: parseFloat(pnlPct.toFixed(3)),
        duration, reason,
        openTime: pos.openTime, closeTime: Date.now(),
      };

      this.trades.unshift(trade);
      if (this.trades.length > 200) this.trades.pop();

      const emoji = pnl >= 0 ? '✅' : '❌';
      const sign  = pnl >= 0 ? '+' : '';
      logger.info(`${emoji} CLOSE ${pos.side} ${pos.symbol} @ ${exitPrice} | P&L: ${sign}${pnl.toFixed(4)}$ | ${reason} | ${Math.floor(duration/1000)}s`);
      tradeLogger.info({ event:'CLOSE', ...trade, timestamp:new Date().toISOString() });

      this._broadcast({ type:'POSITION_CLOSE', data:{ trade, stats:this.stats } });

    } catch (err) {
      logger.error(`❌ Close ${pos.symbol}: ${err.message}`);
      // ── FIX: Si la fermeture API échoue, remettre la position dans la Map pour réessayer ──
      // MAIS seulement si ce n'est pas une erreur "position inconnue" côté Binance
      if (!err.message.includes('Position') && !err.message.includes('position') && !err.message.includes('reduceOnly')) {
        logger.warn(`🔄 Remise en Map de ${pos.symbol} après échec de fermeture`);
        this.positions.set(pos.id, pos);
      }
    }
  }

  // ================================================================
  // CHARGER LES BOUGIES
  // ================================================================
  async _loadCandles() {
    await Promise.allSettled(
      this.pairs.map(async pair => {
        try {
          const candles = await Promise.race([
            binance.getKlines(pair, '1m', 100),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000)),
          ]);
          if (candles && candles.length >= 20) {
            this.pairData[pair].candles = candles;
            const lastClose = candles[candles.length - 1].close;
            if (!this.pairData[pair].price) this.pairData[pair].price = lastClose;
          }
        } catch (e) { logger.warn(`Candles ${pair}: ${e.message}`); }
      })
    );
  }

  // ================================================================
  // UTILITAIRES
  // ================================================================
  _cleanHourlyTrades(pair) {
    const oneHourAgo = Date.now() - 3600000;
    if (this.hourlyTrades[pair]) {
      this.hourlyTrades[pair] = this.hourlyTrades[pair].filter(t => t > oneHourAgo);
    }
  }

  _getPriceSnapshot() {
    const snap = {};
    for (const pair of this.pairs) {
      snap[pair] = { price: this.pairData[pair]?.price, analysis: this.pairData[pair]?.analysis };
    }
    return snap;
  }

  addListener(ws)    { this.wsListeners.add(ws); this._sendToClient(ws, { type:'INIT', data:this.getState() }); }
  removeListener(ws) { this.wsListeners.delete(ws); }

  _broadcast(msg) {
    const data = JSON.stringify(msg);
    this.wsListeners.forEach(ws => {
      try { if (ws.readyState === 1) ws.send(data); }
      catch { this.wsListeners.delete(ws); }
    });
  }
  _sendToClient(ws, msg) { try { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); } catch {} }
  _broadcastState() { this._broadcast({ type:'STATE', data:this.getState() }); }

  getState() {
    return {
      running:      this.isRunning,
      pairs:        this.pairs,
      maxPositions: this.maxPositions,
      balance:      this.balance,
      startBalance: this.startBalance,
      positions:    [...this.positions.values()],
      trades:       this.trades.slice(0, 50),
      stats:        this.stats,
      dailyPnl:     this.dailyPnl,
      pairData:     Object.fromEntries(
        this.pairs.map(p => [p, {
          price:    this.pairData[p]?.price,
          analysis: this.pairData[p]?.analysis,
          candles:  (this.pairData[p]?.candles || []).slice(-60).map(c => ({ t:c.closeTime, o:c.open, h:c.high, l:c.low, c:c.close, v:c.volume })),
        }])
      ),
      timestamp: Date.now(),
    };
  }
}

module.exports = new Scalper();