// ================================================================
// scalp-strategy.js — Stratégie de scalping haute fréquence
// Algorithmes: Momentum, Order Flow, RSI rapide, Micro-structure
// ================================================================

// ----------------------------------------------------------------
// INDICATEURS ULTRA-RAPIDES (optimisés pour 1m/30s)
// ----------------------------------------------------------------

function calcRSI(closes, period = 9) { // RSI 9 pour scalping (plus rapide)
  if (closes.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) avgGain += d; else avgLoss += Math.abs(d);
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    avgGain = (avgGain * (period-1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period-1) + (d < 0 ? Math.abs(d) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return parseFloat((100 - 100 / (1 + avgGain / avgLoss)).toFixed(2));
}

function calcEMA(closes, period) {
  if (closes.length < period) return closes[closes.length-1];
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a,b) => a+b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1-k);
  return ema;
}

function calcSMA(closes, period) {
  if (closes.length < period) return closes[closes.length-1];
  return closes.slice(-period).reduce((a,b) => a+b, 0) / period;
}

// Stochastique RSI — très réactif, idéal scalping
function calcStochRSI(closes, rsiPeriod = 9, stochPeriod = 9) {
  if (closes.length < rsiPeriod + stochPeriod) return { k: 50, d: 50 };

  const rsiValues = [];
  for (let i = rsiPeriod; i < closes.length; i++) {
    rsiValues.push(calcRSI(closes.slice(0, i+1), rsiPeriod));
  }

  const recentRsi = rsiValues.slice(-stochPeriod);
  const minRsi = Math.min(...recentRsi);
  const maxRsi = Math.max(...recentRsi);
  const lastRsi = rsiValues[rsiValues.length - 1];

  const k = maxRsi === minRsi ? 50 : ((lastRsi - minRsi) / (maxRsi - minRsi)) * 100;
  const prevK = rsiValues.length > 1
    ? ((rsiValues[rsiValues.length-2] - minRsi) / (maxRsi - minRsi || 1)) * 100
    : k;
  const d = (k + prevK) / 2;

  return { k: parseFloat(k.toFixed(2)), d: parseFloat(d.toFixed(2)) };
}

// VWAP (Volume Weighted Average Price) — niveau clé pour scalping
function calcVWAP(candles) {
  let cumTPV = 0, cumVol = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume;
    cumVol += c.volume;
  }
  return cumVol === 0 ? 0 : cumTPV / cumVol;
}

// ATR pour mesurer la volatilité et calibrer le TP/SL
function calcATR(candles, period = 7) {
  if (candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i-1].close;
    trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
  }
  return trs.slice(-period).reduce((a,b) => a+b, 0) / Math.min(period, trs.length);
}

// Momentum = variation % sur N bougies
function calcMomentum(closes, period = 5) {
  if (closes.length < period + 1) return 0;
  const ref = closes[closes.length - 1 - period];
  if (ref === 0) return 0;
  return (closes[closes.length - 1] - ref) / ref * 100;
}

// Volume delta (pression achat vs vente sur les dernières bougies)
function calcVolumePressure(candles, period = 5) {
  const recent = candles.slice(-period);
  let buyVol = 0, sellVol = 0;
  for (const c of recent) {
    const body = Math.abs(c.close - c.open);
    if (c.close > c.open) buyVol += c.volume * (body / (c.high - c.low || 1));
    else sellVol += c.volume * (body / (c.high - c.low || 1));
  }
  const total = buyVol + sellVol;
  return total === 0 ? 0 : (buyVol - sellVol) / total; // [-1, +1]
}

