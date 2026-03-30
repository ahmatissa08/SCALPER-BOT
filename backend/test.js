// ================================================================
// test.js — Test de connexion Scalper Bot (Binance Futures)
// ================================================================
require('dotenv').config();
const binance = require('./binance-futures');
const { scalpAnalyze } = require('./scalp-strategy');

async function run() {
  console.log('\n' + '='.repeat(60));
  console.log('  ⚡ ScalperBot — Test Binance Futures');
  console.log('='.repeat(60) + '\n');

  const mode = process.env.TRADE_MODE || 'testnet';
  const pairs = (process.env.TRADE_PAIRS || 'BTCUSDT').split(',');
  console.log(`Mode : ${mode.toUpperCase()}`);
  console.log(`Paires: ${pairs.join(', ')}\n`);

  // Test 1: Sync horloge
  console.log('⏱️ Test 1: Sync horloge...');
  await binance.syncTime();
  console.log(`  ✅ Décalage: ${binance.timeOffset}ms\n`);

  // Test 2: Connexion + Balance
  console.log('💰 Test 2: Balance Futures...');
  const bal = await binance.getBalance();
  console.log(`  ✅ Disponible: ${bal.available.toFixed(2)} USDT`);
  console.log(`  💼 Total: ${bal.total.toFixed(2)} USDT`);
  console.log(`  📊 P&L non réalisé: ${bal.unrealizedPnl.toFixed(4)} USDT\n`);

  // Test 3: Prix
  console.log('📈 Test 3: Prix en temps réel...');
  for (const pair of pairs.slice(0,3)) {
    const price = await binance.getPrice(pair);
    const stats = await binance.get24hrStats(pair);
    console.log(`  ${pair}: $${price} | 24h: ${stats.priceChangePercent>=0?'+':''}${stats.priceChangePercent.toFixed(2)}%`);
  }
  console.log('');

  // Test 4: Bougies + Stratégie
  const testPair = pairs[0];
  console.log(`🕯️ Test 4: Analyse scalping ${testPair}...`);
  const candles = await binance.getKlines(testPair, '1m', 60);
  console.log(`  Bougies: ${candles.length}`);

  const orderBook = await binance.getOrderBook(testPair, 20);
  const analysis = scalpAnalyze(candles, orderBook);

  console.log(`  RSI(9):       ${analysis.indicators.rsi9}`);
  console.log(`  StochRSI K:   ${analysis.indicators.stochK}`);
  console.log(`  EMA5 > EMA13: ${analysis.indicators.ema5 > analysis.indicators.ema13}`);
  console.log(`  Momentum 3p:  ${analysis.indicators.momentum3.toFixed(4)}%`);
  console.log(`  Vol. Pressure:${(analysis.indicators.volPressure*100).toFixed(1)}%`);
  console.log(`  Order Flow:   ${analysis.indicators.orderFlow?.signal}`);
  console.log(`  Score LONG:   ${analysis.longScore} pts`);
  console.log(`  Score SHORT:  ${analysis.shortScore} pts`);
  console.log(`  → Action:     ${analysis.action} ${analysis.side||''} (conf:${analysis.confidence}%)`);
  if (analysis.signals?.length) {
    console.log(`  Signaux actifs:`);
    analysis.signals.slice(0,5).forEach(s => console.log(`    • ${s.name}: ${s.value} (+${s.pts}pts ${s.side})`));
  }
  console.log(`  TP: +${(analysis.tpPct).toFixed(3)}% | SL: -${(analysis.slPct).toFixed(3)}%\n`);

  // Test 5: Order book
  console.log(`📖 Test 5: Order book ${testPair}...`);
  console.log(`  Déséquilibre: ${(orderBook.imbalance*100).toFixed(1)}% (pos=pression achat)`);
  console.log(`  Spread:       $${orderBook.spread.toFixed(4)}`);
  console.log(`  Bid volume:   ${orderBook.bidVol.toFixed(3)}`);
  console.log(`  Ask volume:   ${orderBook.askVol.toFixed(3)}\n`);

  // Test 6: Symbol info (min qty)
  console.log(`⚙️ Test 6: Infos symbole ${testPair}...`);
  const info = await binance.getSymbolInfo(testPair);
  console.log(`  Step size: ${info.stepSize}`);
  console.log(`  Min qty:   ${info.minQty}`);
  console.log(`  Precision: ${info.quantityPrecision} décimales\n`);

  console.log('='.repeat(60));
  console.log('  ✅ Tous les tests passés ! Prêt pour le scalping.');
  console.log(`  🚀 Lance: npm start`);
  console.log('='.repeat(60) + '\n');
}

run().catch(e => { console.error('\n❌', e.message); process.exit(1); });
