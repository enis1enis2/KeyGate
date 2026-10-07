# KeyGate Architecture & Engineering Decisions

This document summarizes key architectural and technical judgment calls made while building KeyGate.

---

### DECISION 1: Declarative Provider Specifications as Pure Data (YAML/JSON)
- **Rationale**: Providers frequently introduce new endpoints, authentication headers, and response formats. Rather than writing separate TypeScript classes for each provider, each provider is expressed as a pure declarative YAML schema.
- **Engines Supported**:
  - `openai-compatible`: Fast-path bypassing transformations.
  - `jsonata`: Used for expressive JSON queries, nested key remapping, and math aggregations.
  - `handlebars`: Used for string formatting and prompt injection.
  - `custom_adapter`: Escape hatch dynamically importing a `.js`/`.ts` plugin if bespoke logic is required.

---

### DECISION 2: Authenticated AES-256-GCM Encryption for Upstream Keys
- **Rationale**: Upstream API keys are sensitive credentials. Storing them in plaintext or reversible base64 is unacceptable.
- **Implementation**:
  - Keys are encrypted with AES-256-GCM using a unique 12-byte initialization vector (IV) per key.
  - Master key is derived from the `KEYGATE_MASTER_KEY` environment variable using SHA-256.
  - Authentication tags (16 bytes) ensure ciphertext integrity.
  - Plaintext keys are never logged and never returned in full over the Management API (only masked prefixes/suffixes e.g. `sk-pro...8f9c` are returned).

---

### DECISION 3: In-Memory Sliding Window for Circuit Breaker and Latency Percentiles
- **Rationale**: Querying SQLite on every single proxy request to compute rolling 100-call success rates and p50/p95 latencies would cause write-lock contention under high concurrency.
- **Implementation**:
  - In-memory circular buffer retains the last 100 calls per key.
  - Circuit states: `CLOSED`, `OPEN`, and `HALF_OPEN`.
  - Cooldown uses exponential backoff (`base * 2^(fail_count - 1)`), capped at `maxCooldownMs`.
  - Honors upstream `Retry-After` headers if greater than computed backoff.
  - Single-probe lock in `HALF_OPEN` state prevents stampeding requests while testing upstream recovery.
  - Immediate `is_active = 0` on `auth_fail` errors to halt unauthorized traffic until human review.
  - 24-hour cooldown on `quota_exhausted` errors.

---

### DECISION 4: Smart Router Chain Strategy & Speculative Hedged Requests
- **Rationale**: LLM APIs often suffer from sudden latency spikes, rate limits, or transient outages.
- **Implementation**:
  - Routing supports three configurable strategies:
    1. `weighted-by-health` (default): Score = `weight * (success_rate^2 * 1000) / max(latency_p50, 50)`. Healthy, fast keys are prioritized dynamically.
    2. `round-robin`: Rotates requests uniformly across configured targets.
    3. `priority`: Strict priority waterfall.
  - Transparent Failover: If a key fails with a retryable error or rate limit, KeyGate immediately attempts the next healthy key in the target, and then the next target in the alias chain.
  - Speculative Hedging: For critical aliases, KeyGate can launch a secondary speculative request after a configurable delay (`hedged_delay_ms`). Whichever finishes first is returned to the client, dropping the slower one.

---

### DECISION 5: Native Fastify Architecture with Unified SPA Serving
- **Rationale**: Serving the React dashboard from the same Fastify server simplifies self-hosting to a single container or binary without requiring an extra reverse proxy (Nginx).
- **Implementation**:
  - Built frontend assets in `backend/public/` are served by `@fastify/static`.
  - SPA fallback route routes non-API URLs to `index.html`.
  - Full CORS support is available for decoupled development when Vite runs on `:5173`, but only for origins explicitly listed in `CORS_ORIGINS` (see Decision 8).

---

