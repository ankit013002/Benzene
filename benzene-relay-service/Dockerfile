FROM node:20-alpine AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev

FROM dependencies AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    RELAY_HOST=0.0.0.0 \
    RELAY_PORT=8090

RUN addgroup -S benzene && adduser -S -G benzene benzene
COPY --from=build --chown=benzene:benzene /app/package.json ./package.json
COPY --from=build --chown=benzene:benzene /app/node_modules ./node_modules
COPY --from=build --chown=benzene:benzene /app/built ./built
COPY --chown=benzene:benzene migrations ./migrations

USER benzene
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8090/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "built/index.js"]
