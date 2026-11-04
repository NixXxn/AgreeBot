# AgreeBot — bot + web dashboard for Coolify
# Coolify: Port = 3000, Healthcheck Path = /health

# ---------- Build bot ----------
FROM node:20-alpine AS bot-builder
WORKDIR /app
COPY package*.json ./
COPY tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

# ---------- Build web dashboard ----------
FROM node:20-alpine AS web-builder
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web ./
RUN npm run build

# ---------- Production ----------
FROM node:20-alpine
WORKDIR /app

RUN apk add --no-cache dumb-init curl

# Bot runtime
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=bot-builder /app/dist ./dist

# Web runtime (needs next + deps)
COPY --from=web-builder /app/web ./web
WORKDIR /app/web
RUN npm ci --omit=dev && npm cache clean --force
WORKDIR /app

COPY scripts/docker-entrypoint.sh /app/scripts/docker-entrypoint.sh
RUN chmod +x /app/scripts/docker-entrypoint.sh && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    mkdir -p /app/logs /app/trader_reports && \
    chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000
ENV HEALTH_PORT=3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["/app/scripts/docker-entrypoint.sh"]
