// ================================================================
// binance-futures.js — Client Binance FUTURES (Long + Short)
// Endpoints: /fapi/ (Futures) au lieu de /api/ (Spot)
// ================================================================
const axios  = require('axios');
const crypto = require('crypto');
const { logger } = require('./logger');

class BinanceFutures {
  constructor() {
    this.apiKey    = process.env.BINANCE_API_KEY;
    this.secretKey = process.env.BINANCE_SECRET_KEY;
    this.mode      = process.env.TRADE_MODE || 'testnet';
    this.leverage  = parseInt(process.env.LEVERAGE) || 3;

    if (this.mode === 'testnet') {
      this.baseUrl = 'https://testnet.binancefuture.com';
      logger.info('🟡 Mode FUTURES TESTNET — argent fictif');
    } else {
      this.baseUrl = 'https://fapi.binance.com';
      logger.warn('🔴 Mode FUTURES LIVE — argent réel + levier !');
    }

    this.http = axios.create({
      baseURL: this.baseUrl,
      timeout: 8000,
      headers: { 'X-MBX-APIKEY': this.apiKey },
    });

    this.http.interceptors.response.use(
      r => r,
      err => {
        const msg = err.response?.data?.msg || err.message;
        // ── FIX: Ne pas logger les erreurs "No need to change" comme erreur ──
        if (msg && msg.toLowerCase().includes('no need')) {
          return Promise.reject(new Error(msg));
        }
        logger.error(`Futures API: ${msg}`);
        return Promise.reject(new Error(msg));
      }
    );

    this.timeOffset = 0;
    this.symbolInfo = {};
  }

  // ----------------------------------------------------------------
  // SIGNATURE
  // ----------------------------------------------------------------
  _sign(params = {}) {
    const ts = Date.now() + this.timeOffset;
    const query = new URLSearchParams({ ...params, timestamp: ts, recvWindow: 6000 }).toString();
    const sig = crypto.createHmac('sha256', this.secretKey).update(query).digest('hex');
    return `${query}&signature=${sig}`;
  }

  // ----------------------------------------------------------------
  // SYNC HORLOGE
  // ----------------------------------------------------------------
  async syncTime() {
    const res = await this.http.get('/fapi/v1/time');
    this.timeOffset = res.data.serverTime - Date.now();
    logger.info(`⏱️ Décalage corrigé: ${this.timeOffset}ms`);
  }

  // ----------------------------------------------------------------
  // INFO MARCHÉ
  // ----------------------------------------------------------------
  async ping() {
    return this.http.get('/fapi/v1/ping');
  }

  async getPrice(symbol) {
    const r = await this.http.get('/fapi/v1/ticker/price', { params: { symbol } });
    return parseFloat(r.data.price);
  }

  async get24hrStats(symbol) {
    const r = await this.http.get('/fapi/v1/ticker/24hr', { params: { symbol } });
    return {
      symbol: r.data.symbol,
      lastPrice: parseFloat(r.data.lastPrice),
      priceChangePercent: parseFloat(r.data.priceChangePercent),
      highPrice: parseFloat(r.data.highPrice),
      lowPrice: parseFloat(r.data.lowPrice),
      volume: parseFloat(r.data.volume),
      quoteVolume: parseFloat(r.data.quoteVolume),
    };
  }

  async getKlines(symbol, interval = '1m', limit = 100) {
    const r = await this.http.get('/fapi/v1/klines', {
      params: { symbol, interval, limit },
    });
    return r.data.map(k => ({
      openTime: k[0], open: +k[1], high: +k[2],
      low: +k[3], close: +k[4], volume: +k[5], closeTime: k[6],
    }));
  }

  async getOrderBook(symbol, limit = 20) {
    const r = await this.http.get('/fapi/v1/depth', { params: { symbol, limit } });
    const bids = r.data.bids.map(b => ({ price: +b[0], qty: +b[1] }));
    const asks = r.data.asks.map(a => ({ price: +a[0], qty: +a[1] }));
    const bidVol = bids.reduce((s, b) => s + b.qty, 0);
    const askVol = asks.reduce((s, a) => s + a.qty, 0);
    return {
      bids, asks, bidVol, askVol,
      imbalance: (bidVol - askVol) / (bidVol + askVol),
      spread: asks[0].price - bids[0].price,
      bestBid: bids[0].price,
      bestAsk: asks[0].price,
    };
  }

