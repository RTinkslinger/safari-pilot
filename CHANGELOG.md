# Changelog

## v0.1.36 (2026-05-19) — Per-window session isolation

Every MCP session — every bench task, every claude conversation — now opens
its own dedicated Safari window via the daemon's `ensureSessionWindow`
path. The window closes automatically when the session ends (claude exits,
SIGTERM, or stdio EOF). Cross-session pollution is structurally prevented
at the extension layer.

The user-visible outcome: tabs no longer pile up. When a bench probe at
concurrency=4 finishes, Safari is back to whatever windows existed before
it started.

### Added

- **F1.2 dashboard-URL handshake**: every daemon → extension command now
  carries the session's dashboard URL (`http://127.0.0.1:19475/session?id=sess_<n>`),
  a stable string identifier that crosses the AppleScript ↔ WebExtension
  API boundary safely. `extension/background.js` watches
  `tabs.onUpdated`/`onCreated` for that URL pattern and populates
  `sessionDashboardUrlToWindowId`. The candidate filter
  (`extension/lib/session-filter.js`) resolves the URL via that Map and
  filters in the WebExtension namespace where cache entries actually live.
  The pre-rework version of F1.2 sent the AppleScript `id of window N`,
  which lives in a different integer namespace from the cache's
  `tab.windowId` — they never matched, and the filter silently dropped
  every candidate.

- **stdio-EOF graceful shutdown** in `src/index.ts`: registers
  `process.stdin.on('end')` and `on('close')` listeners that call
  `gracefulShutdown('STDIO_EOF')`. The MCP SDK's `StdioServerTransport`
  listens for stdin 'data' and 'error' but NOT 'end', so its `onclose`
  callback only fires on explicit `transport.close()`. claude exits its
  child via pipe close (no signal), Node drained the event loop before
  the SIGTERM-only handler could run — the session window leaked. The new
  handlers close it via `closeSessionWindow` before exiting. Exit code 0
  on the EOF path (clean drain); SIGINT keeps 130, SIGTERM keeps 143.

- **`bench/webvoyager/probe-analysis.py`**: aggregates a probe directory
  into median/mean wall + turns, verdict distribution, and error counts
  against the configured ship-gate criteria. Replaces the throwaway
  `/tmp/rca-batch-probe/postfix-analysis.py` used during the 2026-05-18
  RCA — that script lived in `/tmp` and got wiped on a Claude Code
  crash; this one lives in-tree.

### Fixed

- **`parseJsResult` empty=CSP_BLOCKED false positive**
  (`src/engines/js-helpers.ts`, `src/engines/applescript.ts`).
  `parseJsResult` now takes `opts.isJsExecution`. `AppleScriptEngine.execute()`
  passes `isJsExecution: false`, so empty stdout from non-JS callers
  (`safari_list_tabs` against a 0-window Safari, etc.) resolves to
  `ok:true, value:''` instead of being mis-labeled CSP_BLOCKED.
  `executeJsInTab` keeps the empty=CSP invariant on the JS path. The
  2026-05-18 batch probe saw 55/61 of its CSP_BLOCKED errors collapse to
  zero after this fix landed.

- **`handleNewTab` no-front-window recovery**
  (`src/tools/navigation.ts:263-303`). When `_sessionWindowId` is undefined
  (bench mode without the session window) and Safari has zero windows,
  AppleScript's `tell front window` returned `-1719` / `-1700`. The new
  branch activates Safari and retries `buildNewTabScript` once when both
  conditions are met. The batch probe's 73 no-front-window errors are
  zero post-fix.

- **`bench/webvoyager/run-one-task.sh` per-task cleanup race**. The pre-fix
  cleanup logic captured a pre-snapshot of Safari tab URLs at task start
  and closed "anything not in the snapshot" at task end. At concurrency 4,
  Task A's pre-snapshot didn't include Task B's mid-execution tabs → A's
  cleanup closed B's tabs. The 2026-05-18 RCA documented 41 such
  confirmed-then-TAB_NOT_FOUND events. v0.1.36 removes the per-task
  cleanup entirely: the per-window session model means each task's tabs
  live in their own window, and `closeSessionWindow` on stdio EOF closes
  the entire window.

