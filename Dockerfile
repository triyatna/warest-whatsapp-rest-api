ARG NODE_VERSION=22-bookworm-slim

FROM node:${NODE_VERSION} AS base
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl dumb-init git ca-certificates \
    && git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS deps
COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

FROM base AS runner

ARG BUILD_VERSION=0.3.43
ARG BUILD_COMMIT=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="warest-whatsapp-rest-api" \
      org.opencontainers.image.description="WARest - WhatsApp Rest API Multi Sessions Unofficial" \
      org.opencontainers.image.version="${BUILD_VERSION}" \
      org.opencontainers.image.revision="${BUILD_COMMIT}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/triyatna/warest-whatsapp-rest-api" \
      org.opencontainers.image.documentation="https://github.com/triyatna/warest-whatsapp-rest-api#readme"

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7308 \

COPY --from=deps /app/node_modules ./node_modules
COPY package*.json ./
COPY src ./src
COPY data/public ./data/public

RUN mkdir -p /app/data/private/storages /app/data/public/storages && chown -R node:node /app

VOLUME ["/app/data"]

EXPOSE 7308

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:7308/api/v1/server/ping || exit 1

USER node
ENTRYPOINT ["dumb-init", "--"]
CMD ["npm", "run", "start"]
