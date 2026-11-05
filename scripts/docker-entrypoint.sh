#!/bin/sh
set -eu

# Public dashboard port (Coolify). Bot health must NEVER share this port.
WEB_PORT="${PORT:-3000}"
BOT_HEALTH_PORT=3001

# Coolify often sets HEALTH_PORT=$PORT — force the bot onto 3001
export PORT="$WEB_PORT"
export HEALTH_PORT="$BOT_HEALTH_PORT"

# Strip accidental wrapping quotes Coolify sometimes leaves on values
strip_q() {
  v="$1"
  case "$v" in
    \'*\') v="${v#\'}"; v="${v%\'}" ;;
    \"*\") v="${v#\"}"; v="${v%\"}" ;;
  esac
  # second peel for nested ''https...''
  case "$v" in
    \'*\') v="${v#\'}"; v="${v%\'}" ;;
    \"*\") v="${v#\"}"; v="${v%\"}" ;;
  esac
  printf '%s' "$v"
}

PAPER_MODE="$(strip_q "${PAPER_MODE:-false}")"
PREVIEW_MODE="$(strip_q "${PREVIEW_MODE:-false}")"
PAPER_BALANCE_USD="$(strip_q "${PAPER_BALANCE_USD:-10000}")"
USER_ADDRESSES="$(strip_q "${USER_ADDRESSES:-}")"
PROXY_WALLET="$(strip_q "${PROXY_WALLET:-}")"
PRIVATE_KEY="$(strip_q "${PRIVATE_KEY:-}")"
MONGO_URI="$(strip_q "${MONGO_URI:-}")"
RPC_URL="$(strip_q "${RPC_URL:-}")"
CLOB_HTTP_URL="$(strip_q "${CLOB_HTTP_URL:-https://clob.polymarket.com/}")"
CLOB_WS_URL="$(strip_q "${CLOB_WS_URL:-wss://ws-subscriptions-clob.polymarket.com/ws}")"
USDC_CONTRACT_ADDRESS="$(strip_q "${USDC_CONTRACT_ADDRESS:-0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174}")"

# Sync Coolify / container env into /app/.env so the Next.js dashboard APIs can read them
ENV_FILE="/app/.env"
{
  echo "# Generated at container start — do not edit by hand"
  echo "PAPER_MODE=${PAPER_MODE}"
  echo "PREVIEW_MODE=${PREVIEW_MODE}"
  echo "PAPER_BALANCE_USD=${PAPER_BALANCE_USD}"
  echo "USER_ADDRESSES=${USER_ADDRESSES}"
  echo "PROXY_WALLET=${PROXY_WALLET}"
  echo "PRIVATE_KEY=${PRIVATE_KEY}"
  echo "MONGO_URI=${MONGO_URI}"
  echo "RPC_URL=${RPC_URL}"
  echo "CLOB_HTTP_URL=${CLOB_HTTP_URL}"
  echo "CLOB_WS_URL=${CLOB_WS_URL}"
  echo "USDC_CONTRACT_ADDRESS=${USDC_CONTRACT_ADDRESS}"
  echo "COPY_STRATEGY=${COPY_STRATEGY:-KELLY}"
  echo "COPY_SIZE=${COPY_SIZE:-10.0}"
  echo "TRADE_MULTIPLIER=${TRADE_MULTIPLIER:-1.0}"
  echo "KELLY_FRACTION=${KELLY_FRACTION:-0.5}"
  echo "KELLY_EDGE=${KELLY_EDGE:-0.05}"
  echo "KELLY_MAX_FRACTION=${KELLY_MAX_FRACTION:-0.25}"
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
  echo "HEALTH_PORT=${BOT_HEALTH_PORT}"
} > "$ENV_FILE"

export HOSTNAME="0.0.0.0"

echo "Starting AgreeBot (health :${BOT_HEALTH_PORT}) + dashboard (:${WEB_PORT})..."

node /app/dist/index.js &
BOT_PID=$!

# Give the bot a moment; fail fast if it crashed (e.g. missing deps)
sleep 2
if ! kill -0 "$BOT_PID" 2>/dev/null; then
  echo "Bot process failed to start"
  wait "$BOT_PID" || true
  exit 1
fi

cd /app/web
npx next start -H 0.0.0.0 -p "$WEB_PORT" &
WEB_PID=$!

term() {
  kill -TERM "$BOT_PID" "$WEB_PID" 2>/dev/null || true
  wait "$BOT_PID" "$WEB_PID" 2>/dev/null || true
}
trap term TERM INT

while kill -0 "$BOT_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null; do
  sleep 2
done

echo "A process exited — shutting down"
term
exit 1
