# Workflows

## Local development

```powershell
# backend (tsx watch on :3000)
cd backend; npm ci; npm run dev

# frontend (Vite dev server; proxies to the backend)
cd frontend; npm ci; npm run dev

# checks that CI runs
cd backend;  npm run typecheck; npm run lint; npm run build; npm run test:coverage
cd frontend; npm run lint; npm run build; npm run test:coverage
```

Production-like run:

```powershell
docker build -t keygate:local .
docker run --rm -p 3000:3000 `
  -e KEYGATE_MASTER_KEY="$(openssl rand -hex 32)" `
  -e KEYGATE_ADMIN_TOKEN="$(openssl rand -hex 24)" `
  keygate:local
```

`docker compose up -d --build` reads `.env`; `KEYGATE_MASTER_KEY` and
`KEYGATE_ADMIN_TOKEN` are mandatory there.

## CI — `.github/workflows/ci.yml`

Triggers: every push to `main` and every pull request.

| Job | What it proves |
| :--- | :--- |
| Backend | typecheck, lint, build, unit coverage, `npm audit --omit=dev --audit-level=high` |
| Frontend | lint, build, unit coverage, production dependency audit |
| Docker image | image builds, container starts, `/healthz` returns healthy within 60 s |

Conventions: actions pinned to full commit SHAs, `persist-credentials: false`,
`contents: read`, per-job timeouts, PR runs superseded on new pushes while
`main` runs are not cancelled.

## Release — `.github/workflows/release.yml`

1. `CI` finishes on `main` with `conclusion == success`.
2. `workflow_run` starts the release job (so fork PRs never get a write token).
3. The job checks whether the exact commit is already released; if so it exits.
4. It takes the highest `v*` tag, increments the patch (`v0.1.0` → `v0.1.1`),
   and skips any name already taken by a tag.
5. `gh release create <tag> --target <sha> --generate-notes` creates the tag,
   the release and notes generated from commits since the previous tag.

Manual re-run: Actions → Release → *Re-run all jobs*. A commit that is already
tagged is skipped, so re-runs are safe.

## Deploy — `.github/workflows/pages.yml`

GitHub Pages serves the **real console in demo mode**: the React components in
`frontend/` are built with `VITE_DEMO=1` and a `fetch` interceptor
(`frontend/src/demo/mockApi.ts`) answers every `/api` and `/v1` request from
seeded memory.

1. Push to `main` touching `frontend/**` (or run the workflow manually).
2. `configure-pages` reads the repository's Pages configuration
   (`build_type=workflow`, enabled once via
   `gh api -X POST repos/enis1enis2/KeyGate/pages -f build_type=workflow`).
3. `setup-node` installs from `frontend/package-lock.json`; `npm run build:demo`
   runs with `VITE_DEMO=1` and `VITE_BASE=/KeyGate/`, writing `frontend/dist`.
4. `upload-pages-artifact` packs `frontend/dist`; `deploy-pages` publishes it to
   <https://enis1enis2.github.io/KeyGate/>.

The deployed demo never contacts a backend: no `/api` or `/v1` request leaves the
browser, all values are fictional, and every reload rebuilds the seed state.
The normal `npm run build` still writes `backend/public` at base `/`, so the
self-hosted console is unaffected. `demo/` is the old hand-written static page;
it stays in the tree for reference but is not deployed.

## Production deploy (self-hosted)

```powershell
git pull
docker compose up -d --build
docker compose logs -f keygate
curl http://127.0.0.1:3000/healthz
```

Schema migrations run on boot. Back up `KEYGATE_DB_PATH` before upgrading; the
SQLite file is the only stateful artifact.

## Alert and dependency workflow

```powershell
gh api "repos/enis1enis2/KeyGate/dependabot/alerts?per_page=100" `
  --jq '[.[] | {n: .number, state, sev: .security_advisory.severity, pkg: .dependency.package.name}]'
gh api "repos/enis1enis2/KeyGate/code-scanning/alerts?state=open"
gh api "repos/enis1enis2/KeyGate/secret-scanning/alerts?state=open"
```

Dependabot PRs are merged after CI is green. CodeQL runs on `main`, on PRs and
weekly; its alerts land in Security → Code scanning. Secret-scanning alerts are
always treated as incidents (rotate first, then clean history if needed).

## Documentation workflow

`memory-bank/` is the operating manual. Update it in the same PR as the change
it describes: `project.md` for scope/stack, `workflows.md` for pipelines,
`tools.md` for commands, `runbook.md` for failure handling.
