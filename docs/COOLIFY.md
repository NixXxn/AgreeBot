# Deploy AgreeBot on Coolify

Coolify can run this bot from the included `Dockerfile`. MongoDB Atlas is the simplest database option (no extra Coolify service required).

## Prerequisites

- Coolify instance with Docker
- Git repo pushed somewhere Coolify can clone (GitHub/GitLab/self-hosted)
- MongoDB Atlas URI (or a Coolify MongoDB resource)
- Polygon wallet funded with USDC + POL for gas
- Polygon RPC URL (Infura / Alchemy / public)

## 1. Create the application

1. In Coolify → **New Resource** → **Application**
2. Connect this repository
3. **Build Pack:** Dockerfile  
4. **Dockerfile location:** `/Dockerfile` (repo root)
5. **Port:** `3000` (health server)
6. **Healthcheck Path:** `/health`  
   Method: GET — expected status 200

Coolify will build the multi-stage image and start `node dist/index.js`.

## 2. Environment variables

In the Coolify app → **Environment Variables**, set at least:

| Key | Example / notes |
| --- | --- |
| `USER_ADDRESSES` | `0xTrader1,0xTrader2,0xTrader3` |
| `PROXY_WALLET` | Your Polygon address |
| `PRIVATE_KEY` | Key **without** `0x` — mark as secret |
| `MONGO_URI` | `mongodb+srv://...` Atlas string |
| `RPC_URL` | Your Polygon RPC |
| `CLOB_HTTP_URL` | `https://clob.polymarket.com/` |
| `CLOB_WS_URL` | `wss://ws-subscriptions-clob.polymarket.com/ws` |
| `USDC_CONTRACT_ADDRESS` | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |
| `HEALTH_PORT` | `3000` |

### Consensus (recommended for AgreeBot)

| Key | Suggested |
| --- | --- |
| `CONSENSUS_ENABLED` | `true` |
| `CONSENSUS_MIN_AGREEMENT` | `2` |
| `CONSENSUS_WINDOW_SECONDS` | `300` |
| `CONSENSUS_APPLY_TO` | `BUY` |
| `CONSENSUS_SIZE_MODE` | `AVERAGE` |
| `PREVIEW_MODE` | `true` first, then `false` |

Copy any other knobs you need from `.env.example` (`COPY_STRATEGY`, `MAX_ORDER_SIZE_USD`, etc.).

## 3. MongoDB options

**A. Atlas (easiest)**  
Create a cluster, whitelist Coolify server IP (or `0.0.0.0/0` if you accept the risk), paste URI into `MONGO_URI`.

**B. Coolify MongoDB resource**  
Deploy a MongoDB service in the same Coolify project/network, then:

```bash
MONGO_URI=mongodb://user:pass@mongodb:27017/polymarket_copytrading
```

Use the internal hostname Coolify assigns to that resource.

## 4. Deploy

1. Save env vars  
2. **Deploy**  
3. Open logs — you should see traders listed, consensus mode status, and `Health server listening on :3000`  
4. Hit `https://<your-coolify-url>/health` — JSON with `"status":"ok"`

## 5. Local Docker (same image Coolify uses)

```bash
cp .env.example .env
# edit .env — for compose MongoDB use:
# MONGO_URI=mongodb://mongodb:27017/polymarket_copytrading

docker compose up -d --build
curl http://localhost:3000/health
docker compose logs -f bot
```

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Healthcheck failing | Ensure `HEALTH_PORT=3000` and Coolify port matches |
| `Missing required environment variables` | Add every required key from the table above |
| No trades | Confirm trader addresses, `TOO_OLD_TIMESTAMP`, and that consensus isn’t waiting forever (`/health` shows `pending` groups) |
| Order failures | Check USDC balance, POL for gas, and RPC |

## Notes

- The bot process is long-running (not a web app). Coolify keeps the container alive; `/health` exists only for probes.
- Changing env vars requires a **redeploy / restart** so `src/config/env.ts` reloads.
- Do not commit `.env` or private keys.