- **sessionId uniqueness under concurrent spawn** (`src/server.ts:222`).
  `sess_${Date.now().toString(36)}` collided when two MCP servers spawned
  in the same millisecond — the F1.2 map keyed two distinct windows under
  one key, and cross-session lookups misfired. Added a 6-hex random
  suffix for 16M-way disambiguation per ms.

### 50-task probe — ship-gate verification

Same 50-task subset as the 2026-05-18 evening regressed probe
(Allrecipes/Amazon/Coursera/ESPN 0-12, concurrency 4, Max-billed). Full
report at `bench-runs/v0136-probes/RESULTS-perwin.md`.

| Metric | Regressed batch+dev.10 | Envelope-only baseline | Per-window v0.1.36 |
|---|---:|---:|---:|
| Median wall | 369s | 324s | **348s** (+7.4% vs baseline) |
| Median turns | 23.5 | 14 | **15** (+7.1% vs baseline) |
| CSP_BLOCKED | 61 | low | **0** |
| No-window AppleScript errors | 73 | low | **0** |
| TAB_NOT_FOUND | 51 | low | **13** (−75% vs regressed) |

4/5 ship gates hard PASS, 1/5 borderline pass at 75% reduction. The
residual 13 TAB_NOT_FOUND trace to a known slow-path where F1.2
correctly rejects a candidate but the extension takes ~15s to surface
the no-match instead of milliseconds. Response-path optimization is
captured for v0.1.37.

### Watch-list for v0.1.37

- Slow-path TAB_NOT_FOUND surfacing (15s → ms when the F1.2 filter rejects).
- Cross-session F1.2 filter behavior on same-site adjacency (the full
  WebVoyager 643-task benchmark has 49 Amazon tasks etc. — captured but
  not exercised by this probe).
- Apply the per-window model to the standalone `safari_pilot` CLI hooks
  and the `/safari-pilot:stats` skill path.

## v0.1.33 (2026-05-12) — Daemon HTTP-layer hardening

Pure-bugfix release. No new tools, skills, or commands. The TS-side feature
work that shipped in v0.1.32 still applies; this release adds two daemon Swift
fixes that surfaced during the v0.1.32 ship-gate T24 attempt and a benchmark
configuration correction.

### Fixed

- **Daemon HTTP self-test no longer deadlocks on every startup.** Pre-fix,
  `HTTP_SELF_TEST` failed with a 60s URLSession timeout on every clean
  daemon start since at least 2026-04-19, recording a phantom
  `recordHttpRequestError()` each cycle. Cause: synchronous self-test inside
  Hummingbird's `onServerRunning` deadlocked on the very server it was
  probing — the accept loop couldn't process the loopback request until
  `onServerRunning` returned, but `onServerRunning` was awaiting the
  self-test's response. Fix: `Task.detached` + 200ms grace + explicit 5s
  URLRequest timeout. Self-test now passes status=200 within ~236ms of
  `HTTP_READY` (commit `1acd277`).

