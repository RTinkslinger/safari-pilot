# T55a — Frame-aware storage bus implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the executing-plans skill to implement this plan task-by-task. Supports two modes: subagent-driven (recommended, fresh subagent per task with three-stage review) or inline execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable cross-origin iframe access from the Safari Pilot extension via targeted-only dispatch, frameId-aware routing, and commandId-keyed storage — flipping `ENGINE_CAPS.extension.framesCrossOrigin` from `false` to `true` honestly.

**Architecture:** 11 tools touched (1 returns frameId, 10 accept optional `frameId` param). Manifest gains `all_frames: true` + `webNavigation` permission. Storage bus migrates from single-slot `sp_cmd`/`sp_result` to commandId-keyed `sp_cmd_<id>`/`sp_result_<id>`. Each frame learns its own frameId via lazy `sp_getFrameId` handshake. Document-mutation guard via `cmd.frameUrl` vs `location.href` comparison. New shared `_frame-routing-helper.ts` is the single source of truth for the routing rule across all 10 tool handlers.

**Tech Stack:** TypeScript (Node 20+), Safari Web Extension API (Manifest V3), Swift (daemon, Hummingbird HTTP), Vitest (unit + e2e), AppleScript (legacy engine). macOS-only (`darwin`).

**Spec:** `docs/upp/specs/2026-05-02-t55a-frame-aware-storage-bus-design.md` (commit `e9cccc4`).

**Branch:** `fix/T55a-frame-aware-storage-bus` (already created from main at `2a43370`).

---

## File structure

**New files (Extension — pure helpers, browser-free testable):**
- `extension/lib/route-command.js` — `shouldProcess(cmd, myTabId, myFrameId)` filter rule.
- `extension/lib/handshake-machine.js` — `frameIdHandshakeReducer(state, event)` pure state machine.
- `extension/lib/storage-keys.js` — `pickSpCmdKeys(storageObject)` prefix scanner.

**New files (TypeScript):**
- `src/tools/_frame-routing-helper.ts` — single routing helper consumed by 10 frame-aware tool handlers.

**New files (tests):**
- `test/unit/errors/frame-error-codes.test.ts`
- `test/unit/engine-selector/frames-cross-origin-cap.test.ts`
- `test/unit/tools/frame-routing-helper.test.ts`
- `test/unit/tools/frame-aware-tools-routing.test.ts` (parameterized over 10 tools)
- `test/unit/extension/route-command.test.ts`
- `test/unit/extension/handshake-machine.test.ts`
- `test/unit/extension/storage-keys.test.ts`
- `test/e2e/t55a-list-frames-cross-origin.test.ts`
- `test/e2e/t55a-eval-in-frame-cross-origin.test.ts`
- `test/e2e/t55a-frame-not-found.test.ts`
- `test/e2e/t55a-frame-targeted-respects-security-pipeline.test.ts`
- `test/e2e/t55a-extension-down-frame-call.test.ts`
- `test/e2e/t55a-extract-text-cross-origin.test.ts`
- `test/e2e/t55a-query-shadow-cross-origin.test.ts`
- `test/e2e/t55a-concurrent-frame-commands.test.ts`
- `test/e2e/t55a-url-change-relay-iframe-filter.test.ts`
- `test/helpers/fixture-server.ts` — Node http.createServer on 19476 + 19477.
- `test/fixtures/cross-frame/host.html`, `inner.html`, `inner-a.html`, `inner-b.html`, `shadow.html`.
- `daemon/Tests/SafariPilotdTests/ExtensionBridgeFrameIdTests.swift`

**Modified files:**
- `extension/manifest.json` — `permissions += "webNavigation"`, `content_scripts[*].all_frames = true`.
- `extension/content-isolated.js` — adopt `route-command.js`, `handshake-machine.js`, `storage-keys.js`; lazy `sp_getFrameId`; commandId-keyed sp_cmd_/sp_result_; frameUrl mutation guard.
- `extension/background.js` — `sp_getFrameId` action handler; `webNavigation.getAllFrames` validation; commandId-keyed storage writes/reads/cleanup; idle-sweep prefix-scan; test-harness poison-write paths; 10s frame-targeted timeout.
- `src/types.ts` — (no changes needed — `requiresFramesCrossOrigin` already exists).
- `src/engine-selector.ts` — flip `ENGINE_CAPS.extension.framesCrossOrigin` from `false` to `true` with precision comment.
- `src/engines/engine.ts` — add `executeJsInFrame(tabUrl: string, frameId: number, js: string)` to `IEngine`.
- `src/engines/extension.ts` — implement `executeJsInFrame`, payload includes frameId + frameUrl.
- `src/engines/applescript.ts` — `executeJsInFrame` throws `FrameNotSupportedError`.
- `src/engines/daemon.ts` — `executeJsInFrame` throws `FrameNotSupportedError`.
- `src/errors.ts` — `FRAME_NOT_FOUND`, `FRAME_NAVIGATED`, `FRAME_UNREACHABLE`, `FRAME_NOT_SUPPORTED` codes + classes.
- `src/tools/frames.ts` — `safari_list_frames` extension path uses webNavigation directly (drop merge); `safari_eval_in_frame` gains optional frameId.
- `src/tools/interaction.ts` — `safari_get_text`, `safari_get_html` gain optional frameId via shared helper.
- `src/tools/extraction.ts` — 5 extraction tools gain optional frameId via shared helper.
- `src/tools/shadow.ts` — `safari_query_shadow`, `safari_click_shadow` gain optional frameId via shared helper.
- `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` — `frameId` + `frameUrl` optional fields on Codable storage-bus payload.

**Final-step files (post-merge):**
- `package.json` — version bump (per `feedback-extension-version-both-fields`).
- `extension/Info.plist` (via `scripts/build-extension.sh` sed patches) — `CFBundleShortVersionString` + `CFBundleVersion`.
- `bin/Safari Pilot.app` — rebuilt + re-signed + re-notarized.
- `bin/Safari Pilot.zip` — release artifact.
- `ARCHITECTURE.md` — frame-aware storage bus section.
- `TRACES.md` — iteration entry.
- `docs/TRACKER.md` — T55a moved Open → Resolved.

---

## Task ordering

Foundation first (errors, interface), then pure helpers (TDD-friendliest), then bridge plumbing, then routing layer (manifest + content-isolated + background), then tool handlers, then ENGINE_CAPS flip, then e2e tests, then build/verify/document.

---

### Task 1: Frame error classes

**Files:**
- Modify: `src/errors.ts`
- Test: `test/unit/errors/frame-error-codes.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// test/unit/errors/frame-error-codes.test.ts
import { describe, it, expect } from 'vitest';
import {
  FrameNotFoundError,
  FrameNavigatedError,
  FrameUnreachableError,
  FrameNotSupportedError,
  ERROR_CODES,
} from '../../../src/errors.js';

describe('Frame error classes (T55a)', () => {
  it('FrameNotFoundError has code FRAME_NOT_FOUND, retryable=false, hint mentions safari_list_frames', () => {
    const e = new FrameNotFoundError(5);
    expect(e.code).toBe(ERROR_CODES.FRAME_NOT_FOUND);
    expect(e.retryable).toBe(false);
    expect(e.hints.join(' ')).toMatch(/safari_list_frames/);
    expect(e.message).toMatch(/5/);
  });

  it('FrameNavigatedError has code FRAME_NAVIGATED, retryable=true', () => {
    const e = new FrameNavigatedError(5, 'https://old', 'https://new');
    expect(e.code).toBe(ERROR_CODES.FRAME_NAVIGATED);
    expect(e.retryable).toBe(true);
    expect(e.message).toMatch(/old/);
    expect(e.message).toMatch(/new/);
  });

  it('FrameUnreachableError has code FRAME_UNREACHABLE, retryable=false, hint enumerates causes', () => {
    const e = new FrameUnreachableError(5);
    expect(e.code).toBe(ERROR_CODES.FRAME_UNREACHABLE);
    expect(e.retryable).toBe(false);
    expect(e.hints.join(' ')).toMatch(/sandbox|CSP|injection/i);
  });

  it('FrameNotSupportedError has code FRAME_NOT_SUPPORTED, retryable=false, hint mentions extension', () => {
    const e = new FrameNotSupportedError();
    expect(e.code).toBe(ERROR_CODES.FRAME_NOT_SUPPORTED);
    expect(e.retryable).toBe(false);
    expect(e.hints.join(' ')).toMatch(/extension/i);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run test/unit/errors/frame-error-codes.test.ts`
Expected: FAIL with "FrameNotFoundError is not exported" (or similar).

- [ ] **Step 3: Test-reviewer gate (full mode — 4 tests)**

Dispatch the `upp:test-reviewer` agent with:
- Test file content (from Step 1)
- Spec excerpt: error model table from `docs/upp/specs/2026-05-02-t55a-frame-aware-storage-bus-design.md`
- SUT source: `src/errors.ts` (current state — pre-implementation)
- Entry point: "src/errors.ts; consumed by formatToolError() in src/types.ts"

Verdict must be PASS before proceeding. If REVISE, fix tests and re-dispatch.

- [ ] **Step 4: Implement the four error classes**

Append to `src/errors.ts` (follow existing patterns — there are 21 error codes already):

```typescript
// Add these codes to ERROR_CODES (use existing exact pattern from the file):
//   FRAME_NOT_FOUND: 'FRAME_NOT_FOUND',
//   FRAME_NAVIGATED: 'FRAME_NAVIGATED',
//   FRAME_UNREACHABLE: 'FRAME_UNREACHABLE',
//   FRAME_NOT_SUPPORTED: 'FRAME_NOT_SUPPORTED',

export class FrameNotFoundError extends SafariPilotError {
  constructor(frameId: number) {
    super(
      `Frame ${frameId} not found in tab. It may have navigated or unloaded.`,
      ERROR_CODES.FRAME_NOT_FOUND,
      false,
      ['Run safari_list_frames again — frame may have navigated or unloaded.']
    );
  }
}

export class FrameNavigatedError extends SafariPilotError {
  constructor(frameId: number, expectedUrl: string, actualUrl: string) {
    super(
      `Frame ${frameId} navigated mid-command. Expected ${expectedUrl}, found ${actualUrl}.`,
      ERROR_CODES.FRAME_NAVIGATED,
      true,
      ['Frame navigated mid-command. List frames again with safari_list_frames.']
    );
  }
}

export class FrameUnreachableError extends SafariPilotError {
  constructor(frameId: number) {
    super(
      `Frame ${frameId} unreachable — content script did not load.`,
      ERROR_CODES.FRAME_UNREACHABLE,
      false,
      ['Frame may be sandboxed (no allow-scripts), CSP-blocked, or content-script injection failed.']
    );
  }
}

export class FrameNotSupportedError extends SafariPilotError {
  constructor() {
    super(
      'Cross-origin frame access requires the Safari Pilot extension engine.',
      ERROR_CODES.FRAME_NOT_SUPPORTED,
      false,
      ['Cross-origin frame access requires the Safari Pilot extension to be installed and connected.']
    );
  }
}
```

- [ ] **Step 5: Run tests — verify they pass**

Run: `npx vitest run test/unit/errors/frame-error-codes.test.ts`
Expected: 4 PASS.

- [ ] **Step 6: Verify no other tests broke**

Run: `npm run lint && npm test`
Expected: all unit tests still pass.

- [ ] **Step 7: Commit**

```bash
git add src/errors.ts test/unit/errors/frame-error-codes.test.ts
git commit -m "feat(T55a): add frame-aware error classes

FRAME_NOT_FOUND, FRAME_NAVIGATED, FRAME_UNREACHABLE,
FRAME_NOT_SUPPORTED. Used by handler guard, dispatch validation,
content-isolated.js mutation guard, and the unreachable-timeout heuristic.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 2: IEngine.executeJsInFrame interface + AppleScript/Daemon throws

**Files:**
- Modify: `src/engines/engine.ts`, `src/engines/applescript.ts`, `src/engines/daemon.ts`
- Test: `test/unit/engines/execute-js-in-frame-throws.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// test/unit/engines/execute-js-in-frame-throws.test.ts
import { describe, it, expect } from 'vitest';
import { AppleScriptEngine } from '../../../src/engines/applescript.js';
import { DaemonEngine } from '../../../src/engines/daemon.js';
import { ERROR_CODES } from '../../../src/errors.js';

