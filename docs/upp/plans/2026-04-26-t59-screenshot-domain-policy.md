# T59: Screenshot Domain Policy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the executing-plans skill to implement this plan task-by-task. Supports two modes: subagent-driven (recommended, fresh subagent per task with three-stage review) or inline execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Block `safari_take_screenshot` on sensitive financial domains (banking, payment processors) by injecting a `ScreenshotPolicy` check into the handler before `screencapture -x` runs; the policy queries the frontmost Safari tab URL when the caller omits `tabUrl`, closing the prompt-injection bypass.

**Architecture:** New `src/security/screenshot-policy.ts` holds the domain-matching logic; `ScreenshotBlockedError` is added to the existing error hierarchy in `src/errors.ts`; the `ExtractionTools` constructor accepts an optional `ScreenshotPolicy`; `src/server.ts` instantiates the policy from config and passes it in. The handler's policy check fires before the `screencapture` subprocess. If the policy is absent (e.g. unit tests that don't inject it), the check is skipped — no silent default-block behaviour.

**Tech Stack:** TypeScript, Vitest (unit tests), existing McpTestClient (e2e), `node:child_process.execFile` + `util.promisify` (AppleScript frontmost-tab query)

---

## Spec Reference

`docs/upp/specs/2026-04-26-threat-model-decisions.md` — T59 section (Design through Tests).

---

## Task 1: Create branch

**Files:** none

- [ ] **Step 1: Create and switch to feature branch**

```bash
git checkout -b fix/t59-screenshot-domain-policy
```

- [ ] **Step 2: Verify branch**

```bash
git branch --show-current
```
Expected: `fix/t59-screenshot-domain-policy`

---

## Task 2: Policy-logic unit tests — RED phase

Write the 4 `ScreenshotPolicy` tests. They import a module that does not yet exist, so they fail at collection time.

**Files:**
- Create: `test/unit/security/screenshot-policy.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
/**
 * T59 unit coverage for ScreenshotPolicy — the class that decides whether a
 * given URL's hostname falls inside the blocked-domain set.
 *
 * These 4 tests cover the three code paths in checkDomain():
 *   1. Seed list blocks a matched banking hostname.
 *   2. Seed list passes an unmatched hostname (no throw).
 *   3. Operator override with [] disables all blocking.
 *   4. Seed list is active by default (no config arg needed).
 *
 * Discrimination: delete the `find(p => p.test(hostname))` line in
 * checkDomain() → tests 1 and 4 fail (no throw). Delete the
 * `if (config?.blockedPatterns !== undefined)` branch → test 3 fails
 * (seed list still fires on the override path).
 */
import { describe, it, expect } from 'vitest';
import { ScreenshotPolicy } from '../../../src/security/screenshot-policy.js';
import { ScreenshotBlockedError } from '../../../src/errors.js';

describe('ScreenshotPolicy (T59)', () => {
  it('blocks a banking URL from the seed list', () => {
    const policy = new ScreenshotPolicy();
    expect(() => policy.checkDomain('https://online.chase.com/accounts'))
      .toThrow(ScreenshotBlockedError);
  });

  it('passes a non-banking URL without throwing', () => {
    const policy = new ScreenshotPolicy();
    expect(() => policy.checkDomain('https://example.com/page')).not.toThrow();
  });

  it('operator override with blockedPatterns:[] disables all blocking', () => {
    const policy = new ScreenshotPolicy({ blockedPatterns: [] });
    // Seed list is replaced by the empty override; no domain should throw.
    expect(() => policy.checkDomain('https://online.chase.com/accounts')).not.toThrow();
    expect(() => policy.checkDomain('https://paypal.com/checkout')).not.toThrow();
  });

  it('seed list is active by default (no config arg) — new ScreenshotPolicy() blocks chase.com', () => {
    // Confirms the seed list is opt-out, not opt-in.
    const policy = new ScreenshotPolicy();
    const err = (() => { try { policy.checkDomain('https://chase.com/'); } catch (e) { return e; } return null; })();
    expect(err).toBeInstanceOf(ScreenshotBlockedError);
    expect((err as ScreenshotBlockedError).domain).toBe('chase.com');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd "$(git rev-parse --show-toplevel)" && npx vitest run test/unit/security/screenshot-policy.test.ts 2>&1
```
Expected: FAIL — `Cannot find module '../../../src/security/screenshot-policy.js'`

