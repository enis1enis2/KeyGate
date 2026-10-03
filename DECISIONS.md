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
  - Full CORS support enables decoupled development when Vite runs on `:5173`.

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