describe('executeJsInFrame throws on non-extension engines (T55a)', () => {
  it('AppleScriptEngine.executeJsInFrame throws FRAME_NOT_SUPPORTED', async () => {
    const engine = new AppleScriptEngine();
    const result = await engine.executeJsInFrame('https://example.com', 5, 'return 1');
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(ERROR_CODES.FRAME_NOT_SUPPORTED);
  });

  it('DaemonEngine.executeJsInFrame throws FRAME_NOT_SUPPORTED', async () => {
    const engine = new DaemonEngine();
    const result = await engine.executeJsInFrame('https://example.com', 5, 'return 1');
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(ERROR_CODES.FRAME_NOT_SUPPORTED);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run test/unit/engines/execute-js-in-frame-throws.test.ts`
Expected: FAIL — `engine.executeJsInFrame is not a function`.

- [ ] **Step 3: Test-reviewer gate (fast mode — 2 tests)**

Dispatch `upp:test-reviewer-fast` with the test file + spec excerpt (Decisions D8 from spec) + SUT source (current `src/engines/applescript.ts`, `daemon.ts`, `engine.ts`). Verdict PASS before proceeding.

- [ ] **Step 4: Add interface + implementations**

In `src/engines/engine.ts`, add to `IEngine`:

```typescript
executeJsInFrame(tabUrl: string, frameId: number, jsCode: string, timeout?: number): Promise<EngineResult>;
```

In `src/engines/applescript.ts` (and `daemon.ts`), add:

```typescript
async executeJsInFrame(_tabUrl: string, _frameId: number, _jsCode: string, _timeout?: number): Promise<EngineResult> {
  return {
    ok: false,
    error: {
      code: ERROR_CODES.FRAME_NOT_SUPPORTED,
      message: 'Cross-origin frame access requires the Safari Pilot extension engine.',
      retryable: false,
    },
    elapsed_ms: 0,
  };
}
```

`src/engines/extension.ts` will implement properly in Task 7. For now, add a stub that throws a clear "not yet implemented" error so TypeScript compiles:

```typescript
async executeJsInFrame(_tabUrl: string, _frameId: number, _jsCode: string, _timeout?: number): Promise<EngineResult> {
  throw new Error('ExtensionEngine.executeJsInFrame: implementation pending Task 7');
}
```

- [ ] **Step 5: Run tests — verify they pass**

Run: `npm run lint && npx vitest run test/unit/engines/execute-js-in-frame-throws.test.ts`
Expected: 2 PASS, lint clean.

- [ ] **Step 6: Commit**

```bash
git add src/engines/engine.ts src/engines/applescript.ts src/engines/daemon.ts src/engines/extension.ts test/unit/engines/execute-js-in-frame-throws.test.ts
git commit -m "feat(T55a): add IEngine.executeJsInFrame interface

AppleScript and Daemon engines throw FRAME_NOT_SUPPORTED. Extension
engine stub implementation pending Task 7. The interface addition is
load-bearing — frame-aware tool handlers will route through this method.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3: Pure helper — `extension/lib/route-command.js`

**Files:**
- Create: `extension/lib/route-command.js`
- Test: `test/unit/extension/route-command.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// test/unit/extension/route-command.test.ts
import { describe, it, expect } from 'vitest';
import { shouldProcess } from '../../../extension/lib/route-command.js';

describe('shouldProcess routing rule (T55a)', () => {
  it('rejects when tabId mismatches', () => {
    expect(shouldProcess({ tabId: 1, frameId: 0 }, 2, 0)).toBe(false);
  });

  it('omitted frameId targets only top frame', () => {
    expect(shouldProcess({ tabId: 1 }, 1, 0)).toBe(true);
    expect(shouldProcess({ tabId: 1 }, 1, 3)).toBe(false);
  });

  it('explicit frameId targets only that frame', () => {
    expect(shouldProcess({ tabId: 1, frameId: 3 }, 1, 3)).toBe(true);
    expect(shouldProcess({ tabId: 1, frameId: 3 }, 1, 0)).toBe(false);
  });

  it('myFrameId null (handshake not complete) means no decision yet — caller queues', () => {
    expect(shouldProcess({ tabId: 1, frameId: 0 }, 1, null)).toBe(null);
  });

  it('frameUrl mismatch returns false (will emit FRAME_NAVIGATED upstream)', () => {
    expect(shouldProcess({ tabId: 1, frameId: 3, frameUrl: 'https://old' }, 1, 3, 'https://new')).toBe(false);
  });

  it('frameUrl match returns true', () => {
    expect(shouldProcess({ tabId: 1, frameId: 3, frameUrl: 'https://x' }, 1, 3, 'https://x')).toBe(true);
  });

  it('frameUrl absent on cmd is permissive', () => {
    expect(shouldProcess({ tabId: 1, frameId: 3 }, 1, 3, 'https://x')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run test/unit/extension/route-command.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Test-reviewer gate (full mode — 7 tests)**

Dispatch `upp:test-reviewer` with the test file + spec excerpts (storage-key invariants, filter rule from architecture section) + entry point hint: "consumed by extension/content-isolated.js storage.onChanged listener and initial-read scan."

- [ ] **Step 4: Implement the helper**

```javascript
// extension/lib/route-command.js
// Pure helper. No browser globals. Used by content-isolated.js to decide
// whether a stored sp_cmd_* belongs to this frame.
//
// Returns:
//   true  — process this command (passes filter)
//   false — skip (different tab, different frame, or stale frameUrl)
//   null  — myFrameId not yet known; caller MUST queue and re-check
//           after handshake completes
//
// Contract:
//   tabId mismatch → false (early reject)
//   myFrameId null → null (caller queues)
//   omitted cmd.frameId → matches only myFrameId === 0 (top frame)
//   explicit cmd.frameId → matches only cmd.frameId === myFrameId
//   cmd.frameUrl set → must equal currentLocationHref or → false
//
export function shouldProcess(cmd, myTabId, myFrameId, currentLocationHref) {
  if (cmd.tabId !== myTabId) return false;
  if (myFrameId === null) return null;
  const targetFrameId = cmd.frameId ?? 0;
  if (targetFrameId !== myFrameId) return false;
  if (cmd.frameUrl != null && currentLocationHref != null && cmd.frameUrl !== currentLocationHref) {
    return false;
  }
  return true;
}
```

- [ ] **Step 5: Run tests — verify they pass**

Run: `npx vitest run test/unit/extension/route-command.test.ts`
Expected: 7 PASS.

- [ ] **Step 6: Commit**

```bash
git add extension/lib/route-command.js test/unit/extension/route-command.test.ts
git commit -m "feat(T55a): pure routing helper for content-isolated.js filter

shouldProcess(cmd, myTabId, myFrameId, currentLocationHref) returns
true|false|null. null signals 'queue, handshake pending'. The single
load-bearing filter rule for the storage bus, extracted as a pure
helper for browser-free unit testing.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 4: Pure helper — `extension/lib/handshake-machine.js`

**Files:**
- Create: `extension/lib/handshake-machine.js`
- Test: `test/unit/extension/handshake-machine.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// test/unit/extension/handshake-machine.test.ts
import { describe, it, expect } from 'vitest';
import { frameIdHandshakeReducer, INITIAL_STATE } from '../../../extension/lib/handshake-machine.js';

describe('frameIdHandshakeReducer (T55a)', () => {
  it('starts in IDLE with empty queue and null myFrameId', () => {
    expect(INITIAL_STATE).toEqual({ phase: 'IDLE', myFrameId: null, queue: [] });
  });

  it('IDLE + first sp_cmd → AWAITING, queues cmd, emits sp_getFrameId effect', () => {
    const cmd = { tabId: 1, commandId: 'c1' };
    const next = frameIdHandshakeReducer(INITIAL_STATE, { type: 'sp_cmd_arrived', cmd });
    expect(next.state.phase).toBe('AWAITING_FRAME_ID');
    expect(next.state.queue).toEqual([cmd]);
    expect(next.effects).toContainEqual({ type: 'send_sp_getFrameId' });
  });

  it('AWAITING + additional sp_cmd → enqueues, no new handshake effect', () => {
    const s1 = { phase: 'AWAITING_FRAME_ID', myFrameId: null, queue: [{ commandId: 'c1' }] };
    const next = frameIdHandshakeReducer(s1, { type: 'sp_cmd_arrived', cmd: { commandId: 'c2' } });
    expect(next.state.queue.map(c => c.commandId)).toEqual(['c1', 'c2']);
    expect(next.effects).not.toContainEqual({ type: 'send_sp_getFrameId' });
  });

  it('AWAITING + handshake response → READY, drains queue as drain effects', () => {
    const queue = [{ commandId: 'c1' }, { commandId: 'c2' }];
    const s1 = { phase: 'AWAITING_FRAME_ID', myFrameId: null, queue };
    const next = frameIdHandshakeReducer(s1, { type: 'sp_getFrameId_response', frameId: 7 });
    expect(next.state.phase).toBe('READY');
    expect(next.state.myFrameId).toBe(7);
    expect(next.state.queue).toEqual([]);
    expect(next.effects).toEqual([
      { type: 'process_cmd', cmd: { commandId: 'c1' } },
      { type: 'process_cmd', cmd: { commandId: 'c2' } },
    ]);
  });

  it('AWAITING + handshake error → IDLE (queue dropped, next cmd retries)', () => {
    const s1 = { phase: 'AWAITING_FRAME_ID', myFrameId: null, queue: [{ commandId: 'c1' }] };
    const next = frameIdHandshakeReducer(s1, { type: 'sp_getFrameId_error' });
    expect(next.state.phase).toBe('IDLE');
    expect(next.state.queue).toEqual([]);
  });

  it('READY + sp_cmd → process immediately, no queue', () => {
    const s1 = { phase: 'READY', myFrameId: 7, queue: [] };
    const cmd = { commandId: 'c1' };
    const next = frameIdHandshakeReducer(s1, { type: 'sp_cmd_arrived', cmd });
    expect(next.state).toEqual(s1);
    expect(next.effects).toEqual([{ type: 'process_cmd', cmd }]);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run test/unit/extension/handshake-machine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Test-reviewer gate (full mode — 6 tests)**

Dispatch `upp:test-reviewer` with the test file + spec excerpt (Lazy `sp_getFrameId` handshake state machine from Architecture section) + entry hint: "consumed by content-isolated.js as the source of truth for handshake state."

- [ ] **Step 4: Implement the reducer**

```javascript
// extension/lib/handshake-machine.js
// Pure reducer for the lazy sp_getFrameId handshake. No browser globals.
// State shape:
//   { phase: 'IDLE' | 'AWAITING_FRAME_ID' | 'READY',
//     myFrameId: number | null,
//     queue: Array<cmd> }
// Effects (returned alongside state — caller dispatches):
//   { type: 'send_sp_getFrameId' }
//   { type: 'process_cmd', cmd }

export const INITIAL_STATE = { phase: 'IDLE', myFrameId: null, queue: [] };

export function frameIdHandshakeReducer(state, event) {
  switch (event.type) {
    case 'sp_cmd_arrived': {
      if (state.phase === 'IDLE') {
        return {
          state: { ...state, phase: 'AWAITING_FRAME_ID', queue: [event.cmd] },
          effects: [{ type: 'send_sp_getFrameId' }],
        };
      }
      if (state.phase === 'AWAITING_FRAME_ID') {
        return {
          state: { ...state, queue: [...state.queue, event.cmd] },
          effects: [],
        };
      }
      // READY
      return { state, effects: [{ type: 'process_cmd', cmd: event.cmd }] };
    }
    case 'sp_getFrameId_response': {
      if (state.phase !== 'AWAITING_FRAME_ID') return { state, effects: [] };
      const drained = state.queue.map((cmd) => ({ type: 'process_cmd', cmd }));
      return {
        state: { phase: 'READY', myFrameId: event.frameId, queue: [] },
        effects: drained,
      };
    }
    case 'sp_getFrameId_error': {
      if (state.phase !== 'AWAITING_FRAME_ID') return { state, effects: [] };
      return { state: INITIAL_STATE, effects: [] };
    }
    default:
      return { state, effects: [] };
  }
}
```

- [ ] **Step 5: Run tests — verify they pass**

Run: `npx vitest run test/unit/extension/handshake-machine.test.ts`
Expected: 6 PASS.

- [ ] **Step 6: Commit**

```bash
git add extension/lib/handshake-machine.js test/unit/extension/handshake-machine.test.ts
git commit -m "feat(T55a): pure handshake reducer for lazy sp_getFrameId

Three states: IDLE → AWAITING_FRAME_ID → READY. Queues cmds during
handshake, drains via effects when response lands, resets to IDLE on
error so next cmd retries. No browser globals — testable without a
content-script harness.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 5: Pure helper — `extension/lib/storage-keys.js`

**Files:**
- Create: `extension/lib/storage-keys.js`
- Test: `test/unit/extension/storage-keys.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// test/unit/extension/storage-keys.test.ts
import { describe, it, expect } from 'vitest';
import { pickSpCmdKeys, makeSpCmdKey, makeSpResultKey, parseCommandIdFromKey } from '../../../extension/lib/storage-keys.js';

describe('storage-keys helpers (T55a)', () => {
  it('pickSpCmdKeys finds all sp_cmd_<id> keys', () => {
    const obj = {
      sp_cmd_a: { commandId: 'a' },
      sp_cmd_b: { commandId: 'b' },
      sp_result_a: { commandId: 'a' },
      sp_unrelated: { x: 1 },
    };
    expect(pickSpCmdKeys(obj).sort()).toEqual(['sp_cmd_a', 'sp_cmd_b']);
  });

  it('pickSpCmdKeys returns empty for object with no sp_cmd_*', () => {
    expect(pickSpCmdKeys({ sp_result_a: {}, foo: 'bar' })).toEqual([]);
  });

  it('makeSpCmdKey/makeSpResultKey produce expected shapes', () => {
    expect(makeSpCmdKey('xyz')).toBe('sp_cmd_xyz');
    expect(makeSpResultKey('xyz')).toBe('sp_result_xyz');
  });

  it('parseCommandIdFromKey extracts id from sp_cmd_ and sp_result_', () => {
    expect(parseCommandIdFromKey('sp_cmd_abc')).toBe('abc');
    expect(parseCommandIdFromKey('sp_result_def')).toBe('def');
    expect(parseCommandIdFromKey('foo')).toBe(null);
  });

  it('parseCommandIdFromKey handles ids containing underscores', () => {
    expect(parseCommandIdFromKey('sp_cmd_uuid_v4_part1_part2')).toBe('uuid_v4_part1_part2');
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run test/unit/extension/storage-keys.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Test-reviewer gate (full mode — 5 tests)**

Dispatch `upp:test-reviewer` with the test file + spec excerpt (commandId-keyed storage decision D6 + spec note #5) + entry hint: "consumed by content-isolated.js initial-read and background.js writer/cleanup/idle-sweep."

- [ ] **Step 4: Implement the helper**

```javascript
// extension/lib/storage-keys.js
// Pure helpers for commandId-keyed storage bus keys.

const CMD_PREFIX = 'sp_cmd_';
const RESULT_PREFIX = 'sp_result_';

export function makeSpCmdKey(commandId) { return CMD_PREFIX + commandId; }
export function makeSpResultKey(commandId) { return RESULT_PREFIX + commandId; }

export function pickSpCmdKeys(storageObject) {
  return Object.keys(storageObject).filter((k) => k.startsWith(CMD_PREFIX));
}

export function parseCommandIdFromKey(key) {
  if (key.startsWith(CMD_PREFIX)) return key.slice(CMD_PREFIX.length);
  if (key.startsWith(RESULT_PREFIX)) return key.slice(RESULT_PREFIX.length);
  return null;
}
```

- [ ] **Step 5: Run tests — verify they pass**

Run: `npx vitest run test/unit/extension/storage-keys.test.ts`
Expected: 5 PASS.

- [ ] **Step 6: Commit**

```bash
git add extension/lib/storage-keys.js test/unit/extension/storage-keys.test.ts
git commit -m "feat(T55a): commandId-keyed storage helpers

makeSpCmdKey/makeSpResultKey produce sp_cmd_<id>/sp_result_<id>.
pickSpCmdKeys + parseCommandIdFromKey support prefix-scan reads in
content-isolated.js and background.js idle-sweep.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 6: TS frame-routing helper — `src/tools/_frame-routing-helper.ts`

**Files:**
- Create: `src/tools/_frame-routing-helper.ts`
- Test: `test/unit/tools/frame-routing-helper.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// test/unit/tools/frame-routing-helper.test.ts
import { describe, it, expect, vi } from 'vitest';
import { routeFrameAware } from '../../../src/tools/_frame-routing-helper.js';
import { ERROR_CODES } from '../../../src/errors.js';
import type { IEngine, EngineResult } from '../../../src/engines/engine.js';

function recordingEngine(name: string, result: EngineResult): IEngine & { calls: any[] } {
  const calls: any[] = [];
  return {
    name,
    isAvailable: async () => true,
    executeAppleScript: async () => result,
    executeJsInTab: async (...args) => { calls.push({ method: 'executeJsInTab', args }); return result; },
    executeJsInFrame: async (...args) => { calls.push({ method: 'executeJsInFrame', args }); return result; },
    calls,
  } as any;
}

const okResult: EngineResult = { ok: true, value: '{"x":1}', elapsed_ms: 1 };

describe('routeFrameAware (T55a)', () => {
  it('frameId omitted → calls executeJsInTab', async () => {
    const engine = recordingEngine('extension', okResult);
    await routeFrameAware(engine, { tabUrl: 'https://x' }, 'js-code');
    expect(engine.calls).toEqual([{ method: 'executeJsInTab', args: ['https://x', 'js-code'] }]);
  });

  it('frameId set + extension engine → calls executeJsInFrame', async () => {
    const engine = recordingEngine('extension', okResult);
    await routeFrameAware(engine, { tabUrl: 'https://x', frameId: 5 }, 'js-code');
    expect(engine.calls).toEqual([{ method: 'executeJsInFrame', args: ['https://x', 5, 'js-code'] }]);
  });

  it('frameId set + non-extension engine → throws FrameNotSupportedError', async () => {
    const engine = recordingEngine('applescript', okResult);
    await expect(routeFrameAware(engine, { tabUrl: 'https://x', frameId: 5 }, 'js-code'))
      .rejects.toMatchObject({ code: ERROR_CODES.FRAME_NOT_SUPPORTED });
    expect(engine.calls).toEqual([]); // never dispatched
  });

  it('frameId === 0 explicitly is treated as omitted (top frame, any engine)', async () => {
    const engine = recordingEngine('applescript', okResult);
    await routeFrameAware(engine, { tabUrl: 'https://x', frameId: 0 }, 'js-code');
    expect(engine.calls).toEqual([{ method: 'executeJsInTab', args: ['https://x', 'js-code'] }]);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run test/unit/tools/frame-routing-helper.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Test-reviewer gate (full mode — 4 tests)**

Dispatch `upp:test-reviewer` with the test file + spec excerpt (D8 + Component layout `_frame-routing-helper.ts` description) + entry hint: "consumed by 10 frame-aware tool handlers in src/tools/{frames,interaction,extraction,shadow}.ts."

- [ ] **Step 4: Implement the helper**

```typescript
// src/tools/_frame-routing-helper.ts
// Single source of truth for frameId routing across all 10 frame-aware tool handlers.
// Tools call this instead of dispatching engine.executeJsInTab themselves.
//
// Contract:
//   params.frameId == null OR === 0 → executeJsInTab (top frame, any engine)
//   params.frameId > 0 + engine.name === 'extension' → executeJsInFrame
//   params.frameId > 0 + engine.name !== 'extension' → throws FrameNotSupportedError
//
// Why this exists: spec D7 maximal v1 = 10 tools accept frameId. Without a
// shared helper the routing rule drifts across tool handlers as new tools land.
// The parameterized test in frame-aware-tools-routing.test.ts covers all 10
// tools' adoption of this helper.

import { FrameNotSupportedError } from '../errors.js';
import type { IEngine, EngineResult } from '../engines/engine.js';

export async function routeFrameAware(
  engine: IEngine,
  params: { tabUrl: string; frameId?: number },
  jsCode: string,
  timeout?: number,
): Promise<EngineResult> {
  const frameId = params.frameId;
  if (frameId == null || frameId === 0) {
    return engine.executeJsInTab(params.tabUrl, jsCode, timeout);
  }
  if (engine.name !== 'extension') {
    throw new FrameNotSupportedError();
  }
  return engine.executeJsInFrame(params.tabUrl, frameId, jsCode, timeout);
}
```

Note: `engine.name` is the existing identification field (`Engine` type in `src/types.ts`: `'extension' | 'daemon' | 'applescript'`). Confirm by reading `src/engines/engine.ts` first; if there's no `name` field, use `engine.constructor.name === 'ExtensionEngine'` instead — but `name` is the project pattern.

- [ ] **Step 5: Run tests — verify they pass**

Run: `npx vitest run test/unit/tools/frame-routing-helper.test.ts && npm run lint`
Expected: 4 PASS, lint clean.

- [ ] **Step 6: Commit**

```bash
git add src/tools/_frame-routing-helper.ts test/unit/tools/frame-routing-helper.test.ts
git commit -m "feat(T55a): shared frame-routing helper for tool handlers

routeFrameAware(engine, params, js) is the single source of truth
for frameId dispatch. Tools delegate to it instead of the engine
directly, preventing drift across 10 frame-aware tool handlers.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 7: ExtensionEngine.executeJsInFrame implementation

**Files:**
- Modify: `src/engines/extension.ts`

> No new test file in this task — Task 6 already covers the routing helper, Task 8 covers the bridge field round-trip, and the e2e tests in Tasks 19-27 cover end-to-end behavior. Implementation here is a straight thin wrapper.

- [ ] **Step 1: Read current implementation**

Read `src/engines/extension.ts` to understand `executeJsInTab`'s payload shape (which methods it calls on the daemon, what fields it sends).

- [ ] **Step 2: Implement executeJsInFrame**

Replace the Task 2 stub with a real implementation. The shape mirrors `executeJsInTab` but adds `frameId` and `frameUrl` to the daemon storage-bus payload:

```typescript
async executeJsInFrame(tabUrl: string, frameId: number, jsCode: string, timeout?: number): Promise<EngineResult> {
  const start = Date.now();
  try {
    const response = await this.bridge.execute({
      method: 'execute_script',
      params: { script: jsCode },
      tabUrl,
      frameId,
      frameUrl: tabUrl, // initial frameUrl = tabUrl; background re-resolves via webNavigation
      timeout: timeout ?? FRAME_TARGETED_TIMEOUT_MS, // 10_000
    });
    return { ok: true, value: response, elapsed_ms: Date.now() - start };
  } catch (err) {
    return {
      ok: false,
      error: this.formatBridgeError(err),
      elapsed_ms: Date.now() - start,
    };
  }
}
```

Where `FRAME_TARGETED_TIMEOUT_MS = 10_000` is a new module-local constant (top frame uses the existing 30_000 default).

`this.bridge.execute()` is whatever the existing bridge call is named — read the file to confirm. The `frameId` and `frameUrl` fields propagate through ExtensionBridge.swift (Task 8) into the storage-bus `sp_cmd_<id>` payload.

- [ ] **Step 3: Run lint + existing tests**

Run: `npm run lint && npm test`
Expected: lint clean, all unit tests still pass.

- [ ] **Step 4: Commit**

```bash
git add src/engines/extension.ts
git commit -m "feat(T55a): ExtensionEngine.executeJsInFrame implementation

Mirrors executeJsInTab but adds frameId + frameUrl to the storage-bus
payload. Uses 10s timeout (vs 30s for top frame). End-to-end coverage
by t55a-eval-in-frame-cross-origin.test.ts (Task 20).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 8: ExtensionBridge.swift — frameId/frameUrl Codable round-trip

**Files:**
- Modify: `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift`
- Test: `daemon/Tests/SafariPilotdTests/ExtensionBridgeFrameIdTests.swift`

- [ ] **Step 1: Write the failing Swift test**

Read the existing daemon test files to understand the test harness conventions (`daemon/Tests/SafariPilotdTests/main.swift` runs the suite). Add:

```swift
// daemon/Tests/SafariPilotdTests/ExtensionBridgeFrameIdTests.swift
import XCTest
@testable import SafariPilotdCore

final class ExtensionBridgeFrameIdTests: XCTestCase {
    func testFrameIdAndFrameUrlRoundTripThroughCodable_T55a() throws {
        // Construct a payload struct as the bridge would, encode, decode, verify.
        let payload = ExtensionBridgePayload(
            commandId: "cmd_xyz",
            method: "execute_script",
            params: ["script": "return 1"],
            tabUrl: "https://merchant.example.com/cart",
            frameId: 5,
            frameUrl: "https://checkout.stripe.com/inner",
            deadline: Date().timeIntervalSince1970 + 10
        )
        let encoded = try JSONEncoder().encode(payload)
        let decoded = try JSONDecoder().decode(ExtensionBridgePayload.self, from: encoded)
        XCTAssertEqual(decoded.frameId, 5)
        XCTAssertEqual(decoded.frameUrl, "https://checkout.stripe.com/inner")
    }

    func testFrameIdNilEncodesAsAbsentField_T55a() throws {
        let payload = ExtensionBridgePayload(
            commandId: "cmd_xyz",
            method: "execute_script",
            params: [:],
            tabUrl: "https://x",
            frameId: nil,
            frameUrl: nil,
            deadline: 0
        )
        let encoded = try JSONEncoder().encode(payload)
        let json = try JSONSerialization.jsonObject(with: encoded) as! [String: Any]
        XCTAssertNil(json["frameId"], "frameId should be omitted when nil so background.js sees absent field")
        XCTAssertNil(json["frameUrl"])
    }
}
```

Wire into `daemon/Tests/SafariPilotdTests/main.swift` per existing conventions.

- [ ] **Step 2: Run tests — verify they fail**

Run: `cd daemon && swift test`
Expected: FAIL — `ExtensionBridgePayload` has no `frameId`/`frameUrl` (or struct is named differently and needs updating).

- [ ] **Step 3: Test-reviewer gate (fast mode — 2 tests)**

Dispatch `upp:test-reviewer-fast` with the test file + spec excerpt (Component layout, ExtensionBridge.swift section) + entry hint: "encodes/decodes the storage-bus payload that background.js consumes."

- [ ] **Step 4: Add frameId + frameUrl to the Codable struct**

Read `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` to find the storage-bus payload struct (likely named `ExtensionCommand` or similar — confirm the exact name). Add:

```swift
let frameId: Int?
let frameUrl: String?
```

Plus the corresponding `CodingKeys` enum case if the struct has explicit keys. Encoder must emit `nil` as absent (use `encodeIfPresent`).

Find the call site that constructs this struct from incoming MCP requests (likely `handleExecute` or similar — search for the existing `tabUrl` field's call site). Pass through `frameId` and `frameUrl` from the MCP request payload.

- [ ] **Step 5: Run tests — verify they pass**

Run: `cd daemon && swift test`
Expected: all tests PASS, including 2 new ones.

- [ ] **Step 6: Commit**

```bash
git add daemon/Sources/SafariPilotdCore/ExtensionBridge.swift daemon/Tests/SafariPilotdTests/
git commit -m "feat(T55a): ExtensionBridge.swift frameId+frameUrl round-trip

Adds optional frameId (Int) and frameUrl (String) fields to the
Codable storage-bus payload. Uses encodeIfPresent so background.js
sees absent fields when frameId is omitted (top-frame default path).

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 9: manifest.json — webNavigation permission + all_frames:true

**Files:**
- Modify: `extension/manifest.json`

> The existing `test/unit/engine-selector/cap-manifest-parity.test.ts` is the gate for this task — it currently asserts `framesCrossOrigin === every-content_scripts-entry-has-all_frames`, which is `false === false` today. After this task `framesCrossOrigin` is still `false` (we flip it in Task 18) but `everyEntryAllFrames` becomes `true`, so parity FAILS until Task 18 lands. We use a temporary skip annotation here and re-enable in Task 18.

- [ ] **Step 1: Read manifest.json + parity test to confirm current state**

Run: `cat extension/manifest.json | grep -A2 content_scripts`
Confirm: no `all_frames` key on any entry. Confirm: `permissions` array does not include `webNavigation`.

- [ ] **Step 2: Add webNavigation + all_frames:true**

Edit `extension/manifest.json`:

```diff
   "permissions": [
     "activeTab",
     "scripting",
     "storage",
     "cookies",
     "declarativeNetRequest",
     "nativeMessaging",
     "tabs",
-    "alarms"
+    "alarms",
+    "webNavigation"
   ],
   ...
   "content_scripts": [
     {
       "matches": ["<all_urls>"],
       "js": ["content-isolated.js"],
       "run_at": "document_idle",
-      "world": "ISOLATED"
+      "world": "ISOLATED",
+      "all_frames": true
     },
     {
       "matches": ["<all_urls>"],
       "js": ["content-main.js"],
       "run_at": "document_idle",
-      "world": "MAIN"
+      "world": "MAIN",
+      "all_frames": true
     }
   ],
```

- [ ] **Step 3: Temporarily skip the parity test**

In `test/unit/engine-selector/cap-manifest-parity.test.ts`, change `it(` to `it.skip(` on the single test. Add an inline comment:

```typescript
// T55a: temporarily skipped between Task 9 (manifest gains all_frames:true)
// and Task 18 (ENGINE_CAPS.framesCrossOrigin flips to true). Re-enable in
// Task 18.
it.skip('framesCrossOrigin is true iff every content_scripts entry has all_frames: true', () => {
```

- [ ] **Step 4: Run unit tests — verify all pass with the skip**

Run: `npm test`
Expected: all unit tests pass; the parity test reports "skipped".

- [ ] **Step 5: Commit**

```bash
git add extension/manifest.json test/unit/engine-selector/cap-manifest-parity.test.ts
git commit -m "feat(T55a): manifest gains webNavigation + all_frames:true

Cross-origin iframes now load both content scripts. Parity test
temporarily skipped — re-enabled in Task 18 when framesCrossOrigin
flips to true. The skip is the gate that forces Task 18 to be the
final commit of the routing+manifest+cap trio.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 10: content-isolated.js — adopt pure helpers + lazy handshake + frameUrl guard

**Files:**
- Modify: `extension/content-isolated.js`

> No new unit test in this task — the pure helpers (Tasks 3, 4, 5) are already tested. End-to-end behavior is covered by Tasks 19, 20, 26, 27, 28. This task wires the helpers into the actual content-script flow.

- [ ] **Step 1: Read the current content-isolated.js end-to-end**

Read `extension/content-isolated.js` (267 lines). Note current structure: tabId registration, `processStorageCommand`, `storage.onChanged` listener, MAIN-world response listener, runtime.onMessage listener.

- [ ] **Step 2: Refactor to consume the three pure helpers + add lazy handshake**

Replace the existing storage-bus handling. Key changes:

1. Import the three helpers via `<script>` style — or, since this file is loaded as a content script, import via dynamic `import()` won't work. Instead: inline the helper module contents OR add `extension/lib/*.js` to the `content_scripts.js` array in manifest. **Simpler approach: add them to the manifest** (they execute in the same isolated world; their exports become available via globals).

   Actually content scripts in MV3 don't share scope across multiple `js` entries automatically. The cleanest path: rewrite the helpers as IIFE-wrapped globals on `window.__sp_lib__`, OR include them via build script that concatenates. Given the project's build pattern, **concatenate via a small build step**: prepend the helper sources to `content-isolated.js` at build time.

   The Edit conservative approach for v1: **inline the helper code** in `content-isolated.js` directly (10-30 lines each), keeping the lib files as the unit-test source of truth. Document the duplication with a comment pointing to the canonical source.

   Inline pattern:
   ```javascript
   // ── Pure helpers (canonical source: extension/lib/route-command.js) ────
   // If you change anything here, mirror the change in extension/lib/ + the
   // unit test, and vice versa. Concatenation build step deferred to v2.
   function shouldProcess(cmd, myTabId, myFrameId, currentLocationHref) { /* … */ }
   const INITIAL_HANDSHAKE_STATE = { phase: 'IDLE', myFrameId: null, queue: [] };
   function frameIdHandshakeReducer(state, event) { /* … */ }
   function pickSpCmdKeys(obj) { /* … */ }
   function makeSpResultKey(commandId) { return 'sp_result_' + commandId; }
   ```

2. Replace the `let myTabId = null;` block with state-machine-driven handshake:

   ```javascript
   let myTabId = null;
   let handshakeState = INITIAL_HANDSHAKE_STATE;

   function applyEffects(effects) {
     for (const eff of effects) {
       if (eff.type === 'send_sp_getFrameId') {
         browser.runtime.sendMessage({ action: 'sp_getFrameId' }).then(
           (resp) => dispatch({ type: 'sp_getFrameId_response', frameId: resp?.frameId }),
           () => dispatch({ type: 'sp_getFrameId_error' }),
         );
       } else if (eff.type === 'process_cmd') {
         processStorageCommand(eff.cmd);
       }
     }
   }

   function dispatch(event) {
     const { state, effects } = frameIdHandshakeReducer(handshakeState, event);
     handshakeState = state;
     applyEffects(effects);
   }
   ```

3. Replace the existing `tabId !== myTabId` filter in `processStorageCommand` with the helper:

   ```javascript
   function processStorageCommand(cmd) {
     const decision = shouldProcess(cmd, myTabId, handshakeState.myFrameId, location.href);
     if (decision === false) return;
     if (decision === null) {
       // handshake pending — forward to dispatch
       dispatch({ type: 'sp_cmd_arrived', cmd });
       return;
     }
     if (cmd.deadline && cmd.deadline < Date.now()) return;
     if (cmd.commandId && processedCommandIds.has(cmd.commandId)) return;
     if (cmd.commandId) processedCommandIds.add(cmd.commandId);

     // ... existing flow continues, but write to sp_result_<commandId> ...
     const resultKey = makeSpResultKey(cmd.commandId);
     // ... eventually:
     browser.storage.local.set({ [resultKey]: { commandId: cmd.commandId, result: { ok: true, value }, timestamp: Date.now() } });
   }
   ```

   When `frameUrl` mismatches `location.href` (filter returns false), emit `FRAME_NAVIGATED`:

   ```javascript
   // Inside shouldProcess decision === false branch, only when the false was due to
   // frameUrl mismatch (re-check inline since shouldProcess collapses both reasons):
   if (cmd.frameUrl != null && cmd.frameUrl !== location.href && cmd.tabId === myTabId && (cmd.frameId ?? 0) === handshakeState.myFrameId) {
     browser.storage.local.set({
       [makeSpResultKey(cmd.commandId)]: {
         commandId: cmd.commandId,
         result: { ok: false, error: { code: 'FRAME_NAVIGATED', expected: cmd.frameUrl, actual: location.href } },
         timestamp: Date.now(),
       },
     });
     return;
   }
   ```

4. Update `storage.onChanged` listener to scan for `sp_cmd_*` (not `sp_cmd`):

   ```javascript
   browser.storage.onChanged.addListener((changes, area) => {
     if (area !== 'local') return;
     for (const key of Object.keys(changes)) {
       if (!key.startsWith('sp_cmd_')) continue;
       const cmd = changes[key].newValue;
       if (!cmd) continue;
       dispatch({ type: 'sp_cmd_arrived', cmd });
     }
   });
   ```

5. Update initial-read scan:

   ```javascript
   const all = await browser.storage.local.get(null);
   for (const key of pickSpCmdKeys(all)) {
     dispatch({ type: 'sp_cmd_arrived', cmd: all[key] });
   }
   ```

6. Add a `pagehide` listener for the FRAME_NAVIGATED fast-fail path:

   ```javascript
   window.addEventListener('pagehide', () => {
     // Best-effort: tell background this frame is going away. Delivery during
     // unload is not guaranteed — the frameUrl mutation guard inside the next
     // content-isolated.js is the secondary path; webNavigation revalidation
     // is the final safety net.
     try {
       browser.runtime.sendMessage({
         action: 'sp_frame_unloading',
         frameId: handshakeState.myFrameId,
       }).catch(() => {});
     } catch {}
   });
   ```

- [ ] **Step 3: Run unit tests**

Run: `npm test`
Expected: all unit tests still pass (helpers tested; content-isolated.js itself isn't unit-tested but its imports compile and the helpers it inlines remain pure-equivalent).

- [ ] **Step 4: Commit**

```bash
git add extension/content-isolated.js
git commit -m "feat(T55a): content-isolated.js adopts pure helpers + lazy handshake

shouldProcess is the routing rule. frameIdHandshakeReducer drives lazy
sp_getFrameId. pickSpCmdKeys + makeSpResultKey support commandId-keyed
storage. frameUrl mismatch emits FRAME_NAVIGATED via sp_result.
pagehide fires sp_frame_unloading best-effort.

Helper code inlined for content-script-scope compatibility; canonical
source remains extension/lib/*.js (unit-tested). Concatenation build
step deferred to v2.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 11: background.js — sp_getFrameId handler + commandId-keyed writer/listener

**Files:**
- Modify: `extension/background.js`

- [ ] **Step 1: Read background.js sections that need updating**

Read `extension/background.js`. Key sites identified by spec note #5:
- Line 271 (writer)
- Line 258-268 (resultListener)
- Line 287 (cleanup)
- Line 430-446 (idle-sweep)
- Line 624 (URL-change relay filter — DO NOT REMOVE; Task 29 defends it)
- Line 700-723 (test-harness poison-write paths)

- [ ] **Step 2: Add sp_getFrameId action handler**

In the `runtime.onMessage` dispatcher (find the existing `sp_getTabId` handler — should be near top of `runtime.onMessage.addListener`):

```javascript
if (message.action === 'sp_getFrameId') {
  // sender.frameId is the authoritative answer for the calling content script.
  // 0 = top frame, > 0 = iframe (frameId stable for life of frame).
  sendResponse({ frameId: sender?.frameId ?? null });
  return false; // synchronous response; no return-true keep-alive needed
}

if (message.action === 'sp_frame_unloading') {
  // Best-effort fast-fail. Mark any in-flight commandId targeting this
  // {tabId, frameId} as FRAME_NAVIGATED.
  const tabId = sender?.tab?.id;
  const frameId = message.frameId;
  // Iterate in-flight pendingResultListeners for matches, resolve as
  // FRAME_NAVIGATED. Implementation depends on existing pending-tracking
  // structure; see line 240-est for resolver pattern.
  // Safe minimum: do nothing. The frameUrl guard in the new content-isolated.js
  // catches the document-mutation case; this best-effort path only saves time.
  return false;
}
```

- [ ] **Step 3: Convert writer (line 271) to commandId-keyed**

Replace:
```javascript
await browser.storage.local.set({ sp_cmd: storageCmd });
```
With:
```javascript
const cmdKey = 'sp_cmd_' + commandId;
await browser.storage.local.set({ [cmdKey]: storageCmd });
```

- [ ] **Step 4: Convert resultListener (line 258-268) to filter on keyed result**

Replace:
```javascript
function resultListener(changes, area) {
  if (area !== 'local' || !changes.sp_result?.newValue) return;
  const reply = changes.sp_result.newValue;
  if (reply.commandId !== commandId) return;
  // ...
}
```
With:
```javascript
const resultKey = 'sp_result_' + commandId;
function resultListener(changes, area) {
  if (area !== 'local' || !changes[resultKey]?.newValue) return;
  const reply = changes[resultKey].newValue;
  // commandId already implied by key match — no double-check needed
  // ...
}
```

- [ ] **Step 5: Convert cleanup (line 287)**

Replace:
```javascript
try { await browser.storage.local.remove(['sp_cmd', 'sp_result']); } catch { /* ignore */ }
```
With:
```javascript
try {
  await browser.storage.local.remove(['sp_cmd_' + commandId, 'sp_result_' + commandId]);
} catch { /* ignore */ }
```

- [ ] **Step 6: Run unit tests**

Run: `npm test`
Expected: all unit tests still pass (background.js isn't unit-tested directly; this verifies nothing else imports its internal shape).

- [ ] **Step 7: Commit**

```bash
git add extension/background.js
git commit -m "feat(T55a): background.js — sp_getFrameId + commandId-keyed storage

Writer/listener/cleanup migrate from single-slot sp_cmd/sp_result
to sp_cmd_<id>/sp_result_<id>. New sp_getFrameId action returns
sender.frameId. sp_frame_unloading is a best-effort hook — minimum
viable implementation is a no-op; frameUrl guard catches the case.

Idle-sweep + test-harness poison paths in next task.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 12: background.js — webNavigation validation + 10s frame-targeted timeout

**Files:**
- Modify: `extension/background.js`

- [ ] **Step 1: Add webNavigation.getAllFrames validation in handleExecute**

In the `handleExecute(cmd)` function (find by searching for `findTargetTab` call), add validation BEFORE the `storage.local.set` writer:

```javascript
// T55a: validate frameId at dispatch time
if (cmd.frameId != null && cmd.frameId !== 0) {
  let frames;
  try {
    frames = await browser.webNavigation.getAllFrames({ tabId: tab.id });
  } catch (e) {
    return { ok: false, error: { code: 'FRAME_NOT_FOUND', message: 'webNavigation.getAllFrames failed: ' + e.message } };
  }
  const target = frames.find((f) => f.frameId === cmd.frameId);
  if (!target) {
    return { ok: false, error: { code: 'FRAME_NOT_FOUND', message: `Frame ${cmd.frameId} not found in tab ${tab.id}` } };
  }
  // Re-resolve frameUrl to the frame's CURRENT URL at dispatch time so
  // content-isolated.js can compare against location.href on receipt.
  cmd.frameUrl = target.url;
}
```

- [ ] **Step 2: Apply 10s timeout for frame-targeted dispatch (vs 30s top-frame)**

Find the existing `resultTimeout` (line 252-est):
```javascript
const resultTimeout = setTimeout(() => {
  // ...
}, 30000);
```

Replace with conditional:
```javascript
const TIMEOUT_MS = (cmd.frameId != null && cmd.frameId !== 0) ? 10000 : 30000;
const resultTimeout = setTimeout(() => {
  clearInterval(keepAlive);
  browser.storage.onChanged.removeListener(resultListener);
  const code = (cmd.frameId != null && cmd.frameId !== 0)
    ? 'FRAME_UNREACHABLE'
    : 'STORAGE_BUS_TIMEOUT';
  resultResolver({
    ok: false,
    error: { code, message: code === 'FRAME_UNREACHABLE'
      ? `Frame ${cmd.frameId} unreachable — content script did not respond within ${TIMEOUT_MS}ms (sandbox/CSP/injection failure?)`
      : `Storage bus timeout (${TIMEOUT_MS}ms) — content script may not be loaded on target tab` }
  });
}, TIMEOUT_MS);
```

- [ ] **Step 3: Run unit tests + build**

Run: `npm run lint && npm run build && npm test`
Expected: lint clean, build clean, all unit tests pass.

- [ ] **Step 4: Commit**

```bash
git add extension/background.js
git commit -m "feat(T55a): background.js — webNavigation validation + 10s frame timeout

handleExecute calls webNavigation.getAllFrames when cmd.frameId is set,
returns FRAME_NOT_FOUND if missing. Re-resolves frameUrl to the frame's
current URL at dispatch (content-isolated.js then compares against
location.href on receipt for the document-mutation guard).

Frame-targeted commands use 10s timeout (vs 30s for top-frame).
Timeout emits FRAME_UNREACHABLE when no result lands — heuristic for
sandbox/CSP/injection failure.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 13: background.js — idle-sweep prefix-scan + test-harness poison paths

**Files:**
- Modify: `extension/background.js`

- [ ] **Step 1: Update idle-sweep (line 430-446) for prefix-scan**

Replace the existing block:
```javascript
const stored = await browser.storage.local.get(['sp_cmd', 'sp_result']);
// ...
if (stored.sp_cmd && (!stored.sp_cmd.commandId || !liveIds.has(stored.sp_cmd.commandId))) {
  toRemove.push('sp_cmd');
  removedDetails.sp_cmd = stored.sp_cmd.commandId ?? null;
}
if (stored.sp_result && (!stored.sp_result.commandId || !liveIds.has(stored.sp_result.commandId))) {
  toRemove.push('sp_result');
  removedDetails.sp_result = stored.sp_result.commandId ?? null;
}
```

With:
```javascript
const stored = await browser.storage.local.get(null);
for (const key of Object.keys(stored)) {
  if (!key.startsWith('sp_cmd_') && !key.startsWith('sp_result_')) continue;
  const commandId = key.startsWith('sp_cmd_') ? key.slice(7) : key.slice(10);
  if (!liveIds.has(commandId)) {
    toRemove.push(key);
    removedDetails[key] = commandId;
  }
}
```

- [ ] **Step 2: Update test-harness poison-write paths (line 700-723)**

Find the existing `op.poison?.sp_result` and `op.poison?.sp_cmd` writes in the `__sp_test__` action handler. Per spec note #5, these must update to write keyed slots.

Search the block for `writes.sp_result = op.poison.sp_result` and similar. Replace with:

```javascript
// T55a: poison paths must use commandId-keyed slots so the storage bus's
// commandId-keyed listener actually fires. Tests that poison the storage
// bus must specify which commandId to poison.
if (op.poison?.sp_result) {
  const cid = op.poison.commandId ?? 'unknown';
  writes['sp_result_' + cid] = op.poison.sp_result;
}
if (op.poison?.sp_cmd) {
  const cid = op.poison.commandId ?? 'unknown';
  writes['sp_cmd_' + cid] = op.poison.sp_cmd;
}
```

(Test code that uses these paths will need to add a `commandId` field to the poison op. Existing test files that exercise these paths are not in v1 scope but flag any that break in Step 4.)

- [ ] **Step 3: Verify safari_extension_debug_dump doesn't hardcode sp_cmd/sp_result literal**

Run: `grep -n "'sp_cmd'\|'sp_result'\|\"sp_cmd\"\|\"sp_result\"" extension/background.js src/tools/`

If any literal `sp_cmd` or `sp_result` references remain (outside the prefix-aware code added in this task and Task 11), update them to either accept a commandId or scan with prefix. Report findings in the commit body.

- [ ] **Step 4: Run unit tests**

Run: `npm run lint && npm run build && npm test`
Expected: all unit tests still pass.

- [ ] **Step 5: Commit**

```bash
git add extension/background.js
git commit -m "feat(T55a): background.js — idle-sweep prefix-scan + poison-path keys

Idle-sweep now reads storage.local.get(null) and prefix-scans both
sp_cmd_* and sp_result_* keys, removing entries whose commandId is
not in the liveIds set.

Test-harness poison paths require commandId in the op so writes land
in keyed slots — tests that exercised the old literal sp_cmd/sp_result
paths must update.

Verified safari_extension_debug_dump has no hardcoded key literals.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 14: src/tools/frames.ts — list_frames returns frameId; eval_in_frame frameId param

**Files:**
- Modify: `src/tools/frames.ts`

- [ ] **Step 1: Read current frames.ts**

Read all of `src/tools/frames.ts` (current ~150 lines, both handlers).

- [ ] **Step 2: Update safari_list_frames extension path (drop merge)**

Per spec B3 — the merge-by-index/src is bug-prone. Extension path returns webNavigation directly. Implementation:

The handler already calls `engine.executeJsInTab(tabUrl, listFramesJs)` for top-frame DOM enumeration. After this work:

```typescript
private async handleListFrames(params: Record<string, unknown>): Promise<ToolResponse> {
  const start = Date.now();
  const tabUrl = params['tabUrl'] as string;

  // Branch on engine type. Extension path uses webNavigation; others fall back to DOM enumeration.
  if (this.engine.name === 'extension') {
    // Send a special method that background.js handles by calling
    // browser.webNavigation.getAllFrames and returning the result directly.
    const result = await (this.engine as any).executeWebNavigationListFrames(tabUrl);
    if (!result.ok) throw new Error(result.error?.message ?? 'List frames failed');
    return this.makeResponse(JSON.parse(result.value), Date.now() - start);
  }

  // AppleScript path: existing DOM enumeration; frameId field set to null.
  const js = `
    var frames = Array.from(document.querySelectorAll('iframe'));
    return {
      count: frames.length,
      frames: frames.map(function(f, idx) {
        var rect = f.getBoundingClientRect();
        return {
          index: idx,
          frameId: null,         /* T55a: AppleScript path can't resolve frameId */
          parentFrameId: null,
          src: f.src || null,
          name: f.name || null,
          id: f.id || null,
          width: f.width || rect.width,
          height: f.height || rect.height,
          sandbox: f.sandbox ? f.sandbox.value : null,
        };
      }),
    };
  `;
  const result = await this.engine.executeJsInTab(tabUrl, js);
  if (!result.ok) throw new Error(result.error?.message ?? 'List frames failed');
  return this.makeResponse(result.value ? JSON.parse(result.value) : { count: 0, frames: [] }, Date.now() - start);
}
```

`executeWebNavigationListFrames` is a new method on `ExtensionEngine` (add to the class — not on `IEngine` since it's extension-specific). Implementation: sends a payload with `method: 'list_frames_via_webNavigation'` to ExtensionBridge → background.js handles by calling `browser.webNavigation.getAllFrames({tabId})` and returning the result.

This requires three small additions:
1. `ExtensionEngine.executeWebNavigationListFrames(tabUrl)` method.
2. ExtensionBridge.swift passthrough for the new method (no decoding logic — it's just another method name on the storage bus).
3. `background.js` handler for `cmd.method === 'list_frames_via_webNavigation'` that calls `webNavigation.getAllFrames` and writes the result to sp_result_<commandId>.

- [ ] **Step 3: Update safari_eval_in_frame to accept optional frameId**

Add `frameId` to `inputSchema.properties`:

```typescript
{
  name: 'safari_eval_in_frame',
  description:
    'Execute arbitrary JavaScript inside a specific iframe\'s context. ' +
    'Supports same-origin via frameSelector (existing path) and cross-origin ' +
    'via frameId (requires extension engine). When both are provided, frameId wins.',
  inputSchema: {
    type: 'object',
    properties: {
      tabUrl: { type: 'string', description: 'Current URL of the tab' },
      frameSelector: { type: 'string', description: 'CSS selector for the target iframe (same-origin only)' },
      frameId: { type: 'number', description: 'Numeric frameId from safari_list_frames (required for cross-origin frames)' },
      script: { type: 'string', description: 'JavaScript code to execute inside the frame' },
    },
    required: ['tabUrl', 'script'],
  },
  requirements: { idempotent: false, requiresFramesCrossOrigin: true },
},
```

In `handleEvalInFrame`, if `params.frameId` is set, route through `routeFrameAware` (which calls `engine.executeJsInFrame`). Otherwise the existing same-origin `frame.contentWindow.Function(...)` path runs.

```typescript
private async handleEvalInFrame(params: Record<string, unknown>): Promise<ToolResponse> {
  const start = Date.now();
  const tabUrl = params['tabUrl'] as string;
  const frameId = params['frameId'] as number | undefined;
  const frameSelector = params['frameSelector'] as string | undefined;
  const script = params['script'] as string;

  if (frameId != null && frameId !== 0) {
    // Cross-origin path: routeFrameAware enforces engine === extension and dispatches.
    const result = await routeFrameAware(this.engine, { tabUrl, frameId }, script);
    if (!result.ok) throw new Error(result.error?.message ?? 'Frame eval failed');
    return this.makeResponse(result.value ? JSON.parse(result.value) : null, Date.now() - start);
  }

  // Existing same-origin contentWindow path (unchanged)
  if (!frameSelector) throw new Error('safari_eval_in_frame requires either frameId or frameSelector');
  // ... existing JS eval block unchanged ...
}
```

Add the import at top: `import { routeFrameAware } from './_frame-routing-helper.js';`

- [ ] **Step 4: Run lint + tests**

Run: `npm run lint && npm test`
Expected: all unit tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/frames.ts src/engines/extension.ts daemon/Sources/SafariPilotdCore/ExtensionBridge.swift extension/background.js
git commit -m "feat(T55a): safari_list_frames returns frameId; safari_eval_in_frame frameId param

list_frames extension path uses webNavigation.getAllFrames directly
(drops bug-prone merge-by-index/src). AppleScript path keeps DOM
enumeration with frameId: null.

eval_in_frame accepts optional frameId; precedence over frameSelector.
When set, routes via routeFrameAware → executeJsInFrame → bridge.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 15: src/tools/interaction.ts — get_text + get_html frameId param

**Files:**
- Modify: `src/tools/interaction.ts`

- [ ] **Step 1: Read current handlers + schemas**

Find `safari_get_text` and `safari_get_html` definitions and handlers.

- [ ] **Step 2: Add frameId param + route via shared helper**

For each of `safari_get_text` and `safari_get_html`:

1. Add `frameId: { type: 'number', description: 'Optional: target a specific iframe by frameId from safari_list_frames' }` to `inputSchema.properties`.
2. Add `requiresFramesCrossOrigin: true` to `requirements` (the requirement is dynamic on the param presence — but since the helper handles the engine check, the static flag is fine to mark as "may require extension"; the actual gating happens in the helper at dispatch time).
3. In the handler, replace the existing `engine.executeJsInTab(tabUrl, js)` call with `routeFrameAware(engine, { tabUrl, frameId }, js)`.

Pattern:
```typescript
import { routeFrameAware } from './_frame-routing-helper.js';

private async handleGetText(params: Record<string, unknown>): Promise<ToolResponse> {
  const start = Date.now();
  const tabUrl = params['tabUrl'] as string;
  const frameId = params['frameId'] as number | undefined;
  // ... build js as before ...
  const result = await routeFrameAware(this.engine, { tabUrl, frameId }, js);
  if (!result.ok) throw new Error(result.error?.message ?? 'Get text failed');
  return this.makeResponse(/* parse result.value as before */);
}
```

- [ ] **Step 3: Run lint + tests**

Run: `npm run lint && npm test`
Expected: all unit tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/tools/interaction.ts
git commit -m "feat(T55a): safari_get_text + safari_get_html accept frameId

Both tools route via routeFrameAware. frameId omitted → top frame
(existing path). frameId set → cross-origin frame via extension
engine; non-extension engines throw FrameNotSupportedError.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 16: src/tools/extraction.ts — 5 extraction tools frameId param

**Files:**
- Modify: `src/tools/extraction.ts`

- [ ] **Step 1: Read current handlers**

Find: `safari_extract_text`, `safari_extract_links`, `safari_extract_tables`, `safari_extract_metadata`, `safari_extract_images`.

- [ ] **Step 2: Apply same pattern as Task 15 to all 5**

For each of the 5: add `frameId` to schema + `requiresFramesCrossOrigin: true` to requirements + replace `executeJsInTab` call with `routeFrameAware`.

- [ ] **Step 3: Run lint + tests**

Run: `npm run lint && npm test`

- [ ] **Step 4: Commit**

```bash
git add src/tools/extraction.ts
git commit -m "feat(T55a): 5 extraction tools accept frameId param

extract_text, extract_links, extract_tables, extract_metadata,
extract_images all route via routeFrameAware.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 17: src/tools/shadow.ts — query_shadow + click_shadow frameId param

**Files:**
- Modify: `src/tools/shadow.ts`

- [ ] **Step 1-4: Same pattern as Task 15 for the 2 shadow tools**

```bash
git commit -m "feat(T55a): safari_query_shadow + safari_click_shadow accept frameId

Both tools route via routeFrameAware. Shadow DOM lookup happens
inside the targeted frame's document tree.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 18: Parameterized routing test + ENGINE_CAPS flip + cap-parity test re-enable

**Files:**
- Create: `test/unit/tools/frame-aware-tools-routing.test.ts`
- Modify: `src/engine-selector.ts`
- Modify: `test/unit/engine-selector/cap-manifest-parity.test.ts` (un-skip)
- Create: `test/unit/engine-selector/frames-cross-origin-cap.test.ts`

- [ ] **Step 1: Write the parameterized routing test**

```typescript
// test/unit/tools/frame-aware-tools-routing.test.ts
import { describe, it, expect } from 'vitest';
import { ERROR_CODES } from '../../../src/errors.js';
import { FrameTools } from '../../../src/tools/frames.js';
import { InteractionTools } from '../../../src/tools/interaction.js';
import { ExtractionTools } from '../../../src/tools/extraction.js';
import { ShadowTools } from '../../../src/tools/shadow.js';
import type { IEngine, EngineResult } from '../../../src/engines/engine.js';

const okResult: EngineResult = { ok: true, value: '{"x":1}', elapsed_ms: 1 };

function recordingEngine(name: 'extension' | 'applescript') {
  const calls: any[] = [];
  return {
    name,
    isAvailable: async () => true,
    executeAppleScript: async () => okResult,
    executeJsInTab: async (...args: any[]) => { calls.push({ method: 'executeJsInTab', args }); return okResult; },
    executeJsInFrame: async (...args: any[]) => { calls.push({ method: 'executeJsInFrame', args }); return okResult; },
    calls,
  } as any;
}

const FRAME_AWARE_TOOLS: Array<{ tool: string; module: any; minParams: any }> = [
  { tool: 'safari_eval_in_frame', module: FrameTools, minParams: { tabUrl: 'https://x', script: 'return 1' } },
  { tool: 'safari_get_text', module: InteractionTools, minParams: { tabUrl: 'https://x', selector: 'div' } },
  { tool: 'safari_get_html', module: InteractionTools, minParams: { tabUrl: 'https://x', selector: 'div' } },
  { tool: 'safari_extract_text', module: ExtractionTools, minParams: { tabUrl: 'https://x' } },
  { tool: 'safari_extract_links', module: ExtractionTools, minParams: { tabUrl: 'https://x' } },
  { tool: 'safari_extract_tables', module: ExtractionTools, minParams: { tabUrl: 'https://x' } },
  { tool: 'safari_extract_metadata', module: ExtractionTools, minParams: { tabUrl: 'https://x' } },
  { tool: 'safari_extract_images', module: ExtractionTools, minParams: { tabUrl: 'https://x' } },
  { tool: 'safari_query_shadow', module: ShadowTools, minParams: { tabUrl: 'https://x', selector: 'x' } },
  { tool: 'safari_click_shadow', module: ShadowTools, minParams: { tabUrl: 'https://x', selector: 'x' } },
];

describe.each(FRAME_AWARE_TOOLS)('%s frame-aware routing (T55a)', ({ tool, module, minParams }) => {
  it('frameId omitted → executeJsInTab', async () => {
    const engine = recordingEngine('applescript');
    const inst = new module(engine);
    const handler = inst.getHandler(tool);
    await handler!(minParams);
    expect(engine.calls.some((c: any) => c.method === 'executeJsInTab')).toBe(true);
    expect(engine.calls.some((c: any) => c.method === 'executeJsInFrame')).toBe(false);
  });

  it('frameId set + extension engine → executeJsInFrame', async () => {
    const engine = recordingEngine('extension');
    const inst = new module(engine);
    const handler = inst.getHandler(tool);
    await handler!({ ...minParams, frameId: 5 });
    expect(engine.calls.some((c: any) => c.method === 'executeJsInFrame')).toBe(true);
  });

  it('frameId set + non-extension engine → throws FRAME_NOT_SUPPORTED', async () => {
    const engine = recordingEngine('applescript');
    const inst = new module(engine);
    const handler = inst.getHandler(tool);
    await expect(handler!({ ...minParams, frameId: 5 })).rejects.toMatchObject({ code: ERROR_CODES.FRAME_NOT_SUPPORTED });
  });
});
```

- [ ] **Step 2: Write the cap test**

```typescript
// test/unit/engine-selector/frames-cross-origin-cap.test.ts
import { describe, it, expect } from 'vitest';
import { selectEngine, ENGINE_CAPS } from '../../../src/engine-selector.js';
import { ERROR_CODES } from '../../../src/errors.js';

describe('framesCrossOrigin capability flag (T55a)', () => {
  it('ENGINE_CAPS.extension.framesCrossOrigin is true after T55a', () => {
    expect(ENGINE_CAPS.extension.framesCrossOrigin).toBe(true);
  });

  it('selectEngine returns extension for tool with requiresFramesCrossOrigin when extension available', () => {
    const tool = { idempotent: false, requiresFramesCrossOrigin: true };
    expect(selectEngine(tool, { extension: true, daemon: true })).toBe('extension');
  });

  it('selectEngine throws when requiresFramesCrossOrigin and extension unavailable', () => {
    const tool = { idempotent: false, requiresFramesCrossOrigin: true };
    expect(() => selectEngine(tool, { extension: false, daemon: true })).toThrow(/extension/i);
  });
});
```

- [ ] **Step 3: Run tests — verify failures**

Run: `npx vitest run test/unit/engine-selector/frames-cross-origin-cap.test.ts test/unit/tools/frame-aware-tools-routing.test.ts`
Expected: routing-test passes (helpers + tools wired in Tasks 6, 14-17). Cap-test fails (cap is still false).

- [ ] **Step 4: Test-reviewer gate (full mode — combined ~33 cases)**

Dispatch `upp:test-reviewer` with both test files + spec excerpts (D7 maximal scope, Component layout `_frame-routing-helper.ts`, Risk register row "10 frame-aware tools drift") + entry hint: "the parameterized test is the architecture-litmus for D7."

- [ ] **Step 5: Flip ENGINE_CAPS.extension.framesCrossOrigin to true**

In `src/engine-selector.ts`:

```diff
   extension: {
     shadowDom: true,
     cspBypass: true,
     networkIntercept: true,
-    framesCrossOrigin: false,
+    // T55a: true = the extension can inject content scripts into typical
+    // cross-origin iframes via manifest all_frames:true. FRAME_UNREACHABLE
+    // is returned when injection fails for a specific frame (sandbox without
+    // allow-scripts, page CSP blocking extension scripts, COOP/COEP isolation,
+    // or silent injection failure).
+    framesCrossOrigin: true,
```

- [ ] **Step 6: Re-enable the parity test**

In `test/unit/engine-selector/cap-manifest-parity.test.ts`, change `it.skip(` back to `it(`. Remove the temporary T55a comment block.

- [ ] **Step 7: Run all unit tests**

Run: `npm run lint && npm run build && npm test`
Expected: all unit tests pass — including cap-parity (now `true === true`), the new cap test, and the parameterized routing test.

- [ ] **Step 8: Commit**

```bash
git add src/engine-selector.ts test/unit/engine-selector/cap-manifest-parity.test.ts test/unit/engine-selector/frames-cross-origin-cap.test.ts test/unit/tools/frame-aware-tools-routing.test.ts
git commit -m "feat(T55a): flip framesCrossOrigin cap + parameterized routing test

ENGINE_CAPS.extension.framesCrossOrigin: true. Cap-manifest-parity
test re-enabled (now passes). New parameterized test covers all 10
frame-aware tools' adoption of routeFrameAware — adding a new tool
that bypasses the helper fails its case.

This is the third commit of the routing+manifest+cap trio (Tasks 9
manifest, 10-13 routing, 18 cap). After this commit
ENGINE_CAPS lies less.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 19: E2E fixture infrastructure

**Files:**
- Create: `test/helpers/fixture-server.ts`
- Create: `test/fixtures/cross-frame/host.html`, `inner.html`, `inner-a.html`, `inner-b.html`, `shadow.html`

- [ ] **Step 1: Create the fixture server**

```typescript
// test/helpers/fixture-server.ts
// Node http.createServer bound on two ports for cross-origin iframe e2e.
// 19476 = host page port. 19477 = inner page port. Different ports = different
// origins per same-origin policy.

import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const FIXTURE_DIR = resolve(__filename, '../../fixtures/cross-frame');

export interface FixtureServer { close: () => Promise<void>; hostPort: number; innerPort: number; }

export async function startFixtureServer(): Promise<FixtureServer> {
  const hostPort = parseInt(process.env.SAFARI_PILOT_FIXTURE_PORT_HOST ?? '19476', 10);
  const innerPort = parseInt(process.env.SAFARI_PILOT_FIXTURE_PORT_INNER ?? '19477', 10);

  const handle = (req: any, res: any) => {
    const url = req.url ?? '/';
    const file = url === '/' ? 'host.html' : url.replace(/^\/+/, '');
    try {
      const body = readFileSync(resolve(FIXTURE_DIR, file));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  };

  const hostServer = createServer(handle);
  const innerServer = createServer(handle);

  await Promise.all([
    new Promise<void>((r) => hostServer.listen(hostPort, '127.0.0.1', r)),
    new Promise<void>((r) => innerServer.listen(innerPort, '127.0.0.1', r)),
  ]);

  return {
    hostPort,
    innerPort,
    close: async () => {
      await Promise.all([
        new Promise<void>((r) => hostServer.close(() => r())),
        new Promise<void>((r) => innerServer.close(() => r())),
      ]);
    },
  };
}
```

- [ ] **Step 2: Create the fixture HTML files**

`test/fixtures/cross-frame/host.html`:
```html
<!DOCTYPE html>
<html><head><title>Host Page</title></head>
<body>
  <h1>Host page (port 19476)</h1>
  <iframe id="inner" src="http://127.0.0.1:19477/inner.html" width="600" height="400"></iframe>
</body></html>
```

`test/fixtures/cross-frame/inner.html`:
```html
<!DOCTYPE html>
<html><head><title>Inner Frame Document</title></head>
<body>
  <h1 id="marker">Inner frame body — distinct from host</h1>
  <p>This text only exists in the cross-origin iframe.</p>
</body></html>
```

`inner-a.html`, `inner-b.html` (same shape, distinct titles + markers for the concurrent test).

`shadow.html`:
```html
<!DOCTYPE html>
<html><head><title>Shadow inside frame</title></head>
<body>
  <div id="host"></div>
  <script>
    const root = document.getElementById('host').attachShadow({ mode: 'open' });
    root.innerHTML = '<p id="shadow-marker">shadow content</p>';
  </script>
</body></html>
```

- [ ] **Step 3: Smoke-test the fixture server**

Run a one-off check:
```bash
node -e "import('./test/helpers/fixture-server.js').then(async ({startFixtureServer}) => { const s = await startFixtureServer(); const r = await fetch('http://127.0.0.1:19476/'); console.log(r.status, (await r.text()).slice(0, 80)); await s.close(); })"
```
Expected: `200 <!DOCTYPE html>...`

- [ ] **Step 4: Commit**

```bash
git add test/helpers/fixture-server.ts test/fixtures/cross-frame/
git commit -m "test(T55a): cross-origin iframe fixture server

Node http.createServer on 19476 + 19477 for cross-origin e2e.
Fixture HTML in test/fixtures/cross-frame/. Override ports via
SAFARI_PILOT_FIXTURE_PORT_HOST / _INNER env vars.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 20: e2e — t55a-list-frames-cross-origin

**Files:**
- Create: `test/e2e/t55a-list-frames-cross-origin.test.ts`

> Tasks 20-28 are e2e tests against the full production stack. Each must:
> (1) start the fixture server in `beforeAll`, stop in `afterAll`;
> (2) open a new tab via `safari_new_tab` (NEVER activate/navigate an existing tab — memory `feedback-never-switch-user-tabs`);
> (3) close the tab in `afterAll` with a URL marker `?sp_t<N>=` (memory `feedback-e2e-tests-must-close-tabs`);
> (4) test against the MCP JSON-RPC boundary via `test/helpers/mcp-client.ts` (zero internal-module imports — memory `feedback-e2e-means-e2e`);
> (5) verify the litmus deletion fails the test as a one-time manual check, documented in the commit body.

- [ ] **Step 1: Write the failing test**

```typescript
// test/e2e/t55a-list-frames-cross-origin.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';
import { McpTestClient } from '../helpers/mcp-client.js';

describe('T55a — safari_list_frames returns cross-origin frameId', () => {
  let fixture: FixtureServer;
  let mcp: McpTestClient;
  let tabUrl: string;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    mcp = await McpTestClient.start();
    tabUrl = `http://127.0.0.1:${fixture.hostPort}/host.html?sp_t20=1`;
    await mcp.callTool('safari_new_tab', { url: tabUrl });
  }, 30_000);

  afterAll(async () => {
    try { await mcp.callTool('safari_close_tab', { tabUrl }); } catch {}
    await mcp.stop();
    await fixture.close();
  });

  it('returns at least one frame with frameId !== 0, parentFrameId === 0, src matching inner port', async () => {
    const result = await mcp.callTool('safari_list_frames', { tabUrl });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.count).toBeGreaterThanOrEqual(1);
    const innerFrame = parsed.frames.find((f: any) => f.src && f.src.includes(`:${fixture.innerPort}`));
    expect(innerFrame, 'expected to find a frame served from the inner-port origin').toBeDefined();
    expect(innerFrame.frameId).not.toBe(0);
    expect(innerFrame.frameId).not.toBeNull();
    expect(innerFrame.parentFrameId).toBe(0);
  });
});
```

- [ ] **Step 2: Run test — verify it fails (or fails for the right reason)**

Run: `npx vitest run -c vitest.config.e2e.ts test/e2e/t55a-list-frames-cross-origin.test.ts --reporter=verbose`
Expected pre-Task-9 + Task-14 wiring: FAIL because either webNavigation isn't requested, all_frames isn't true, or list_frames doesn't return frameId.

If the prior tasks (9, 12, 14) have shipped and the production stack has the new extension build, this test should PASS first try. Document either outcome.

- [ ] **Step 3: Test-reviewer gate (fast-mode — 1 test)**

Dispatch `upp:test-reviewer-fast` with the test file + spec excerpt (E2E table row 1) + entry hint: "MCP JSON-RPC boundary; full production stack required."

- [ ] **Step 4: If failing, the test was RED before the production stack was updated. After the next stack rebuild + reload it should PASS.**

This task does NOT include implementation — Tasks 9, 12, 14 + the eventual extension rebuild (Task 29) are the implementation. This task only adds the test.

- [ ] **Step 5: Litmus verification (one-time, document)**

After this task lands and the production stack ships the new extension (post Task 29): manually remove `"webNavigation"` from `extension/manifest.json` permissions, rebuild, reload, re-run this test. Expected: FAIL with permission denied or null frameId. Restore manifest. Record outcome in the commit body.

- [ ] **Step 6: Commit**

```bash
git add test/e2e/t55a-list-frames-cross-origin.test.ts
git commit -m "test(T55a): e2e — list_frames returns cross-origin frameId

