# KeyGate 🗝️🛡️

> **Self-hosted, general-purpose AI API gateway: group upstream provider keys into load-balanced AI pools, route around failing ones, meter and cap spend, and expose ONE OpenAI-compatible API (`/v1`) for any client — plus a modern management UI.**

[![CI](https://img.shields.io/github/actions/workflow/status/enis1enis2/KeyGate/ci.yml?branch=main&logo=github)](.github/workflows/ci.yml)
[![Tests](https://img.shields.io/badge/tests-63%20passed-brightgreen)]()
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
   git clone <repo-url> keygate
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
| `/v1/passthrough/{provider}/*` | `ANY` | Injects the healthiest key into raw requests for anything else |

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
- **Admin Authentication**: `/api/*` and `/metrics` require a bearer token compared with `crypto.timingSafeEqual`.
- **Fail-Fast Secrets**: `KEYGATE_MASTER_KEY` / `KEYGATE_ADMIN_TOKEN` are mandatory under `NODE_ENV=production`.
- **Rate Limiting**: Global cap plus a tighter per-route cap on `/v1/*` (`RATE_LIMIT_MAX`, `RATE_LIMIT_V1_MAX`, `RATE_LIMIT_WINDOW_MS`).
- **Quotas Enforced Before Dispatch**: gateway-key rpm/tpm slots, pool daily token/spend caps and API-key daily budgets are all checked *before* an upstream call; violations answer `429 quota_exhausted` with `Retry-After` instead of burning money.
- **Same-Origin by Default**: No CORS headers unless `CORS_ORIGINS` explicitly lists allowed origins.
- **Session Expiry**: The UI signs out automatically on a `401` from the management API.
- **Data Retention**: Request trace logs and metrics are retained for 30 days and automatically pruned by a background task.

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