### DECISION 6: Zero-Friction Provider Onboarding via cURL Parser
- **Rationale**: Hand-crafting YAML templates can be error-prone.
- **Implementation**:
  - Wizard parses standard cURL command flags (`-X`, `-H`, `-d`, `--data-raw`, URL).
  - Automatically identifies authentication schemes (`Bearer`, `x-api-key`, query parameter).
  - Automatically infers request bodies and provides sample response JSONata transformations.
  - Integrated "Live Test" button evaluates mappings against live upstream APIs before saving.

---

### DECISION 7: Automated 30-Day Metrics Pruning
- **Rationale**: To respect the 30-day retention requirement without manual maintenance.
- **Implementation**:
  - `RequestLogRepo.purgeOldLogs` runs at startup and periodically via a 24-hour timer.
  - Indexed timestamp columns in SQLite ensure fast prune queries.

---

### DECISION 8: Admin Bearer Token, Fail-Fast Secrets, and Same-Origin-Only CORS
- **Rationale**: The management API could mutate provider specs and read masked key metadata without any credential, and development fallbacks made the deployment insecure by default.
- **Implementation**:
  - `KEYGATE_ADMIN_TOKEN` guards every `/api/*` route and `/metrics` via a Fastify `onRequest` hook registered before routes; comparison uses SHA-256 digests + `crypto.timingSafeEqual` to avoid length/timing leaks.
  - `KEYGATE_MASTER_KEY` and `KEYGATE_ADMIN_TOKEN` are mandatory whenever `NODE_ENV=production`; KeyGate refuses to boot otherwise. Development fallbacks emit a startup warning.
  - CORS emits headers only for origins in `CORS_ORIGINS`; an empty value means same-origin only, which is the safe default for a self-hosted single-container deployment.
  - The SPA stores the admin token in `localStorage` and signs out automatically on `401` (`keygate:unauthorized` event).

---

### DECISION 9: Layered Rate Limiting on Hot Routes
- **Rationale**: `/v1/*` is the public-facing surface and must be protected without letting management UI traffic starve legitimate model calls.
- **Implementation**:
  - Global `@fastify/rate-limit` cap (`RATE_LIMIT_MAX`, default 300/window) applied to all routes.
  - Tighter per-route bucket (`RATE_LIMIT_V1_MAX`, default 120/window) on `/v1/chat/completions`, `/v1/embeddings` and `/v1/passthrough/:provider/*`.
  - Window configurable via `RATE_LIMIT_WINDOW_MS` (default 60s).

---

### DECISION 10: Governance via oxlint, Strict Test Isolation, and CI
- **Rationale**: Lint debt and unchecked types let `any` casts spread across both codebases, and the test suite previously wrote to the production SQLite file.
- **Implementation**:
  - `oxlint` runs on `backend` (src + tests) and `frontend` with `typescript/no-explicit-any: "error"`; error handling is centralized in `src/errors.ts` (`toErrorInfo` / `errorMessage`) so `catch (err: unknown)` is the norm.
  - `npm run typecheck` covers `src/` and `tests/` (`tsconfig.test.json`).
  - `vitest.config.ts` + `tests/setup.ts` point `KEYGATE_DB_PATH` at a temp file and set test secrets; `afterAll` closes the DB and deletes it, so `data/` is never touched.
  - `.github/workflows/ci.yml` runs typecheck, lint, build and tests for both packages on every push and PR.

---

### DECISION 11: AI Pools Are Promoted Model Aliases, Evolved by an Idempotent Migration Shim
- **Rationale**: KeyGate already had a working routing primitive (`model_aliases`), so introducing a second top-level "pool" table would have created two sources of truth for the same concept. The project also has no migration framework — `db/schema.ts` is `CREATE TABLE IF NOT EXISTS` only.
- **Implementation**:
  - `model_aliases` gained `description`, `endpoint_kind`, `daily_token_cap` and `daily_spend_cap`; the UI concept is "AI Pool".
  - `backend/src/db/migrations.ts` adds columns with `PRAGMA table_info` + `ALTER TABLE ... ADD COLUMN` and is invoked from `getDb()` right after `SCHEMA_SQL`. It is additive-only, so existing databases (including `backend/data/keygate.sqlite`) upgrade in place with no rollback needed.
  - `model_pricing(provider_id, model, input_per_mtok, output_per_mtok)` prices requests with `provider_id`/`model` wildcards (`*`), resolved by `PricingRepo.findBest` in precedence order: exact pair, provider wildcard, model wildcard, global wildcard.
  - `request_logs` gained `endpoint`, `cost` and `pool_name`, plus composite indexes on `(gateway_key_id, created_at)` and `(alias_name, created_at)` for daily roll-ups.
  - New admin surface `/api/pricing` (list/upsert/delete) under the admin `onRequest` hook.

