// ================================================================
// scalp-strategy.js v2.0 — Stratégie professionnelle HFT
// Basée sur: Market Structure, Order Flow, Momentum, Mean Reversion
// Objectif: signaux de haute qualité, biais directionnel correct
// ================================================================

// ----------------------------------------------------------------
// INDICATEURS CORE (calculs optimisés en ms)
// ----------------------------------------------------------------

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i-1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    avgGain = (avgGain * (period-1) + Math.max(d,0)) / period;
    avgLoss = (avgLoss * (period-1) + Math.max(-d,0)) / period;
  }
  return avgLoss === 0 ? 100 : parseFloat((100 - 100/(1 + avgGain/avgLoss)).toFixed(2));
}

function calcEMA(closes, period) {
  if (closes.length < period) return closes[closes.length-1];
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a,b) => a+b) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i]*k + ema*(1-k);
  return ema;
}

// Stochastique rapide (3 périodes)
function calcStochRSI(closes, rsiPer=14, stochPer=5) {
  if (closes.length < rsiPer + stochPer) return { k:50, d:50 };
  const rsiArr = [];
  for (let i = rsiPer; i < closes.length; i++) {
    rsiArr.push(calcRSI(closes.slice(0, i+1), rsiPer));
  }
  const recent = rsiArr.slice(-stochPer);
  const minR = Math.min(...recent), maxR = Math.max(...recent);
  const lastR = rsiArr[rsiArr.length-1];
  const k = maxR === minR ? 50 : (lastR - minR) / (maxR - minR) * 100;
  const prevK = rsiArr.length > 1 ? ((rsiArr[rsiArr.length-2] - minR) / (maxR - minR || 1)) * 100 : k;
  return { k: parseFloat(k.toFixed(2)), d: parseFloat(((k+prevK)/2).toFixed(2)) };
}

// ATR dynamique pour TP/SL adaptatifs
function calcATR(candles, period=10) {
  if (candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i-1].close;
    trs.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
  }
  return trs.slice(-period).reduce((a,b) => a+b) / Math.min(period, trs.length);
}

// VWAP sur la session
function calcVWAP(candles) {
  let tpv = 0, vol = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    tpv += tp * c.volume; vol += c.volume;
  }
  return vol === 0 ? candles[candles.length-1].close : tpv / vol;
}

// ----------------------------------------------------------------
// DÉTECTION DE STRUCTURE DE MARCHÉ (Market Structure)
// Identifie: Higher High/Lower Low, Support/Resistance, Trend
// ----------------------------------------------------------------
function detectMarketStructure(candles, lookback=20) {
  if (candles.length < lookback) return { trend: 'NEUTRAL', strength: 0 };
  
  const recent = candles.slice(-lookback);
  const closes = recent.map(c => c.close);
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);
  
  // Détecter HH/HL (uptrend) ou LH/LL (downtrend)
  const mid = Math.floor(lookback/2);
  const firstHalf = closes.slice(0, mid);
  const secHalf = closes.slice(mid);
  
  const avgFirst = firstHalf.reduce((a,b)=>a+b) / firstHalf.length;
  const avgSec = secHalf.reduce((a,b)=>a+b) / secHalf.length;
  
  // Angle de la tendance
  const slope = (avgSec - avgFirst) / avgFirst * 100;
  
  // Consolidation: range étroit = marché plat → éviter!
  const highRange = Math.max(...highs) - Math.min(...lows);
  const avgClose = closes.reduce((a,b)=>a+b) / closes.length;
  const rangePct = highRange / avgClose * 100;
  
  let trend = 'NEUTRAL';
  let strength = 0;
  
  if (slope > 0.05 && rangePct > 0.3) { trend = 'BULLISH'; strength = Math.min(100, slope * 20); }
  else if (slope < -0.05 && rangePct > 0.3) { trend = 'BEARISH'; strength = Math.min(100, Math.abs(slope) * 20); }
  else { trend = 'NEUTRAL'; strength = 0; }
  
  return { trend, strength: parseFloat(strength.toFixed(1)), slope: parseFloat(slope.toFixed(4)), rangePct: parseFloat(rangePct.toFixed(4)) };
}

