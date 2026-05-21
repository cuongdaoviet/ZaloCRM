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

# Feature 0046 BR-0022..BR-0024 — run the Node process as a dedicated
# unprivileged user. A Node RCE that escapes the runtime no longer
# drops the attacker straight to root.
#
# - mkdir the uploads volume mount point in the same layer as the
#   user/group creation so the chown that follows covers a known set
#   of files.
# - addgroup -S / adduser -S → system uid/gid (no collision with host
#   uids on older builds).
# - chown the app dir AND the uploads mount point so first-run writes
#   succeed without a runtime chown step.
# - USER app sits BEFORE CMD so both `tini` (ENTRYPOINT) and the shell
#   that runs `prisma db push` + `node dist/app.js` execute as app,
#   not root.
# - Port 3000 is non-privileged → no setcap needed.
RUN mkdir -p /var/lib/zalo-crm/files \
    && addgroup -S app \
    && adduser -S -G app -h /app -s /sbin/nologin app \
    && chown -R app:app /app /var/lib/zalo-crm/files

USER app

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
