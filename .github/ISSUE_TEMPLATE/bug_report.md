---
name: Bug report
about: Create a report to help us improve KeyGate
title: ''
labels: bug
assignees: ''
---

<!--
    Please do NOT use this template for security issues — report those
    privately per SECURITY.md.
-->

## Describe the bug

A clear and concise description of what the bug is.

## Steps to reproduce

1. Go to ...
2. Do ...
3. See error

## Expected behavior

What you expected to happen.

## Actual behavior

What actually happened, including any error message or stack trace.

## Environment

- KeyGate version / commit / Docker image tag:
- Deployment: Docker Compose / local
- Node version (if local):
- OS:
- Relevant env vars set (e.g. `CORS_ORIGINS`, `KEYGATE_REQUIRE_AUTH`):

## Configuration

- Provider spec (sanitized — no real upstream keys/masks):
- Pool / alias setup:

## Screenshots

If applicable.

## Additional context

Anything else relevant, e.g. a failing test case, logs from `mock-dbg.mjs`.

---

### 🔒 Security bug report

**Do not use this template for security issues.** Instead, follow
[`SECURITY.md`](SECURITY.md) and report privately via GitHub's private
vulnerability reporting, a security advisory, or contact the maintainers
directly.

If you've found a security vulnerability, do NOT fill out the fields above.
Instead, provide:

- A minimal, reproducible test case (commands + expected vs. actual output).
- The affected version(s), commit, or Docker image tag.
- Your assessment of impact (remote unauthenticated? data exposure? DoS?).
- Configuration involved (`KEYGATE_MASTER_KEY`, `KEYGATE_ADMIN_TOKEN`,
  `KEYGATE_REQUIRE_AUTH`, provider specs).
- **Never** include `KEYGATE_MASTER_KEY`, `KEYGATE_ADMIN_TOKEN`, or full
  upstream API keys in the issue body, logs, or screenshots.