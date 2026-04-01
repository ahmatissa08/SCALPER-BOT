// ================================================================
// server.js — Serveur Scalper Bot
// ================================================================
require('dotenv').config();
const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const cors      = require('cors');
const path      = require('path');
const { logger } = require('./logger');
const binance   = require('./binance-futures');
const scalper   = require('./scalper');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server, path: '/ws' });
const PORT   = process.env.PORT || 3000;

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// ----------------------------------------------------------------
// API REST
// ----------------------------------------------------------------
app.get('/api/status', async (req, res) => {
  try {
    const conn = await binance.testConnection();
    res.json({ bot: scalper.getState(), binance: conn, mode: process.env.TRADE_MODE });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/bot/start', async (req, res) => {
  if (scalper.isRunning)   return res.json({ success: false, message: 'Déjà en marche' });
  if (scalper._starting)   return res.json({ success: false, message: 'Démarrage en cours...' });
  scalper._starting = true;
  const result = await scalper.start();
  scalper._starting = false;
  res.json(result);
});

app.post('/api/bot/stop', async (req, res) => {
  res.json(await scalper.stop());
});

app.post('/api/bot/emergency', async (req, res) => {
  await scalper.emergencyClose();
  res.json({ success: true, message: 'Fermeture urgence exécutée' });
});

app.get('/api/state', (req, res) => res.json(scalper.getState()));
app.get('/api/trades', (req, res) => res.json({ trades: scalper.trades, stats: scalper.stats }));
app.get('/api/positions', (req, res) => res.json([...scalper.positions.values()]));

app.get('/api/account', async (req, res) => {
  try { res.json(await binance.getBalance()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/price/:symbol', async (req, res) => {
  try {
    const [price, stats] = await Promise.all([
      binance.getPrice(req.params.symbol.toUpperCase()),
      binance.get24hrStats(req.params.symbol.toUpperCase()),
    ]);
    res.json({ price, ...stats });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/klines/:symbol', async (req, res) => {
  try {
    const klines = await binance.getKlines(req.params.symbol.toUpperCase(), req.query.interval || '1m', 100);
    res.json(klines);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/ticker', async (req, res) => {
  try {
    const pairs = scalper.pairs.length ? scalper.pairs : ['BTCUSDT','ETHUSDT','BNBUSDT'];
    const results = await Promise.allSettled(pairs.map(p => binance.get24hrStats(p)));
    const ticker = {};
    results.forEach((r, i) => { if (r.status === 'fulfilled') ticker[pairs[i]] = r.value; });
    res.json(ticker);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/config', (req, res) => {
  const { pairs, amount, maxPositions, tpPct, slPct } = req.body;
  if (pairs)        scalper.pairs = pairs.split(',').map(s => s.trim());
  if (amount)       scalper.amount = parseFloat(amount);
  if (maxPositions) scalper.maxPositions = parseInt(maxPositions);
  if (tpPct)        scalper.tpPct = parseFloat(tpPct) / 100;
  if (slPct)        scalper.slPct = parseFloat(slPct) / 100;
  logger.info(`⚙️ Config: ${JSON.stringify(req.body)}`);
  res.json({ success: true });
});

// ----------------------------------------------------------------
// WEBSOCKET
// ----------------------------------------------------------------
wss.on('connection', (ws, req) => {
  logger.info(`🔌 WS client connecté`);
  scalper.addListener(ws);

  const ping = setInterval(() => { if (ws.readyState === 1) ws.ping(); }, 30000);

  ws.on('message', async data => {
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case 'START':
          if (!scalper.isRunning && !scalper._starting) {
            scalper._starting = true;
            await scalper.start();
            scalper._starting = false;
          }
          break;
        case 'STOP':  if (scalper.isRunning) await scalper.stop();  break;
        case 'EMERGENCY': await scalper.emergencyClose(); break;
        case 'GET_STATE': ws.send(JSON.stringify({ type: 'STATE', data: scalper.getState() })); break;
      }
    } catch {}
  });

  ws.on('close', () => { clearInterval(ping); scalper.removeListener(ws); });
});

// ----------------------------------------------------------------
// DÉMARRAGE
// ----------------------------------------------------------------
server.listen(PORT, () => {
  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`  ⚡ SCALPER BOT — Démarré`);
  logger.info(`🌐 Dashboard: ${process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`}`);
  logger.info(`  💹 Mode: ${(process.env.TRADE_MODE || 'testnet').toUpperCase()}`);
  logger.info(`  🎯 Stratégie: Scalping Multi-Paires Long/Short`);
  logger.info(`${'='.repeat(60)}\n`);
});

process.on('SIGTERM', async () => {
  if (scalper.isRunning) await scalper.stop();
  server.close(() => process.exit(0));
});
