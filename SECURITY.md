# Security Policy

KeyGate is a self-hosted AI API pool gateway that stores encrypted upstream API keys and exposes them to OpenAI-compatible clients. Security is taken seriously.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security problems.**

Please report privately instead:

1. Use GitHub's **private vulnerability reporting** (the repository's **Security → Report a vulnerability** page), or
2. Open a **security advisory** against this repository, or
3. Contact the maintainers directly if you already have a trusted channel.

You will get an acknowledgement within **3 business days**. Critical issues are treated with priority and are handled privately until a fix is shipped.

### What a good report includes

- A minimal, reproducible test case (commands + expected vs. actual output).
- The affected version(s), commit, or Docker image tag.
- The configuration involved (e.g. `KEYGATE_MASTER_KEY`, `CORS_ORIGINS`, `KEYGATE_REQUIRE_AUTH`) and whether it reproduced in a default setup.
- Your assessment of impact (remote unauthenticated? data exposure? DoS?) and any proposed fix, if you have one.

### Secure Submission Guidelines

- **Never include** `KEYGATE_MASTER_KEY`, `KEYGATE_ADMIN_TOKEN`, or any full upstream API keys in your report, logs, screenshots, or commit messages.
- When reproducing, prefer throwaway keys and a temporary database (`KEYGATE_DB_PATH` pointing somewhere outside `data/`).
- Include the exact request-target shape that triggers the issue (raw socket, percent-encoded, absolute-form, etc.), since the router normalizes paths differently from path guards.

## Supported Versions

| Version | Supported |
| :--- | :--- |
| `main` (development) | Yes — bug fixes against latest source |
| Latest tagged release | Yes |
| Older releases | No — please upgrade |

## Disclosure Policy

- Validated vulnerabilities are fixed on `main` before any public disclosure.
- Once a fix is released, the issue is documented in the release notes and, when applicable, disclosed via a public security advisory with credit if requested.

## Scope

### In scope:

- The KeyGate server (`backend/`), including all `/v1` and `/api/*` routes.
- The management UI (`frontend/`) and its token handling.
- The Docker images produced by `docker-compose.yml` / `Dockerfile`.
- Request path normalization and guard comparison logic.
- Pre-authentication body buffering checks.
- Passthrough path confinement and pool scoping.
- Client-supplied trace-id validation.
- Response security headers and CSP.

### Out of scope:

- Software and services KeyGate merely proxies to (OpenAI, Anthropic, Groq, …).
- Environments where the server is deployed without following the documented environment-security guidance (e.g. missing `KEYGATE_MASTER_KEY`/`KEYGATE_ADMIN_TOKEN`).
- Client-side applications using KeyGate with proper authentication.

## Data Protection Notes

- Upstream API keys are encrypted at rest with **AES-256-GCM** and are never logged or returned in full by the Management API (only masked prefixes/suffixes, e.g. `sk-pro...8f9c`).
- The master key (`KEYGATE_MASTER_KEY`) and admin token (`KEYGATE_ADMIN_TOKEN`) are the crown jewels — never include them in a report, logs, screenshots, or commits.
- When reproducing, prefer throwaway keys and a temporary database (`KEYGATE_DB_PATH` pointing somewhere outside `data/`).
- Gateways running without `KEYGATE_REQUIRE_AUTH=true` or without an admin token are development-only configurations; production deployments must have both set.

## Security Audit History

This project underwent a security audit following the Cloudflare `security-audit-skill` methodology. Key findings and fixes:

1. **Management guard normalization**: Path guards now use `normalizedPathname()` so percent-encoded (`/%61pi/keys`) and absolute-form (`GET http://host/api/keys`) targets are normalized before comparison against the router's view.
2. **Pre-auth data plane**: Gateway bearer token is verified for `/v1/*` in an `onRequest` hook *before* Fastify parses or buffers any request body, preventing unauthenticated callers from driving upload buffering.
3. **Passthrough path confinement**: `/v1/passthrough/:provider/*` resolves its wildcard against the provider `base_url` with `new URL()`, rejects dot segments (literal or percent-encoded) and verifies origin + base-path prefix, preventing escape to other endpoints on the provider host.
4. **Passthrough pool scope**: Keys restricted to specific pools via `allowed_aliases_json` now get 403 `model_not_allowed` outside their pools; previously passthrough skipped this check entirely.
5. **Unknown model names 404**: `resolveTargets()` reports `unresolved` → `404 model_not_found` instead of silently routing via first-active-provider, which would bypass pool daily caps.
6. **Client trace-id validation**: `x-trace-id` accepted when matching `^[A-Za-z0-9._:-]{8,64}$`; `finalizeUsage()` scoped by `gateway_key_id IS ?` so one key's stream cannot rewrite another's metering rows.
7. **Response security headers**: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, and a verified CSP (`script-src 'self'`, `frame-ancestors 'none'`, …) added to every response.
8. **Web-search cache**: Bounded by TTL + 256-entry cap (query cardinality is attacker-influenceable); oldest-first eviction.
9. **Health probe redaction**: `/healthz` no longer echoes driver error text to anonymous callers.
10. **CI integrity**: Actions pinned to full commit SHAs with `permissions: contents: read`; unused `zod` dependency removed.
11. **Hop-by-hop header strip**: Passthrough no longer relays `connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`, `transfer-encoding`, `upgrade` headers upstream.

## Dependency Maintenance

- Regular `npm audit` runs on both `backend/` and `frontend/`.
- Dependabot alerts are reviewed and dependencies updated per the project's release cycle.
- Critical/security patches are released promptly; non-critical updates land in the next minor release.
- `npm audit fix` is run as part of the CI pipeline where safe to do so.

## Recent Dependency Fixes

| Package | Vulnerability | Severity | Fix |
| :--- | :--- | :--- | :--- |
| `@vitest/mocker` | GHSA-qxg6-89mg-rqv8 (code injection via unauthenticated manual mock registration) | moderate | Updated to `^4.1.12` |
| `@vitest/mocker` | GHHA-xp26-3454-mjwp (Windows backslash traversal bypass) | moderate | Updated to `^4.1.12` |

(critical and high severity vulnerabilities are blocked from merging via `npm audit` in CI)

---

## Contributing Security Fixes

1. Report vulnerabilities privately via GitHub's private reporting as described above.
2. For non-critical fixes, submit a pull request against `main` with appropriate tests.
3. Ensure `npm audit` passes cleanly after your changes.
4. Update `SECURITY.md` if the fix changes the security posture or adds new guidance.
5. Follow the existing code conventions: `oxlint`, `typescript/no-explicit-any: "error"` in oxlint config, and `vitest` test isolation (temp DB, no production data writes).