---

## Task 3: Implement ScreenshotBlockedError + ScreenshotPolicy — GREEN phase

Wire the code. Tests must pass before committing.

**Files:**
- Modify: `src/errors.ts`
- Create: `src/security/screenshot-policy.ts`

- [ ] **Step 1: Add SCREENSHOT_BLOCKED to ERROR_CODES in `src/errors.ts`**

In `src/errors.ts` find the `ERROR_CODES` object (line 5). Add one entry before the closing `} as const`:

```typescript
// Old (last two lines of ERROR_CODES):
  SESSION_WINDOW_INIT_FAILED: 'SESSION_WINDOW_INIT_FAILED',
} as const;

// New:
  SESSION_WINDOW_INIT_FAILED: 'SESSION_WINDOW_INIT_FAILED',
  SCREENSHOT_BLOCKED: 'SCREENSHOT_BLOCKED',
} as const;
```

- [ ] **Step 2: Add ScreenshotBlockedError class to `src/errors.ts`**

Insert after `SessionWindowInitError` (ends at line 365), before the `// ─── formatToolError` comment:

```typescript
export class ScreenshotBlockedError extends SafariPilotError {
  readonly code = ERROR_CODES.SCREENSHOT_BLOCKED;
  readonly retryable = false;
  readonly hints: string[];

  constructor(public readonly domain: string) {
    super(`Screenshot blocked on sensitive domain: ${domain}`);
    this.name = 'ScreenshotBlockedError';
    this.hints = [
      'Use safari_get_text or safari_get_html to read DOM content (does not capture OS-level chrome)',
      'To override for all domains, set screenshotPolicy.blockedPatterns: [] in safari-pilot.config.json',
    ];
  }
}
```

- [ ] **Step 3: Create `src/security/screenshot-policy.ts`**

```typescript
import { ScreenshotBlockedError } from '../errors.js';

// Anchored hostname patterns — match exact domain and all subdomains.
// Mirrors SENSITIVE_PATTERNS in domain-policy.ts. Keep in sync:
// if SENSITIVE_PATTERNS gains a new entry, add it here too.
const BANKING_DOMAIN_SEED: RegExp[] = [
  /(^|\.)bank\./i,
  /(^|\.)banking\./i,
  /(^|\.)paypal\.com$/i,
  /(^|\.)stripe\.com$/i,
  /(^|\.)venmo\.com$/i,
  /(^|\.)chase\.com$/i,
  /(^|\.)wellsfargo\.com$/i,
  /(^|\.)bankofamerica\.com$/i,
  /(^|\.)citibank\.com$/i,
  /(^|\.)hsbc\.com$/i,
  /(^|\.)barclays\.com$/i,
];

export class ScreenshotPolicy {
  private patterns: RegExp[];

  constructor(config?: { blockedPatterns?: string[] }) {
    // blockedPatterns present (even []) = full replacement of seed list.
    // blockedPatterns absent = seed list active.
    if (config?.blockedPatterns !== undefined) {
      this.patterns = config.blockedPatterns.map((p) => new RegExp(p, 'i'));
    } else {
      this.patterns = BANKING_DOMAIN_SEED;
    }
  }

  checkDomain(url: string): void {
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return; // unparseable URL → fail open
    }
    const match = this.patterns.find((p) => p.test(hostname));
    if (match) throw new ScreenshotBlockedError(hostname);
  }
}
```

- [ ] **Step 4: Run policy-logic tests — verify they pass**

```bash
npx vitest run test/unit/security/screenshot-policy.test.ts 2>&1
```
Expected: 4 passed

- [ ] **Step 5: Verify no regressions in other unit tests**

```bash
npx vitest run 2>&1 | tail -6
```
Expected: same test counts as before (185 passed + new 4 = 189; failing count unchanged at 6)

- [ ] **Step 6: Commit**

```bash
git add src/errors.ts src/security/screenshot-policy.ts test/unit/security/screenshot-policy.test.ts
git commit -m "feat(T59): ScreenshotBlockedError + ScreenshotPolicy with anchored BANKING_DOMAIN_SEED"
```