// Détection de breakout (cassure de range)
function detectBreakout(candles, period = 10) {
  if (candles.length < period + 1) return { type: 'NONE', strength: 0 };
  const recent = candles.slice(-period - 1, -1); // Exclure la dernière bougie
  const high = Math.max(...recent.map(c => c.high));
  const low  = Math.min(...recent.map(c => c.low));
  const last = candles[candles.length - 1];

  if (last.close > high) {
    const strength = (last.close - high) / high * 100;
    return { type: 'BULLISH', strength: parseFloat(strength.toFixed(4)) };
  }
  if (last.close < low) {
    const strength = (low - last.close) / low * 100;
    return { type: 'BEARISH', strength: parseFloat(strength.toFixed(4)) };
  }
  return { type: 'NONE', strength: 0 };
}

// ----------------------------------------------------------------
// ANALYSE ORDER FLOW (données temps réel du carnet d'ordres)
// ----------------------------------------------------------------
function analyzeOrderFlow(orderBook) {
  if (!orderBook) return { signal: 'NEUTRAL', score: 0 };

  const { imbalance, spread, bidVol, askVol } = orderBook;

  // imbalance > +0.15 = pression achat forte
  // imbalance < -0.15 = pression vente forte
  let score = 0;
  if (imbalance > 0.15) score += 40;
  else if (imbalance > 0.05) score += 20;
  else if (imbalance < -0.15) score -= 40;
  else if (imbalance < -0.05) score -= 20;

  const signal = score > 20 ? 'BUY' : score < -20 ? 'SELL' : 'NEUTRAL';
  return { signal, score, imbalance, spread, bidVol, askVol };
}