Asserts a frame served from inner-port origin (different origin from
host) has frameId !== 0, parentFrameId === 0. Litmus verified: removing
webNavigation permission fails the test.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 21: e2e — t55a-eval-in-frame-cross-origin

**Files:**
- Create: `test/e2e/t55a-eval-in-frame-cross-origin.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';
import { McpTestClient } from '../helpers/mcp-client.js';

describe('T55a — safari_eval_in_frame runs script in cross-origin iframe', () => {
  let fixture: FixtureServer;
  let mcp: McpTestClient;
  let tabUrl: string;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    mcp = await McpTestClient.start();
    tabUrl = `http://127.0.0.1:${fixture.hostPort}/host.html?sp_t21=1`;
    await mcp.callTool('safari_new_tab', { url: tabUrl });
  }, 30_000);

  afterAll(async () => {
    try { await mcp.callTool('safari_close_tab', { tabUrl }); } catch {}
    await mcp.stop();
    await fixture.close();
  });

  it('returns the iframe document title (NOT the host page title)', async () => {
    const list = await mcp.callTool('safari_list_frames', { tabUrl });
    const frames = JSON.parse(list.content[0].text).frames;
    const inner = frames.find((f: any) => f.src && f.src.includes(`:${fixture.innerPort}`));
    expect(inner).toBeDefined();

    const result = await mcp.callTool('safari_eval_in_frame', {
      tabUrl,
      frameId: inner.frameId,
      script: 'return document.title',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.result).toBe('Inner Frame Document');     // inner.html title
    expect(parsed.result).not.toBe('Host Page');           // host.html title
  });
});
```

- [ ] **Step 2: Run + verify failure mode (or first-try pass)**

Run: `npx vitest run -c vitest.config.e2e.ts test/e2e/t55a-eval-in-frame-cross-origin.test.ts --reporter=verbose`

- [ ] **Step 3: Test-reviewer gate (fast-mode — 1 test)**

- [ ] **Step 4: Litmus verification (one-time, document)**

Manually remove `all_frames: true` from one content_scripts entry, rebuild, reload, re-run. Expected: FAIL — the iframe's content script doesn't load, no one writes sp_result, 10s timeout fires with FRAME_UNREACHABLE. Restore manifest.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/t55a-eval-in-frame-cross-origin.test.ts
git commit -m "test(T55a): e2e — eval_in_frame runs in cross-origin iframe

Returns iframe document.title (Inner Frame Document), NOT host title.
Litmus verified: removing all_frames:true fails with FRAME_UNREACHABLE.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 22: e2e — t55a-frame-not-found

**Files:**
- Create: `test/e2e/t55a-frame-not-found.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';
import { McpTestClient } from '../helpers/mcp-client.js';

