# Contributing to KeyGate

Thanks for considering a contribution! KeyGate is a small, fast-moving project,
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

Prerequisites: **Node.js >= 20** and **npm >= 10**.

```bash
# 1. Build the frontend (outputs directly to ../backend/public)
cd frontend
npm install
npm run build

# 2. Install + run the backend (serves the built UI on :3000)
cd ../backend
npm install
npm run build
npm start
```

Open http://localhost:3000 — the management UI prompts for the admin token
(`KEYGATE_ADMIN_TOKEN`; a dev token is auto-seeded with a fresh database).

For local development without any external provider, a mock OpenAI-compatible
upstream is included: `node backend/mock-dbg.mjs` (port 9712). Point a provider
spec at `http://127.0.0.1:9712/v1` and load-test the whole pipeline offline.

## What we're looking for

- Bug fixes with a regression test.
- New provider preset YAML specs for the Add-Provider Wizard.
- Support for more of the OpenAI API surface in the shared proxy pipeline.
- Observability, retention, and security hardening.
- Documentation and example integrations (n8n, LangChain, Open WebUI, …).

Anything that adds a new endpoint, a new provider engine, or changes auth must
come with tests and a `DECISIONS.md` entry (see below).

## Code conventions

- **TypeScript everywhere.** No `any`. The frontend lints with
  `oxlint` where `no-explicit-any` is an **error** — respect that.
- **Declarative over imperative in the gateway**: new upstream behavior belongs
  in a provider YAML spec (engines: `openai-compatible`, `jsonata`,
  `handlebars`, `custom_adapter`), not in bespoke route code.
- **Fastify + zod** on the backend; **React + Tailwind** on the frontend.
  Match the surrounding file's style.
- Use the existing patterns: unified error envelopes, masked key output,
  in-memory sliding-window metrics — don't reinvent them.
- Keep table/models in `backend/src/db/` with schema migrations; never mutate
  `data/` from tests.

## Testing

Every change must keep the suite green:

```bash
# backend
npm run typecheck   # tsc for src/ and tests/
npm run lint        # oxlint
npm test            # vitest

# frontend
npm run lint
npm run build       # tsc -b + vite build
```

Notes:

- Backend tests use an **isolated throwaway SQLite database** in the OS temp
  directory (`backend/tests/setup.ts`) — your local `data/` is never touched.
- Add a test for every bugfix (the suite currently covers mapping, jsonata,
  streaming translation, circuit breaker, router strategies, quotas/budgets,
  the proxy pipeline across the whole `/v1` surface, and integration against an
  in-process mock upstream).
- CI runs backend typecheck/lint/test and frontend lint/build on every push and
  PR (`.github/workflows/ci.yml`).

## The provider-spec model

Adding a provider means writing a YAML spec, not code — see
[`providers/openai-compatible.yaml`](providers/openai-compatible.yaml) for the
trivial case and
[`providers/anthropic-messages.yaml`](providers/anthropic-messages.yaml) for the
non-standard case (bidirectional JSONata + streaming remapping). If you extend
the spec shape (new top-level fields), update the zod schemas in
`backend/src/`, the Live Spec Tester, and the README's provider table.

## Changelog & architecture docs

- New behaviors that constrain future direction get an entry in
  [`DECISIONS.md`](DECISIONS.md) (keep the numbering).
- Things we deliberately don't support go in [`BLOCKERS.md`](BLOCKERS.md).
- User-facing changes to integration setup go in
  [`docs/integrations.md`](docs/integrations.md) / `docs/n8n.md`.

## Pull request process

1. **Branch from `main`** — short descriptive branch name (`fix/`, `feat/`,
   `docs/`).
2. **Small, focused commits** — one logical change per commit, descriptive
   message in the imperative mood ("Add per-pool chat history",
   "Fix timeout header propagation"). Keep secrets out of history.
3. **Run all checks** locally before opening the PR (CI enforces the same set).
4. **PR description**: what changed, why, and how it was tested.
5. After review, prefer squash-merging to keep `main` history tidy.

## Code of conduct & security

By contributing you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). If you
find a security issue, **do not open a public issue** — follow
[`SECURITY.md`](SECURITY.md).