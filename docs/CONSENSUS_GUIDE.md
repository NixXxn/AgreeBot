# Consensus Mode (Multi-Trader Agreement)

AgreeBot extends the Polymarket copy-trading bot so you can follow **multiple traders** and only enter when a configurable number of them **agree on the same outcome**.

## What “agree” means

Two traders agree when they take the **same side** on the **same outcome token** of the same market within the consensus window:

| Field | Must match |
| --- | --- |
| `conditionId` | Same market |
| `asset` | Same outcome token (e.g. Yes vs No) |
| `side` | Same BUY or SELL |

Trader A buys **Yes** and Trader B buys **No** → no consensus.  
Trader A and Trader B both buy **Yes** → counts toward agreement.

## Quick setup

```bash
# Follow several wallets
USER_ADDRESSES='0xTrader1...,0xTrader2...,0xTrader3...'

# Require 2 of them to agree before copying
CONSENSUS_ENABLED=true
CONSENSUS_MIN_AGREEMENT=2
CONSENSUS_WINDOW_SECONDS=300
CONSENSUS_APPLY_TO=BUY
CONSENSUS_SIZE_MODE=AVERAGE
```

Start with `PREVIEW_MODE=true` to verify signals without placing orders.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `CONSENSUS_ENABLED` | `false` | Turn consensus gating on |
| `CONSENSUS_MIN_AGREEMENT` | `2` | Unique traders required on the same outcome |
| `CONSENSUS_WINDOW_SECONDS` | `300` | Max wait from the first agreeing trade |
| `CONSENSUS_APPLY_TO` | `BUY` | `BUY`, `SELL`, or `BOTH` |
| `CONSENSUS_SIZE_MODE` | `AVERAGE` | How to size the single copy order |

### Size modes

- **AVERAGE** — mean USDC size of the agreeing traders’ trades (recommended)
- **LARGEST** — use the biggest agreeing trade as the template size
- **MEDIAN** — median of agreeing sizes
- **FIRST** — size from the first trader who opened the window

The normal `COPY_STRATEGY` / safety limits still apply on top of that sized amount.

### Apply to

- **BUY** (default) — only entries need agreement; sells still copy per-trader so you can exit when someone cuts
- **SELL** — only exits need agreement
- **BOTH** — both sides require consensus

## How the loop works

1. Monitor polls every `FETCH_INTERVAL` seconds for new trades from all `USER_ADDRESSES`.
2. A trade that needs consensus is buffered under `conditionId:asset:side`.
3. When unique traders in that buffer ≥ `CONSENSUS_MIN_AGREEMENT`, the bot places **one** copy order and marks all contributing trades processed.
4. If the window expires first, those trades are skipped (not copied).

## Tips

- Use **3–5** traders; set `CONSENSUS_MIN_AGREEMENT` to 2 or 3.
- Shorter windows (60–120s) for liquid/news markets; longer (5–15m) for slower confirmation.
- Without consensus (`CONSENSUS_ENABLED=false`), behavior matches the upstream multi-trader bot (copy each trader independently).
- Health endpoint `GET /health` includes pending consensus groups for debugging.

## Example scenarios

**2-of-3 agreement on entries**

```bash
USER_ADDRESSES='0xaaa...,0xbbb...,0xccc...'
CONSENSUS_ENABLED=true
CONSENSUS_MIN_AGREEMENT=2
CONSENSUS_APPLY_TO=BUY
```

**Strict: all tracked traders must agree**

```bash
CONSENSUS_MIN_AGREEMENT=3   # same as number of addresses
CONSENSUS_WINDOW_SECONDS=600
```
