# Threat-Model Decisions: SD-30, T59, SD-33
*Brainstormed 2026-04-26 | Adversarially reviewed and revised 2026-04-26*

---

## SD-30 — Banking-disable-extension: Deferred Indefinitely

**Decision:** Do not implement.

**Rationale (corrected from first draft):** The extension engine has four capabilities that applescript/daemon lack: httpOnly cookie access (`safari_get_cookies`), network request interception (`safari_intercept_requests`, `safari_mock_request`), CSP bypass for script injection, and closed shadow DOM traversal. These are meaningfully larger attack surfaces than "can read HTML." The decision to defer SD-30 is not that the extension adds no marginal risk — it does. The decision is that the complexity of per-domain engine restriction (re-introducing `extensionAllowed` into `DomainPolicy` + `selectEngine` wiring + discriminating tests + operator config) is not justified given the defense-in-depth nature of the pipeline. The accepted risks are: on banking domains, the agent can still read httpOnly session cookies and intercept network requests if it has a tab it owns there.

**Tracker status:** Remove from deferred features table. Filing this decision as permanent.

---

## T59 — Domain-Allowlist Screenshot Policy

### Threat Model

**Primary threat:** Prompt injection on the page. A malicious banking/payment-processor page injects instructions into the DOM, directing the agent to call `safari_take_screenshot`. The tool runs `screencapture -x`, which captures OS-level chrome — autofill suggestions, password manager popups, 2FA notification banners — that is not accessible via any DOM tool (`safari_get_html`, `safari_get_text`, `safari_evaluate`, `safari_extract_metadata` all see only the page DOM, not OS-level UI rendered on top).

**Why this is the unique channel:** No other tool captures OS-level chrome. `screencapture -x` is immune to DOM manipulation — a page cannot remove autofill UI from a screenshot by hiding DOM elements. T59 closes this specific path.

**Accepted limitation (TOCTOU):** The domain check validates the frontmost Safari tab's URL at call time. `screencapture -x` captures whatever is visible at execution time. If a navigation occurs between the URL query and the capture (race condition), the check may pass on `example.com` but the screenshot shows `chase.com`. This race is narrow and inherent to the screen-level tool design. Documented as an accepted limitation in `ARCHITECTURE.md`.

**Why this is defense-in-depth, not a complete defense:** The agent retains 5 other read channels for DOM content. Blocking screenshots does not prevent data exfiltration via DOM tools. T59 removes the one path that exposes credentials visible only in OS-level UI (autofill, password manager, 2FA banners).

### Design

#### New file: `src/security/screenshot-policy.ts`

Seed list mirrors `SENSITIVE_PATTERNS` from `domain-policy.ts` (same domain scope, anchored hostname regex format):

```typescript
// Anchored hostname patterns — match exact domain and all subdomains.
// Mirrors SENSITIVE_PATTERNS in domain-policy.ts. Keep in sync.
const BANKING_DOMAIN_SEED: RegExp[] = [
  /(^|\.)bank\./i,           // *.bank.* (any bank.TLD)
  /(^|\.)banking\./i,        // *.banking.*
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
    // blockedPatterns present (even empty []) = full replacement of seed list.
    // blockedPatterns absent = seed list active.
    if (config?.blockedPatterns !== undefined) {
      this.patterns = config.blockedPatterns.map(p => new RegExp(p, 'i'));
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
    const match = this.patterns.find(p => p.test(hostname));
    if (match) throw new ScreenshotBlockedError(hostname);
  }
}
```

**Pattern anchoring:** All seed patterns use `/(^|\.)domain\.tld$/i` — matches the exact domain and any subdomain, but not substrings in unrelated hostnames. The first draft used unanchored patterns that would block `ebank.com`, `openbank.com`, `nonbank.com` as false positives. Anchored patterns eliminate this.

**Seed list alignment:** The seed list adds `hsbc.com` and `barclays.com` (from the deleted `screenshot-redaction.ts`) to the domains already in `SENSITIVE_PATTERNS`. Both lists must be kept in sync — if `SENSITIVE_PATTERNS` gains a new domain, `BANKING_DOMAIN_SEED` should too. A comment in `screenshot-policy.ts` marks this maintenance requirement.