  async getRecentTrades(symbol, limit = 50) {
    const r = await this.http.get('/fapi/v1/trades', { params: { symbol, limit } });
    return r.data.map(t => ({ price: +t.price, qty: +t.quoteQty, isBuyer: t.isBuyerMaker === false }));
  }

  // ----------------------------------------------------------------
  // COMPTE & POSITIONS
  // ----------------------------------------------------------------
  async getAccount() {
    const r = await this.http.get(`/fapi/v2/account?${this._sign()}`);
    return r.data;
  }

  async getBalance() {
    const acc = await this.getAccount();
    const usdt = acc.assets?.find(a => a.asset === 'USDT');
    return {
      available: parseFloat(usdt?.availableBalance || 0),
      total: parseFloat(usdt?.walletBalance || 0),
      unrealizedPnl: parseFloat(acc.totalUnrealizedProfit || 0),
    };
  }

  async getOpenPositions() {
    const r = await this.http.get(`/fapi/v2/positionRisk?${this._sign()}`);
    return r.data.filter(p => parseFloat(p.positionAmt) !== 0).map(p => ({
      symbol:       p.symbol,
      side:         parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
      size:         Math.abs(parseFloat(p.positionAmt)),
      entryPrice:   parseFloat(p.entryPrice),
      markPrice:    parseFloat(p.markPrice),
      unrealizedPnl: parseFloat(p.unRealizedProfit),
      leverage:     parseInt(p.leverage),
      liquidationPrice: parseFloat(p.liquidationPrice),
    }));
  }

  // ----------------------------------------------------------------
  // CONFIGURATION DU LEVIER
  // ----------------------------------------------------------------
  async setLeverage(symbol, leverage) {
    const r = await this.http.post(`/fapi/v1/leverage?${this._sign({ symbol, leverage })}`);
    logger.info(`⚙️ Levier ${symbol}: x${r.data.leverage}`);
    return r.data;
  }

  // ── FIX: Ignorer silencieusement "No need to change" (erreur bénigne) ──
  async setMarginType(symbol, marginType = 'ISOLATED') {
    try {
      await this.http.post(`/fapi/v1/marginType?${this._sign({ symbol, marginType })}`);
      logger.info(`⚙️ Margin type ${symbol}: ${marginType}`);
    } catch (e) {
      const msg = e.message || '';
      // Code -4046 = margin type already set — pas une vraie erreur
      if (msg.toLowerCase().includes('no need') || msg.includes('-4046')) {
        // Silencieux — déjà configuré correctement
        return;
      }
      throw e; // Relancer les vraies erreurs
    }
  }

  // ----------------------------------------------------------------
  // RÉCUPÉRER LA QUANTITÉ MINIMUM
  // ----------------------------------------------------------------
  async getSymbolInfo(symbol) {
    if (this.symbolInfo[symbol]) return this.symbolInfo[symbol];
    const r = await this.http.get('/fapi/v1/exchangeInfo');
    const info = r.data.symbols.find(s => s.symbol === symbol);
    if (!info) throw new Error(`Symbol ${symbol} not found`);

    const lotFilter = info.filters.find(f => f.filterType === 'LOT_SIZE');
    const minFilter = info.filters.find(f => f.filterType === 'MIN_NOTIONAL');

    const result = {
      symbol,
      stepSize:    parseFloat(lotFilter?.stepSize || 0.001),
      minQty:      parseFloat(lotFilter?.minQty || 0.001),
      minNotional: parseFloat(minFilter?.notional || 5),
      pricePrecision: info.pricePrecision || 2,
      quantityPrecision: info.quantityPrecision || 3,
    };

    this.symbolInfo[symbol] = result;
    return result;
  }

  roundQty(qty, stepSize) {
    const precision = Math.round(-Math.log10(stepSize));
    return parseFloat(qty.toFixed(precision));
  }

