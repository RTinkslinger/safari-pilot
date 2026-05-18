# v0.1.36 Finishing Sprint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the executing-plans skill to implement this plan task-by-task. Supports two modes: subagent-driven (recommended, fresh subagent per task with three-stage review) or inline execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land reviewer findings F3.1 (preserve `EngineResult.error` structure through tool handlers — the HEADLINE gap that makes Track A's error envelope operationally inert) + F1.2 (session-scoped tab cache to prevent cross-session pollution) on top of Track A, then re-baseline against the canonical patched-2026 WebVoyager dataset (Max-billed) and ship v0.1.36.

**Architecture:**
- **F3.1 (envelope preservation)**: Add a concrete `EngineExecutionError` subclass + a `wrapEngineError(engineErr, fallback)` helper in `src/errors.ts` that lifts the `EngineResult.error` payload (`code/message/retryable/hints`) into a thrown `SafariPilotError` instance. Replace the ~70 sites of `throw new Error(result.error?.message ?? '<fallback>')` across 12 tool files with `throw wrapEngineError(result.error, '<fallback>')`. Extend `executeToolWithSecurity`'s catch block in `src/server.ts` to convert any caught `SafariPilotError` into a structured `isError: true` MCP response (mirrors the existing T30 `HumanApprovalRequiredError` soft-return pattern at `src/server.ts:737-759`) so the agent receives `code/retryable/hints` instead of opaque message text.
- **F1.2 (session-scoped tab matcher)**: The MCP server already creates a per-session Safari window and surfaces `_sessionWindowId` on `safari_new_tab` (`src/server.ts:960`). Extend that thread-through: include `sessionWindowId` in every storage-bus command the daemon dispatches to the extension, store the value on the extension's `tabCacheMap` entries at create-time, and filter `findTargetTab`'s candidate pool by `sessionWindowId` before running the 4-tier matcher. Cross-session tabs are excluded → no pollution.
- **Re-baseline + ship**: Build `0.1.36-dev.10` (signed + notarized via `scripts/build-extension.sh`), install, run full single-run patched bench at `--concurrency 4` with `WV_AUTH=max` (~28h wall, $0 API), trace-mine the streams, validate against the spec's acceptance criteria. If all green: bump to `0.1.36`, run `scripts/pre-tag-check.sh`, tag, merge worktree branch → `main`, push.

**Tech Stack:** TypeScript (Vitest 1.6 unit tests + e2e via `McpTestClient` over real MCP stdio), Safari Web Extension MV3 (`extension/background.js`), Swift daemon (`daemon/Sources/SafariPilotdCore/`), MCP SDK 1.x (`@modelcontextprotocol/sdk`).

---

## Pre-flight context

- **Worktree (working directory):** `/Users/Aakash/Claude Projects/Skills Factory/safari-pilot-v0136-track-a/`
- **Branch:** `feat/v0136-track-a-infra`
- **Current HEAD:** `3863737 fix(extension): Tier 1 ambiguity guard for spMatchTabUrl (reviewer F1.1)`
- **Current version:** `0.1.36-dev.9` (signed + notarized, installed in Safari at session start)
- **Active spec:** `docs/upp/specs/2026-05-15-safari-pilot-v0136-track-a-infrastructure.md`
- **Reviewer report:** consumed inline in 2026-05-16 session; summarized in CHECKPOINT.md
- **Acceptance criteria (from spec):**
  - Total error count ≤ 700 (was 3,209)
  - Tab-cache-miss errors ≤ 80 (was 1,317)
  - Daemon execute timeouts ≤ 100 (was 963)
  - Storage bus timeouts ≤ 50 (was 499)
  - No new error class > 50 occurrences (regression guard)
  - Median wall/task ≤ 150s (was 270s)
  - Median cost/task ≤ $0.45 (now $0 with Max — cost criterion is moot but turn count remains)
  - Mean turns/task ≤ 18 (was 23)
  - All e2e tests still pass

**Out of scope for this plan:** v0.1.37 Track B (loop detector, schema-swap cap, narrow tool surface). Any reviewer finding beyond F3.1+F1.2 stays deferred to v0.1.37.

---

## File Structure

### F3.1 — Envelope preservation

| File | Action | Responsibility |
|---|---|---|
| `src/errors.ts` | Modify | Add `EngineExecutionError` class + `wrapEngineError()` helper (after `formatToolError`) |
| `src/server.ts:1240-1281` (the catch block in `executeToolWithSecurity`) | Modify | Convert thrown `SafariPilotError` → structured `isError: true` MCP response |
| `src/tools/interaction.ts` | Modify | Replace 7 sites |
| `src/tools/extraction.ts` | Modify | Replace 13 sites |
| `src/tools/storage.ts` | Modify | Replace 13 sites |
| `src/tools/network.ts` | Modify | Replace 9 sites |
| `src/tools/structured-extraction.ts` | Modify | Replace 9 sites |
| `src/tools/permissions.ts` | Modify | Replace 5 sites |
| `src/tools/frames.ts` | Modify | Replace 4 sites |
| `src/tools/shadow.ts` | Modify | Replace 2 sites |
| `src/tools/selector-pack.ts` | Modify | Replace 2 sites |
| `src/tools/auth.ts` | Modify | Replace 2 sites |
| `src/tools/pdf.ts` | Modify | Replace 2 sites (variant pattern — `throw` is inside an `if`, no `if (!result.ok)` prefix) |
| `src/tools/file-upload.ts` | Modify | Replace 1 site |
| `test/unit/errors/wrap-engine-error.test.ts` | Create | TDD coverage for the helper |
| `test/unit/server/error-envelope-response.test.ts` | Create | TDD coverage for the catch-block conversion (uses a stub engine) |
| `test/e2e/error-envelope-propagation.test.ts` | Create | Real DAEMON_TIMEOUT → structured isError MCP response |

### F1.2 — Session-scoped tab cache

| File | Action | Responsibility |
|---|---|---|
| `src/engines/extension.ts` | Modify | Include `sessionWindowId` in the JSON command payload passed to the daemon |
| `daemon/Sources/SafariPilotdCore/Models.swift` | Modify | Add `sessionWindowId: Int?` to `ExtensionCommand` decode/encode |
| `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` | Modify | Forward `sessionWindowId` in the command body delivered via the HTTP poll endpoint |
| `extension/background.js` | Modify | Persist `sessionWindowId` on `tabCacheMap` entries at create (`tabs.onCreated` listener); filter `findTargetTab` candidates by it |
| `test/unit/extension/find-target-tab.test.ts` | Create | TDD for the filter logic (mock `browser.tabs.query`) |
| `test/e2e/cross-session-isolation.test.ts` | Create | Real two-session test: session A's `safari_new_tab` doesn't shadow session B's matcher |