---

## Task 4: Handler-wiring unit tests — RED phase

Write the 4 handler tests and update the schema test that will break. Both happen in the same step because they're in the same commit.

**Files:**
- Create: `test/unit/tools/take-screenshot-policy.test.ts`
- Modify: `test/unit/tools/extraction-screenshot-schema.test.ts`

- [ ] **Step 1: Write handler-wiring tests**

```typescript
/**
 * T59 unit coverage for the handler-level policy check in
 * ExtractionTools.handleTakeScreenshot.
 *
 * Four tests cover the check/no-check decision tree:
 *   5. tabUrl provided → blocks and never calls screencapture.
 *   6. tabUrl absent; getFrontmostTabUrl→chase.com (mock osascript) → blocks.
 *   7. tabUrl absent; getFrontmostTabUrl→example.com → screencapture runs.
 *   8. tabUrl absent; getFrontmostTabUrl→undefined (Safari not running) →
 *      fail open, screencapture runs.
 *
 * Mocks: node:child_process (execFile) and node:fs/promises (readFile, unlink)
 * are Node boundary mocks — permitted per CLAUDE.md unit test rules.
 * No internal modules are mocked.
 *
 * Discrimination: remove the `this.screenshotPolicy.checkDomain(urlToCheck)`
 * call in handleTakeScreenshot → tests 5 and 6 fail (screencapture runs on
 * banking domain; no throw). Restore → tests 5 and 6 pass.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from('iVBORw0KGgo=')), // fake PNG bytes
  unlink: vi.fn().mockResolvedValue(undefined),
}));

import { execFile } from 'node:child_process';
import { ExtractionTools } from '../../../src/tools/extraction.js';
import type { IEngine } from '../../../src/engines/engine.js';
import { ScreenshotPolicy } from '../../../src/security/screenshot-policy.js';
import { ScreenshotBlockedError } from '../../../src/errors.js';

// Helper: configure execFile to simulate osascript returning a URL.
// promisify(execFile) calls execFile(cmd, args, opts, (err, stdout, stderr) => void).
function mockOsascriptReturns(url: string | null): void {
  vi.mocked(execFile).mockImplementation(
    (cmd: string, _args: unknown, _opts: unknown, callback: unknown) => {
      const cb = callback as (err: null | Error, stdout: string, stderr: string) => void;
      if (cmd === 'osascript') {
        if (url !== null) cb(null, url + '\n', '');
        else cb(new Error('Safari not running'), '', '');
      } else if (cmd === 'screencapture') {
        // screencapture callback is (error) => void
        (callback as (err: null) => void)(null);
      }
      return {} as ReturnType<typeof execFile>;
    },
  );
}

describe('ExtractionTools handleTakeScreenshot — policy wiring (T59)', () => {
  let policy: ScreenshotPolicy;

  beforeEach(() => {
    vi.clearAllMocks();
    policy = new ScreenshotPolicy(); // seed list active
  });

  it('test 5: tabUrl=chase.com → throws ScreenshotBlockedError; screencapture not called', async () => {
    // execFile should never be called (neither osascript nor screencapture).
    const tools = new ExtractionTools({} as IEngine, policy);
    const handler = tools.getHandler('safari_take_screenshot')!;

    await expect(handler({ tabUrl: 'https://chase.com/' })).rejects.toBeInstanceOf(ScreenshotBlockedError);
    expect(vi.mocked(execFile)).not.toHaveBeenCalledWith(
      'screencapture', expect.anything(), expect.anything(), expect.anything(),
    );
  });

  it('test 6: no tabUrl; osascript returns chase.com → throws ScreenshotBlockedError; screencapture not called', async () => {
    mockOsascriptReturns('https://chase.com');
    const tools = new ExtractionTools({} as IEngine, policy);
    const handler = tools.getHandler('safari_take_screenshot')!;

    await expect(handler({})).rejects.toBeInstanceOf(ScreenshotBlockedError);
    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      'osascript', expect.anything(), expect.anything(), expect.anything(),
    );
    expect(vi.mocked(execFile)).not.toHaveBeenCalledWith(
      'screencapture', expect.anything(), expect.anything(), expect.anything(),
    );
  });

  it('test 7: no tabUrl; osascript returns example.com → screencapture runs', async () => {
    mockOsascriptReturns('https://example.com');
    const tools = new ExtractionTools({} as IEngine, policy);
    const handler = tools.getHandler('safari_take_screenshot')!;

    const result = await handler({});
    expect(result.content[0]).toMatchObject({ type: 'image' });
    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      'screencapture', expect.anything(), expect.anything(), expect.anything(),
    );
  });

  it('test 8: no tabUrl; osascript fails (Safari not running) → fail open, screencapture runs', async () => {
    mockOsascriptReturns(null); // osascript throws → getFrontmostTabUrl returns undefined
    const tools = new ExtractionTools({} as IEngine, policy);
    const handler = tools.getHandler('safari_take_screenshot')!;

    const result = await handler({});
    expect(result.content[0]).toMatchObject({ type: 'image' });
    expect(vi.mocked(execFile)).toHaveBeenCalledWith(
      'screencapture', expect.anything(), expect.anything(), expect.anything(),
    );
  });
});
```

