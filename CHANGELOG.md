# Changelog

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
