# safari_take_screenshot — WebView Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the executing-plans skill to implement this plan task-by-task. Supports two modes: subagent-driven (recommended, fresh subagent per task with three-stage review) or inline execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `safari_take_screenshot`'s broken whole-screen `screencapture` implementation with WebView-only capture via the Safari Web Extension's `tabs.captureVisibleTab` API, plus the bench-harness null-handling and build-script changes the fix requires to be honest end-to-end.

**Architecture:** A new `__SP_TAKE_SCREENSHOT__` sentinel script in the existing extension dispatch pattern (alongside `__SP_LIST_FRAMES__`, `__SP_DNR_*`). The TS tool handler routes through `engine.executeJsInTab`, decoded base64 returns as the MCP image content. New `requiresViewportCapture` tool flag forces extension routing. Bench harness gates the judge call on screenshot success and reports `capture_failure_rate` separately from `success_rate`. Distribution adds a `--skip-notarize` flag to `build-extension.sh` for dev-loop iteration; full notarization stays mandatory for release.

**Tech Stack:** TypeScript (Node 20+), Safari Web Extension (manifest v3, JS), Swift daemon (passthrough — no changes), vitest (unit + e2e), real Safari + real daemon for e2e.

**Spec:** `docs/upp/specs/2026-05-08-safari-take-screenshot-webview-design.md`. Read it first.

**Critical-path declaration:** This is the v0.1.30 sprint critical path. The Phase 2 v0.1.29 dev-sample baseline cannot run honestly until this lands. The user has a halted partial run at `bench-runs/webvoyager-v0.1.29-baseline-20260507-232457.partial-screenshot-bug/` to compare against post-fix.

---

## Task 0: Branch + plan-driven roadmap entry

**Files:**
- Create: branch `feat/v0130-screenshot-webview` from `main`

- [ ] **Step 1: Create feature branch**

```bash
cd "/Users/Aakash/Claude Projects/Skills Factory/safari-pilot"
git checkout main
git status   # verify clean working tree (CHECKPOINT.md uncommitted is OK; it is gitignored if listed)
git pull --ff-only
git checkout -b feat/v0130-screenshot-webview
```

- [ ] **Step 2: Add Notion roadmap item**

Use the Notion MCP if loaded; otherwise tell the user to add manually:
- Database: `2ccf9222-eb39-4093-9e76-ec408afedcba`
- Item: "Fix safari_take_screenshot to capture Safari WebView via extension"
- Status: In Progress
- Priority: High
- Epic: v0.1.30 sprint
- Source: Bench harness diagnosis (2026-05-07 partial run)
- Branch: feat/v0130-screenshot-webview
- Technical Notes: "Replaces whole-screen screencapture with browser.tabs.captureVisibleTab via __SP_TAKE_SCREENSHOT__ sentinel. Spec: docs/upp/specs/2026-05-08-safari-take-screenshot-webview-design.md. Plan: docs/upp/plans/2026-05-08-safari-take-screenshot-webview.md."

If Notion MCP is unavailable, paste the above into the Notion DB manually, then continue.

---

## Task 1: Preflight — verify captureVisibleTab works on this Safari

**Goal:** Before writing any production code, prove that `browser.tabs.captureVisibleTab` actually works on this Safari version with the existing manifest permissions. If this fails, the entire spec is dead and we revisit Option A (screencapture window-ID) before anything else.

**Files:**
- Modify (TEMPORARY — reverted at end of task): `extension/background.js` — add a one-shot debug log
- No commit at end of this task. The instrumentation is reverted before moving on.

- [ ] **Step 1: Add temporary preflight instrumentation to extension/background.js**

Insert this block inside `executeCommand`, AFTER `findTargetTab` and BEFORE the existing sentinel branches (around line 332 after the LIST_FRAMES branch). This is throwaway code:

```javascript
// PREFLIGHT (TEMPORARY): proves tabs.captureVisibleTab API works.
// Remove before committing.
if (cmd.script === '__SP_PREFLIGHT_CAPTURE__') {
  try {
    if (tab.windowId == null) throw { name: 'WINDOW_CLOSED', message: 'no windowId' };
    const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const base64Len = (dataUrl?.split(',')[1] ?? '').length;
    const result = { ok: true, value: JSON.stringify({ base64Len, dataUrlPrefix: dataUrl?.slice(0, 30) }) };
    await updatePendingEntry(commandId, { status: 'completed', result });
    return result;
  } catch (e) {
    const result = { ok: false, error: { name: e?.name ?? 'CAPTURE_FAILED', message: e?.message ?? String(e) } };
    await updatePendingEntry(commandId, { status: 'completed', result });
    return result;
  }
}
```

- [ ] **Step 2: Build extension via dev-loop (no skip-notarize flag yet — Task 2 adds it; for this preflight only, edit the script in place to skip notarytool, OR comment out lines 293–315 of `scripts/build-extension.sh` temporarily).**

```bash
cd "/Users/Aakash/Claude Projects/Skills Factory/safari-pilot"

# TEMPORARY: comment out notarytool block in build-extension.sh for this build only.
# Capture the original first:
cp scripts/build-extension.sh scripts/build-extension.sh.preflight-backup

# Edit scripts/build-extension.sh: comment out lines that run `xcrun notarytool submit ...`
# AND the `xcrun stapler staple` block immediately after. Use micro/your editor.
# Look for the block starting around line 293.

bash scripts/build-extension.sh
# Expect: build succeeds. May warn "not stapled" — fine for preflight.

open "bin/Safari Pilot.app"
```

- [ ] **Step 3: Enable extension in Safari (per memory `reference_extension_enablement_workaround`)**

Manual user steps:
1. Safari → Settings → Advanced → check "Show features for web developers"
2. Safari → Develop → check "Allow Unsigned Extensions"
3. Safari → Settings → Extensions → enable Safari Pilot
4. Quit Safari, reopen — verify extension stays enabled

- [ ] **Step 4: Trigger preflight sentinel via the harness MCP**

Create a temporary preflight test runner:

```bash
cat > /tmp/preflight-capture.mjs <<'EOF'
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const REPO = "/Users/Aakash/Claude Projects/Skills Factory/safari-pilot";
const proc = spawn('node', [resolve(REPO, 'dist/index.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: REPO,
  env: { ...process.env, SAFARI_PILOT_SURFACE: 'full', SAFARI_PILOT_HARNESS_BYPASS_OWNERSHIP: '1', SAFARI_PILOT_NO_SESSION_WINDOW: '1' },
});
let buf = '';
proc.stdout.on('data', (b) => buf += b.toString());
proc.stderr.on('data', (b) => process.stderr.write(b));

const send = (id, method, params) => {
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
};

await new Promise((r) => setTimeout(r, 2500));
send(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'preflight', version: '1.0' } });
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
await new Promise((r) => setTimeout(r, 500));

// Open a tab
send(2, 'tools/call', { name: 'safari_new_tab', arguments: { url: 'https://example.com' } });
await new Promise((r) => setTimeout(r, 4000));

// Trigger preflight sentinel via safari_evaluate_script (which reaches the extension)
// Or use a handler that lets us send a raw script. Easiest: directly call tools/call with
// a tool name that maps to the script path. The `safari_evaluate_script` tool will not
// pass through sentinel strings — instead, monkey-call with a specific tool that the
// extension intercepts. For preflight we use `safari_take_screenshot` only because the
// PREFLIGHT sentinel branch is in place and the existing tool's script path is not a
// sentinel — so we need to bypass the tool layer.
//
// Simpler: write a short shell that pokes the daemon's TCP:19474 directly with a
// dispatch_command containing script='__SP_PREFLIGHT_CAPTURE__' and the example.com tabUrl.
// See preflight-direct.sh in step 5 below for that path.

// EXIT
proc.kill('SIGTERM');
EOF
```

Cleaner approach — bypass the tool layer entirely and hit the daemon directly via TCP:19474, since the daemon will dispatch any `script` string to the extension storage bus and our PREFLIGHT sentinel intercepts:

```bash
cat > /tmp/preflight-direct.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
# 1. Open a tab manually in Safari to https://example.com (or via osascript)
osascript -e 'tell application "Safari" to make new document with properties {URL:"https://example.com"}'
sleep 3
# 2. Send dispatch_command via TCP:19474 to the daemon
#    The daemon protocol expects NDJSON. Look up the exact frame in
#    daemon/Sources/SafariPilotd/CommandDispatcher.swift if needed.
#    For now, easier: trigger via the existing TinyMcpClient pattern in
#    bench/webvoyager/mcp-direct.ts but call a different tool name. Actually
#    simpler still: just call safari_evaluate_script with the sentinel string
#    as the script — the extension's executeCommand will see cmd.script ===
#    '__SP_PREFLIGHT_CAPTURE__' and our PREFLIGHT branch matches BEFORE the
#    existing IIFE wrapper. So:

node --experimental-vm-modules <<'NODE'
import { spawn } from 'node:child_process';
const proc = spawn('node', ['/Users/Aakash/Claude Projects/Skills Factory/safari-pilot/dist/index.js'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  cwd: '/Users/Aakash/Claude Projects/Skills Factory/safari-pilot',
  env: { ...process.env, SAFARI_PILOT_SURFACE: 'full', SAFARI_PILOT_HARNESS_BYPASS_OWNERSHIP: '1', SAFARI_PILOT_NO_SESSION_WINDOW: '1' },
});
let out = '';
proc.stdout.on('data', (b) => out += b.toString());
proc.stderr.on('data', (b) => process.stderr.write(b));

const send = (id, method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
await new Promise(r => setTimeout(r, 2500));
send(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'preflight', version: '1.0' } });
proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
await new Promise(r => setTimeout(r, 500));
send(2, 'tools/call', { name: 'safari_evaluate_script', arguments: { tabUrl: 'https://example.com', script: '__SP_PREFLIGHT_CAPTURE__' } });
await new Promise(r => setTimeout(r, 5000));
console.log('--- last stdout chunk ---');
console.log(out.split('\n').slice(-5).join('\n'));
proc.kill('SIGTERM');
NODE
EOF
chmod +x /tmp/preflight-direct.sh
bash /tmp/preflight-direct.sh
```

