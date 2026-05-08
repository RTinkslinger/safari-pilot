# Changelog

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