**Config semantics:** `blockedPatterns`, when present, is a full replacement of the seed list. To extend, operator lists all desired patterns (seed + additions). To disable entirely, operator sets `blockedPatterns: []`. When absent from config, seed list is active.

#### Config change: `src/config.ts`

The `deepMerge` in `loadConfig()` silently drops keys not present in `DEFAULT_CONFIG`. `screenshotPolicy` must be added to both `SafariPilotConfig` and `DEFAULT_CONFIG` or operator overrides are silently ignored.

Add to `SafariPilotConfig` interface:
```typescript
screenshotPolicy?: {
  blockedPatterns?: string[];  // full override of seed list; absent = use seed
};
```

Add to `DEFAULT_CONFIG`:
```typescript
screenshotPolicy: undefined,   // undefined = seed list active
```

Add to `validate()`:
```typescript
if (config.screenshotPolicy?.blockedPatterns !== undefined) {
  if (!Array.isArray(config.screenshotPolicy.blockedPatterns)) {
    throw new ConfigValidationError('screenshotPolicy.blockedPatterns must be a string array');
  }
  for (const p of config.screenshotPolicy.blockedPatterns) {
    if (typeof p !== 'string') {
      throw new ConfigValidationError(`screenshotPolicy.blockedPatterns: all entries must be strings, got ${typeof p}`);
    }
    try {
      new RegExp(p);
    } catch (e) {
      throw new ConfigValidationError(`screenshotPolicy.blockedPatterns: invalid regex "${p}": ${(e as Error).message}`);
    }
  }
}
```

Regex validation in `validate()` (not in the `ScreenshotPolicy` constructor) ensures a malformed pattern in the config file produces a `ConfigValidationError` at startup — not an uncaught exception mid-construction.

#### Schema change: `src/tools/extraction.ts` (`safari_take_screenshot`)

Add optional `tabUrl` to the input schema:
```json
"tabUrl": {
  "type": "string",
  "description": "URL of the tab currently being operated on. Used for the screenshot domain policy check. If omitted, the handler queries Safari for the frontmost tab's URL."
}
```

`required` stays `[]`. `tabUrl` is optional but the domain check always fires — if `tabUrl` is absent, the handler falls back to querying Safari directly (see handler change below).

#### Handler change: `src/tools/extraction.ts`

```typescript
// ExtractionTools constructor
constructor(engine: IEngine, screenshotPolicy?: ScreenshotPolicy) {
  this.engine = engine;
  this.screenshotPolicy = screenshotPolicy;
  this.registerHandlers();
}

// New private helper — queries Safari for the current frontmost tab URL
private async getFrontmostTabUrl(): Promise<string | undefined> {
  try {
    const { stdout } = await execFilePromise('osascript', [
      '-e', 'tell application "Safari" to return URL of current tab of front window'
    ], { timeout: 3000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;  // fail open: Safari not running, no window, or permission denied
  }
}

// handleTakeScreenshot — policy check before screencapture
private async handleTakeScreenshot(params: Record<string, unknown>): Promise<ToolResponse> {
  if (this.screenshotPolicy) {
    const tabUrl = params['tabUrl'] as string | undefined;
    const urlToCheck = tabUrl ?? await this.getFrontmostTabUrl();
    if (urlToCheck) {
      this.screenshotPolicy.checkDomain(urlToCheck);  // throws ScreenshotBlockedError if blocked
    }
    // urlToCheck undefined = fail open (Safari not running, no window)
  }
  // ... existing screencapture -x logic unchanged
}
```

