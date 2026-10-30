# Contributing to KeyGate

Thanks for considering a contribution! KeyGate is a small, fast-moving project
so a little structure goes a long way. Please read
[`README.md`](README.md) first for the project overview, then follow the
conventions below.

## Table of contents

- [Development setup](#development-setup)
- [What we're looking for](#what-were-looking-for)
- [Code conventions](#code-conventions)
- [Testing](#testing)
- [The provider-spec model](#the-provider-spec-model)
- [Changelog & architecture docs](#changelog--architecture-docs)
- [Pull request process](#pull-request-process)
- [Code of conduct & security](#code-of-conduct--security)

## Development setup

### Prerequisites

- **Node.js >= 20** (recommended: Node 22 LTS)
- **npm >= 10** (or `pnpm`/`yarn` if you prefer)

### 1. Build the frontend (outputs directly to `../backend/public`)

```bash
cd frontend
npm install
npm run build   # tsc -b + vite build → ../backend/public
```

### 2. Install + run the backend (serves the built UI on :3000)

```bash
cd ../backend
npm install
npm run build   # tsc
npm start         # Fastify on http://localhost:3000
```

Open http://localhost:3000 — the management UI prompts for the admin token
(`KEYGATE_ADMIN_TOKEN`; a dev token is auto-seeded with a fresh database).

### Optional: Mock upstream for offline testing

```bash
node backend/mock-dbg.mjs   # runs on port 9712
# Point a provider spec at http://127.0.0.1:9712/v1 and test the full pipeline
```

## What we're looking for

We value contributions that make KeyGate more robust, more complete, or easier
to operate. Specifically we're looking for:

- **Bug fixes with a regression test** — every bugfix must include a test that
  pins down the fix, and the test must pass on the first run against the
  unmodified code.
- **New provider preset YAML specs** for the Add-Provider Wizard — write the YAML
  in `providers/`, follow the shape of `openai-compatible.yaml` or
  `anthropic-messages.yaml`, and update the Live Spec Tester if you extend the
  spec shape.
- **Support for more of the OpenAI API surface** in the shared proxy pipeline
  (`/v1/responses`, `/v1/completions`, `/v1/images/*`, `/v1/audio/*`,
  `/v1/files`, `/v1/batches`) — these all flow through `engine/proxy.ts`
  and `routes/openai-surface.ts`; adding a surface is typically a one-line
  change to the endpoint table.
- **Observability, retention, and security hardening** — circuit-breaker
  tuning, new metricPrometheus labels, log format improvements, CSP tweaks,
  or anything that reduces the audit surface.
- **Documentation and example integrations** — n8n, LangChain, Open WebUI,
  cURL, or any custom agent. Prefer `docs/integrations.md` over code changes
  when possible.
- **Anything that adds a new endpoint, a new provider engine, or changes auth**
  must come with tests and a `DECISIONS.md` entry (see below).

> **Note**: We merge small, focused PRs quickly. Larger changes may be discussed
> as a draft PR or RFC before implementation.

## Code conventions

- **TypeScript everywhere.** No `any`. The frontend lints with
  `oxlint` where `no-explicit-any` is an **error** — respect that.
- **Declarative over imperative in the gateway**: new upstream behavior belongs
  in a provider YAML spec (engines: `openai-compatible`, `jsonata`,
  `handlebars`, `custom_adapter`), not in bespoke route code.
- **Fastify** on the backend; **React + Tailwind** on the frontend. Match the
  surrounding file's style.
- Use the existing patterns: unified error envelopes (`src/errors.ts`),
  masked key output, in-memory sliding-window metrics — don't reinvent them.
- Keep table/models in `backend/src/db/` with schema migrations; never mutate
  `data/` from tests. Always use `ON CONFLICT(id) DO UPDATE` for idempotent
  initialization across test runs and container restarts.
- Commit messages in the imperative mood: "Add per-pool chat history", not
  "Added per-pool chat history".

## Testing

Every change must keep the suite green:

```bash
# backend
npm run typecheck   # tsc for src/ and tests/
npm run lint        # oxlint (src/ and tests/)
npm test            # vitest (isolated temp DB, never touches data/)

# frontend
npm run lint        # oxlint
npm run build       # tsc -b + vite build → ../backend/public
```

### Notes

- Backend tests use an **isolated throwaway SQLite database** in the OS temp
  directory (`backend/tests/setup.ts`) — your local `data/` is never touched.
- Add a test for every bugfix. The suite currently covers:
  - Template mapping, JSONata expressions, and streaming chunk translation
  - Sliding window circuit breaker, backoff, and Retry-Ahead
  - Router strategies (`weighted-by-health`, `round-robin`, `priority`)
  - Quota slots, pool caps, daily budgets, pricing and cost metering
  - The proxy pipeline across the whole `/v1` surface (responses, completions,
    images, audio, files, batches), multipart re-serialization, sticky routes,
    pool scoping, budget blocks and error envelopes
  - Integration test against an in-process mock non-standard upstream HTTP
    server with streaming and failover
- CI runs backend typecheck/lint/test and frontend lint/build on every push and
  PR (`.github/workflows/ci.yml`).

## The provider-spec model

Adding a provider means writing a YAML spec, not code — see
[`providers/openai-compatible.yaml`](providers/openai-compatible.yaml) for the
trivial case and
[`providers/anthropic-messages.yaml`](providers/anthropic-messages.yaml) for the
non-standard case (bidirectional JSONata + streaming remapping).

If you extend the spec shape (new top-level fields):

1. Update the zod schemas in `backend/src/`
2. Update the Live Spec Tester (`routes/openai-surface.ts` test route)
3. Update the provider table in `README.md`
4. Add a DECISIONS.md entry documenting the change

## Changelog & architecture docs

- New behaviors that constrain future direction get an entry in
  [`DECISIONS.md`](DECISIONS.md) (keep the numbering).
- Things we deliberately don't support go in [`BLOCKERS.md`](BLOCKERS.md).
- User-facing changes to integration setup go in
  [`docs/integrations.md`](docs/integrations.md) / `docs/n8n.md`.

## Pull request process

1. **Branch from `main`** — short descriptive branch name
   (`fix/`, `feat/`, `docs/`).
2. **Small, focused commits** — one logical change per commit, descriptive
   message in the imperative mood (e.g. "Add per-pool chat history",
   "Fix timeout header propagation"). Keep secrets out of history.
3. **Run all checks** locally before opening the PR (CI enforces the same set).
4. **PR description**: what changed, why, and how it was tested.
5. After review, prefer **squash-merging** to keep `main` history tidy.

> **Security first**: If your change touches auth, path guards, or the data
> plane, you must also update `SECURITY.md` and add regression tests in
> `backend/tests/security.test.ts` / `backend/tests/security-preauth.test.ts`.

## Code of conduct & security

By contributing you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). If you
find a security issue, **do not open a public issue** — follow
[`SECURITY.md`](SECURITY.md).

All contributors must read and abide by the Code of Conduct. Community leaders
enforce it consistently; see the "Enforcement" section of `CODE_OF_CONDUCT.md`
for the escalation ladder.

--- 

# Development Quickstart (condensed)

```bash
# From repo root
cd frontend && npm install && npm run build    # → ../backend/public
cd ../backend && npm install && npm run build && npm start
# Visit http://localhost:3000, enter KEYGATE_ADMIN_TOKEN
```

# Dependency Maintenance

- Run `npm audit` on both `backend/` and `frontend/` before committing.
- Dependabot alerts are reviewed per the project release cycle.
- Critical/security patches are released promptly; non-critical updates land in
  the next minor release.
- `npm audit fix` is run as part of CI where safe to do so.

--- 

# Recent Dependency Fixes

| Package | Vulnerability | Severity | Fix |
| :--- | :--- | :--- | :--- |
| `@vitest/mocker` | GHSA-qxg6-89mg-rqv8 (code injection via unauthenticated manual mock registration) | moderate | Updated to `^4.1.12` |
| `@vitest/mocker` | GHHA-xp26-3454-mjwp (Windows backslash traversal bypass) | moderate | Updated to `^4.1.12` |

(critical and high severity vulnerabilities are blocked from merging via `npm audit` in CI)