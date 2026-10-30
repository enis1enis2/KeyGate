# Integrating KeyGate with n8n

KeyGate exposes a 100% OpenAI-compatible API (`/v1`) that allows n8n to connect
using standard **OpenAI Chat Model**, **AI Agent**, and **HTTP Request** nodes while
pooling and routing across all your upstream keys with automatic failover and
circuit breaker protection.

> **Prerequisite**: A running KeyGate instance (see the quick start in the main
> integrations guide). You will need a **gateway key** (`kg-live_...`) from the
> **Gateway Keys** tab in the KeyGate UI.

## 1. Quick Setup (OpenAI Chat Model Node)

### Step 1: Create a Gateway Key in KeyGate

1. Open the KeyGate UI at `http://localhost:3000` (or your server IP).
2. Go to the **Gateway Keys** tab.
3. Click **Generate Gateway Key**, give it a name (e.g. `n8n-production`), and
   copy the secret token (`kg-live-...`).
4. (Optional) Restrict the key to specific pools or apply daily caps if you want
   per-workflow budgeting.

### Step 2: Configure OpenAI Credential in n8n

1. In your n8n workspace, navigate to **Credentials** &rarr; **Add Credential**.
2. Select **OpenAI API**.
3. Fill in the fields:
   - **API Key**: Paste your KeyGate token (`kg-live-...`).
   - **URL / Base URL**:
     - If n8n runs in Docker on the same Docker network as KeyGate:
       `http://keygate:3000/v1`
     - If n8n runs in Docker and KeyGate is on the Docker host:
       `http://host.docker.internal:3000/v1` (reaches the host's localhost)
     - If n8n and KeyGate are both on localhost (no Docker):
       `http://localhost:3000/v1`
4. Click **Save**.

### Step 3: Use the OpenAI Chat Model Node

1. Add an **OpenAI Chat Model** node to your n8n canvas (e.g., connected to an
   **AI Agent** or **Chain**).
2. Select the credential created in Step 2.
3. In the **Model** field, enter any AI pool configured in KeyGate (e.g.
   `gpt-4o`, `default`, or any custom pool name).
4. Execute the node. KeyGate will dynamically select the healthiest upstream API
   key, track latency, and transparently handle rate limits.

> **Why this works**: The OpenAI Chat Model node sends a standard chat completion
> request to the `/v1/chat/completions` endpoint. KeyGate resolves the model name
> to a pool → provider → healthiest key → routes the request. If a key fails or
> exhausts its quota, the circuit breaker isolates it and the next healthy key is
> tried automatically.

## 2. Using the Generic Passthrough Endpoint (HTTP Request Node)

For provider-specific endpoints that KeyGate does not expose natively (e.g. a
specific Groq or Anthropic endpoint), KeyGate provides a zero-configuration
passthrough router:

```
ANY /v1/passthrough/{provider}/*
```

KeyGate selects the healthiest active key for `{provider}`, injects the required
authentication headers or parameters, proxies the raw request directly to upstream,
and passes back the upstream response.

### Example: Calling Upstream Image Generation from n8n

1. Add an **HTTP Request** node in n8n.
2. Set **Method**: `POST`
3. Set **URL**:
   ```
   http://keygate:3000/v1/passthrough/openai-compatible/images/generations
   ```
4. Set **Authentication**: Header Auth or Generic Credential:
   - Header Name: `Authorization`
   - Header Value: `Bearer kg-live-...`
5. Set **Send Body**: `JSON`
   ```json
   {
     "prompt": "A futuristic server room with glowing green status lights",
     "n": 1,
     "size": "1024x1024"
   }
   ```
6. The request will automatically be dispatched with the healthiest key in your
   pool. The upstream response returns directly to n8n.

> **Passthrough confinement**: The `/v1/passthrough/{provider}/*` path is
> confined to the provider's `base_url`. Dot segments (`/..`) and percent-encoded
> traversals (`%2e%2e`) are rejected, preventing escape to other endpoints on the
> provider host.

## 3. Importing the Example Workflow

An end-to-end, ready-to-run n8n workflow is included in
[n8n-example.json](../n8n-example.json).

### How to Import:

1. In n8n, open your workflow canvas.
2. Click the top-right **Options (three dots)** menu &rarr; **Import from File**.
3. Select `n8n-example.json`.
4. Update the OpenAI credential to point to your KeyGate Base URL and Bearer
   Token.
5. Click **Test Step** or **Execute Workflow**.

> **Note**: The example workflow uses a KeyGate gateway key with access to the
> `gpt-4o` pool. If your setup uses a different pool, adjust the model field
> accordingly.

## 4. Key Benefits for n8n Workflows

| Benefit | Description |
| :--- | :--- |
| **Zero Workflow Downtime** | If an upstream key runs out of quota or hits an RPM cap, KeyGate instantly falls over to the next healthy key or provider target in milliseconds without terminating the n8n execution. |
| **Circuit Breakers** | Flaky providers are isolated automatically, preventing workflows from hanging or timing out. |
| **Audit Logging** | View complete traces of tokens used, latencies, and exact upstream providers in the KeyGate **Request Logs** tab. |
| **Automatic Failover** | Circuit-breaker state is per-key; a flaky upstream is isolated while other keys continue serving. |
| **Unified Billing** | All token usage is tracked through KeyGate, giving you a single pane of glass for cost monitoring across all n8n workflows. |

## 5. Advanced: Custom Pool per Workflow

If you want different n8n workflows to use different sets of upstream keys:

1. Create multiple AI pools in KeyGate (e.g. `pool-fast`, `pool-cheap`, `pool-balanced`).
2. Configure each pool with different upstream keys and quota budgets.
3. In n8n, select the appropriate credential and model name for each workflow.

This is useful for partitioning production vs. staging, or for routing cost-sensitive
workflows through a different key bucket.

## 6. Troubleshooting n8n

| Symptom | Cause |
| :--- | :--- |
| `401 invalid_api_key` | Missing/invalid/revoked gateway key, or expired. |
| `403 model_not_allowed` | The gateway key is scoped to a different pool than the model you selected. |
| `429` from KeyGate | Gateway-key rpm/tpm limit, pool daily cap exhausted, or upstream key pool rate-limited. |
| `503` from KeyGate | No healthy upstream key for the resolved provider; circuit breaker may have isolated the key. |
| Timeout / hanging | The upstream key may be flaky; check the circuit state in KeyGate's **Dashboard** and consider adding more keys to the pool. |
| CORS error when n8n runs in a browser | n8n is typically server-side; this is rare. If you see it, set `CORS_ORIGINS` in KeyGate's environment. |
| "No healthy upstream key" | All keys in the pool are either circuit-broken or have exhausted their quota. Add a new key or increase quotas. |