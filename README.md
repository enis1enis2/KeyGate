<div align="center">

<img src=".github/social-preview.jpg" alt="KeyGate — self-hosted AI API gateway" width="100%">

<h1>KeyGate</h1>

<p><strong>One OpenAI-compatible API in front of every provider key you own.</strong></p>

<p>Pool provider keys, route around failures, meter usage and enforce budgets — self-hosted as a single Node.js service with SQLite.</p>

<p>
  <a href="https://github.com/enis1enis2/KeyGate/actions/workflows/ci.yml"><img src="https://github.com/enis1enis2/KeyGate/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://github.com/enis1enis2/KeyGate/releases/latest"><img src="https://img.shields.io/github/v/release/enis1enis2/KeyGate" alt="Latest release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/enis1enis2/KeyGate" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A520-339933?logo=node.js&logoColor=white" alt="Node.js 20 or newer">
  <a href="Dockerfile"><img src="https://img.shields.io/badge/docker-ready-2496ED?logo=docker&logoColor=white" alt="Docker ready"></a>
</p>

<p>
  <a href="#quick-start">Quick start</a> ·
  <a href="#features">Features</a> ·
  <a href="#api-reference">API</a> ·
  <a href="#configuration">Configuration</a> ·
  <a href="#development">Development</a> ·
  <a href="README.tr.md">Türkçe</a>
</p>

</div>

## Overview

Every AI provider gives you another key, another quota, and another way to fail. KeyGate puts a
single OpenAI-compatible endpoint in front of all of them. Provider keys become **pools**, pools
become **model names your clients already send**, and unhealthy keys are routed around
automatically.

It is one Fastify service with an embedded SQLite database — no Redis, no Postgres, no sidecar,
no external queue. Point the official OpenAI SDK, LangChain, Open WebUI, LlamaIndex, n8n or any
custom agent at the gateway's base URL and it works unchanged.

## Features

| Capability | What it does |
| :--- | :--- |
| **One API, every surface** | `/v1/chat/completions`, `/v1/responses`, `/v1/completions`, `/v1/embeddings`, `/v1/moderations`, `/v1/images/*`, `/v1/audio/*`, `/v1/files`, `/v1/batches`, `/v1/models` and a generic `/v1/passthrough/{provider}/*` route share one pipeline. |
| **Pools and routing** | A pool is the model name clients send. Give it a target chain and a strategy: `weighted-by-health`, `round-robin` or `priority`. |
| **Health-aware failover** | A rolling window per upstream key tracks p50/p95 latency and success rate. Failing keys get exponential backoff, upstream `Retry-After` is honoured, and auth/quota failures trigger long cooldowns. |
| **Metering and budgets** | Per-million-token pricing turns usage into cost. Daily caps apply per pool and per gateway key, and over-budget keys are dropped from routing before an upstream call is made. |
| **Declarative providers** | Providers are YAML/JSON data — endpoints, auth headers, JSONata/Handlebars mappings, streaming chunk translation and error classification — not bespoke code. |
| **Secrets at rest** | Upstream keys are encrypted with AES-256-GCM under a master key from the environment. Raw keys are never logged or returned in full. |
| **Management console** | A React UI for providers, pools, keys, pricing, request traces and live health. Includes a cURL-to-spec wizard and a test runner that shows the mapped request and response. |
| **Observability** | Prometheus metrics at `/metrics`, filterable request traces with cost, trace IDs propagated through the pipeline, and a redacted `/healthz` probe. |
| **Hardened by default** | Admin/data-plane authentication, strict CSP and security headers, rate limiting, upload limits, traversal-safe passthrough and scoped model routing. |

## How it works

```text
OpenAI SDK · LangChain · Open WebUI · n8n · curl
                       │
                       │  POST /v1/chat/completions
                       │  Authorization: Bearer kg-live-…
                       ▼
┌────────────────────────────── KeyGate ─────────────────────────────┐
│  1. Authenticate the gateway key — pool scope, rpm/tpm, budget     │
│  2. Resolve the model name → pool → target chain                   │
│  3. Pick a healthy upstream key (weighted / round-robin / priority)│
│  4. Map the request with JSONata or Handlebars                     │
│  5. Call the upstream, stream the response back, meter usage       │
│  6. On 429/5xx: retry the next key, back off, open the circuit     │
└────────────────────────────────────────────────────────────────────┘
                       │
                       ▼
        OpenAI · Groq · Mistral · Together · DeepSeek · Anthropic · …
```

