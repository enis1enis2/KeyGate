## What

Short summary of the change and *why* it matters. Be specific about the problem
or the new capability.

## Type of change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] Feature (new functionality)
- [ ] Refactor (code change that neither fixes an issue nor adds a feature)
- [ ] Docs (updating docs, README, SECURITY.md, contributing guides)
- [ ] CI / tooling (workflow, lint, typecheck, Dependabot)
- [ ] Security (security-related fix, audit hardening, headers, path confinement)

## How it was tested

### Backend

- [ ] `npm run typecheck` — 0 errors
- [ ] `npm run lint` — 0 warnings
- [ ] `npm test` — 122/122 tests green
- [ ] If the change touches auth, path guards, or the data plane:
  - [ ] Targeted regression test passes (e.g. `security.test.ts`, `security-preauth.test.ts`)

### Frontend

- [ ] `npm run lint` — 0 warnings
- [ ] `npm run build` — successful build

### Manual verification (describe steps)

> **Security first**: If your change touches auth, path guards, passthrough
> confinement, or the data plane, you must also update `SECURITY.md` and add
> regression tests. No secrets (master key, admin token, upstream keys) may be
> included in commits or test output.

## Backwards compatibility

Does this change the API surface, DB schema, or provider YAML format? If yes,
what's the migration story?

- [ ] No backwards-incompatible changes
- [ ] Breaking change — see migration notes below

## Related items

- Issue(s): #
- [ ] Adds a `DECISIONS.md` entry if this constrains future direction
- [ ] Updates README / docs if user-facing
- [ ] Updates SECURITY.md if security posture changes

## Security checklist (answer for every PR)

- [ ] No master key, admin token, or upstream API key in commit history or test output
- [ ] No new `any` types (frontend oxlint error)
- [ ] Path guards use `normalizedPathname()` for consistent comparison
- [ ] Passthrough confinement checks origin + base-path prefix
- [ ] Trace-id validation regex is enforced (`^[A-Za-z0-9._:-]{8,64}$`)
- [ ] Response headers include `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`
- [ ] `npm audit` passes cleanly