  // ----------------------------------------------------------------
  // ORDRES FUTURES
  // ----------------------------------------------------------------
  async openLong(symbol, usdtAmount) {
    return this._openPosition(symbol, 'BUY', 'LONG', usdtAmount);
  }

  async openShort(symbol, usdtAmount) {
    return this._openPosition(symbol, 'SELL', 'SHORT', usdtAmount);
  }

  async _openPosition(symbol, side, positionSide, usdtAmount) {
    const price = await this.getPrice(symbol);
    const info  = await this.getSymbolInfo(symbol);

    let rawQty = (usdtAmount * this.leverage) / price;

    const minNotionalQty = info.minNotional / price;
    if (rawQty < minNotionalQty) {
      rawQty = minNotionalQty * 1.01;
      const requiredUsdt = (rawQty * price) / this.leverage;
      logger.warn(`⚠️ Notionnel minimum ajusté pour ${symbol}: ${requiredUsdt.toFixed(2)} USDT requis (vous aviez ${usdtAmount}$)`);
    }

    const qty = this.roundQty(rawQty, info.stepSize);

    if (qty < info.minQty) {
      throw new Error(`Quantité ${qty} < minimum ${info.minQty} pour ${symbol}. Augmentez TRADE_AMOUNT_USDT.`);
    }

    const notional = qty * price;
    if (notional < info.minNotional) {
      throw new Error(`Notionnel ${notional.toFixed(2)}$ < minimum ${info.minNotional}$ pour ${symbol}. Augmentez TRADE_AMOUNT_USDT à au moins ${Math.ceil(info.minNotional/this.leverage)+5}$.`);
    }

    const params = {
      symbol,
      side,
      positionSide,
      type:     'MARKET',
      quantity: qty.toFixed(info.quantityPrecision),
    };

    const effectiveUsdt = (qty * price / this.leverage).toFixed(2);
    logger.info(`📤 OPEN ${positionSide} ${symbol} | qty:${qty} | notionnel:${notional.toFixed(2)}$ | capital:~${effectiveUsdt}$ | levier:x${this.leverage}`);
    const r = await this.http.post(`/fapi/v1/order?${this._sign(params)}`);

    return {
      orderId:    r.data.orderId,
      symbol,
      side:       positionSide,
      qty,
      entryPrice: price,
      notional,
      usdtAmount: parseFloat(effectiveUsdt),
      status:     r.data.status,
      timestamp:  r.data.updateTime,
    };
  }

  async closeLong(symbol, qty) {
    return this._closePosition(symbol, 'SELL', 'LONG', qty);
  }

  async closeShort(symbol, qty) {
    return this._closePosition(symbol, 'BUY', 'SHORT', qty);
  }

  async _closePosition(symbol, side, positionSide, qty) {
    const info = await this.getSymbolInfo(symbol);
    const roundedQty = this.roundQty(qty, info.stepSize);

    const params = {
      symbol,
      side,
      positionSide,
      type:         'MARKET',
      quantity:     roundedQty.toFixed(info.quantityPrecision),
    };

    logger.info(`📤 CLOSE ${positionSide} ${symbol} | qty:${roundedQty}`);
    const r = await this.http.post(`/fapi/v1/order?${this._sign(params)}`);
    return r.data;
  }

  async closeAllPositions(symbol) {
    const positions = await this.getOpenPositions();
    const toClose = positions.filter(p => p.symbol === symbol);
    for (const pos of toClose) {
      if (pos.side === 'LONG') await this.closeLong(symbol, pos.size);
      else await this.closeShort(symbol, pos.size);
    }
  }

  // ----------------------------------------------------------------
  // TEST CONNEXION
  // ----------------------------------------------------------------
  async testConnection() {
    try {
      await this.ping();
      await this.syncTime();
      const bal = await this.getBalance();
      logger.info(`✅ Futures connecté | Balance: ${bal.available.toFixed(2)} USDT`);
      return { success: true, balance: bal };
    } catch (err) {
      logger.error(`❌ Connexion Futures échouée: ${err.message}`);
      return { success: false, error: err.message };
    }
  }
}

module.exports = new BinanceFutures();