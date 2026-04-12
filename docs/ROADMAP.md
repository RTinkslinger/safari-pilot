# Safari Pilot — Roadmap

## Shipped (v0.1.0)

- 74 MCP tools across 14 categories
- Three engine tiers: AppleScript (fallback) → Swift Daemon (1ms p50) → Safari Web Extension (deep DOM)
- 9-layer security pipeline (tab ownership, domain policy, rate limiter, circuit breaker, IDPI scanner, human approval, screenshot redaction, kill switch, audit logging)
- Signed and notarized Safari Web Extension (Developer ID, persists across restarts)
- Published to npm (`safari-pilot`) and GitHub Releases
- CI/CD via GitHub Actions
- Live tested against Hacker News and X.com (authenticated bookmarks)

---

## Future: CI Browser Testing

**Goal:** Make Safari Pilot a viable option for running browser tests in CI/CD pipelines on macOS runners.

**Why it matters:** Currently, teams that need Safari testing in CI use Playwright with WebKit (which is NOT real Safari) or skip Safari entirely. Safari Pilot runs real Safari — the actual browser users have — which catches bugs that WebKit-in-Playwright misses.

**What needs to be built:**
- Test runner CLI: `safari-pilot test ./tests/` — discovers test files, runs sequentially, reports in JUnit/TAP format
- Local HTTP server for test fixtures (serve HTML from `test/fixtures/` during test runs)
- Assertion library integration (or built-in assertions for common checks: element exists, text matches, screenshot matches)
- Parallel test execution (multiple tabs, serial per tab)
- Screenshot-on-failure capture with artifact upload
- CI-friendly output (exit codes, JUnit XML for GitHub Actions test summary)
- Configuration file (viewports, timeouts, base URL, fixture paths)

**What already exists:** safari_test_flow (compound tool), safari_wait_for (7 conditions), safari_take_screenshot, safari_evaluate, all navigation + interaction tools. The infrastructure is there — the missing piece is the test framework wrapper.

**Estimated effort:** 1-2 sessions for research + spec, 2-3 sessions for implementation.

**Requires research on:**
- How macOS CI runners handle Safari (GUI session availability, Xcode version requirements)
- Test file format (JS? TS? YAML step definitions?)
- How to integrate with existing test frameworks (Jest, Vitest, Playwright test runner)
- Fixture serving patterns (static file server vs inline HTML)

---

## Future: Visual Regression Testing

**Goal:** Add pixel-level screenshot comparison for catching unintended visual changes, using real Safari rendering (not WebKit proxy).

**Why it matters:** Playwright's visual regression uses its bundled WebKit which renders differently from actual Safari. Font rendering, subpixel antialiasing, CSS interpretation — all subtly different. Safari Pilot captures what users actually see.

**What needs to be built:**
- New tool: `safari_visual_compare` — takes screenshot, compares against stored baseline, returns `{match, diffPercentage, diffImagePath}`
- Baseline management: store per-test baselines in `.safari-pilot/baselines/`, create on first run, compare on subsequent runs
- Image diffing engine: options are `pixelmatch` (npm, lightweight, pure JS) or macOS Core Image APIs via the daemon (GPU-accelerated)
- Threshold configuration: percentage of pixels allowed to differ (default 0.1%, configurable per test)
- Viewport normalization: enforce consistent size via `safari_resize` before capture
- HiDPI/Retina handling: baselines must be resolution-aware (2x on Retina)
- Diff image generation: visual overlay showing changed pixels (red highlights)
- Update workflow: `safari-pilot update-baselines` to accept current screenshots as new baselines

**What already exists:** safari_take_screenshot (viewport + full page), safari_resize (viewport control), safari_evaluate (can read devicePixelRatio). The screenshot pipeline works — the missing piece is the comparison engine and baseline storage.

**Estimated effort:** 1 session for research + spec, 2-3 sessions for implementation.

**Requires research on:**
- Best image diffing libraries for macOS (pixelmatch vs sharp vs native Core Image)
- How to handle anti-aliasing and font rendering variance across macOS versions
- Baseline storage format (flat files vs git LFS vs separate repo)
- Integration with existing visual regression tools (Percy, Chromatic — can we feed them Safari screenshots?)
- Retina vs non-Retina normalization strategies