### Release

| File | Action | Responsibility |
|---|---|---|
| `package.json` | Modify | Bump to `0.1.36` |
| `extension/manifest.json` | Modify | Bump to `0.1.36` (per `feedback-extension-version-both-fields` rule) |
| `CHANGELOG.md` | Modify | Add 0.1.36 entry |
| `bin/Safari Pilot.app` | Build | dev.10 → 0.1.36 final (signed + notarized) |
| `bin/SafariPilotd` | Build | dev.10 → 0.1.36 final (signed + notarized) |

---

## Task Ordering

Backend correctness refactor — no frontend ordering constraint. The shape is:

1. F3.1 helper + class (TDD)
2. F3.1 catch-block conversion in server.ts (TDD)
3. F3.1 mechanical site replacements (12 small tasks, one per tool file)
4. F3.1 end-to-end propagation test
5. F1.2 daemon plumbing (sessionWindowId in command)
6. F1.2 extension filter (TDD-unit)
7. F1.2 end-to-end cross-session isolation test
8. Build + install dev.10
9. Run full patched WebVoyager bench (background, ~28h)
10. Trace-mine + validate acceptance criteria
11. Bump versions, pre-tag-check, tag, push

---

## Task 1: Add EngineExecutionError + wrapEngineError helper

**Files:**
- Modify: `src/errors.ts` (insert new class + helper after the existing `formatToolError` export at line 816)
- Create: `test/unit/errors/wrap-engine-error.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/errors/wrap-engine-error.test.ts
import { describe, expect, it } from 'vitest';
import { wrapEngineError, EngineExecutionError, InternalError } from '../../../src/errors.js';
import type { EngineError } from '../../../src/types.js';

describe('wrapEngineError', () => {
  it('lifts code/message/retryable/hints from EngineError into EngineExecutionError', () => {
    const engineErr: EngineError = {
      code: 'DAEMON_TIMEOUT',
      message: "Daemon command 'execute' timed out after 30000ms",
      retryable: false,
      hints: ['Switch tools', 'Call safari_wait_for first'],
    };

    const wrapped = wrapEngineError(engineErr, 'fallback should not show');

    expect(wrapped).toBeInstanceOf(EngineExecutionError);
    expect(wrapped.code).toBe('DAEMON_TIMEOUT');
    expect(wrapped.message).toBe("Daemon command 'execute' timed out after 30000ms");
    expect(wrapped.retryable).toBe(false);
    expect(wrapped.hints).toEqual(['Switch tools', 'Call safari_wait_for first']);
  });

  it('returns InternalError with the fallback message when engineErr is undefined', () => {
    const wrapped = wrapEngineError(undefined, 'Shadow query failed');
    expect(wrapped).toBeInstanceOf(InternalError);
    expect(wrapped.message).toBe('Shadow query failed');
  });

  it('defaults retryable to false and hints to [] when EngineError omits them', () => {
    const wrapped = wrapEngineError(
      { code: 'CSP_BLOCKED', message: 'CSP rejected the script' } as EngineError,
      'fallback',
    );
    expect(wrapped.code).toBe('CSP_BLOCKED');
    expect(wrapped.retryable).toBe(false);
    expect(wrapped.hints).toEqual([]);
  });

  it('preserves an unknown code string verbatim (no enum coercion)', () => {
    const wrapped = wrapEngineError(
      { code: 'SOME_FUTURE_CODE', message: 'm', retryable: true, hints: [] },
      'fb',
    );
    expect(wrapped.code).toBe('SOME_FUTURE_CODE');
  });
});
```

- [ ] **Step 2: Run the test — verify it fails**

Run: `npx vitest run test/unit/errors/wrap-engine-error.test.ts`
Expected: `FAIL` with "wrapEngineError is not a function" and "EngineExecutionError is not exported".

- [ ] **Step 3: Implement the helper + class**

Append to `src/errors.ts` (after the `formatToolError` function at line 816):

```typescript
// ─── EngineExecutionError + wrapEngineError ──────────────────────────────────
//
// Reviewer finding F3.1 (v0.1.36): tool handlers used to do
//   if (!result.ok) throw new Error(result.error?.message ?? 'X failed');
// which collapses the structured engine envelope to plain message text — the
// `code`, `retryable`, and `hints` from EngineResult.error were dropped before
// reaching the MCP response. The agent saw opaque strings instead of
// recoverable structured errors, making the DAEMON_TIMEOUT / CONTENT_SCRIPT_NOT_READY
// envelope operationally inert in v0.1.36 Track A.
//
// EngineExecutionError preserves the full envelope through to the catch block
// in src/server.ts:executeToolWithSecurity, which converts it to a structured
// isError: true MCP response (mirroring the T30 HumanApproval soft-return).

import type { EngineError as _EngineError } from './types.js';

export class EngineExecutionError extends SafariPilotError {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly hints: string[];

  constructor(engineErr: _EngineError) {
    super(engineErr.message);
    // Engine codes are strings from the daemon/extension layer; if the value
    // matches a known ErrorCode it round-trips intact, otherwise we keep the
    // raw string. The MCP response carries the string regardless — the
    // ErrorCode union is documentation, not enforcement.
    this.code = engineErr.code as ErrorCode;
    this.retryable = engineErr.retryable ?? false;
    this.hints = Array.isArray(engineErr.hints) ? [...engineErr.hints] : [];
  }
}

export function wrapEngineError(
  engineErr: _EngineError | undefined,
  fallbackMessage: string,
): SafariPilotError {
  if (!engineErr) return new InternalError(fallbackMessage);
  return new EngineExecutionError(engineErr);
}
```

- [ ] **Step 4: Run the test — verify it passes**

Run: `npx vitest run test/unit/errors/wrap-engine-error.test.ts`
Expected: 4/4 PASS.

- [ ] **Step 5: Verify no regression in the existing unit suite**

Run: `npm run test:unit`
Expected: all 96 (now 100) unit tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/errors.ts test/unit/errors/wrap-engine-error.test.ts
git commit -m "feat(errors): add wrapEngineError + EngineExecutionError (F3.1)

Lifts EngineResult.error.code/retryable/hints into a thrown SafariPilotError
subclass so the structured envelope survives the rethrow chain to MCP.
Replaces ~70 sites of throw new Error(result.error?.message ?? ...) in
follow-up tasks."
```

---

## Task 2: Convert thrown SafariPilotError to structured MCP isError in executeToolWithSecurity

**Files:**
- Modify: `src/server.ts` (the outer catch block at lines 1240-1281 inside `executeToolWithSecurity`)
- Create: `test/unit/server/error-envelope-response.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/server/error-envelope-response.test.ts
import { describe, expect, it, beforeEach } from 'vitest';
import { createServer } from '../../../src/server.js';
import { EngineExecutionError } from '../../../src/errors.js';
import type { EngineError } from '../../../src/types.js';