---

### DECISION 12: Every Quota Is Enforced Before Dispatch, and Budgets Read the Request Log
- **Rationale**: Limits that are only checked at response time still burn upstream money. Storing a rolling `daily_usage` counter would also require a midnight reset job and drifts from what was actually billed.
- **Implementation**:
  - `authorizeGatewayKey()` is the single data-plane entry point: authenticate → pool scope (`allowed_aliases_json`, `["*"]` = all pools) → atomic rpm/tpm slot reservation via `engine/gateway-quota.ts` (in-memory fixed 1-minute buckets, mirroring the upstream limiter in `circuit-breaker.ts`). `sendAuthError()` renders OpenAI-shaped `401/403/429` bodies with `Retry-After`.
  - API-key daily budgets are enforced by *excluding* over-budget keys inside `SmartRouter.selectKeys()`, so normal failover moves traffic to the next key; if every key is budget-blocked the request fails with `quota_exhausted` (429) instead of a generic error.
  - Pool caps (`daily_token_cap`, `daily_spend_cap`) are checked in `assertPoolBudget()` before any upstream call.
  - Budgets read `SUM(cost)` from `request_logs` for the current UTC day, so rollover needs no cron; `api_keys.daily_usage` is still incremented as a lifetime counter for display.
  - `computeCost()` writes cost into `request_logs.cost`, feeds `api_keys.daily_usage`, and backs the Prometheus gauges `keygate_spend_today_usd` / `keygate_pool_spend_today_usd` / `keygate_pool_tokens_today`.
  - Streaming requests send `stream_options.include_usage = true` upstream, and the gateway backfills `request_logs` with real usage via `RequestLogRepo.finalizeUsage()` once the SSE stream drains — otherwise streaming traffic could never be metered.
  - `/v1/models` is now rate-limited like the other `/v1` routes and lists only the pools a given gateway key may use.

---

### DECISION 13: One Shared Proxy Pipeline for Every Non-Chat Surface
- **Rationale**: `/v1/embeddings` had its own hand-rolled proxy; adding `/v1/responses`, images, audio, batches and files as bespoke handlers would have produced seven copies of routing, failover, metering and error shaping — each able to drift from the pool semantics chat already had.
- **Implementation**:
  - `engine/proxy.ts` exports `proxyEndpoint(options)` — auth → pool budget → sticky/candidate targeting → failover → response streaming → usage metering → OpenAI error envelope. `routes/openai-surface.ts` is a declarative table of `{path, EndpointPathKey, flags}`; adding a surface is a one-line change.
  - Target/selection logic moved out of `engine/router.ts` into `engine/targeting.ts` (`resolveTargets`, `selectCandidateKeys`, `assertPoolBudget`, `sortTargets`, `loadProviderSpec`, `providerHealthScore`) so chat and the proxy pipeline cannot diverge — and so `proxy.ts` does not import `router.ts` (which would have been circular).
  - `endpoint_paths` in a provider spec is now a full `EndpointPaths` map (`DEFAULT_ENDPOINT_PATHS` provides fallbacks). A pool's `model` names the route *and* the upstream model; `resolveTargets(alias, model, pathKey)` picks the pool when one is given and falls back to the first active provider otherwise (preserving historical chat behaviour).
  - Model-bearing surfaces reject a request with no `model` up front (`requireModel`, 400 `missing_required_fields`) because without it there is no pool to budget or scope; `images/variations`, `batches` and `files` are exempt where the model is genuinely optional upstream.