describe('T55a — safari_eval_in_frame with bogus frameId returns FRAME_NOT_FOUND', () => {
  let fixture: FixtureServer;
  let mcp: McpTestClient;
  let tabUrl: string;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    mcp = await McpTestClient.start();
    tabUrl = `http://127.0.0.1:${fixture.hostPort}/host.html?sp_t22=1`;
    await mcp.callTool('safari_new_tab', { url: tabUrl });
  }, 30_000);

  afterAll(async () => {
    try { await mcp.callTool('safari_close_tab', { tabUrl }); } catch {}
    await mcp.stop();
    await fixture.close();
  });

  it('returns FRAME_NOT_FOUND immediately (NOT after 10s timeout)', async () => {
    const start = Date.now();
    let caught: any = null;
    try {
      await mcp.callTool('safari_eval_in_frame', {
        tabUrl,
        frameId: 9999,
        script: 'return 1',
      });
    } catch (e) {
      caught = e;
    }
    const elapsed = Date.now() - start;

    expect(caught).toBeDefined();
    expect(caught.message ?? caught.code).toMatch(/FRAME_NOT_FOUND/);
    // Validation must be fast (< 2s); a 10s elapsed time means we hit timeout instead
    expect(elapsed).toBeLessThan(2000);
  });
});
```

- [ ] **Step 2-3:** RED gate, test-reviewer-fast.

- [ ] **Step 4: Litmus (one-time)**

Manually skip the webNavigation validation in `background.handleExecute` (comment out the `if (cmd.frameId != null && cmd.frameId !== 0)` block), rebuild, reload. Expected: test fails — elapsed becomes ~10000 (timeout), error code is FRAME_UNREACHABLE. Restore.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/t55a-frame-not-found.test.ts
git commit -m "test(T55a): e2e — bogus frameId returns FRAME_NOT_FOUND fast

Validation at dispatch returns FRAME_NOT_FOUND in <2s, not after the
10s timeout. Litmus verified: removing webNavigation validation flips
the error to FRAME_UNREACHABLE after 10s.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 23: e2e — t55a-frame-targeted-respects-security-pipeline

**Files:**
- Create: `test/e2e/t55a-frame-targeted-respects-security-pipeline.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';
import { McpTestClient } from '../helpers/mcp-client.js';

