# Integrating KeyGate with n8n

KeyGate exposes a 100% OpenAI-compatible API (`/v1`) that allows n8n to connect using standard **OpenAI Chat Model**, **AI Agent**, and **HTTP Request** nodes while pooling and routing across all your upstream keys with automatic failover and circuit breaker protection.

---

## 1. Quick Setup (OpenAI Chat Model Node)

### Step 1: Create a Gateway Key in KeyGate
1. Open the KeyGate UI at `http://localhost:3000` (or your server IP).
2. Go to the **Gateway Keys** tab.
3. Click **Generate Gateway Key**, give it a name (e.g., `n8n-production`), and copy the secret token (`kg-live-...`).

### Step 2: Configure OpenAI Credential in n8n
1. In your n8n workspace, navigate to **Credentials** &rarr; **Add Credential**.
2. Select **OpenAI API**.
3. Fill in the fields:
   - **API Key**: Paste your KeyGate token (`kg-live-...`).
   - **URL / Base URL**:
     - If n8n runs in Docker on the same Docker network: `http://keygate:3000/v1`
     - If n8n is running in Docker and KeyGate is on the host: `http://host.docker.internal:3000/v1`
     - If n8n and KeyGate are on localhost: `http://localhost:3000/v1`
4. Click **Save**.

### Step 3: Use the OpenAI Chat Model Node
1. Add an **OpenAI Chat Model** node to your n8n canvas (e.g., connected to an **AI Agent** or **Chain**).
2. Select the credential created in Step 2.
3. In the **Model** field, enter any model alias configured in KeyGate (e.g., `gpt-4o` or `default`).
4. Execute the node. KeyGate will dynamically select the healthiest upstream API key, track latency, and transparently handle rate limits.

---

## 2. Using the Generic Passthrough Endpoint (HTTP Request Node)

For non-chat endpoints (e.g., image generation, audio transcription, or custom provider-specific endpoints), KeyGate provides a zero-configuration passthrough router:

```
ANY /v1/passthrough/{provider}/*
```

KeyGate selects the healthiest active key for `{provider}`, injects the required authentication headers or parameters, proxies the raw request directly to upstream, and passes back the upstream response.

### Example: Calling Upstream Image Generation or TTS from n8n
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
6. The request will automatically be dispatched with the healthiest key in your pool.

---

## 3. Importing the Example Workflow

An end-to-end, ready-to-run n8n workflow is included in [`n8n-example.json`](../n8n-example.json).

### How to Import:
1. In n8n, open your workflow canvas.
2. Click the top-right **Options (three dots)** menu &rarr; **Import from File**.
3. Select `n8n-example.json`.
4. Update the OpenAI credential to point to your KeyGate Base URL and Bearer Token.
5. Click **Test Step** or **Execute Workflow**.

---

## 4. Key Benefits for n8n Workflows

- **Zero Workflow Downtime**: If an upstream key runs out of quota or hits an RPM cap, KeyGate instantly falls over to the next healthy key or provider target in milliseconds without terminating the n8n execution.
- **Circuit Breakers**: Flaky providers are isolated automatically, preventing workflows from hanging or timing out.
- **Audit Logging**: View complete traces of tokens used, latencies, and exact upstream providers in the KeyGate **Request Logs** tab.