- [ ] **Step 2: Run to verify tests fail**

```bash
npx vitest run test/unit/tools/take-screenshot-policy.test.ts 2>&1
```
Expected: FAIL — handler has no `screenshotPolicy` param and no policy check yet

- [ ] **Step 3: Update the schema test that will break when tabUrl is added**

In `test/unit/tools/extraction-screenshot-schema.test.ts`, test 1 currently asserts that `tabUrl` is NOT in the schema (from T17 cleanup). T59 re-adds `tabUrl` for a different, legitimate purpose: domain policy check. Update the test:

Replace the existing "does not declare `tabUrl`" test (lines 35-43):

```typescript
// OLD — this test must be removed/replaced:
it('does not declare `tabUrl` (handler ignores it; screencapture -x targets frontmost only)', () => {
  expect(getProperties()).not.toHaveProperty('tabUrl');
});

// NEW — replace with:
it('declares optional `tabUrl` for domain policy check; not in required[]', () => {
  // T59: tabUrl was re-introduced (after T17 removal) for the screenshot
  // domain policy check. The handler uses it to skip the AppleScript
  // frontmost-tab query. It must be OPTIONAL — callers may omit it and
  // the handler falls back to querying Safari directly.
  expect(getProperties()).toHaveProperty('tabUrl');
  const def = tools.getDefinitions().find((d) => d.name === 'safari_take_screenshot')!;
  const required = (def.inputSchema as { required?: string[] }).required ?? [];
  expect(required).not.toContain('tabUrl');
});
```

- [ ] **Step 4: Run all unit tests — confirm exact failures (handler wiring tests fail, schema test now correct)**

