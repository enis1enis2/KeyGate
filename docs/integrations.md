# Integrations

KeyGate exposes the standard OpenAI protocol, so any client that lets you override the **base URL** and **API key** works without modification.

| Setting | Value |
| :--- | :--- |
| Base URL | `http://localhost:3000/v1` (or `https://your-host/v1`) |
| API key | A gateway key (`kg-live_...`) from **Gateway Keys** in the UI |
| Admin token | `KEYGATE_ADMIN_TOKEN` — required only for `/api/*` and `/metrics` |

Issue a gateway key in the UI under **Gateway Keys**, or use the token printed on first boot.

---

## OpenAI SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:3000/v1",
    api_key="kg-live_your_gateway_key",
)

resp = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello"}],
)
print(resp.choices[0].message.content)
```

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  baseURL: 'http://localhost:3000/v1',
  apiKey: 'kg-live_your_gateway_key',
});

const resp = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello' }],
});
```

The `model` value is an **AI pool** (the pool's name) configured under *AI Pools* — KeyGate resolves it to a provider and picks the healthiest upstream key.

---

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

---

## Open WebUI

1. **Admin Panel → Settings → Connections → OpenAI Connection**
2. URL: `http://keygate:3000/v1` (use `http://host.docker.internal:3000/v1` if Open WebUI runs in Docker)
3. Key: your `kg-live_...` gateway key

Models from `/v1/models` appear in the model picker automatically.

---

## n8n

See the dedicated guide: [docs/n8n.md](n8n.md), plus the importable [`n8n-example.json`](../n8n-example.json).

---

## cURL

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer kg-live_your_gateway_key" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hello"}]}'
```

### Everything else via passthrough

The common OpenAI surfaces — chat, responses, completions, embeddings, moderations, images, audio, files, batches and models — are exposed natively under `/v1` and go through full pool routing, failover and metering.

Provider-specific endpoints that KeyGate does not expose natively can still be reached through the generic passthrough proxy, which injects an upstream key and strips it from the response:

```bash
curl http://localhost:3000/v1/passthrough/{provider}/{path} \
  -H "Authorization: Bearer kg-live_your_gateway_key" \
  -H "Content-Type: application/json" \
  -d '{...}'
```

Example for an image endpoint on a provider whose id is `openai-compatible`:

```bash
curl http://localhost:3000/v1/passthrough/openai-compatible/images/generations \
  -H "Authorization: Bearer kg-live_your_gateway_key" \
  -H "Content-Type: application/json" \
  -d '{"model":"dall-e-3","prompt":"A cute baby sea otter"}'
```

---

## Available endpoints

| Endpoint | Method | Auth |
| :--- | :--- | :--- |
| `/v1/chat/completions` | `POST` | gateway key |
| `/v1/responses` | `POST` | gateway key |
| `/v1/completions` | `POST` | gateway key |
| `/v1/embeddings` | `POST` | gateway key |
| `/v1/moderations` | `POST` | gateway key |
| `/v1/images/generations`, `/v1/images/edits`, `/v1/images/variations` | `POST` | gateway key |
| `/v1/audio/transcriptions`, `/v1/audio/translations`, `/v1/audio/speech` | `POST` | gateway key |
| `/v1/files`, `/v1/files/:id`, `/v1/files/:id/content` | `GET`, `POST` | gateway key |
| `/v1/batches`, `/v1/batches/:id`, `/v1/batches/:id/cancel` | `GET`, `POST` | gateway key |
| `/v1/models` | `GET` | gateway key |
| `/v1/passthrough/{provider}/*` | `ANY` | gateway key |
| `/healthz` | `GET` | none |
| `/api/*`, `/metrics` | varies | admin token |

---

## Troubleshooting

| Symptom | Cause |
| :--- | :--- |
| `401 invalid_api_key` | Missing/invalid/revoked gateway key, or expired. |
| `403 model_not_allowed` | The gateway key is scoped to other pools than the one requested. |
| `400 missing_required_fields` | The endpoint requires a `model` (pool) in the JSON body. |
| `404` from the model picker | No AI pool configured yet — create one under *AI Pools*. |
| `503` | No healthy upstream key for the resolved provider; check the circuit state in *Dashboard*. |
| CORS error in a browser client | `CORS_ORIGINS` is empty (same-origin only). Add your origin. |
| `429` from KeyGate itself | Gateway rate limit (`RATE_LIMIT_MAX` / `RATE_LIMIT_V1_MAX`), gateway-key rpm/tpm limits, an exhausted pool daily cap, or an over-budget key (`quota_exhausted`), or the upstream key pool is rate-limited. |