- [ ] **Step 5: Verify preflight succeeds**

Expected: stdout contains a JSON response with `value: '{"base64Len": 12345, "dataUrlPrefix": "data:image/png;base64,"}'` (length > 1000 typical). If you see `error.name === 'CAPTURE_FAILED'` or `'TypeError'` saying captureVisibleTab is undefined, **STOP THE PLAN** and revisit Option A (screencapture window-ID) in the spec — it means Safari's WebExtension implementation does not support this method.

- [ ] **Step 6: Revert preflight instrumentation**

```bash
cd "/Users/Aakash/Claude Projects/Skills Factory/safari-pilot"
git restore extension/background.js scripts/build-extension.sh
rm -f scripts/build-extension.sh.preflight-backup
# Verify clean:
git status
git diff extension/background.js scripts/build-extension.sh
# Should report no changes.
```

- [ ] **Step 7: Record preflight outcome in TRACES.md**

Add an iteration entry confirming captureVisibleTab works on this Safari version. No commit yet — that happens in Task 14.

---

## Task 2: Add `--skip-notarize` flag to scripts/build-extension.sh

**Files:**
- Modify: `scripts/build-extension.sh` (notarytool + stapler blocks gated on flag)
- Test: `scripts/build-extension-test.sh` (new)

- [ ] **Step 1: Write the failing test**

```bash
cat > scripts/build-extension-test.sh <<'EOF'
#!/usr/bin/env bash
# Asserts: build-extension.sh accepts --skip-notarize and skips the notarytool step.
# Runs in a `bash -n` syntax check + a dry-run grep for the conditional.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRIPT="$ROOT/scripts/build-extension.sh"

# 1. Syntax must be valid
bash -n "$SCRIPT"

# 2. The script must define SKIP_NOTARIZE based on flag/env
grep -q 'SKIP_NOTARIZE' "$SCRIPT" || { echo "FAIL: SKIP_NOTARIZE not referenced in $SCRIPT"; exit 1; }

# 3. The notarytool invocation must be guarded by SKIP_NOTARIZE
if grep -B 5 'xcrun notarytool submit' "$SCRIPT" | grep -q 'if.*SKIP_NOTARIZE.*!=.*1\|if.*\[\[.*-z.*SKIP_NOTARIZE'; then
  echo "PASS: notarytool guarded by SKIP_NOTARIZE"
else
  echo "FAIL: notarytool block is not guarded by SKIP_NOTARIZE"
  exit 1
fi

# 4. The stapler block must also be guarded
if grep -B 5 'xcrun stapler staple' "$SCRIPT" | grep -q 'if.*SKIP_NOTARIZE'; then
  echo "PASS: stapler guarded by SKIP_NOTARIZE"
else
  echo "FAIL: stapler block is not guarded by SKIP_NOTARIZE"
  exit 1
fi

# 5. --skip-notarize must be parsed as a CLI flag
grep -qE -- '--skip-notarize' "$SCRIPT" || { echo "FAIL: --skip-notarize flag not parsed in $SCRIPT"; exit 1; }

echo "ALL TESTS PASSED"
EOF
chmod +x scripts/build-extension-test.sh
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bash scripts/build-extension-test.sh
```
Expected: FAIL with "SKIP_NOTARIZE not referenced" (current script has no flag).

- [ ] **Step 3: Implement the flag in scripts/build-extension.sh**

Add CLI/env parsing near the top of the script (after the existing `set -euo pipefail`):

```bash
# Parse --skip-notarize (or SKIP_NOTARIZE=1 env var). Default: notarize.
SKIP_NOTARIZE="${SKIP_NOTARIZE:-}"
for arg in "$@"; do
  case "$arg" in
    --skip-notarize) SKIP_NOTARIZE=1 ;;
  esac
done
```

Wrap the notarytool block (around line 293):

```bash
if [[ "$SKIP_NOTARIZE" != "1" ]]; then
  echo "[build-extension] notarizing..."
  xcrun notarytool submit "$ROOT/bin/Safari Pilot.zip" \
    --keychain-profile "apple-notarytool" --wait
  # ...rest of original block...
else
  echo "[build-extension] SKIP_NOTARIZE=1: skipping notarytool submission"
fi
```

Wrap the stapler block (the `xcrun stapler staple` invocation) the same way.

- [ ] **Step 4: Run test to verify it passes**

```bash
bash scripts/build-extension-test.sh
```
Expected: PASS lines for all 5 checks, ending with "ALL TESTS PASSED".

- [ ] **Step 5: Commit**

```bash
git add scripts/build-extension.sh scripts/build-extension-test.sh
git commit -m "feat(scripts): add --skip-notarize flag to build-extension.sh

Allows local dev-loop iteration without the 30+ min Apple notarization
wait. CI release path leaves the flag off, full notarization stays
mandatory for shipped releases.

Refs: docs/upp/plans/2026-05-08-safari-take-screenshot-webview.md task 2"
```

---

## Task 3: Add type fields — ToolRequirements.requiresViewportCapture and EngineCapabilities.viewportCapture

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/types-viewport-capture.test.ts
import { describe, it, expect } from 'vitest';
import type { ToolRequirements, EngineCapabilities } from '../../src/types.js';

