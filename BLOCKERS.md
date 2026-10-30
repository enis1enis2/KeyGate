# KeyGate Blockers & Resolution Log

## Current Status: No Blockers (All Tests Passing, 100% Operational)

All core requirements, tests, database operations, declarative mapping engines, circuit breakers, routing algorithms, frontend dashboard components, and n8n integration artifacts have been successfully implemented and validated. Security, lint, type-safety, test-isolation and CI findings from the repository audit are resolved (items 4-9 below).

The product has since been expanded from an n8n-focused key broker into a general-purpose AI API pool:

- **Full OpenAI surface**: `/v1/responses`, `/v1/completions`, `/v1/moderations`, `/v1/images/*`, `/v1/audio/*` (multipart), `/v1/files`, `/v1/batches` are served by one shared pipeline (`engine/proxy.ts` + `routes/openai-surface.ts`) with the same routing, failover, metering and error shaping as chat. See `DECISIONS.md` decisions 13-15.
- **Metering & budgets**: `model_pricing` → `request_logs.cost` → daily UTC budgets for pools (`daily_token_cap`, `daily_spend_cap`) and gateway keys, enforced before dispatch. See decisions 11-12.
- **Console**: *AI Pools* (formerly *Model Aliases*), a *Model Pricing* tab, pool scoping on gateway keys, endpoint/cost columns in request logs, and spend panels on the dashboard. See decision 16.
- **Verified**: backend typecheck/lint/44 tests, frontend lint/typecheck/build, and a live smoke run covering every `/v1` surface against a mock upstream — all green.

### Resolved Considerations During Implementation:
1. **ES Module & TypeScript 7 Resolution**:
   - *Status*: Resolved.
   - *Action*: Configured `backend/tsconfig.json` for ES2022 with `NodeNext` module resolution, updated `backend/package.json` to `"type": "module"`, and ensured all local imports use explicit `.js` extensions.

2. **Tailwind CSS v4 Integration**:
   - *Status*: Resolved.
   - *Action*: Configured `@tailwindcss/vite` plugin with modern `@import "tailwindcss";` in `frontend/src/index.css`. Build outputs directly to `backend/public/`.

3. **Database Conflict Handling on Seeding / Tests**:
   - *Status*: Resolved.
   - *Action*: Replaced plain inserts with `ON CONFLICT(id) DO UPDATE` for idempotent initialization across test runs and container restarts.

4. **Unauthenticated Management API & Hardcoded Dev Secrets**:
   - *Status*: Resolved.
   - *Action*: Added `KEYGATE_ADMIN_TOKEN` (SHA-256 + `timingSafeEqual`) enforced by an `onRequest` hook in `server.ts` covering `/api/*` and `/metrics`. `KEYGATE_MASTER_KEY` / `KEYGATE_ADMIN_TOKEN` now hard-fail at boot when `NODE_ENV=production`; development fallbacks warn loudly at startup.

5. **Wide-Open CORS and No Rate Limiting**:
   - *Status*: Resolved.
   - *Action*: CORS now emits headers only for origins listed in `CORS_ORIGINS` (empty = same-origin only). Added a global `@fastify/rate-limit` plus a tighter per-route cap on `/v1/chat/completions`, `/v1/embeddings` and `/v1/passthrough/*`.

6. **Build Artifacts & Secrets Tracked in Git**:
   - *Status*: Resolved.
   - *Action*: Root `.gitignore` added; `backend/node_modules`, `backend/dist`, `backend/data`, `backend/public` removed from the index (6,259 files untracked).

7. **Lint Debt, Explicit `any`, and Unchecked Test Types**:
   - *Status*: Resolved.
   - *Action*: `oxlint` configured for backend and frontend with `typescript/no-explicit-any: "error"`; all explicit `any` replaced by `unknown` + narrowing (`src/errors.ts`). Added `npm run typecheck` (checks `src/` and `tests/`).

8. **Tests Mutating the Real Database**:
   - *Status*: Resolved.
   - *Action*: `vitest.config.ts` + `tests/setup.ts` point `KEYGATE_DB_PATH` at a throwaway file in the OS temp directory and set test secrets; the temp DB is closed and deleted in `afterAll`.

9. **No CI**:
   - *Status*: Resolved.
   - *Action*: `.github/workflows/ci.yml` runs typecheck, lint, build and tests for the backend and lint + build for the frontend on every push and PR.

10. **Security audit findings (unauthenticated management API, scope/quota bypasses)**:
    - *Status*: Resolved.
    - *Method*: Full audit following Cloudflare's `security-audit-skill` workflow — architecture/coverage recon over `backend/src`, coverage-led hunting across the HTTP/auth, injection, quota/availability and supply-chain classes, then adversarial validation with bounded local fixtures (raw-socket request-target tests, mock-upstream URL capture, isolated pre-auth body test) before any fix was written.
    - *Findings & fixes* (all with regression tests in `backend/tests/security.test.ts` and `backend/tests/security-preauth.test.ts`):
      1. **CRITICAL — unauthenticated management API**: `isManagementPath()` compared the raw URL while the router percent-decodes and accepts absolute-form targets, so `GET /%61pi/keys`, `GET /%6detrics` and `GET http://host/api/keys` served admin data / Prometheus metrics without the admin token. Fixed with `normalizedPathname()` shared by both guards (DECISION 17).
      2. **MEDIUM — pre-auth body buffering**: the gateway token was checked after the body was parsed/buffered, letting unauthenticated callers force up to `MAX_UPLOAD_BYTES × files` (512 MB by default) of multipart buffering per request. Fixed with a `/v1/*` `onRequest` token hook before parsing.
      3. **MEDIUM — passthrough path traversal**: `/v1/passthrough/:provider/*` concatenated the client wildcard onto `base_url`, so `..` (raw or percent-encoded) escaped the base path and reached other endpoints on the provider host with the operator's credential attached. Fixed with dot-segment rejection + origin/base-path verification.
      4. **HIGH — passthrough ignored pool scope**: keys restricted to specific pools could reach every provider via passthrough. Fixed with `isProviderReachableByKey()` (403 `model_not_allowed` outside the key's pools).
      5. **MEDIUM — unknown model names bypassed pool caps**: any model that matched no pool silently rode the first-active-provider fallback with no daily caps, strategy or timeout. Fixed: `resolveTargets()` returns `unresolved` → `404 model_not_found` (DECISION 13 amended).
      6. **LOW — client-controlled `x-trace-id`**: chat accepted arbitrary client trace ids used as the metering `UPDATE … WHERE trace_id` key. Fixed with format validation + `gateway_key_id` scoping in `finalizeUsage()`.
      7. **Hardening**: response security headers incl. CSP; hop-by-hop headers no longer relayed by passthrough; web-search cache TTL + 256-entry cap; `/healthz` error-text redaction; CI actions SHA-pinned with `permissions: contents: read`; unused `zod` dependency removed.
    - *Verification*: `npm test` 122/122 (13 files), `npm run typecheck`, `npm run lint` clean for backend; frontend lint + build clean; live smoke run confirmed 401/404/400 on the fixed vectors and admin API still reachable with the token.
    - *Noted, not defects in source* (need owner/deployment observation): rate-limit keying is per-`request.ip` — behind a reverse proxy the operator must configure trusted-proxy settings or all clients share one bucket; shared upstream accounts mean `files`/`batches` visible to any key routed to that account (pool design); the container runs as root (volume-permission trade-off); first-boot prints the generated gateway token to stdout for onboarding (protect container logs).