// ----------------------------------------------------------------
// DÉTECTION DE MOMENTUM (Taux de changement)
// ----------------------------------------------------------------
function calcMomentumScore(closes) {
  if (closes.length < 10) return 0;
  const last = closes[closes.length-1];
  const m1  = (last - closes[closes.length-2]) / closes[closes.length-2] * 100;   // 1 bougie
  const m3  = (last - closes[closes.length-4]) / closes[closes.length-4] * 100;   // 3 bougies
  const m5  = (last - closes[closes.length-6]) / closes[closes.length-6] * 100;   // 5 bougies
  // Pondération: m1 compte plus pour scalping
  return m1 * 0.5 + m3 * 0.3 + m5 * 0.2;
}

// ----------------------------------------------------------------
// ANALYSE DU CARNET D'ORDRES (Order Flow)
// ----------------------------------------------------------------
function analyzeOrderFlow(orderBook) {
  if (!orderBook) return { signal: 'NEUTRAL', pressure: 0 };
  const { bidVol, askVol, imbalance, spread } = orderBook;
  // Pression achat forte = imbalance positif
  const pressure = parseFloat((imbalance * 100).toFixed(2));
  const signal = pressure > 15 ? 'BUY' : pressure < -15 ? 'SELL' : 'NEUTRAL';
  return { signal, pressure, spread };
}

// ----------------------------------------------------------------
// FILTRE DE VOLATILITÉ — Évite les marchés trop plats ou trop chauds
// ----------------------------------------------------------------
function volatilityFilter(candles, minAtrPct=0.05, maxAtrPct=0.8) {
  const atr = calcATR(candles, 10);
  const price = candles[candles.length-1].close;
  const atrPct = atr / price * 100;
  return {
    ok: atrPct >= minAtrPct && atrPct <= maxAtrPct,
    atr,
    atrPct: parseFloat(atrPct.toFixed(4)),
    tooFlat: atrPct < minAtrPct,
    tooVolatile: atrPct > maxAtrPct,
  };
}