- **Daemon recovers HTTP-layer runtime crashes instead of FATAL-exiting.**
  Pre-fix, `runService()` throwing for ANY reason — including transient
  `NIOFcntlFailedError` mid-flight under sustained load — logged
  `HTTP_BIND_FAILED` and called `onBindFailure` → `exit(1)` → launchctl
  KeepAlive respawn. That converted a transient runtime blip into a
  permanent process crashloop. Fix: track `readyFlag` per `start()` attempt;
  if `onServerRunning` ever fired (server was ready), restart the
  Hummingbird `Application` in-process with exponential backoff
  (1s, 2s, 4s, 8s, 16s capped at 30s) for up to 5 attempts. Initial bind
  failures (never ready) retain the original fatal-exit behavior. Beyond
  5 runtime restarts, escalate as bind failure (visible exit, launchctl
  respawns fresh) (commit `5147d5e`).

  Empirically validated post-fix: 30s synthetic 8-worker HTTP storm, 1-task
  bench probe at c=1, 8-task bench probe at c=8 — all produced zero
  `HTTP_BIND_FAILED` / `HTTP_SERVICE_FAILED` / `NIOFcntlFailedError` events
  in `~/.safari-pilot/daemon.log`. 156 daemon unit tests pass including
  `testOnBindFailureFiresWhenPortAlreadyBound` (preserves bind-failure-fatal
  on the "never ready" branch).

### Changed

