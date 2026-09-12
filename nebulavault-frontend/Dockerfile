FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup -S benzene && adduser -S -G benzene benzene
COPY --from=builder --chown=benzene:benzene /app/public ./public
COPY --from=builder --chown=benzene:benzene /app/.next/standalone ./
COPY --from=builder --chown=benzene:benzene /app/.next/static ./.next/static

USER benzene
EXPOSE 3000
CMD ["node", "server.js"]