## Quick start

### Docker Compose (recommended)

```bash
git clone https://github.com/enis1enis2/KeyGate.git
cd KeyGate

cp .env.example .env
# Generate the two required secrets and put them in .env:
#   KEYGATE_MASTER_KEY=$(openssl rand -hex 32)
#   KEYGATE_ADMIN_TOKEN=$(openssl rand -hex 32)

docker compose up -d --build
```

Open [http://localhost:3000](http://localhost:3000), paste the admin token, then add a provider,
create a pool and issue a gateway key. The first boot prints a starter gateway token to the
container log.

| Service | URL |
| :--- | :--- |
| Management UI | `http://localhost:3000` |
| OpenAI-compatible API | `http://localhost:3000/v1` |
| Health probe | `http://localhost:3000/healthz` |
| Prometheus metrics | `http://localhost:3000/metrics` |

> [!IMPORTANT]
> The image runs as the unprivileged `node` user (uid 1000). On Linux, create the bind-mounted
> data directory with matching ownership before the first start:
> `mkdir -p data && sudo chown -R 1000:1000 data`.
>
> `KEYGATE_MASTER_KEY` and `KEYGATE_ADMIN_TOKEN` are mandatory when `NODE_ENV=production`.
> KeyGate refuses to boot with a missing, too-short or placeholder-looking secret.

Then call it like any OpenAI endpoint:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer kg-live-..." \
  -H "Content-Type: application/json" \
  -d '{
    "model": "default",
    "messages": [{ "role": "user", "content": "Hello from KeyGate" }]
  }'
