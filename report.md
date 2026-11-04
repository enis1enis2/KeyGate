# KeyGate — Full Repository Audit

**Repository:** `C:\Users\Enis Polat\keygate`
**Commit audited:** `0b9efbe` (`Add free-tier provider presets and support keyless auth`), branch `main`
**Audit date:** 31 Oct – 1 Nov 2026
**Auditor:** Big Pickle (AI coding agent, OpenCode harness)
**Deliverable:** this audit plus the remediation applied to the working tree. Every finding was
fixed or reduced; per-finding evidence is in [§5A](#5a-remediation-status-post-audit).

---

## 1. Executive summary

KeyGate is a self-hosted, OpenAI-compatible AI gateway: a Fastify 5 + SQLite backend with a
declarative YAML provider-mapping engine, health-weighted key pools, circuit breakers, budgets,
metering, a React 19 admin console, and a bundled Home Assistant integration. The architecture is
genuinely good — the two trust boundaries (admin `/api` vs. data-plane `/v1`) are explicit, upstream
credentials are encrypted with AES-256-GCM, every SQL statement is parameterised, and trace IDs flow
end to end.

The problem is not the design, it is the **edge cases around the design**. Four issues are serious
enough to block a multi-tenant or internet-facing deployment:

1. **`/v1/passthrough/*` silently ignores gateway-key pool scoping and all metering.** A key that is
   restricted to one pool reaches every configured provider, any upstream path, and its spend is
   never recorded. *Reproduced live.*
2. **The documented quickstart produces a fully compromised instance.** `cp .env.example .env`
   leaves placeholder secrets that pass the production validation in `config.ts`.
3. **Eight dependency advisories ship in the runtime image**, including **critical Handlebars
   JavaScript-injection** advisories in the template engine that renders provider specs, and an
   unused `zod` with a high-severity memory-exhaustion advisory. CI runs no `npm audit`.
4. **There is no request-body validation anywhere.** Non-numeric quota/budget caps are accepted and
   persisted verbatim, which silently disables rate limiting and spend caps. *Reproduced live.*

Everything else is a mix of hardening gaps (no CSP/security headers, `localStorage` token storage,
header forwarding to third parties, plaintext prompt history), one measured accessibility defect
cluster, real test-coverage holes, and a container that runs as root with a compiler in it.

**Overall score: 6.0 / 10.** A strong single-tenant personal gateway today; roughly two focused
weeks away from being defensible as a shared or internet-facing service.

### What is already good

| Area | Evidence |
|---|---|
| Constant-time admin token comparison | `backend/src/auth.ts:33-37` (SHA-256 + `timingSafeEqual`) |
| Authenticated encryption at rest | `backend/src/crypto.ts:8-32` (AES-256-GCM, random 12-byte IV, auth tag) |
| High-entropy gateway tokens, hashed at rest | `crypto.ts:56-69` (24 random bytes → base64url, SHA-256 stored) |
| No SQL injection found | every query is `prepare(...).all/get/run(...)`; only static identifiers are interpolated (`db/migrations.ts:11-13`) |
| Fail-fast secrets in production | `config.ts:20-31` throws instead of falling back when `NODE_ENV=production` |
| Secrets never returned in full | `crypto.ts:35-50`, `routes/keys.ts:72-76` (masked prefix/suffix only) |
| Test DB isolation | `backend/tests/setup.ts:7-27` (per-worker temp DB, never `data/`) |
| Trace correlation | `x-trace-id` generated/echoed in `routes/chat.ts:161,260,311`, `engine/proxy.ts:594,630`, `routes/passthrough.ts:96` |
| Graceful shutdown + retention cron | `backend/src/index.ts:39-55`, `server.ts:116-136` |
| React output is escaped by construction | no `dangerouslySetInnerHTML`, no `innerHTML`, no `eval` in `frontend/src` |
| Skip link + focus-visible main landmark | `frontend/src/App.tsx:100-113` |

---

## 2. Scorecard

| Dimension | Score | Rationale |
|---|---:|---|
| Security (design) | 6.5 | Sound primitives and boundaries; undermined by the passthrough scope bypass, placeholder secrets, and stale crypto deps. |
| Authorization / multi-tenancy | 4.5 | Pool scoping works on `/v1/chat`, `/v1/embeddings`, `/v1/models`; it does **not** apply to `/v1/passthrough`. |
| Correctness | 7.5 | 82 passing tests, careful failover/hedging logic; a few dead-code and type-coercion defects. |
| API & interface design | 6.0 | Consistent OpenAI envelope on the happy path; no schema validation, two error shapes, no machine-readable contract. |
| Data layer | 7.5 | WAL + `foreign_keys=ON`, parameterised queries, retention cron; schema split across two files, two missing indexes. |
| Test suite | 4.5 | Excellent engine coverage; routes 33.7 %, no frontend tests, no E2E, no coverage gate. |
| Frontend / UX | 6.0 | Clean, responsive, sensible state flow; polling and error handling are rough. |
| Accessibility (WCAG 2.2 AA) | 5.5 | Measured: 3 critical unnamed selects, non-dialog modals, 16 px targets, forced-colors contrast. |
| Performance | 6.5 | Fast cold load (98 kB gz JS); per-request template compilation and 60 req/min/idle-tab polling. |
| Observability | 5.0 | Structured logs + Prometheus + trace IDs; no latency histogram, no failover/retry counters. |
| CI/CD & operations | 5.5 | Lint/typecheck/build/test on every PR; no audit, no coverage gate, no container build, no frontend tests. |
| Containers | 5.0 | Multi-stage and non-root-capable, but runs as root with `python3 make g++` and no `.dockerignore`. |
| Documentation | 6.5 | Unusually complete (`DECISIONS.md`, `BLOCKERS.md`, `docs/`); stale test counts and no OpenAPI contract. |
| **Overall** | **6.0** | Production-ready foundation; not yet production-safe for hostile or multi-tenant traffic. |

---

## 3. Scope and method

### 3.1 In scope

- `backend/` — all TypeScript sources, tests, config, `package.json`.
- `frontend/` — all React/TS sources, build config.
- `homeassistant/custom_components/keygate/` — the bundled HA integration (pre-existing untracked work, read-only).
- `Dockerfile`, `docker-compose.yml`, `.github/workflows/ci.yml`, `.env.example`, `.gitignore`, `providers/*.yaml`.
- Documentation: `README.md`, `SECURITY.md`, `DECISIONS.md`, `BLOCKERS.md`, `docs/n8n.md`, `docs/integrations.md`.

### 3.2 Out of scope / not performed

- Third-party providers themselves (OpenAI, Anthropic, Groq) — only treated as untrusted upstreams.
- Penetration testing with Strix (`api-security-testing` skill requires the Strix CLI, not installed).
- Load/soak testing; all performance numbers are single-request lab measurements.
- Windows-specific path handling beyond what the test suite exercises.
- Runtime test of the Home Assistant integration inside a real HA instance (static review + API contract only).

> **Post-audit update:** the last three were completed after the audit against real hardware — see
> the live-verification table in [§5A](#5a-remediation-status-post-audit). Strix remains pending an
> LLM provider key; the runbook is in [`docs/security-testing.md`](docs/security-testing.md).

### 3.3 Skills applied

`planning-with-files`, `security-review`, `security-threat-model`, `codebase-design`,
`fastify-best-practices`, `api-and-interface-design`, `database-migrations`, `sql-optimization`,
`accessibility`, `performance`, `vercel-react-best-practices`, `web-design-guidelines`,
`observability-and-instrumentation`, `ci-cd-and-automation`, `multi-stage-dockerfile`, `vitest`,
`documentation-writer`, `verification-before-completion`.

Every finding below was cross-checked three ways where possible: reading the code, grepping for the
absence of a control, and exercising the running product.

### 3.4 Live verification environment

A production build (`backend/dist` + `backend/public`) was started on `127.0.0.1:3100` with a
throwaway database (`%TEMP%\keygate-audit\keygate.sqlite`), `NODE_ENV=production`, and throwaway
secrets. The server was stopped afterwards and the DB left outside the repo.

The post-audit verification in §5A was extended to real hardware: a disposable KeyGate container
built on a Raspberry Pi 5 running HAOS 2026.10.4 (aarch64, Docker 29.8.2), plus a second disposable
Home Assistant container for the integration flow. Both used fresh volumes and generated secrets;
no user data or production instance was touched.

---

## 4. Architecture and trust boundaries

```
                      ┌──────────────────────────────┐
  Admin browser ─────▶│ /api/*  + /metrics           │  Bearer KEYGATE_ADMIN_TOKEN
  (localStorage       │  onRequest hook (server.ts:58)│  constant-time compare
   admin token)       └─────────────┬────────────────┘
                                    │  full CRUD
                      ┌─────────────▼────────────────┐
                      │  SQLite (WAL)                │  upstream keys: AES-256-GCM
                      │  providers / keys / aliases  │  gateway tokens: SHA-256
                      │  logs / history / pricing    │
                      └─────────────┬────────────────┘
                                    │
  SDK / n8n / HA ────▶┌─────────────▼────────────────┐
  (kg-live-… token)   │ /v1/*                        │  Bearer gateway token
                      │  chat / embeddings / models  │  + pool scope + rpm/tpm
                      │  responses / images / audio  │
                      │  /v1/passthrough/:provider/* │  ◀── scope NOT enforced
                      └─────────────┬────────────────┘
                                    │
                      ┌─────────────▼────────────────┐
                      │ third-party upstreams        │  untrusted
                      └──────────────────────────────┘
```

Two trust boundaries exist and are documented in code (`auth.ts:164-166`). The audit's highest
severity finding is precisely where the second boundary is assumed but not applied.

---

## 5. Findings

Severity scale: **Critical** = trivially exploitable, catastrophic, no preconditions.
**High** = exploitable by a realistic actor or guaranteed to cause serious harm.
**Medium** = material weakness requiring a precondition or chained issue.
**Low** = hardening, maintainability, or defence-in-depth.

Summary: **0 Critical · 4 High · 12 Medium · 12 Low.**

---

### HIGH

---

#### H-1 — `/v1/passthrough/*` bypasses gateway-key pool scope and all metering

**Area:** Authorization · **Files:** `backend/src/routes/passthrough.ts`, `backend/src/auth.ts`

**Evidence**

```ts
// backend/src/routes/passthrough.ts:13
fastify.all('/v1/passthrough/:provider/*', { ... }, async (request, reply) => {
  // :16-18 — "No pool alias to scope against here"
  const auth = authorizeGatewayKey(request);   // ← no { alias } argument
```

`authorizeGatewayKey` only enforces pool scope when an alias is supplied:

```ts
// backend/src/auth.ts:104
if (opts?.alias && !isAliasAllowed(key, opts.alias)) { ... }
```

Consequences, all confirmed by reading the file end to end:

1. **No scope check.** `allowed_aliases_json` is never consulted, so a key minted for `["default"]`
   can reach `anthropic-messages`, or any other provider, at any path.
2. **No metering.** The file never imports `RequestLogRepo`; there is no `insert`, no pricing lookup,
   no `assertPoolBudget`. Spend from passthrough is invisible in dashboards, `/metrics`, and budgets.
3. **No upstream timeout.** `await fetch(authed.url, fetchOpts)` (`:80`) has no `signal`; unlike
   `proxy.ts:397` and `router.ts:239-240`, there is no `AbortController`.
4. **Raw path passthrough.** `targetUrl` is `base_url + '/' + wildcard` (`:53`), so any method
   (`fastify.all`) and any upstream path is reachable.
5. **Internal error text leak.** `:118` returns `errorMessage(err)` verbatim to the client.

**Live reproduction**

A gateway key created with `allowed_aliases: ["default"]`:

| Request | Result |
|---|---|
| `POST /v1/chat/completions` `{"model":"gpt-4o"}` | **403** `model_not_allowed` ✅ scope enforced |
| `POST /v1/passthrough/anthropic-messages/v1/messages` | **503** `No healthy active keys available for provider 'anthropic-messages'` ❌ authorized, provider looked up, dispatch attempted |
| `GET /v1/passthrough/nonexistent-provider/whatever` | **404** `Provider 'nonexistent-provider' not found` ❌ authorization passed first |

The 503/404 (rather than 403) proves the request cleared authorization *and* scope.

**Impact.** Any holder of a scoped gateway key — the exact credential designed to be handed to
untrusted clients, n8n workflows, and HA automations — can use the gateway as an open egress proxy
to every configured provider, with no budget ceiling that anyone can observe, and can pin a
connection open indefinitely.

**Remediation**

1. Resolve the requested provider to its pools and call
   `authorizeGatewayKey(request, { alias })` per resolved pool; if the provider is not part of any
   pool, require an explicit `allowed_providers_json` permission on the key (default deny).
2. Wrap the upstream call in `AbortController` with `CONFIG.defaultTimeoutMs`, and stream with the
   same body-phase deadline used in `engine/proxy.ts:289-347`.
3. Insert a `request_logs` row for passthrough (`endpoint: 'passthrough'`, provider, key, latency,
   status), run pricing/cost, and apply `assertPoolBudget` when a pool applies.
4. Reject path segments equal to `..` and refuse absolute `wildcard` values.
5. Return a fixed message on upstream failure; log the detail.

**Acceptance criteria.** A key scoped to `["default"]` receives `403 model_not_allowed` for
`/v1/passthrough/<any-other-provider>/*`; every passthrough call produces a request-log row with a
non-zero `latency_ms`; a hung upstream is aborted at `DEFAULT_TIMEOUT_MS`.

---

#### H-2 — `.env.example` placeholder secrets pass production validation

**Area:** Deployment security · **Files:** `.env.example`, `backend/src/config.ts`, `README.md`

**Evidence**

```ini
# .env.example:9,12
KEYGATE_MASTER_KEY=generate_a_random_32_character_or_hex_string_here_12345
KEYGATE_ADMIN_TOKEN=generate_a_random_admin_token_here_12345
```

```ts
// backend/src/config.ts:34-36
if (raw.length < MIN_SECRET_LENGTH) { throw ... }   // MIN_SECRET_LENGTH = 16
```

Both placeholders are longer than 16 characters, so they pass. The README instructs operators to
copy the file verbatim:

```bash
# README.md:41
cp .env.example .env
```

`docker-compose.yml:15-17` only requires the variables to be non-empty
(`${KEYGATE_MASTER_KEY:?...}`), so a Compose deployment with a copied `.env` boots happily with
publicly known secrets.

**Impact.** For any instance deployed by following the quickstart:

- the admin token is in the public repository → full control of `/api/*` (create keys, read logs,
  read chat history, issue gateway tokens) and `/metrics`;
- the master key is public → every stored upstream API key can be decrypted offline from
  `data/keygate.sqlite`;
- the two combine into complete takeover of every provider account and every prompt ever stored.

This is the single most likely real-world compromise path for this project, because it requires no
attacker cleverness — only that the operator did what the documentation says.

**Remediation**

1. Ship `.env.example` with **empty** values and comments, not plausible-looking ones.
2. Reject known placeholder substrings (`generate_a_random`, `changeme`, `example`, `dev_only`) and
   enforce minimum entropy in `requireSecret`.
3. Add a Compose pre-flight guard that refuses to start when the admin token equals any value in a
   blocklist.
4. Change the README to generate secrets inline:
   `KEYGATE_ADMIN_TOKEN=$(openssl rand -hex 32)`, `KEYGATE_MASTER_KEY=$(openssl rand -hex 32)`.
5. Add a startup warning when the token looks low-entropy (e.g. `< 20` distinct characters).

**Acceptance criteria.** `cp .env.example .env && docker compose up` fails fast with an explicit
"placeholder secret detected" message.

---

#### H-3 — Eight dependency advisories, including critical Handlebars injection, with no CI audit gate

**Area:** Supply chain · **Files:** `backend/package.json`, `.github/workflows/ci.yml`

**Evidence** (`npm audit --omit=dev`, backend):

| Package | Severity | Advisory | Fix |
|---|---|---|---|
| `handlebars` 4.7.9 | **critical** | GHSA-8r5x-fm3f-whwj (JS injection via AST type confusion), GHSA-p8wg-vrv2-v86f (own-property bypass); plus moderate GHSA-xw65-4hp5-5hc7 | 4.7.10 |
| `zod` 4.6.5 | **high** | GHSA-mrhx-c7xc-m3w5 (memory exhaustion on oversized constrained collections) | ≥ 4.6.6 |
| `@fastify/static` 10.1.5 | moderate | via `glob`/`minimatch` | override `glob ≥ 11` |
| `fast-uri`, `glob`, `minimatch`, `ip-address` | moderate | transitive | bump parents |
| `fastify` 5.12.5 | low | GHSA-389g-gv7q-r4x8 (header validation bypass) | 5.12.7 |

`handlebars` is not decorative — it is the mapping engine that renders **provider-authored**
templates on every request:

```ts
// backend/src/engine/mapper.ts:1,12-15,165-167,259-261,365-366
import Handlebars from 'handlebars';
const templateFn = Handlebars.compile(mapping.template);
```

`zod` is imported **nowhere** in `backend/src` (verified by grep) — it is pure attack surface.

CI runs typecheck, lint, build, test and nothing else:

```yaml
# .github/workflows/ci.yml:22-26
- run: npm ci
- run: npm run typecheck
- run: npm run lint
- run: npm run build
- run: npm test
```

**Impact.** The Handlebars advisories require attacker-influenced template input. The realistic
vector is not the admin (who already owns the box) but a **shared or pasted provider spec**: the
product's headline feature is "paste a cURL command and we draft YAML", and users are expected to
import community provider YAML. A malicious spec becomes arbitrary JavaScript execution inside the
gateway process, with access to `CONFIG.masterKey` in memory. `zod` is a latent memory-exhaustion
vector the day someone starts using it. The missing audit gate means the next advisory lands
silently.

**Remediation**

1. `npm i handlebars@^4.7.10` (or replace Handlebars with a fixed, non-`eval` renderer — the mapper
   already supports JSONata).
2. `npm uninstall zod` (zero imports).
3. `npm i fastify@^5.12.7`; add `"overrides": { "glob": "^11" }` for the `@fastify/static` chain.
4. Add to CI: `npm audit --omit=dev --audit-level=high` and a `dependabot.yml` (npm, weekly).
5. Treat provider YAML import as untrusted input: validate the spec against a JSON Schema before
   persisting, and refuse `handlebars` templates containing `{{#with}}`/helper calls if the engine
   cannot be made safe.

**Acceptance criteria.** `npm audit --omit=dev` reports 0 high/critical; CI fails a PR that
introduces one.

---

#### H-4 — No request validation: non-numeric caps silently disable quotas and budgets

**Area:** Input validation · **Files:** all of `backend/src/routes/*`, `backend/src/db/index.ts`

**Evidence.** No route declares a Fastify `schema` — verified by grepping `routes/` for `schema:`:
zero matches. Bodies are cast, not validated:

```ts
// backend/src/routes/keys.ts:35-42
const body = request.body as { provider_id: string; key_name: string; api_key: string;
  rpm_cap?: number; tpm_cap?: number; daily_budget_cap?: number; };
// :67-69
rpm_cap: body.rpm_cap || 0,
tpm_cap: body.tpm_cap || 0,
daily_budget_cap: body.daily_budget_cap || 0,
```

Quota enforcement compares with `>`:

```ts
// backend/src/engine/gateway-quota.ts:39-40
if (key.rpm_limit > 0 && b.requests >= key.rpm_limit) return 'rpm_limit_exceeded';
```

**Live reproduction.** `POST /api/keys` with `rpm_cap:"abc"`, `tpm_cap:"xyz"`,
`daily_budget_cap:"nope"` → **200 OK**, and `GET /api/keys` returns:

```json
{"rpm_cap":"abc","tpm_cap":"xyz","daily_budget_cap":"nope"}
```

SQLite's dynamic typing stores the strings as TEXT in `INTEGER`/`REAL` columns. In JavaScript
`"abc" > 0` is `false`, so **the limit is silently treated as "unlimited"**. The UI then renders
`abc` as a cap.

The same class of defect exists in `gateway-keys.ts:26-45` (`rpm_limit`, `tpm_limit`,
`allowed_aliases`), `aliases.ts:49-60` (`timeout_ms`, `daily_token_cap`, `daily_spend_cap`,
`tiers_json`), and `providers.ts:34-60` (`base_url`, `spec_yaml`). `pricing.ts` is the only route
that validates numerically, which shows the pattern was known but not applied.

**Impact.** A typo, a stringified form value from an external automation, or a malicious admin-adjacent
caller can remove the spend ceiling from a key without any error and without any visible signal
except a string in the table. This is a budget-control bypass with a one-character trigger.

**Remediation**

1. Declare JSON Schema on every route (`body`, `params`, `querystring`) with
   `type: 'integer' | 'number'`, `minimum: 0`, `additionalProperties: false`; enable
   `ajv: { customOptions: { coerceTypes: true } }` if string-form input must be accepted.
2. Replace `body.x || 0` with explicit coercion (`Number.isFinite` + `Math.trunc`, reject otherwise).
3. Add DB-level guards: `CHECK (rpm_cap >= 0)` on `api_keys` and `gateway_keys` (requires a table
   rebuild migration on SQLite — see `database-migrations` expand/contract pattern).
4. Add a regression test: posting a string cap must return `400`.

**Acceptance criteria.** `POST /api/keys` with `rpm_cap:"abc"` returns `400` with a field-level
message; a schema exists on 100 % of mutating routes.

---

### MEDIUM

---

#### M-1 — No security headers and no CSP on any response

**Evidence.** Measured response headers from the live server (production build):

```
index.html : accept-ranges, cache-control, connection, content-length, content-type, etag,
             last-modified, x-ratelimit-*
/healthz   : connection, content-length, content-type, x-ratelimit-*
```

No `Content-Security-Policy`, `X-Content-Type-Options`, `X-Frame-Options`/`frame-ancestors`,
`Referrer-Policy`, `Permissions-Policy`, or `Strict-Transport-Security`. `backend/src/server.ts:28-54`
registers CORS and rate-limit only; `@fastify/helmet` is absent from `package.json`.

**Impact.** The admin console can be framed (clickjacking a "revoke key"/"delete provider" action is
one click), MIME sniffing is unrestricted, and — critically — there is no CSP to blunt an XSS against
the admin token in `localStorage` (see M-2). With no CSP, `alert()`/`confirm()` usage (L-11) and any
future inline script become directly exploitable.

**Remediation.** Register `@fastify/helmet` with an explicit CSP (`default-src 'self'; script-src
'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors
'none'; base-uri 'none'; form-action 'self'`), `hsts` when TLS terminates upstream, and
`referrer-policy: no-referrer`. Add a test asserting the headers on `/` and `/api/*`.

---

#### M-2 — Admin token and gateway key stored in `localStorage`

**Evidence**

```ts
// frontend/src/api.ts:48-54
export function getAdminToken(): string { return localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) ?? ''; }
export function setAdminToken(token: string): void { localStorage.setItem(...); }
```

```ts
// frontend/src/components/PlaygroundTab.tsx:43,291
useState(() => localStorage.getItem(PLAYGROUND_KEY_STORAGE) ?? '')
localStorage.setItem(PLAYGROUND_KEY_STORAGE, e.target.value);
```

**Impact.** `localStorage` is readable by any script on the origin. Combined with M-1 (no CSP) and
the unescaped-by-construction React tree, a single XSS — in this app, a dependency, or a future
feature — exfiltrates the **root admin credential** (which cannot be scoped or expired) and a live
gateway key. The token also survives tab close indefinitely; there is no idle timeout.

**Remediation.** Prefer an `HttpOnly; Secure; SameSite=Strict` cookie session minted by a
`/api/session` endpoint, with CSRF protection and a server-side expiry. If bearer-in-storage must
stay for single-user self-hosting, store it in `sessionStorage`, add a visible "expires when tab
closes" note, and ship the CSP from M-1 in the same release.

---

#### M-3 — Passthrough forwards client cookies and proxy headers to third-party upstreams

**Evidence**

```ts
// backend/src/routes/passthrough.ts:56-62
for (const [k, v] of Object.entries(request.headers)) {
  const lower = k.toLowerCase();
  if (lower !== 'host' && lower !== 'authorization' && lower !== 'content-length' && v) {
    forwardHeaders[k] = Array.isArray(v) ? v[0]! : v;
  }
}
```

Not excluded: `cookie`, `set-cookie`, `x-forwarded-for`, `x-real-ip`, `forwarded`,
`proxy-authorization`, `cf-connecting-ip`, `x-api-key`, and any custom auth header a client sends.
Response headers are likewise relayed with only four names stripped (`:88-95`), so upstream
`set-cookie` reaches the browser.

**Impact.** A gateway that serves a browser SPA will forward the admin session cookie to
`api.anthropic.com`/`api.groq.com`. Internal topology (`x-forwarded-for`) is disclosed to third
parties. A `set-cookie` from an upstream can overwrite cookies on the gateway origin.

**Remediation.** Replace blacklist with allowlist: forward only `content-type`, `accept`,
`accept-encoding`, `user-agent`, `openai-*`, `anthropic-*` and explicitly configured names.
Strip all `cookie`/`set-cookie`/`forwarded`/`x-forwarded-*`/`x-real-ip`. Do the same on the response
side (allowlist `content-type`, `content-disposition`, `retry-after`, `x-request-id`,
`x-ratelimit-*`).

---

#### M-4 — Chat prompts and completions are persisted in plaintext, always, with no opt-out

**Evidence**

```ts
// backend/src/routes/chat.ts:202-227
ChatHistoryRepo.add({ ... role: 'user', content: args.userMessage ... });
ChatHistoryRepo.add({ ... role: 'assistant', content: args.assistantMessage ... });
```

There is no config flag; the write is unconditional. `db/index.ts:545` caps it at 200 rows per pool
and `server.ts:128` purges after `METRICS_RETENTION_DAYS` (30 by default).

`SECURITY.md:59-60` says only *"Upstream API keys are encrypted at rest"* — which is true, but the
conversation content sitting next to them in the same SQLite file is not encrypted, and nothing tells
the operator that.

**Impact.** In a shared gateway, tenant A's prompts are readable by the admin (expected) and by
anyone who obtains a copy of `data/keygate.sqlite` or a backup (not expected). This is a
data-protection problem (GDPR/confidentiality) more than a technical one, and it is invisible in the
documentation.

**Remediation.** Add `HISTORY_ENABLED=true|false` and `HISTORY_RETENTION_DAYS`; document the
default in `SECURITY.md` under "Data protection notes"; consider storing only metadata
(tokens/model) by default and content only on opt-in; encrypt `chat_history.content` with the same
AES-256-GCM envelope used for upstream keys if it must be kept.

---

#### M-5 — Rate limiting keys on the socket IP; no `trustProxy`

**Evidence**

```ts
// backend/src/server.ts:42
keyGenerator: (request) => request.ip,
```

`Fastify({...})` at `:29-33` sets no `trustProxy`, and `config.ts` exposes no knob for it. Behind
Caddy/nginx/Traefik — the documented deployment shape (`docker-compose.yml:8-9` publishes
`${PORT}:3000`) — every client presents as the proxy's address.

**Impact.** `RATE_LIMIT_MAX=300/min` becomes a **single global budget for the entire internet**, so
one client exhausts it and everyone else receives 429. Conversely, per-client abuse cannot be
isolated. It also makes `authRejections`/`quotaRejections` metrics misleading.

**Remediation.** Add `TRUST_PROXY` (`false | true | <CIDR list>`) and pass it to Fastify, then key
the limiter on the resolved client IP with a fallback to `request.ip`. Document the required value
for each reverse proxy in `docs/`.

---

#### M-6 — `KEYGATE_REQUIRE_AUTH=false` produces a fully open, unattributed proxy

**Evidence**

```ts
// backend/src/auth.ts:53-56
export function authenticateGatewayKey(request: FastifyRequest): AuthResult {
  if (!CONFIG.requireAuth) { return { authenticated: true }; }   // no key, no scope
```

`authorizeGatewayKey` then returns early because `!auth.key` (`:100`), so no scope check and no quota
reservation happen. The mode is documented as "local offline debugging"
(`.env.example:15-17`) and defaulted on (`config.ts:69`), but nothing prevents it in production:
the flag is independent of `NODE_ENV`.

**Impact.** A single flipped environment variable turns the gateway into an unauthenticated proxy
for real paid upstream keys, with no attribution in logs and no budgets. Compose passes it straight
through (`docker-compose.yml:18`).

**Remediation.** Refuse `KEYGATE_REQUIRE_AUTH=false` when `NODE_ENV=production` (fail fast like the
secret check), or gate it behind an explicit `KEYGATE_ALLOW_INSECURE_LOCAL=true` that also forces
`HOST=127.0.0.1`. Log a loud warning on every boot in insecure mode.

---

#### M-7 — Idle-tab polling: 60 requests/min across five endpoints, overlapping, silent on failure

**Evidence**

```ts
// frontend/src/App.tsx:46-52, 80-92
return Promise.all([
  fetchStats().catch(() => null), fetchProviders().catch(() => []),
  fetchKeys().catch(() => []), fetchAliases().catch(() => []), fetchGatewayKeys().catch(() => []),
])
...
const interval = setInterval(loadData, 5000);
```

Measured against the running build with seed data:

| Endpoint | Bytes |
|---|---:|
| `/api/dashboard/stats` | 321 |
| `/api/providers` | 4 381 |
| `/api/keys` | 2 |
| `/api/aliases` | 1 679 |
| `/api/gateway-keys` | 206 |
| **per cycle** | **6 589** |

→ **60 requests/min and ~79 kB/min per open admin tab**, growing linearly with provider count
because each provider's full YAML spec is re-downloaded every 5 s.

Two behavioural defects ride along:

- `setInterval` does not wait for the previous cycle. A `/api/providers` call slower than 5 s stacks
  requests without bound (a browser tab left open during a slow DB easily reaches hundreds of
  in-flight requests; 250 resource entries accumulated during this audit's short interaction).
- Every individual rejection is swallowed (`.catch(() => null)`), and the outer `catch` only
  `console.error`s. The UI keeps showing stale data with no indicator.

**Remediation.** Poll only the visible tab; use 15–30 s for `/api/providers` (or ETag/`If-None-Match`);
replace `setInterval` with a self-scheduling `setTimeout` after the previous cycle settles; surface a
non-blocking "last updated / reconnecting" state; abort in-flight requests on unmount with
`AbortController`.

---

#### M-8 — Accessibility: unnamed selects, non-dialog modals, undersized targets

**Method.** Built production bundle, real Chromium via the accessibility scanner: axe matrix at
baseline/mobile/desktop/forced-colors/reduced-motion/zoom-200, plus a 45-step keyboard audit.

**Measured results**

| Page / state | Rule | Impact | Nodes |
|---|---|---|---:|
| Request Logs | `select-name` | **critical** | 3 |
| Gateway key modal | `target-size` (WCAG 2.2 SC 2.5.8) | serious | 3 |
| Dashboard (all viewports) | — | — | 0 |
| Forced-colors (all pages) | `color-contrast` | serious | 4–8 |

Accessible-tree evidence for the Logs tab — three comboboxes with no name:

```
- generic: "Status Filter:"   → combobox  (no accessible name)
- generic: "Provider:"        → combobox  (no accessible name)
- generic: "Endpoint:"        → combobox  (no accessible name)
```

Source cause:

```tsx
// frontend/src/components/LogsTab.tsx:96-97,109-110,123-124
<label className="block ...">Status Filter:</label>
<select className="...">          // no id, no htmlFor, no aria-label
```

Modal semantics are absent even though the overlay is a real modal:

```tsx
// frontend/src/components/GatewayKeysTab.tsx:214,248 ; KeysTab.tsx:189
<div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
```

Live checks with the key modal open: `document.querySelectorAll('[role=dialog]').length === 0`,
`[aria-modal=true] === 0`, and pressing **Escape leaves the modal open**. The overlay also intercepts
pointer events for the whole page (verified: clicking a nav tab timed out because the overlay blocked
it), so an accidental click outside cannot dismiss it.

**Impact.** A screen-reader user cannot tell which of the three filters they are changing; a
keyboard user lands in a modal with no announced role, no Escape, no focus restoration, and no way
back except tabbing to Cancel. WCAG 2.2 AA: 1.3.1, 2.1.1, 2.1.2, 2.4.3, 2.5.8, 4.1.2.

**Remediation**

1. Give every control an accessible name: `id` + `htmlFor`, or `aria-label` on the select
   (`HistoryTab.tsx:117-119` already does this correctly — copy that pattern).
2. Build one `<Modal>` component: `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, initial
   focus on the first field, focus trap, Escape to close, focus restored to the trigger, `inert` on
   the background.
3. Make the checkbox hit area ≥ 24×24 px (`w-6 h-6`, or a padded label).
4. Replace `text-slate-500`/`opacity-60` combos in forced-colors mode with
   `forced-color-adjust`-safe tokens (`text-slate-300` + `border` outline).
5. Add `@axe-core/playwright` with the scan matrix as a CI job so regressions are caught.

---

#### M-9 — No frontend tests, 33.7 % route coverage, no coverage gate

**Evidence.** `npm run test:coverage` (v8):

| Scope | Stmts | Branch | Funcs | Lines |
|---|---:|---:|---:|---:|
| All files | 59.89 | 52.38 | 64.07 | 61.03 |
| `routes/*` | **33.68** | — | — | — |
| `routes/models.ts` | 7.40 | | | |
| `engine/curl-parser.ts` | **0** | | | |
| `db/seed.ts` | **0** | | | |
| `index.ts` | **0** | | | |
| `routes/passthrough.ts` | **3.5** | | | |
| `routes/keys.ts` | 13.5 | | | |
| `routes/gateway-keys.ts` | 21.7 | | | |
| `routes/aliases.ts` | 18.5 | | | |

There are 11 backend test files and **zero** frontend test files; no Playwright/Cypress config exists.
`vitest.config.ts` collects coverage but never enforces it, and CI (`ci.yml:22-26`) runs plain
`npm test`.

Notably, the exact route implicated in H-1 (`passthrough.ts`) sits at 3.5 % — the highest-risk code
is the least tested.

**Impact.** Every finding in this report that is a *behavioural* defect could have been caught by a
route-level test. The absence of frontend tests means the admin credential flow, the 5 s polling,
and the modal behaviour have never been exercised automatically.

**Remediation.**

1. Add `thresholds: { lines: 60, branches: 50, functions: 60, statements: 60 }` now, then ratchet.
2. Write `app.inject()` route tests for auth (401/403/429 per boundary), key CRUD validation, alias
   CRUD, and `/v1/passthrough` scope.
3. Add Vitest + Testing Library for `api.ts` (token handling, 401 broadcast) and the modal component.
4. Add one Playwright smoke spec covering login → create key → create pool → send chat.

---

#### M-10 — Container runs as root and keeps a compiler; no `.dockerignore`

**Evidence**

```dockerfile
# Dockerfile:19-21
FROM node:22-alpine AS runner
RUN apk add --no-cache curl python3 make g++      # build toolchain in the runtime image
```

No `USER` directive anywhere → PID 1 runs as `root`. `npm ci --omit=dev` (`:30`) is executed *in the
runtime stage*, which is why `python3 make g++` is present: `better-sqlite3` has no musl prebuild and
compiles from source.

`.dockerignore` does not exist (verified at repo root). `COPY frontend/ ./` (`:6`) and
`COPY backend/ ./` (`:15`) therefore copy any local `node_modules/`, `dist/`, `data/`, `.env`, or
`*.sqlite` into the build context and into layers.

**Impact.** A compromised gateway process runs as root inside the container; the toolchain it needs
to compile a malicious addon is present; a developer machine with a populated `node_modules` or a
local `.env` produces a differently-built, potentially secret-leaking image; layers are far larger
than necessary.

**Remediation**

```dockerfile
# build better-sqlite3 once, copy it
FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++
COPY backend/package*.json ./ && RUN npm ci
...
FROM node:22-alpine AS runner
RUN apk add --no-cache curl && addgroup -S app && adduser -S app -G app
COPY --from=build /app/backend/node_modules ./node_modules
USER app
```

Add `.dockerignore` (`node_modules`, `dist`, `backend/public`, `data`, `.env*`, `*.sqlite*`,
`coverage`, `.git`, `.planning`, `.playwright-mcp`).

---

#### M-11 — Home Assistant integration: dead pruning code, stale caps, `Bearer None`

**Evidence**

1. **Orphan entities.** `entity.py` defines `hub_device`, `sub_device`, `async_remove_entity`, and
   `async_prune_stale_entities` — and is imported by **nothing**. Each platform re-implements
   `_hub_device`/`_sub_device` locally (`sensor.py:26-56`, `binary_sensor.py:25-55`,
   `button.py:26-56`). The pruning routine (`entity.py:55-79`) therefore never runs, so deleting a
   pool, key, or provider in KeyGate leaves its Home Assistant entities behind permanently.

2. **Stale pool caps.** `sensor.py:140-166` reads `daily_token_cap`/`daily_spend_cap` **once**, at
   entity creation, and closes over the values:

   ```python
   token_cap = pool.get("daily_token_cap") or 0
   spend_cap = pool.get("daily_spend_cap") or 0
   ... "fn": lambda d: _num(token_cap)          # never re-read
   ... return round((usage(d).get("spend") or 0) / spend_cap * 100, 1)
   ```

   Change a pool's cap in the UI and HA keeps reporting the old cap and a wrong utilisation
   percentage until the config entry reloads.

3. **`Bearer None`.** `api.py:149-158` builds the metrics request without the guard used elsewhere:

   ```python
   headers = {"Authorization": f"Bearer {self._admin_token}"}
   ```

   When no admin token is configured (the gateway-key-only setup the config flow allows), this
   sends the literal string `Bearer None`.

**Impact.** Silent data loss/staleness in the user's dashboard — the worst failure mode for a
monitoring integration — plus integration-created garbage in the entity registry that survives
forever.

**Remediation.** Import and use `entity.py` (single source of truth) and call
`async_prune_stale_entities(hass, entry, platform_domain, wanted_unique_ids)` after each entity
sync. Make cap sensors `lambda d: _num(_current_pool(d).get("daily_token_cap"))` so they read the
live coordinator payload. Guard `async_get_metrics` with the same `if not self._admin_token: raise
KeyGateAuthError(...)` used at `api.py:112-115`.

---

#### M-12 — The master key cannot be rotated

**Evidence.** `crypto.ts:8-32` writes `{encrypted, iv, tag}` with no key identifier or version.
`CONFIG.masterKey` is derived once at boot (`config.ts:41-42`). Nothing re-encrypts existing rows.

**Impact.** Rotating `KEYGATE_MASTER_KEY` — a normal response to suspected compromise, and a
requirement under most key-management policies — instantly makes every stored upstream key
undecryptable, taking the gateway down. Operators are effectively locked into one key forever.

**Remediation.** Add a `key_version INTEGER DEFAULT 1` column to `api_keys`, attempt decryption with
the current key then fall back to previous versions listed in `KEYGATE_MASTER_KEY_PREVIOUS`, and
provide an offline re-encrypt command. Document rotation in `SECURITY.md`.

---

### LOW

---

| ID | Finding | Evidence | Remediation |
|---|---|---|---|
| **L-1** | `Authorization` scheme parsing is case-sensitive, so `bearer x` is rejected (§2.1 of RFC 9110 says schemes are case-insensitive). Interop friction with hand-rolled clients, not a vuln. | `auth.ts:25-29` `header.startsWith('Bearer ')` | Lowercase the scheme portion before comparing. |
| **L-2** | Unauthenticated `/healthz` returns the raw database error string and the active key count — internal file paths / SQLite messages leak to anonymous callers. | `routes/health.ts:14-24`; confirmed public because `isManagementPath` only matches `/api` and `/metrics` (`auth.ts:184-187`) | Return `database: "error"`; log the detail. Drop `activeKeys` or gate it. |
| **L-3** | Two error shapes on `/v1`: hand-built `{error:{message,type,param,code}}` vs. Fastify's `{statusCode,error,message}` (malformed JSON, 404, 413). OpenAI SDKs surface the second as a generic APIError. | `errors.ts:63-72` vs. absent `setErrorHandler` (grep: 0 matches) | Register `setErrorHandler` that maps framework errors into the OpenAI envelope on `/v1` paths. |
| **L-4** | Provider templates are compiled on **every** request: `Handlebars.compile` and `jsonata(...)` re-parse the same static template per call. | `mapper.ts:163,166,260,366` | Memoise by `(engine, templateString)` in a bounded `Map`; compile at provider-save time and cache on the spec. |
| **L-5** | Missing indexes on two hot-ish filters: `api_keys(provider_id)` (FK columns are **not** auto-indexed in SQLite) and `chat_history(trace_id)` (used by `getByTrace`). | `schema.ts:19-43,137-153`; queries at `db/index.ts:145,622` | Add `CREATE INDEX IF NOT EXISTS idx_api_keys_provider ON api_keys(provider_id)` and `idx_chat_history_trace ON chat_history(trace_id)` after the 200-row cap makes them cheap. |
| **L-6** | In-memory fixed-window quota allows a 2× burst across the window boundary, and `tpm` is charged only **after** the response, so N concurrent requests can all pass the check. | `gateway-quota.ts:19-42`; `addTokens` called post-response | Document the behaviour, or move to a token bucket / sliding log; reserve an estimated token cost at admission. |
| **L-7** | The canonical schema is split: `schema.ts` creates tables, `migrations.ts` adds 12 columns (`description`, `endpoint_kind`, caps, search, classifier, tiers, `endpoint`, `cost`, `pool_name`). A reader of `schema.ts` sees an incomplete model, and `ModelAliasRepo.upsert` depends on migration ordering. | `schema.ts:45-64` vs `migrations.ts:18-36` | Fold the current columns into `schema.ts` (it is `IF NOT EXISTS`, so fresh DBs get them) and keep migrations only for already-deployed DBs. Add a comment table documenting column provenance. |
| **L-8** | Dead code and misleading names: `hub_device`/`sub_device`/`async_prune_stale_entities` unused; `history.ts:14-15` is a redundant ternary with identical branches; `cryptoRandomSegment()` uses `Math.random()` despite the name. | `entity.py:18-79`; `routes/history.ts:12-15`; `engine/quick-add.ts:365-366` | Delete or wire up the HA helpers (M-11); simplify the ternary; rename to `randomSegment()` or use `crypto.randomBytes` (it feeds primary-key suffixes). |
| **L-9** | Documentation drift: README badge says **63** tests, `BLOCKERS.md:12` says **44**, actual is **82**. No OpenAPI/Swagger document exists; the API contract lives only in README prose. | `README.md:9`, `BLOCKERS.md:12` | Make the badge dynamic (`shields.io/endpoint`) or drop the number; generate an OpenAPI 3.1 doc from Fastify schemas once H-4 adds them. |
| **L-10** | Footer links open `target="_blank"` without `rel="noopener noreferrer"`. Modern browsers imply `noopener`, so this is hygiene rather than a live risk — but it is also caught by `web-design-guidelines`. | `App.tsx:200-202` | Add `rel="noreferrer"`. |
| **L-11** | Admin UX uses blocking `alert()` and `window.confirm()`; neither is styleable, screen-reader-friendly, or consistent with the design system. | `ProvidersTab.tsx:203,209`; `GatewayKeysTab.tsx:61`; `HistoryTab.tsx:94` | Use the Modal/Toast component introduced for M-8, with `role="alertdialog"` for destructive actions. |
| **L-12** | Vite emits content-hashed asset filenames, but `@fastify/static` serves everything with `cache-control: public, max-age=0`, so every page load revalidates the immutable bundle. | measured header; `server.ts:99-102` | `setHeaders` for `/assets/*` → `public, max-age=31536000, immutable`; keep `index.html` at `no-cache`. |

---

## 5A. Remediation status (post-audit)

Every finding was re-checked against the working tree after the fixes. Status legend:
**Fixed** = code changed and covered by the verification suite below; **Fixed (documented)** = the
current behaviour is intentional and documented; **Partial** = the reported risk is reduced but part
of the remediation is still open. No finding remains Partial.

| ID | Finding | Status | Evidence |
|---|---|---|---|
| **H-1** | Passthrough scope bypass / unmetered proxy | **Fixed** | `backend/src/routes/passthrough.ts` now enforces gateway-key pool scope via `poolsForProvider`, rejects traversal (including double-encoded), allowlists request/response headers, re-checks the final origin, applies a request timeout, and writes a `request_logs` row for every call. Regression tests: traversal → `400`/`404`, scoped key → `403`, wildcard → `503`. |
| **H-2** | Placeholder secrets pass production validation | **Fixed** | `backend/src/config.ts` rejects known placeholders, enforces ≥16 chars, fails low-entropy keys in production, supports `KEYGATE_MASTER_KEY_PREVIOUS`, and refuses `KEYGATE_REQUIRE_AUTH=false` in production. `.env.example` leaves secrets empty with `openssl rand -hex 32` guidance; `docker-compose.yml` fails fast with `:?`. |
| **H-3** | Dependency advisories, no audit gate | **Fixed** | `backend/package.json` overrides (`glob`, `minimatch`, `ip-address`, `fast-uri`) plus bumped `fastify`/`handlebars`; unused `zod` removed. `npm audit --omit=dev --audit-level=high` → **0 vulnerabilities** in `backend` and `frontend`. CI runs `test:coverage` and the audit gate; `.github/dependabot.yml` added. |
| **H-4** | No request validation for caps | **Fixed** | `backend/src/routes/schemas.ts` + JSON Schemas in `keys.ts`, `gateway-keys.ts`, `aliases.ts`, `providers.ts`, `pricing.ts`. Tests assert non-numeric/negative caps → `400` and numeric strings are coerced (`tests/validation.test.ts`). |
| **M-1** | Missing security headers / CSP | **Fixed** | `backend/src/server.ts` `onSend` hook emits CSP, `nosniff`, `DENY`, `no-referrer`, COOP/CORP, permissions policy, and HSTS on HTTPS. Test asserts the headers on `/healthz`. |
| **M-2** | Admin token and gateway key in `localStorage` | **Fixed** | `frontend/src/api.ts:48-60` and `PlaygroundTab.tsx` use `sessionStorage`; README updated. |
| **M-3** | Passthrough forwards cookies/proxy headers | **Fixed** | Covered by the H-1 rewrite: only `accept*`, `content-type`, `idempotency-key`, `user-agent` and vendor prefixes are forwarded, and provider auth/static headers are applied last. |
| **M-4** | Unconditional plaintext history | **Fixed** | `recordChatHistory` early-returns unless `CONFIG.historyEnabled`; `HISTORY_ENABLED=false` documented in README/`.env.example`. |
| **M-5** | Rate limiting keys on the socket IP | **Fixed** | `TRUST_PROXY` parsed in `config.ts` and passed to Fastify `trustProxy` in `server.ts`; documented for Traefik/Nginx/Cloudflare deployments. |
| **M-6** | `KEYGATE_REQUIRE_AUTH=false` opens the proxy | **Fixed** | Production startup now throws in `config.ts` when auth is disabled; the variable remains available for local debugging only. |
| **M-7** | Idle-tab polling volume and silent failures | **Fixed** | `frontend/src/App.tsx` polls only visible tabs, self-schedules a 15 s `setTimeout`, aborts on unmount, retries on `online`, and shows stale/`lastUpdated` state with per-endpoint fallbacks. |
| **M-8** | Accessibility of admin UI | **Fixed** | New `Modal.tsx`/`ConfirmDialog.tsx` (`role="dialog"`/`alertdialog`, focus trap, Escape); all seven tabs migrated; labels wired via `htmlFor`/`id`; ≥24 px targets; `role="alert"`/`status` banners; `:focus-visible`, forced-colors and reduced-motion rules in `index.css`. |
| **M-9** | No coverage gate / low route coverage | **Fixed** | Backend: `backend/vitest.config.ts` gates coverage at 55/48/58/56 and `backend/tests/validation.test.ts` adds 11 boundary/auth/header/traversal/scope/OpenAPI tests. Frontend: `frontend/vitest.config.ts` + `src/test/setup.ts` add Vitest/Testing Library with a coverage ratchet; `Modal.test.tsx`, `ConfirmDialog.test.tsx`, and `api.test.ts` cover focus trapping, Escape/backdrop close, focus restoration, inert background, busy/destructive states, `sessionStorage` token handling, bearer headers, and the 401 broadcast (17 tests). CI runs `test:coverage` for both packages. `frontend/e2e/console.spec.ts` adds a Playwright suite that logs in, walks every tab, and creates/revokes/deletes a gateway key through the UI; **3/3 tests pass** against the live arm64 container. |
| **M-10** | Root container with a compiler, no `.dockerignore` | **Fixed** | `Dockerfile` is a four-stage build with a production-deps stage, no compiler/curl in the runner, `USER node`, and a node-based healthcheck; `.dockerignore` added; compose healthcheck updated. **Built and run** on the arm64 HAOS host: `docker build -t keygate:audit` succeeded (322 MB), and the container runs healthy as uid 1000 with `/healthz` reporting `database: "ok"`. The arm64 build needed `python3 make g++` in `backend-builder` because `better-sqlite3` has no musl/arm64 prebuild. |
| **M-11** | HA dead pruning, stale caps, `Bearer None` | **Fixed** | `sensor.py`, `binary_sensor.py`, `button.py` now import `hub_device`/`sub_device`/`async_prune_stale_entities`, track live entity objects, prune deleted items, and include the static `refresh` button in the wanted set. `_pool_metrics` reads caps/strategy/endpoint/timeout from every poll. `api.py:async_get_metrics` raises when no admin token is configured. **Live HA test passed** on HA 2026.10.4 / Python 3.14: a real config flow against the running gateway created an entry that reached `loaded` with **28 entities** and **28 services**, and the error log had no component errors. The live test also found and fixed a `via_device` deprecation (removed in HA 2027.8): `entity.py` now resolves the hub's `via_device_id` through the device registry, and `__init__.py` registers the hub device before the platforms load. |
| **M-12** | Master key cannot be rotated | **Fixed** | `key_version` column + migration, `KEYGATE_MASTER_KEY_PREVIOUS` fallback in `crypto.ts`, and idempotent `backend/src/reencrypt.ts` (`npm run reencrypt` / `reencrypt:prod`). The script verifies each row with the current key (not just `key_version`), so a second rotation still re-encrypts old rows. Rotation procedure documented in README and covered by `tests/crypto-rotation.test.ts`. |
| **L-1** | Case-sensitive `Bearer` scheme | **Fixed** | `readBearerToken` uses `/^Bearer[ \t]+(.+)$/i` (`auth.ts`). |
| **L-2** | `/healthz` leaks DB error details | **Fixed** | `routes/health.ts` logs the error and returns `database: "error"`; details never reach the probe. |
| **L-3** | Two error shapes on `/v1` | **Fixed** | `server.ts` `setErrorHandler` maps framework errors into the OpenAI envelope on `/v1` paths. |
| **L-4** | Templates compiled on every request | **Fixed** | `engine/mapper.ts` has bounded module-level caches for Handlebars and JSONata (`MAX_TEMPLATE_CACHE = 100`). |
| **L-5** | Missing `api_keys(provider_id)` / `chat_history(trace_id)` indexes | **Fixed** | Added to `schema.ts` and to `migrations.ts` for existing databases. |
| **L-6** | Fixed-window quota burst / post-response TPM | **Fixed (documented)** | `engine/gateway-quota.ts` documents the 2× boundary burst and post-response TPM charging; the algorithm is intentionally unchanged. |
| **L-7** | Schema split between `schema.ts` and `migrations.ts` | **Fixed** | `schema.ts` now declares the current columns (`key_version`, `endpoint`, `cost`, `pool_name`, alias extras) and indexes; migrations only alter old databases. |
| **L-8** | Dead code and misleading names | **Fixed** | HA helpers wired up (M-11); `routes/history.ts` ternary simplified; `engine/quick-add.ts` uses `crypto.randomBytes` in a private `randomSegment()`. |
| **L-9** | Doc drift / no OpenAPI document | **Fixed** | README test badge no longer claims a stale count; `BLOCKERS.md` updated; OpenAPI 3.1 served at `GET /api/openapi.json` from route schemas (`@fastify/swagger`, admin auth) and asserted in tests; new env vars documented. |
| **L-10** | Footer links lack `rel` | **Fixed** | `frontend/src/App.tsx` uses `rel="noopener noreferrer"`. |
| **L-11** | Blocking `alert()` / `confirm()` | **Fixed** | Replaced by `Modal`/`ConfirmDialog` across all tabs; no `alert`/`confirm` remains in `frontend/src`. |
| **L-12** | Immutable assets revalidated | **Fixed** | `server.ts` serves `/assets/*` with `public, max-age=31536000, immutable` and keeps `index.html` at `no-cache`. |
| **PA-1** | Rate-limit rejections returned `500 {}` instead of `429` (found during post-audit verification) | **Fixed** | `@fastify/rate-limit` throws whatever `errorResponseBuilder` returns, and the global handler only reads `statusCode`; the builder returned a plain object, so every rejection became a 500 with an empty body and no `Retry-After`. `server.ts:153-157` now returns an `Error` carrying `context.statusCode`; `backend/tests/rate-limit.test.ts` asserts the global `429` envelope, `Retry-After`, and the `/v1` `rate_limit_error` envelope. Proven live: 320-request burst → 300 × `200` + 20 × `429`. |

### Verification run (this working tree)

```
backend  npm run typecheck      -> clean (tsc --noEmit && tsc -p tsconfig.test.json)
backend  npm run lint           -> clean (oxlint src tests, no output)
backend  npm test               -> 16 files passed, 138 tests passed
backend  npm run test:coverage  -> statements 65.07% / branches 55.63% /
                                   functions 70.50% / lines 66.52% (all above the gate)
backend  npm audit --omit=dev --audit-level=high  -> 0 vulnerabilities
frontend npm run lint           -> clean
frontend npm run build          -> tsc -b && vite build; JS 369.97 kB (gzip 100.45 kB),
                                   CSS 47.10 kB (gzip 8.30 kB)
frontend npm run test:coverage  -> 3 files / 17 tests passed; statements 8.17% / branches 5.49% /
                                   functions 7.26% / lines 8.10% (all above the ratchet threshold)
frontend npm audit --omit=dev --audit-level=high  -> 0 vulnerabilities
frontend npm run test:e2e      -> 3/3 Playwright tests passed against the live container
HA       python -m compileall homeassistant/custom_components/keygate -> OK
Docker   docker build -t keygate:audit . -> success, 322 MB (aarch64/musl)
```

### Live verification on real hardware

Run against a disposable KeyGate container on a Raspberry Pi 5 (HAOS 2026.10.4, aarch64,
Docker 29.8.2), reached over SSH. The instance used a fresh data volume and generated secrets,
and was never the user's production data.

| Area | Setup | Result |
|---|---|---|
| Container build | `docker build -t keygate:audit .` on arm64 HAOS | Success, **322 MB**, four-stage build; `USER node` (uid 1000) at runtime |
| Container run | `keygate-audit`, `-p 3000:3000`, mounted SQLite volume | Healthy; `/healthz` → `{"status":"healthy","database":"ok"}` |
| Playwright E2E | `@playwright/test` 1.64.1 / Chromium, `KEYGATE_E2E_URL=http://192.168.1.12:3000` | **3/3 passed** on the final rebuilt image: wrong-token rejection + unlock, every console tab renders, gateway key create → revoke → delete through the UI |
| k6 smoke | k6 v2.3.0 arm64, 1 VU / 15 s | **180/180 checks (100%)**, 0 failed requests, p95 **5.80 ms** |
| k6 load | 10 VUs / 2 m 50 s, instance limits raised for throughput | **8,532 requests, 0 failed (0%)**; 17,064/17,064 checks passed; p95 **4.84 ms**, p99 5.88 ms, max 13.46 ms; **0** 5xx, **0** auth failures |
| k6 soak | 5 VUs / 10 min, instance limits raised for throughput | **17,715 requests, 0 failed**; 35,430/35,430 checks passed; p95 **4.29 ms**, max 18.01 ms. A repeat run sampled RSS every 15 s: 56 MiB → 72 MiB during the first minute, then flat at **71–73 MiB for the remaining 9 minutes**, 71.29 MiB after the run — heap warm-up, not a growth trend |
| Rate limiter | default `RATE_LIMIT_MAX=300`/min, 100 req/s burst | **300 × `200` then 20 × `429`** in a 320-request burst; body `{"error":"Rate limit exceeded: retry in 39 seconds"}`, `Retry-After: 39`, `X-RateLimit-Remaining: 0`. k6 `ratelimit` scenario (100 req/s, 20 s): **6,003 requests**, **5,583 rate-limited (93.00%)**, **0** 5xx / server errors, **0** auth failures, all thresholds passed |
| HA component runtime | HA 2026.10.4 container, live gateway API | Module imports; health/stats/providers/pools/keys/gateway-keys/pricing work; `/metrics` denied without an admin token |
| HA config flow | Disposable HA container + live gateway, real flow submission | Entry reaches `loaded`: **28 entities**, **28 services**, no component errors; only the standard "custom integration not tested" warning. Re-run on a fresh HA instance against the final rebuilt image after the merge: same **28/28** result. |

Reproduce any of these against a disposable instance:

```bash
# Docker image (multi-stage, non-root)
docker build -t keygate:audit .
docker run -d --name keygate-audit -p 3000:3000 \
  -e NODE_ENV=production -e KEYGATE_MASTER_KEY=... -e KEYGATE_ADMIN_TOKEN=... \
  -e KEYGATE_DB_PATH=/data/keygate.sqlite -v keygate-data:/data keygate:audit

# Playwright E2E (mutates the target: creates and deletes one key)
cd frontend && npm run test:e2e:install
KEYGATE_E2E_URL=http://127.0.0.1:3000 KEYGATE_E2E_ADMIN_TOKEN=... npm run test:e2e

# k6: smoke, raw throughput, limiter proof, soak
docker run --rm --network host -e BASE_URL=http://127.0.0.1:3000 \
  -e ADMIN_TOKEN=... -e GATEWAY_KEY=... -e SCENARIO=smoke \
  -v "$PWD/load-tests:/scripts" grafana/k6 run /scripts/keygate.js

# Home Assistant: copy custom_components/keygate into <config>/custom_components,
# restart, then Settings -> Devices & services -> Add integration -> KeyGate
# (url, admin token, optional gateway key).
```

The Strix API pentest is the one run that needs an external credential: set `STRIX_LLM`
and `LLM_API_KEY`, then follow [`docs/security-testing.md`](docs/security-testing.md).

The Playwright run also caught a real accessibility defect that unit tests could not: the gateway-key
form labels were not associated with their inputs, so `getByLabel` could not find them. Fixed in
`frontend/src/components/GatewayKeysTab.tsx` with `htmlFor`/`id` pairs. The E2E suite is destructive
by design (it creates and deletes a key) and is documented as disposable-instance-only.

The k6 run caught a second defect that neither the unit suite nor the audit had exercised: rate-limit
rejections came back as **`500 {}`** rather than `429`, because `@fastify/rate-limit` throws the
builder's return value and the returned plain object had no `statusCode`. The fix is in
`backend/src/server.ts:153-157`, with regression coverage in `backend/tests/rate-limit.test.ts`; the
burst and k6 results above are from the rebuilt image.

**Still not performed:** the Strix API pentest (needs an LLM provider key, see
[`docs/security-testing.md`](docs/security-testing.md)) and end-to-end provider streaming under load
(needs a real upstream or a mock provider; the k6 profile covers the gateway's own endpoints).

---

## 6. Verified baseline at audit time (before fixes)

These are the audit's original measurements, kept for traceability. The post-fix run is in
[§5A](#5a-remediation-status-post-audit); current results were materially better (138 backend +
17 frontend tests, 0 advisories, security headers and validation enforced).

All commands were run in this audit; outputs are the real ones.

### Backend

```
> tsc --noEmit && tsc -p tsconfig.test.json      # clean
> oxlint src tests                               # clean
> vitest run
  Test Files  11 passed (11)
       Tests  82 passed (82)
    Duration  3.94s
```

```
% Coverage report from v8
All files       | 59.89 | 52.38 | 64.07 | 61.03
src             | 67.44 | 64.56 | 70.27 | 67.63
 auth.ts        | 89.65 | 80.39 |   100 | 90.56
 config.ts      |    76 |  62.5 | 85.71 |    76
 crypto.ts      | 96.55 | 66.66 |   100 | 96.55
 index.ts       |     0 |   100 |     0 |     0
```

### Frontend

```
> oxlint                                        # clean
> tsc -b && vite build
  vite v8.3.2  building for production
  1909 modules transformed
  dist/../backend/public/assets/index-*.js   361.96 kB │ gzip: 98.09 kB
  dist/../backend/public/assets/index-*.css   46.17 kB │ gzip:  8.02 kB
```

### Dependencies

```
backend : 8 advisories (1 critical, 1 high, 5 moderate, 1 low)   → see H-3
frontend: 0 advisories
```

### Live product checks

Audit-time results (the ❌ rows are the findings addressed in §5A):

| Check | Result |
|---|---|
| Boot in `NODE_ENV=production` with real secrets | ✅ healthy, DB created and seeded |
| Boot with a missing secret | ✅ throws (fail-fast works) |
| `/healthz` | ✅ 200 `{status:"healthy", database:"ok"}` |
| Admin hook on `/api/*` and `/metrics` | ✅ 401 without bearer |
| Gateway auth on `/v1/*` | ✅ 401 without bearer, 403 outside pool scope |
| Pool scoping on `/v1/chat/completions` | ✅ 403 `model_not_allowed` |
| Pool scoping on `/v1/passthrough/*` | ❌ **not enforced** (H-1) |
| Numeric cap validation | ❌ **not enforced** (H-4) |
| Security headers | ❌ absent (M-1) |
| Dashboard axe scan | ✅ 0 violations (forced-colors: contrast only) |
| Request Logs axe scan | ❌ 3 × `select-name` critical (M-8) |

---

## 7. Remediation roadmap

> **Status:** every item below has been implemented in this working tree; see
> [§5A](#5a-remediation-status-post-audit) for per-finding evidence, the Docker/HA/Playwright/k6
> results, and the two remaining environment-limited caveats (Strix needs an LLM key; provider
> streaming needs a real upstream).

### Release-blocking (do before any shared / internet-facing deployment) — ~3–4 days

1. **H-1** passthrough: scope enforcement, timeout, metering, header allowlist. *(1.5 d)*
2. **H-2** secrets: empty `.env.example`, placeholder detection, README rewrite. *(0.5 d)*
3. **H-3** dependencies: `handlebars` 4.7.10, drop `zod`, `fastify` 5.12.7, `overrides`, CI audit. *(0.5 d)*
4. **H-4** validation: JSON Schema on all mutating routes + coercion + tests. *(1 d)*
5. **M-1** helmet + CSP, in the same release as **M-2** storage change. *(0.5 d)*

### Hardening sprint — ~1 week

6. **M-3** header allowlists (request and response).
7. **M-5** `TRUST_PROXY`; **M-6** refuse insecure auth in production.
8. **M-4** history toggle + docs + optional encryption.
9. **M-8** modal component + accessible names + focus management + axe CI job.
10. **M-7** polling redesign (visible tab only, self-scheduling, abort, error state).
11. **M-10** non-root runtime stage, copy `node_modules` from builder, `.dockerignore`.

### Quality and operations — ~1 week

12. **M-9** coverage thresholds + route tests + Playwright smoke.
13. **M-11** HA integration fixes (import `entity.py`, live caps, auth guard).
14. **M-12** key rotation (`key_version` + previous keys).
15. **L-4** template cache; **L-5** indexes; **L-12** asset caching.
16. **L-3** unified error handler; **L-9** OpenAPI 3.1 from schemas; docs refresh.
17. **L-1/L-2/L-6/L-7/L-8/L-10/L-11** cleanup pass.

---

## 8. Appendix A — Reproduction evidence

### A.1 Passthrough scope bypass

```http
POST /api/gateway-keys
{"name":"audit-scoped","allowed_aliases":["default"],"rpm_limit":0,"tpm_limit":0}
→ 200 {"token":"kg-live_oFq…","masked_token":"kg-live_...w5ua"}
```

```http
POST /v1/chat/completions            Authorization: Bearer kg-live_oFq…
{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}
→ 403 {"error":{"message":"Gateway API key is not permitted to use model 'gpt-4o'.",
                "code":"model_not_allowed"}}
```

```http
POST /v1/passthrough/anthropic-messages/v1/messages   Authorization: Bearer kg-live_oFq…
→ 503 {"error":{"message":"No healthy active keys available for provider 'anthropic-messages'."}}

GET  /v1/passthrough/nonexistent-provider/whatever    Authorization: Bearer kg-live_oFq…
→ 404 {"error":{"message":"Provider 'nonexistent-provider' not found or inactive."}}
```

Same key. Chat path enforces scope; passthrough path does not.

### A.2 Non-numeric caps

```http
POST /api/keys
{"provider_id":"openai-compatible","key_name":"audit-typed-cap","api_key":"sk-audit-fake-key",
 "rpm_cap":"abc","tpm_cap":"xyz","daily_budget_cap":"nope"}
→ 200 {"success":true,"id":"7b44…"}

GET /api/keys
→ [{"rpm_cap":"abc","tpm_cap":"xyz","daily_budget_cap":"nope", ...}]
```

### A.3 Missing security headers

```
GET /            → 200, headers: accept-ranges, cache-control, content-length, content-type,
                            etag, last-modified, x-ratelimit-*
GET /healthz     → 200, headers: content-length, content-type, x-ratelimit-*
(no CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, HSTS)
```

### A.4 Modal semantics

```js
// with the "Generate Gateway Bearer Token" modal open
document.querySelectorAll('[role=dialog]').length   // 0
document.querySelectorAll('[aria-modal=true]').length // 0
// Escape pressed → modalStillOpen: true
// click on nav tab → intercepted by .fixed.inset-0.z-50 overlay
```

### A.5 Polling volume

```js
// App.tsx issues these every 5000 ms
/api/dashboard/stats  321 B
/api/providers      4 381 B   ← full YAML spec per provider
/api/keys               2 B
/api/aliases        1 679 B
/api/gateway-keys     206 B
                    ────────
                    6 589 B / cycle  →  60 req/min, ~79 kB/min per idle tab
```

---

## 9. Appendix B — Audit limitations

- **No dynamic API fuzzing.** The `api-security-testing` skill requires the Strix CLI, which was not
  installed during the audit. Findings were derived from code reading plus targeted live
  reproductions. *(Post-audit: the Strix runbook and a ready-to-run command are in
  `docs/security-testing.md`; execution still needs an LLM provider key.)*
- **No load testing at audit time.** Quota burst-splitting (L-6), polling concurrency (M-7), and
  template-compile cost (L-4) were reasoned from code. *(Post-audit: smoke, load, soak, and a
  rate-limit scenario were run with k6 against the arm64 container — results in §5A.)*
- **No real Home Assistant runtime at audit time.** M-11 was a static review against the HA 2024+
  entity/coordinator API. *(Post-audit: a real config flow on HA 2026.10.4 created a loaded entry
  with 28 entities; the live run also surfaced and fixed a `via_device` deprecation.)*
- **Windows host.** All commands ran on Windows; shell behaviours (line endings, path handling) were
  not exercised on Linux, though CI uses `ubuntu-latest`.
- **Time-boxed.** The 30 remaining frontend components were reviewed by targeted grep for the
  relevant pattern class (a11y, storage, polling, XSS) rather than line-by-line reading; the
  components carrying the most risk (`App`, `api`, `LogsTab`, `HistoryTab`, `GatewayKeysTab`,
  `KeysTab`, `ProvidersTab`, `RoutingTab`, `PlaygroundTab`) were read directly.

---

## 10. Sign-off

The codebase shows a developer who understands the domain: the trust boundaries are named, the
crypto is correct, the failover logic is thoughtful, and the docs are better than most commercial
projects. The gap is that controls are applied **where they were written**, not **at every ingress** —
`/v1/passthrough` is the clearest example, and it is the one an attacker will find first.

Fix H-1 through H-4 and M-1/M-2, and this becomes a gateway I would happily expose to the internet.
Ship it as-is to a shared network and the first person to read the README will own it.
