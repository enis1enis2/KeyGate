# KeyGate container image.
#
# Build layout:
#   frontend-builder -> compiles the SPA into backend/public
#   backend-builder  -> compiles TypeScript into backend/dist
#   backend-deps     -> installs production dependencies (better-sqlite3 needs a compiler here)
#   runner           -> minimal runtime, non-root, no build toolchain

# Stage 1: Build Frontend
FROM node:26-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# Stage 2: Build Backend
FROM node:26-alpine AS backend-builder
WORKDIR /app/backend
# `better-sqlite3` ships no musl/arm64 prebuild, so the build stage needs a toolchain too.
RUN apk add --no-cache python3 make g++
COPY backend/package*.json ./
RUN npm ci --no-audit --no-fund
COPY backend/ ./
RUN npm run build

# Stage 3: Production dependencies only. `better-sqlite3` compiles/downloads its native addon
# here, so the runner image never needs python/make/g++.
FROM node:26-alpine AS backend-deps
WORKDIR /app/backend
RUN apk add --no-cache python3 make g++
COPY backend/package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# Stage 4: Lean production image
FROM node:26-alpine AS runner
WORKDIR /app/backend

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV KEYGATE_DB_PATH=/app/data/keygate.sqlite

# Copy only runtime artifacts; tests, sources and the build toolchain stay in the builder stages.
COPY --from=backend-deps /app/backend/node_modules ./node_modules
COPY --from=backend-deps /app/backend/package*.json ./
COPY --from=backend-builder /app/backend/dist ./dist
COPY --from=frontend-builder /app/backend/public ./public
COPY providers /app/providers

# The SQLite directory must be writable by the unprivileged runtime user. A bind mount from the
# host keeps its own ownership, so Linux users must pre-create it as uid 1000 (see README).
RUN mkdir -p /app/data && chown -R node:node /app/data

USER node

VOLUME ["/app/data"]
EXPOSE 3000

# Node 22 has fetch built in, so the health probe needs no extra package (curl/wget).
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/index.js"]
