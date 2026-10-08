# Security Policy

KeyGate is a gateway that stores encrypted upstream API keys and exposes them to
OpenAI-compatible clients — security is taken seriously.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security problems.**

Please report privately instead:

1. Use GitHub's **private vulnerability reporting** (the repository's
   **Security → Report a vulnerability** page), or
2. Open a **security advisory** against this repository, or
3. Contact the maintainers directly if you already have a trusted channel.

You will get an acknowledgement within **3 business days**. Critical issues are
treated with priority and are handled privately until a fix is shipped.

### What a good report includes

- A minimal, reproducible test case (commands + expected vs. actual output).
- The affected version(s), commit, or Docker image tag.
- The configuration involved (e.g. `KEYGATE_MASTER_KEY`, `CORS_ORIGINS`,
  `KEYGATE_REQUIRE_AUTH`) and whether it reproduced in a default setup.
- Your assessment of impact (remote unauthenticated? data exposure? DoS?) and
  any proposed fix, if you have one.

## Supported Versions

| Version | Supported |
| :--- | :--- |
| `main` (development) | Yes — bug fixes against latest source |
| Latest tagged release | Yes |
| Older releases | No — please upgrade |

## Disclosure Policy

- Validated vulnerabilities are fixed on `main` before any public disclosure.
- Once a fix is released, the issue is documented in the release notes and, when
  applicable, disclosed via a public security advisory with credit if requested.

## Scope

In scope:

- The KeyGate server (`backend/`), including all `/v1` and `/api/*` routes.
- The management UI (`frontend/`) and its token handling.
- The Docker images produced by `docker-compose.yml` / `Dockerfile`.

Out of scope:

- Software and services KeyGate merely proxies to (OpenAI, Anthropic, Groq, …).
- Environments where the server is deployed without following the documented
  environment-security guidance (e.g. missing `KEYGATE_MASTER_KEY`/`KEYGATE_ADMIN_TOKEN`).

## Data protection notes

- Upstream API keys are encrypted at rest with **AES-256-GCM** and are never
  logged or returned in full by the Management API.
- The master key (`KEYGATE_MASTER_KEY`) and admin token (`KEYGATE_ADMIN_TOKEN`)
  are the crown jewels — never include them in a report, logs, screenshots, or
  commits.
- When reproducing, prefer throwaway keys and a temporary database
  (`KEYGATE_DB_PATH` pointing somewhere outside `data/`).