// ----------------------------------------------------------------
// STRATÉGIE SCALPING PRINCIPALE
// ----------------------------------------------------------------
function scalpAnalyze(candles, orderBook = null, recentTrades = []) {
  if (candles.length < 20) {
    return { action: 'HOLD', side: null, confidence: 0, reason: 'Pas assez de données' };
  }

  const closes  = candles.map(c => c.close);
  const current = closes[closes.length - 1];

  // --- CALCUL INDICATEURS ---
  const rsi9      = calcRSI(closes, 9);
  const rsi14     = calcRSI(closes, 14);
  const stochRsi  = calcStochRSI(closes, 9, 9);
  const ema5      = calcEMA(closes, 5);
  const ema13     = calcEMA(closes, 13);
  const ema21     = calcEMA(closes, 21);
  const vwap      = calcVWAP(candles);
  const atr       = calcATR(candles, 7);
  const momentum5 = calcMomentum(closes, 5);
  const momentum3 = calcMomentum(closes, 3);
  const volPres   = calcVolumePressure(candles, 5);
  const breakout  = detectBreakout(candles, 8);
  const orderFlow = analyzeOrderFlow(orderBook);

  // Volatilité relative (ATR / prix)
  const atrPct = (atr / current) * 100;

  // --- SCORING ---
  let longScore  = 0;  // Score pour LONG (achat)
  let shortScore = 0;  // Score pour SHORT (vente)
  const signals  = [];

  // ── 1. STOCHASTIC RSI (signal le plus réactif) ──────────────────
  if (stochRsi.k < 20 && stochRsi.k > stochRsi.d) {
    // K oversold et croise D vers le haut = signal LONG fort
    longScore += 35;
    signals.push({ name: 'StochRSI Oversold + Cross', value: `K:${stochRsi.k} D:${stochRsi.d}`, side: 'LONG', pts: 35 });
  } else if (stochRsi.k < 30) {
    longScore += 20;
    signals.push({ name: 'StochRSI Oversold', value: `K:${stochRsi.k}`, side: 'LONG', pts: 20 });
  }

  if (stochRsi.k > 80 && stochRsi.k < stochRsi.d) {
    shortScore += 35;
    signals.push({ name: 'StochRSI Overbought + Cross', value: `K:${stochRsi.k} D:${stochRsi.d}`, side: 'SHORT', pts: 35 });
  } else if (stochRsi.k > 70) {
    shortScore += 20;
    signals.push({ name: 'StochRSI Overbought', value: `K:${stochRsi.k}`, side: 'SHORT', pts: 20 });
  }

  // ── 2. RSI 9 (rapide) ───────────────────────────────────────────
  const rsiOversold  = parseFloat(process.env.RSI_OVERSOLD  || 38);
  const rsiOverbought= parseFloat(process.env.RSI_OVERBOUGHT|| 62);

  if (rsi9 < rsiOversold) {
    longScore += 25;
    signals.push({ name: `RSI9 Oversold (<${rsiOversold})`, value: rsi9, side: 'LONG', pts: 25 });
  } else if (rsi9 < 45) {
    longScore += 12;
    signals.push({ name: 'RSI9 Bas', value: rsi9, side: 'LONG', pts: 12 });
  }

  if (rsi9 > rsiOverbought) {
    shortScore += 25;
    signals.push({ name: `RSI9 Overbought (>${rsiOverbought})`, value: rsi9, side: 'SHORT', pts: 25 });
  } else if (rsi9 > 55) {
    shortScore += 12;
    signals.push({ name: 'RSI9 Haut', value: rsi9, side: 'SHORT', pts: 12 });
  }

  // ── 3. EMA ALIGNMENT (5/13/21) ──────────────────────────────────
  if (ema5 > ema13 && ema13 > ema21 && current > ema5) {
    longScore += 30;
    signals.push({ name: 'EMA Bull Alignment (5>13>21)', value: `${ema5.toFixed(2)}>>${ema21.toFixed(2)}`, side: 'LONG', pts: 30 });
  } else if (ema5 > ema13 && current > ema5) {
    longScore += 15;
    signals.push({ name: 'EMA5 > EMA13', value: `${ema5.toFixed(2)}>${ema13.toFixed(2)}`, side: 'LONG', pts: 15 });
  }

  if (ema5 < ema13 && ema13 < ema21 && current < ema5) {
    shortScore += 30;
    signals.push({ name: 'EMA Bear Alignment (5<13<21)', value: `${ema5.toFixed(2)}<<${ema21.toFixed(2)}`, side: 'SHORT', pts: 30 });
  } else if (ema5 < ema13 && current < ema5) {
    shortScore += 15;
    signals.push({ name: 'EMA5 < EMA13', value: `${ema5.toFixed(2)}<${ema13.toFixed(2)}`, side: 'SHORT', pts: 15 });
  }

  // ── 4. VWAP (niveau de référence des institutionnels) ────────────
  if (current > vwap * 1.0008) {
    // Prix bien au-dessus du VWAP = momentum haussier
    longScore += 15;
    signals.push({ name: 'Prix > VWAP', value: `+${((current/vwap-1)*100).toFixed(3)}%`, side: 'LONG', pts: 15 });
  } else if (current < vwap * 0.9992) {
    shortScore += 15;
    signals.push({ name: 'Prix < VWAP', value: `${((current/vwap-1)*100).toFixed(3)}%`, side: 'SHORT', pts: 15 });
  }

  // ── 5. MOMENTUM ──────────────────────────────────────────────────
  if (momentum3 > 0.08 && momentum5 > 0.12) {
    longScore += 20;
    signals.push({ name: 'Momentum Haussier', value: `3p:+${momentum3.toFixed(3)}% 5p:+${momentum5.toFixed(3)}%`, side: 'LONG', pts: 20 });
  } else if (momentum3 > 0.04) {
    longScore += 10;
    signals.push({ name: 'Momentum Positif', value: `${momentum3.toFixed(3)}%`, side: 'LONG', pts: 10 });
  }

  if (momentum3 < -0.08 && momentum5 < -0.12) {
    shortScore += 20;
    signals.push({ name: 'Momentum Baissier', value: `3p:${momentum3.toFixed(3)}% 5p:${momentum5.toFixed(3)}%`, side: 'SHORT', pts: 20 });
  } else if (momentum3 < -0.04) {
    shortScore += 10;
    signals.push({ name: 'Momentum Négatif', value: `${momentum3.toFixed(3)}%`, side: 'SHORT', pts: 10 });
  }

  // ── 6. VOLUME PRESSURE ───────────────────────────────────────────
  if (volPres > 0.25) {
    longScore += 15;
    signals.push({ name: 'Volume Pressure Buy', value: `${(volPres*100).toFixed(1)}%`, side: 'LONG', pts: 15 });
  } else if (volPres < -0.25) {
    shortScore += 15;
    signals.push({ name: 'Volume Pressure Sell', value: `${(volPres*100).toFixed(1)}%`, side: 'SHORT', pts: 15 });
  }

  // ── 7. ORDER FLOW (carnet d'ordres en temps réel) ────────────────
  if (orderFlow.signal === 'BUY') {
    longScore += 20;
    signals.push({ name: 'Order Flow Buy', value: `imb:${(orderFlow.imbalance*100).toFixed(1)}%`, side: 'LONG', pts: 20 });
  } else if (orderFlow.signal === 'SELL') {
    shortScore += 20;
    signals.push({ name: 'Order Flow Sell', value: `imb:${(orderFlow.imbalance*100).toFixed(1)}%`, side: 'SHORT', pts: 20 });
  }

  // ── 8. BREAKOUT ──────────────────────────────────────────────────
  if (breakout.type === 'BULLISH' && breakout.strength > 0.02) {
    longScore += 25;
    signals.push({ name: 'Breakout Haussier', value: `+${breakout.strength.toFixed(3)}%`, side: 'LONG', pts: 25 });
  } else if (breakout.type === 'BEARISH' && breakout.strength > 0.02) {
    shortScore += 25;
    signals.push({ name: 'Breakout Baissier', value: `-${breakout.strength.toFixed(3)}%`, side: 'SHORT', pts: 25 });
  }

  // --- DÉCISION FINALE ---
  // Seuil minimal pour entrer en trade: score >= 50
  const ENTRY_THRESHOLD = 50;
  let action = 'HOLD';
  let side   = null;

  const totalScore = Math.max(longScore, shortScore);
  const scoreDiff  = Math.abs(longScore - shortScore);

  // N'entrer que si un côté domine clairement (diff >= 20 pts)
  if (longScore >= ENTRY_THRESHOLD && longScore > shortScore + 15) {
    action = 'OPEN';
    side   = 'LONG';
  } else if (shortScore >= ENTRY_THRESHOLD && shortScore > longScore + 15) {
    action = 'OPEN';
    side   = 'SHORT';
  }

  // --- TP/SL DYNAMIQUES basés sur l'ATR ---
  const minTpPct = parseFloat(process.env.TAKE_PROFIT_PCT || 0.4);
  const minSlPct = parseFloat(process.env.STOP_LOSS_PCT   || 0.25);
  // TP = max(config, 1.5x ATR) | SL = max(config, 0.8x ATR)
  const tpPct = Math.max(minTpPct, (atr / current * 100) * 1.5);
  const slPct = Math.max(minSlPct, (atr / current * 100) * 0.8);

  return {
    action,
    side,
    confidence: Math.min(100, Math.round(totalScore)),
    longScore,
    shortScore,
    signals,
    indicators: {
      price: current,
      rsi9, rsi14,
      stochK: stochRsi.k,
      stochD: stochRsi.d,
      ema5: parseFloat(ema5.toFixed(4)),
      ema13: parseFloat(ema13.toFixed(4)),
      ema21: parseFloat(ema21.toFixed(4)),
      vwap: parseFloat(vwap.toFixed(4)),
      atr: parseFloat(atr.toFixed(6)),
      atrPct: parseFloat(atrPct.toFixed(4)),
      momentum3, momentum5,
      volPressure: parseFloat(volPres.toFixed(4)),
      breakout,
      orderFlow,
    },
    tpPct: parseFloat(tpPct.toFixed(4)),
    slPct: parseFloat(slPct.toFixed(4)),
    timestamp: Date.now(),
  };
}

module.exports = { scalpAnalyze, calcRSI, calcEMA, calcATR, calcVWAP, calcStochRSI };