// ----------------------------------------------------------------
// STRATÉGIE PRINCIPALE v2.0
// Philosophie: qualité > quantité, confirmation multiple
// ----------------------------------------------------------------
function scalpAnalyze(candles, orderBook=null) {
  if (!candles || candles.length < 30) {
    return { action:'HOLD', side:null, confidence:0, reason:'Données insuffisantes' };
  }

  const closes  = candles.map(c => c.close);
  const current = closes[closes.length-1];

  // ── CALCUL RAPIDE DES INDICATEURS ────────────────────────────
  const rsi14    = calcRSI(closes, 14);
  const rsi7     = calcRSI(closes, 7);       // ultra-rapide
  const ema8     = calcEMA(closes, 8);
  const ema21    = calcEMA(closes, 21);
  const ema55    = calcEMA(closes, 55);
  const stoch    = calcStochRSI(closes, 14, 5);
  const vwap     = calcVWAP(candles);
  const atr      = calcATR(candles, 10);
  const atrPct   = atr / current * 100;
  const ms       = detectMarketStructure(candles, 20);
  const mom      = calcMomentumScore(closes);
  const of       = analyzeOrderFlow(orderBook);
  const vol      = volatilityFilter(candles, 0.04, 1.2);

  // ── FILTRE PRIMAIRE: marché trop plat = pas de trade ─────────
  if (vol.tooFlat) {
    return {
      action:'HOLD', side:null, confidence:0,
      reason:`Marché trop plat (ATR=${atrPct.toFixed(3)}% < 0.04%)`,
      indicators: { rsi14, ema8, ema21, stochK:stoch.k, vwap, atr, atrPct, momentum:mom, marketStructure:ms, orderFlow:of }
    };
  }

  // ── SCORING DIRECTIONNEL ──────────────────────────────────────
  let longScore = 0, shortScore = 0;
  const signals = [];

  // 1. STRUCTURE DE MARCHÉ (poids fort: 35 pts)
  if (ms.trend === 'BULLISH') {
    longScore += 35;
    signals.push({ name:'Market Structure BULL', pts:35, side:'LONG' });
  } else if (ms.trend === 'BEARISH') {
    shortScore += 35;
    signals.push({ name:'Market Structure BEAR', pts:35, side:'SHORT' });
  }

  // 2. ALIGNEMENT EMA (poids fort: 30 pts)
  if (ema8 > ema21 && ema21 > ema55 && current > ema8) {
    longScore += 30;
    signals.push({ name:'EMA Bull Stack', pts:30, side:'LONG' });
  } else if (ema8 < ema21 && ema21 < ema55 && current < ema8) {
    shortScore += 30;
    signals.push({ name:'EMA Bear Stack', pts:30, side:'SHORT' });
  } else if (current > ema8 && ema8 > ema21) {
    longScore += 15;
    signals.push({ name:'EMA8>21 Bull', pts:15, side:'LONG' });
  } else if (current < ema8 && ema8 < ema21) {
    shortScore += 15;
    signals.push({ name:'EMA8<21 Bear', pts:15, side:'SHORT' });
  }

  // 3. VWAP — Niveau clé institutionnel (20 pts)
  const vwapDist = ((current - vwap) / vwap) * 100;
  if (current > vwap * 1.0005) {
    longScore += 20;
    signals.push({ name:`Prix > VWAP +${vwapDist.toFixed(3)}%`, pts:20, side:'LONG' });
  } else if (current < vwap * 0.9995) {
    shortScore += 20;
    signals.push({ name:`Prix < VWAP ${vwapDist.toFixed(3)}%`, pts:20, side:'SHORT' });
  }

  // 4. RSI DOUBLE (rapide + normal) — 25 pts
  // Oversold double confirmation
  if (rsi7 < 25 && rsi14 < 35) {
    longScore += 25;
    signals.push({ name:`RSI Double Oversold (${rsi7}/${rsi14})`, pts:25, side:'LONG' });
  } else if (rsi7 < 35 && rsi14 < 45) {
    longScore += 12;
    signals.push({ name:`RSI Oversold (${rsi7}/${rsi14})`, pts:12, side:'LONG' });
  }
  // Overbought double confirmation
  if (rsi7 > 75 && rsi14 > 65) {
    shortScore += 25;
    signals.push({ name:`RSI Double Overbought (${rsi7}/${rsi14})`, pts:25, side:'SHORT' });
  } else if (rsi7 > 65 && rsi14 > 55) {
    shortScore += 12;
    signals.push({ name:`RSI Overbought (${rsi7}/${rsi14})`, pts:12, side:'SHORT' });
  }

  // 5. STOCHASTIC RSI — Croisements (20 pts)
  if (stoch.k < 20 && stoch.k > stoch.d) {
    longScore += 20;
    signals.push({ name:`StochRSI Cross Up (${stoch.k})`, pts:20, side:'LONG' });
  } else if (stoch.k < 30) {
    longScore += 10;
    signals.push({ name:`StochRSI Low (${stoch.k})`, pts:10, side:'LONG' });
  }
  if (stoch.k > 80 && stoch.k < stoch.d) {
    shortScore += 20;
    signals.push({ name:`StochRSI Cross Down (${stoch.k})`, pts:20, side:'SHORT' });
  } else if (stoch.k > 70) {
    shortScore += 10;
    signals.push({ name:`StochRSI High (${stoch.k})`, pts:10, side:'SHORT' });
  }

  // 6. MOMENTUM (15 pts)
  if (mom > 0.08) {
    longScore += 15;
    signals.push({ name:`Momentum +${mom.toFixed(3)}%`, pts:15, side:'LONG' });
  } else if (mom > 0.03) {
    longScore += 7;
    signals.push({ name:`Momentum faible +${mom.toFixed(3)}%`, pts:7, side:'LONG' });
  }
  if (mom < -0.08) {
    shortScore += 15;
    signals.push({ name:`Momentum ${mom.toFixed(3)}%`, pts:15, side:'SHORT' });
  } else if (mom < -0.03) {
    shortScore += 7;
    signals.push({ name:`Momentum faible ${mom.toFixed(3)}%`, pts:7, side:'SHORT' });
  }

  // 7. ORDER FLOW — Carnet d'ordres (15 pts)
  if (of.signal === 'BUY') {
    longScore += 15;
    signals.push({ name:`Order Flow BUY (${of.pressure}%)`, pts:15, side:'LONG' });
  } else if (of.signal === 'SELL') {
    shortScore += 15;
    signals.push({ name:`Order Flow SELL (${of.pressure}%)`, pts:15, side:'SHORT' });
  }

  // ── ANTI-BIAIS: pénaliser si contre la structure ─────────────
  // Si marché haussier mais signal SHORT → réduire le score SHORT
  if (ms.trend === 'BULLISH' && shortScore > longScore) {
    shortScore = Math.floor(shortScore * 0.6); // -40% si contre tendance
    signals.push({ name:'Pénalité contre-tendance (Bull)', pts:-0, side:'SHORT' });
  }
  if (ms.trend === 'BEARISH' && longScore > shortScore) {
    longScore = Math.floor(longScore * 0.6);
    signals.push({ name:'Pénalité contre-tendance (Bear)', pts:-0, side:'LONG' });
  }

  // ── DÉCISION FINALE ───────────────────────────────────────────
  // Seuil minimum: 45 pts ET domination claire (+15 pts d'écart)
  // 45 pts = au moins 2 signaux confirmant la direction
  const ENTRY_THRESHOLD = 45;
  const DOMINATION_MIN  = 15;

  let action = 'HOLD', side = null;
  const maxScore = Math.max(longScore, shortScore);
  const diff = Math.abs(longScore - shortScore);

  if (longScore  >= ENTRY_THRESHOLD && longScore > shortScore + DOMINATION_MIN) {
    action = 'OPEN'; side = 'LONG';
  } else if (shortScore >= ENTRY_THRESHOLD && shortScore > longScore + DOMINATION_MIN) {
    action = 'OPEN'; side = 'SHORT';
  }

  // ── TP/SL ADAPTATIFS basés sur l'ATR ─────────────────────────
  // TP/SL adaptatifs en RATIO (0.002 = 0.2%)
  // ATR est en % (ex: 0.13) → diviser par 100 pour ratio
  const safeAtrPct = isNaN(atrPct) || atrPct <= 0 ? 0.15 : atrPct;
  const atrRatio = safeAtrPct / 100; // 0.13% → 0.0013
  // TP = 1.8× ATR, SL = 0.9× ATR → ratio 2:1
  // Caps: TP entre 0.12% et 0.35%, SL entre 0.07% et 0.20%
  const rawTP = Math.max(0.0012, Math.min(0.0035, atrRatio * 1.8));
  const rawSL = Math.max(0.0007, Math.min(0.0020, atrRatio * 0.9));

  return {
    action,
    side,
    confidence:  Math.min(100, Math.round(maxScore)),
    longScore:   Math.round(longScore),
    shortScore:  Math.round(shortScore),
    signals,
    tpPct:       parseFloat(rawTP.toFixed(4)),
    slPct:       parseFloat(rawSL.toFixed(4)),
    indicators: {
      price:     current,
      rsi14,     rsi7,
      stochK:    stoch.k,  stochD: stoch.d,
      ema8:      parseFloat(ema8.toFixed(4)),
      ema21:     parseFloat(ema21.toFixed(4)),
      ema55:     parseFloat(ema55.toFixed(4)),
      vwap:      parseFloat(vwap.toFixed(4)),
      vwapDist:  parseFloat(vwapDist.toFixed(4)),
      atr:       parseFloat(atr.toFixed(6)),
      atrPct:    parseFloat(atrPct.toFixed(4)),
      momentum:  parseFloat(mom.toFixed(4)),
      marketStructure: ms,
      orderFlow: of,
      volatility: vol,
    },
    timestamp: Date.now(),
  };
}

module.exports = { scalpAnalyze, calcRSI, calcEMA, calcATR, calcVWAP, calcStochRSI, detectMarketStructure };