```bash
npx vitest run test/unit/tools/ 2>&1
```
Expected: 4 new failures in take-screenshot-policy.test.ts; schema test passes (or fails if you haven't yet updated — it should pass after the update above)

---

## Task 5: Implement config + handler wiring + server.ts — GREEN phase

**Files:**
- Modify: `src/config.ts`
- Modify: `src/tools/extraction.ts`
- Modify: `src/server.ts`

- [ ] **Step 1: Add `screenshotPolicy` to `SafariPilotConfig` interface in `src/config.ts`**

After the `extension: ExtensionConfig;` line (line 63), add before the closing `}`:

```typescript
// OLD (end of SafariPilotConfig):
  extension: ExtensionConfig;
}

// NEW:
  extension: ExtensionConfig;
  screenshotPolicy?: {
    blockedPatterns?: string[];  // full replacement of seed list; absent = seed list active
  };
}
```

- [ ] **Step 2: Add `screenshotPolicy` to `DEFAULT_CONFIG` in `src/config.ts`**

After the `extension: { ... }` block (line 97-100), before the closing `};`:

```typescript
// OLD (end of DEFAULT_CONFIG):
  extension: {
    enabled: true,
    killSwitchVersion: '0.1.5',
  },
};

// NEW:
  extension: {
    enabled: true,
    killSwitchVersion: '0.1.5',
  },
  screenshotPolicy: undefined,
};
```

- [ ] **Step 3: Add `screenshotPolicy` validation to `validate()` in `src/config.ts`**

After the last `assertString('extension.killSwitchVersion', ...)` call (line 204), before the closing `}` of `validate()`:

```typescript
  if (config.screenshotPolicy !== undefined) {
    assertSection('screenshotPolicy', config.screenshotPolicy);
    if (config.screenshotPolicy.blockedPatterns !== undefined) {
      if (!Array.isArray(config.screenshotPolicy.blockedPatterns)) {
        throw new ConfigValidationError('screenshotPolicy.blockedPatterns must be a string array');
      }
      for (const p of config.screenshotPolicy.blockedPatterns) {
        if (typeof p !== 'string') {
          throw new ConfigValidationError(
            `screenshotPolicy.blockedPatterns: all entries must be strings, got ${typeof p}`,
          );
        }
        try {
          new RegExp(p);
        } catch (e) {
          throw new ConfigValidationError(
            `screenshotPolicy.blockedPatterns: invalid regex "${p}": ${(e as Error).message}`,
          );
        }
      }
    }
  }
```

- [ ] **Step 4: Add `promisify` import and `execFilePromise` to `src/tools/extraction.ts`**

The file currently imports `import { execFile } from 'node:child_process';` (line 1). Replace with:

```typescript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
```

After the imports block (after line 9, before `export interface ToolDefinition`), add:

```typescript
const execFilePromise = promisify(execFile);
```

- [ ] **Step 5: Add `ScreenshotPolicy` import + private field + updated constructor to `src/tools/extraction.ts`**

Add to the imports at the top of the file (after the existing imports, around line 9):

```typescript
import { ScreenshotPolicy } from '../security/screenshot-policy.js';
```

Find the `ExtractionTools` class definition (line 20). Update the private fields and constructor:

```typescript
// OLD:
export class ExtractionTools {
  private engine: IEngine;
  private handlers: Map<string, Handler> = new Map();

  constructor(engine: IEngine) {
    this.engine = engine;
    this.registerHandlers();
  }

// NEW:
export class ExtractionTools {
  private engine: IEngine;
  private handlers: Map<string, Handler> = new Map();
  private screenshotPolicy?: ScreenshotPolicy;

  constructor(engine: IEngine, screenshotPolicy?: ScreenshotPolicy) {
    this.engine = engine;
    this.screenshotPolicy = screenshotPolicy;
    this.registerHandlers();
  }
```

- [ ] **Step 6: Add `tabUrl` to `safari_take_screenshot` schema in `src/tools/extraction.ts`**

Find the `safari_take_screenshot` definition (line 167-184). Update `inputSchema.properties` to add `tabUrl`:

```typescript
// OLD:
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Optional file path to save the screenshot. If omitted, returns base64 data.',
            },
            format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format', default: 'png' },
          },
          required: [],
        },

// NEW:
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: {
              type: 'string',
              description:
                'URL of the tab currently being operated on. Used for the screenshot domain policy check. ' +
                'If omitted, the handler queries Safari for the frontmost tab URL.',
            },
            path: {
              type: 'string',
              description: 'Optional file path to save the screenshot. If omitted, returns base64 data.',
            },
            format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format', default: 'png' },
          },
          required: [],
        },
```

- [ ] **Step 7: Add `getFrontmostTabUrl` private helper and policy check to `handleTakeScreenshot` in `src/tools/extraction.ts`**

Add the helper method anywhere in the private methods section (e.g. just before `handleTakeScreenshot` at line 384):

```typescript
  private async getFrontmostTabUrl(): Promise<string | undefined> {
    try {
      const { stdout } = await execFilePromise(
        'osascript',
        ['-e', 'tell application "Safari" to return URL of current tab of front window'],
        { timeout: 3000 },
      );
      return stdout.trim() || undefined;
    } catch {
      return undefined; // Safari not running, no window, or permission denied → fail open
    }
  }
```

Update `handleTakeScreenshot` (line 384) to add the policy check at the top of the function, after reading `start` and before the `screencapture` call:

```typescript
// OLD:
  private async handleTakeScreenshot(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const format = (params['format'] as string | undefined) ?? 'png';

// NEW:
  private async handleTakeScreenshot(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();

    if (this.screenshotPolicy) {
      const tabUrl = params['tabUrl'] as string | undefined;
      const urlToCheck = tabUrl ?? await this.getFrontmostTabUrl();
      if (urlToCheck) {
        this.screenshotPolicy.checkDomain(urlToCheck); // throws ScreenshotBlockedError if blocked
      }
      // urlToCheck === undefined → fail open (Safari not running, no window)
    }

    const format = (params['format'] as string | undefined) ?? 'png';
```

- [ ] **Step 8: Wire ScreenshotPolicy into ExtractionTools in `src/server.ts`**

Add the `ScreenshotPolicy` import at the top of `src/server.ts` (near other security imports):

```typescript
import { ScreenshotPolicy } from './security/screenshot-policy.js';
```

Find the `ExtractionTools` instantiation (line 317):

```typescript
// OLD:
    const extractionTools = new ExtractionTools(proxy);

// NEW:
    const screenshotPolicy = new ScreenshotPolicy(this.config.screenshotPolicy);
    const extractionTools = new ExtractionTools(proxy, screenshotPolicy);
```

- [ ] **Step 9: Compile to verify no TypeScript errors**

```bash
npm run lint 2>&1
```
Expected: no errors

- [ ] **Step 10: Run all unit tests — verify 4 new handler tests now pass**

```bash
npx vitest run 2>&1 | tail -6
```
Expected: 8 new tests passing (4 policy + 4 handler). Previously failing 6 tests should be unchanged.

- [ ] **Step 11: Commit**

```bash
git add src/config.ts src/tools/extraction.ts src/server.ts \
        test/unit/tools/take-screenshot-policy.test.ts \
        test/unit/tools/extraction-screenshot-schema.test.ts
git commit -m "feat(T59): wire ScreenshotPolicy into ExtractionTools + config support + tabUrl schema"
```

---

## Task 6: E2E architecture wiring test

Write the litmus test that fails if `server.ts` stops wiring `ScreenshotPolicy` into `ExtractionTools`. This test requires the full production stack (daemon + extension + Safari).

**Files:**
- Modify: `test/e2e/security-layers.test.ts`

- [ ] **Step 1: Add the T59 wiring test to `test/e2e/security-layers.test.ts`**

At the end of the `describe('Security layers e2e (SD-04)')` block, add:

```typescript
  // ── T59: ScreenshotPolicy wiring ─────────────────────────────────────────
  it('T59: safari_take_screenshot with tabUrl=chase.com returns SCREENSHOT_BLOCKED error', async () => {
    // This is the architecture litmus test: delete `const screenshotPolicy =
    // new ScreenshotPolicy(...)` from server.ts → this test fails (no block,
    // tool returns an image instead of an error). Restore → passes.
    //
    // Calls safari_take_screenshot with a synthetic tabUrl pointing to a
    // blocked domain. Does NOT open a real tab on chase.com (screencapture
    // is blocked before running, so no actual screen content is captured).
    const raw = await rawCallTool(
      client,
      'safari_take_screenshot',
      { tabUrl: 'https://chase.com/accounts' },
      nextId(),
      15_000,
    );

    // The response must be degraded with SCREENSHOT_BLOCKED error code.
    // server.ts wraps SafariPilotError in a degraded envelope (same path
    // as HUMAN_APPROVAL_REQUIRED — server.ts:486-503).
    expect(raw.meta?.['degraded'], 'expected degraded:true for blocked domain').toBe(true);
    expect(raw.payload['error'], 'expected SCREENSHOT_BLOCKED error code').toBe('SCREENSHOT_BLOCKED');
    // The domain must appear in the payload — distinguishes a stub that
    // throws the right code from one that actually checked the domain.
    expect(JSON.stringify(raw.payload)).toContain('chase.com');
  }, 20_000);
