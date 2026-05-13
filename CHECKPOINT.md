# Checkpoint
*Written: 2026-05-13 07:38*

## Current Task

v0.1.33 bench validation **COMPLETE**. WebVoyager 175-task inline-bench finished at 128/175 SUCCESS (73.1%), 0.0% capture failure rate, all 3 acceptance criteria PASS. Branch is bench-gate-clear; remaining work is the release ritual (pre-tag-check + tag push + CI watch).

## Progress

See `TRACES.md` iter 79 for the full per-site breakdown, judge run details, and the two operational fixes that came out of the resume (harness mktemp + cleanup-AppleScript hang).

- [x] All 5 daemon + TS-side fixes committed (`1acd277`, `5147d5e`, `e27ff37`, `9a42551`, `130f9ba`)
- [x] 175/175 canonical tasks run with screenshot
- [x] Judge run via `bench/webvoyager/judge-inline-runs.ts` against gpt-4o seed=42
- [x] Acceptance criteria validated against v0.1.30 baseline (6 sites overlap, all improved or equal)
- [x] TRACES iter 79 + judge orchestrator committed (`de2a4f7`)
- [ ] **Pre-tag-check.sh full pass** — re-run after CHECKPOINT.md committed
- [ ] **Tag push `v0.1.33`** — needs user authorization (fires CI + npm publish)
- [ ] **CI watch + merge to main** — after tag push succeeds

## Key Decisions (not yet persisted)

None — TRACES iter 79 covers iter-level decisions. The bench-completion state is fully in git history.

## Next Steps

When user authorizes:

```bash
cd "/Users/Aakash/Claude Projects/Skills Factory/safari-pilot"

# Re-run pre-tag-check (CHECKPOINT.md will be clean by this point)
bash scripts/pre-tag-check.sh
# Must print "ALL CHECKS PASSED" before tagging.

# Tag + push
git tag -a v0.1.33 -m "release v0.1.33 — daemon HTTP hardening + bench robustness

Bench (WebVoyager 175): 128/175 SUCCESS (73.1%), 0.0% capture failure.
All v0.1.30-baseline sites improved or equal (Amazon +6, BBC News +4,
Booking +4, ArXiv +2, Apple +1, Allrecipes =).

Daemon: HTTP self-test detached from onServerRunning (1acd277); HTTP
service recovers from runtime crash instead of FATAL-exiting (5147d5e).
TS: MCP server retries TCP probe 3x with backoff before spawn fallback;
extension screenshot races local 15s timeout against macOS screencapture
fallback (130f9ba)."

git push origin fix/v0132-daemon-hardening
git push origin v0.1.33

# Watch CI
gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"

# After CI green, merge to main
git checkout main
git pull origin main
git merge fix/v0132-daemon-hardening
git push origin main
```

## Context

### Repo state at this checkpoint

- **Branch:** `fix/v0132-daemon-hardening` at HEAD `de2a4f7`, 31 commits ahead of `main`.
- **Latest commit:** `de2a4f7 docs(traces): iter 79 — bench finalized 175/175, judge ACCEPT (v0.1.33)`.
- **Working tree:** dirty only by CHECKPOINT.md (this file) — must commit to clear pre-tag-check gate 1.
- **Pre-existing untracked:** `daemon/CLAUDE.md`, `daemon/TRACES.md` (v0.1.30 carry-forwards — out of scope, can be left alone or moved to .git/info/exclude).
- **Active extension:** v0.1.33 (build 202605121922), notarized + stapled + Gatekeeper-accepted.
- **Daemon process:** `bin/SafariPilotd` PID 76143 alive ~13h, 0 FATAL exits since Fix 2 landed.
- **Tests:** unit + e2e last PASS pre-`130f9ba`. Pre-tag-check.sh runs unit tests.

### v0.1.34 carry-forwards surfaced during this sprint

1. **Daemon NIOFcntlFailedError SwiftNIO root cause** — recoverable now but trigger remains opaque.
2. **CSP-blocked sites — non-eval content-script execute path.** Apple shop, Google Flights, X.com all enforce Trusted Types; safari_evaluate fails. Largest gap on Google Flights (3/11 = 27%).
3. **Inline-bench harness promotion** — `/tmp/run-one-task.sh` works well after the mktemp + cleanup-timeout fixes. Should land at `bench/webvoyager/run-one-task.sh` (or sibling) with both fixes baked in.
4. **Bench seed footgun documentation** — note in `CONCURRENCY_DECISION` or sibling: `sample-cli.ts --seed default` ≠ `run.sh --seed "v0.1.x-dev-sample"`; only the v0.1.x-dev seed produces the canonical 175.
5. **Pre-existing v0.1.32 sprint carry-forwards** still pending (daemon Models.swift AnyCodable bool/int coercion; allowlist over-broadness; `skipped[]` sanitization; `selector-pack.ts` dead code).
6. **Per-site failure analysis from this bench** (read `bench-runs/webvoyager-v0.1.33-inline-bench-20260513/scoreboard.json` for raw, individual score.json files in `/tmp/wv-inline-runs/`).
