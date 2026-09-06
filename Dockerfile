# syntax=docker/dockerfile:1.7
#
# Plain `next build` + `next start`. NOT output: "standalone" — see
# docs/superpowers/plans/2026-09-06-aws-deployment.md Task 2 for why.
#
# Build (for ECR, from any machine):
#   docker build --platform linux/amd64 -t loadline .

FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# No DATABASE_URL: every page is force-dynamic, so nothing prerenders.
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder   /app/.next        ./.next
COPY package.json next.config.ts ./
# REQUIRED AT RUNTIME: migrate() reads db/schema.sql from process.cwd().
COPY db ./db

# Without DATABASE_URL, PGlite persists to ./.pgdata under process.cwd()
# (/app) at runtime, so /app must be writable by the user that starts
# the process, not just readable.
RUN chown -R nextjs:nodejs /app

USER nextjs
EXPOSE 3000
CMD ["npx", "next", "start", "-H", "0.0.0.0", "-p", "3000"]