```

- [ ] **Step 2: Run e2e security-layers test (production stack required)**

```bash
npx vitest run test/e2e/security-layers.test.ts 2>&1 | tail -10
```
Expected: all existing tests pass; the new T59 test passes.

If the production stack is not running: skip this step and note it for manual verification before merge.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/security-layers.test.ts
git commit -m "test(T59): e2e litmus — safari_take_screenshot blocked on chase.com via ScreenshotPolicy wiring"
```

---

## Task 7: Update ARCHITECTURE.md

Document the T59 handler-level check, TOCTOU limitation, config field, and domain fallback.

**Files:**
- Modify: `ARCHITECTURE.md`

- [ ] **Step 1: Find the screenshot-related section in ARCHITECTURE.md**

```bash
grep -n "screenshot\|ScreenshotRedact\|T59\|T36" ARCHITECTURE.md | head -20
```

- [ ] **Step 2: Update or add screenshot policy documentation**

Locate the security pipeline section in `ARCHITECTURE.md`. Add a note after the post-execution layers description (the paragraph mentioning T36 deletion of ScreenshotRedaction). The note should document:

```markdown
### `safari_take_screenshot` Domain Policy (T59)

`safari_take_screenshot` has a **handler-level policy check** that fires before `screencapture -x`, separate from the 9-layer security pipeline. The check is implemented in `ScreenshotPolicy` (`src/security/screenshot-policy.ts`) and injected into `ExtractionTools` by `server.ts`.

**Domain determination:** If the caller supplies `tabUrl`, that URL is checked. If `tabUrl` is absent, the handler queries Safari for the frontmost tab URL via AppleScript (`osascript -e 'tell application "Safari" to return URL of current tab of front window'`, 3s timeout). If that query fails (Safari not running, no window, permission denied), the check is skipped and `screencapture` runs (fail-open).

**Config:** `screenshotPolicy.blockedPatterns: string[]` in `safari-pilot.config.json` fully replaces the seed list. Set `[]` to disable all blocking. Absent from config = seed list active.

**TOCTOU limitation (accepted):** The domain check validates the frontmost tab URL at query time. `screencapture -x` captures the screen at execution time. A navigation between these two moments (narrow race) could pass the check on `example.com` while `screencapture` captures `chase.com`. This race is inherent to the screen-level tool design and accepted.
```

