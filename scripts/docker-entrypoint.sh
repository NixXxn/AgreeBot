#!/bin/sh
set -eu

# Sync Coolify / container env into /app/.env so the Next.js dashboard APIs can read them
ENV_FILE="/app/.env"
{
  echo "# Generated at container start — do not edit by hand"
  echo "PAPER_MODE=${PAPER_MODE:-false}"
  echo "PREVIEW_MODE=${PREVIEW_MODE:-false}"
  echo "USER_ADDRESSES=${USER_ADDRESSES:-}"
  echo "PROXY_WALLET=${PROXY_WALLET:-}"
  echo "PRIVATE_KEY=${PRIVATE_KEY:-}"
  echo "MONGO_URI=${MONGO_URI:-}"
  echo "RPC_URL=${RPC_URL:-}"
  echo "CLOB_HTTP_URL=${CLOB_HTTP_URL:-https://clob.polymarket.com/}"
  echo "CLOB_WS_URL=${CLOB_WS_URL:-wss://ws-subscriptions-clob.polymarket.com/ws}"
  echo "USDC_CONTRACT_ADDRESS=${USDC_CONTRACT_ADDRESS:-0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174}"
  echo "COPY_STRATEGY=${COPY_STRATEGY:-PERCENTAGE}"
  echo "COPY_SIZE=${COPY_SIZE:-10.0}"
  echo "TRADE_MULTIPLIER=${TRADE_MULTIPLIER:-1.0}"
  echo "MAX_ORDER_SIZE_USD=${MAX_ORDER_SIZE_USD:-100.0}"
  echo "MIN_ORDER_SIZE_USD=${MIN_ORDER_SIZE_USD:-1.0}"
  echo "FETCH_INTERVAL=${FETCH_INTERVAL:-1}"
  echo "TOO_OLD_TIMESTAMP=${TOO_OLD_TIMESTAMP:-1}"
  echo "RETRY_LIMIT=${RETRY_LIMIT:-3}"
  echo "CONSENSUS_ENABLED=${CONSENSUS_ENABLED:-false}"
  echo "CONSENSUS_MIN_AGREEMENT=${CONSENSUS_MIN_AGREEMENT:-2}"
  echo "CONSENSUS_WINDOW_SECONDS=${CONSENSUS_WINDOW_SECONDS:-300}"
  echo "CONSENSUS_APPLY_TO=${CONSENSUS_APPLY_TO:-BUY}"
  echo "CONSENSUS_SIZE_MODE=${CONSENSUS_SIZE_MODE:-AVERAGE}"
  echo "TRADE_AGGREGATION_ENABLED=${TRADE_AGGREGATION_ENABLED:-false}"
  echo "TRADE_AGGREGATION_WINDOW_SECONDS=${TRADE_AGGREGATION_WINDOW_SECONDS:-300}"
  echo "AUTO_RESOLVE_ENABLED=${AUTO_RESOLVE_ENABLED:-false}"
  echo "HEALTH_PORT=${HEALTH_PORT:-3001}"
} > "$ENV_FILE"

# Bot health stays on 3001; Next.js dashboard owns public port 3000
export HEALTH_PORT="${HEALTH_PORT:-3001}"
export PORT="${PORT:-3000}"
export HOSTNAME="0.0.0.0"

echo "Starting AgreeBot (health :${HEALTH_PORT}) + dashboard (:${PORT})..."

node /app/dist/index.js &
BOT_PID=$!

cd /app/web
npm run start -- -H 0.0.0.0 -p "$PORT" &
WEB_PID=$!

term() {
  kill -TERM "$BOT_PID" "$WEB_PID" 2>/dev/null || true
  wait "$BOT_PID" "$WEB_PID" 2>/dev/null || true
}
trap term TERM INT

# Exit if either process dies
while kill -0 "$BOT_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null; do
  sleep 2
done

echo "A process exited — shutting down"
term
exit 1
