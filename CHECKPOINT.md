# Checkpoint
*Written: 2026-04-14 11:50*

## Current Task
File Download Handling (P1) shipped on `feat/file-download-handling` branch. Next: PDF Generation (P1), then benchmark delta, then v0.1.5 build+deploy+publish.

## Progress
- [x] File Download Handling — full implementation (spec, plan, 10 tasks via subagent-driven development)
- [x] DownloadWatcher.swift — FSEvents + DispatchSource hybrid in daemon (628 lines)
- [x] safari_wait_for_download MCP tool — daemon primary, plist polling fallback
- [x] Click context capture — safari_click extracts href/download attr, server stores keyed by tabUrl
- [x] Inline render detection — detects PDFs opened in-tab instead of downloading
- [x] Safari download permission sheet detection — via System Events, DOWNLOAD_PERMISSION_TIMEOUT error
- [x] Last-chance quickDirectoryCheck — catches downloads missed by daemon probe overhead
- [x] daemon.ts command() fix — handles object values (was calling trimEnd on non-strings)
- [x] All 14 critical+important code review findings fixed
- [x] Flaky e2e test root cause found and fixed — fileParallelism: false in vitest.config.ts
- [x] Honest e2e test — no silent pass on timeout, asserts download MUST succeed
- [x] Real download detection verified — 512-byte file downloaded and verified on disk
- [x] 1299 unit tests + 5 integration tests + 48 e2e tests — ALL PASSING
- [x] Fixture server download endpoints + 6 benchmark tasks
- [ ] PDF Generation (P1 — next item)
- [ ] Benchmark delta run after PDF ships
- [ ] Version bump to 0.1.5
- [ ] Daemon rebuild via update-daemon.sh (batches downloads + PDF changes)
- [ ] TypeScript build (npm run build)
- [ ] Extension does NOT need rebuild (no extension changes through P2)
- [ ] Tag, push, GitHub Release, npm publish

## Key Decisions (not yet persisted)
- Extension rebuild (risky Xcode pipeline) is NOT needed until P3 Route Modification — all P1-P2 items are daemon+TypeScript only
- Batch downloads + PDF daemon changes into one daemon rebuild for v0.1.5
- Safari download permission prompt handled like auth flows — 60s timeout, agent tells user to allow, DOWNLOAD_PERMISSION_TIMEOUT vs regular TIMEOUT
- Click context stored in Map keyed by tabUrl (not single property) for concurrent call safety
- plist reading uses python3 plistlib (not plutil) because Downloads.plist has binary bookmark data that breaks plutil -convert json
- Default download timeout is 60s (not 30s) to allow user interaction for permission prompts
- fileParallelism: false in vitest.config.ts — e2e tests must run sequentially because multiple MCP servers compete for Safari tabs

## Next Steps
1. Start PDF Generation: read research at `docs/research/p1-pdf-generation-research.md`
2. Write spec (small, focused — similar to download handling spec at `docs/superpowers/specs/2026-04-14-file-download-handling-design.md`)
3. Write implementation plan
4. Execute via subagent-driven development (same pattern as downloads)
5. After PDF ships: run benchmark delta `npx safari-pilot-bench --model sonnet --parallel 3`
6. Version bump to 0.1.5 in package.json
7. Daemon rebuild: `bash scripts/update-daemon.sh` (covers both downloads + PDF)
8. TypeScript build: `npm run build`
9. NO extension rebuild needed (extension code unchanged)
10. Commit, tag v0.1.5, push, GitHub Release (CI handles universal daemon binary + npm publish)

## Context
- Branch: `feat/file-download-handling` (21 commits ahead of main, not yet merged)
- All tests passing: 1299 unit + 5 integration + 48 e2e
- Daemon already rebuilt locally with download watcher (will rebuild again after PDF)
- Spec: `docs/superpowers/specs/2026-04-14-file-download-handling-design.md`
- Plan: `docs/superpowers/plans/2026-04-14-file-download-handling.md`
- PDF research: `docs/research/p1-pdf-generation-research.md` (WKWebView print-to-PDF via daemon)
- Baseline: 37.8% (bench-20260413-sonnet-mnxkgwxd, 90 traces)
- npm v0.1.4 has broken MCP server — v0.1.5 fixes it + adds downloads + PDF
- Key files modified: src/tools/downloads.ts (456 lines), daemon/Sources/SafariPilotdCore/DownloadWatcher.swift (628 lines), src/tools/interaction.ts (click context), src/engines/daemon.ts (command() method), src/server.ts (keyed click context Map), vitest.config.ts (fileParallelism)
