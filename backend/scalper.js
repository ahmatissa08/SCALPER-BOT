// ================================================================
// scalper.js — Moteur de scalping v1.4 AGRESSIF
// TP/SL serrés, timeout court, scan rapide, profits fréquents
// ================================================================
const binance = require('./binance-futures');
const { scalpAnalyze } = require('./scalp-strategy');
const { logger, tradeLogger } = require('./logger');

class Scalper {
  constructor() {
    this.pairs        = (process.env.TRADE_PAIRS || 'BTCUSDT,ETHUSDT').split(',').map(s => s.trim());
    this.amount       = parseFloat(process.env.TRADE_AMOUNT_USDT || 20);
    this.maxPositions = parseInt(process.env.MAX_POSITIONS || 3);
    this.leverage     = parseInt(process.env.LEVERAGE || 3);

    // TP/SL serrés pour scalping (en %)
    // Par défaut: TP=0.15%, SL=0.10% → ratio 1.5:1
    this.tpPct        = parseFloat(process.env.TAKE_PROFIT_PCT || 0.15) / 100;
    this.slPct        = parseFloat(process.env.STOP_LOSS_PCT   || 0.10) / 100;

    this.trailingStop = process.env.TRAILING_STOP !== 'false'; // activé par défaut
    this.trailActPct  = parseFloat(process.env.TRAILING_ACTIVATION_PCT || 0.08) / 100;
    this.trailDistPct = parseFloat(process.env.TRAILING_DISTANCE_PCT   || 0.06) / 100;

    // Timing agressif
    this.scanInterval = parseInt(process.env.SCAN_INTERVAL_MS || 3000); // analyse toutes les 3s
    this.maxDailyLoss = parseFloat(process.env.MAX_DAILY_LOSS  || 50);
    this.cooldownMs   = parseInt(process.env.TRADE_COOLDOWN_MS || 10000); // 10s cooldown
    this.maxHourly    = parseInt(process.env.MAX_TRADES_PER_HOUR || 20);

    // Timeout court: ferme si pas de TP en 3min en profit, force à 5min
    this.timeoutProfit = 180000;  // 3 min
    this.timeoutForce  = 300000;  // 5 min

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
    this.stats = {
      totalPnl: 0, wins: 0, losses: 0,
      bestTrade: 0, worstTrade: 0,
      totalTrades: 0, longTrades: 0, shortTrades: 0,
      totalDuration: 0, avgDuration: 0,
    };

    this._priceTimer  = null;
    this._scanTimer   = null;
    this._candleTimer = null;
    this.wsListeners  = new Set();
  }

