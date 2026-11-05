# Kelly / Half-Kelly Sizing

Use this when following many traders with different bet sizes and you want **your stake** driven by **your bankroll**, not theirs.

## Formula (buy YES / outcome token)

Assumed true probability: `p = marketPrice + KELLY_EDGE`  
Full Kelly fraction of bankroll: `f* = (p − price) / (1 − price)`  
Applied fraction: `f = min(KELLY_FRACTION × f*, KELLY_MAX_FRACTION)`  
**Stake USD** = `bankroll × f` (then capped by `MAX_ORDER_SIZE_USD`)

- Paper mode bankroll = `PAPER_BALANCE_USD`
- Live bankroll = your USDC balance

## Coolify env (recommended)

```bash
COPY_STRATEGY=KELLY
KELLY_FRACTION=0.5          # half Kelly
KELLY_EDGE=0.05             # assume +5pp edge when copying / consensus fires
KELLY_MAX_FRACTION=0.25     # never >25% of bankroll on one bet
PAPER_BALANCE_USD=10000
MAX_ORDER_SIZE_USD=500      # don't leave at 100 or Kelly gets clipped
MIN_ORDER_SIZE_USD=1
```

## Why an “edge”?

Kelly needs a win probability above the market price. Copy/consensus is treated as that edge (`KELLY_EDGE`). Raise it if you trust signals more; lower it to bet smaller.

## vs PERCENTAGE

| | PERCENTAGE | KELLY |
| --- | --- | --- |
| Input | Trader’s $ size | Your bankroll + market price |
| Same signal, whale vs small trader | Different stakes | **Same** stake |
| Consensus multi-trader | Still tied to sized template trade | Bankroll Kelly once |

Trader size is logged but **ignored** for the dollar amount when `COPY_STRATEGY=KELLY`.
