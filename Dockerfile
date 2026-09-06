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
# --chown here is free (ownership is set while the layer is written) and
# covers `next start` wanting to write .next/cache.
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next
COPY package.json next.config.ts ./
# REQUIRED AT RUNTIME: migrate() reads db/schema.sql from process.cwd().
COPY db ./db

# Without DATABASE_URL, PGlite (local/dev only — the deployed environment
# always sets DATABASE_URL, so PGlite never runs there) persists to
# ./.pgdata under process.cwd() (/app) at runtime. Creating that directory
# entry needs write permission on the /app inode itself, not just on its
# contents, so a single non-recursive chown of /app is required — node_modules
# (504MB) stays root-owned since it only ever needs to be readable, and a
# recursive chown here would copy-up the entire preceding layers (~568MB),
# nearly doubling the image for no runtime benefit.
RUN chown nextjs:nodejs /app

USER nextjs
EXPOSE 3000
CMD ["npx", "next", "start", "-H", "0.0.0.0", "-p", "3000"]