- **`bench/webvoyager/CONCURRENCY`: 8 → 1.** Aligns the config with v0.1.30
  canonical baseline precedent (all three v0.1.30 runs were launched at
  `--concurrency 1` despite the file claiming 8 — operator override that
  wasn't documented). The 8-task probe at c=8 post-daemon-fix exposed an
  upstream issue: Anthropic Max queues 8-concurrent `claude -p` invocations,
  exceeding the bench's 248s per-task timeout with empty STDOUT and
  `agent_final_text=""`. Single-shot `claude -p` works (~54s for `OK`);
  8-concurrent does not. Original PF-6 microbench used
  `safari_health_check`, a no-network client-side probe that doesn't touch
  Anthropic's API at all, so didn't surface this. Rationale and reversal
  trigger now documented in `bench/webvoyager/CONCURRENCY_DECISION`.

### Known limitations carried forward to a future release

- **`NIOFcntlFailedError` upstream trigger not root-caused.** Synthetic
  8-worker HTTP storm over 3 minutes did not reproduce; the trigger seems
  to require sustained mixed real-Safari interaction. The v0.1.33 fix makes
  the daemon resilient regardless. Deeper SwiftNIO investigation is open.
- All v0.1.32 carry-forwards remain: daemon `Models.swift` AnyCodable bool/
  int coercion, allowlist pattern over-broadness + registry-order collision,
  `skipped[]` field-level sanitization + `MALFORMED_SENTINEL` error name,
  `selector-pack.ts` dead-code wire-or-remove.

### Rollback

If v0.1.33 introduces a regression versus v0.1.32:
- The HTTP service fix is well-encapsulated in `ExtensionHTTPServer.start()`.
  Revert commit `5147d5e` to restore pre-fix FATAL-exit behavior. The
  daemon Swift API surface is unchanged.
- The self-test detach (`1acd277`) is similarly isolated. Revert returns
  to the pre-fix always-fails-at-60s behavior, which was non-fatal.
- `bench/webvoyager/CONCURRENCY` can be reverted to `8` if a future
  Anthropic Max policy change makes that viable; the daemon hardening
  stays.

---

## v0.1.32 (2026-05-08)

(Released as v0.1.32 because the dev cycle required mid-sprint marketing-version
bumps for Safari extension cache invalidation. The "v0.1.31 sprint" label
designates the work scope; the published version reflects the final marketing
version after iteration.)

### Added

- **`safari_scroll_to_element` MCP tool.** Scrolls a specific element into
  the visible viewport. Multi-mode input ({selector, text, role+name}).
  Returns matched-node descriptor + viewport state + multi-match candidates.
  Open shadow root penetration; same-origin iframe traversal. Extension-engine
  only (`requiresAsyncJs: true`). 6 e2e assertions, p95 ≈ 291ms.
- **`safari_dismiss_overlays` MCP tool.** Detects and dismisses ~14 known
  overlay patterns (cookie-consent, registration-wall, app-install, paywall)
  using a curated allowlist of DOM signatures with a two-signal-per-pattern
  rule. Returns `{dismissed[], skipped[], overlaysAtStart, overlaysAtEnd}`
  with id-only-sanitized `dismissed[]` entries (page-injected hostile strings
  cannot leak via response). IdpiAnnotator scans the response summary.
  Extension-engine only (`requiresShadowDom: true`).
- **Four new plugin skills:**
  - `evidence-grounded-screenshot` (procedural workflow: dismiss → scroll → screenshot)
  - `dismiss-overlays-recovery` (strategy: recover from blocked extraction)
  - `visible-evidence-grounding` (strategy: ground answers in current visible page state)
  - `temporal-substitution` (strategy: substitute past-relative dates)
- **`/safari-pilot:stats` slash command.** Local-only metrics summary over
  `~/.safari-pilot/trace.ndjson` — per-tool count/error-rate/p50/p95, top
  errors, top domains. Supports `--since`, `--by-tool`, `--by-error`,
  `--by-domain`, `--tail`, `--json`, plus `SAFARI_PILOT_TRACE_OVERRIDE` for
  test hermeticity.
- **SessionStart hook injects current date as `additionalContext`** so the
  temporal-substitution skill (and others) sees today's date without an
  extra tool call.

### Fixed

- **`extension/locator.js` `matchSignal('selector')` now uses `el.matches()`
  instead of `hostDoc.querySelector()`.** The latter returned false for
  shadow-encapsulated elements because hostDoc was the outer light-DOM document.
  Surfaced by Task 12 shadow-DOM penetration test.
- **`smart-app-banner` allowlist pattern fixed.** Original required
  `meta[name=apple-itunes-app]` (head) AND `.smart-app-banner` (body) to match
  the same element — impossible. Replaced head-meta requirement with
  `fixed-position` structural discriminator. Surfaced by Task 14 per-pattern
  integration sweep.
- **`.claude-plugin/plugin.json` now correctly registers `login`,
  `paginate-and-scrape`, `robust-form-fill` skills** (previously on disk but
  unregistered — discrepancy discovered during v0.1.31 design review).

### Internal

- New error codes (data-only, no thrown classes): `TARGET_NOT_FOUND`, `TARGET_HIDDEN`.
- New extension sentinels (prefix-and-JSON convention):
  `__SP_SCROLL_TO_ELEMENT__:<json>` and `__SP_DISMISS_OVERLAYS__:<json>`.
  Both intercept early in `extension/content-main.js` `case 'execute_script':`.
  Sentinel-handler files MUST live in MAIN-world content scripts (not
  `background.js` service worker which lacks DOM access).
- New helper module `extension/locator.js` exposes `window.__SP_LOCATOR__`
  with `querySelectorWithShadow`, `resolveScrollTargets`, `waitForScrollSettle`,
  `serializeNode`, `matchSignal`, `findPatternRoot`, `dismissPattern`.
- Allowlist content lives in `src/overlays/*.json` — patch-releasable via
  `npm publish` (no extension rebuild needed for content-only changes; user
  must run `npm update safari-pilot` to pick up patches; propagation is not silent).
- Pre-tag-check (`scripts/pre-tag-check.sh`) extended with two new gates:
  allowlist parse-validate (loader schema + two-signal rule) and content-only
  patch flow proof (`tests/ci/content-only-patch.sh`).
- `EXTRACTION_TOOLS` Set in `src/server.ts` extended with `safari_dismiss_overlays`
  so IdpiAnnotator scans `content[0].text` for indirect prompt injection.

### Paywall dismissal — opt-IN by default, residual risk acknowledged

The dismiss-overlays allowlist ships 3 conservatively-scoped paywall patterns
(NYT-soft, FT-modal, Bloomberg-overlay). They are **OPT-IN by default**: users
must set `SAFARI_PILOT_ENABLE_PAYWALL_DISMISS=true` to activate them. Default
install does not dismiss paywalls. Two engineering reviews independently
flagged the inclusion as the highest-residual-risk decision; the opt-in
default-off behavior was the agreed compromise.

Each pattern dismisses ONLY the overlay element; server-side gating is not
bypassed. Overlays may re-render on subsequent scroll/click. Mitigations:
6 total — kill switch via `SAFARI_PILOT_DISABLE_OVERLAY_DISMISS=true`,
paywall opt-in flag, two-signal pattern rule, per-pattern negative-fixture
tests, per-dismissal audit log, IdpiAnnotator scan extension. Any pattern
can be removed in a content-only patch without an extension rebuild.

### Patch propagation — user action required

Content-only patches via `npm publish`. **Users must run `npm update safari-pilot`**
to pick up patches; propagation is not silent.

### Carry-forward to v0.1.33

- **`daemon/Models.swift` `AnyCodable.encode` bool/int coercion bug.**
  `case let bool as Bool` matches `NSNumber(value: 1)` before `Int`/`Double`,
  so integer 0/1 values round-trip as `false`/`true`. Surfaced by v0.1.31
  Task 7 e2e; tests use an `asInt()` normalizer pattern as a workaround.
  Fix needs scoped sprint with regression coverage.
- **Allowlist pattern over-broadness flags:** `generic-newsletter-modal`
  (signals can match user's own newsletter management UI),
  `generic-aria-cookie` (primary selector embeds aria-label test, weakening
  two-signal independence), pattern collision between `generic-newsletter-modal`
  and `substack-bottom-banner`. Documented per-fixture; tighten with
  fingerprint-based ordering or specific-to-general matching.
- **`.skipped[]` field-level sanitization.** Currently passes through raw;
  `click_failed.candidate.hint` includes DOM exception messages. IdpiAnnotator
  scans the response text but doesn't strip; consider parallel explicit-field
  map matching the `dismissed[]` sanitization.
- **Outer try/catch in dismiss intercept tags JSON.parse failures as
  `NO_LOCATOR`** — semantic mismatch; should distinguish malformed-sentinel
  from locator-not-loaded.

### Rollback

- **Tag revert:** `git revert v0.1.32` → users on v0.1.30/v0.1.29 unaffected.
- **Allowlist content patch:** publish a patched npm tarball (no extension
  rebuild). Users must `npm update safari-pilot` to pick up.
- **Tool kill (per-user):** `SAFARI_PILOT_DISABLE_OVERLAY_DISMISS=true` env var.
- **Paywall kill:** paywalls ship opt-in (default off); no rollback needed
  unless a default-on accidental ship.

---

## v0.1.30 (2026-05-08)

### BREAKING

- **`safari_take_screenshot` now captures only the Safari WebView**, not the entire screen.
  - Implementation switched from macOS `screencapture` CLI to the Safari Web Extension's
    `tabs.captureVisibleTab` API. Output is the rendered viewport of the target tab,
    at the display's native devicePixelRatio (Retina captures are 2× viewport pixels).
  - Previous behavior (v0.1.29 and earlier) captured whatever was frontmost on the screen
    at capture time — almost never Safari during automated benchmarks. The tool name was
    always Safari-specific; the implementation finally matches.
  - **If you relied on whole-screen capture**, downgrade to v0.1.29 or file an issue
    requesting a separate `safari_take_full_screen_screenshot` tool.
  - `format='jpeg'` is now rejected with `INVALID_PARAMS`. Previous releases silently
    accepted jpeg and returned PNG.

### Added

- New error codes: `WINDOW_CLOSED`, `CAPTURE_RACE`, `CAPTURE_FAILED`, `INVALID_PARAMS`.
- New `requiresViewportCapture` flag in `ToolRequirements`; matching `viewportCapture`
  in `EngineCapabilities`. Engine selector routes any viewport-capture tool to the
  extension engine, throwing `EngineUnavailableError` when the extension is offline.
- WebVoyager harness: two-tier screenshot capture protocol (agent self-capture + post-hoc
  fallback) with `capture_failure_rate` field in scoreboard, separate from `success_rate`.
- WebVoyager harness: `CAPTURE_SOURCE: agent|posthoc|none` marker in transcripts for
  post-mortem tier-ratio analysis.
- `scripts/build-extension.sh --skip-notarize` flag (and `SKIP_NOTARIZE=1` env var) for
  local dev iteration without the 30+ min Apple notarization wait. CI release path
  ignores the flag — full notarization stays mandatory for shipped releases.

### Fixed

- WebVoyager benchmark screenshots no longer show the bench runner's terminal output.
  Root cause: `screencapture` with no window-targeting flag captured the entire screen,
  whatever window was frontmost. Diagnosed when the v0.1.29 dev-sample baseline halted
  at 36/175 with every failure attributed to "terminal output unrelated to the task" —
  the agent's text answer was correct but the screenshot was the bench runner's stdout.
- WebVoyager harness: stale screenshot detection. Adapter now `unlink`s the deterministic
  screenshot path BEFORE each capture, so `existsSync` correctly reflects whether THIS
  run wrote a file (vs. inheriting a previous run's file at the same path).
- `ScreenshotPolicy` (T59) error path: now propagates `SCREENSHOT_BLOCKED` as a
  thrown error envelope rather than the previous degraded-response shape. Test updated
  to match.

### Internal

- Extension: new `__SP_TAKE_SCREENSHOT__` sentinel in `executeCommand` (alongside
  `__SP_LIST_FRAMES__`, `__SP_DNR_*`). Activates target tab in its window via
  `tabs.update({active:true})` (no Safari foregrounding), polls up to 5×40ms to verify
  activation, captures, then restores prior active tab in `finally`.
- Sentinel returns base64 PNG in `result.value` on success; structured error names
  (`WINDOW_CLOSED`, `CAPTURE_RACE`, `CAPTURE_FAILED`) on failure. Existing
  `findTargetTab` continues to surface `TAB_NOT_FOUND` before the sentinel runs.
- `ExtractionTools` constructor no longer accepts a `screencaptureRunner` DI parameter.
  `defaultScreencaptureRunner` and `import * as childProcess` removed.
- E2E: new `test/e2e/screenshot-webview.test.ts` with 5 assertions: red-pixel
  WebView proof (≥95% red on a localhost #ff0000 fixture), no-Safari-foregrounding,
  TAB_NOT_FOUND on closed tabs, p95 latency < 1000ms over 20 captures, image/png
  payload shape.

### Baseline (v0.1.30 dev-sample, partial)

Halted at 67/175 tasks when Anthropic Max subscription quota refreshed. Partial data:

| Metric | Value |
|---|---|
| Tasks scored | 67 |
| SUCCESS | 38 (56.7%) |
| FAILURE | 22 (32.8%) |
| UNKNOWN (capture failed) | 7 (10.4%) |
| Tier-1 (agent self-capture) | 50 (75%) |
| Tier-2 (post-hoc fallback) | 10 (15%) |
| Tier-3 (no capture) | 7 (10%) |

Per-site (where halted):
- Allrecipes: **12/12 (100%)**
- Amazon: ~5/12 (~42%) — Amazon's bot wall causes ~3-5 silent timeouts per run
- Apple: 3/12 (25%) — strict judge interpretation on marketing pages
- ArXiv: 7/11 (64%)
- BBC News: ~5/9 (~56%)
- Booking: 3/5 partial

Headwinds NOT addressed by this release (separate work):
- `claude -p` silent hangs on bot-wall sites (Amazon especially)
- Safari locale leakage routing to non-en_US Amazon/Google pages
- Agent under-reporting in `FINAL_ANSWER` despite having full data

The remaining 108 tasks will be run with `--resume` once Max quota refreshes.

### Rollback

If this release is broken on a Safari version we didn't test:
- `npm install safari-pilot@0.1.29` returns to whole-screen `screencapture` behavior
- Open an issue describing what broke

---

For older releases, see git history.