**Why this closes C-2:** The check no longer depends on the caller passing `tabUrl`. Even if a prompt injection payload omits it, the handler queries Safari for the real frontmost tab URL (~80ms, consistent with `screencapture`'s existing 10s timeout). Callers that do pass `tabUrl` use that; callers that don't get the real screen state checked.

#### Server change: `src/server.ts`

```typescript
// In tool registration block (line ~317):
const screenshotPolicy = new ScreenshotPolicy(this.config.screenshotPolicy);
const extractionTools = new ExtractionTools(proxy, screenshotPolicy);
```

#### New error: `src/errors.ts`

```typescript
export class ScreenshotBlockedError extends SafariPilotError {
  readonly code = ERROR_CODES.SCREENSHOT_BLOCKED;
  readonly retryable = false;
  constructor(public readonly domain: string) {
    super(`Screenshot blocked on sensitive domain: ${domain}`);
    this.hints = [
      'Use safari_get_text or safari_get_html to read DOM content (does not capture OS-level chrome)',
      'To override for all domains, set screenshotPolicy.blockedPatterns: [] in safari-pilot.config.json',
    ];
  }
}
```

New error code:
```typescript
SCREENSHOT_BLOCKED: 'SCREENSHOT_BLOCKED',
```

### Files Changed

| File | Change |
|------|--------|
| `src/security/screenshot-policy.ts` | **New** — `ScreenshotPolicy` class + anchored `BANKING_DOMAIN_SEED` |
| `src/errors.ts` | Add `SCREENSHOT_BLOCKED` to `ERROR_CODES` + `ScreenshotBlockedError` class |
| `src/config.ts` | Add `screenshotPolicy` to `SafariPilotConfig`, `DEFAULT_CONFIG`, and `validate()` |
| `src/tools/extraction.ts` | Inject `screenshotPolicy`; add `tabUrl` (optional) to schema; add `getFrontmostTabUrl()`; policy check before screencapture |
| `src/server.ts` | Create `ScreenshotPolicy(config.screenshotPolicy)`, pass to `ExtractionTools` |
| `ARCHITECTURE.md` | Document T59 handler-level check; TOCTOU accepted limitation; config field |
| `test/unit/security/screenshot-policy.test.ts` | **New** — policy-logic tests |
| `test/unit/tools/take-screenshot-policy.test.ts` | **New** — handler-wiring tests |
| `test/e2e/security-layers.test.ts` | **New test** — architecture wiring test (MCP-spawning) |

### Tests

**`test/unit/security/screenshot-policy.test.ts`** (4 tests):
1. Banking URL (`https://online.chase.com/accounts`) → `checkDomain` throws `ScreenshotBlockedError` with `domain: 'chase.com'`
2. Non-banking URL (`https://example.com/page`) → `checkDomain` returns void (no throw)
3. Operator override with `blockedPatterns: []` → no URL throws (seed list fully replaced by empty list)
4. Seed list is active by default → `new ScreenshotPolicy()` (no config) blocks `chase.com`; confirms seed is not opt-in

**`test/unit/tools/take-screenshot-policy.test.ts`** (4 tests):
5. `handleTakeScreenshot` with `tabUrl: 'https://chase.com'` → throws `ScreenshotBlockedError`; `execFile('screencapture')` not called (mock `node:child_process` per unit boundary rules)
6. `handleTakeScreenshot` with no `tabUrl`; `getFrontmostTabUrl()` resolves to `'https://chase.com'` (mock `osascript`) → throws `ScreenshotBlockedError`; `screencapture` not called
7. `handleTakeScreenshot` with no `tabUrl`; `getFrontmostTabUrl()` resolves to `'https://example.com'` → `screencapture` runs
8. `handleTakeScreenshot` with no `tabUrl`; `getFrontmostTabUrl()` resolves to `undefined` (Safari not running) → fail open, `screencapture` runs

**`test/e2e/security-layers.test.ts`** (1 new test — architecture wiring):
9. Spawn real MCP server via `McpTestClient`; call `safari_take_screenshot` with `tabUrl: 'https://chase.com'` on an owned tab; assert response contains `SCREENSHOT_BLOCKED` error code. **This is the litmus test that deleting the `ScreenshotPolicy` wiring in `server.ts` makes fail.**

9 tests total — 8 unit + 1 e2e → full `test-reviewer` gate.

**Discriminator (unit):** Revert the `checkDomain(urlToCheck)` line in `handleTakeScreenshot` → tests 5 and 6 fail (screencapture runs on banking domain). Restore → tests 5 and 6 pass.

**Discriminator (e2e):** Delete `const screenshotPolicy = new ScreenshotPolicy(...)` from `server.ts` → test 9 fails (no block). Restore → test 9 passes.

### ARCHITECTURE.md Update (required)

Update in the same commit as the code. Must document:
- `safari_take_screenshot` has a handler-level policy check that fires before `screencapture -x`, separate from the 9-layer security pipeline
- Domain is determined by: caller-provided `tabUrl` if present, else an AppleScript query for the frontmost Safari tab URL; if that also fails (Safari not running), fail open
- Config field: `screenshotPolicy.blockedPatterns: string[]` (full override of seed list)
- Accepted limitation (TOCTOU): check validates URL at query time; `screencapture` captures screen at execution time; narrow race window accepted

### Branch

`fix/t59-screenshot-domain-policy`

---

## SD-33 — HealthStore Dead Instrumentation: Wire (Option A)

**Decision:** Wire SD-33a, SD-33b, and SD-33d. Investigate SD-33c before committing to wiring or deletion.

**Rationale:** The methods, backing arrays, and health-snapshot fields exist. Wiring them gives real telemetry that enables three named operational decisions:
- `roundtripCount1h` — confirms the extension is alive and processing commands. Zero after agent activity = extension is stuck (actionable: check `safari_extension_health`, consider force-reload)
- `timeoutCount1h` — alert signal: non-zero = commands are timing out. Actionable: diagnose extension connectivity, consider reducing request rate
- `forceReloadCount24h` — measures extension instability over time. A rising count = extension keeps crashing. Useful for diagnosing systemic recovery loops

`uncertainCount1h` (SD-33c) has no verified production path — investigation required first.

### Sub-items

**SD-33a — Wire `incrementRoundtrip()`**
- Call site: inside `CommandDispatcher.handle()` success path, after a command result is returned to the bridge.
- Operational use: confirms extension is alive and processing. Zero after agent activity → extension is stuck.
- Discriminator: after wiring, `roundtripCount1h` reads non-zero after dispatching one extension command in the Swift test.

**SD-33b — Wire `incrementTimeout()`**
- Call site: the command deadline expiry branch in `ExtensionBridge.swift` or `CommandDispatcher.swift` where a command is aborted past its deadline.
- Operational use: non-zero = commands are timing out; diagnose extension connectivity.
- Discriminator: after wiring, `timeoutCount1h` reads non-zero after forcing a command timeout in the Swift test.

**SD-33c — Investigate `incrementUncertain()` before deciding**
- No current production uncertain path verified by grep across `daemon/Sources/`. Phase 1 investigation required: determine whether an uncertain state is reachable in the current storage-bus IPC flow.
- If a production path exists → wire it (same rubric as SD-33a/b).
- If no production path exists → delete the method, backing array, accessor, and test (deletion-only precedent, no reviewer).
- Do not wire to an invented call site. Do not leave it dead.

**SD-33d — Wire `incrementForceReload()`**
- Call site: inside the `forceReloadExtension()` recovery flow in `ExtensionBridge.swift`.
- Operational use: tracks extension instability; a rising `forceReloadCount24h` identifies systemic recovery loops.
- Discriminator: after wiring, `forceReloadCount24h` reads non-zero after calling `forceReloadExtension()` in the Swift test.

### Tracker updates

- Add SD-33a, SD-33b, SD-33c, SD-33d as separate open items in `docs/TRACKER.md`
- Move SD-33 parent entry to Resolved: "decision: wire SD-33a/b/d; investigate SD-33c"

---

## Summary of Decisions

| Item | Decision | Status |
|------|----------|--------|
| SD-30 | Deferred indefinitely. Extension risks accepted. | Close |
| T59 | Ship — frontmost-tab query + handler-level policy, hard throw, anchored seed list, operator-configurable | Implement |
| SD-33 | Wire SD-33a/b/d; investigate SD-33c | Schedule (4 sub-items) |