- [ ] **Step 3: Compile and run unit tests — confirm no regressions**

```bash
npm run lint 2>&1 && npx vitest run 2>&1 | tail -6
```

- [ ] **Step 4: Commit**

```bash
git add ARCHITECTURE.md
git commit -m "docs(T59): document handler-level ScreenshotPolicy, TOCTOU limitation, config field"
```

---

## Task 8: Final verification and merge

- [ ] **Step 1: Full unit test run**

```bash
npx vitest run 2>&1 | tail -6
```
Expected: 8 new tests passing vs baseline; previously failing 6 unchanged.

- [ ] **Step 2: Full lint pass**

```bash
npm run lint 2>&1
```
Expected: no errors

- [ ] **Step 3: Review all changes**

```bash
git diff main..fix/t59-screenshot-domain-policy --stat
```
Expected: 7-8 files changed:
- `src/errors.ts` (SCREENSHOT_BLOCKED + ScreenshotBlockedError)
- `src/config.ts` (screenshotPolicy interface + DEFAULT_CONFIG + validate)
- `src/security/screenshot-policy.ts` (new)
- `src/tools/extraction.ts` (promisify, constructor, tabUrl schema, getFrontmostTabUrl, policy check)
- `src/server.ts` (ScreenshotPolicy import + instantiation)
- `ARCHITECTURE.md` (T59 docs)
- `test/unit/security/screenshot-policy.test.ts` (new)
- `test/unit/tools/take-screenshot-policy.test.ts` (new)
- `test/unit/tools/extraction-screenshot-schema.test.ts` (tabUrl test replaced)
- `test/e2e/security-layers.test.ts` (T59 litmus test added)

- [ ] **Step 4: Merge to main**

```bash
git checkout main
git merge fix/t59-screenshot-domain-policy
git branch -d fix/t59-screenshot-domain-policy
```

- [ ] **Step 5: Push to origin**

```bash
git push origin main
```

---

## Test count summary

| Suite | New tests | File |
|-------|-----------|------|
| Unit — policy logic | 4 | `test/unit/security/screenshot-policy.test.ts` |
| Unit — handler wiring | 4 | `test/unit/tools/take-screenshot-policy.test.ts` |
| E2E — architecture litmus | 1 | `test/e2e/security-layers.test.ts` |
| **Total new** | **9** | |

9 tests > 3 → full `test-reviewer` gate applies during execution.
