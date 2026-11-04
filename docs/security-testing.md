# API security testing with Strix

[Strix](https://github.com/usestrix/strix) runs autonomous agents that enumerate an API, try the
OWASP API Security Top 10 (2023) exploit classes, and write a proof-of-concept request for every
finding. Use it against a **disposable** KeyGate instance that you own — the agents send real
traffic and may create or delete records.

## 1. Prepare the target

1. Start a throwaway instance (never production):

   ```bash
   KEYGATE_MASTER_KEY=$(openssl rand -hex 32) \
   KEYGATE_ADMIN_TOKEN=$(openssl rand -hex 24) \
   KEYGATE_DB_PATH=/tmp/keygate-strix.sqlite \
   NODE_ENV=production node backend/dist/index.js
   ```

2. Create credentials that let the agents test authorization boundaries:

   ```bash
   ADMIN=...   # KEYGATE_ADMIN_TOKEN
   BASE=http://127.0.0.1:3000

   # Wildcard gateway key (every pool) — the "high privilege" data-plane token.
   curl -s -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
     -d '{"name":"strix-wildcard","allowed_aliases":["*"]}' \
     "$BASE/api/gateway-keys"

   # Scope-restricted gateway key — the "low privilege" token. Replace `default`
   # with a pool that exists, or leave it pointing at a non-existent pool to prove
   # that unknown pools are denied.
   curl -s -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
     -d '{"name":"strix-scoped","allowed_aliases":["default"]}' \
     "$BASE/api/gateway-keys"

   # Revoked token: use the returned id.
   curl -s -X POST -H "Authorization: Bearer $ADMIN" \
     "$BASE/api/gateway-keys/<id>/revoke"
   ```

3. Export the live OpenAPI document so Strix starts from the real endpoint list:

   ```bash
   curl -s -H "Authorization: Bearer $ADMIN" "$BASE/api/openapi.json" \
     > audit-artifacts/openapi.json
   ```

## 2. Install Strix

```bash
curl -sSL https://strix.ai/install | bash   # standalone binary (recommended)
# or: uv tool install strix-agent
# or: pipx install strix-agent
strix --version
```

Strix spawns sandbox containers, so Docker (or Podman) must be available to the CLI. If the
machine running Strix has no Docker, run Strix on the Docker host or use the managed cloud
(`strix cloud login`, then `strix cloud scans start --help`).

Set the model and key (use a model your provider supports; see the Strix LLM-provider docs):

```bash
export STRIX_LLM="openrouter/z-ai/glm-5.3"
export LLM_API_KEY="<provider-key>"
```

Keep the key out of shell history and out of the repository.

## 3. Run the scan

Use the instruction block in `audit-artifacts/strix-instructions.md` (created from the template
below) and point Strix at both the spec and the live base URL:

```bash
strix -n \
  -t ./audit-artifacts/openapi.json \
  -t http://127.0.0.1:3000 \
  --instruction-file ./audit-artifacts/strix-instructions.md \
  --max-budget 20
```

`-n` runs non-interactively. `--max-budget` is a spend cap in USD; start small. Reports land in
`strix_runs/<run>/penetration_test_report.md` plus `vulnerabilities/*.md`,
`vulnerabilities.json`, and `findings.sarif`.

## 4. Instruction template

```text
Target: disposable KeyGate instance at <BASE>. Owned by the tester; no third-party data.

Credentials:
- Admin token (management plane /api/*): <ADMIN_TOKEN>
- Wildcard gateway key (/v1/*): <WILDCARD_KEY>
- Pool-scoped gateway key (/v1/*): <SCOPED_KEY>, allowed pool "default"
- Revoked gateway key: <REVOKED_KEY>

Focus, mapped to OWASP API Security Top 10 (2023):
- API1 BOLA / broken object-level authorization: use the scoped key against
  /v1/chat/completions, /v1/models, and /v1/passthrough/<provider>/* for pools and
  providers outside its scope; try path traversal and encoding tricks
  (%2e%2e, %252e%252e, backslashes) through the passthrough route.
- API2 broken authentication: revoked/expired/malformed/duplicated Authorization headers,
  case variations, empty bearer tokens, gateway key used on /api/*.
- API3 broken object property level authorization: mass assignment on POST /api/keys,
  /api/aliases, /api/providers; look for secret fields (api_key_encrypted, token_hash)
  leaked in list responses.
- API4 unrestricted resource consumption: oversized JSON bodies, unbounded pagination,
  streaming endpoints held open, concurrent requests against a key with RPM/TPM caps.
- API5 broken function-level authorization: gateway key calling admin routes;
  readonly expectations on /api/dashboard/stats vs mutating routes.
- API7 SSRF: provider base_url and the passthrough :provider resolution — try
  internal addresses (127.0.0.1, 169.254.169.254, file://), redirects, and
  host-header tricks.
- API8 security misconfiguration: CORS, security headers, error envelopes leaking
  stack traces or upstream URLs, /metrics exposure.
- API10 unsafe consumption of third-party APIs: malformed upstream responses,
  redirect handling, timeout behavior.

Out of scope: destructive operations on non-disposable data, payment flows, DoS that
would take the host down. Keep request volume moderate; the gateway has a global rate
limit (RATE_LIMIT_MAX, default 300/min).

Deliver: for each finding, the exact request, observed vs expected response, severity,
and the smallest fix (authorization check at the object/pool boundary, not the single route).
```

## 5. Verify and re-test

Replay each proof-of-concept with `curl` before treating it as real; authorization findings
must show another tenant's/pool's data, not an empty `200`. Fix the shared check (for KeyGate:
`authorizeGatewayKey` scope, `poolsForProvider`, admin-path guard), then re-run the same scan
and confirm the exploit is gone.

## Notes for this repository

- The audit that prompted these tests is in `report.md`; H-1 (passthrough scope bypass) is the
  highest-value area for the agents.
- `backend/tests/validation.test.ts` already covers traversal, scope denial, and unauthenticated
  admin writes at the route level. Strix adds independent, black-box confirmation.
- Do not commit tokens, `audit-artifacts/`, or `strix_runs/`; they are gitignored.
