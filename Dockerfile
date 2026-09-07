FROM node:22-slim AS build

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 --branch main https://github.com/EloiGP10/wardrobe.git .

RUN npm ci && npm run build && node scripts/fetch-model.mjs

FROM node:22-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends dumb-init ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/dist ./dist
COPY --from=build /app/server.mjs .
COPY --from=build /app/lib ./lib
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/models ./models
COPY --from=build /app/package*.json ./

RUN npm ci --omit=dev && mkdir -p /app/data/imported && chown -R node:node /app

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.mjs"]