  // ================================================================
  // START / STOP
  // ================================================================
  async start() {
    if (this.isRunning) return { success: false, message: 'Déjà en marche' };
    try {
      logger.info(`🚀 Scalper v1.4 | Paires: ${this.pairs.join(',')} | TP:${(this.tpPct*100).toFixed(2)}% SL:${(this.slPct*100).toFixed(2)}% | x${this.leverage}`);

      await binance.syncTime();
      const conn = await binance.testConnection();
      if (!conn.success) throw new Error(conn.error);

      this.balance = conn.balance.available;
      this.startBalance = this.balance;

      for (const pair of this.pairs) {
        try { await binance.setLeverage(pair, this.leverage); } catch {}
        try { await binance.setMarginType(pair, 'ISOLATED'); } catch {}
        this.lastTradeTime[pair] = 0;
        this.hourlyTrades[pair]  = [];
        this.pairData[pair]      = { candles: [], price: 0, orderBook: null, analysis: null };
      }

      await this._loadCandles();
      await this._fetchPrices();

      this.isRunning = true;
      this._broadcast({ type: 'STATUS', data: { running: true, balance: this.balance } });
      logger.info(`✅ Prêt | Balance: ${this.balance.toFixed(2)} USDT | TP=${(this.tpPct*100).toFixed(2)}% SL=${(this.slPct*100).toFixed(2)}% Timeout=${this.timeoutProfit/1000}s`);

      // Boucle rapide: prix + TP/SL toutes les 1s
      this._priceTimer  = setInterval(() => this._priceLoop(), 1000);
      // Boucle analyse: nouvelles entrées toutes les scanInterval
      this._scanTimer   = setInterval(() => this._analysisLoop(), this.scanInterval);
      // Boucle bougies: rechargement toutes les 60s
      this._candleTimer = setInterval(() => this._loadCandles(), 60000);

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
    const pnl = this.stats.totalPnl;
    logger.info(`🛑 Arrêté | Trades: ${this.stats.totalTrades} | P&L: ${pnl>=0?'+':''}${pnl.toFixed(4)}$ | W:${this.stats.wins} L:${this.stats.losses}`);
    this._broadcast({ type: 'STATUS', data: { running: false } });
    return { success: true };
  }

  async emergencyClose() {
    logger.warn('🚨 URGENCE — fermeture de toutes les positions');
    const positions = [...this.positions.values()];
    await Promise.allSettled(
      positions.map(pos => this._closePosition(pos, pos.currentPrice || pos.entryPrice, 'EMERGENCY'))
    );
  }

  // ================================================================
  // BOUCLE RAPIDE — PRIX + TP/SL (toutes les 1s)
  // ================================================================
  async _priceLoop() {
    if (!this.isRunning) return;
    try {
      await this._fetchPrices();

      for (const [id, pos] of this.positions) {
        const price = this.pairData[pos.symbol]?.price;
        if (!price || price <= 0) continue;

        pos.currentPrice = price;
        pos.currentPnl = pos.side === 'LONG'
          ? (price - pos.entryPrice) / pos.entryPrice * pos.amount * this.leverage
          : (pos.entryPrice - price) / pos.entryPrice * pos.amount * this.leverage;

        // ── TAKE PROFIT ──────────────────────────────────────────────
        const tpHit = pos.side === 'LONG' ? price >= pos.tpPrice : price <= pos.tpPrice;
        if (tpHit) {
          await this._closePosition(pos, price, 'TAKE_PROFIT');
          continue;
        }

        // ── STOP LOSS ────────────────────────────────────────────────
        const slHit = pos.side === 'LONG' ? price <= pos.slPrice : price >= pos.slPrice;
        if (slHit) {
          await this._closePosition(pos, price, 'STOP_LOSS');
          continue;
        }

        // ── TRAILING STOP ────────────────────────────────────────────
        if (this.trailingStop) {
          if (pos.side === 'LONG') {
            if (price > pos.highestPrice) {
              pos.highestPrice = price;
              if ((price - pos.entryPrice) / pos.entryPrice >= this.trailActPct) {
                const newSL = price * (1 - this.trailDistPct);
                if (newSL > pos.trailSL) {
                  pos.trailSL = newSL;
                }
              }
            }
            if (price <= pos.trailSL && pos.trailSL > pos.slPrice) {
              logger.info(`📈 TRAIL LONG ${pos.symbol} @ ${price} | TSL:${pos.trailSL.toFixed(4)}`);
              await this._closePosition(pos, price, 'TRAILING_SL');
              continue;
            }
          } else {
            if (price < pos.lowestPrice) {
              pos.lowestPrice = price;
              if ((pos.entryPrice - price) / pos.entryPrice >= this.trailActPct) {
                const newSL = price * (1 + this.trailDistPct);
                if (newSL < pos.trailSL) {
                  pos.trailSL = newSL;
                }
              }
            }
            if (price >= pos.trailSL && pos.trailSL < pos.slPrice) {
              logger.info(`📉 TRAIL SHORT ${pos.symbol} @ ${price} | TSL:${pos.trailSL.toFixed(4)}`);
              await this._closePosition(pos, price, 'TRAILING_SL');
              continue;
            }
          }
        }

        // ── TIMEOUT AGRESSIF ─────────────────────────────────────────
        const age = Date.now() - pos.openTime;

        // 3min en profit → fermer immédiatement (encaisser le gain)
        if (age > this.timeoutProfit && pos.currentPnl > 0) {
          logger.info(`⏱️ TIMEOUT PROFIT ${pos.symbol} ${pos.side} | ${Math.floor(age/1000)}s | P&L:+${pos.currentPnl.toFixed(4)}$`);
          await this._closePosition(pos, price, 'TIMEOUT_PROFIT');
          continue;
        }

        // 5min → fermer quoi qu'il arrive (stop le saignement)
        if (age > this.timeoutForce) {
          const sign = pos.currentPnl >= 0 ? '+' : '';
          logger.warn(`⏱️ TIMEOUT FORCE ${pos.symbol} | ${Math.floor(age/1000)}s | P&L:${sign}${pos.currentPnl.toFixed(4)}$`);
          await this._closePosition(pos, price, 'TIMEOUT_FORCE');
          continue;
        }
      }

      // Broadcast état P&L live
      this._broadcast({ type: 'PRICES', data: this._getPriceSnapshot() });

    } catch (err) {
      if (!err.message?.includes('timeout')) {
        logger.error(`PriceLoop: ${err.message}`);
      }
    }
  }

  // ================================================================
  // BOUCLE ANALYSE — NOUVELLES ENTRÉES
  // ================================================================
  async _analysisLoop() {
    if (!this.isRunning) return;
    try {
      // Reset PnL quotidien
      const today = new Date().setHours(0,0,0,0);
      if (today > this.dailyReset) { this.dailyPnl = 0; this.dailyReset = today; }

      if (this.dailyPnl <= -this.maxDailyLoss) {
        logger.warn(`🛑 Perte max journalière (${this.dailyPnl.toFixed(2)}$) — arrêt`);
        await this.stop(); return;
      }

      // Mise à jour balance (sans bloquer si timeout)
      try {
        const bal = await Promise.race([
          binance.getBalance(),
          new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 3000)),
        ]);
        this.balance = bal.available;
      } catch {}

      if (this.positions.size < this.maxPositions) {
        await this._findEntries();
      }

      this._broadcastState();
    } catch (err) {
      logger.error(`AnalysisLoop: ${err.message}`);
    }
  }

  // ================================================================
  // RÉCUPÉRER LES PRIX (timeout 2s, très court)
  // ================================================================
  async _fetchPrices() {
    await Promise.allSettled(
      this.pairs.map(async pair => {
        try {
          const price = await Promise.race([
            binance.getPrice(pair),
            new Promise((_, r) => setTimeout(() => r(new Error('t')), 2000)),
          ]);
          if (price > 0) this.pairData[pair].price = price;
        } catch {}
      })
    );
  }

  // ================================================================
  // CHERCHER DES ENTRÉES
  // ================================================================
  async _findEntries() {
    const candidates = [];

    await Promise.allSettled(
      this.pairs.map(async pair => {
        try {
          const r = await this._analyzePair(pair);
          if (r?.action === 'OPEN') candidates.push({ pair, ...r });
        } catch {}
      })
    );

    candidates.sort((a, b) => b.confidence - a.confidence);

    for (const c of candidates) {
      if (this.positions.size >= this.maxPositions) break;
      await this._openPosition(c.pair, c.side, c.confidence);
    }
  }

  // ================================================================
  // ANALYSER UNE PAIRE
  // ================================================================
  async _analyzePair(pair) {
    const data = this.pairData[pair];
    if (!data?.candles || data.candles.length < 20) return null;

    // Blacklist
    if (this.pairBlacklist[pair] && Date.now() < this.pairBlacklist[pair]) return null;
    if (this.pairBlacklist[pair]) {
      delete this.pairBlacklist[pair]; this.pairErrors[pair] = 0;
      logger.info(`✅ ${pair} retiré de la blacklist`);
    }

    // Cooldown
    if (Date.now() - (this.lastTradeTime[pair] || 0) < this.cooldownMs) return null;

    // Limite horaire
    this._cleanHourlyTrades(pair);
    if ((this.hourlyTrades[pair] || []).length >= this.maxHourly) return null;

    // Position déjà ouverte
    if ([...this.positions.values()].find(p => p.symbol === pair)) return null;

    // Order book rapide
    let ob = null;
    try {
      ob = await Promise.race([
        binance.getOrderBook(pair, 10),
        new Promise((_, r) => setTimeout(r, 1500)),
      ]);
    } catch {}

    const analysis = scalpAnalyze(data.candles, ob);
    this.pairData[pair].analysis = analysis;

    const price = data.price || 0;
    logger.info(`📊 ${pair} @ ${price.toFixed(price > 100 ? 2 : 4)} | L:${analysis.longScore} S:${analysis.shortScore} | ${analysis.action}${analysis.side ? ' ' + analysis.side : ''} (${analysis.confidence}%)`);

    return analysis;
  }

  // ================================================================
  // OUVRIR UNE POSITION
  // ================================================================
  async _openPosition(symbol, side, confidence) {
    if (this.positions.size >= this.maxPositions) return;
    if ([...this.positions.values()].find(p => p.symbol === symbol)) return;
    if (this.balance < this.amount * 1.02) {
      logger.warn(`⛔ Solde insuffisant: ${this.balance.toFixed(2)} USDT`);
      return;
    }

    try {
      const order = side === 'LONG'
        ? await binance.openLong(symbol, this.amount)
        : await binance.openShort(symbol, this.amount);

      const entryPrice = order.entryPrice;
      const qty        = order.qty;

      // TP/SL en prix absolus — vérification directionnelle garantie
      // LONG:  TP = entry × (1 + tpPct)  |  SL = entry × (1 - slPct)
      // SHORT: TP = entry × (1 - tpPct)  |  SL = entry × (1 + slPct)
      const tpPrice = side === 'LONG'
        ? entryPrice * (1 + this.tpPct)
        : entryPrice * (1 - this.tpPct);
      const slPrice = side === 'LONG'
        ? entryPrice * (1 - this.slPct)
        : entryPrice * (1 + this.slPct);

      // Validation de cohérence
      if (side === 'LONG'  && (tpPrice <= entryPrice || slPrice >= entryPrice)) throw new Error('TP/SL LONG incohérents');
      if (side === 'SHORT' && (tpPrice >= entryPrice || slPrice <= entryPrice)) throw new Error('TP/SL SHORT incohérents');

      const posId = `${symbol}_${side}_${++this._posCounter}`;
      const position = {
        id: posId, symbol, side, entryPrice, qty,
        amount: order.usdtAmount || this.amount,
        tpPrice, slPrice,
        openTime: Date.now(),
        currentPrice: entryPrice, currentPnl: 0,
        highestPrice: entryPrice, lowestPrice: entryPrice,
        trailSL: slPrice,
        confidence,
      };

      this.positions.set(posId, position);
      this.lastTradeTime[symbol] = Date.now();
      if (!this.hourlyTrades[symbol]) this.hourlyTrades[symbol] = [];
      this.hourlyTrades[symbol].push(Date.now());
      this.pairErrors[symbol] = 0;
      delete this.pairBlacklist[symbol];

      const emoji = side === 'LONG' ? '🟢' : '🔴';
      logger.info(
        `${emoji} OPEN ${side} ${symbol} @ ${entryPrice}` +
        ` | TP:${tpPrice.toFixed(4)} (+${side==='LONG'?'+':'-'}${(this.tpPct*100).toFixed(2)}%)` +
        ` SL:${slPrice.toFixed(4)} (-${(this.slPct*100).toFixed(2)}%)` +
        ` | conf:${confidence}%`
      );

      tradeLogger.info({
        event:'OPEN', id:posId, symbol, side, entryPrice, qty,
        amount: this.amount, tpPrice, slPrice, confidence,
        tpPct: this.tpPct*100, slPct: this.slPct*100,
        timestamp: new Date().toISOString(),
      });

      this._broadcast({ type:'POSITION_OPEN', data:position, positions:[...this.positions.values()] });

    } catch (err) {
      logger.error(`❌ Open ${side} ${symbol}: ${err.message}`);
      this.pairErrors[symbol] = (this.pairErrors[symbol] || 0) + 1;

      if (err.message.includes('notional') || err.message.includes('Notionnel')) {
        this.pairBlacklist[symbol] = Date.now() + 600000;
        logger.warn(`🚫 ${symbol} blacklisté 10min — augmenter TRADE_AMOUNT_USDT`);
      } else if (this.pairErrors[symbol] >= 3) {
        this.pairBlacklist[symbol] = Date.now() + 300000;
        logger.warn(`🚫 ${symbol} blacklisté 5min (${this.pairErrors[symbol]} erreurs)`);
        this.pairErrors[symbol] = 0;
      }

      this.lastTradeTime[symbol] = Date.now();
    }
  }

  // ================================================================
  // FERMER UNE POSITION
  // ================================================================
  async _closePosition(pos, exitPrice, reason) {
    if (!this.positions.has(pos.id)) return;
    this.positions.delete(pos.id); // suppression atomique immédiate

    try {
      if (pos.side === 'LONG') await binance.closeLong(pos.symbol, pos.qty);
      else                     await binance.closeShort(pos.symbol, pos.qty);

      const pnl = pos.side === 'LONG'
        ? (exitPrice - pos.entryPrice) / pos.entryPrice * pos.amount * this.leverage
        : (pos.entryPrice - exitPrice) / pos.entryPrice * pos.amount * this.leverage;

      const pnlPct   = pnl / pos.amount * 100;
      const duration = Date.now() - pos.openTime;

      // Stats
      this.stats.totalPnl     += pnl;
      this.dailyPnl           += pnl;
      this.stats.totalTrades++;
      this.stats.totalDuration += duration;
      this.stats.avgDuration   = this.stats.totalDuration / this.stats.totalTrades;
      if (pos.side === 'LONG') this.stats.longTrades++; else this.stats.shortTrades++;
      if (pnl > 0) { this.stats.wins++; if (pnl > this.stats.bestTrade) this.stats.bestTrade = pnl; }
      else         { this.stats.losses++; if (pnl < this.stats.worstTrade) this.stats.worstTrade = pnl; }

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
      logger.info(`${emoji} CLOSE ${pos.side} ${pos.symbol} @ ${exitPrice} | P&L: ${sign}${pnl.toFixed(4)}$ (${sign}${pnlPct.toFixed(2)}%) | ${reason} | ${Math.floor(duration/1000)}s | Total: ${this.stats.totalPnl>=0?'+':''}${this.stats.totalPnl.toFixed(4)}$`);
      tradeLogger.info({ event:'CLOSE', ...trade, timestamp:new Date().toISOString() });

      this._broadcast({ type:'POSITION_CLOSE', data:{ trade, stats:this.stats } });

    } catch (err) {
      logger.error(`❌ Close ${pos.symbol}: ${err.message}`);
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
            new Promise((_, r) => setTimeout(() => r(new Error('timeout')), 10000)),
          ]);
          if (candles?.length >= 20) {
            this.pairData[pair].candles = candles;
            if (!this.pairData[pair].price) {
              this.pairData[pair].price = candles[candles.length - 1].close;
            }
          }
        } catch (e) { logger.warn(`Candles ${pair}: ${e.message}`); }
      })
    );
  }

  // ================================================================
  // UTILITAIRES
  // ================================================================
  _cleanHourlyTrades(pair) {
    const h = Date.now() - 3600000;
    if (this.hourlyTrades[pair]) this.hourlyTrades[pair] = this.hourlyTrades[pair].filter(t => t > h);
  }

  _getPriceSnapshot() {
    const snap = {};
    for (const p of this.pairs) snap[p] = { price: this.pairData[p]?.price, analysis: this.pairData[p]?.analysis };
    return snap;
  }

  addListener(ws)    { this.wsListeners.add(ws); this._sendToClient(ws, { type:'INIT', data:this.getState() }); }
  removeListener(ws) { this.wsListeners.delete(ws); }

  _broadcast(msg) {
    const d = JSON.stringify(msg);
    this.wsListeners.forEach(ws => {
      try { if (ws.readyState === 1) ws.send(d); }
      catch { this.wsListeners.delete(ws); }
    });
  }

  _sendToClient(ws, msg) { try { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); } catch {} }
  _broadcastState()      { this._broadcast({ type:'STATE', data:this.getState() }); }

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
      config: {
        tpPct:     (this.tpPct * 100).toFixed(2),
        slPct:     (this.slPct * 100).toFixed(2),
        leverage:  this.leverage,
        timeout:   this.timeoutProfit / 1000,
        cooldown:  this.cooldownMs / 1000,
      },
      pairData: Object.fromEntries(
        this.pairs.map(p => [p, {
          price:    this.pairData[p]?.price,
          analysis: this.pairData[p]?.analysis,
          candles:  (this.pairData[p]?.candles || []).slice(-60).map(c => ({
            t:c.closeTime, o:c.open, h:c.high, l:c.low, c:c.close, v:c.volume
          })),
        }])
      ),
      timestamp: Date.now(),
    };
  }
}

module.exports = new Scalper();
