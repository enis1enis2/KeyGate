# Runbook

Short, actionable procedures. Replace `<run-id>` with the id from `gh run list`
and `<tag>` with the release tag in question.

## CI fails on main

1. Read the failing job:
   `gh run view <run-id> --log-failed`
2. Reproduce locally with the same command CI ran (see `workflows.md`).
3. Fix on a branch, open a PR, wait for green, merge.
4. If `main` is red and the fix will take time, revert the offending commit
   (`git revert <sha>`) so releases and Pages are not blocked.

Never re-run a failed job hoping it passes — re-run only after confirming the
failure is infrastructure (runner image, registry outage).

## A Dependabot alert appears

```powershell
gh api "repos/enis1enis2/KeyGate/dependabot/alerts?state=open" `
  --jq '[.[] | {n: .number, sev: .security_advisory.severity, pkg: .dependency.package.name, fixed: .security_vulnerability.first_patched_version.identifier}]'
```

1. If a Dependabot PR exists, review its diff and merge once CI is green.
2. No PR: bump the package in the affected workspace, run
   `npm audit --omit=dev --audit-level=high`, commit, PR.
3. If the fix needs a major bump, check the changelog for breaking changes and
   add a note to `DECISIONS.md`.
4. Confirm closure: the alert's `state` becomes `fixed` after the next
   dependency graph update (usually within minutes of the merge).

## A code-scanning alert appears

1. `gh api "repos/enis1enis2/KeyGate/code-scanning/alerts?state=open"` — note
   rule id, path, line and severity.
2. Open the alert in Security → Code scanning for the data-flow trace.
3. Fix the source, or dismiss with a written reason only when the finding is a
   false positive and the reason is reviewable.
4. CodeQL re-runs on the next push to `main` and closes fixed alerts.
5. If there is no analysis at all (`404 no analysis found`), run
   Actions → CodeQL → *Run workflow*.

## A secret-scanning alert appears

Treat as an incident, not a chore.

1. **Rotate the secret immediately** at the provider. Do not wait for the fix.
2. Revoke the old credential; confirm requests still succeed through KeyGate.
3. Remove the secret from the working tree, then from git history
   (`git filter-repo` or GitHub's guidance) before making the repository public.
4. Record what leaked, where, and for how long in `SECURITY.md` or the incident
   notes. Never paste the secret into an issue or commit message.

## Pages deploy fails

1. `gh run view <run-id> --log-failed` on the Pages workflow.
2. `gh api repos/enis1enis2/KeyGate/pages` — `build_type` must be `workflow`.
3. If the site is not configured: `gh api -X POST repos/enis1enis2/KeyGate/pages -f build_type=workflow`.
4. If the artifact upload failed, check that `demo/index.html` exists and the
   workflow still points at `path: demo`.
5. For an environment-protection rejection, approve the `github-pages`
   deployment in Actions, then re-run.
6. Re-deploy without a code change: Actions → Pages → *Run workflow*.

## Demo URL returns 404

1. Confirm the Pages workflow succeeded for the latest `main`.
2. Pages only serves from the configured build type; a `workflow` site is not
   built from the branch, so a manual push does nothing until the workflow runs.
3. First deployment can take 1–2 minutes to propagate; retry with a cache-bust
   query (`?v=2`).
4. Direct URL: <https://enis1enis2.github.io/KeyGate/>.

## Release fails or does not run

1. Releases only start after **CI** succeeds for a **push** to `main`.
   A green PR run does not qualify.
2. `gh run list --workflow Release` — if no run exists, check that the CI run's
   `head_branch` is `main` and its conclusion is `success`.
3. If the job failed on permissions, confirm the workflow has
   `permissions: contents: write` on the release job.
4. If the tag already exists, the job skips or bumps past it. Do not delete a
   published tag to force a version.
5. Publish manually only as a last resort:
   `gh release create vX.Y.Z --target <sha> --generate-notes`.

## Gateway answers 502 `no_healthy_upstream`

1. Open the console → Pools. Check whether every target is offline or cooling
   down.
2. Upstream keys: a key with 401/403 is broken — rotate it. A key with 429 is
   rate-limited — wait for the cooldown or add a sibling key.
3. Budget exhausted: raise the key or pool cap, or rebalance traffic.
4. Confirm recovery with a playground request and a new trace with status 200.

## All requests fail with 401

- Client side: the gateway key was revoked, expired, or the client sends the
  upstream key instead of the `kg-live-…` token.
- Admin side: `/api/*` needs `KEYGATE_ADMIN_TOKEN`; `/v1/*` needs a gateway key.
- `KEYGATE_REQUIRE_AUTH=false` is only honoured outside production.

## Backend will not start after an upgrade

1. Check logs: `docker compose logs keygate` (or the process output).
2. `KEYGATE_MASTER_KEY` or `KEYGATE_ADMIN_TOKEN` missing in production is a
   deliberate hard failure — set them in `.env`.
3. Back up the SQLite file before changing anything:
   copy `KEYGATE_DB_PATH` plus `-wal`/`-shm` while the service is stopped.
4. Schema migrations are forward-only. To roll back, restore the backup and
   redeploy the previous image tag.

## Master-key rotation

1. Set the new key as `KEYGATE_MASTER_KEY` and the old one as
   `KEYGATE_MASTER_KEY_PREVIOUS`.
2. Restart, then run `npm run reencrypt` (or `npm run reencrypt:prod` in the
   container).
3. When it reports zero old rows, remove `KEYGATE_MASTER_KEY_PREVIOUS` and
   restart again.
4. Back up the database first; a lost master key cannot be recovered.

## XERJ index fails

| Message | Action |
| :--- | :--- |
| `document is at least 8388611 bytes` | `--max-file-mb 4` and re-run |
| `legacy nonempty plan cannot become generation authority` | new `--prefix` + new `--state-dir` |
| `EADDRINUSE 9200` | an XERJ node is already running; use it or stop that PID |
| empty search results | `xerj autoindex map` — confirm prefix and document count |

## Port already in use locally

```powershell
Get-NetTCPConnection -LocalPort 3000,4173 -State Listen |
  Select-Object LocalPort, OwningProcess
Stop-Process -Id <pid>
```

Do not kill every `node` process — it also terminates the editor/browser
backend and other long-running tooling.

## Repository housekeeping

- `.tmp_hapkg/` is a local Home Assistant packaging scratch directory and stays
  untracked.
- Git author email must be `128625009+enis1enis2@users.noreply.github.com`,
  otherwise GitHub rejects the push with GH007.
- Push to `origin main` after every coherent change; never force-push `main`.
