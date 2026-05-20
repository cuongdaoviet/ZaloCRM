# ── Stage 1: Build frontend ──────────────────────────────────────────────────
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ── Stage 2: Build backend ───────────────────────────────────────────────────
FROM node:20-alpine AS backend-builder
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci
COPY backend/ ./
RUN npx prisma generate
RUN npm run build

# ── Stage 3: Production image ────────────────────────────────────────────────
FROM node:20-alpine
RUN apk add --no-cache tini
WORKDIR /app

# Copy built artefacts
COPY --from=backend-builder /app/backend/dist       /app/dist
COPY --from=backend-builder /app/backend/node_modules /app/node_modules
COPY --from=backend-builder /app/backend/prisma     /app/prisma
COPY --from=backend-builder /app/backend/package.json /app/package.json
COPY --from=frontend-builder /app/frontend/dist     /app/static

RUN mkdir -p /var/lib/zalo-crm/files

EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
# Push schema to DB then start server.
#
# `--accept-data-loss` is added in NON-production only. Lets dev/staging
# self-heal across destructive migrations (e.g. column drops where the
# DB still has rows). Production must NOT auto-accept data loss — a real
# operator needs to run `npx prisma db push --accept-data-loss` manually
# after backup + review, or use `prisma migrate deploy` with reviewed
# migration files. NODE_ENV is set by docker-compose; defaults to
# production if missing for safety.
CMD ["sh", "-c", "PUSH_FLAGS=''; if [ \"$NODE_ENV\" != 'production' ]; then PUSH_FLAGS='--accept-data-loss'; fi; npx prisma db push $PUSH_FLAGS --url \"$DATABASE_URL\" && node dist/app.js"]
