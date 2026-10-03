# Stage 1: Build Frontend
FROM node:22-alpine AS frontend-builder
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Stage 2: Build Backend
FROM node:22-alpine AS backend-builder
WORKDIR /app/backend
RUN apk add --no-cache python3 make g++
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# Stage 3: Lean Production Image
FROM node:22-alpine AS runner
WORKDIR /app
RUN apk add --no-cache curl python3 make g++

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV KEYGATE_DB_PATH=/app/data/keygate.sqlite

WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev

COPY --from=backend-builder /app/backend/dist ./dist
COPY --from=frontend-builder /app/backend/public ./public
COPY providers /app/providers

VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/healthz || exit 1

CMD ["node", "dist/index.js"]