describe('T55a — frame-targeted call against unowned tab respects security pipeline', () => {
  let fixture: FixtureServer;
  let mcp: McpTestClient;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    mcp = await McpTestClient.start();
    // No safari_new_tab call — we use a URL the agent never opened
  }, 30_000);

  afterAll(async () => {
    await mcp.stop();
    await fixture.close();
  });

  it('returns TAB_URL_NOT_RECOGNIZED, not FRAME_NOT_FOUND', async () => {
    const unownedUrl = `http://127.0.0.1:${fixture.hostPort}/host.html?sp_t23_unowned=1`;
    let caught: any = null;
    try {
      await mcp.callTool('safari_eval_in_frame', {
        tabUrl: unownedUrl,
        frameId: 5,
        script: 'return 1',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const errStr = (caught.message ?? '') + ' ' + (caught.code ?? '');
    expect(errStr).toMatch(/TAB_URL_NOT_RECOGNIZED|TabUrlNotRecognized/);
    expect(errStr).not.toMatch(/FRAME_NOT_FOUND/);
  });
});
```

- [ ] **Step 2-3:** RED gate, test-reviewer-fast.

- [ ] **Step 4: Litmus (one-time)**

Manually move the frame validation in `background.handleExecute` to BEFORE the existing TabOwnership check at server.ts step 7 (or equivalent in the bridge layer). Rebuild. Expected: test fails — error becomes FRAME_NOT_FOUND because frame validation fires first. Restore order.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/t55a-frame-targeted-respects-security-pipeline.test.ts
git commit -m "test(T55a): e2e — security pipeline runs before frame validation

Frame-targeted call against unowned tab returns TAB_URL_NOT_RECOGNIZED.
Litmus verified: moving frame validation ahead of TabOwnership flips
the error to FRAME_NOT_FOUND.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 24: e2e — t55a-extension-down-frame-call

**Files:**
- Create: `test/e2e/t55a-extension-down-frame-call.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';
import { McpTestClient } from '../helpers/mcp-client.js';

describe('T55a — frame-targeted call when extension is unreachable', () => {
  let fixture: FixtureServer;
  let mcp: McpTestClient;
  let tabUrl: string;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    // Set env that signals "extension unavailable" to the daemon health check.
    // The setup is done by spawning the MCP with SAFARI_PILOT_FORCE_NO_EXTENSION=1
    // (a test-only env var the engine selector reads — implementation note in Task 24).
    mcp = await McpTestClient.start({ env: { SAFARI_PILOT_FORCE_NO_EXTENSION: '1' } });
    tabUrl = `http://127.0.0.1:${fixture.hostPort}/host.html?sp_t24=1`;
    await mcp.callTool('safari_new_tab', { url: tabUrl });
  }, 30_000);

  afterAll(async () => {
    try { await mcp.callTool('safari_close_tab', { tabUrl }); } catch {}
    await mcp.stop();
    await fixture.close();
  });

  it('returns FRAME_NOT_SUPPORTED (or EngineUnavailable), not a SecurityError DOMException', async () => {
    let caught: any = null;
    try {
      await mcp.callTool('safari_eval_in_frame', {
        tabUrl,
        frameId: 5,
        script: 'return 1',
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    const errStr = (caught.message ?? '') + ' ' + (caught.code ?? '');
    expect(errStr).toMatch(/FRAME_NOT_SUPPORTED|EngineUnavailable/);
    // Negative: must NOT silently route to AppleScript and emit a DOMException
    expect(errStr).not.toMatch(/SecurityError|DOMException/);
  });
});
```

> Implementation note: this task may require adding `SAFARI_PILOT_FORCE_NO_EXTENSION` env support to the engine availability check in `src/engines/extension.ts isAvailable()`. If that infra doesn't exist yet, add it as a small dev-only branch:
> ```typescript
> async isAvailable(): Promise<boolean> {
>   if (process.env.SAFARI_PILOT_FORCE_NO_EXTENSION === '1') return false;
>   // ... existing check ...
> }
> ```
> Document this addition in the commit body.

- [ ] **Step 2-3:** RED gate, test-reviewer-fast.

- [ ] **Step 4: Litmus (one-time)**

Manually remove the `if (engine.name !== 'extension') throw FrameNotSupportedError` guard from `routeFrameAware`. Restart MCP without the env var. Expected: test fails — engine routes to AppleScript which calls `frame.contentWindow.Function` and gets a SecurityError DOMException for cross-origin.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/t55a-extension-down-frame-call.test.ts src/engines/extension.ts
git commit -m "test(T55a): e2e — extension-down frame call gates cleanly

Frame-targeted call with extension unavailable returns
FRAME_NOT_SUPPORTED (typed error), not a SecurityError DOMException
from a silent fallback to AppleScript. Adds SAFARI_PILOT_FORCE_NO_EXTENSION
env var to ExtensionEngine.isAvailable() for dev-only override.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 25: e2e — t55a-extract-text-cross-origin

**Files:**
- Create: `test/e2e/t55a-extract-text-cross-origin.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';
import { McpTestClient } from '../helpers/mcp-client.js';

describe('T55a — safari_extract_text in cross-origin iframe', () => {
  let fixture: FixtureServer;
  let mcp: McpTestClient;
  let tabUrl: string;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    mcp = await McpTestClient.start();
    tabUrl = `http://127.0.0.1:${fixture.hostPort}/host.html?sp_t25=1`;
    await mcp.callTool('safari_new_tab', { url: tabUrl });
  }, 30_000);

  afterAll(async () => {
    try { await mcp.callTool('safari_close_tab', { tabUrl }); } catch {}
    await mcp.stop();
    await fixture.close();
  });

  it('extracts text from the iframe body (NOT the host body)', async () => {
    const list = await mcp.callTool('safari_list_frames', { tabUrl });
    const inner = JSON.parse(list.content[0].text).frames.find((f: any) =>
      f.src && f.src.includes(`:${fixture.innerPort}`)
    );

    const result = await mcp.callTool('safari_extract_text', {
      tabUrl,
      frameId: inner.frameId,
    });
    const text = JSON.parse(result.content[0].text).text ?? JSON.parse(result.content[0].text);
    const blob = typeof text === 'string' ? text : JSON.stringify(text);

    expect(blob).toMatch(/Inner frame body/);
    expect(blob).toMatch(/cross-origin iframe/);
    expect(blob).not.toMatch(/Host page \(port/);  // host h1 must not appear
  });
});
```

- [ ] **Step 2-3:** RED gate, test-reviewer-fast.

- [ ] **Step 4: Litmus (one-time)**

In `src/tools/extraction.ts handleExtractText`, replace `routeFrameAware(...)` with `engine.executeJsInTab(...)` directly (bypassing the helper). Rebuild. Expected: test fails — top frame answers, returned text contains host h1 instead of inner h1.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/t55a-extract-text-cross-origin.test.ts
git commit -m "test(T55a): e2e — extract_text routes through frameId

Returned text matches inner.html body, not host.html. Proves
routeFrameAware adoption in extraction.ts. Litmus verified.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 26: e2e — t55a-query-shadow-cross-origin

**Files:**
- Create: `test/e2e/t55a-query-shadow-cross-origin.test.ts`

- [ ] **Step 1: Update host fixture to embed shadow.html**

Add a second iframe to `test/fixtures/cross-frame/host.html`:

```html
<iframe id="shadow-frame" src="http://127.0.0.1:19477/shadow.html" width="600" height="400"></iframe>
```

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';
import { McpTestClient } from '../helpers/mcp-client.js';

describe('T55a — safari_query_shadow in cross-origin iframe', () => {
  let fixture: FixtureServer;
  let mcp: McpTestClient;
  let tabUrl: string;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    mcp = await McpTestClient.start();
    tabUrl = `http://127.0.0.1:${fixture.hostPort}/host.html?sp_t26=1`;
    await mcp.callTool('safari_new_tab', { url: tabUrl });
  }, 30_000);

  afterAll(async () => {
    try { await mcp.callTool('safari_close_tab', { tabUrl }); } catch {}
    await mcp.stop();
    await fixture.close();
  });

  it('finds shadow content inside cross-origin iframe', async () => {
    const list = await mcp.callTool('safari_list_frames', { tabUrl });
    const shadowFrame = JSON.parse(list.content[0].text).frames.find((f: any) =>
      f.src && f.src.endsWith('/shadow.html')
    );
    expect(shadowFrame, 'shadow.html iframe must be discoverable').toBeDefined();

    const result = await mcp.callTool('safari_query_shadow', {
      tabUrl,
      frameId: shadowFrame.frameId,
      hostSelector: '#host',
      innerSelector: '#shadow-marker',
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.found ?? parsed.matched ?? false).toBe(true);
  });
});
```

> The exact response shape of `safari_query_shadow` may differ — read `src/tools/shadow.ts` first and adjust the assertion field names.

- [ ] **Step 3-4:** RED gate, test-reviewer-fast.

- [ ] **Step 5: Litmus (one-time)**

Bypass `routeFrameAware` in `shadow.ts handleQueryShadow`. Rebuild. Expected: top frame is searched, host has no `#host` element with shadow root, returns `found: false`.