```

## Configuration

The full list, with comments, is in [`.env.example`](.env.example). The settings that matter most:

| Variable | Default | Purpose |
| :--- | :--- | :--- |
| `KEYGATE_MASTER_KEY` | *required in production* | AES-256-GCM key for upstream keys at rest (min 16 chars) |
| `KEYGATE_MASTER_KEY_PREVIOUS` | — | Comma-separated retired keys, accepted for decryption only during rotation |
| `KEYGATE_ADMIN_TOKEN` | *required in production* | Bearer token for `/api/*` and `/metrics` |
| `KEYGATE_REQUIRE_AUTH` | `true` | Gateway bearer checks on `/v1/*` (cannot be disabled in production) |
| `KEYGATE_DB_PATH` | `./data/keygate.sqlite` | SQLite database location |
| `TRUST_PROXY` | `false` | `true` or comma-separated proxy addresses/CIDRs, for correct client IPs behind a proxy |
| `CORS_ORIGINS` | *(empty)* | Comma-separated allowed origins; empty means same-origin only |
| `RATE_LIMIT_MAX` | `300` | Global requests per window |
| `RATE_LIMIT_V1_MAX` | `120` | Tighter per-window cap for `/v1/*` |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit window length |
| `HISTORY_ENABLED` | `true` | Store per-pool prompt/completion history; set `false` on shared deployments |
| `METRICS_RETENTION_DAYS` | `30` | Request-log and metric retention |
| `MAX_UPLOAD_BYTES` | `67108864` | Maximum multipart upload size (64 MiB) |
| `DEFAULT_TIMEOUT_MS` | `30000` | Default per-request upstream timeout (pools may override) |

### Rotating the master key

Rotation is a two-key operation, so the gateway stays online:

1. Generate a replacement with `openssl rand -hex 32`.
2. Set `KEYGATE_MASTER_KEY` to the new value and `KEYGATE_MASTER_KEY_PREVIOUS` to the old one,
   then restart. Both keys are tried for decryption.
3. Re-encrypt every row: `cd backend && npm run reencrypt`, or
   `docker compose exec keygate node dist/reencrypt.js`.
4. Remove `KEYGATE_MASTER_KEY_PREVIOUS` and restart.

The script is idempotent, skips rows already on the current key, and reports any row it cannot
decrypt without printing secrets.

## API reference

### OpenAI-compatible API (`/v1`)

Every route requires `Authorization: Bearer kg-live-...` (unless `KEYGATE_REQUIRE_AUTH=false`)
and is routed through an AI pool.

| Endpoint | Methods | Description |
| :--- | :--- | :--- |
| `/v1/chat/completions` | `POST` | Chat completions — streaming and non-streaming, failover, hedging |
| `/v1/responses` | `POST` | OpenAI Responses API |
| `/v1/completions` | `POST` | Legacy text completions, usage backfilled from SSE |
| `/v1/embeddings` | `POST` | Embeddings with cost metering |
| `/v1/moderations` | `POST` | Content moderation |
| `/v1/images/generations` | `POST` | Image generation (JSON) |
| `/v1/images/edits`, `/v1/images/variations` | `POST` | Multipart image operations, re-serialized per attempt |
| `/v1/audio/transcriptions`, `/v1/audio/translations` | `POST` | Multipart audio to JSON |
| `/v1/audio/speech` | `POST` | Audio synthesis (binary pass-through) |
| `/v1/files`, `/v1/files/{id}`, `/v1/files/{id}/content` | `GET`, `POST` | Upload, list and retrieve files, pinned to the creating upstream account |
| `/v1/batches`, `/v1/batches/{id}`, `/v1/batches/{id}/cancel` | `GET`, `POST` | Batch jobs, pinned to the creating upstream account |
| `/v1/models` | `GET` | Lists the pools this gateway key may use |
| `/v1/passthrough/{provider}/*` | any | Injects the healthiest key into raw requests, confined to the provider base URL and the key's pool scope |

### Management API (`/api`)

All `/api/*` routes and `/metrics` require `Authorization: Bearer <KEYGATE_ADMIN_TOKEN>`. The UI
keeps the token in `sessionStorage` and discards it when the tab closes. The contract is generated
from the route schemas and served as OpenAPI 3.1 at `GET /api/openapi.json`.

| Endpoint | Methods | Description |
| :--- | :--- | :--- |
| `/api/providers` | `GET`, `POST` | List and save declarative provider specs |
| `/api/providers/wizard/draft` | `POST` | Draft a provider spec from a cURL command |
| `/api/providers/test` | `POST` | Live test runner showing the mapped request and response |
| `/api/keys` | `GET`, `POST`, `PUT`, `DELETE` | Encrypted upstream keys, health metrics, daily budgets |
| `/api/aliases` | `GET`, `POST`, `DELETE` | Pools: target chain, strategy, endpoint hint, daily caps |
| `/api/pricing` | `GET`, `POST`, `DELETE` | `model_pricing` rows (USD per million tokens) |
| `/api/gateway-keys` | `GET`, `POST`, `DELETE` | Issue and revoke client bearer tokens with rpm/tpm limits and pool scope |
| `/api/logs` | `GET` | Filterable request traces with status, provider, model, endpoint and cost |
| `/api/dashboard/stats` | `GET` | KPIs, spend today, per-pool usage and over-budget keys |

## Provider specs

Providers are configuration, not code. Two working examples ship in [`providers/`](providers):

- [`openai-compatible.yaml`](providers/openai-compatible.yaml) — the fast path for Groq, Together,
  DeepSeek, Mistral and any other OpenAI-compatible API.
- [`anthropic-messages.yaml`](providers/anthropic-messages.yaml) — a deliberately non-standard API,
  showing bidirectional JSONata mapping, streaming chunk remapping and custom error types.

Add your own by writing a YAML spec, or paste a cURL command into the **Add Provider** wizard and
let it draft the spec for you.

## Integrations

KeyGate speaks the OpenAI protocol, so any client that accepts a custom base URL works unchanged.

| Client | Guide |
| :--- | :--- |
| OpenAI SDK (Python / Node) | [docs/integrations.md](docs/integrations.md) |
| LangChain | [docs/integrations.md](docs/integrations.md) |
| Open WebUI | [docs/integrations.md](docs/integrations.md) |
| n8n | [docs/n8n.md](docs/n8n.md) and [`n8n-example.json`](n8n-example.json) |
| Home Assistant | [homeassistant/custom_components/keygate](homeassistant/custom_components/keygate/README.md) |
| cURL / any HTTP client | [docs/integrations.md](docs/integrations.md) |

## Development

### Requirements

- Node.js 20 or newer (CI runs 22; the container image ships 26)
- npm 10 or newer

```bash
# Frontend — builds into backend/public
cd frontend
npm install
npm run build

# Backend — serves the built UI on :3000
cd ../backend
npm install
npm run build
npm start
```

### Checks

```bash
# Backend
cd backend
npm run typecheck   # tsc for src/ and tests/
npm run lint        # oxlint
npm test            # vitest, isolated temp database
npm run test:coverage

# Frontend
cd frontend
npm run lint
npm test            # vitest + Testing Library (jsdom)
npm run build
```

Tests run against a throwaway SQLite database in the OS temp directory, so your local `data/` is
never touched. Both packages gate coverage in `vitest.config.ts`, and CI runs the same checks on
every push and pull request ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

### End-to-end and load testing

Both suites need a **disposable running instance** — they create data and generate real traffic.

```bash
# Playwright: login, tab navigation, gateway-key create/revoke/delete
cd frontend
npm run test:e2e:install
KEYGATE_E2E_URL=http://127.0.0.1:3000 \
KEYGATE_E2E_ADMIN_TOKEN=... \
npm run test:e2e

# k6: SCENARIO=smoke|load|ratelimit|soak
docker run --rm --network host \
  -e BASE_URL=http://127.0.0.1:3000 \
  -e ADMIN_TOKEN=... -e GATEWAY_KEY=kg-live-... -e SCENARIO=soak \
  -v "$PWD/load-tests:/scripts" grafana/k6 run /scripts/keygate.js
```

`429` is a correct response under load because the gateway rate-limits by design. The k6 script
accepts it; run the `ratelimit` scenario to prove the limiter engages, and raise the limits on a
disposable instance when you want raw throughput numbers. Never point either suite at production.

## Security

- **Encrypted at rest** — AES-256-GCM with unique IVs and authenticated tags; keys are masked as
  `prefix...suffix` and never logged.
- **Admin authentication** — `/api/*` and `/metrics` compare the bearer token with
  `crypto.timingSafeEqual`, on the normalized pathname.
- **Pre-auth data plane** — `/v1/*` bearer tokens are checked in an `onRequest` hook before any
  request body is parsed or buffered.
- **Fail-fast secrets** — production refuses to boot with missing, weak or placeholder secrets.
- **Quotas before dispatch** — rpm/tpm slots, pool caps and key budgets are checked before an
  upstream call; violations answer `429 quota_exhausted` with `Retry-After`.
- **Security headers** — strict CSP, `nosniff`, `DENY`, `no-referrer`, COOP/CORP, permissions
  policy and HSTS in production.
- **Passthrough hardening** — allowlisted headers only, traversal rejection (including encoded
  dots), origin pinning and pool-scope enforcement.
- **Scoped routing** — unknown models answer `404 model_not_found` instead of silently falling
  back to the first provider.
- **Retention** — request traces and metrics are pruned after `METRICS_RETENTION_DAYS`; prompt and
  completion history can be disabled with `HISTORY_ENABLED=false`.

For the full threat model and reporting process, see [`SECURITY.md`](SECURITY.md).

## Documentation

| Document | Contents |
| :--- | :--- |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | Development setup, code conventions, pull-request process |
| [`SECURITY.md`](SECURITY.md) | Security architecture, disclosure policy, key rotation |
| [`DECISIONS.md`](DECISIONS.md) | Architecture and engineering decisions |
| [`docs/integrations.md`](docs/integrations.md) | OpenAI SDK, LangChain, Open WebUI and generic clients |
| [`docs/n8n.md`](docs/n8n.md) | n8n workflow setup |
| [`report.md`](report.md) | Security and quality audit, with remediation status |
| [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) | Community expectations |

## Contributing

Contributions are welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first, and follow the
[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).

Found a security issue? **Do not open a public issue** — follow the reporting process in
[`SECURITY.md`](SECURITY.md).

## License

Released under the [MIT License](LICENSE).
