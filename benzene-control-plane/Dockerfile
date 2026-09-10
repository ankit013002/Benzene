FROM node:20-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV LOCAL_STORAGE_DIR=/data

RUN addgroup -S benzene && adduser -S -G benzene benzene \
  && mkdir -p /data \
  && chown benzene:benzene /data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build --chown=benzene:benzene /app/built ./built
COPY --chown=benzene:benzene drizzle ./drizzle

USER benzene
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:5000/health || exit 1
# Run `npm run db:migrate:runtime` as a one-off release step before startup.
CMD ["node", "built/server.js"]
