// ================================================================
// scalper.js v2.0 — Moteur de scalping corrigé + optimisé
// FIXES: double position, timeout bug, biais directionnel, TP/SL adaptatifs
// ================================================================
const binance  = require('./binance-futures');
const { scalpAnalyze } = require('./scalp-strategy');
const { logger, tradeLogger } = require('./logger');

class Scalper {
  constructor() {
    this.pairs        = (process.env.TRADE_PAIRS || 'BTCUSDT,ETHUSDT,BNBUSDT').split(',').map(s=>s.trim());
    this.amount       = parseFloat(process.env.TRADE_AMOUNT_USDT || 20);
    this.maxPositions = parseInt(process.env.MAX_POSITIONS || 3);
    this.leverage     = parseInt(process.env.LEVERAGE || 3);

    // TP/SL adaptatifs basés sur l'ATR (overridables via .env)
    this.tpOverride   = process.env.TAKE_PROFIT_PCT ? parseFloat(process.env.TAKE_PROFIT_PCT)/100 : null;
    this.slOverride   = process.env.STOP_LOSS_PCT   ? parseFloat(process.env.STOP_LOSS_PCT)/100   : null;

    // Timing
    this.scanInterval  = parseInt(process.env.SCAN_INTERVAL_MS || 3000);
    this.maxDailyLoss  = parseFloat(process.env.MAX_DAILY_LOSS  || 50);
    this.cooldownMs    = parseInt(process.env.TRADE_COOLDOWN_MS  || 15000);
    this.maxHourly     = parseInt(process.env.MAX_TRADES_PER_HOUR || 15);

    // Timeout adaptatif selon la volatilité
    this.timeoutProfit = 180000;   // 3min → fermer si en profit
    this.timeoutForce  = 300000;   // 5min → fermer quoi qu'il arrive
    this.timeoutMax    = 600000;   // 10min → JAMAIS dépasser (fix bug 1h30)

    // État
    this.isRunning     = false;
    this._starting     = false;
    this._openingPairs = new Set(); // MUTEX par paire — FIX double position
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
      totalPnl:0, wins:0, losses:0,
      bestTrade:0, worstTrade:0,
      totalTrades:0, longTrades:0, shortTrades:0,
      totalDuration:0, avgDuration:0,
      byReason: {},
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
    if (this.isRunning || this._starting) return { success: false, message: 'Déjà en marche' };
    this._starting = true;
    try {
      logger.info(`🚀 Scalper v2.0 | Paires: ${this.pairs.join(',')} | MaxPos: ${this.maxPositions} | Levier: x${this.leverage}`);
      logger.info(`   TP: ${this.tpOverride ? (this.tpOverride*100).toFixed(2)+'% (fixe)' : 'ATR×2 (adaptatif)'} | SL: ${this.slOverride ? (this.slOverride*100).toFixed(2)+'% (fixe)' : 'ATR×1 (adaptatif)'}`);

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
        this.pairData[pair]      = { candles:[], price:0, orderBook:null, analysis:null };
      }

      await this._loadCandles();
      await this._fetchPrices();

      this.isRunning = true;
      this._starting = false;
      this._broadcast({ type:'STATUS', data:{ running:true, balance:this.balance } });
      logger.info(`✅ Scalper prêt | Balance: ${this.balance.toFixed(2)} USDT`);

      // 3 boucles indépendantes
      this._priceTimer  = setInterval(() => this._priceLoop(),    1000);
      this._scanTimer   = setInterval(() => this._analysisLoop(), this.scanInterval);
      this._candleTimer = setInterval(() => this._loadCandles(),  60000);

      await this._analysisLoop();
      return { success:true, balance:this.balance };
    } catch (err) {
      this._starting = false;
      this.isRunning = false;
      logger.error(`❌ Start: ${err.message}`);
      return { success:false, error:err.message };
    }
  }

  async stop() {
    this.isRunning = false;
    clearInterval(this._priceTimer);
    clearInterval(this._scanTimer);
    clearInterval(this._candleTimer);
    const p = this.stats.totalPnl;
    logger.info(`🛑 Arrêt | ${this.stats.totalTrades} trades | P&L: ${p>=0?'+':''}${p.toFixed(4)}$ | W:${this.stats.wins} L:${this.stats.losses}`);
    this._broadcast({ type:'STATUS', data:{ running:false } });
    return { success:true };
  }

  async emergencyClose() {
    logger.warn('🚨 URGENCE — fermeture immédiate de tout');
    const all = [...this.positions.values()];
    await Promise.allSettled(all.map(pos =>
      this._closePosition(pos, pos.currentPrice || pos.entryPrice, 'EMERGENCY')
    ));
  }

  // ================================================================
  // BOUCLE 1 — PRIX + TP/SL (1s, ultra-rapide)
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

        const age = Date.now() - pos.openTime;

        // ── TAKE PROFIT ──
        const tpHit = pos.side === 'LONG' ? price >= pos.tpPrice : price <= pos.tpPrice;
        if (tpHit) {
          await this._closePosition(pos, price, 'TAKE_PROFIT');
          continue;
        }

        // ── STOP LOSS ──
        const slHit = pos.side === 'LONG' ? price <= pos.slPrice : price >= pos.slPrice;
        if (slHit) {
          await this._closePosition(pos, price, 'STOP_LOSS');
          continue;
        }

        // ── TRAILING STOP ──
        if (pos.side === 'LONG') {
          if (price > pos.highestPrice) pos.highestPrice = price;
          if ((pos.highestPrice - pos.entryPrice) / pos.entryPrice >= pos.trailActPct) {
            const newSL = pos.highestPrice * (1 - pos.trailDistPct);
            if (newSL > pos.trailSL && newSL > pos.slPrice) {
              pos.trailSL = newSL;
            }
          }
          if (pos.trailSL > pos.slPrice && price <= pos.trailSL) {
            await this._closePosition(pos, price, 'TRAILING_SL');
            continue;
          }
        } else {
          if (price < pos.lowestPrice) pos.lowestPrice = price;
          if ((pos.entryPrice - pos.lowestPrice) / pos.entryPrice >= pos.trailActPct) {
            const newSL = pos.lowestPrice * (1 + pos.trailDistPct);
            if (newSL < pos.trailSL && newSL < pos.slPrice) {
              pos.trailSL = newSL;
            }
          }
          if (pos.trailSL < pos.slPrice && price >= pos.trailSL) {
            await this._closePosition(pos, price, 'TRAILING_SL');
            continue;
          }
        }

        // ── TIMEOUTS (FIX: jamais plus de timeoutMax) ──
        if (age > this.timeoutMax) {
          // JAMAIS laisser une position plus de 10min — bug corrigé
          const sign = pos.currentPnl >= 0 ? '+' : '';
          logger.warn(`⏱️ TIMEOUT MAX ${pos.symbol} | ${Math.floor(age/1000)}s | P&L:${sign}${pos.currentPnl.toFixed(4)}$`);
          await this._closePosition(pos, price, 'TIMEOUT_FORCE');
          continue;
        }

        if (age > this.timeoutProfit && pos.currentPnl > 0) {
          logger.info(`⏱️ TIMEOUT PROFIT ${pos.symbol} ${pos.side} | ${Math.floor(age/1000)}s | +${pos.currentPnl.toFixed(4)}$`);
          await this._closePosition(pos, price, 'TIMEOUT_PROFIT');
          continue;
        }

        if (age > this.timeoutForce) {
          const sign = pos.currentPnl >= 0 ? '+' : '';
          logger.warn(`⏱️ TIMEOUT FORCE ${pos.symbol} | ${Math.floor(age/1000)}s | P&L:${sign}${pos.currentPnl.toFixed(4)}$`);
          await this._closePosition(pos, price, 'TIMEOUT_FORCE');
          continue;
        }
      }

      this._broadcast({ type:'PRICES', data:this._getPriceSnap() });
    } catch {}
  }

  // ================================================================
  // BOUCLE 2 — ANALYSE + ENTRÉES
  // ================================================================
  async _analysisLoop() {
    if (!this.isRunning) return;
    try {
      const today = new Date().setHours(0,0,0,0);
      if (today > this.dailyReset) { this.dailyPnl = 0; this.dailyReset = today; }

      if (this.dailyPnl <= -this.maxDailyLoss) {
        logger.warn(`🛑 Perte journalière max (${this.dailyPnl.toFixed(2)}$)`);
        await this.stop(); return;
      }

      try {
        const bal = await Promise.race([binance.getBalance(), new Promise((_,r)=>setTimeout(()=>r(),3000))]);
        if (bal) this.balance = bal.available;
      } catch {}

      if (this.positions.size < this.maxPositions) {
        await this._findEntries();
      }

      this._broadcastState();
    } catch (err) { logger.error(`AnalysisLoop: ${err.message}`); }
  }

  // ================================================================
  // TROUVER DES ENTRÉES
  // ================================================================
  async _findEntries() {
    const candidates = [];
    await Promise.allSettled(this.pairs.map(async pair => {
      try {
        const r = await this._analyzePair(pair);
        if (r?.action === 'OPEN') candidates.push({ pair, ...r });
      } catch {}
    }));

    // Trier par confiance ET par ratio risque/récompense (TP/SL)
    candidates.sort((a, b) => {
      const scoreA = a.confidence * (a.tpPct / a.slPct);
      const scoreB = b.confidence * (b.tpPct / b.slPct);
      return scoreB - scoreA;
    });

    for (const c of candidates) {
      if (this.positions.size >= this.maxPositions) break;
      await this._openPosition(c.pair, c.side, c.confidence, c.tpPct, c.slPct);
    }
  }

  // ================================================================
  // ANALYSER UNE PAIRE
  // ================================================================
  async _analyzePair(pair) {
    const data = this.pairData[pair];
    if (!data?.candles || data.candles.length < 30) return null;

    // Blacklist
    if (this.pairBlacklist[pair] && Date.now() < this.pairBlacklist[pair]) return null;
    if (this.pairBlacklist[pair]) {
      delete this.pairBlacklist[pair]; this.pairErrors[pair] = 0;
      logger.info(`✅ ${pair} retiré de la blacklist`);
    }

    if (Date.now() - (this.lastTradeTime[pair]||0) < this.cooldownMs) return null;
    this._cleanHourlyTrades(pair);
    if ((this.hourlyTrades[pair]||[]).length >= this.maxHourly) return null;

    // Déjà position OU en cours d'ouverture sur cette paire
    if ([...this.positions.values()].find(p=>p.symbol===pair)) return null;
    if (this._openingPairs.has(pair)) return null; // MUTEX

    let ob = null;
    try {
      ob = await Promise.race([
        binance.getOrderBook(pair, 10),
        new Promise((_,r)=>setTimeout(r,1500)),
      ]);
    } catch {}

    const analysis = scalpAnalyze(data.candles, ob);
    this.pairData[pair].analysis = analysis;

    const price = data.price || 0;
    const ms = analysis.indicators?.marketStructure;
    const trend = ms ? ms.trend : '?';
    logger.info(`📊 ${pair} @ ${price.toFixed(price>100?2:4)} | L:${analysis.longScore} S:${analysis.shortScore} | Trend:${trend} | ${analysis.action}${analysis.side?' '+analysis.side:''} (${analysis.confidence}%) | TP:${(analysis.tpPct*100).toFixed(2)}% SL:${(analysis.slPct*100).toFixed(2)}%`);

    return analysis;
  }

  // ================================================================
  // OUVRIR UNE POSITION — avec MUTEX paire pour éviter les doublons
  // ================================================================
  async _openPosition(symbol, side, confidence, tpPct, slPct) {
    // MUTEX: une seule ouverture à la fois par paire
    if (this._openingPairs.has(symbol)) return;
    if (this.positions.size >= this.maxPositions) return;
    if ([...this.positions.values()].find(p=>p.symbol===symbol)) return;
    if (this.balance < this.amount * 1.02) {
      logger.warn(`⛔ Solde insuffisant: ${this.balance.toFixed(2)}`);
      return;
    }

    this._openingPairs.add(symbol); // Verrouiller

    try {
      const order = side === 'LONG'
        ? await binance.openLong(symbol, this.amount)
        : await binance.openShort(symbol, this.amount);

      const entryPrice = order.entryPrice;
      const qty        = order.qty;

      // TP/SL: utiliser l'adaptatif ATR OU le fixe du .env
      const finalTP = this.tpOverride ?? tpPct;
      const finalSL = this.slOverride ?? slPct;

      // Garantir ratio 1.5:1 minimum
      const ratio = finalTP / finalSL;
      if (ratio < 1.2) {
        logger.warn(`⚠️ Ratio TP/SL trop faible (${ratio.toFixed(2)}:1) sur ${symbol} — skip`);
        this._openingPairs.delete(symbol);
        return;
      }

      const tpPrice = side==='LONG' ? entryPrice*(1+finalTP) : entryPrice*(1-finalTP);
      const slPrice = side==='LONG' ? entryPrice*(1-finalSL) : entryPrice*(1+finalSL);

      // Validation cohérence
      if (side==='LONG'  && (tpPrice<=entryPrice || slPrice>=entryPrice)) throw new Error(`TP/SL LONG invalides: tp=${tpPrice} sl=${slPrice} entry=${entryPrice}`);
      if (side==='SHORT' && (tpPrice>=entryPrice || slPrice<=entryPrice)) throw new Error(`TP/SL SHORT invalides: tp=${tpPrice} sl=${slPrice} entry=${entryPrice}`);

      // Trailing activé à 60% du TP, distance = 30% du SL
      const trailActPct  = finalTP * 0.6;
      const trailDistPct = finalSL * 0.3;

      const posId = `${symbol}_${side}_${++this._posCounter}`;
      const pos = {
        id:posId, symbol, side, entryPrice, qty,
        amount: order.usdtAmount || this.amount,
        tpPrice, slPrice, finalTP, finalSL,
        trailActPct, trailDistPct,
        openTime:Date.now(),
        currentPrice:entryPrice, currentPnl:0,
        highestPrice:entryPrice, lowestPrice:entryPrice,
        trailSL: side==='LONG' ? 0 : Infinity,
        confidence,
      };

      this.positions.set(posId, pos);
      this.lastTradeTime[symbol] = Date.now();
      if (!this.hourlyTrades[symbol]) this.hourlyTrades[symbol]=[];
      this.hourlyTrades[symbol].push(Date.now());
      this.pairErrors[symbol] = 0;
      delete this.pairBlacklist[symbol];

      const emoji = side==='LONG' ? '🟢' : '🔴';
      const sign  = side==='LONG' ? '+' : '-';
      logger.info(`${emoji} OPEN ${side} ${symbol} @ ${entryPrice} | TP:${tpPrice.toFixed(4)} (${sign}${(finalTP*100).toFixed(2)}%) SL:${slPrice.toFixed(4)} (-${(finalSL*100).toFixed(2)}%) | Ratio:${(finalTP/finalSL).toFixed(2)}:1 | conf:${confidence}%`);

      tradeLogger.info({ event:'OPEN', id:posId, symbol, side, entryPrice, qty, amount:this.amount, tpPrice, slPrice, tpPct:finalTP*100, slPct:finalSL*100, confidence, timestamp:new Date().toISOString() });
      this._broadcast({ type:'POSITION_OPEN', data:pos, positions:[...this.positions.values()] });

    } catch (err) {
      logger.error(`❌ Open ${side} ${symbol}: ${err.message}`);
      this.pairErrors[symbol] = (this.pairErrors[symbol]||0) + 1;
      if (err.message.includes('notional')||err.message.includes('Notionnel')) {
        this.pairBlacklist[symbol] = Date.now() + 600000;
        logger.warn(`🚫 ${symbol} blacklisté 10min — augmenter TRADE_AMOUNT_USDT`);
      } else if (this.pairErrors[symbol] >= 3) {
        this.pairBlacklist[symbol] = Date.now() + 300000;
        logger.warn(`🚫 ${symbol} blacklisté 5min`);
        this.pairErrors[symbol] = 0;
      }
      this.lastTradeTime[symbol] = Date.now();
    } finally {
      this._openingPairs.delete(symbol); // Toujours déverrouiller
    }
  }

  // ================================================================
  // FERMER UNE POSITION
  // ================================================================
  async _closePosition(pos, exitPrice, reason) {
    if (!this.positions.has(pos.id)) return;
    this.positions.delete(pos.id);

    try {
      if (pos.side==='LONG') await binance.closeLong(pos.symbol, pos.qty);
      else                   await binance.closeShort(pos.symbol, pos.qty);

      const pnl = pos.side==='LONG'
        ? (exitPrice-pos.entryPrice)/pos.entryPrice * pos.amount * this.leverage
        : (pos.entryPrice-exitPrice)/pos.entryPrice * pos.amount * this.leverage;

      const pnlPct   = pnl / pos.amount * 100;
      const duration = Date.now() - pos.openTime;

      this.stats.totalPnl      += pnl;
      this.dailyPnl            += pnl;
      this.stats.totalTrades++;
      this.stats.totalDuration += duration;
      this.stats.avgDuration    = this.stats.totalDuration / this.stats.totalTrades;
      if (pos.side==='LONG') this.stats.longTrades++; else this.stats.shortTrades++;
      if (pnl>0) { this.stats.wins++; if(pnl>this.stats.bestTrade) this.stats.bestTrade=pnl; }
      else { this.stats.losses++; if(pnl<this.stats.worstTrade) this.stats.worstTrade=pnl; }
      if (!this.stats.byReason[reason]) this.stats.byReason[reason] = {count:0,pnl:0,wins:0};
      this.stats.byReason[reason].count++;
      this.stats.byReason[reason].pnl += pnl;
      if (pnl>0) this.stats.byReason[reason].wins++;

      const trade = {
        id:pos.id, symbol:pos.symbol, side:pos.side,
        entryPrice:pos.entryPrice, exitPrice,
        qty:pos.qty, amount:pos.amount,
        pnl:parseFloat(pnl.toFixed(4)),
        pnlPct:parseFloat(pnlPct.toFixed(3)),
        duration, reason,
        openTime:pos.openTime, closeTime:Date.now(),
      };

      this.trades.unshift(trade);
      if (this.trades.length > 200) this.trades.pop();

      const emoji = pnl>=0 ? '✅' : '❌';
      const sign  = pnl>=0 ? '+' : '';
      logger.info(`${emoji} CLOSE ${pos.side} ${pos.symbol} @ ${exitPrice} | P&L: ${sign}${pnl.toFixed(4)}$ (${sign}${pnlPct.toFixed(2)}%) | ${reason} | ${Math.floor(duration/1000)}s | Total: ${this.stats.totalPnl>=0?'+':''}${this.stats.totalPnl.toFixed(4)}$`);
      tradeLogger.info({ event:'CLOSE', ...trade, timestamp:new Date().toISOString() });
      this._broadcast({ type:'POSITION_CLOSE', data:{ trade, stats:this.stats } });

    } catch (err) {
      logger.error(`❌ Close ${pos.symbol}: ${err.message}`);
    }
  }

  // ================================================================
  // UTILITAIRES
  // ================================================================
  async _fetchPrices() {
    await Promise.allSettled(this.pairs.map(async pair => {
      try {
        const price = await Promise.race([
          binance.getPrice(pair),
          new Promise((_,r)=>setTimeout(()=>r(new Error('t')),2000)),
        ]);
        if (price>0) this.pairData[pair].price = price;
      } catch {}
    }));
  }

  async _loadCandles() {
    await Promise.allSettled(this.pairs.map(async pair => {
      try {
        const candles = await Promise.race([
          binance.getKlines(pair, '1m', 100),
          new Promise((_,r)=>setTimeout(()=>r(new Error('timeout')),10000)),
        ]);
        if (candles?.length >= 30) {
          this.pairData[pair].candles = candles;
          if (!this.pairData[pair].price) this.pairData[pair].price = candles[candles.length-1].close;
        }
      } catch (e) { logger.warn(`Candles ${pair}: ${e.message}`); }
    }));
  }

  _cleanHourlyTrades(pair) {
    const h = Date.now() - 3600000;
    if (this.hourlyTrades[pair]) this.hourlyTrades[pair] = this.hourlyTrades[pair].filter(t=>t>h);
  }

  _getPriceSnap() {
    const snap={};
    for (const p of this.pairs) snap[p]={ price:this.pairData[p]?.price, analysis:this.pairData[p]?.analysis };
    return snap;
  }

  addListener(ws)    { this.wsListeners.add(ws); this._sendToClient(ws,{type:'INIT',data:this.getState()}); }
  removeListener(ws) { this.wsListeners.delete(ws); }
  _broadcast(msg)    {
    const d=JSON.stringify(msg);
    this.wsListeners.forEach(ws=>{ try{if(ws.readyState===1)ws.send(d);}catch{this.wsListeners.delete(ws);} });
  }
  _sendToClient(ws,msg) { try{if(ws.readyState===1)ws.send(JSON.stringify(msg));}catch{} }
  _broadcastState()  { this._broadcast({type:'STATE',data:this.getState()}); }

  getState() {
    return {
      running:      this.isRunning,
      pairs:        this.pairs,
      maxPositions: this.maxPositions,
      balance:      this.balance,
      startBalance: this.startBalance,
      positions:    [...this.positions.values()],
      trades:       this.trades.slice(0,50),
      stats:        this.stats,
      dailyPnl:     this.dailyPnl,
      config: {
        tpMode:   this.tpOverride ? 'FIXE '+( this.tpOverride*100).toFixed(2)+'%' : 'ADAPTATIF (ATR×2)',
        slMode:   this.slOverride ? 'FIXE '+(this.slOverride*100).toFixed(2)+'%'  : 'ADAPTATIF (ATR×1)',
        leverage: this.leverage,
        timeout:  this.timeoutProfit/1000,
        cooldown: this.cooldownMs/1000,
      },
      pairData: Object.fromEntries(
        this.pairs.map(p=>[p,{
          price:   this.pairData[p]?.price,
          analysis:this.pairData[p]?.analysis,
          candles: (this.pairData[p]?.candles||[]).slice(-60).map(c=>({t:c.closeTime,o:c.open,h:c.high,l:c.low,c:c.close,v:c.volume})),
        }])
      ),
      timestamp: Date.now(),
    };
  }
}

module.exports = new Scalper();
