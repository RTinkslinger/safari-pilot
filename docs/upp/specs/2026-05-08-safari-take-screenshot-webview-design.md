# safari_take_screenshot — WebView capture via extension

**Date:** 2026-05-08
**Sprint:** v0.1.30
**Status:** approved (brainstorming + leadership review complete; awaiting plan)
**Origin:** WebVoyager v0.1.29 dev-sample serial run halted at 36/175 because every post-hoc judge screenshot showed the bench runner's terminal output instead of Safari, deflating the baseline.
**Critical-path declaration:** This is the v0.1.30 sprint critical path. Phase 2 (v0.1.29 dev-sample baseline) and every downstream gate (B, C, ship-gate) cannot run until this lands. Any plan-time triage trades against the entire sprint timeline.

## Problem

`safari_take_screenshot` shells out to macOS `screencapture` with no window-targeting flag (`screencapture -x -t png file.png` in `src/tools/extraction.ts:5-14 defaultScreencaptureRunner`). That captures the entire screen — whatever was frontmost at capture time, almost never Safari during a long benchmark. The tool's own description says "Capture a screenshot of the frontmost Safari window via the screencapture CLI," but the implementation cannot constrain to Safari at all; the `tabUrl` parameter is documented as *"does not retarget screencapture."*

Effect: WebVoyager judge sees terminal output instead of the agent's page → marks tasks FAILURE even when the agent answered correctly. ~5 of 9 Amazon tasks in the partial run, and confirmed site-independent on Apple — every site is affected.

## Goal

Replace the implementation of `safari_take_screenshot` so it captures the rendered viewport of a specific Safari tab via the Web Extension's `browser.tabs.captureVisibleTab` API. Same input shape, same output shape, fixed semantics. No fallback. Strict drop-in.

## Success criteria

User-outcome metrics (verified by the next overnight run AFTER this lands):

1. **Screenshot-invalidation rate (judge sees wrong content) < 2%** measured as: judge_reasoning containing the regex `terminal output|unrelated to the task|screenshot does not show` over total tasks. Baseline rate in the 36-task partial run: ~28% (10 of 36 tasks). The fix should drive this near-zero on tasks where capture succeeds; residual cases would be edge tabs or pages mid-load.
2. **Capture-failure rate (capture didn't fire — UNKNOWN verdict) < 5%** measured as: scoreboard `capture_failure_rate` field. These are tasks where TAB_NOT_FOUND, WINDOW_CLOSED, CAPTURE_RACE, or CAPTURE_FAILED bubbled up. Honest accounting of when our capture path can't get pixels.
3. **No judge crashes.** ENOENT-on-screenshot errors = 0. The runner's null-path gate ensures judge is never called with a missing file.
4. **Per-task overhead added by capture < 1 second p95.** Capture path replaces a ~50ms `screencapture` with an extension round-trip. Budget: 250ms p50 / 1000ms p95.
5. **Bench-run produces a defensible baseline number** citable in v0.1.30 Gate C and externally as v0.1.29 ship-gate.

### Headwinds NOT addressed by this fix (called out so the baseline is read honestly)

- **Silent-hang failures.** ~3 of 36 partial-run tasks had `claude -p` produce no output for the 240s timeout — likely Amazon bot walls or `claude -p` MCP startup hang on specific page loads. These will continue to count as FAILURE in the next baseline. Headwind ~3-8% on absolute success rate, separate fix.
- **Locale leakage.** Some sites (Amazon → amazon.in, Google → google.in) routed by Safari's default locale produce non-English content the agent answers in INR/Hindi, which then mismatches WebVoyager ground truth. Separate fix (locale config in Safari Pilot's session window or per-task locale override).
- **Agent under-reporting in FINAL_ANSWER.** Cases like Allrecipes--13 where the agent collected complete data but only emitted partial in the answer string. Prompt-template issue in `bench/webvoyager/adapter.ts buildPrompt()`. Separate fix.

These three together account for ~5–10% of the v0.1.29 absolute success rate. Reading the baseline number after this fix lands: subtract ~5–10pp from the implied "true product capability" upper bound.

## Non-goals (v1)

- JPEG output, quality parameter, format selection of any kind
- Full-page (scroll-and-stitch) capture
- Element-clip / region capture
- Removing dead imports beyond what the rewrite directly orphans
- Daemon trace events for capture lifecycle (`cap_received`/`cap_completed`) — defer to a follow-up observability roadmap item; existing engine-result trace covers the critical path
- Concurrent-call serialization at the tool layer (caller responsibility; concurrency=1 in the bench, harness must serialize at higher concurrency)

