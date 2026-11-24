# Crypto 5m trader pipeline

Keeps a live **top-50** list of successful Polymarket crypto up/down **5m** traders using the [Gravia Data API](https://docs.gravia.trade/).

## Isolation (does not slow AgreeBot)

`docker-compose.yml` runs **three services** on `bot-network`:

| Service | Role |
| --- | --- |
| `bot` | Copy / consensus / orders + Next.js dashboard |
| `mongodb` | Shared DB (traders, activities, curated list) |
| `pipeline` | Discovery + evaluation + list maintenance |

`pipeline` is the same Docker image with `AGREEBOT_ROLE=pipeline`. It shares Mongo (and can HTTP-reload the bot) but **never** shares the bot event loop.

## How it works

1. **Discover** — Gravia transaction WebSocket filtered to current `BTC/ETH/SOL/…` `5m` market condition IDs (refreshed ~90s).
2. **Evaluate** (REST, rate-limited ≤60/min by default):
   - 30d category metrics → PnL, ROI, win rate, volume
   - Recent activities → trades/day, active days/week, both-sides detection
3. **Maintain** — keep wallets that pass gates; rank by score; write top 50.
4. **Apply** (optional) — update `runtime_settings.values.USER_ADDRESSES`, sync Gravia webhook wallet filter, `POST` bot `/runtime/reload`.

### Inclusion gates

- Positive last-30-day PnL (crypto category)
- ROI ≥ 10% (`pnl / buy_volume`)
- Win rate ≥ 55% (configurable)
- Volume ≥ $100 (configurable)
- ≥ **10 trades/day** average over 7 days on crypto `*updown-5m*` markets
- Active on ≥ **4 distinct UTC days** in that week
- Does **not** BUY both outcomes in the same market

Failing / inactive wallets drop out; stronger new candidates replace them.

## Mongo collections

| Collection | Purpose |
| --- | --- |
| `pipeline_candidates` | Discovery hits + last evaluation |
| `pipeline_curated_traders` (`_id: crypto_5m_top`) | Current top list |
| `pipeline_status` | Health / last cycle stats |
| `runtime_settings` | Bot trader list when `TRADER_PIPELINE_AUTO_APPLY=true` |

## Run

### Local

```bash
# requires MONGO_URI + GRAVIA_API in .env
npm run pipeline
```

### docker compose (recommended — all three services)

```bash
# bot + mongodb + pipeline on one network
docker compose up -d --build

curl -s http://127.0.0.1:3000/health   # bot / dashboard
curl -s http://127.0.0.1:3002/health   # pipeline
curl -s http://127.0.0.1:3002/curated

docker compose logs -f pipeline
```

Pipeline-only (bot already running):

```bash
docker compose up -d --build pipeline
```

### Coolify

Prefer **Docker Compose** build pack with this repo’s `docker-compose.yml` so `bot`, `mongodb`, and `pipeline` deploy together (`BOT_RELOAD_URL=http://bot:3001/runtime/reload` is already set).

A second Dockerfile-only app with `AGREEBOT_ROLE=pipeline` still works, but compose is simpler.

## Copying crypto 5m markets

AgreeBot defaults `SKIP_CRYPTO_UPDOWN=true`. To copy these traders’ markets, set:

```bash
SKIP_CRYPTO_UPDOWN=false
```

## Rate limits

Gravia default is **100 req/min**. The pipeline:

- Caps itself at `GRAVIA_RATE_LIMIT_PER_MIN` (default 60)
- Honors `Retry-After` / `RateLimit-*` headers
- Skips activity pagination when metrics already fail
- Caches evaluations (`TRADER_PIPELINE_EVAL_CACHE_MS`, default 6h)
- Uses at most one WebSocket (Gravia concurrent stream allowance)

## Important env knobs

See `.env.example` section **CRYPTO 5m TRADER PIPELINE**.