---

### DECISION 14: Multipart Is Re-Serialized Per Attempt, and Created Resources Are Pinned
- **Rationale**: Pool scoping and body-auth need to rewrite fields inside file uploads, and retried uploads must not reuse a consumed boundary. Separately, batches and files are *account-scoped*: a job created through upstream account A must be read/cancelled through A, never a pooled sibling.
- **Implementation**:
  - `@fastify/multipart` parses uploads into memory (bounded by `MAX_UPLOAD_BYTES`, default 64 MB) and `serializeMultipart()` rebuilds the body with a fresh `keygate-boundary-<uuid>` per attempt, rewriting `model` and appending body-auth fields.
  - `sticky_routes(resource_id PK, provider_id, key_id, pool_name, endpoint, created_at)` pins a created resource id to the attempt that produced it. Follow-up routes pass `stickyParam`/`pathSuffix` so the upstream URL reconstructs `/batches/:id[/cancel]` and `/files/:id[/content]`.
  - Sticky attempts bypass `selectCandidateKeys`, so a pinned job still resolves while every pooled key is budget-blocked; absent a sticky row, routing falls back to normal pool selection. Rows are purged by the same retention cron as request logs.

---

### DECISION 15: Streaming, Binary and Error Responses Are Pass-Through with Metering on Drain
- **Rationale**: Images, file downloads and `audio/speech` are not JSON, and SSE consumers expect byte-for-byte upstream chunks. Both cases must still be logged, costed and quota-accounted, and must never desync the client connection.
- **Implementation**:
  - Non-JSON upstream bodies are piped to `reply.raw` (chunked reader, no `reply.hijack()`), and SSE is written through the same path; once bytes reach the client the failover chain ends (`clientCommitted`) — only a failure *before* any write triggers a retry on the next key.
  - Response headers are an allow-list (`content-type`, `content-disposition`, `cache-control`, `retry-after`, `x-request-id`, `openai-*`, `x-ratelimit-*`); `content-length`/`content-encoding`/`transfer-encoding` are dropped because `fetch` has already decoded the body.
  - Streaming usage is parsed incrementally by `SseUsageReader` (handles both `usage` and `response.usage` shapes) and written back with `RequestLogRepo.finalizeUsage()` + `GatewayQuota.addTokens()` after drain.
  - JSON bodies are sent upstream with an explicit `Content-Type: application/json` (undici otherwise labels string bodies `text/plain`, which upstreams refuse), and error envelopes come from the shared `toOpenAIError()` helper in `errors.ts`.
  - `proxyEndpoint` always mints its own trace id (client `x-trace-id` is not trusted) and returns it as `x-trace-id`, which is how log rows are correlated during smoke tests.


---

### DECISION 16: The Console Is Organized Around Pools, Prices and Spend
- **Rationale**: The admin UI still described the product as an n8n key broker ("Routing & Aliases") and hid the metering that the backend now enforces, so budgets and pool caps were invisible to an operator until they hit a 429.
- **Implementation**:
  - The tab is renamed **AI Pools** and the editor gained the pool's data fields: `description`, `endpoint_kind` (documented hint over `ENDPOINT_KINDS`, not a restriction), `daily_token_cap` and `daily_spend_cap`, with today's per-pool requests/tokens/spend shown against those caps in the pool list.
  - A new **Model Pricing** tab manages `model_pricing` rows (provider, model, input/output USD per Mtok, `*` wildcards allowed) through the existing `/api/pricing` CRUD.
  - Gateway keys gained a **Pool Scope** selector (empty = `["*"]` = all pools) in the create modal and a scope column in the table; Requests Logs gained an **Endpoint** filter (new `endpoint` query param on `/api/logs`) plus Endpoint and Cost columns, and the trace modal now shows endpoint, pool and cost.
  - The Dashboard adds a Spend (Today UTC) KPI and two panels — per-pool usage vs cap and gateway keys over daily budget — fed by `spendToday`, `poolUsageToday` and `budgetedKeys` from `/api/dashboard/stats`.
