# ⚡ ScalperBot — Binance Futures Long/Short

Bot de scalping ultra-rapide multi-positions sur Binance Futures.
**Long ET Short**, plusieurs trades simultanés, profits rapides.

---

## 🎯 Ce que fait ce bot

| Fonctionnalité | Détail |
|---|---|
| **Scalping ultra-rapide** | Trades de quelques secondes à quelques minutes |
| **Long + Short** | Profite aussi bien des hausses que des baisses |
| **Multi-positions** | Jusqu'à N positions ouvertes simultanément |
| **Multi-paires** | Surveille BTC, ETH, BNB, SOL en même temps |
| **Levier** | x1 à x10 (x3 recommandé) |
| **Trailing Stop** | Le SL monte    le prix pour sécuriser les gains |
| **TP/SL dynamiques** | Calibrés sur l'ATR (volatilité réelle du marché) |
| **Timeout auto** | Ferme les positions après 15min max |
| **Stop perte quotidien** | Arrêt automatique si perte > seuil configuré |

---

## 📊 Stratégie de scalping

Le bot combine **8 signaux** pour décider d'entrer en position :

| Signal | Description | Poids |
|---|---|---|
| **Stochastic RSI** | Oversold/Overbought ultra-rapide | 35 pts |
| **RSI(9)** | RSI période courte pour réactivité | 25 pts |
| **EMA 5/13/21** | Alignement des moyennes mobiles exponentielles | 30 pts |
| **VWAP** | Prix par rapport au volume moyen pondéré | 15 pts |
| **Momentum** | Vitesse du mouvement sur 3 et 5 bougies | 20 pts |
| **Volume Pressure** | Pression achat vs vente (delta volume) | 15 pts |
| **Order Flow** | Déséquilibre du carnet d'ordres en temps réel | 20 pts |
| **Breakout** | Cassure de range (haute/basse des N dernières bougies) | 25 pts |

**Entrée en position** : Score ≥ 50 pts ET domination claire d'un côté (+15 pts d'écart)

---

## 🚀 Installation

### 1. Prérequis
- Node.js 18+
- Compte Binance avec accès Futures

### 2. Installer
```bash
cd scalper-bot
npm install
```

### 3. Configurer `.env`
```bash
cp .env.example .env
```

```env
# Clés API Futures Testnet: https://testnet.binancefuture.com
BINANCE_API_KEY=ta_cle_ici
BINANCE_SECRET_KEY=ta_cle_secrete_ici
TRADE_MODE=testnet

# Scalping sur 4 paires simultanément
TRADE_PAIRS=BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT

# Capital par trade
TRADE_AMOUNT_USDT=20

# Levier x3 = 20$ contrôle 60$ de position
LEVERAGE=3

# Max 3 positions en même temps
MAX_POSITIONS=3

# TP rapide +0.4% | SL serré -0.25%
TAKE_PROFIT_PCT=0.4
STOP_LOSS_PCT=0.25

# Trailing stop activé
TRAILING_STOP=true
```

### 4. Clés API Futures Testnet
1. Va sur https://testnet.binancefuture.com
2. Connecte-toi (compte Binance standard)
3. Clique sur ton profil → **API Key**
4. Génère une paire de clés
5. Colle dans `.env`

> ⚠️ Ce sont des clés DIFFÉRENTES du testnet Spot !

### 5. Tester la connexion
```bash
npm test
```

### 6. Lancer
```bash
npm start
# Ouvre http://localhost:3000
```

---

## 💻 Dashboard

Le dashboard affiche en temps réel :
- **Ticker multi-paires** dans le header
- **Graphique live** avec EMA5/EMA13 et les entrées marquées
- **Positions ouvertes** avec P&L en direct, TP/SL, barre de progression
- **8 signaux techniques** avec scores LONG/SHORT
- **Historique des trades** (paire, side, prix entrée/sortie, P&L, durée, raison)
- **Log** de chaque décision du bot

---

## ⚙️ Paramètres importants

### Levier recommandé selon profil :
| Profil | Levier | Risque |
|---|---|---|
| Débutant | x1 - x2 | Faible |
| Intermédiaire | x3 - x5 | Moyen |
| Avancé | x5 - x10 | Élevé |

### TP/SL pour scalping :
| Style | TP | SL | Ratio R/R |
|---|---|---|---|
| Agressif | 0.3% | 0.2% | 1.5:1 |
| Équilibré | 0.4% | 0.25% | 1.6:1 |
| Conservateur | 0.6% | 0.3% | 2:1 |

### Scan interval :
- `3000` ms = très réactif (beaucoup de trades)
- `5000` ms = équilibré
- `10000` ms = conservateur (moins de trades, plus sélectif)

---

## 🛡️ Protections

1. **Stop perte quotidienne** (`MAX_DAILY_LOSS`) — arrêt automatique
2. **Trailing Stop** — sécurise les gains dès +0.2%
3. **Cooldown** — pas deux trades sur la même paire trop rapidement
4. **Timeout** — ferme les positions après 15 min maximum
5. **Rate limit horaire** — max 12 trades/heure/paire
6. **Bouton urgence** 🚨 — ferme TOUT immédiatement
7. **Marge isolée** — chaque position ne risque que son propre capital

---

## ⚠️ Avertissements

> **Le trading avec levier amplifie les gains ET les pertes.**
> Sur Binance Futures, tu peux perdre l'intégralité de ta mise si le marché va dans le mauvais sens.
> Commence TOUJOURS par le testnet. Ne trade qu'avec de l'argent que tu peux te permettre de perdre.

---

*ScalperBot v1.0 — Long/Short Futures Multi-Positions*
