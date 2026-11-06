# Project

## What KeyGate is

KeyGate is a self-hosted AI API gateway. Clients talk to one OpenAI-compatible
endpoint; KeyGate holds the real provider keys, pools them, routes each request
to a healthy one, and records what it cost.

The problem it removes: every provider brings its own key, quota and failure
mode. Without a gateway, every client has to know all of them and every key
rotation is a redeploy of every client.

## Goals

- **One endpoint.** `/v1/chat/completions` (plus embeddings, audio, images and
  passthrough) works with any OpenAI SDK, LangChain, Open WebUI, n8n or agent.
- **Survive a dead key.** Consecutive failures open a circuit, back off, and
  route to a sibling key without dropping the request.
- **Know the spend.** Per-key and per-pool budgets, per-request cost, traces
  retained for `METRICS_RETENTION_DAYS`.
- **Single binary to operate.** One Fastify service, embedded SQLite, no Redis,
  no Postgres, no queue.
- **Safe by default.** Upstream keys encrypted at rest (AES-256-GCM), admin
  routes behind a bearer token, production refuses weak configuration.

## Stack

| Layer | Choice |
| :--- | :--- |
| Runtime | Node.js 20+ (container ships Node 26) |
| Backend | Fastify 5, TypeScript, `better-sqlite3`, `zod` |
| Frontend | React 19, Vite, Tailwind CSS 4, TypeScript |
| Database | SQLite in WAL mode, schema created on boot |
| Crypto | AES-256-GCM with a key derived from `KEYGATE_MASTER_KEY` |
| Tests | Vitest (unit/coverage), Playwright (e2e), k6 (load) |
| Delivery | Docker multi-stage, GitHub Actions CI, GitHub Releases |
| Demo | Real React console in demo mode (`frontend/src/demo/`), published to GitHub Pages |

## Repository structure

```text
backend/            Fastify service
  src/
    index.ts        boot, config validation, graceful shutdown
    server.ts       route registration, /v1 proxy, /api management, /metrics
    auth.ts         admin + gateway token checks, constant-time compares
    crypto.ts       AES-256-GCM envelope for provider keys
    config.ts       env parsing and production guards
    metrics.ts      request traces, aggregates, retention
    reencrypt.ts    master-key rotation job
  tests/            Vitest suites
frontend/           React admin console (builds into backend/public)
  src/demo/         Browser-only mock API + seed data for the Pages demo
demo/               Legacy static demo (kept for reference, no longer deployed)
providers/          Declarative provider specs (YAML)
homeassistant/      Home Assistant custom component
docs/               Integration guides (SDK, n8n)
load-tests/         k6 scenarios
memory-bank/        This operational knowledge base
```

## Runtime shape

- The backend serves the built React console from `backend/public` on `:3000`.
- The console shell is a fixed 256 px left sidebar (grouped Overview / Configure / Access /
  Observe) with a slim sticky top bar. Below 1024 px the sidebar becomes a modal drawer with a
  focus trap and Escape/scrim close. Production and the Pages demo use the same shell.
- `/v1/*` is the data plane, authenticated with `kg-live-…` gateway keys.
- `/api/*` and `/metrics` are the control plane, authenticated with
  `KEYGATE_ADMIN_TOKEN`.
- `/healthz` is unauthenticated and used by Docker and CI.
- SQLite file lives at `KEYGATE_DB_PATH` (default `./data/keygate.sqlite`).

## Core concepts

| Concept | Meaning |
| :--- | :--- |
| Provider | A declarative spec: base URL, auth, request/response transforms |
| Upstream key | A real provider secret, encrypted at rest, with a daily budget |
| Pool | A model name clients request, backed by ordered/weighted targets |
| Target | One (upstream key, model) pair inside a pool, with weight and health |
| Gateway key | A client token scoped to pools, with rpm/tpm limits and spend cap |
| Trace | One request: routing decision, upstream, latency, tokens, cost, status |

## Non-goals

- Multi-tenant billing or invoicing.
- Training, prompt management or evaluation.
- Storing provider keys anywhere except the local SQLite database.

## Where to look first

- Product behaviour: `README.md`
- Architecture decisions: `DECISIONS.md`
- Security model: `SECURITY.md`
- Current audit status: `report.md`
- Operational procedures: `memory-bank/runbook.md`
