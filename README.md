# KeyGate 🗝️🛡️

> **Self-hosted gateway that pools upstream API keys for arbitrary, mostly non-mainstream providers, routes around failing ones, and exposes ONE OpenAI-compatible API for n8n, plus a modern management UI.**

[![Tests](https://img.shields.io/badge/tests-16%20passed-brightgreen.svg)]()
[![License](https://img.shields.io/badge/license-MIT-blue.svg)]()
[![Fastify](https://img.shields.io/badge/Fastify-v5-black.svg)]()
[![React](https://img.shields.io/badge/React-19-cyan.svg)]()
[![Docker](https://img.shields.io/badge/docker-ready-blue.svg)]()

---

## 🌟 Core Concepts

- **Providers are DATA, not code**: Each upstream provider is defined as a declarative YAML/JSON spec containing endpoints, auth templates, request/response JSONata or Handlebars mappings, streaming chunk translation, and error classification rules.
- **Circuit Breaker & Key Health**: Tracks a rolling 100-call window per key with p50/p95 latencies and rolling success rates. Automatically opens the circuit upon `N` consecutive failures or low success rates, applies exponential backoff, honors upstream `Retry-After`, applies long cooldowns on quota exhaustion, and disables keys on auth failures.
- **Smart Failover & Hedging**: Model aliases define target chains with routing strategies: `weighted-by-health` (default), `round-robin`, or `priority`. Automatically fails over across healthy keys and upstream providers. Optional speculative hedged requests race backup keys to eliminate latency tail spikes.
- **Encrypted at Rest**: Upstream API keys are encrypted using **AES-256-GCM** with a master key from the environment. Raw keys are never logged and never exposed in the UI.
- **Zero-Friction Onboarding**: Paste a cURL command into the **Add Provider Wizard** to auto-draft the YAML spec, then test mappings live before saving.
- **Built for n8n**: Drop KeyGate's Base URL into n8n's standard OpenAI Chat Model node, or use the generic passthrough endpoint for non-chat endpoints.

---

## 🚀 Quick Start with Docker Compose

1. Clone or download the repository:
   ```bash
   git clone <repo-url> keygate
   cd keygate
   ```

2. Copy environment file and configure a master encryption key:
   ```bash
   cp .env.example .env
   # Edit .env and set KEYGATE_MASTER_KEY to a secure 32-byte secret
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

### 3. Run Tests
```bash
cd backend
npm test
```
The test suite includes:
- Unit tests for template mapping, JSONata expressions, and streaming chunk translation
- Unit tests for the sliding window circuit breaker, backoff, and Retry-After
- Unit tests for router strategies (`weighted-by-health`, `round-robin`, `priority`)
- Integration test running an in-process mock non-standard upstream HTTP server with streaming and failover

---

## 📡 API Reference

### OpenAI-Compatible API (`/v1`)
| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/v1/chat/completions` | `POST` | Standard OpenAI chat completions (supports streaming SSE & non-streaming) |
| `/v1/models` | `GET` | Lists configured model aliases and mapped provider models |
| `/v1/embeddings` | `POST` | Forwards embedding requests to healthy upstream provider |
| `/v1/passthrough/{provider}/*` | `ANY` | Injects the healthiest key into raw requests for image, audio, or custom endpoints |

### Management API (`/api`)
| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/providers` | `GET`, `POST` | List and save declarative YAML provider specs |
| `/api/providers/wizard/draft` | `POST` | Auto-drafts provider YAML spec from cURL command |
| `/api/providers/test` | `POST` | Live test runner showing mapped request and response |
| `/api/keys` | `GET`, `POST`, `PUT`, `DELETE` | Encrypted upstream key manager and health metrics |
| `/api/aliases` | `GET`, `POST`, `DELETE` | Model alias routing chain and strategy configuration |
| `/api/gateway-keys` | `GET`, `POST`, `DELETE` | Issue and revoke client Bearer tokens |
| `/api/logs` | `GET` | Filterable request trace logs with snippets |
| `/api/dashboard/stats` | `GET` | Aggregate KPIs and circuit breaker status |

---

## 🧩 Shipped Provider Specs

KeyGate ships with two example provider specs in the `providers/` directory:
1. [`providers/openai-compatible.yaml`](providers/openai-compatible.yaml): Fast-path configuration for OpenAI-compatible providers (Groq, Together, DeepSeek, Mistral).
2. [`providers/anthropic-messages.yaml`](providers/anthropic-messages.yaml): Deliberately non-standard API demonstrating bidirectional JSONata transformation of Anthropic's Messages format, streaming chunk remapping, and custom error types.

---

## 📖 n8n Integration Guide

For full instructions, screenshots, and an importable workflow, see [docs/n8n.md](docs/n8n.md) and [`n8n-example.json`](n8n-example.json).

```
n8n AI Agent / Chat Model
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
- **Data Retention**: Request trace logs and metrics are retained for 30 days and automatically pruned by a background task.