- [ ] **Step 6: Commit**

```bash
git add test/e2e/t55a-query-shadow-cross-origin.test.ts test/fixtures/cross-frame/host.html
git commit -m "test(T55a): e2e — query_shadow routes through frameId

Shadow DOM lookup happens in iframe's document tree. Litmus verified.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 27: e2e — t55a-concurrent-frame-commands (DEFENDS D6)

**Files:**
- Create: `test/e2e/t55a-concurrent-frame-commands.test.ts`
- Modify: `test/fixtures/cross-frame/host.html` (use inner-a.html + inner-b.html for two distinct frames)

- [ ] **Step 1: Update host.html to embed two distinct iframes**

```html
<iframe id="inner-a" src="http://127.0.0.1:19477/inner-a.html" width="400" height="300"></iframe>
<iframe id="inner-b" src="http://127.0.0.1:19477/inner-b.html" width="400" height="300"></iframe>
```

`inner-a.html`:
```html
<!DOCTYPE html><html><head><title>Inner A</title></head><body><h1>FRAME_A_MARKER</h1></body></html>
```

`inner-b.html`:
```html
<!DOCTYPE html><html><head><title>Inner B</title></head><body><h1>FRAME_B_MARKER</h1></body></html>
```

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';
import { McpTestClient } from '../helpers/mcp-client.js';

describe('T55a — concurrent commands to two frames defend commandId-keyed storage (D6)', () => {
  let fixture: FixtureServer;
  let mcp: McpTestClient;
  let tabUrl: string;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    mcp = await McpTestClient.start();
    tabUrl = `http://127.0.0.1:${fixture.hostPort}/host.html?sp_t27=1`;
    await mcp.callTool('safari_new_tab', { url: tabUrl });
  }, 30_000);

  afterAll(async () => {
    try { await mcp.callTool('safari_close_tab', { tabUrl }); } catch {}
    await mcp.stop();
    await fixture.close();
  });

  it('two simultaneous safari_eval_in_frame calls return correct, non-clobbered results', async () => {
    const list = await mcp.callTool('safari_list_frames', { tabUrl });
    const frames = JSON.parse(list.content[0].text).frames;
    const a = frames.find((f: any) => f.src?.endsWith('/inner-a.html'));
    const b = frames.find((f: any) => f.src?.endsWith('/inner-b.html'));
    expect(a, 'inner-a.html must be discoverable').toBeDefined();
    expect(b, 'inner-b.html must be discoverable').toBeDefined();

    // Issue both calls in parallel — neither must clobber the other's sp_result
    const [resA, resB] = await Promise.all([
      mcp.callTool('safari_eval_in_frame', { tabUrl, frameId: a.frameId, script: "return document.querySelector('h1').textContent" }),
      mcp.callTool('safari_eval_in_frame', { tabUrl, frameId: b.frameId, script: "return document.querySelector('h1').textContent" }),
    ]);

    const valueA = JSON.parse(resA.content[0].text).result;
    const valueB = JSON.parse(resB.content[0].text).result;

    expect(valueA).toBe('FRAME_A_MARKER');
    expect(valueB).toBe('FRAME_B_MARKER');
    // Neither command's result was clobbered by the other:
    expect(valueA).not.toBe('FRAME_B_MARKER');
    expect(valueB).not.toBe('FRAME_A_MARKER');
  });
});
```

- [ ] **Step 3-4:** RED gate, test-reviewer-fast.

- [ ] **Step 5: Litmus (one-time, MOST IMPORTANT)**

In `extension/background.js`, manually revert the writer/listener/cleanup changes from Tasks 11+13: change `'sp_cmd_' + commandId` back to literal `'sp_cmd'` and similarly for `sp_result`. Revert the idle-sweep prefix-scan to literal-key reads. Rebuild + reload. Expected: test FAILS — fastest frame's sp_result write clobbers the slower frame's; one of the assertions returns the wrong marker. Restore.

This litmus is the entire justification for D6 (commandId-keyed storage). Without this verification, the design choice is undefended.

- [ ] **Step 6: Commit**

```bash
git add test/e2e/t55a-concurrent-frame-commands.test.ts test/fixtures/cross-frame/host.html test/fixtures/cross-frame/inner-a.html test/fixtures/cross-frame/inner-b.html
git commit -m "test(T55a): e2e — concurrent frame commands defend D6

