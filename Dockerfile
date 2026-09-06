FROM node:22-alpine AS build

WORKDIR /app

RUN apk add --no-cache git

RUN git clone --depth 1 --branch main https://github.com/EloiGP10/wardrobe.git .

RUN npm ci && npm run build

FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache dumb-init

COPY --from=build /app/dist ./dist
COPY --from=build /app/server.mjs .
COPY --from=build /app/package*.json ./

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

USER node

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.mjs"]