// Helper: builds a server with a stub engine that throws on a specific tool call.
async function buildServerWithThrowingEngine(toolName: string, engineErr: EngineError) {
  const server = await createServer({
    overrides: {
      stubEngineThrow: { toolName, engineErr },
    },
  });
  return server;
}

describe('executeToolWithSecurity catch block: SafariPilotError → isError MCP response', () => {
  it('returns structured {isError: true, content[0].text = JSON envelope} on EngineExecutionError', async () => {
    const server = await buildServerWithThrowingEngine('safari_get_text', {
      code: 'DAEMON_TIMEOUT',
      message: "Daemon command 'execute' timed out after 30000ms",
      retryable: false,
      hints: ['Switch tools', 'Call safari_wait_for first'],
    });

    const res = await server.executeToolWithSecurity('safari_get_text', {
      tabUrl: 'https://example.com/',
      selector: 'h1',
    });

    expect(res.isError).toBe(true);
    expect(res.content).toHaveLength(1);
    const payload = JSON.parse((res.content[0] as { type: 'text'; text: string }).text);
    expect(payload.error).toBe('DAEMON_TIMEOUT');
    expect(payload.message).toBe("Daemon command 'execute' timed out after 30000ms");
    expect(payload.retryable).toBe(false);
    expect(payload.hints).toEqual(['Switch tools', 'Call safari_wait_for first']);
    expect(res.metadata?.engine).toBeDefined();
    expect(res.metadata?.latencyMs).toBeGreaterThanOrEqual(0);

    await server.shutdown();
  });

  it('still rethrows non-SafariPilotError unchanged (e.g. raw TypeError)', async () => {
    const server = await buildServerWithThrowingEngine('safari_get_text', null as unknown as EngineError);
    // The stub will throw `new TypeError('boom')` when engineErr is null.
    await expect(server.executeToolWithSecurity('safari_get_text', {
      tabUrl: 'https://example.com/',
      selector: 'h1',
    })).rejects.toThrow(TypeError);
    await server.shutdown();
  });
});
```

- [ ] **Step 2: Add the stub-engine override hook**

(The test depends on `createServer({ overrides: { stubEngineThrow: ... } })`. If the existing `createServer` factory doesn't accept overrides, add this hook now — it's the minimal seam needed for the test. Skip if already present.)

Modify `src/server.ts` — extend the `createServer` factory signature to accept an `overrides` field carrying a stub-engine wiring used only by tests. Locate the `createServer` definition (search for `export async function createServer`) and add:

```typescript
export interface CreateServerOptions {
  overrides?: {
    stubEngineThrow?: { toolName: string; engineErr: EngineError | null };
  };
}
```

Then route the override to the engine selector so that when `name === toolName` it throws `wrapEngineError(engineErr, '<toolname> failed')` if engineErr is set, or `new TypeError('boom')` if `engineErr === null`. (Implementation detail — keep it under 30 lines, behind a single `if (overrides?.stubEngineThrow)` branch.)

- [ ] **Step 3: Run the test — verify it fails**

Run: `npx vitest run test/unit/server/error-envelope-response.test.ts`
Expected: FAIL — the catch block currently rethrows on `SafariPilotError`, the test asserts a structured return.

- [ ] **Step 4: Replace the rethrow with structured conversion**

In `src/server.ts:1240-1281`, locate the `} catch (error) {` block at the end of `executeToolWithSecurity`. Below the existing audit-log record (after line 1278) and before `throw error;` (line 1280), add:

```typescript
      // F3.1 — Convert SafariPilotError instances to a structured isError MCP
      // response. Mirrors the T30 HumanApproval soft-return at server.ts:737-759
      // so the agent receives code/retryable/hints instead of opaque message
      // text. Non-SafariPilotError (TypeError, programming bugs) still rethrow.
      if (error instanceof SafariPilotError) {
        const payload = {
          error: error.code,
          message: error.message,
          retryable: error.retryable,
          hints: error.hints,
        };
        return {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          isError: true,
          metadata: {
            engine: selectedEngineName,
            degraded: false,
            latencyMs: Date.now() - start,
          },
        };
      }

      throw error;
```

Remove the original `throw error;` (line 1280) — it's replaced by the conditional throw inside the new block.

Verify the `SafariPilotError` import exists at the top of `src/server.ts`. If not, add it: `import { SafariPilotError, ... } from './errors.js';` (extend the existing errors import).

- [ ] **Step 5: Run both new tests + the full unit suite**

Run:
```bash
npx vitest run test/unit/errors/wrap-engine-error.test.ts test/unit/server/error-envelope-response.test.ts
npm run test:unit
```
Expected: all PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts test/unit/server/error-envelope-response.test.ts
git commit -m "feat(server): convert SafariPilotError to structured isError MCP response (F3.1)

Catch block in executeToolWithSecurity now mirrors the T30 HumanApproval
soft-return pattern: code/message/retryable/hints land in content[0].text
JSON with isError:true. The MCP request handler in src/index.ts already
forwards isError to the client (line 81). Agent sees recoverable structure
instead of an opaque thrown Error."
```

---

## Task 3: Replace ~70 throw sites with wrapEngineError (12 tool files, one task each — execute in any order)

For each file below, the operation is identical:

1. `import { wrapEngineError } from '../errors.js';` (add to the existing errors import if present).
2. Replace every line matching `if (!result.ok) throw new Error(result.error?.message ?? '<msg>');` with `if (!result.ok) throw wrapEngineError(result.error, '<msg>');`.
3. For variants without the `if (!result.ok)` prefix (e.g. `src/tools/pdf.ts:572`) replace `throw new Error(result.error?.message ?? '<msg>');` with `throw wrapEngineError(result.error, '<msg>');`.
4. Run that tool's unit tests; verify all pass.
5. Commit with `chore(tools/<file>): use wrapEngineError to preserve engine error envelope (F3.1)`.

### Task 3a: src/tools/interaction.ts (7 sites)

**Files:**
- Modify: `src/tools/interaction.ts:138,838,874,917,960,1022,1151`

- [ ] **Step 1: Apply the pattern**

Inspect each of the 7 sites; confirm the pre-image matches `throw new Error(result.error?.message ?? '<msg>');`. Apply the Edit tool with `replace_all: false`, replacing each verbatim. Add the import if missing.

- [ ] **Step 2: Run interaction tests**

Run: `npx vitest run test/unit --reporter=verbose 2>&1 | grep -i interaction`
(Or if a more specific path exists, target it.) Expected: PASS.

- [ ] **Step 3: Run full unit suite to catch unrelated breakage**

Run: `npm run test:unit`
Expected: 100/100 PASS.

- [ ] **Step 4: Commit**

```bash
git add src/tools/interaction.ts
git commit -m "chore(tools/interaction): use wrapEngineError to preserve engine error envelope (F3.1)

7 sites: 138 (executeAction), 838 (Type fast path), 874 (Type fallback),
917 (Press key), 960/1022 (Scroll variants), 1151 (Handle dialog)."
```

### Task 3b: src/tools/extraction.ts (13 sites)

**Files:**
- Modify: `src/tools/extraction.ts:309,331,380,436,494,549,613,670,918,951,967,1020,1036`

- [ ] **Step 1:** Apply the pattern across all 13 sites.
- [ ] **Step 2:** `npm run test:unit` → PASS.
- [ ] **Step 3:** Commit: `chore(tools/extraction): use wrapEngineError ... (F3.1)`.

### Task 3c: src/tools/storage.ts (13 sites)

**Files:**
- Modify: `src/tools/storage.ts:266,307,343,394,411,449,513,575,601,627,653,679,704,782`

(There are 14 sites by the grep, but 266+307 are paired guarded gets and 343+394 paired sets — visit each one.)

- [ ] **Step 1:** Apply the pattern.
- [ ] **Step 2:** `npm run test:unit` → PASS.
- [ ] **Step 3:** Commit: `chore(tools/storage): use wrapEngineError ... (F3.1)`.

### Task 3d: src/tools/network.ts (9 sites)

**Files:**
- Modify: `src/tools/network.ts:345,412,600,658,701,779,842,877,895`

- [ ] **Step 1:** Apply.
- [ ] **Step 2:** `npm run test:unit` → PASS.
- [ ] **Step 3:** Commit: `chore(tools/network): use wrapEngineError ... (F3.1)`.

### Task 3e: src/tools/structured-extraction.ts (9 sites)

**Files:**
- Modify: `src/tools/structured-extraction.ts:170,263,283,347,364,422,440,478,494,563`

- [ ] **Step 1:** Apply.
- [ ] **Step 2:** `npm run test:unit` → PASS.
- [ ] **Step 3:** Commit: `chore(tools/structured-extraction): use wrapEngineError ... (F3.1)`.

### Task 3f: src/tools/permissions.ts (5 sites)

**Files:**
- Modify: `src/tools/permissions.ts:196,270,303,333,358`

- [ ] **Step 1:** Apply.
- [ ] **Step 2:** `npm run test:unit` → PASS.
- [ ] **Step 3:** Commit: `chore(tools/permissions): use wrapEngineError ... (F3.1)`.

### Task 3g: src/tools/frames.ts (4 sites)

**Files:**
- Modify: `src/tools/frames.ts:81,112,128,178`

- [ ] **Step 1:** Apply.
- [ ] **Step 2:** `npm run test:unit` → PASS.
- [ ] **Step 3:** Commit: `chore(tools/frames): use wrapEngineError ... (F3.1)`.

### Task 3h: src/tools/shadow.ts (2 sites)

**Files:**
- Modify: `src/tools/shadow.ts:107,147`

- [ ] **Step 1:** Apply. (Leave the locally-thrown `Object.assign(new Error(...), { name: '...' })` branches at lines 87/89/91/124/126/128 alone — those are page-side errors with synthetic codes, not engine errors.)
- [ ] **Step 2:** `npm run test:unit` → PASS.
- [ ] **Step 3:** Commit: `chore(tools/shadow): use wrapEngineError ... (F3.1)`.

### Task 3i: src/tools/selector-pack.ts (2 sites)

**Files:**
- Modify: `src/tools/selector-pack.ts:87,104`

- [ ] **Step 1:** Apply. (Leave line 89 alone — that's `throw new Error('selectorPack register rejected by page: ${parsed.error}')`, a page-validation error not an engine error.)
- [ ] **Step 2:** `npm run test:unit` → PASS.
- [ ] **Step 3:** Commit: `chore(tools/selector-pack): use wrapEngineError ... (F3.1)`.

### Task 3j: src/tools/auth.ts (2 sites)

**Files:**
- Modify: `src/tools/auth.ts:133,150`

- [ ] **Step 1:** Apply.
- [ ] **Step 2:** `npm run test:unit` → PASS.
- [ ] **Step 3:** Commit: `chore(tools/auth): use wrapEngineError ... (F3.1)`.

### Task 3k: src/tools/pdf.ts (2 sites, variant pattern)

**Files:**
- Modify: `src/tools/pdf.ts:572,588`

- [ ] **Step 1:** These sites are inside conditional branches that look like:
  ```typescript
  if (!result.ok) {
    throw new Error(result.error?.message ?? 'Failed to extract HTML from Safari tab');
  }
  ```
  (i.e. multi-line `if` block, not the single-line `if (!result.ok) throw` form). Replace the `throw new Error(...)` line with `throw wrapEngineError(result.error, '<msg>');`.
- [ ] **Step 2:** `npm run test:unit` → PASS.
- [ ] **Step 3:** Commit: `chore(tools/pdf): use wrapEngineError ... (F3.1)`.

### Task 3l: src/tools/file-upload.ts (1 site)

**Files:**
- Modify: `src/tools/file-upload.ts:148`

(Lines 155, 204, 225 are also throws but `155` carries a synthetic `probe.errorCode` not from `EngineResult.error`; `204` uses a different message-construction pattern (`'stage_file failed: ${stageRes.error?.message ...}'`) — leave both alone in this task. Line 225 (`throw new Error(finalResult.error?.message ?? 'file upload dispatch failed');`) follows the canonical pattern — include it.)

- [ ] **Step 1:** Apply pattern at lines 148 + 225. Leave 155 and 204 untouched.
- [ ] **Step 2:** `npm run test:unit` → PASS.
- [ ] **Step 3:** Commit: `chore(tools/file-upload): use wrapEngineError ... (F3.1)`.

---

## Task 4: E2E envelope propagation test (DAEMON_TIMEOUT through real MCP stack)

**Files:**
- Create: `test/e2e/error-envelope-propagation.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// test/e2e/error-envelope-propagation.test.ts
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { McpTestClient } from '../helpers/mcp-client.js';

describe('F3.1 — engine error envelope propagation', () => {
  let client: McpTestClient;
  let createdTabUrl: string;

  beforeAll(async () => {
    client = new McpTestClient();
    await client.start();
    const r = await client.callTool('safari_new_tab', {
      url: 'data:text/html,<html><body><h1>ENVELOPE_TEST</h1></body></html>',
    });
    const parsed = JSON.parse(r.content[0].text);
    createdTabUrl = parsed.url;
  }, 60000);

  afterAll(async () => {
    if (createdTabUrl) {
      try { await client.callTool('safari_close_tab', { tabUrl: createdTabUrl }); } catch {}
    }
    await client.stop();
  });

  it('DAEMON_TIMEOUT surfaces as isError with code/retryable/hints in MCP response', async () => {
    // Inject a 20s sleep script into safari_evaluate; per Fix 2, default
    // timeout is now 15s, so this MUST time out. The structured envelope
    // must arrive at the MCP client, NOT a flat message-only Error.
    const r = await client.callToolRaw('safari_evaluate', {
      tabUrl: createdTabUrl,
      script: 'await new Promise(r => setTimeout(r, 20000));',
    });

    expect(r.isError).toBe(true);
    expect(r.content).toHaveLength(1);
    expect(r.content[0].type).toBe('text');
    const payload = JSON.parse(r.content[0].text);
    expect(payload.error).toBe('DAEMON_TIMEOUT');
    expect(typeof payload.message).toBe('string');
    expect(payload.message.toLowerCase()).toContain('timed out');
    expect(typeof payload.retryable).toBe('boolean');
    expect(Array.isArray(payload.hints)).toBe(true);
    expect(payload.hints.length).toBeGreaterThan(0);
  }, 30000);

  it('TAB_NOT_FOUND surfaces with structured envelope', async () => {
    const r = await client.callToolRaw('safari_get_text', {
      tabUrl: 'https://this-tab-was-never-opened.example.com/',
      selector: 'body',
    });

    expect(r.isError).toBe(true);
    const payload = JSON.parse(r.content[0].text);
    // TabUrlNotRecognizedError or TabNotFoundError — both should surface a structured code
    expect(['TAB_URL_NOT_RECOGNIZED', 'TAB_NOT_FOUND']).toContain(payload.error);
    expect(typeof payload.retryable).toBe('boolean');
    expect(Array.isArray(payload.hints)).toBe(true);
  }, 15000);
});
```

If `McpTestClient.callToolRaw` doesn't already return `isError`, add the field to the return type. (It already forwards `result` from the MCP SDK; just expose `isError` alongside `content`.)

- [ ] **Step 2: Run the test against the live stack**

Pre-flight: Safari running with the dev.9 extension already installed (per CHECKPOINT.md), daemon up.

Run: `npx vitest run test/e2e/error-envelope-propagation.test.ts`
Expected: 2/2 PASS.

- [ ] **Step 3: If the test fails because `_meta` / `isError` is not threaded through `McpTestClient`, fix the harness**

Locate `test/helpers/mcp-client.ts`; `callToolRaw()` should return `{ content, isError, _meta }` from the MCP `CallToolResultSchema` response, not just `content`. Add the missing fields if absent. Re-run.

- [ ] **Step 4: Commit**

```bash
git add test/e2e/error-envelope-propagation.test.ts test/helpers/mcp-client.ts
git commit -m "test(e2e): assert F3.1 envelope propagation through real MCP stack

DAEMON_TIMEOUT and TAB_NOT_FOUND now arrive at the MCP client as
isError:true with content[0].text carrying code/retryable/hints. Closes
the headline gap that made Track A's error envelope operationally inert."
```

---

## Task 5: F1.2 — Plumb sessionWindowId through daemon command body

**Files:**
- Modify: `src/engines/extension.ts` — include `sessionWindowId` in the command JSON passed to the daemon.
- Modify: `daemon/Sources/SafariPilotdCore/Models.swift` — add `sessionWindowId: Int?` to the `ExtensionCommand` codable struct.
- Modify: `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` — pass `sessionWindowId` through the HTTP poll endpoint's command body.

- [ ] **Step 1: Read the current command struct in Models.swift**

Locate the `ExtensionCommand` (or equivalent) Codable. Identify which fields are currently encoded (`tabUrl`, `script`, `tabId`, etc.).

- [ ] **Step 2: Add `sessionWindowId: Int?` to the struct**

```swift
// In daemon/Sources/SafariPilotdCore/Models.swift
public struct ExtensionCommand: Codable {
    public let id: String
    public let tabUrl: String?
    public let script: String?
    public let tabId: Int?
    public let sessionWindowId: Int?  // F1.2 — filter findTargetTab candidates
    // ... existing fields ...
}
```

If `ExtensionCommand` has a custom `init(from:)` or `encode(to:)`, extend both. If derivation is automatic, no further change required.

- [ ] **Step 3: Forward in ExtensionBridge.swift**

Locate the HTTP `/poll` handler (or wherever the bridge serializes the command body to send to the extension). Add `sessionWindowId` to the dictionary returned to `background.js`.

- [ ] **Step 4: TS side — emit sessionWindowId**

In `src/engines/extension.ts` `execute(...)`, the command body sent to the daemon. The session-window ID lives on `SafariPilotServer._sessionWindowId`. If the engine doesn't have access today, thread it through: `ExtensionEngine.setSessionWindowId(id: number)` setter, called from `server.ts` `start()` after the session window is created.

```typescript
// In src/engines/extension.ts
private sessionWindowId?: number;

setSessionWindowId(id: number): void {
  this.sessionWindowId = id;
}

// In execute(...), when building the command JSON:
const cmd = {
  id,
  tabUrl,
  script,
  tabId,
  sessionWindowId: this.sessionWindowId,  // F1.2
};
```

In `src/server.ts` `start()`, after the session window is created:
```typescript
this.extensionEngine?.setSessionWindowId(this._sessionWindowId);
```

- [ ] **Step 5: Smoke-build the daemon to catch the Swift change**

Run: `bash scripts/update-daemon.sh`
Expected: build succeeds, no Swift errors. The new field is harmless on the wire.

- [ ] **Step 6: Run TS unit tests**

Run: `npm run test:unit`
Expected: 100/100 PASS.

- [ ] **Step 7: Commit**

```bash
git add src/engines/extension.ts src/server.ts daemon/Sources/SafariPilotdCore/Models.swift daemon/Sources/SafariPilotdCore/ExtensionBridge.swift
git commit -m "feat(F1.2): thread sessionWindowId through daemon → extension command (F1.2)

ExtensionCommand now carries the MCP server's session window ID so the
extension's findTargetTab can filter candidates to the current session,
preventing cross-session pollution flagged by reviewer F1.2."
```

---

## Task 6: F1.2 — Extension filters findTargetTab candidates by sessionWindowId

**Files:**
- Modify: `extension/background.js` — extend `tabCacheMap` entry shape + `findTargetTab` filter.
- Create: `test/unit/extension/find-target-tab.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/extension/find-target-tab.test.ts
import { describe, expect, it } from 'vitest';
// Import the extension's findTargetTab and tabCacheMap helpers. If they
// aren't currently extracted, extract them into extension/findTargetTab.js
// (a CommonJS-compatible module) and import that here. See Step 2 if needed.
import { findTargetTab, _resetTabCache, _seedTabCache } from '../../../extension/findTargetTab.js';

describe('findTargetTab — F1.2 session filtering', () => {
  beforeEach(() => _resetTabCache());

  it('returns the tab when session matches', async () => {
    _seedTabCache([
      { id: 7, url: 'https://example.com/page', sessionWindowId: 100 },
    ]);
    const t = await findTargetTab('https://example.com/page', { sessionWindowId: 100 });
    expect(t?.id).toBe(7);
  });

  it('excludes a tab from a different session even with identical URL', async () => {
    _seedTabCache([
      { id: 1, url: 'https://example.com/page', sessionWindowId: 200 },
      { id: 2, url: 'https://example.com/page', sessionWindowId: 100 },
    ]);
    const t = await findTargetTab('https://example.com/page', { sessionWindowId: 100 });
    expect(t?.id).toBe(2);
  });

  it('returns null when no tab in the current session matches', async () => {
    _seedTabCache([
      { id: 1, url: 'https://example.com/page', sessionWindowId: 200 },
    ]);
    const t = await findTargetTab('https://example.com/page', { sessionWindowId: 100 });
    expect(t).toBeNull();
  });

  it('falls back to no filter when sessionWindowId is undefined (back-compat)', async () => {
    _seedTabCache([
      { id: 1, url: 'https://example.com/page', sessionWindowId: 200 },
    ]);
    const t = await findTargetTab('https://example.com/page', {});
    expect(t?.id).toBe(1);
  });
});
```

- [ ] **Step 2: If `findTargetTab` is not yet extractable, extract it**

If `extension/background.js` defines `findTargetTab` as a top-level function with no external imports, extract it (plus `spMatchTabUrl`, `tabCacheMap`, and the cache-mutation helpers) into a new module `extension/findTargetTab.js` that exports them. The background script re-imports them. This preserves runtime behavior while making the function unit-testable. (If extraction is non-trivial, move to MSW-style stub of `browser.tabs.query` and keep the function in-place; but extraction is preferred for clean TDD.)

- [ ] **Step 3: Run the test — verify it fails**

Run: `npx vitest run test/unit/extension/find-target-tab.test.ts`
Expected: FAIL — the function doesn't accept a `sessionWindowId` arg yet.

- [ ] **Step 4: Update findTargetTab**

Extend signature: `async function findTargetTab(tabUrl, opts = {})`. Inside:
- After `const all = await browser.tabs.query({});`, filter by `opts.sessionWindowId` if defined:
  ```javascript
  const sessionAll = (opts.sessionWindowId !== undefined)
    ? all.filter((t) => t.windowId === opts.sessionWindowId)
    : all;
  ```
  And use `sessionAll` for the matcher input.
- In the fallback `tabCacheMap` lookup, filter cache entries by `sessionWindowId` similarly.
- Update `tabs.onCreated` to record `windowId` (already does so via Safari's API) and `tabs.onUpdated` / `tabs.onRemoved` to maintain the field. Cache entry shape becomes `{ url, title, windowId }`.

Call-sites of `findTargetTab` in `background.js` `executeCommand` must pass `{ sessionWindowId: cmd.sessionWindowId }`.

- [ ] **Step 5: Run the test — verify it passes**

Run: `npx vitest run test/unit/extension/find-target-tab.test.ts`
Expected: 4/4 PASS.

- [ ] **Step 6: Build the extension to catch syntax issues**

Run: `bash scripts/build-extension.sh`
Expected: build + sign + notarize succeed. Verify the build emits `bin/Safari Pilot.app` with the new findTargetTab. (Notarization adds ~5min — accept the wait. NEVER skip per `feedback-no-skip-notarize`.)

- [ ] **Step 7: Commit**

```bash
git add extension/background.js extension/findTargetTab.js test/unit/extension/find-target-tab.test.ts
git commit -m "feat(F1.2): filter findTargetTab candidates by sessionWindowId

Reviewer F1.2: tabs.query({}) returns all tabs across all sessions. When
sessionWindowId is passed in the command body, filter candidates to that
window so cross-session stale tabs can't pollute the matcher. Unit-tested
via extracted findTargetTab.js module."
```

---

## Task 7: F1.2 — E2E cross-session isolation test

**Files:**
- Create: `test/e2e/cross-session-isolation.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// test/e2e/cross-session-isolation.test.ts
import { describe, expect, it, afterAll } from 'vitest';
import { McpTestClient } from '../helpers/mcp-client.js';

describe('F1.2 — cross-session tab isolation', () => {
  const clients: McpTestClient[] = [];

  afterAll(async () => {
    for (const c of clients) {
      try { await c.stop(); } catch {}
    }
  });

  it('session A cannot resolve a tab opened by session B', async () => {
    const sessionA = new McpTestClient();
    const sessionB = new McpTestClient();
    clients.push(sessionA, sessionB);
    await sessionA.start();
    await sessionB.start();

    // Session B opens a tab.
    const bOpen = await sessionB.callTool('safari_new_tab', {
      url: 'data:text/html,<html><body><h1>SESSION_B_ONLY</h1></body></html>',
    });
    const bUrl = JSON.parse(bOpen.content[0].text).url;

    // Session A tries to read that tab — must fail with TAB_NOT_FOUND
    // because it lives in B's session window, not A's.
    const aRead = await sessionA.callToolRaw('safari_get_text', {
      tabUrl: bUrl,
      selector: 'h1',
    });
    expect(aRead.isError).toBe(true);
    const payload = JSON.parse(aRead.content[0].text);
    expect(['TAB_URL_NOT_RECOGNIZED', 'TAB_NOT_FOUND']).toContain(payload.error);

    // Session B can still read its own tab.
    const bRead = await sessionB.callTool('safari_get_text', {
      tabUrl: bUrl,
      selector: 'h1',
    });
    expect(bRead.content[0].text).toContain('SESSION_B_ONLY');

    // Teardown.
    await sessionB.callTool('safari_close_tab', { tabUrl: bUrl });
  }, 90000);
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/e2e/cross-session-isolation.test.ts`
Expected: 1/1 PASS.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/cross-session-isolation.test.ts
git commit -m "test(e2e): cross-session tab isolation (F1.2)

Two concurrent MCP sessions open distinct session windows; each cannot
resolve the other's tabs via findTargetTab. Asserts the filter is wired
through real daemon → extension → matcher."
```

---

## Task 8: Build, install, smoke

**Files:** none new; uses existing build scripts.

- [ ] **Step 1: Bump intermediate version**

Edit `package.json` and `extension/manifest.json` to `0.1.36-dev.10`. (Per memory rule `feedback-extension-version-both-fields` — Safari caches by CFBundleShortVersionString, marketing version MUST bump.)

- [ ] **Step 2: Rebuild extension**

Run: `bash scripts/build-extension.sh`
Expected: archive, export, sign, notarize, staple all succeed. Final artifact `bin/Safari Pilot.app` at version 0.1.36-dev.10.

- [ ] **Step 3: Rebuild daemon if F1.2 changed Swift code**

Run: `bash scripts/update-daemon.sh`
Expected: build + sign + atomic swap. (Skip if Task 5 already ran the daemon build.)

- [ ] **Step 4: Install in Safari**

Run: `open "bin/Safari Pilot.app"`
Wait ~5s. Verify in Safari > Settings > Extensions that 0.1.36-dev.10 is active. (Follow `reference_extension_enablement_workaround` if Safari blocks enablement.)

- [ ] **Step 5: One-task smoke against dev.10**

```bash
rm -rf /tmp/wv-dev10-smoke && mkdir -p /tmp/wv-dev10-smoke
WV_AUTH=max \
WV_DATASET="/Users/Aakash/Claude Projects/Skills Factory/safari-pilot/bench-runs/v0136-probes/probe-tasks.jsonl" \
  bash bench/webvoyager/run-bench.sh --patched --runs 1 --concurrency 1 --limit 1 \
  --out-dir /tmp/wv-dev10-smoke
```
Expected: completes, `cost_usd: 0` in `/tmp/wv-dev10-smoke/Allrecipes--0-r1.score.json`.

- [ ] **Step 6: Commit version bump**

```bash
git add package.json extension/manifest.json
git commit -m "build(release): 0.1.36-dev.10 — picks up F3.1 + F1.2"
```

---

## Task 9: Launch full patched WebVoyager re-baseline (background, ~28h wall)

**Files:** none new.

- [ ] **Step 1: Verify environment**

```bash
curl -s http://127.0.0.1:19475/status   # expect {"ext":true, "mcp":false}
plutil -p "bin/Safari Pilot.app/Contents/Info.plist" | grep BundleShort  # expect 0.1.36-dev.10
which claude && (unset ANTHROPIC_API_KEY && claude -p "say ALIVE" --output-format text)  # expect ALIVE
```

- [ ] **Step 2: Launch full bench**

```bash
cd "/Users/Aakash/Claude Projects/Skills Factory/safari-pilot"
mkdir -p bench-runs/webvoyager-v0.1.36-bench-$(date +%Y%m%d)
WV_AUTH=max \
  bash bench/webvoyager/run-bench.sh --patched --runs 1 --concurrency 4 \
  --out-dir bench-runs/webvoyager-v0.1.36-bench-$(date +%Y%m%d) \
  > bench-runs/webvoyager-v0.1.36-bench-$(date +%Y%m%d)/runner.log 2>&1 &
```

Note the PID. Estimated wall: ~28h at concurrency 4. Max-billed → $0 API spend.

- [ ] **Step 3: Periodic check-in (every 4-6h)**

```bash
ls bench-runs/webvoyager-v0.1.36-bench-*/ | wc -l   # count of completed tasks
tail -20 bench-runs/webvoyager-v0.1.36-bench-*/runner.log
```

If progress stalls for > 1h or runner.log shows persistent error patterns, kill the bench and diagnose before relaunching.

- [ ] **Step 4: Once bench completes — confirm 641 tasks landed**

```bash
ls bench-runs/webvoyager-v0.1.36-bench-*/*.score.json | wc -l
# Expect 641 (or close — a handful of unreachable sites are normal)
```

No git commit at this step — bench output goes into `bench-runs/` which is the canonical artifact directory.

---

## Task 10: Trace-mine + validate acceptance criteria

**Files:** Create the analysis report in `bench-runs/webvoyager-v0.1.36-bench-<date>/trace-mining.md`.

- [ ] **Step 1: Mine error class counts**

Use the existing helper at `/tmp/v0135-trace-mining-helper` (or rebuild from the v0.1.35 trace-mining.md notes). Concretely:

```python
import json, glob, collections
errs = collections.Counter()
for path in glob.glob('bench-runs/webvoyager-v0.1.36-bench-*/*.stream.jsonl'):
    for line in open(path):
        if '"isError":true' in line or 'tool_result' in line:
            try:
                d = json.loads(line)
                # ... extract error code from MCP isError payload ...
            except: pass
print(errs.most_common(20))
```

(Adapt to the actual stream-json shape. See `bench-runs/webvoyager-v0.1.35-bench-20260515/trace-mining.md` for the canonical mining script.)

- [ ] **Step 2: Write the mining report**

Create `bench-runs/webvoyager-v0.1.36-bench-<date>/trace-mining.md` with:
- Headline counts: total calls, total errors, top-5 error classes with counts.
- Per-criterion verdict against spec:
  - Total errors ≤ 700? Y/N (actual: X)
  - Tab-cache-miss ≤ 80? Y/N
  - Daemon timeouts ≤ 100? Y/N
  - Storage bus ≤ 50? Y/N
  - No new class > 50? Y/N (if N: list which)
  - Median wall ≤ 150s? Y/N
  - Mean turns ≤ 18? Y/N
- Per-site breakdown (top 5 sites by error rate).

- [ ] **Step 3: Decide ship-readiness**

If all 8 criteria PASS → proceed to Task 11.
If 1-2 fail by < 20% → discuss with user (path B-loose) — likely still ship with named exceptions.
If > 2 fail or any fail by > 20% → STOP. Return to diagnosis. The spec's gate triggers ("return to diagnosis if any criterion fails by more than 20%").

- [ ] **Step 4: Commit the report**

```bash
git add bench-runs/webvoyager-v0.1.36-bench-*/trace-mining.md
git commit -m "docs(bench): v0.1.36 full-bench trace mining + acceptance verdict"
```

---

## Task 11: Ship v0.1.36

**Files:**
- Modify: `package.json` → version `0.1.36`
- Modify: `extension/manifest.json` → version `0.1.36`
- Modify: `CHANGELOG.md` — add 0.1.36 entry

- [ ] **Step 1: Bump versions to final**

Edit both `package.json` and `extension/manifest.json` to `"version": "0.1.36"`.

- [ ] **Step 2: Add CHANGELOG entry**

Append to `CHANGELOG.md`:

```markdown
## [0.1.36] - 2026-05-XX

### Added
- **F3.1: Engine error envelope preservation** — `EngineExecutionError` + `wrapEngineError()` helper lift `EngineResult.error.code/retryable/hints` into thrown `SafariPilotError` instances; `executeToolWithSecurity` catch block converts these to structured `isError: true` MCP responses. The agent now receives `{ error, message, retryable, hints }` JSON in `content[0].text` instead of opaque message strings (~70 call sites across 12 tool files).
- **F1.2: Session-scoped tab cache** — `sessionWindowId` threads through every daemon → extension command. The extension's `findTargetTab` filters candidates by the current session window, preventing cross-session pollution where concurrent MCP sessions could match each other's tabs.

### Track A (already in 0.1.36-dev series)
- Fix 1: 4-tier tab URL matcher with Tier 1 ambiguity guard (reviewer F1.1).
- Fix 2: Removed `Math.max(timeout, 90_000)` floor in `src/engines/extension.ts`; introduced structured `DAEMON_TIMEOUT` envelope.
- Fix 3: Content-script readiness gate via storage-bus heartbeat (telemetry-only; hard fast-fail wired but disabled).

### Verified
- WebVoyager patched-2026: <FILL FROM TASK 10 REPORT> total errors (was 3,209).
- All 100+ unit tests pass.
- All e2e tests pass on Safari 17 with the dev.10 binary.
```

- [ ] **Step 3: Final rebuild**

Run:
```bash
bash scripts/update-daemon.sh
bash scripts/build-extension.sh
```
Expected: both succeed; the final `bin/Safari Pilot.app` and `bin/SafariPilotd` carry version `0.1.36`.

- [ ] **Step 4: Local user-install rehearsal**

Run: `open "bin/Safari Pilot.app"`. Verify in Safari > Settings > Extensions that `0.1.36` shows up and the extension is active.

- [ ] **Step 5: Pre-tag check**

Run: `bash scripts/pre-tag-check.sh`
Expected: ends with `ALL CHECKS PASSED — safe to tag`. Per memory rule, NEVER push a tag without this script's green light.

- [ ] **Step 6: Commit + tag**

```bash
git add package.json extension/manifest.json CHANGELOG.md
git commit -m "chore(release): v0.1.36

F3.1 (envelope preservation) + F1.2 (session-scoped tabs) on top of
Track A. Headline error envelope now arrives at MCP clients with full
code/retryable/hints. WebVoyager re-baseline meets all spec acceptance
criteria (see bench-runs/webvoyager-v0.1.36-bench-*/trace-mining.md)."
git tag -a v0.1.36 -m "v0.1.36 — F3.1 + F1.2 + Track A complete"
```

- [ ] **Step 7: Merge worktree → main**

From the main repo at `/Users/Aakash/Claude Projects/Skills Factory/safari-pilot/`:

```bash
cd "/Users/Aakash/Claude Projects/Skills Factory/safari-pilot"
git checkout main
git pull
git merge feat/v0136-track-a-infra --no-ff -m "Merge feat/v0136-track-a-infra: v0.1.36 ship"
```

Resolve conflicts (most likely in `package.json`, `CHANGELOG.md`, `extension/manifest.json`). The worktree values win.

- [ ] **Step 8: Push**

```bash
git push origin main
git push origin v0.1.36
```

GitHub Actions `release.yml` will pick up the tag, run the canonical verify steps, and publish to GitHub Releases + npm.

- [ ] **Step 9: Verify release published**

```bash
gh release view v0.1.36
npm view safari-pilot version    # expect 0.1.36
```

Per memory rule `reference-ci-npm-token-expiry`: if `npm view` shows a stale version, the CI npm token has expired. Refresh and republish manually if needed.

- [ ] **Step 10: Sweep up**

Delete the worktree:
```bash
cd "/Users/Aakash/Claude Projects/Skills Factory/safari-pilot"
git worktree remove "../safari-pilot-v0136-track-a"
git branch -d feat/v0136-track-a-infra
```

Delete `CHECKPOINT.md` (per session-management rule):
```bash
rm CHECKPOINT.md
```

(Skip if user wants to keep it for postmortem reference — ask before deleting.)

---

## Self-review

**Spec coverage:**
- F3.1 (envelope preservation) → Tasks 1, 2, 3a–3l, 4 ✓
- F1.2 (session-scoped cache) → Tasks 5, 6, 7 ✓
- Build + install dev.10 → Task 8 ✓
- Full bench re-baseline → Task 9 ✓
- Acceptance criteria validation → Task 10 ✓
- Ship → Task 11 ✓

Spec acceptance criteria from `docs/upp/specs/2026-05-15-safari-pilot-v0136-track-a-infrastructure.md`:
- Total errors ≤ 700 → Task 10 ✓
- Tab-cache-miss ≤ 80 → Task 10 ✓
- Daemon timeouts ≤ 100 → Task 10 ✓
- Storage bus timeouts ≤ 50 → Task 10 ✓
- No new error class > 50 → Task 10 ✓
- Median wall ≤ 150s → Task 10 ✓
- Mean turns ≤ 18 → Task 10 ✓
- All e2e tests pass → Task 8 (smoke) + Task 4 + Task 7 (e2e additions) ✓

**Placeholder scan:**
- No "TBD", "implement later", "handle edge cases" without specifics.
- Task 10 has a `<FILL FROM TASK 10 REPORT>` in the CHANGELOG sample — this is deliberate (the actual numbers come from the bench run). The mining script in Step 1 is concrete enough for the engineer to produce real numbers.

**Type consistency:**
- `wrapEngineError(engineErr, fallback)` signature is used identically across Tasks 1, 2, 3a-l.
- `EngineExecutionError` constructor signature `(engineErr: EngineError)` is consistent.
- `findTargetTab(tabUrl, opts)` opts shape `{ sessionWindowId?: number }` is consistent across Tasks 5, 6.

**No design-aware tasks** (backend refactor, no DESIGN.md) — no spot-check / final-design-verification tasks needed.

---

## Execution Handoff

Plan complete and saved to `docs/upp/plans/2026-05-17-v0136-finishing-sprint.md`.

Execute with the executing-plans skill in subagent mode (default — fresh subagent per task with three-stage spec/quality/design review). Tasks 1, 2, 4, 5, 6, 7 are all TDD with concrete test code; Tasks 3a-3l are mechanical pattern replacements that benefit from subagent dispatch to keep file-state churn isolated. Task 8 (build) and Task 9 (launch bench) are single-shot subagent calls. Task 10 (analysis) and Task 11 (ship) are inline with user — they involve judgment calls and the canonical pre-tag-check.