Promise.all of two safari_eval_in_frame calls to distinct frames
returns correct, non-clobbered results. This is the litmus for
commandId-keyed storage (D6 in spec). Reverted to single-slot
sp_cmd/sp_result during litmus verification: test failed — fastest
frame won, slower frame's result was overwritten.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 28: e2e — t55a-url-change-relay-iframe-filter (REGRESSION LITMUS)

**Files:**
- Create: `test/e2e/t55a-url-change-relay-iframe-filter.test.ts`
- Modify: `test/fixtures/cross-frame/host.html` (add SPA pushState scripts)
- Modify: `test/fixtures/cross-frame/inner.html` (add SPA pushState script)

- [ ] **Step 1: Add pushState triggers to fixtures**

`host.html` add:
```html
<script>
  setTimeout(() => history.pushState({}, '', location.pathname + '?host_pushed=1'), 200);
</script>
```

`inner.html` add:
```html
<script>
  setTimeout(() => history.pushState({}, '', location.pathname + '?iframe_pushed=1'), 400);
</script>
```

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';
import { McpTestClient } from '../helpers/mcp-client.js';

describe('T55a — URL-change relay filter survives all_frames:true (regression litmus)', () => {
  let fixture: FixtureServer;
  let mcp: McpTestClient;
  let tabUrl: string;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    mcp = await McpTestClient.start();
    tabUrl = `http://127.0.0.1:${fixture.hostPort}/host.html?sp_t28=1`;
    await mcp.callTool('safari_new_tab', { url: tabUrl });
  }, 30_000);

  afterAll(async () => {
    try { await mcp.callTool('safari_close_tab', { tabUrl }); } catch {}
    await mcp.stop();
    await fixture.close();
  });

  it('extension internal cache reflects host top-frame URL only, not iframe URL', async () => {
    // Wait for both pushState calls to have fired (host: 200ms, iframe: 400ms)
    await new Promise((r) => setTimeout(r, 1000));

    // Use safari_extension_debug_dump (existing tool) to read tabCacheMap
    const dump = await mcp.callTool('safari_extension_debug_dump', {});
    const parsed = JSON.parse(dump.content[0].text);

    // Find the entry for our tab. Shape may be { tabCacheMap: { <tabId>: { url, ... } } }
    const tabEntries = Object.values(parsed.tabCacheMap ?? {}) as any[];
    const ours = tabEntries.find((e) => e.url && e.url.startsWith(`http://127.0.0.1:${fixture.hostPort}/host.html`));
    expect(ours, 'tab must be in tabCacheMap').toBeDefined();

    // tabCacheMap MUST reflect host pushState, NOT iframe pushState
    expect(ours.url).toMatch(/host_pushed=1/);
    expect(ours.url).not.toMatch(/iframe_pushed=1/);
  });
});
```

> If `safari_extension_debug_dump` doesn't expose tabCacheMap, read its source first and adapt the field name. If no tool exposes it, this test may need a tiny addition to `safari_extension_debug_dump`'s output — flag in commit body if so.

- [ ] **Step 3-4:** RED gate, test-reviewer-fast.

- [ ] **Step 5: Litmus (one-time, MOST IMPORTANT)**

In `extension/background.js:624`, manually delete the `if (sender?.frameId !== 0) return;` guard. Rebuild + reload. Expected: test fails — iframe's pushState event reaches background's URL-change handler, tabCacheMap gets updated to the iframe URL. Restore.

This litmus defends an EXISTING invariant against the NEW manifest change. Without `all_frames: true` no iframe ever fires URL-change events. With it, every iframe does — and the filter must hold.

- [ ] **Step 6: Commit**

```bash
git add test/e2e/t55a-url-change-relay-iframe-filter.test.ts test/fixtures/cross-frame/host.html test/fixtures/cross-frame/inner.html
git commit -m "test(T55a): e2e — URL-change relay filter regression litmus

