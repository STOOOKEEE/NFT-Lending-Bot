# NFT Lending Bot

Bot automatique de lending NFT sur Ethereum. Observe le marche, evalue les risques et publie des offres de pret competitives sur **Gondi** et **Blur Blend**.

## Comment ca marche

Le bot fonctionne en boucle autonome avec 4 timers independants :

| Timer | Intervalle | Role |
|-------|-----------|------|
| **Price collection** | 1h | Collecte floor price + top bid via OpenSea |
| **Main cycle** | 30 min | Sync marche + tracking + strategie + publication |
| **Risk report** | 1h | Met a jour les prix des positions et genere des alertes |
| **Price compaction** | 24h | Compacte l'historique des prix (garde 7j haute frequence) |

## Cycle principal (toutes les 30 min)

```
1. Sync Gondi       → Recupere les meilleures offres du marche
2. Sync Blur        → Recupere les donnees Blur Blend on-chain
3. Track loans      → Detecte offres acceptees/expirees/annulees
4. Liquidations     → Gondi: liquide les prets en defaut
                    → Blur: recall si LTV > 90%
5. Strategie        → Evalue chaque collection et publie les offres
```

Les offres expirent en **30 minutes** — pas de gas pour annuler. Si le marche bouge, le prochain cycle ajuste automatiquement.

## Pricing (Black-Scholes)

Le bot traite un pret NFT comme la **vente d'un put option** :
- Si le floor reste au-dessus du montant prete → on gagne les interets
- Si le floor chute en-dessous → on recupere un NFT devalue

Le pricing utilise Black-Scholes pour calculer la prime du put, puis derive l'APR minimum pour etre rentable :

```
APR minimum = (put premium + liquidity premium) / (loan amount * duration)
```

La volatilite est calculee par **EWMA** (Exponentially Weighted Moving Average) sur 30 jours de donnees de prix, puis annualisee.

Pour chaque collection et duree, le bot genere 2 types d'offres :
- **Type 1 (best APR)** : undercut la meilleure APR du marche de 1%
- **Type 2 (best principal)** : matcher le plus gros montant avec APR competitive

Une offre n'est envoyee que si `minApr < competitiveApr` (on est rentable) et `isViable` (LTV raisonnable).

## Plateformes

### Gondi
- Offres collection-wide (pas par NFT individuel)
- Durees : 7, 15, 30 jours
- LTV max dynamique basee sur spread et volatilite

### Blur Blend
- Prets rolling (pas de duree fixe, le lender peut exit via recall)
- LTV max : 80% (plus eleve que Gondi car on peut sortir)
- Recall automatique si LTV depasse 90%, warning a 85%

## Risk Manager

Le `RiskManager` controle l'allocation de capital avant chaque offre :

- **Max capital global** : limite totale d'ETH deployes
- **Max par collection** : limite d'exposition par collection (configurable dans `collections.json`)
- **Max loans par collection** : nombre max de prets actifs
- **Taux d'utilisation** : ratio capital deploye / capital total
- **Seuil de liquidation** : bloque si trop de capital a risque

Les positions ne sont enregistrees que quand une offre est **acceptee par un emprunteur** (pas a l'envoi).

## Commandes Telegram

Le bot ecoute les commandes Telegram en temps reel :

```
/status              Portfolio stats (capital, utilisation, exposure)
/limits              Afficher les limites de risque
/setlimit col eth    Modifier la limite d'une collection
/setmax eth          Modifier le capital max global
/loans               Lister les prets actifs
/risk                Alertes de risque en cours
/help                Liste des commandes
```

Les notifications automatiques incluent : alertes de prix (mouvement > 10%), offres acceptees, erreurs, liquidations, alertes Blur LTV.

## Structure

```
src/
  bot-auto.ts                  # Point d'entree unique, orchestration
  compact-price-history.ts     # Compaction des prix anciens
  adapters/
    BlurAdapter.ts             # API Blur Blend (offres, monitoring, recall)
  collectors/
    price-fetcher.ts           # Floor price via OpenSea
    gondi-fetcher.ts           # Offres Gondi (GraphQL)
    blur-market-collector.ts   # Donnees marche Blur
  engines/
    LoanPricer.ts              # Black-Scholes put pricing
    volatility.ts              # EWMA volatilite + annualisation
  execution/
    send-gondi-offer.ts        # Publication offres Gondi
    loan-tracker.ts            # Suivi statut des offres envoyees
    liquidation.ts             # Liquidation Gondi + recall Blur
  risk/
    RiskManager.ts             # Allocation capital + positions + alertes
  strategy/
    Strategy.ts                # Decision: quelles offres envoyer
  utils/
    supabase.ts                # Client Supabase singleton
    price-db.ts                # CRUD prix
    gondi-db.ts                # CRUD best offers Gondi
    blur-db.ts                 # CRUD marche Blur
    lending-db.ts              # CRUD offres envoyees
    telegram.ts                # Envoi messages Telegram
    telegram-commands.ts       # Reception commandes Telegram
    collections-loader.ts      # Chargement collections.json
    helpers.ts                 # Utilitaires (sleep, format, ETH price)
```

## Base de donnees (Supabase)

| Table | Role |
|-------|------|
| `price_history` | Historique floor/bid/spread par collection |
| `gondi_best_offers` | Meilleures offres Gondi par collection/duree |
| `blur_market_data` | Donnees marche Blur Blend |
| `lending_offers` | Offres envoyees par le bot (statut: ACTIVE/EXECUTED/EXPIRED) |
| `risk_positions` | Prets actifs pour le risk management |

Views : `gondi_best_offers_latest`, `blur_market_data_latest`

## Configuration

Variables d'environnement requises dans `.env` :

```bash
# Required
OPENSEA_API_KEY=           # OpenSea API key (prix)
SUPABASE_URL=              # Supabase project URL
SUPABASE_ANON_KEY=         # Supabase anon key

# Wallet (required si SEND_OFFERS=true)
WALLET_PRIVATE_KEY=        # Cle privee du wallet lender
WALLET_ADDRESS=            # Adresse publique du wallet
RPC_URL=                   # Ethereum RPC (Alchemy/Infura)

# Blur (required pour offres Blur)
RAPIDAPI_KEY=              # RapidAPI key pour l'API Blur

# Telegram (optional)
TELEGRAM_BOT_TOKEN=        # Token du bot Telegram
TELEGRAM_CHAT_ID=          # ID du chat pour notifications

# Strategy
SEND_OFFERS=false          # false = dry-run, true = envoie les offres
MAX_CAPITAL_ETH=10         # Capital max total
MAX_EXPOSURE_PER_COLLECTION=2  # Exposition max par collection
```

## Commandes

```bash
npm install                 # Installer les dependances
npm run build               # Compiler TypeScript
npm run dev                 # Lancer en dev (ts-node)
npm start                   # Lancer en production
npm run compact             # Compacter l'historique des prix
```

## Limitations connues

- **Prix uniquement via OpenSea** : si l'API est down, pas de prix
- **Pas de gestion multi-devises** : les montants non-WETH sont convertis via prix ETH/USD
- **Blur offres fire-and-forget** : pas de tracking detaille cote Blur (pas d'API pour ca)
- **Gondi nonce collision** : si le cycle precedent n'a pas expire, erreur `duplicate key` (benigne, le SDK incremente le nonce)