describe('viewport capture types (Task 3)', () => {
  it('ToolRequirements has optional requiresViewportCapture', () => {
    const req: ToolRequirements = { retryable: false, requiresViewportCapture: true };
    expect(req.requiresViewportCapture).toBe(true);
  });

  it('EngineCapabilities has optional viewportCapture', () => {
    const caps: EngineCapabilities = {
      shadowDom: false, cspBypass: false, dialogIntercept: false,
      networkIntercept: false, cookieHttpOnly: false, framesCrossOrigin: false,
      asyncJs: false, latencyMs: 5,
      viewportCapture: true,
    };
    expect(caps.viewportCapture).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/unit/types-viewport-capture.test.ts
```
Expected: TypeScript compile error: "Object literal may only specify known properties, and 'requiresViewportCapture' does not exist in type 'ToolRequirements'."

- [ ] **Step 3: Add the type fields to src/types.ts**

In `ToolRequirements` interface (after `requiresAsyncJs`, around line 43):

```typescript
  /**
   * The tool needs to capture rendered WebView pixels (screenshots).
   * Forces routing to the extension engine; the daemon and AppleScript
   * paths cannot capture WebView contents.
   */
  requiresViewportCapture?: boolean;
```

In `EngineCapabilities` interface (after `asyncJs`, before `latencyMs`):

```typescript
  /**
   * Whether the engine can capture rendered WebView pixels for a specific
   * tab via browser.tabs.captureVisibleTab. Only the extension can; daemon
   * and AppleScript engines have no path to the rendered viewport.
   */
  viewportCapture?: boolean;
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/unit/types-viewport-capture.test.ts
```
Expected: PASS for both assertions.

- [ ] **Step 5: Verify nothing else broke**

```bash
npm run lint   # tsc --noEmit
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts test/unit/types-viewport-capture.test.ts
git commit -m "feat(types): add viewport capture flags to ToolRequirements and EngineCapabilities

Adds requiresViewportCapture (tool-side) and viewportCapture (engine-side)
optional booleans. No behavioral change yet — engine-selector and tool
definition wiring lands in subsequent tasks.

Refs: docs/upp/plans/2026-05-08-safari-take-screenshot-webview.md task 3"
```

---

## Task 4: Engine selector — set viewportCapture on extension caps; update requiresExtension chain

**Files:**
- Modify: `src/engine-selector.ts`
- Test: existing `test/unit/engine-selector/*.test.ts` (or new file if pattern doesn't match)

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/engine-selector/viewport-capture.test.ts
import { describe, it, expect } from 'vitest';
import { selectEngine, requiresExtension, ENGINE_CAPS, EngineUnavailableError } from '../../../src/engine-selector.js';

describe('engine-selector — viewport capture (Task 4)', () => {
  it('ENGINE_CAPS.extension.viewportCapture === true', () => {
    expect(ENGINE_CAPS.extension.viewportCapture).toBe(true);
  });

  it('ENGINE_CAPS.daemon.viewportCapture is falsy', () => {
    expect(ENGINE_CAPS.daemon.viewportCapture).toBeFalsy();
  });

  it('ENGINE_CAPS.applescript.viewportCapture is falsy', () => {
    expect(ENGINE_CAPS.applescript.viewportCapture).toBeFalsy();
  });

  it('requiresExtension returns true for {requiresViewportCapture: true}', () => {
    expect(requiresExtension({ retryable: false, requiresViewportCapture: true })).toBe(true);
  });

  it('selectEngine routes viewport-capture tool to extension when available', () => {
    const engine = selectEngine(
      { retryable: false, requiresViewportCapture: true },
      { daemon: true, extension: true }
    );
    expect(engine).toBe('extension');
  });

  it('selectEngine throws EngineUnavailableError when extension unavailable', () => {
    expect(() => selectEngine(
      { retryable: false, requiresViewportCapture: true },
      { daemon: true, extension: false }
    )).toThrow(EngineUnavailableError);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/unit/engine-selector/viewport-capture.test.ts
```
Expected: First three tests fail (`viewportCapture` not on ENGINE_CAPS); next three fail (requiresExtension chain doesn't include the new flag).

- [ ] **Step 3: Update src/engine-selector.ts**

In `ENGINE_CAPS.extension` block:

```typescript
  extension: {
    shadowDom: true,
    cspBypass: true,
    dialogIntercept: true,
    networkIntercept: true,
    cookieHttpOnly: true,
    framesCrossOrigin: true,
    asyncJs: true,
    viewportCapture: true,    // NEW
    latencyMs: 10,
  },
```

In `ENGINE_CAPS.daemon` and `ENGINE_CAPS.applescript`, add explicitly:

```typescript
    viewportCapture: false,
```

(Optional but recommended — makes the falsy intent explicit, mirrors other caps style.)

In `requiresExtension`, add to the `||`-chain:

```typescript
export function requiresExtension(tool: ToolRequirements): boolean {
  return !!(
    tool.requiresShadowDom ||
    tool.requiresCspBypass ||
    tool.requiresDialogIntercept ||
    tool.requiresNetworkIntercept ||
    tool.requiresCookieHttpOnly ||
    tool.requiresFramesCrossOrigin ||
    tool.requiresAsyncJs ||
    tool.requiresViewportCapture     // NEW
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/unit/engine-selector/viewport-capture.test.ts
```
Expected: All 6 tests PASS.

- [ ] **Step 5: Run full engine-selector tests to verify no regression**

```bash
npx vitest run test/unit/engine-selector/
```
Expected: existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/engine-selector.ts test/unit/engine-selector/viewport-capture.test.ts
git commit -m "feat(engine-selector): wire viewport capture to extension engine

ENGINE_CAPS.extension.viewportCapture = true; daemon and applescript
remain false. requiresExtension() now returns true when a tool declares
requiresViewportCapture, ensuring screen-capture-routing tools hit the
extension or fail loudly with EngineUnavailableError.

Refs: docs/upp/plans/2026-05-08-safari-take-screenshot-webview.md task 4"
```

---

## Task 5: Add error codes — WINDOW_CLOSED, CAPTURE_RACE, CAPTURE_FAILED

**Files:**
- Modify: `src/errors.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/errors-capture-codes.test.ts
import { describe, it, expect } from 'vitest';
import { ERROR_CODES } from '../../src/errors.js';

describe('error codes — capture additions (Task 5)', () => {
  it('WINDOW_CLOSED exists with retryable=false', () => {
    expect(ERROR_CODES.WINDOW_CLOSED).toBeDefined();
    expect(ERROR_CODES.WINDOW_CLOSED.retryable).toBe(false);
    expect(ERROR_CODES.WINDOW_CLOSED.hints?.length).toBeGreaterThan(0);
  });

  it('CAPTURE_RACE exists with retryable=true', () => {
    expect(ERROR_CODES.CAPTURE_RACE).toBeDefined();
    expect(ERROR_CODES.CAPTURE_RACE.retryable).toBe(true);
  });

  it('CAPTURE_FAILED exists with retryable=true', () => {
    expect(ERROR_CODES.CAPTURE_FAILED).toBeDefined();
    expect(ERROR_CODES.CAPTURE_FAILED.retryable).toBe(true);
  });

  it('TAB_NOT_FOUND already exists (regression check)', () => {
    expect(ERROR_CODES.TAB_NOT_FOUND).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/unit/errors-capture-codes.test.ts
```
Expected: WINDOW_CLOSED, CAPTURE_RACE, CAPTURE_FAILED tests fail.

- [ ] **Step 3: Add the error codes to src/errors.ts**

Find the `ERROR_CODES` object and add these entries (alphabetical or grouped — match existing style):

```typescript
  WINDOW_CLOSED: {
    retryable: false,
    hints: ['The Safari window containing this tab was closed before capture could complete.'],
  },
  CAPTURE_RACE: {
    retryable: true,
    hints: ['Another tab became active during the capture window. Retry; if persistent, reduce concurrent activity in this Safari window.'],
  },
  CAPTURE_FAILED: {
    retryable: true,
    hints: ['Screenshot capture API failed. Verify Safari extension is enabled and the page is fully loaded.'],
  },
```

If `INVALID_PARAMS` does not already exist in `ERROR_CODES`, add:

```typescript
  INVALID_PARAMS: {
    retryable: false,
    hints: ['Tool was called with parameters that violate its input schema.'],
  },
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run test/unit/errors-capture-codes.test.ts
```
Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/errors.ts test/unit/errors-capture-codes.test.ts
git commit -m "feat(errors): add WINDOW_CLOSED, CAPTURE_RACE, CAPTURE_FAILED codes

Used by safari_take_screenshot's new extension-based capture path.
Retryability classified per spec: WINDOW_CLOSED is permanent (window
gone), CAPTURE_RACE and CAPTURE_FAILED are transient.

Refs: docs/upp/plans/2026-05-08-safari-take-screenshot-webview.md task 5"
```

---

## Task 6: Tool handler rewrite — handleTakeScreenshot routes to extension

**Files:**
- Modify: `src/tools/extraction.ts` — rewrite `handleTakeScreenshot`, drop `screencaptureRunner` field/type/default; update `getDefinitions()` entry; reject non-png format
- Test (new): `test/unit/tools/extraction-screenshot-handler.test.ts`
- Test (update): `test/unit/tools/extraction-screenshot-schema.test.ts` — assert `format: enum(['png'])` and `additionalProperties: false`
- Test (update): `test/unit/tools/extraction-requirements.test.ts` — assert `safari_take_screenshot.requirements.requiresViewportCapture === true`

- [ ] **Step 1: Write the failing handler test**

```typescript
// test/unit/tools/extraction-screenshot-handler.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ExtractionTools } from '../../../src/tools/extraction.js';
import type { IEngine, EngineResult } from '../../../src/engines/engine.js';

function makeFakeEngine(result: EngineResult): IEngine {
  return {
    name: 'extension' as const,
    isAvailable: async () => true,
    executeJsInTab: vi.fn(async () => result),
    // unused methods stubbed
    executeJsInTabByPosition: vi.fn(),
    listTabs: vi.fn(),
    closeTab: vi.fn(),
    healthCheck: vi.fn(),
    setupSession: vi.fn(),
    teardownSession: vi.fn(),
  } as unknown as IEngine;
}

describe('safari_take_screenshot handler (Task 6)', () => {
  it('rejects format!=png with INVALID_PARAMS and does NOT call engine', async () => {
    const engine = makeFakeEngine({ ok: true, value: 'AAAA', elapsed_ms: 1 });
    const tools = new ExtractionTools(engine);
    const handler = tools.getHandler('safari_take_screenshot')!;
    await expect(handler({ tabUrl: 'https://example.com', format: 'jpeg' }))
      .rejects.toMatchObject({ message: expect.stringContaining('jpeg') });
    expect(engine.executeJsInTab).not.toHaveBeenCalled();
  });

  it('decodes base64 and returns image content', async () => {
    // 4-byte PNG-ish data: a real test would use a tiny valid PNG; this is fine for shape
    const fakeB64 = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
    const engine = makeFakeEngine({ ok: true, value: fakeB64, elapsed_ms: 5 });
    const tools = new ExtractionTools(engine);
    const handler = tools.getHandler('safari_take_screenshot')!;
    const res = await handler({ tabUrl: 'https://example.com' });
    expect(res.content[0]?.type).toBe('image');
    expect(res.content[0]?.mimeType).toBe('image/png');
    expect((res.content[0] as { data: string }).data).toBe(fakeB64);
    expect(engine.executeJsInTab).toHaveBeenCalledWith('https://example.com', '__SP_TAKE_SCREENSHOT__', 30_000);
  });

  it('propagates result.error.code on engine failure', async () => {
    const engine = makeFakeEngine({ ok: false, error: { code: 'TAB_NOT_FOUND', message: 'no such tab' }, elapsed_ms: 2 });
    const tools = new ExtractionTools(engine);
    const handler = tools.getHandler('safari_take_screenshot')!;
    let thrown: unknown;
    try { await handler({ tabUrl: 'https://gone.example.com' }); } catch (e) { thrown = e; }
    expect((thrown as Error & { code?: string }).code).toBe('TAB_NOT_FOUND');
  });

  it('throws CAPTURE_FAILED when result.value is empty', async () => {
    const engine = makeFakeEngine({ ok: true, value: '', elapsed_ms: 1 });
    const tools = new ExtractionTools(engine);
    const handler = tools.getHandler('safari_take_screenshot')!;
    await expect(handler({ tabUrl: 'https://example.com' }))
      .rejects.toMatchObject({ code: 'CAPTURE_FAILED' });
  });
});
```

- [ ] **Step 2: Update extraction-screenshot-schema test**

```typescript
// test/unit/tools/extraction-screenshot-schema.test.ts — UPDATE existing test file
// Add this assertion alongside the existing T17 schema test:

import { describe, it, expect } from 'vitest';
import { ExtractionTools } from '../../../src/tools/extraction.js';
import type { IEngine } from '../../../src/engines/engine.js';

describe('safari_take_screenshot inputSchema (Task 6 update)', () => {
  it('format must be enum=["png"] and additionalProperties=false', () => {
    const tools = new ExtractionTools({} as IEngine);
    const def = tools.getDefinitions().find((d) => d.name === 'safari_take_screenshot');
    if (!def) throw new Error('definition missing');
    const props = (def.inputSchema as { properties?: Record<string, { enum?: string[] }>; additionalProperties?: boolean }).properties ?? {};
    expect(props['format']?.enum).toEqual(['png']);
    expect((def.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
  });
});
```

- [ ] **Step 3: Update extraction-requirements test**

```typescript
// test/unit/tools/extraction-requirements.test.ts — UPDATE existing test file
// Add:

it('safari_take_screenshot requires viewport capture', () => {
  const tools = new ExtractionTools({} as IEngine);
  const def = tools.getDefinitions().find((d) => d.name === 'safari_take_screenshot');
  if (!def) throw new Error('definition missing');
  expect(def.requirements.requiresViewportCapture).toBe(true);
});
```

- [ ] **Step 4: Run all three tests — verify they fail**

```bash
npx vitest run test/unit/tools/extraction-screenshot-handler.test.ts test/unit/tools/extraction-screenshot-schema.test.ts test/unit/tools/extraction-requirements.test.ts
```
Expected: All new assertions FAIL. (Existing assertions in the schema/requirements tests still pass.)

- [ ] **Step 5: Rewrite handleTakeScreenshot in src/tools/extraction.ts**

Replace `handleTakeScreenshot` and remove `screencaptureRunner`. Full code:

```typescript
// At top: drop the existing
//   import * as childProcess from 'node:child_process';
//   type ScreencaptureRunner = ...
//   function defaultScreencaptureRunner(...) { ... }
// Add (if not already imported):
import { writeFile } from 'node:fs/promises';

// Constructor — drop the third arg:
constructor(engine: IEngine, screenshotPolicy?: ScreenshotPolicy) {
  this.engine = engine;
  this.screenshotPolicy = screenshotPolicy;
  // ...rest of existing handler registrations unchanged...
  this.handlers.set('safari_take_screenshot', this.handleTakeScreenshot.bind(this));
}

// Drop the private field:
//   private screencaptureRunner: ScreencaptureRunner;

// Replace handleTakeScreenshot:
private async handleTakeScreenshot(params: Record<string, unknown>): Promise<ToolResponse> {
  const tabUrl = params['tabUrl'] as string | undefined;
  if (!tabUrl) {
    const err = new Error('tabUrl required');
    (err as Error & { code?: string }).code = 'INVALID_PARAMS';
    throw err;
  }

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

Update `getDefinitions()` entry for `safari_take_screenshot`:

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
      format: { type: 'string', enum: ['png'], description: 'Image format. v1 only accepts png; non-png values are rejected with INVALID_PARAMS.' },
      path:   { type: 'string', description: 'Optional filesystem path. If provided, the PNG is also written to this path.' },
    },
    required: ['tabUrl'],
    additionalProperties: false,
  },
  requirements: { retryable: true, requiresViewportCapture: true },
},
```

(Adjust the `retryable` field per the existing tool's value — read it from current code before changing.)

- [ ] **Step 6: Run all tests — verify they pass**

```bash
npx vitest run test/unit/tools/extraction-screenshot-handler.test.ts test/unit/tools/extraction-screenshot-schema.test.ts test/unit/tools/extraction-requirements.test.ts
```
Expected: All assertions PASS.

- [ ] **Step 7: Run lint to catch type errors from the constructor change**

```bash
npm run lint
```
Expected: type errors at `src/server.ts:267` and `src/server.ts:401` (3rd arg removed). These are fixed in Task 7. Hold the commit.

- [ ] **Step 8: Make src/server.ts type-clean to allow the commit**

In `src/server.ts`, drop the third arg from both `new ExtractionTools(...)` calls (lines 267 and 401). The third arg was `new ScreenshotPolicy(this.config.screenshotPolicy)` — wait, looking again, the third arg in current code is the policy itself. The policy IS the SECOND arg already (verify by reading); the screencaptureRunner default came from omission. If only 2 args are present in current call sites, no change needed.

```bash
grep -nE "new ExtractionTools\(" src/server.ts
```

If both call sites are already 2 args, skip this step. If 3 args: drop the 3rd.

- [ ] **Step 9: Run lint + full unit suite**

```bash
npm run lint
npx vitest run test/unit/
```
Expected: clean lint, all unit tests pass.

- [ ] **Step 10: Commit**

```bash
git add src/tools/extraction.ts src/server.ts \
  test/unit/tools/extraction-screenshot-handler.test.ts \
  test/unit/tools/extraction-screenshot-schema.test.ts \
  test/unit/tools/extraction-requirements.test.ts
git commit -m "feat(tools): rewrite safari_take_screenshot to route to extension

handleTakeScreenshot now sends '__SP_TAKE_SCREENSHOT__' sentinel via
engine.executeJsInTab; decodes base64 result; writes file if path given.
Drops screencaptureRunner DI (no longer used). Rejects format!=png with
INVALID_PARAMS. Tool definition declares requiresViewportCapture: true,
forcing extension-engine routing.

Sentinel branch in extension/background.js lands in Task 8.

Refs: docs/upp/plans/2026-05-08-safari-take-screenshot-webview.md task 6"
```

---

## Task 7: Replace test/unit/tools/take-screenshot-policy.test.ts

**Files:**
- Replace: `test/unit/tools/take-screenshot-policy.test.ts`

**Why:** The old test exercises `screencaptureRunner` DI, which is gone. The replacement asserts that ScreenshotPolicy still gates the engine call (policy runs BEFORE engine round-trip).

- [ ] **Step 1: Read existing test, identify intent**

```bash
cat test/unit/tools/take-screenshot-policy.test.ts
```
Identify: the test asserts ScreenshotPolicy.checkDomain runs before screencapture and that a blocked domain doesn't trigger capture.

- [ ] **Step 2: Replace test contents**

```typescript
// test/unit/tools/take-screenshot-policy.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ExtractionTools } from '../../../src/tools/extraction.js';
import { ScreenshotPolicy } from '../../../src/security/screenshot-policy.js';
import type { IEngine } from '../../../src/engines/engine.js';

/**
 * T59 — ScreenshotPolicy must run BEFORE the engine call.
 * Old (pre-2026-05-08): policy gated screencaptureRunner; that DI is gone.
 * New: policy gates engine.executeJsInTab; if blocked, the engine is never invoked.
 */
describe('safari_take_screenshot — ScreenshotPolicy gates engine call', () => {
  function makeEngine(): IEngine {
    return {
      name: 'extension',
      isAvailable: async () => true,
      executeJsInTab: vi.fn(async () => ({ ok: true, value: 'AAAA', elapsed_ms: 1 })),
      executeJsInTabByPosition: vi.fn(),
      listTabs: vi.fn(),
      closeTab: vi.fn(),
      healthCheck: vi.fn(),
      setupSession: vi.fn(),
      teardownSession: vi.fn(),
    } as unknown as IEngine;
  }

  it('blocked tabUrl: throws ScreenshotBlockedError, engine NOT called', async () => {
    const policy = new ScreenshotPolicy({ blockedDomains: ['blocked.example.com'] });
    const engine = makeEngine();
    const tools = new ExtractionTools(engine, policy);
    const handler = tools.getHandler('safari_take_screenshot')!;

    await expect(handler({ tabUrl: 'https://blocked.example.com/page' })).rejects.toThrow(/screenshot|blocked/i);
    expect(engine.executeJsInTab).not.toHaveBeenCalled();
  });

  it('unblocked tabUrl: engine IS called', async () => {
    const policy = new ScreenshotPolicy({ blockedDomains: ['other.example.com'] });
    const engine = makeEngine();
    const tools = new ExtractionTools(engine, policy);
    const handler = tools.getHandler('safari_take_screenshot')!;

    await handler({ tabUrl: 'https://allowed.example.com/page' });
    expect(engine.executeJsInTab).toHaveBeenCalledWith('https://allowed.example.com/page', '__SP_TAKE_SCREENSHOT__', 30_000);
  });

  it('no policy configured: engine still called', async () => {
    const engine = makeEngine();
    const tools = new ExtractionTools(engine);
    const handler = tools.getHandler('safari_take_screenshot')!;

    await handler({ tabUrl: 'https://example.com' });
    expect(engine.executeJsInTab).toHaveBeenCalledOnce();
  });
});
```

Verify the `ScreenshotPolicy` constructor signature in `src/security/screenshot-policy.ts` and adjust `{ blockedDomains: [...] }` if the actual config shape differs.

- [ ] **Step 3: Run test — verify it passes**

```bash
npx vitest run test/unit/tools/take-screenshot-policy.test.ts
```
Expected: 3 PASS.

- [ ] **Step 4: Commit**

```bash
git add test/unit/tools/take-screenshot-policy.test.ts
git commit -m "test: rewrite take-screenshot-policy unit test for extension routing

Old test mocked screencaptureRunner DI which was removed in Task 6.
New test asserts policy still gates engine.executeJsInTab — policy
runs BEFORE the engine call (T59 invariant preserved).

Refs: docs/upp/plans/2026-05-08-safari-take-screenshot-webview.md task 7"
```

---

## Task 8: Add `__SP_TAKE_SCREENSHOT__` sentinel branch in extension/background.js

**Files:**
- Modify: `extension/background.js` — add sentinel branch in `executeCommand`

**Note:** This task does not have a unit test — extension JS only runs in real Safari per the project's HARD RULE. The behavioral test is in Task 11 (e2e). This task implements the code; the e2e gate verifies it.

- [ ] **Step 1: Locate insertion point**

In `extension/background.js`, find the `executeCommand` function. The sentinel branches start near line 332 (`__SP_LIST_FRAMES__`). Insert the new branch AFTER the `__SP_DNR_*` block but BEFORE the IIFE wrapper that handles regular scripts.

- [ ] **Step 2: Insert the sentinel branch**

```javascript
// safari_take_screenshot — capture the visible viewport of the target tab
// via browser.tabs.captureVisibleTab. Triggered by the __SP_TAKE_SCREENSHOT__
// sentinel from src/tools/extraction.ts. Briefly activates target tab in its
// window (no Safari app activation), captures, restores prior active tab.
if (cmd.script === '__SP_TAKE_SCREENSHOT__') {
  let prevActiveTabId = null;
  try {
    if (tab.windowId == null) {
      throw { name: 'WINDOW_CLOSED', message: 'tab.windowId missing' };
    }

    // Snapshot the previous active tab so we can restore it.
    const prevActive = await browser.tabs.query({ windowId: tab.windowId, active: true });
    prevActiveTabId = prevActive[0]?.id ?? null;

    // Activate the target tab if it isn't already active. tabs.update resolves
    // before Safari's internal active-tab state settles, so we verify by
    // polling tabs.query before the capture (TOCTOU narrows but doesn't close).
    if (prevActiveTabId !== tab.id) {
      await browser.tabs.update(tab.id, { active: true });
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
      try { await browser.tabs.update(prevActiveTabId, { active: true }); } catch { /* tab may have closed */ }
    }
  }
}
```

- [ ] **Step 3: Verify JS syntax via node parsing**

```bash
node --check extension/background.js
```
Expected: no syntax errors printed.

- [ ] **Step 4: Bump extension/manifest.json version**

```bash
# Set to a dev-iteration version that's higher than current. Use timestamp suffix.
# Look up current version:
grep '"version"' extension/manifest.json
# Edit extension/manifest.json: bump "version" to next patch, e.g. "0.1.29" → "0.1.30-dev1"
# (final release version chosen in Task 13)
```

- [ ] **Step 5: Commit**

```bash
git add extension/background.js extension/manifest.json
git commit -m "feat(extension): add __SP_TAKE_SCREENSHOT__ sentinel for WebView capture

In executeCommand, intercept the new sentinel script before generic
script execution. Briefly activates target tab (verifies activation via
tabs.query polling, throws CAPTURE_RACE on timeout), calls
browser.tabs.captureVisibleTab, returns raw base64. Restores prior
active tab in finally even on error.

Refs: docs/upp/plans/2026-05-08-safari-take-screenshot-webview.md task 8"
```

---

## Task 9: Bench harness null-handling — types, adapter, runner, score

**Files:**
- Modify: `bench/webvoyager/types.ts` — `WebVoyagerScore.screenshot_path: string | null`
- Modify: `bench/webvoyager/adapter.ts` — `RawAdapterResult.screenshot_path: string | null`; null when capture failed; populate `errorCode?: string`
- Modify: `bench/webvoyager/runner.ts` — gate judge call: skip when screenshot is null, write `verdict: 'UNKNOWN'`, `judge_reasoning: 'screenshot capture failed: <code>'`
- Modify: `bench/webvoyager/score.ts` — add `capture_failure_rate` field to scoreboard
- Test (new): `test/unit/bench/webvoyager-runner-null-screenshot.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/bench/webvoyager-runner-null-screenshot.test.ts
import { describe, it, expect } from 'vitest';
import { aggregateScoreboard } from '../../../bench/webvoyager/score.js';
import type { WebVoyagerScore } from '../../../bench/webvoyager/types.js';

describe('webvoyager scoreboard — capture_failure_rate (Task 9)', () => {
  it('counts UNKNOWN verdicts with capture-failed reasoning toward capture_failure_rate', () => {
    const scores: WebVoyagerScore[] = [
      { task_id: 'A--1', variant: 'v', verdict: 'SUCCESS',  judge_reasoning: 'ok',  agent_final_text: 'x', run_seq: 1, wall_ms: 1, screenshot_path: '/tmp/a.png' },
      { task_id: 'A--2', variant: 'v', verdict: 'FAILURE',  judge_reasoning: 'no',  agent_final_text: 'y', run_seq: 1, wall_ms: 1, screenshot_path: '/tmp/b.png' },
      { task_id: 'A--3', variant: 'v', verdict: 'UNKNOWN',  judge_reasoning: 'screenshot capture failed: TAB_NOT_FOUND', agent_final_text: 'z', run_seq: 1, wall_ms: 1, screenshot_path: null },
      { task_id: 'A--4', variant: 'v', verdict: 'UNKNOWN',  judge_reasoning: 'screenshot capture failed: CAPTURE_FAILED', agent_final_text: 'w', run_seq: 1, wall_ms: 1, screenshot_path: null },
    ];
    const board = aggregateScoreboard(scores);
    expect(board.overall.tasks_total).toBe(4);
    expect(board.overall.tasks_success).toBe(1);
    expect(board.overall.success_rate).toBeCloseTo(0.25);
    expect(board.overall.capture_failure_rate).toBeCloseTo(0.5);
  });

  it('capture_failure_rate is 0 when no UNKNOWN-with-capture-failed scores', () => {
    const scores: WebVoyagerScore[] = [
      { task_id: 'A--1', variant: 'v', verdict: 'SUCCESS', judge_reasoning: 'ok', agent_final_text: 'x', run_seq: 1, wall_ms: 1, screenshot_path: '/tmp/a.png' },
    ];
    const board = aggregateScoreboard(scores);
    expect(board.overall.capture_failure_rate).toBe(0);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

```bash
npx vitest run test/unit/bench/webvoyager-runner-null-screenshot.test.ts
```
Expected: type error (screenshot_path: null not allowed) and missing capture_failure_rate field.

- [ ] **Step 3: Update `bench/webvoyager/types.ts`**

```typescript
export interface WebVoyagerScore {
  task_id: string;
  variant: string;
  verdict: 'SUCCESS' | 'FAILURE' | 'UNKNOWN';
  judge_reasoning: string;
  agent_final_text: string;
  run_seq: number;
  wall_ms: number;
  screenshot_path: string | null;   // CHANGED: was string
}
```

If a `WebVoyagerScoreboard` interface (or similar) exists, extend the `overall` and per-site shape with `capture_failure_rate: number`.

- [ ] **Step 4: Update `bench/webvoyager/adapter.ts`**

Change `RawAdapterResult` interface and `runWebVoyagerTask` to:
- Set `screenshot_path: null, errorCode: <code>` on capture failure (catch around the `captureScreenshotPostHoc` call).
- Set `screenshot_path: <path>, errorCode: undefined` on success.

```typescript
interface RawAdapterResult {
  // ...existing fields...
  screenshot_path: string | null;
  capture_error_code?: string;
}
```

In the catch around `captureScreenshotPostHoc(tabSnapshot, screenshotPath)`:

```typescript
let screenshotPathOrNull: string | null = screenshotPath;
let captureErrorCode: string | undefined;
try {
  await captureScreenshotPostHoc(tabSnapshot, screenshotPath);
  // verify file exists; if mcp-direct returned null URL or didn't write the file:
  if (!existsSync(screenshotPath)) {
    screenshotPathOrNull = null;
    captureErrorCode = 'CAPTURE_NO_FILE';
  }
} catch (e) {
  screenshotPathOrNull = null;
  captureErrorCode = (e as Error & { code?: string }).code ?? 'CAPTURE_FAILED';
}
```

Return `screenshot_path: screenshotPathOrNull, capture_error_code: captureErrorCode` from the function. Add `import { existsSync } from 'node:fs';` if not already present.

- [ ] **Step 5: Update `bench/webvoyager/runner.ts`**

In the worker loop, gate the judge call on screenshot presence:

```typescript
const adapterResult = await runWebVoyagerTask(task, { /* ... */ });

let verdict: 'SUCCESS' | 'FAILURE' | 'UNKNOWN' = 'UNKNOWN';
let reasoning = '(judge skipped)';

if (adapterResult.screenshot_path === null) {
  // Capture failed — skip judge entirely. Don't try to call OpenAI without a screenshot;
  // the upstream WebVoyager prompt is screenshot-mandatory and would either crash or
  // produce a conservative NOT SUCCESS that's unrelated to agent capability.
  verdict = 'UNKNOWN';
  reasoning = `screenshot capture failed: ${adapterResult.capture_error_code ?? 'unknown'}`;
} else if (!args.skipJudge) {
  try {
    const j = await runJudge(task.question, adapterResult.agent_final_text, adapterResult.screenshot_path);
    verdict = j.verdict;
    reasoning = j.reasoning;
  } catch (e) {
    reasoning = `judge error: ${e instanceof Error ? e.message : String(e)}`;
    verdict = 'FAILURE';
  }
}

const score: WebVoyagerScore = {
  task_id: task.id,
  variant: args.variant,
  verdict,
  judge_reasoning: reasoning,
  agent_final_text: adapterResult.agent_final_text,
  run_seq: runSeq,
  wall_ms: adapterResult.wall_ms,
  screenshot_path: adapterResult.screenshot_path,   // string | null
};
```

- [ ] **Step 6: Update `bench/webvoyager/score.ts`**

Add `capture_failure_rate` to the aggregator. The metric: count of `verdict === 'UNKNOWN' && reasoning matches /screenshot capture failed/` divided by total tasks. Both overall and per-site.

```typescript
function isCaptureFailure(s: WebVoyagerScore): boolean {
  return s.verdict === 'UNKNOWN' && /^screenshot capture failed:/.test(s.judge_reasoning);
}

// In aggregateScoreboard:
const overall = {
  tasks_total: scores.length,
  tasks_success: scores.filter(s => s.verdict === 'SUCCESS').length,
  success_rate: scores.length ? scores.filter(s => s.verdict === 'SUCCESS').length / scores.length : 0,
  capture_failure_rate: scores.length ? scores.filter(isCaptureFailure).length / scores.length : 0,
  wall_ms_median: median(scores.map(s => s.wall_ms)),
};
```

Per-site aggregation: same shape, computed per `site = task_id.split('--')[0]`.

- [ ] **Step 7: Run unit test — verify it passes**

```bash
npx vitest run test/unit/bench/webvoyager-runner-null-screenshot.test.ts
```
Expected: PASS.

- [ ] **Step 8: Run lint**

```bash
npm run lint
```
Expected: clean.

- [ ] **Step 9: Commit**

```bash
git add bench/webvoyager/types.ts bench/webvoyager/adapter.ts bench/webvoyager/runner.ts bench/webvoyager/score.ts \
  test/unit/bench/webvoyager-runner-null-screenshot.test.ts
git commit -m "feat(bench): null-screenshot handling + capture_failure_rate metric

Adapter returns screenshot_path: string | null and capture_error_code.
Runner skips the judge entirely when null (upstream prompt is
screenshot-mandatory; calling without one would either break parity or
produce conservative NOT SUCCESS). Tasks with null get verdict=UNKNOWN.
Scoreboard adds capture_failure_rate as a separate metric so success_rate
remains a clean (success/total) ratio without conflating capture failures.

Refs: docs/upp/plans/2026-05-08-safari-take-screenshot-webview.md task 9"
```

---

## Task 10: Build extension via dev-loop and install

**Files:**
- (no source files; operational task)

**Goal:** Get the new sentinel running in real Safari so e2e tests can exercise it.

- [ ] **Step 1: Build TypeScript**

```bash
cd "/Users/Aakash/Claude Projects/Skills Factory/safari-pilot"
npm run build
```
Expected: clean compile.

- [ ] **Step 2: Build extension via skip-notarize path**

```bash
bash scripts/build-extension.sh --skip-notarize
```
Expected: `bin/Safari Pilot.app` updated. Notarytool block skipped (printed "SKIP_NOTARIZE=1: skipping notarytool submission"). Stapler block skipped.

- [ ] **Step 3: Install in Safari**

```bash
open "bin/Safari Pilot.app"
```

If already enabled and the version bumped, Safari will reload it. If not enabled:
1. Safari → Develop → "Allow Unsigned Extensions" (toggle on)
2. Safari → Settings → Extensions → enable Safari Pilot
3. Quit Safari, reopen — verify enabled

- [ ] **Step 4: Smoke test — confirm tools list includes safari_take_screenshot**

```bash
claude --dangerously-skip-permissions -p "List the safari_* tools available to you whose names start with 'safari_take_screenshot'. Just the names." 2>&1 | tail -5
```
Expected: prints `safari_take_screenshot`.

- [ ] **Step 5: Smoke test — capture a tab**

Open a fresh Safari window manually, then:

```bash
claude --dangerously-skip-permissions -p "Use safari_new_tab to open https://example.com (and only this URL — do not switch any existing tabs). Then call safari_take_screenshot on it with path=/tmp/smoke.png. Reply DONE." 2>&1 | tail -10
ls -la /tmp/smoke.png
file /tmp/smoke.png
open /tmp/smoke.png   # visually inspect
```
Expected: `/tmp/smoke.png` exists, file type is "PNG image data", visual inspection shows the example.com page (not terminal output).

- [ ] **Step 6: No commit (operational task)**

The build artifacts in `bin/` are produced fresh; don't commit them — they're regenerated by the release pipeline. Verify `bin/` is gitignored or that bins aren't committed by other discipline.

```bash
git status   # should show no new staged changes
```

---

## Task 11: New e2e — test/e2e/screenshot-webview.test.ts

**Files:**
- Create: `test/e2e/screenshot-webview.test.ts`
- Create: `test/fixtures/red-page-server.ts` (small Node http server serving a solid red HTML page)
- Modify (small): `test/e2e/setup-production.ts` if a fixture-server hook is needed

- [ ] **Step 1: Write the red-page fixture server**

```typescript
// test/fixtures/red-page-server.ts
import { createServer, type Server } from 'node:http';

export async function startRedPageServer(port = 0): Promise<{ url: string; close: () => Promise<void> }> {
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=800">
<title>red</title><style>html,body{margin:0;background:#ff0000;width:100%;height:100%;}</style>
</head><body></body></html>`;
  const server: Server = createServer((req, res) => {
    if (req.url === '/red.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()));
  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  return {
    url: `http://127.0.0.1:${actualPort}/red.html`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
```

- [ ] **Step 2: Write the failing e2e test**

```typescript
// test/e2e/screenshot-webview.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { PNG } from 'pngjs';   // existing dep? if not, add to devDeps
import { McpTestClient } from '../helpers/mcp-client.js';
import { startRedPageServer } from '../fixtures/red-page-server.js';

let client: McpTestClient;
let fixture: { url: string; close: () => Promise<void> };
let openedTabUrls: string[] = [];

const URL_MARKER = '?sp_screenshot_e2e=1';

beforeAll(async () => {
  fixture = await startRedPageServer();
  client = await McpTestClient.start();
}, 60_000);

afterAll(async () => {
  // Per project hard rule (feedback-e2e-tests-must-close-tabs): close every tab we opened.
  for (const url of openedTabUrls) {
    try { await client.callTool('safari_close_tab', { tabUrl: url }); } catch { /* best effort */ }
  }
  await client.close();
  await fixture.close();
}, 30_000);

function frontmostApp(): string {
  return execSync(`osascript -e 'tell app "System Events" to name of first application process whose frontmost is true'`).toString().trim();
}

function dominantlyRed(pngBuffer: Buffer): { fraction: number; sampled: number } {
  const png = PNG.sync.read(pngBuffer);
  const totalPixels = png.width * png.height;
  const sampleCount = Math.min(200, totalPixels);
  let red = 0;
  for (let i = 0; i < sampleCount; i++) {
    const idx = Math.floor(Math.random() * totalPixels) * 4;
    const r = png.data[idx]!, g = png.data[idx + 1]!, b = png.data[idx + 2]!;
    if (r > 200 && g < 50 && b < 50) red++;
  }
  return { fraction: red / sampleCount, sampled: sampleCount };
}

describe('safari_take_screenshot — WebView capture (e2e)', () => {
  it('captures the agent\'s tab as a dominantly-red PNG (proves WebView, not screen)', async () => {
    const url = fixture.url + URL_MARKER + 'a';
    await client.callTool('safari_new_tab', { url });
    openedTabUrls.push(url);

    // Wait for full page load — fixture is tiny and local, but be safe.
    await client.callTool('safari_wait_for', { tabUrl: url, condition: 'load', timeout: 10_000 });

    const path = '/tmp/sp-e2e-red-' + Date.now() + '.png';
    await client.callTool('safari_take_screenshot', { tabUrl: url, path });
    const buf = readFileSync(path);
    expect(statSync(path).size).toBeGreaterThan(1000);

    const { fraction, sampled } = dominantlyRed(buf);
    expect(fraction).toBeGreaterThanOrEqual(0.95);
  }, 60_000);

  it('does NOT bring Safari to foreground', async () => {
    expect(frontmostApp()).not.toBe('Safari');   // precondition
    const url = fixture.url + URL_MARKER + 'b';
    await client.callTool('safari_new_tab', { url });
    openedTabUrls.push(url);
    await client.callTool('safari_wait_for', { tabUrl: url, condition: 'load', timeout: 10_000 });
    await client.callTool('safari_take_screenshot', { tabUrl: url, path: '/tmp/sp-e2e-noact-' + Date.now() + '.png' });
    expect(frontmostApp()).not.toBe('Safari');   // postcondition
  }, 45_000);

  it('returns TAB_NOT_FOUND when target tab was closed before capture', async () => {
    const url = fixture.url + URL_MARKER + 'c';
    await client.callTool('safari_new_tab', { url });
    await client.callTool('safari_close_tab', { tabUrl: url });
    let err: Error & { code?: string } | undefined;
    try {
      await client.callTool('safari_take_screenshot', { tabUrl: url });
    } catch (e) { err = e as Error & { code?: string }; }
    expect(err?.code).toBe('TAB_NOT_FOUND');
  }, 30_000);

  it('latency p95 < 1000ms over 20 sequential captures', async () => {
    const url = fixture.url + URL_MARKER + 'd';
    await client.callTool('safari_new_tab', { url });
    openedTabUrls.push(url);
    await client.callTool('safari_wait_for', { tabUrl: url, condition: 'load', timeout: 10_000 });

    const latencies: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t0 = Date.now();
      await client.callTool('safari_take_screenshot', { tabUrl: url });
      latencies.push(Date.now() - t0);
    }
    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.floor(latencies.length * 0.95)]!;
    expect(p95).toBeLessThan(1000);
  }, 90_000);
});
```

If `pngjs` is not in `package.json`, install it as a dev dep before running:

```bash
npm install --save-dev pngjs @types/pngjs
```

- [ ] **Step 3: Run test — verify failures (most assertions should pass after Task 10's build, but flag any unexpected fails)**

```bash
npm run test:e2e -- test/e2e/screenshot-webview.test.ts
```

Expected at this point: All 4 tests should PASS, since the implementation is in place from Tasks 6+8 and the build was done in Task 10. If they fail, debug:
- Red-pixel < 95%: check page actually loaded; check Retina-PNG decoding shape
- Frontmost-app changes to Safari: check tabs.update isn't bringing Safari forward (it shouldn't; if it does, this is a Safari-specific divergence from the WebExtensions spec)
- TAB_NOT_FOUND missing: check error.code propagation through the chain
- Latency p95 > 1s: investigate; may need to relax target if Safari is consistently slow on this machine

- [ ] **Step 4: Commit**

```bash
git add test/e2e/screenshot-webview.test.ts test/fixtures/red-page-server.ts package.json package-lock.json
git commit -m "test(e2e): WebView capture proof via red-pixel fixture

Localhost fixture serves a solid #ff0000 page; e2e captures, decodes,
asserts >=95% sampled pixels are red. This is the only assertion that
proves we got Safari's WebView and not a screencapture-of-screen.
Plus: no-Safari-foregrounding, TAB_NOT_FOUND on closed tabs, p95<1s
latency over 20 captures.

Refs: docs/upp/plans/2026-05-08-safari-take-screenshot-webview.md task 11"
```

---

## Task 12: Update existing e2e tests for new screenshot semantics

**Files:**
- Modify: `test/e2e/T43-observation-tools.test.ts` — existing assertion still valid; verify it still passes
- Modify: `test/e2e/phase1-core-navigation.test.ts` — same
- Modify: `test/e2e/security-layers.test.ts` — verify SCREENSHOT_BLOCKED policy still gates BEFORE the engine round-trip (no new tabs opened in extension when policy rejects)

- [ ] **Step 1: Run existing e2e tests against the new build**

```bash
npm run test:e2e -- test/e2e/T43-observation-tools.test.ts test/e2e/phase1-core-navigation.test.ts test/e2e/security-layers.test.ts
```
Expected: all pass with no changes — existing assertions ("returns a non-empty PNG", "SCREENSHOT_BLOCKED on seed-list domain") survive the implementation switch.

- [ ] **Step 2: Strengthen security-layers.test.ts policy assertion**

Add a daemon-trace-count assertion to confirm policy rejection short-circuits before the extension is reached:

```typescript
// In test/e2e/security-layers.test.ts, in the SCREENSHOT_BLOCKED test:
import { readFileSync } from 'node:fs';

// After the SCREENSHOT_BLOCKED rejection, assert no __SP_TAKE_SCREENSHOT__ trace event:
const traceLines = readFileSync(client.daemonTracePath, 'utf-8').split('\n');
const captureCount = traceLines.filter(l => l.includes('__SP_TAKE_SCREENSHOT__')).length;
expect(captureCount).toBe(0);  // policy short-circuited; engine never invoked
```

(Adjust to actual tracing API; if `daemonTracePath` isn't exposed by McpTestClient, skip this strengthening — the existing rejection assertion is sufficient.)

- [ ] **Step 3: Run again — verify pass**

```bash
npm run test:e2e -- test/e2e/security-layers.test.ts
```
Expected: PASS.

- [ ] **Step 4: Commit (only if there were changes; otherwise skip commit)**

```bash
git status
# If changes exist:
git add test/e2e/security-layers.test.ts
git commit -m "test(e2e): strengthen SCREENSHOT_BLOCKED short-circuit assertion

Verify the policy rejection prevents the __SP_TAKE_SCREENSHOT__ sentinel
from ever reaching the extension (daemon trace count == 0).

Refs: docs/upp/plans/2026-05-08-safari-take-screenshot-webview.md task 12"
```

---

## Task 13: Local bench smoke — single WebVoyager task end-to-end

**Goal:** Validate the full chain (`claude -p` → MCP → engine → daemon → extension → captureVisibleTab → file → judge) on one real WebVoyager task before kicking off the 175-task overnight.

- [ ] **Step 1: Pick a single short task from the WebVoyager dataset**

```bash
cd "/Users/Aakash/Claude Projects/Skills Factory/safari-pilot"
TASKS_FULL="$(cat bench/webvoyager/TASKS_PATH)"
[[ "$TASKS_FULL" = /* ]] || TASKS_FULL="bench/webvoyager/$TASKS_FULL"

# Take the first task (~30s wall):
head -1 "$TASKS_FULL" > /tmp/wv-smoke-1.jsonl
cat /tmp/wv-smoke-1.jsonl
```

- [ ] **Step 2: Run the bench against it**

```bash
bash bench/webvoyager/run.sh \
  --variant smoke-screenshot-fix \
  --tasks-file /tmp/wv-smoke-1.jsonl \
  --concurrency 1
```

- [ ] **Step 3: Verify outputs**

```bash
SMOKE_DIR=$(ls -td bench-runs/webvoyager-smoke-screenshot-fix-* | head -1)
echo "smoke run dir: $SMOKE_DIR"
ls -la "$SMOKE_DIR"
cat "$SMOKE_DIR"/*.score.json
```

Expected:
- `screenshot_path` is a real file path, not null
- `verdict` is SUCCESS or FAILURE (not UNKNOWN — UNKNOWN means capture failed)
- Visually open the screenshot — must show the agent's actual page, not terminal output

```bash
SHOT=$(jq -r '.screenshot_path' "$SMOKE_DIR"/*.score.json | head -1)
file "$SHOT"
open "$SHOT"
```

- [ ] **Step 4: If verdict is UNKNOWN (capture failed), debug before proceeding**

UNKNOWN verdict at this stage means the capture path failed in the wild even though e2e passed. Possible causes:
- Tab cleanup race in `cleanupNewTabs` racing with screenshot
- Tab gone before screenshot fires (agent navigated, closed)
- Extension state issue — kill claude-p sessions, reload extension

Do NOT proceed to Task 14 until at least one smoke run produces a non-null screenshot of a real page. Iterate as needed; commit no code yet (this is purely operational verification).

- [ ] **Step 5: No commit (operational task — run-results aren't committed)**

```bash
git status   # nothing should be staged
```

---

## Task 14: Overnight bench — v0.1.29 dev-sample baseline (post-fix)

**Goal:** The deliverable. Produces the canonical v0.1.29 baseline number that this whole spec was built to enable.

- [ ] **Step 1: Pre-launch checks**

```bash
cd "/Users/Aakash/Claude Projects/Skills Factory/safari-pilot"
echo "OPENAI_API_KEY: $([ -n "$OPENAI_API_KEY" ] && echo set || echo NOT SET)"
[ -z "$OPENAI_API_KEY" ] && { echo "ABORT: OPENAI_API_KEY missing — source ~/.secrets.zsh"; exit 1; }

# Verify daemon + extension are healthy
curl -sS --max-time 3 http://127.0.0.1:19475/status

# Verify build is current (post-fix)
ls -la dist/index.js bin/Safari\ Pilot.app
```

- [ ] **Step 2: Launch the run in background**

```bash
bash bench/webvoyager/run.sh --variant v0.1.29-baseline-postfix --sample dev --runs 1 --concurrency 1 \
  2>&1 | tee bench-runs/launch-v0.1.29-baseline-postfix-$(date +%Y%m%d-%H%M%S).log
```

This will take ~6h wall. Run via `run_in_background: true` if executing through the harness, or detach with `nohup` + `&` if running shell-direct.

- [ ] **Step 3: Monitor for stack health every ~30 min**

While the run is in progress, periodically:

```bash
# Daemon up
ps -p $(pgrep SafariPilotd) -o pid,etime,rss
# Extension keepaliving
curl -sS --max-time 3 http://127.0.0.1:19475/status
# Verdict tally
RUN_DIR=$(ls -td bench-runs/webvoyager-v0.1.29-baseline-postfix-* | head -1)
echo "completed: $(ls "$RUN_DIR"/*.score.json 2>/dev/null | wc -l)"
echo "SUCCESS: $(grep -l '"verdict": "SUCCESS"' "$RUN_DIR"/*.score.json | wc -l)"
echo "FAILURE: $(grep -l '"verdict": "FAILURE"' "$RUN_DIR"/*.score.json | wc -l)"
echo "UNKNOWN: $(grep -l '"verdict": "UNKNOWN"' "$RUN_DIR"/*.score.json | wc -l)"
```

- [ ] **Step 4: After the run completes, evaluate against success criteria**

```bash
RUN_DIR=$(ls -td bench-runs/webvoyager-v0.1.29-baseline-postfix-* | head -1)
jq '.overall' "$RUN_DIR"/scoreboard.json
```

Verify:
- `success_rate` is a real number (not 0 — the partial run was 50% via accident; this should be the real product number).
- `capture_failure_rate` < 5% (success criterion #2). If higher, capture path has issues to debug — do NOT ship the release.
- Spot-check 5 random `*.score.json` files: open the corresponding screenshot, verify it actually shows the agent's page.

```bash
ls "$RUN_DIR"/*.score.json | shuf | head -5 | while read f; do
  shot=$(jq -r '.screenshot_path' "$f")
  echo "=== $(basename $f) ==="
  jq -r '.verdict, .judge_reasoning' "$f" | head -5
  [ -n "$shot" ] && [ "$shot" != "null" ] && open "$shot"
  echo "Press enter for next"; read
done
```

- [ ] **Step 5: Update CHECKPOINT.md, TRACES.md with results**

Add a TRACES iteration entry covering this task. Capture: success rate, capture-failure rate, wall-time vs partial-run baseline, qualitative sample-check observations.

- [ ] **Step 6: Commit nothing yet (run results live in bench-runs/, gitignored or excluded)**

If the v0.1.29 baseline is satisfying, proceed to Task 15. If it shows issues, decide whether to debug-and-rerun or accept the number.

---

## Task 15: Version bump + CHANGELOG + release pipeline

**Files:**
- Modify: `package.json` — bump version to v0.1.30
- Modify: `extension/manifest.json` — bump to 0.1.30 (both `version` + any `CFBundleShortVersionString` mirror in Info.plist if applicable)
- Modify: `CHANGELOG.md` (or create if missing) — add v0.1.30 entry

- [ ] **Step 1: Bump versions**

```bash
cd "/Users/Aakash/Claude Projects/Skills Factory/safari-pilot"
# package.json
node -e "const p=require('./package.json'); p.version='0.1.30'; require('fs').writeFileSync('./package.json', JSON.stringify(p,null,2)+'\n');"
# extension/manifest.json
node -e "const p=require('./extension/manifest.json'); p.version='0.1.30'; require('fs').writeFileSync('./extension/manifest.json', JSON.stringify(p,null,2)+'\n');"
grep '"version"' package.json extension/manifest.json
```

- [ ] **Step 2: Add CHANGELOG entry**

If `CHANGELOG.md` doesn't exist, create with this content. Otherwise prepend.

```markdown
## v0.1.30 (2026-05-08)

### BREAKING

- **`safari_take_screenshot` now captures only the Safari WebView**, not the entire screen.
  - Implementation switched from macOS `screencapture` CLI to the Safari Web Extension's
    `tabs.captureVisibleTab` API. Output is the rendered viewport of the target tab,
    at the display's native devicePixelRatio (Retina captures are 2× viewport pixels).
  - Previous behavior captured whatever was frontmost on screen — almost never Safari
    during automated benchmarks. The tool name was always Safari-specific; the
    implementation finally matches.
  - **If you relied on whole-screen capture**, downgrade to v0.1.29 or file an issue
    requesting a separate `safari_take_full_screen_screenshot` tool.
  - `format='jpeg'` is now rejected with `INVALID_PARAMS`. Previous releases silently
    accepted jpeg and returned PNG.

### Added

- New error codes: `WINDOW_CLOSED`, `CAPTURE_RACE`, `CAPTURE_FAILED`.
- New `requiresViewportCapture` flag in `ToolRequirements`.
- WebVoyager harness: `capture_failure_rate` field in scoreboard (separate from `success_rate`).
- `scripts/build-extension.sh --skip-notarize` flag for local dev iteration.

### Fixed

- WebVoyager benchmark screenshots no longer show the bench runner's terminal
  output (root cause: `screencapture` with no window-targeting flag).

### Internal

- Extension: new `__SP_TAKE_SCREENSHOT__` sentinel in `executeCommand`.
- `ExtractionTools` constructor no longer accepts a `screencaptureRunner` DI parameter.
```

- [ ] **Step 3: Build everything with the release path (full notarize)**

```bash
npm run build
bash scripts/build-extension.sh   # NO --skip-notarize this time. Full notarization.
```
Expected: ~10–30 min wall. May stall on Apple's notarization service for 1+ hour. Be patient; do not Ctrl-C.

- [ ] **Step 4: Local rehearsal — install the notarized .app, smoke test**

```bash
open "bin/Safari Pilot.app"
# Verify in Safari > Settings > Extensions — shows v0.1.30, enabled
claude --dangerously-skip-permissions -p "Use safari_new_tab to open https://example.com, then call safari_take_screenshot on it with path=/tmp/release-smoke.png. Reply DONE."
file /tmp/release-smoke.png
open /tmp/release-smoke.png
```
Expected: PNG of example.com.

- [ ] **Step 5: Run pre-tag-check**

```bash
bash scripts/pre-tag-check.sh
```
Expected: prints "ALL CHECKS PASSED — safe to tag" (or whatever the literal string is). If anything fails: do NOT tag. Investigate, fix, rebuild, re-run.

- [ ] **Step 6: Commit version bump + CHANGELOG + bin updates**

```bash
git add package.json extension/manifest.json CHANGELOG.md docs/upp/specs/2026-05-08-safari-take-screenshot-webview-design.md docs/upp/plans/2026-05-08-safari-take-screenshot-webview.md
# Note: bin/ artifacts are typically gitignored; if they are committed in this repo, add them.
git status
git commit -m "release: v0.1.30 — safari_take_screenshot captures Safari WebView

BREAKING: implementation switches from macOS screencapture (whole-screen)
to the Safari Web Extension's tabs.captureVisibleTab. See CHANGELOG.

Refs: docs/upp/plans/2026-05-08-safari-take-screenshot-webview.md task 15"
```

- [ ] **Step 7: Tag and push**

```bash
git push origin feat/v0130-screenshot-webview
# Open PR to main, get review, merge.
# After merge, on main:
git checkout main && git pull --ff-only
git tag -a v0.1.30 -m "release: v0.1.30 — safari_take_screenshot captures Safari WebView"
git push origin v0.1.30
```

- [ ] **Step 8: Watch CI release.yml**

```bash
gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```
Expected: green. If red, investigate and either patch-release v0.1.30.1 or revert the tag and fix.

- [ ] **Step 9: Update Notion roadmap item to Verifying / Shipped**

Mark the v0.1.30 screenshot-fix item as Verifying (user runs the npm package install path; on next session SessionStart hook asks about Verifying items and either marks Shipped on pass or Verification Failure).

---

## Self-review

**1. Spec coverage**

| Spec section | Plan task |
|---|---|
| Goal | Tasks 6, 8 (handler + sentinel) |
| Success criteria #1 (invalidation rate) | Task 14 (overnight verifies) |
| Success criteria #2 (capture_failure_rate < 5%) | Task 9 (metric added), Task 14 (verifies) |
| Success criteria #3 (no judge crashes) | Task 9 (null-handling gate), Task 14 (verifies) |
| Success criteria #4 (latency budget) | Task 11 (e2e p95 assertion) |
| Decisions table — race fix | Task 8 (sentinel poll loop) |
| Decisions table — JPEG rejection | Task 6 (handler validation), Task 6 (schema test) |
| Decisions table — error codes | Task 5 (errors.ts), Task 6 (handler propagation) |
| Decisions table — Retina DPR | Task 6 (tool description), no behavior change needed |
| Decisions table — sentinel wiring | Tasks 3, 4, 6, 8 |
| Decisions table — harness null-handling | Task 9 |
| Components — extension/background.js | Task 8 |
| Components — src/tools/extraction.ts | Task 6 |
| Components — src/types.ts | Task 3 |
| Components — src/engine-selector.ts | Task 4 |
| Components — src/errors.ts | Task 5 |
| Components — src/server.ts (constructor) | Task 6 step 8 |
| Components — bench/webvoyager/* | Task 9 |
| Components — scripts/build-extension.sh | Task 2 |
| Components — extension/manifest.json + package.json | Tasks 8, 15 |
| Tests — preflight | Task 1 |
| Tests — handler unit | Task 6 |
| Tests — schema/requirements unit | Task 6 |
| Tests — engine-selector unit | Task 4 |
| Tests — policy unit replacement | Task 7 |
| Tests — bench scoreboard unit | Task 9 |
| Tests — e2e red-pixel + frontmost + TAB_NOT_FOUND | Task 11 |
| Tests — existing e2e updates | Task 12 |
| Distribution — dev-loop path | Task 10 |
| Distribution — release path | Task 15 |
| Distribution — CHANGELOG | Task 15 |
| Rollback plan | Documented in spec; no plan task needed (only invoked on failure) |

**Coverage gaps:** None identified.

**2. Placeholder scan:** None — every step has actual code or commands.

**3. Type consistency:** `__SP_TAKE_SCREENSHOT__` used identically in handler (Task 6), sentinel (Task 8), tests (Tasks 6, 11). Error codes `TAB_NOT_FOUND`, `WINDOW_CLOSED`, `CAPTURE_RACE`, `CAPTURE_FAILED`, `INVALID_PARAMS` all match between Tasks 5, 6, 8, 11. `requiresViewportCapture` flag spelling consistent across Tasks 3, 4, 6.

**Plan complete.**
