# KeyGate 🗝️🛡️

![KeyGate — self-hosted AI API pool gateway](.github/social-preview.jpg)

> **Self-hosted, general-purpose AI API gateway: group upstream provider keys into load-balanced AI pools, route around failing ones, meter and cap spend, and expose ONE OpenAI-compatible API (`/v1`) for any client — plus a modern management UI.**

[![Release](https://img.shields.io/github/v/release/enis1enis2/KeyGate?logo=github)](https://github.com/enis1enis2/KeyGate/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/enis1enis2/KeyGate/ci.yml?branch=main&logo=github)](.github/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-122%20passed-brightgreen)]()
[![License](https://img.shields.io/github/license/enis1enis2/KeyGate)](LICENSE)
[![Fastify](https://img.shields.io/badge/Fastify-v5-black.svg)]()
[![React](https://img.shields.io/badge/React-19-cyan.svg)]()
[![Docker](https://img.shields.io/badge/docker-ready-blue.svg)]()

---

## 🌟 Core Concepts

- **Providers are DATA, not code**: Each upstream provider is defined as a declarative YAML/JSON spec containing endpoints, auth templates, request/response JSONata or Handlebars mappings, streaming chunk translation, and error classification rules.
- **The Whole OpenAI Surface**: One pipeline serves `/v1/chat/completions`, `/v1/responses`, `/v1/completions`, `/v1/embeddings`, `/v1/moderations`, `/v1/images/*`, `/v1/audio/*` (multipart uploads included), `/v1/files`, `/v1/batches` (including `.../:id/cancel` and `.../:id/content`), `/v1/models` and `/v1/passthrough/{provider}/*` — with the same routing, failover, metering and error shaping everywhere.
- **AI Pools**: A pool is the model name your clients send. It defines a target chain (`weighted-by-health`, `round-robin`, `priority`), a primary endpoint hint, a description, and **daily token / spend caps**. Gateway keys can be scoped to specific pools.
- **Metering & Budgets**: `model_pricing` rows (USD per million tokens, `*` wildcards allowed) turn usage into `request_logs.cost`. Daily budgets read `SUM(cost)` for the current UTC day — no reset job. Over-budget API keys are dropped from routing (normal failover continues), exhausted pool caps answer `429 quota_exhausted`.
- **Circuit Breaker & Key Health**: Tracks a rolling 100-call window per key with p50/p95 latencies and rolling success rates. Automatically opens the circuit upon `N` consecutive failures or low success rates, applies exponential backoff, honors upstream `Retry-After`, applies long cooldowns on quota exhaustion, and disables keys on auth failures.
- **Smart Failover & Hedging**: Automatically fails over across healthy keys and upstream providers, including multipart uploads and job-based resources (a created batch/file is pinned to the upstream account that created it). Optional speculative hedged requests race backup keys to eliminate latency tail spikes.
- **Encrypted at Rest**: Upstream API keys are encrypted using **AES-256-GCM** with a master key from the environment. Raw keys are never logged and never exposed in the UI.
- **Zero-Friction Onboarding**: Paste a cURL command into the **Add Provider Wizard** to auto-draft the YAML spec, then test mappings live before saving.
- **Any OpenAI-Compatible Client**: Point the official OpenAI SDK, LangChain, Open WebUI, LlamaIndex, n8n, or any custom agent at KeyGate's Base URL — or use the generic passthrough endpoint for anything else.

---

## 🚀 Quick Start with Docker Compose

1. Clone or download the repository:
   ```bash
   git clone https://github.com/enis1enis2/KeyGate.git keygate
   cd keygate
   ```

2. Copy environment file and configure secrets:
   ```bash
   cp .env.example .env
   # Edit .env and set:
   #   KEYGATE_MASTER_KEY  - 32+ char secret used to encrypt upstream keys at rest
   #   KEYGATE_ADMIN_TOKEN  - bearer token for the management API (/api/*) and /metrics
   # Both are REQUIRED when NODE_ENV=production; KeyGate refuses to boot without them.
   ```

3. Start KeyGate with Docker Compose:
   ```bash
   docker-compose up -d --build
   ```

4. Open your browser:
   - **Management UI**: [http://localhost:3000](http://localhost:3000)
   - **OpenAI Compatible Endpoint**: `http://localhost:3000/v1`
   - **Health Probe**: [http://localhost:3000/healthz](http://localhost:3000/healthz)
   - **Prometheus Metrics**: [http://localhost:3000/metrics](http://localhost:3000/metrics)

---

## 🛠️ Local Development

### Prerequisites
- Node.js >= 20
- npm >= 10

### 1. Install & Build Frontend
```bash
cd frontend
npm install
npm run build     # Outputs directly to ../backend/public
```

### 2. Install & Start Backend
```bash
cd ../backend
npm install
npm run build
npm start         # Runs Fastify on http://localhost:3000
```

### 3. Run Checks
```bash
cd backend
npm run typecheck   # tsc for src/ and tests/
npm run lint        # oxlint
npm test            # vitest (isolated temp DB, never touches data/)
```
The test suite includes:
- Unit tests for template mapping, JSONata expressions, and streaming chunk translation
- Unit tests for the sliding window circuit breaker, backoff, and Retry-After
- Unit tests for router strategies (`weighted-by-health`, `round-robin`, `priority`)
- Unit tests for quota slots, pool caps, daily budgets, pricing and cost metering
- Integration test running an in-process mock non-standard upstream HTTP server with streaming and failover
- Integration test for the shared proxy pipeline: every `/v1` surface (responses, completions, images, audio, files, batches), multipart re-serialization, sticky routes, pool scoping, budget blocks and error envelopes

Tests run against a throwaway SQLite database in the OS temp directory (`tests/setup.ts`), so local data is never modified.

Frontend:
```bash
cd frontend
npm run lint        # oxlint (zero warnings, no-explicit-any enforced)
npm run build       # tsc -b + vite build -> ../backend/public
```

CI runs both job sets on every push and PR (`.github/workflows/ci.yml`).

---

## 📡 API Reference

### OpenAI-Compatible API (`/v1`)
All routes require `Authorization: Bearer kg-live-...` (unless `KEYGATE_REQUIRE_AUTH=false`) and are routed through AI pools.

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/v1/chat/completions` | `POST` | Chat completions (streaming SSE & non-streaming, failover, hedging) |
| `/v1/responses` | `POST` | OpenAI Responses API |
| `/v1/completions` | `POST` | Legacy text completions (usage backfilled from SSE) |
| `/v1/embeddings` | `POST` | Embeddings with cost metering |
| `/v1/moderations` | `POST` | Content moderation |
| `/v1/images/generations` | `POST` | Image generation (JSON responses) |
| `/v1/images/edits`, `/v1/images/variations` | `POST` | Multipart image edits/variations (file re-serialized per attempt) |
| `/v1/audio/transcriptions`, `/v1/audio/translations` | `POST` | Multipart audio → JSON |
| `/v1/audio/speech` | `POST` | Audio synthesis (binary pass-through) |
| `/v1/files` (+ `/:id`, `/:id/content`) | `GET`, `POST` | File upload/list/retrieve, pinned to the creating upstream account |
| `/v1/batches` (+ `/:id`, `/:id/cancel`) | `GET`, `POST` | Batch jobs, pinned to the creating upstream account |
| `/v1/models` | `GET` | Lists the pools this gateway key may use |
| `/v1/passthrough/{provider}/*` | `ANY` | Injects the healthiest key into raw requests for anything else (confined to the provider's base URL; pool-scoped keys only reach providers their pools target) |

### Management API (`/api`)
All `/api/*` routes and `/metrics` require `Authorization: Bearer <KEYGATE_ADMIN_TOKEN>`. The Management UI prompts for this token and stores it in `localStorage`.

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/providers` | `GET`, `POST` | List and save declarative YAML provider specs |
| `/api/providers/wizard/draft` | `POST` | Auto-drafts provider YAML spec from cURL command |
| `/api/providers/test` | `POST` | Live test runner showing mapped request and response |
| `/api/keys` | `GET`, `POST`, `PUT`, `DELETE` | Encrypted upstream key manager, health metrics, daily budgets |
| `/api/aliases` | `GET`, `POST`, `DELETE` | AI pools: target chain, strategy, endpoint hint, daily caps |
| `/api/pricing` | `GET`, `POST`, `DELETE` | `model_pricing` rows (USD per Mtok) that meter every request |
| `/api/gateway-keys` | `GET`, `POST`, `DELETE` | Issue/revoke client Bearer tokens with rpm/tpm limits and pool scope |
| `/api/logs` | `GET` | Filterable request traces (`status`, `provider_id`, `model`, `endpoint`) with cost |
| `/api/dashboard/stats` | `GET` | Aggregate KPIs, spend today, per-pool usage, over-budget keys |

---

## 🧩 Shipped Provider Specs

KeyGate ships with two example provider specs in the `providers/` directory:
1. [`providers/openai-compatible.yaml`](providers/openai-compatible.yaml): Fast-path configuration for OpenAI-compatible providers (Groq, Together, DeepSeek, Mistral).
2. [`providers/anthropic-messages.yaml`](providers/anthropic-messages.yaml): Deliberately non-standard API demonstrating bidirectional JSONata transformation of Anthropic's Messages format, streaming chunk remapping, and custom error types.

---

## 🔌 Integrations

KeyGate speaks the OpenAI protocol, so anything that accepts a custom OpenAI base URL works unchanged.

| Client | Setup guide |
| :--- | :--- |
| OpenAI SDK (Python / Node) | [docs/integrations.md](docs/integrations.md) |
| LangChain | [docs/integrations.md](docs/integrations.md) |
| Open WebUI | [docs/integrations.md](docs/integrations.md) |
| n8n | [docs/n8n.md](docs/n8n.md) + [`n8n-example.json`](n8n-example.json) |
| cURL / any HTTP client | [docs/integrations.md](docs/integrations.md) |

```
Any OpenAI-compatible client
           │
           ▼
KeyGate (/v1/chat/completions)
  ├── 1. Authenticate Gateway Key (kg-live-...)
  ├── 2. Resolve Model Alias -> Target Chain
  ├── 3. Health-Weighted Key Selection
  ├── 4. Transform Payload (JSONata / Handlebars)
  ├── 5. Forward to Upstream
  └── 6. Automatic Failover if Rate-Limited or 5xx
```

---

## 🔒 Security Architecture

- **Encrypted at Rest**: Keys are encrypted with **AES-256-GCM** using unique IVs and authenticated tags.
- **Zero Key Leakage**: Sensitive credentials are never logged and never returned in full (masked as `prefix...suffix`).
- **Admin Authentication**: `/api/*` and `/metrics` require a bearer token compared with `crypto.timingSafeEqual`, checked against the **normalized** request path (percent-encoded and absolute-form targets included) before routing. **Audit fix**: Guards now use `normalizedPathname()` so percent-encoded (`/%61pi/keys`) and absolute-form (`GET http://host/api/keys`) targets are normalized before comparison.
- **Pre-Auth Data Plane**: the gateway bearer token is verified for `/v1/*` before any request body is parsed or buffered, so unauthenticated callers cannot drive upload buffering. **Audit fix**: Added `/v1/*` onRequest hook that authenticates the gateway token before Fastify parses/buffers any body.
- **Scoped Model Routing**: a `model` that matches no AI pool answers `404 model_not_found` instead of silently falling back to the first provider, so pool daily caps cannot be bypassed with an unknown model name. **Audit fix**: `resolveTargets()` returns `unresolved` → `404 model_not_found` for unknown models.
- **Passthrough Path Confinement**: `/v1/passthrough/:provider/*` resolves its wildcard against the provider `base_url` with `new URL()`, rejects dot segments (literal or percent-encoded, `/` or `\\`) and verifies origin + base-path prefix, so a gateway key cannot escape the provider's base path and hit other endpoints on the provider host with the operator's credential attached. **Audit fix**: Dot-segment rejection + origin/base-path verification; hop-by-hop headers no longer relayed upstream.
- **Passthrough Pool Scope**: a gateway key with an explicit pool scope may only reach providers that at least one of its allowed pools targets (`isProviderReachableByKey`); `['*']` keys behave as before. **Audit fix**: Previously passthrough skipped the scope check entirely; now keys restricted to specific pools get 403 `model_not_allowed` outside their pools.
- **Baseline Response Headers**: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, and a CSP (`script-src 'self'`, `frame-ancestors 'none'`, …) verified against the production bundle (external module script only, no inline script/style, no external fetches). **Audit fix**: Added as part of the Cloudflare security-audit-skill hardening pass.
- **Client Trace-Id Validation**: client `x-trace-id` accepted when matching `^[A-Za-z0-9._:-]{8,64}$`; `finalizeUsage()` scoped by `gateway_key_id IS ?` so one key's stream can never rewrite another key's metering rows. **Audit fix**: Format validation + key-id scoping in metering.
- **Web-Search Cache**: bounded by TTL + 256-entry cap (query cardinality is attacker-influenceable). **Audit fix**: TTL + oldest-first eviction cap added.
- **Health Probe Redaction**: `/healthz` no longer echoes driver error text to anonymous callers. **Audit fix**: Error text redacted.
- **CI Integrity**: actions pinned to full commit SHAs with `permissions: contents: read`; unused `zod` dependency removed. **Audit fix**: SHA pins + permissions added.

### Environment Variables

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `KEYGATE_MASTER_KEY` | *required in prod* | AES-256-GCM key for stored upstream keys |
| `KEYGATE_ADMIN_TOKEN` | *required in prod* | Bearer token for `/api/*` and `/metrics` |
| `KEYGATE_REQUIRE_AUTH` | `true` | Gateway Bearer token checks on `/v1/*` |
| `KEYGATE_DB_PATH` | `./data/keygate.sqlite` | SQLite database location |
| `CORS_ORIGINS` | *(empty)* | Comma-separated allowed origins; empty = same-origin only |
| `RATE_LIMIT_MAX` | `300` | Global requests per window |
| `RATE_LIMIT_V1_MAX` | `120` | Per-window cap for `/v1/*` routes |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window length |
| `METRICS_RETENTION_DAYS` | `30` | Log/metric retention |
| `MAX_UPLOAD_BYTES` | `67108864` | Max multipart upload size (bytes) for audio/image/file routes |
| `DEFAULT_TIMEOUT_MS` | `30000` | Default per-request upstream timeout (pools may override) |

---

## 🤝 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for
the development setup, code conventions, and the pull-request process. All
participants are expected to follow the
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

Found a security issue? **Do not open a public issue** — follow the reporting
process in [SECURITY.md](SECURITY.md).
