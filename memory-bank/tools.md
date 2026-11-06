# Tools

Commands below are written for **PowerShell on Windows**. They are the ones
this repository is actually operated with; on Linux/macOS the same tools work
with `export` instead of `$env:`.

## XERJ — local semantic search over code and docs

A single Rust binary that indexes the project and reference repositories and
answers questions with file/line citations. Used here to find how the project
already solved something, and how mature gateways solved it first.

**Install** (user scope, adds `%LOCALAPPDATA%\Programs\xerj` to `PATH`):

```powershell
irm https://xerj.org/get.ps1 | iex
```

**Start the node** (keep it running in its own terminal):

```powershell
$env:PATH = "$env:LOCALAPPDATA\Programs\xerj;$env:PATH"
xerj --insecure --data-dir "$env:USERPROFILE\xerj-data"
# REST API + console: http://127.0.0.1:9200/_xerj-console/
```

**Index a repository** (`--prefix` is the search namespace):

```powershell
xerj autoindex "C:\Users\Enis Polat\keygate" --prefix keygate `
  --state-dir "$env:LOCALAPPDATA\xerj-state\keygate"

# Large repositories: cap file size, lower bulk/worker counts to fit the node memory breaker
xerj autoindex "$env:USERPROFILE\keygate-refs\litellm" --prefix litellm `
  --state-dir "$env:LOCALAPPDATA\xerj-state\litellm.generation-v1" `
  --max-file-mb 4 --bulk-mb 1 --workers 2 --no-graph
```

Note: `litellm` indexing did **not** complete on this host — the node's real-memory
breaker (3.9 GB watermark on a 7.7 GB machine) rejected bulk writes. `keygate`,
`oneapi` and `portkey` are fully indexed; treat litellm as best-effort.

Exit code 3 means "indexed, some junk skipped" — success, not failure.

**Query**:

```powershell
xerj search --prefix keygate "gateway key hashing sha256"
xerj search --prefix portkey "fallback retry strategy target health"
xerj def --prefix keygate constantTimeEquals
xerj autoindex map --url http://localhost:9200     # what is indexed
```

Indexes in use: `keygate` (this repo), `oneapi` (songquanpeng/one-api),
`portkey` (Portkey-AI/gateway), plus a partial `litellm` (BerriAI/litellm).

**Field report** (optional, after a session):

```powershell
xerj feedback --submit --agent "Big Pickle" `
  --used-for "indexing project and reference gateways" `
  --verdict "worked; one 8 MB document limit required --max-file-mb"
```

Common failures:

| Symptom | Fix |
| :--- | :--- |
| `document is at least 8388611 bytes` | re-run with `--max-file-mb 4` |
| `legacy nonempty plan cannot become generation authority` | use a new `--prefix` and `--state-dir` |
| `real memory circuit breaker tripped` | node RSS hit its watermark; restart the node, then retry with `--bulk-mb 1 --workers 2` (or index on a host with more RAM) |
| search returns nothing | check the node is up on `:9200` and the prefix is indexed (`autoindex map`) |

## GitHub CLI (`gh`)

Authenticated as the repository owner; the source of truth for alerts, runs,
releases and Pages settings.

```powershell
gh auth status

# Alert triage
gh api "repos/enis1enis2/KeyGate/dependabot/alerts?per_page=100" `
  --jq '[.[] | {n: .number, state, sev: .security_advisory.severity, pkg: .dependency.package.name}]'
gh api "repos/enis1enis2/KeyGate/code-scanning/alerts?state=open"
gh api "repos/enis1enis2/KeyGate/secret-scanning/alerts?state=open"

# Runs and releases
gh run list --limit 10
gh run watch <run-id>
gh release list --limit 5
gh release view --json tagName,targetCommitish,url

# Pages
gh api repos/enis1enis2/KeyGate/pages
gh api -X POST repos/enis1enis2/KeyGate/pages -f build_type=workflow
gh api -X POST repos/enis1enis2/KeyGate/pages/builds
```

Note: PowerShell splits `--jq` expressions that contain spaces. Keep them
single-token or read the plain JSON output.

## Git

```powershell
git config user.email "128625009+enis1enis2@users.noreply.github.com"
git status --short
git add frontend/src/demo .github/workflows/pages.yml
git commit -m "feat(demo): publish the real console with an in-browser mock API"
git push origin main
```

`git push` writes progress to stderr; PowerShell may report a non-zero exit
even when the push succeeded. Confirm with `git log origin/main -1`.

## Node.js / npm

```powershell
npm ci                            # reproducible install
npm run typecheck                 # backend
npm run lint                      # oxlint
npm run test:coverage             # Vitest + coverage
npm run build                     # tsc (backend) / tsc -b + vite build (frontend)
npm run build:demo                # frontend only: demo bundle in frontend/dist
```

## Docker

```powershell
docker build -t keygate:local .
docker run --rm -p 3000:3000 `
  -e KEYGATE_MASTER_KEY="$(openssl rand -hex 32)" `
  -e KEYGATE_ADMIN_TOKEN="$(openssl rand -hex 24)" `
  keygate:local
docker compose up -d --build
docker compose logs -f keygate
```

## Playwright and k6

```powershell
cd frontend
npm run test:e2e:install     # one-time Chromium download
npm run test:e2e             # login, tab navigation, gateway-key lifecycle

cd ..\load-tests
$env:SCENARIO = "smoke"      # smoke | load | ratelimit | soak
k6 run .\keygate.js
```

## Local demo preview

Build the Pages variant and serve the output; the app is the real console with
a mock API, so there is no backend to start.

```powershell
cd frontend
$env:VITE_DEMO = "1"; $env:VITE_BASE = "/"
npm run build:demo
npx --yes serve dist -l 4173
# http://127.0.0.1:4173/
```

For a production-base check, rebuild with `VITE_BASE=/KeyGate/` and confirm
`dist/index.html` references `/KeyGate/assets/...`. In the browser's network
panel the only requests should be the document and its hashed assets — any
`/api/*` or `/v1/*` entry means the interceptor did not install. Reloading must
reset created keys and pricing rows.

## Reference repositories

Shallow clones under `%USERPROFILE%\keygate-refs\` — read them for proven
approaches before inventing new routing, retry or key-storage logic.

| Repository | What to copy from it |
| :--- | :--- |
| `BerriAI/litellm` | Router strategies, fallbacks, provider adapters |
| `songquanpeng/one-api` | Channel/ability model, retries, quota accounting |
| `Portkey-AI/gateway` | Declarative config, target modes, retry/strategy schema |
