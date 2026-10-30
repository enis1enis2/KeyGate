# Integrations

KeyGate exposes the standard OpenAI protocol, so any client that lets you override
the **base URL** and **API key** works without modification. This page collects
the most common integration patterns.

## Quick Start

| Client | Base URL | API Key | Notes |
| :--- | :--- | :--- | :--- |
| **OpenAI Python SDK** | `http://localhost:3000/v1` | `kg-live_...` | `pip install openai` |
| **OpenAI Node SDK** | `http://localhost:3000/v1` | `kg-live_...` | `npm i openai` |
| **LangChain** | `http://localhost:3000/v1` | `kg-live_...` | `langchain-openai` |
| **Open WebUI** | `http://host.docker.internal:3000/v1` | `kg-live_...` | Docker networking note below |
| **n8n** | `http://keygate:3000/v1` or `http://host.docker.internal:3000/v1` | `kg-live_...` | See dedicated n8n guide |
| **cURL / any HTTP client** | `http://localhost:3000/v1` | `kg-live_...` | `-H "Authorization: Bearer ..."` |

## OpenAI SDK (Python / Node)

### Python

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="kg-live_your_gateway_key",
)

resp = client.chat.completions.create(
    model="gpt-4o",  # or any AI pool name configured in KeyGate
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)
```

### Node.js / TypeScript

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:3000/v1',
  apiKey: 'kg-live_your_gateway_key',
});

const resp = await client.chat.completions.create({
  model: 'gpt-4o',  // AI pool name
  messages: [{ role: 'user', content: 'Hello' }],
});
```

> The `model` value is an **AI pool** (the pool's name as configured under
> **AI Pools** in the UI). KeyGate resolves it to a provider and picks the
> healthiest upstream key. If you omit `model`, KeyGate uses the pool named
> `default` if configured, otherwise the first active pool.

## LangChain

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    base_url="http://localhost:3000/v1",
    api_key="kg-live_your_gateway_key",
    model="gpt-4o",
)
print(llm.invoke("Hello").content)
```

## Open WebUI

1. **Admin Panel → Settings → Connections → OpenAI Connection**
2. **URL**: `http://localhost:3000/v1` (development) or
   `http://host.docker.internal:3000/v1` (Docker-on-host networking)
3. **Key**: your `kg-live_...` gateway key
4. Save.

> **Docker networking note**: If both Open WebUI and KeyGate run in Docker on
> the same network, use `http://keygate:3000/v1`. If KeyGate is on the host
> and Open WebUI in Docker, use `http://host.docker.internal:3000/v1` so the
> container can reach the host's localhost.

## n8n

See the dedicated guide: [docs/n8n.md](n8n.md).

## cURL

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer kg-live_your_gateway_key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello"}]}'
```

## Everything else via passthrough

The common OpenAI surfaces — chat, responses, completions, embeddings,
moderations, images, audio, files, batches and models — are exposed natively
under `/v1` and go through full pool routing, failover and metering.

Provider-specific endpoints that KeyGate does not expose natively can still be
reached through the generic passthrough proxy, which injects an upstream key and
strips it from the response:

```bash
curl http://localhost:3000/v1/passthrough/openai-compatible/images/generations \
  -H "Authorization: Bearer kg-live_your_gateway_key" \
  -H "Content-Type: application/json" \
  -d '{"model":"dall-e-3","prompt":"A cute baby sea otter"}'
```

Example for an image endpoint on a provider whose id is `openai-compatible`.

## Available endpoints (full table)

| Endpoint | Method | Auth | Notes |
| :--- | :--- | :--- | :--- |
| `/v1/chat/completions` | `POST` | gateway key | Full chat with SSE & non-streaming, failover, hedging |
| `/v1/responses` | `POST` | gateway key | OpenAI Responses API |
| `/v1/completions` | `POST` | gateway key | Legacy text completions (usage backfilled) |
| `/v1/embeddings` | `POST` | gateway key | Embeddings with cost metering |
| `/v1/moderations` | `POST` | gateway key | Content moderation |
| `/v1/images/generations`, `/v1/images/edits`, `/v1/images/variations` | `POST` | gateway key | Multipart re-serialized per attempt |
| `/v1/audio/transcriptions`, `/v1/audio/translations`, `/v1/audio/speech` | `POST` | gateway key | Multipart audio → JSON; speech is binary pass-through |
| `/v1/files`, `/v1/files/:id`, `/v1/files/:id/content` | `GET`, `POST` | gateway key | Pinned to the creating upstream account |
| `/v1/batches`, `/v1/batches/:id`, `/v1/batches/:id/cancel` | `GET`, `POST` | gateway key | Pinned to the creating upstream account |
| `/v1/models` | `GET` | gateway key | Lists the pools this gateway key may use |
| `/v1/passthrough/{provider}/*` | `ANY` | gateway key | Injects the healthiest key into raw requests; confined to provider base URL |
| `/healthz` | `GET` | none | Health probe; redacted error text |
| `/api/*`, `/metrics` | varies | admin token | Management API |

## Troubleshooting

| Symptom | Cause |
| :--- | :--- |
| `401 invalid_api_key` | Missing/invalid/revoked gateway key, or expired. |
| `403 model_not_allowed` | The gateway key is scoped to other pools than the one requested. |
| `400 missing_required_fields` | The endpoint requires a `model` (pool) in the JSON body. |
| `404` from the model picker | No AI pool configured yet — create one under **AI Pools**. |
| `503` | No healthy upstream key for the resolved provider; check the circuit state in **Dashboard**. |
| CORS error in a browser client | `CORS_ORIGINS` is empty (same-origin only). Add your origin. |
| `429` from KeyGate itself | Gateway rate limit (`RATE_LIMIT_MAX` / `RATE_LIMIT_V1_MAX`), gateway-key rpm/tpm limits, an exhausted pool daily cap, or an over-budget key (`quota_exhausted`), or the upstream key pool is rate-limited. |

## Adding a New Integration

If you integrate KeyGate with a framework not documented here, contributions are
welcome! Please:

1. Add a new section following the existing format (Quick Setup, Code sample,
   Troubleshooting).
2. Include the framework version you tested against.
3. Add a note about any quirks (e.g., "requires `CORS_ORIGINS` to be set").
4. Open a PR against `main` — the maintainers will review and merge.