## Design decisions (locked from discovery)

| Decision | Choice |
|---|---|
| When the target tab is not the active tab in its window | Briefly activate via `browser.tabs.update({active:true})`, **then verify it became active before capturing** (poll `tabs.query({windowId, active:true})` up to 5×40ms; throw `CAPTURE_RACE` if it never becomes active). Capture, restore previous active tab in `finally`. No Safari `app.activate()`. Visible flicker only if the user is actively looking at that exact Safari window at that exact moment. |
| When capture cannot succeed | Return structured error. Codes: `TAB_NOT_FOUND` (existing — pre-sentinel `findTargetTab` failure), `WINDOW_CLOSED` (`tab.windowId == null` at sentinel entry), `CAPTURE_RACE` (new — active-tab activation didn't take), `CAPTURE_FAILED` (any other captureVisibleTab rejection). No fallback to `screencapture`. Caller decides. |
| `format` parameter | **Reject** `format !== 'png'` with `INVALID_PARAMS` error. Old behavior accepted `'jpeg'` and silently returned PNG; that's user-hostile. v1 honest: png-only, explicit rejection of other values. Schema docs the constraint. |
| Retina DPR | **Accept native devicePixelRatio output** without downscaling. On a 2× retina display a 1280×720 viewport returns 2560×1440 PNG (~4× file size of 1×). WebVoyager judge handles it; vision-token cost is acceptable. Documented in the tool description. |
| v1 scope | Strict drop-in: visible viewport, PNG only. No format/quality/full-page/clip. |
| Wiring | Sentinel `__SP_TAKE_SCREENSHOT__` via existing `engine.executeJsInTab(tabUrl, sentinel)`. Same pattern as `__SP_LIST_FRAMES__`, `__SP_DNR_*`, `__SP_PACK_*`. New `requiresViewportCapture: boolean` in `ToolRequirements` (tool-side) plus matching `viewportCapture: boolean` in `EngineCapabilities` (engine-side). `requiresExtension()` updated to include the new flag in its `\|\|`-chain. `ENGINE_CAPS.extension.viewportCapture = true`; `applescript` and `daemon` set false. Engine selector throws `EngineUnavailableError` when no engine matches. |
| Harness null-handling (in scope) | Bench harness detects capture failure (tool throws OR `existsSync(path) === false`) and writes `screenshot_path: null` to the score. **The judge is SKIPPED entirely when screenshot is null** (NOT called text-only) — the WebVoyager judge prompt is screenshot-mandatory ("the content of the screenshot prevails"); a no-image call would either break upstream parity or trick the judge into returning NOT SUCCESS based on prompt-internal logic. Skipped tasks get `verdict: 'UNKNOWN'`, `judge_reasoning: 'screenshot capture failed: <code>'`. Scoreboard counts UNKNOWN tasks toward `tasks_total` but NOT `tasks_success`; success_rate is reported as `success / total` (capture failures depress the rate honestly) AND a separate `capture_failure_rate` metric is added (`unknown / total`). |

## Components touched

### Production code
```
extension/background.js                — add __SP_TAKE_SCREENSHOT__ sentinel branch in executeCommand
src/tools/extraction.ts                — rewrite handleTakeScreenshot; remove screencaptureRunner field/type/default-fn; add format='png' validation; add requirements flag in getDefinitions
src/types.ts                           — add requiresViewportCapture?: boolean to ToolRequirements AND viewportCapture?: boolean to EngineCapabilities
src/engine-selector.ts                 — set viewportCapture: true on ENGINE_CAPS.extension (false on others); update requiresExtension() \|\|-chain to include requiresViewportCapture
src/errors.ts                          — add WINDOW_CLOSED + CAPTURE_RACE + CAPTURE_FAILED to ERROR_CODES (TAB_NOT_FOUND already exists)
src/server.ts                          — drop the third arg from `new ExtractionTools(...)` calls (lines 267, 401)
src/benchmark/runner.ts                — no change (safari_take_screenshot still listed in surface; behavior is engine-internal)
extension/manifest.json                — version bump only (tabs + <all_urls> already granted)
package.json                           — version bump
```

### Bench harness changes (in v1 scope, see Decision 7)
```
bench/webvoyager/adapter.ts            — captureScreenshotPostHoc returns {path: string \| null, errorCode?: string}
bench/webvoyager/runner.ts             — when adapter returns null path, write score with verdict='UNKNOWN', judge_reasoning='screenshot capture failed: <code>', skip judge call entirely
bench/webvoyager/judge.ts              — NO change to its signature; runner's gate ensures judge is only called when screenshotPath is a string
bench/webvoyager/types.ts              — WebVoyagerScore.screenshot_path: string \| null  (downstream parsers must handle null)
bench/webvoyager/score.ts              — aggregateScoreboard adds `capture_failure_rate` field (unknown / total); success_rate stays (success / total) — UNKNOWN counted in denominator
```

### Build script change (added scope from adversarial review)
```
scripts/build-extension.sh             — add --skip-notarize flag (or SKIP_NOTARIZE=1 env var). When set: skip xcrun notarytool submit + stapler block; produce a signed-but-unnotarized .app for local dev iteration. CI release (release.yml) leaves the flag off — full notarization runs on tag push as before.
```

### Tests changed/replaced
```
test/unit/tools/take-screenshot-policy.test.ts          — REPLACE: old test uses screencaptureRunner DI which is being removed. New test mocks IEngine.executeJsInTab to return a base64 string; asserts handler decodes it, writes file, returns image content. Also asserts ScreenshotPolicy still gates by tabUrl BEFORE engine call.
test/unit/tools/extraction-screenshot-schema.test.ts    — UPDATE: schema must reject format !== 'png'; add assertion on the new constraint.
test/unit/tools/extraction-requirements.test.ts         — UPDATE: assert safari_take_screenshot has requiresViewportCapture: true.
test/unit/engine-selector/*.test.ts                     — extend: assert requiresExtension() returns true for {requiresViewportCapture: true}; selectEngine routes to extension.
test/e2e/T43-observation-tools.test.ts                  — UPDATE: existing assertion ("returns a non-empty PNG") still holds; add stronger assertion (red-pixel fixture; see Testing section).
test/e2e/phase1-core-navigation.test.ts                 — UPDATE: same — existing assertion holds; new red-pixel proof.
test/e2e/security-layers.test.ts                        — UPDATE: SCREENSHOT_BLOCKED policy test still holds (policy runs BEFORE engine call); verify path still raises before the new engine round-trip.
```

### Tests added
```
test/unit/tools/extraction-screenshot-handler.test.ts   — NEW: handler-level unit test (mocks IEngine only). Covers: png-only validation, ENOENT path-write fail propagation, base64 decode, error-code propagation through result.error.code.
test/e2e/screenshot-webview.test.ts                     — NEW: opens localhost fixture serving solid red 800×600, captures, asserts dominantly red pixels in PNG. Asserts frontmost app unchanged before/after. Asserts TAB_NOT_FOUND on closed-tab attempt. Asserts inactive-window capture works with prev-active restored.
```

### Constructor consumer enumeration (verified by grep)
```
src/server.ts:267, 401                                                    PROD — drop 3rd arg
test/unit/tools/take-screenshot-policy.test.ts:55                         REPLACE the test file
test/unit/tools/extraction-requirements.test.ts:34                        already 1-arg, no change
test/unit/tools/chain-schema-wiring.test.ts:24                            already 1-arg, no change
test/unit/tools/extraction-screenshot-schema.test.ts:25                   already 1-arg, no change
test/unit/tools/extraction-query-all.test.ts:17                           already 1-arg, no change
test/unit/tools/frame-aware-tools-routing.test.ts:73                      already 1-arg, no change
```

## Data flow (post-hoc benchmark capture, end-to-end)

```
WebVoyager runner (bench/webvoyager/adapter.ts)
  └─ captureScreenshotPostHoc(snapshot, path)              [unchanged]
      └─ TinyMcpClient (harness MCP, BYPASS_OWNERSHIP=1)   [unchanged]
          └─ tools/call: safari_take_screenshot {tabUrl, path}
              └─ src/server.ts → security pipeline
                  └─ engine selection: requiresViewportCapture=true → ExtensionEngine
                      └─ engine.executeJsInTab(tabUrl, '__SP_TAKE_SCREENSHOT__')
                          └─ daemon HTTP /poll → extension storage bus (sp_cmd_<id>)
                              └─ extension/background.js executeCommand(cmd)
                                  ├─ findTargetTab(tabUrl)  // throws TAB_NOT_FOUND if missing
                                  ├─ if cmd.script === '__SP_TAKE_SCREENSHOT__':
                                  │   ├─ remember prev active tab in window
                                  │   ├─ tabs.update(target.id, {active:true})  // no app activate
                                  │   ├─ tabs.captureVisibleTab(windowId,{format:'png'})
                                  │   ├─ {ok:true, value: <base64>}
                                  │   └─ finally: restore prev active
                                  └─ daemon /result HTTP
              ◄── EngineResult.value = base64 string
          ◄── tool returns {content:[{type:'image', data, mimeType:'image/png'}],
                            metadata:{engine:'extension', latencyMs}}
              + writes file at `path` if provided
```

## Component-level changes

### `extension/background.js`

Inserted after the existing `__SP_DNR_*` sentinel block in `executeCommand` (~line 360, after the tab-found check):

```javascript
if (cmd.script === '__SP_TAKE_SCREENSHOT__') {
  let prevActiveTabId = null;
  try {
    if (tab.windowId == null) {
      throw { name: 'WINDOW_CLOSED', message: 'tab.windowId missing' };
    }

    // Snapshot the previous active tab so we can restore it.
    const prevActive = await browser.tabs.query({ windowId: tab.windowId, active: true });
    prevActiveTabId = prevActive[0]?.id ?? null;

    // Activate the target tab if it isn't already active. Then verify the
    // activation actually took before capturing — `tabs.update` resolves before
    // Safari's internal active-tab state settles, and another tab can become
    // active between our update and our capture (page-driven focus, user
    // click). Without verification, captureVisibleTab returns whatever IS
    // active at call time, not what we asked for.
    if (prevActiveTabId !== tab.id) {
      await browser.tabs.update(tab.id, { active: true });

      // Poll up to 5×40ms = 200ms total. Empirical: Safari's active-tab event
      // fires in <50ms in normal conditions; 200ms covers slow contention.
      let activated = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise((r) => setTimeout(r, 40));
        const check = await browser.tabs.query({ windowId: tab.windowId, active: true });
        if (check[0]?.id === tab.id) { activated = true; break; }
      }
      if (!activated) {
        throw { name: 'CAPTURE_RACE', message: 'target tab did not become active within 200ms' };
      }
    }

    const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const commaIdx = dataUrl.indexOf(',');
    const base64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;

    const result = { ok: true, value: base64 };
    await updatePendingEntry(commandId, { status: 'completed', result });
    return result;
  } catch (e) {
    const errName = e?.name && typeof e.name === 'string' ? e.name : 'CAPTURE_FAILED';
    const result = { ok: false, error: { name: errName, message: e?.message ?? String(e) } };
    await updatePendingEntry(commandId, { status: 'completed', result });
    return result;
  } finally {
    if (prevActiveTabId != null && prevActiveTabId !== tab.id) {
      try { await browser.tabs.update(prevActiveTabId, { active: true }); } catch { /* tab may have closed during capture */ }
    }
  }
}
```

`findTargetTab(cmd.tabUrl)` runs above the sentinel block; the existing `TAB_NOT_FOUND` error path already covers the missing-tab case (no new TAB_CLOSED code introduced).

### `src/tools/extraction.ts handleTakeScreenshot` (rewrite)

```typescript
private async handleTakeScreenshot(params: Record<string, unknown>): Promise<ToolResponse> {
  const tabUrl = params['tabUrl'] as string | undefined;
  if (!tabUrl) throw new Error('tabUrl required');

  // v1: png-only. Reject other formats explicitly rather than silently lying.
  const requestedFormat = params['format'];
  if (requestedFormat !== undefined && requestedFormat !== 'png') {
    const err = new Error(`format='${String(requestedFormat)}' not supported in v1; only 'png' is accepted`);
    (err as Error & { code?: string }).code = 'INVALID_PARAMS';
    throw err;
  }

  if (this.screenshotPolicy) this.screenshotPolicy.checkDomain(tabUrl);

  const start = Date.now();
  const savePath = params['path'] as string | undefined;

  const result = await this.engine.executeJsInTab(tabUrl, '__SP_TAKE_SCREENSHOT__', 30_000);
  if (!result.ok) {
    // result.error.code is lifted from the extension's error.name by ExtensionBridge.
    // Propagate cleanly so formatToolError upstream maps to a typed ToolError.
    const err = new Error(`Screenshot failed: ${result.error?.message ?? 'unknown'}`);
    if (result.error?.code) (err as Error & { code?: string }).code = result.error.code;
    throw err;
  }

  const base64 = result.value;
  if (typeof base64 !== 'string' || base64.length === 0) {
    const err = new Error('Screenshot returned empty payload');
    (err as Error & { code?: string }).code = 'CAPTURE_FAILED';
    throw err;
  }

  if (savePath) {
    const buf = Buffer.from(base64, 'base64');
    await writeFile(savePath, buf);
  }

  return {
    content: [{ type: 'image', data: base64, mimeType: 'image/png' }],
    metadata: { engine: 'extension' as Engine, degraded: false, latencyMs: Date.now() - start },
  };
}
```

Constructor signature changes:

```typescript
// Before
constructor(engine: IEngine, screenshotPolicy?: ScreenshotPolicy, screencaptureRunner: ScreencaptureRunner = defaultScreencaptureRunner)
// After
constructor(engine: IEngine, screenshotPolicy?: ScreenshotPolicy)
```

`screencaptureRunner` field, `ScreencaptureRunner` type, `defaultScreencaptureRunner` function, and `import * as childProcess from 'node:child_process'` are deleted. `tmpdir`, `unlink`, `join`, and the existing `readFile` import are evaluated for other-handler use; remove only those orphaned by the rewrite.

`getDefinitions()` entry for `safari_take_screenshot`:

```typescript
{
  name: 'safari_take_screenshot',
  description: 'Capture a PNG of the visible Safari WebView for the given tab. ' +
    'Briefly activates the tab in its window (does not bring Safari to foreground), ' +
    'captures via the extension API, and restores the previously active tab. ' +
    'Output PNG is at the display\'s native devicePixelRatio (Retina captures are 2× viewport pixels). ' +
    'Requires the Safari Pilot extension to be installed and enabled. ' +
    'BREAKING in v0.1.30+: replaces the previous whole-screen screencapture behavior with WebView-only capture.',
  inputSchema: {
    type: 'object',
    properties: {
      tabUrl: { type: 'string', description: 'URL of the tab to capture (required).' },
      format: { type: 'string', enum: ['png'], description: 'Image format. v1 only accepts png; non-png values are rejected.' },
      path:   { type: 'string', description: 'Optional filesystem path. If provided, the PNG is also written to this path.' },
    },
    required: ['tabUrl'],
    additionalProperties: false,
  },
  requirements: { requiresViewportCapture: true },
}
```

### `src/types.ts`

Two type updates — the codebase uses distinct shapes for tool-side requirements (`requires*` prefix) and engine-side capabilities (no prefix):

```typescript
export interface ToolRequirements {
  // ...existing requires* flags...
  requiresViewportCapture?: boolean;
}

export interface EngineCapabilities {
  // ...existing flat caps: shadowDom, cspBypass, dialogIntercept, etc...
  viewportCapture?: boolean;
}
```

### `src/engine-selector.ts`

Two changes:

```typescript
export const ENGINE_CAPS: Record<Engine, EngineCapabilities> = {
  extension: {
    /* ...existing... */
    viewportCapture: true,
  },
  daemon:      { /* unchanged — defaults false/undefined */ },
  applescript: { /* unchanged — defaults false/undefined */ },
};

export function requiresExtension(tool: ToolRequirements): boolean {
  return !!(
    tool.requiresShadowDom ||
    tool.requiresCspBypass ||
    tool.requiresDialogIntercept ||
    tool.requiresNetworkIntercept ||
    tool.requiresCookieHttpOnly ||
    tool.requiresFramesCrossOrigin ||
    tool.requiresAsyncJs ||
    tool.requiresViewportCapture        // ← new
  );
}
```

`selectEngine()` itself needs no change — it consumes `requiresExtension(tool)` which now covers the new flag.

### `src/errors.ts`

```typescript
export const ERROR_CODES = {
  /* ...existing... */
  WINDOW_CLOSED:  { retryable: false, hints: ['The Safari window containing this tab was closed.'] },
  CAPTURE_RACE:   { retryable: true,  hints: ['Another tab became active during capture. Retry; if persistent, reduce concurrent activity in this Safari window.'] },
  CAPTURE_FAILED: { retryable: true,  hints: ['Capture API failed. Verify Safari extension is enabled and the page is fully loaded.'] },
  // INVALID_PARAMS may already exist; if not, add it.
};
```

`TAB_NOT_FOUND` already exists.

## Known residual issues (accepted)

- **Race fix has residual TOCTOU.** Between the activation-poll confirming "target is active" and `captureVisibleTab` firing, the active tab can change again (one event-loop tick). The poll narrows the window from ~50ms to ~5ms but cannot eliminate it. Tests treat occasional `CAPTURE_RACE` as expected (not flake) at concurrency=1 in idle conditions; threshold > 1% over 100 captures = real bug.
- **Concurrent calls on tabs in the same window will race-toggle.** v1 contract: caller serializes. Bench runs concurrency=1, so this is moot for WebVoyager. Documented in the tool description and CHANGELOG.

## Rollback plan

If v0.1.30 ships and the new capture path is broken on a Safari version we didn't test (16.4 vs 17.x quirks), or has regression on a real consumer flow:

1. **Immediate user mitigation:** users downgrade to the previous published version (`npm install safari-pilot@<previous>`). Old whole-screen behavior returns. Documented in CHANGELOG with the exact previous version string.
2. **Hotfix path:** patch release `<VERSION>.1` that re-introduces a `safari_take_screenshot_legacy` tool with the old screencapture behavior, while keeping the new capture as default. Deferred — only build if a real consumer reports breakage. Do NOT pre-build a feature flag for "in case" — that's exactly the unrequested-flexibility anti-pattern.

## Invariants

1. **No Safari foregrounding.** Never call AppleScript `tell application "Safari" to activate`. Tab activation within a window via `browser.tabs.update({active:true})` does not bring Safari to front per WebExtensions spec.
2. **Restore-on-error.** `finally` block restores `prevActiveTabId` even on capture failure. Try/catch around the restore itself absorbs "tab closed" exceptions silently.
3. **Failure shape consistency.** Errors return `{ok:false, error:{name, message}}` from the extension. `daemon/Sources/SafariPilotd/ExtensionBridge.swift handleResult` lifts `name` into `StructuredError.code`. TS engine surfaces it as `EngineResult.error.code`. Tool's `formatToolError` upstream maps to `ToolError`.
4. **Backward-compat shape.** Tool input schema unchanged: `{tabUrl, format?, path?}`. `format` is accepted but only `'png'` is honored — `format='jpeg'` does NOT error in v1; it returns PNG silently. Output unchanged: `{content:[{type:'image', data, mimeType}], metadata:{engine, degraded, latencyMs}}`.

## Error codes (full table)

| Code | Cause | Retryable |
|---|---|---|
| `INVALID_PARAMS` | `format` provided and not `'png'` | false (caller bug) |
| `TAB_NOT_FOUND` | `findTargetTab(tabUrl)` returns null (existing path; pre-sentinel) | false |
| `WINDOW_CLOSED` | `tab.windowId` is null at sentinel entry | false |
| `CAPTURE_RACE` | Activation didn't take within 200ms (5 polls × 40ms) | true |
| `CAPTURE_FAILED` | `captureVisibleTab` rejected, OR any other thrown exception with no `.name`, OR empty base64 returned | true |
| `SCREENSHOT_BLOCKED` | `ScreenshotPolicy.checkDomain(tabUrl)` rejected the domain (pre-existing path; runs BEFORE engine call) | false |

## Testing

### Preflight (verifies before touching production code)
Before writing the full sentinel handler, prove `tabs.captureVisibleTab` works on this Safari version with the current manifest permissions. ~10 lines: open a tab via the harness MCP, call a temporary `__SP_PREFLIGHT_CAPTURE__` sentinel that returns the base64 length, assert > 0. If this fails, the entire approach is dead and we need to revisit Option A (screencapture window-ID) before further work.

### Unit
| Test | Location | Mocks (allowed) |
|---|---|---|
| Handler throws on `result.ok=false`, propagates `result.error.code` to thrown error's `.code` | `test/unit/tools/extraction-screenshot-handler.test.ts` (new) | `IEngine.executeJsInTab` only |
| Handler rejects `format='jpeg'` with `INVALID_PARAMS` and does NOT call engine | same | `IEngine.executeJsInTab` (assert never called) |
| Handler decodes base64 string, writes file at `path` if provided, returns `{type:'image', data, mimeType:'image/png'}` | same | `IEngine.executeJsInTab` (returns fake base64) |
| Handler ENOENT on bad path bubbles as exception (does not silently succeed) | same | `IEngine`, `fs.writeFile` |
| `requiresExtension({requiresViewportCapture: true})` returns true | extend `test/unit/engine-selector/*.test.ts` | none |
| `selectEngine` routes a viewport-capture tool to `'extension'` engine; throws `EngineUnavailableError` when extension not available | same | none |
| `safari_take_screenshot` definition has `requirements.requiresViewportCapture === true` | update `test/unit/tools/extraction-requirements.test.ts` | none |
| `safari_take_screenshot` schema enforces `format: enum(['png'])` and `additionalProperties: false` | update `test/unit/tools/extraction-screenshot-schema.test.ts` | none |
| `take-screenshot-policy` test REPLACED: ScreenshotPolicy still gates BEFORE engine call (verify policy rejection short-circuits engine invocation entirely) | rewrite `test/unit/tools/take-screenshot-policy.test.ts` | `IEngine`, `ScreenshotPolicy.checkDomain` |

Per project HARD RULE in CLAUDE.md "Unit Tests": unit tests may mock Node boundaries and the IEngine contract; never `vi.mock('../../src/...')`. Tests above conform.

### E2E (real Safari + daemon + extension; no mocks)
File: `test/e2e/screenshot-webview.test.ts` (new) plus updates to existing screenshot e2es.

**Strong proof — red-pixel fixture.** A localhost test fixture serves an HTML page with `body { background: #ff0000 }` and a known viewport (`<meta viewport>` with width=800). The test:
1. Opens a new tab to `http://localhost:<port>/red.html` via `safari_new_tab`.
2. **Waits for `document.readyState === 'complete'`** via `safari_wait_for` (NOT a fixed sleep — fonts/CSS can delay paint asymmetrically; sleeping is flaky).
3. Calls `safari_take_screenshot { tabUrl }`.
4. Decodes PNG, samples ≥100 random pixels.
5. **Asserts ≥95% of sampled pixels have red dominance (R > 200, G < 50, B < 50).**

This is the only assertion that proves we got Safari's WebView and not the screen. Dimension-only checks fail under Retina. Replaces the fuzzy "dimensions ≤ screen" approach.

| Test | Asserts |
|---|---|
| **Red-pixel fixture (above)** | Captured PNG is dominantly red — proves WebView capture, not whole-screen |
| **No Safari foregrounding** | Precondition asserts frontmost app is NOT "Safari" (test runner / Terminal / Code). Capture runs. Postcondition asserts frontmost app is STILL not "Safari." This pattern tolerates Calendar/Slack/etc. notification interruptions that can transiently steal focus during the e2e — false-positive on equality of frontmost-app-name strings is too easy. |
| **TAB_NOT_FOUND on closed tab** | Open tab, close it, call `safari_take_screenshot` with the dead URL → throws `TAB_NOT_FOUND` |
| **Inactive-window capture** | Open window A (frontmost), open agent's tab in window B (background), capture from window B → succeeds; window A's frontmost-state and active-tab unchanged |
| **Active-tab restore** | In window B, set tab T1 active, run capture on T2 → after the call, T1 is active again in window B |
| **CAPTURE_RACE survivability** | Concurrency=1 in this test (we don't probe concurrency safety in v1). Single-call should never produce CAPTURE_RACE in normal conditions; if it appears in CI, treat as flake threshold > 1% as a real bug. |
| **SCREENSHOT_BLOCKED policy still works** | `test/e2e/security-layers.test.ts:133`-style: configure a blocked domain, call tool with that URL, assert `SCREENSHOT_BLOCKED` BEFORE the engine round-trip happens (verify by daemon trace count = 0 for `__SP_TAKE_SCREENSHOT__`) |
| **Latency target** | Capture wall < 1000ms p95 over 20 sequential captures on an idle local fixture |

Per project HARD RULE: spawns real `node dist/index.js` MCP server, real daemon, real Safari. No `vi.mock`. Pre-commit hook `hooks/e2e-no-mocks.sh` enforces this.

## Distribution

Two paths — dev-loop (local validation, fast) and release (canonical, slow). Plan must execute the dev-loop path BEFORE invoking the release pipeline.

### Dev-loop path (for fix validation, ~5–10 min wall)
Use this to validate the fix locally and run the overnight benchmark BEFORE shipping a public release. Avoids the notarization stall (Apple's notarization service can hang for 1+ hour).

**Prerequisite:** `scripts/build-extension.sh` must be modified to support `--skip-notarize` (or `SKIP_NOTARIZE=1`). Today the script unconditionally runs `xcrun notarytool submit ... --wait` at line 293, with no escape. Adding the flag is part of v1 plan scope (see Components Touched → Build script change). When the flag is set: skip the notarytool block AND the stapler block. CI release flow (release.yml) does NOT set the flag — full notarization stays mandatory for shipped releases.

1. `npm run build` (TypeScript)
2. `bash scripts/build-extension.sh --skip-notarize` — produces a signed-but-unnotarized `.app` in `bin/`.
3. `open "bin/Safari Pilot.app"` to register with Safari.
4. **Apply the unsigned-extensions enablement workaround** from project memory `reference_extension_enablement_workaround`:
   - Safari → Develop → Allow Unsigned Extensions (requires Develop menu enabled in Safari → Settings → Advanced → "Show features for web developers")
   - Settings → Extensions → enable Safari Pilot
   - Quit Safari, reopen — extension persists
5. Run `claude -p "List the safari_* tools available to you"` from repo root — confirm `safari_take_screenshot` appears.
6. Smoke test: `claude -p "Use safari_new_tab to open https://example.com, then use safari_take_screenshot on it; reply DONE."` — visually inspect the resulting PNG. Use a fresh Safari window or separate profile to keep this isolated from the user's real tabs.
7. Run a single WebVoyager task end-to-end (`bash bench/webvoyager/run.sh --variant smoke --tasks-file <one-task.jsonl>`). Verify the score's `screenshot_path` resolves to a file that visually shows the agent's tab content.
8. Once validated, kick off the overnight 175-task v0.1.29 dev-sample.

### Release path (for canonical shipping, ~30–60 min wall + Apple notarization)
After dev-loop validation succeeds and overnight produces a clean baseline, ship a public release.

1. `npm run build` (TypeScript)
2. `bash scripts/build-extension.sh` (full pipeline: Xcode → archive → sign → notarize → staple → ditto with `--norsrc --noextattr --noqtn --noacl`)
3. Bump `package.json` version AND `extension/manifest.json` version — BOTH fields per `feedback-extension-version-both-fields`
4. Local rehearsal: `open "bin/Safari Pilot.app"` → enable in Safari → smoke-test `safari_take_screenshot` on a known tab via `claude -p`
5. `bash scripts/pre-tag-check.sh` — must print "ALL CHECKS PASSED — safe to tag"
6. Commit, tag, push → `release.yml` runs CI verify + GitHub Release + npm publish

The user's "Release SOP codified after the v0.1.24 publish disaster" applies in full to the release path.

### CHANGELOG language (for release path)
Replace `<VERSION>` with the actual version slot at release time (likely v0.1.30 per current plan, but plan-time decision):
```
<VERSION>
- BREAKING: safari_take_screenshot now captures only the Safari WebView via
  the Web Extension's tabs.captureVisibleTab API. Previous behavior
  captured the entire screen via macOS `screencapture` and was misnamed
  ("safari_..." but never actually constrained to Safari).
  - If you relied on the previous whole-screen capture behavior, file an issue
    — we'll surface a separate `safari_take_full_screen_screenshot` tool.
  - Output is now PNG-only. `format='jpeg'` is rejected with INVALID_PARAMS in
    v0.1.30+. Previous releases silently accepted jpeg and returned PNG.
  - PNG dimensions follow the display's native devicePixelRatio (Retina = 2× viewport).
- Adds error codes: WINDOW_CLOSED, CAPTURE_RACE, CAPTURE_FAILED.
```

## Roadmap item

To be created in Notion DB `2ccf9222-eb39-4093-9e76-ec408afedcba` before plan execution.

- **Item:** Fix safari_take_screenshot to capture Safari WebView via extension
- **Status:** Insight → In Progress when plan execution starts
- **Priority:** High (blocks WebVoyager baseline)
- **Epic:** v0.1.30 sprint
- **Source:** Bench harness diagnosis (2026-05-07 partial run)
- **Sprint#:** matches current TRACES milestone
- **Parallel Safety:** isolated (touches extension + tool handler; no shared state risk)

## Out of scope (deferred)

- JPEG / format / quality params (rejected in v1; can land later as separate roadmap item if a real consumer surfaces).
- Full-page (scroll-and-stitch) capture as a separate tool `safari_take_full_page_screenshot`.
- Element-clip capture as `safari_clip_element`.
- A `safari_take_full_screen_screenshot` tool that preserves the old whole-screen behavior — only build if a CHANGELOG-driven user request comes in.
- Daemon trace events (`cap_received`/`cap_completed`) for capture lifecycle observability — separate roadmap item.
- Capture concurrency-safety at the tool layer (e.g., serialize per-window). v1 contract: caller serializes; bench runs concurrency=1.

## Reverted from earlier draft (now in scope, see Components Touched)

- Bench harness null-screenshot handling (originally Approach C from brainstorming). Pulled into v1 because `bench/webvoyager/judge.ts:82 readFileSync` will throw on a missing screenshot file, swapping today's "wrong screenshot → judge sees garbage" for a new "missing screenshot → judge crash → conservative FAILURE." Same observable failure rate, different cause — not separable from this fix.