With all_frames:true, every iframe fires SAFARI_PILOT_URL_CHANGE on
SPA pushState. The sender.frameId !== 0 filter at background.js:624
must hold so tabCacheMap stays at top-frame URL. Litmus verified:
removing the filter pollutes tabCacheMap with iframe URL.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 29: Verify full test suite + extension build

**Files:**
- Trigger: `bash scripts/build-extension.sh`
- Modify: `package.json` (version bump)

- [ ] **Step 1: Run all tests against full production stack**

Run unit tests:
```bash
npm run lint && npm run build && npm test
```
Expected: all unit tests pass.

Run daemon Swift tests:
```bash
cd daemon && swift test
```
Expected: all Swift tests pass.

Start full production stack (per `test/e2e/setup-production.ts` requirements):
- Verify daemon running on 19474: `nc -zv 127.0.0.1 19474`
- Verify Safari running with JS-from-Apple-Events enabled
- Verify extension reachable: `curl http://127.0.0.1:19475/status`

If extension is NOT yet on the new build (Steps 2-3 needed first), e2e tests for cross-origin frames will fail. Run the e2e suite:
```bash
npx vitest run -c vitest.config.e2e.ts test/e2e/t55a-*.test.ts
```

If they fail because extension is on old version, proceed to Step 2.

- [ ] **Step 2: Bump package.json version**

Per memory `feedback-extension-version-both-fields`: bump the patch version. From current `0.1.17`:

```bash
npm version patch --no-git-tag-version
```
Expected: package.json now `0.1.18`. Verify: `cat package.json | grep version`.

- [ ] **Step 3: Rebuild + sign + notarize the extension**

Per CLAUDE.md hard rules: NEVER manual codesign; always use `scripts/build-extension.sh`. Per memory `feedback-never-open-app-without-version-bump`: only do this AFTER the version bump (Step 2). Per memory `feedback-no-system-manipulation`: NEVER run pluginkit/lsregister/pkill.

```bash
bash scripts/build-extension.sh
```
Expected: succeeds with `bin/Safari Pilot.app` rebuilt + signed + notarized + stapled. Verify entitlements per CLAUDE.md hard rule #7:

```bash
codesign -d --entitlements - "bin/Safari Pilot.app" 2>&1 | grep -E "app-sandbox|network.client"
codesign -d --entitlements - "bin/Safari Pilot.app/Contents/PlugIns/Safari Pilot Extension.appex" 2>&1 | grep -E "app-sandbox|network.client"
```
Expected: both show `app-sandbox` and `com.apple.security.network.client`.

- [ ] **Step 4: Open the .app to register with Safari**

```bash
open "bin/Safari Pilot.app"
```

User action: in Safari → Settings → Extensions, ensure Safari Pilot is enabled. If Safari blocks with "interfered with clicking" warning, follow memory `reference_extension_enablement_workaround` (Develop menu → Allow Unsigned Extensions toggle → enable → quit Safari → reopen → optionally toggle off).

- [ ] **Step 5: Re-run e2e against the new build**

Run: `npx vitest run -c vitest.config.e2e.ts test/e2e/t55a-*.test.ts --reporter=verbose`
Expected: all 9 t55a-* tests pass.

If any fail, do NOT lower thresholds or skip tests (CLAUDE.md hard rule). Diagnose root cause and add a follow-up task or fix in a tightly-scoped commit.

- [ ] **Step 6: Run the broader e2e suite to verify no regressions**

```bash
npx vitest run -c vitest.config.e2e.ts test/e2e/
```
Expected: all e2e tests pass (existing + 9 new T55a).

- [ ] **Step 7: Commit version bump + verify build**

```bash
git add package.json
git commit -m "chore(T55a): bump version to 0.1.18

Per memory feedback-extension-version-both-fields: Safari caches
extension by CFBundleShortVersionString. Version bump required so
Safari sees the rebuilt extension as a new version. Build script
sed-patches Info.plist from package.json.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 30: Documentation — ARCHITECTURE.md + TRACES.md + TRACKER.md

**Files:**
- Modify: `ARCHITECTURE.md`
- Modify: `TRACES.md`
- Modify: `docs/TRACKER.md`

- [ ] **Step 1: Update ARCHITECTURE.md**

Add a "Frame-Aware Storage Bus" section under the existing Extension IPC documentation. Cover: targeted-only dispatch, commandId-keyed storage keys, lazy `sp_getFrameId` handshake, document-mutation guard via `cmd.frameUrl`, capability gating via `routeFrameAware`. Reference the spec at `docs/upp/specs/2026-05-02-t55a-frame-aware-storage-bus-design.md`.

Per CLAUDE.md hard rule: any commit changing component behavior MUST update ARCHITECTURE.md in the same commit. This task closes that obligation for the T55a body of work.

- [ ] **Step 2: Update TRACES.md**

Add an iteration entry. The `# Compaction Process (Every 3 Iterations)` rule may trigger if this lands as a milestone; check the current iteration number first by reading `TRACES.md`.

```markdown
### Iteration N - 2026-05-02
**What:** T55a frame-aware storage bus shipped — cross-origin iframe access via `all_frames: true` + commandId-keyed storage + targeted-only dispatch
**Changes:** `extension/manifest.json` (webNavigation + all_frames:true), `extension/content-isolated.js` (lazy handshake + commandId keys), `extension/background.js` (webNavigation validation + commandId-keyed writer/listener/cleanup + idle-sweep prefix-scan), `extension/lib/{route-command,handshake-machine,storage-keys}.js` (NEW pure helpers), `src/tools/_frame-routing-helper.ts` (NEW shared helper), 10 frame-aware tool handlers (`frames`, `interaction`, `extraction`, `shadow`), `src/engine-selector.ts` (cap flip), `src/errors.ts` (4 new codes), `src/engines/extension.ts` (executeJsInFrame), `daemon/Sources/.../ExtensionBridge.swift` (frameId/frameUrl Codable), 7 unit tests + 9 e2e tests + 1 daemon Swift test
**Context:** Maximal v1 scope (rejected EL eval-only trim) means 11 tools touched; shared `routeFrameAware` helper + parameterized routing test prevent drift. CommandId-keyed storage defended by `t55a-concurrent-frame-commands` e2e test (D6). Document-mutation race guarded by `cmd.frameUrl === location.href` check in content-isolated.js (FRAME_NAVIGATED on mismatch). EL adversarial audit caught 4 blockers + 3 majors before plan-write; all addressed in spec at commit `e9cccc4`.
---
```

- [ ] **Step 3: Update docs/TRACKER.md**

Move T55a from "Open" to "Resolved this sprint" with commit references. Update the open-count.

- [ ] **Step 4: Commit**

```bash
git add ARCHITECTURE.md TRACES.md docs/TRACKER.md
git commit -m "docs(T55a): ARCHITECTURE + TRACES + TRACKER updates

Frame-aware storage bus section added to ARCHITECTURE. TRACES
iteration entry. T55a moved from Open to Resolved.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 31: Merge to main

**Files:**
- Branch: `fix/T55a-frame-aware-storage-bus` → `main`

- [ ] **Step 1: Final review with `git diff main..HEAD`**

```bash
git fetch origin main
git diff origin/main..HEAD --stat
```

Verify: all touched files match the file structure section of this plan. Anything unexpected? Investigate before merging.

- [ ] **Step 2: Re-run full test suite one more time**

```bash
npm run lint && npm run build && npm test
cd daemon && swift test && cd ..
npx vitest run -c vitest.config.e2e.ts test/e2e/
```
Expected: all pass.

- [ ] **Step 3: Merge with merge commit (no fast-forward)**

```bash
git checkout main
git merge --no-ff fix/T55a-frame-aware-storage-bus -m "merge: T55a frame-aware storage bus

11 tools (1 returns frameId, 10 accept frameId param). Manifest gains
webNavigation + all_frames:true. Storage bus migrates to commandId-keyed
keys. Lazy sp_getFrameId handshake. cmd.frameUrl mutation guard.

7 unit + 9 e2e + 1 daemon Swift test, all passing.
ENGINE_CAPS.extension.framesCrossOrigin: true (parity test green).

Spec: docs/upp/specs/2026-05-02-t55a-frame-aware-storage-bus-design.md (e9cccc4)
Plan: docs/upp/plans/2026-05-02-t55a-frame-aware-storage-bus-plan.md

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
git branch -d fix/T55a-frame-aware-storage-bus
git push origin main
```

- [ ] **Step 4: Verify Notion ROADMAP + delete CHECKPOINT.md**

Per project protocol: update Notion roadmap entry to "Verifying" status. Delete `CHECKPOINT.md` (existed from prior session, no longer relevant — the work it described is now shipped).

```bash
rm CHECKPOINT.md
git add -u && git commit -m "chore: remove CHECKPOINT.md (T55a sprint complete)" && git push
```

---

## Verification checklist (Definition of Done)

- [ ] `npm run lint && npm run build` clean.
- [ ] All 7 new unit tests + existing parity test pass.
- [ ] All 9 e2e tests pass against full production stack.
- [ ] Daemon Swift tests pass: 1 new test in green.
- [ ] Extension rebuilt + re-signed + re-notarized via `bash scripts/build-extension.sh`.
- [ ] `package.json` version bumped to next patch.
- [ ] `bin/Safari Pilot.app` opened, extension re-enabled in Safari, smoke-tested.
- [ ] `ARCHITECTURE.md` updated.
- [ ] `TRACES.md` iteration entry written.
- [ ] `docs/TRACKER.md` T55a moved Open → Resolved.
- [ ] Branch merged to main with `--no-ff`, deleted, pushed.

---

## Plan complete and saved to `docs/upp/plans/2026-05-02-t55a-frame-aware-storage-bus-plan.md`.

**Execute with:** the executing-plans skill

The skill supports two modes:
- **Subagent mode** (recommended) — fresh subagent per task with three-stage review (spec → quality → design — design stage is no-op here since no DESIGN.md)
- **Inline mode** — execute in this session with checkpoints

Which mode would you like? (Default: subagent mode)
