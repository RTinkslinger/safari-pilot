# Safari Pilot v0.1.34 CSP / Trusted-Types Bypass — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the executing-plans skill to implement this plan task-by-task. Supports two modes: subagent-driven (recommended, fresh subagent per task with three-stage review) or inline execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make existing safari-pilot tools work on strict-CSP / Trusted-Types pages (Google Flights, Apple Shop, X.com) by duplicating the `new Function(params.script)` dispatcher into ISOLATED-world (CSP-exempt per W3C spec) and routing by per-tab `cspMode`. Add 3 new capability tools for ergonomic page-info reads, a TT policy as defense-in-depth, observability for CSP failures, and a rollback feature flag.

**Architecture:** v0.1.33 routes every tool's JS string through `new Function` in MAIN world (content-main.js:714) — page CSP blocks this on strict-CSP sites. v0.1.34 duplicates the dispatcher into content-isolated.js. A new `cspMode` field per tab (detected via probe on `webNavigation.onCompleted`) decides which world executes: `'open'` keeps the v0.1.33 MAIN path identical, `'tt-strict'` / `'eval-blocked'` / `'hard-block'` route ISOLATED. Three new capability tools (`safari_get_page_info`, `safari_get_meta_tags`, `safari_extract_text_window`) cover the trivial-read patterns observed in v0.1.33 CSP-blocked traces.

**Tech Stack:** TypeScript 5 (MCP server, tools, security layers), JavaScript MV3 (Safari Web Extension), Swift (daemon — no changes this sprint), Node ≥20, vitest, macOS-only.

---

## Spec References

- Spec: `docs/upp/specs/2026-05-13-safari-pilot-v0134-csp-bypass.md`
- Synthesis: `docs/upp/research/2026-05-13-safari-csp-bypass-synthesis.md`
- Choke point: `extension/content-main.js:714` (`new _Function(params.script)`)
- v0.1.33 bench results for comparison: `/tmp/wv-inline-runs/scoreboard.json` + per-task `score.json` files

---

## File Structure

| File | Action | Purpose |
|---|---|---|
| `test/fixtures/csp-trusted-types.ts` | CREATE | HTTP fixture serving `Content-Security-Policy: require-trusted-types-for 'script'` |
| `test/fixtures/csp-trusted-types-allowlist.ts` | CREATE | Fixture with `trusted-types google#safe` policy-name allowlist |
| `test/fixtures/csp-script-src-no-eval.ts` | CREATE | Fixture with `script-src 'self'` (no `unsafe-eval`, no `trusted-types-eval`) |
| `extension/content-isolated.js` | MODIFY | Add `execute_script` handler that runs `new Function(script)` in ISOLATED world. Add CSP detection probe handler. |
| `extension/content-main.js` | MODIFY | Add TT policy registration at top. Modify `execute_script` case to skip MAIN execution when `cspMode !== 'open'`. |
| `extension/background.js` | MODIFY | On `webNavigation.onCompleted`, send CSP detection probe and store result on tab metadata. Read rollback feature flag from storage. |
| `src/security/csp-mode.ts` | CREATE | `CspMode` type + tab→mode map + helpers |
| `src/tools/extraction.ts` | MODIFY | Add `safari_get_page_info`, `safari_get_meta_tags`, `safari_extract_text_window` handlers + definitions |
| `src/errors.ts` | MODIFY | Add `CSP_BLOCKED` and `CSP_HARD_BLOCK` error codes + metadata |
| `src/server.ts` | MODIFY | When `safari_evaluate` (or any MAIN-world-required tool) fails with CSP, format as CSP_BLOCKED with structured hint |
| `safari-pilot.config.json` | MODIFY | Add `cspBypass.legacyMainWorld` field (default false) |
| `src/cli/stats.ts` | MODIFY | Aggregate counts for new error codes |
| `bench/webvoyager/run-one-task.sh` | CREATE | Promote `/tmp/run-one-task.sh` with mktemp + perl-alarm cleanup fixes |
| `test/e2e/csp-isolated-verify.test.ts` | CREATE | Slice 1 RED — empirical verification of ISOLATED-world new Function on TT-strict |
| `test/e2e/csp-detection.test.ts` | CREATE | Verify cspMode classification across all 4 fixtures |
| `test/e2e/csp-apple-shop.test.ts` | CREATE | Slice 1 GREEN — Apple--41-style task on TT-strict fixture |
| `test/e2e/csp-google-flights.test.ts` | CREATE | Slice 2 GREEN — Google Flights--34-style task with policy-allowlist fixture |
| `test/e2e/csp-xcom-login.test.ts` | CREATE | Slice 3 GREEN — X.com login-style task on script-src-no-eval fixture |
| `test/e2e/csp-legacy-flag.test.ts` | CREATE | Verify legacy-main-world feature flag reverts behavior |
| `test/unit/tools/page-info.test.ts` | CREATE | Unit tests for safari_get_page_info |
| `test/unit/tools/meta-tags.test.ts` | CREATE | Unit tests for safari_get_meta_tags |
| `test/unit/tools/extract-text-window.test.ts` | CREATE | Unit tests for safari_extract_text_window |
| `test/unit/security/csp-mode.test.ts` | CREATE | Unit tests for cspMode helpers |
| `test/unit/cli/stats-csp-codes.test.ts` | CREATE | Unit tests for stats CLI counting new codes |
| `test/unit/errors-csp.test.ts` | CREATE | Unit tests for CSP_BLOCKED / CSP_HARD_BLOCK error shapes |
| `CHANGELOG.md` | MODIFY | Add v0.1.34 entry |
| `package.json` | MODIFY | Bump to 0.1.34 (lockstep with manifest) |
| `extension/manifest.json` | MODIFY | Bump to 0.1.34 |
| `ARCHITECTURE.md` | MODIFY | Add cspMode + ISOLATED-world routing section |
| `TRACES.md` | MODIFY | Add iter 80 entry |

---

## Tasks

### Task 1: Create TT-strict fixture + Slice 1 verification RED

**Files:**
- Create: `test/fixtures/csp-trusted-types.ts`
- Create: `test/e2e/csp-isolated-verify.test.ts`

This task's RED test is the **single gate** that decides whether the architectural pivot succeeds or we fall back to Section 8 of the spec. Run early. Result determines the rest of the sprint.

- [ ] **Step 1: Create the fixture**

```typescript
// test/fixtures/csp-trusted-types.ts
import { createServer, Server } from 'node:http';

export function startTrustedTypesFixture(port = 0): { server: Server; url: () => string } {
  const page = `<!DOCTYPE html><html><head>
<meta charset="utf-8"><title>TT-strict fixture</title>
<meta name="description" content="Trusted Types strict fixture">
</head><body>
<h1 id="hero">TT-strict fixture body</h1>
<p id="lede">This page enforces require-trusted-types-for 'script'.</p>
<button id="btn-action" type="button">Action</button>
<input id="input-name" type="text" placeholder="Your name">
<div id="shadow-host"></div>
</body></html>`;
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "require-trusted-types-for 'script'",
    });
    res.end(page);
  });
  server.listen(port);
  return {
    server,
    url: () => {
      const addr = server.address();
      if (typeof addr === 'string' || addr === null) throw new Error('no addr');
      return `http://127.0.0.1:${addr.port}/`;
    },
  };
}
```

- [ ] **Step 2: Write the failing verification test**

```typescript
// test/e2e/csp-isolated-verify.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTrustedTypesFixture } from '../fixtures/csp-trusted-types.js';
import { McpTestClient } from '../helpers/mcp-client.js';

describe('CSP isolated-world verification (gate for the sprint)', () => {
  let fx: ReturnType<typeof startTrustedTypesFixture>;
  let client: McpTestClient;
  let fixtureUrl: string;
  let tabUrl: string;

  beforeAll(async () => {
    fx = startTrustedTypesFixture();
    fixtureUrl = fx.url();
    client = await McpTestClient.spawn();
    const openRes = await client.callTool('safari_new_tab', { url: fixtureUrl });
    tabUrl = (openRes.content[0] as { text: string }).text.match(/tabUrl":"([^"]+)/)?.[1] ?? fixtureUrl;
  });

  afterAll(async () => {
    await client?.callTool('safari_close_tab', { tabUrl }).catch(() => {});
    await client?.shutdown();
    fx?.server.close();
  });

  it('ISOLATED-world new Function bypasses page Trusted Types', async () => {
    // This test asserts the W3C-cited claim. If it FAILS, the entire sprint
    // architecture is invalid → fall back to Section 8 multi-tool refactor.
    // We can't call ISOLATED directly from the MCP tool surface yet (that's
    // what this sprint builds), so this is a stub assertion documenting the
    // experiment that Task 2 enables. In Task 2, we add a __SP_CSP_VERIFY__
    // sentinel that runs in ISOLATED and returns whether new Function worked.
    expect(true).toBe(true); // Real assertion enabled in Task 2 — see step 4.
  });

  it('MAIN-world new Function is blocked on this fixture (regression check)', async () => {
    // Today: safari_evaluate goes to MAIN. Must fail on TT-strict.
    const result = await client.callTool('safari_evaluate', {
      tabUrl, script: 'return 1+1',
    }).catch((e: Error) => ({ error: e.message }));
    if ('error' in result) {
      expect(result.error).toMatch(/Trusted Type|trusted-types-eval|unsafe-eval/i);
    } else {
      throw new Error('safari_evaluate unexpectedly SUCCEEDED on TT-strict fixture — fixture broken?');
    }
  });
});
```

- [ ] **Step 3: Run the failing test**

Run: `npx vitest run test/e2e/csp-isolated-verify.test.ts`
Expected:
- First test (`ISOLATED-world new Function...`): PASS (stub).
- Second test (`MAIN-world new Function...`): PASS (confirms fixture serves CSP correctly and v0.1.33 behavior matches).

If second test FAILS (no CSP error returned from safari_evaluate), the fixture isn't serving the CSP header correctly. Inspect `curl -i http://127.0.0.1:<port>/` for the `Content-Security-Policy` header. Fix fixture before continuing.

- [ ] **Step 4: Commit**

```bash
git add test/fixtures/csp-trusted-types.ts test/e2e/csp-isolated-verify.test.ts
git commit -m "test(fixtures+e2e): TT-strict CSP fixture + v0.1.33 baseline assertion"
```

---

### Task 2: ISOLATED-world execute_script handler + Slice 1 verification GREEN

**Files:**
- Modify: `extension/content-isolated.js:180` (insert new sentinel handler before file_upload sentinels)
- Modify: `test/e2e/csp-isolated-verify.test.ts:31` (replace stub with real assertion)

- [ ] **Step 1: Add the `__SP_CSP_VERIFY__` and `__SP_EXECUTE_ISOLATED__` sentinels**

In `extension/content-isolated.js`, after the existing file_upload sentinel block (around line 178), insert:

```javascript
    // v0.1.34 CSP-VERIFY sentinel — Slice 1 RED test. Runs `new Function`
    // inside the ISOLATED world to empirically verify the W3C-cited claim
    // that isolated-world content scripts are exempt from page Trusted Types.
    if (cmd.method === 'execute_script' && typeof cmd.params?.script === 'string'
        && cmd.params.script === '__SP_CSP_VERIFY__') {
      const probe = (() => {
        try {
          // eslint-disable-next-line no-new-func
          const fn = new Function('return 42;');
          return { ok: true, value: fn(), world: 'isolated' };
        } catch (e) {
          return { ok: false, error: String(e?.message || e), world: 'isolated' };
        }
      })();
      browser.storage.local.set({
        [makeSpResultKey(cmd.commandId)]: {
          commandId: cmd.commandId, result: { ok: true, value: probe }, timestamp: Date.now(),
        },
      }).catch(() => {});
      return;
    }

    // v0.1.34 CSP-BYPASS sentinel — runs an arbitrary JS string in the
    // ISOLATED world. Used by content-isolated.js's own dispatcher when the
    // tab's cspMode is not 'open'. The string is wrapped in a `new Function`
    // body, identical to content-main.js:714 but in this CSP-exempt context.
    // Page-context globals are NOT visible from here — agents whose scripts
    // reference window.someApp.state will get undefined.
    if (cmd.method === 'execute_script' && typeof cmd.params?.script === 'string'
        && cmd.params.script.startsWith('__SP_EXECUTE_ISOLATED__:')) {
      const userScript = cmd.params.script.slice('__SP_EXECUTE_ISOLATED__:'.length);
      let result;
      try {
        // eslint-disable-next-line no-new-func
        const fn = new Function(userScript);
        const value = fn();
        result = { ok: true, value: value === undefined ? null : value };
      } catch (e) {
        result = { ok: false, error: { code: 'EXECUTE_ISOLATED_FAILED', message: String(e?.message || e) } };
      }
      browser.storage.local.set({
        [makeSpResultKey(cmd.commandId)]: { commandId: cmd.commandId, result, timestamp: Date.now() },
      }).catch(() => {});
      return;
    }
```

- [ ] **Step 2: Rebuild the extension and reload**

```bash
bash scripts/build-extension.sh
open "bin/Safari Pilot.app"
# Then in Safari: Settings > Extensions, ensure Safari Pilot is on
```

Verify in `~/.safari-pilot/daemon.log` that the extension reconnected. The reload picks up the new sentinels.

- [ ] **Step 3: Replace the stub assertion with the real test**

Edit `test/e2e/csp-isolated-verify.test.ts` line 31 (the first `it(...)` block):

```typescript
  it('ISOLATED-world new Function bypasses page Trusted Types', async () => {
    const result = await client.callTool('safari_evaluate', {
      tabUrl, script: '__SP_CSP_VERIFY__',
    });
    const text = (result.content[0] as { text: string }).text;
    // The sentinel reports back its world + outcome via the standard result wrapper.
    expect(text).toMatch(/"world":"isolated"/);
    expect(text).toMatch(/"ok":true/);
    expect(text).toMatch(/"value":42/);
  });
```

- [ ] **Step 4: Run and verify**

Run: `npx vitest run test/e2e/csp-isolated-verify.test.ts`
Expected:
- ✓ ISOLATED-world new Function bypasses page Trusted Types (the W3C claim is verified empirically — proceed)
- ✓ MAIN-world new Function is blocked on this fixture

If the ISOLATED test FAILS with a Trusted Types error: **STOP**. Open `docs/upp/specs/2026-05-13-safari-pilot-v0134-csp-bypass.md` Section 8 and pivot the sprint to the fallback multi-tool refactor.

- [ ] **Step 5: Commit**

```bash
git add extension/content-isolated.js test/e2e/csp-isolated-verify.test.ts
git commit -m "feat(ext): __SP_CSP_VERIFY__ + __SP_EXECUTE_ISOLATED__ sentinels (Slice 1 RED → GREEN)"
```

---

### Task 3: cspMode state + detection probe

**Files:**
- Create: `src/security/csp-mode.ts`
- Create: `test/unit/security/csp-mode.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/security/csp-mode.test.ts
import { describe, it, expect } from 'vitest';
import { classifyCspProbe, type CspProbeResult, type CspMode } from '../../../src/security/csp-mode.js';

describe('classifyCspProbe', () => {
  it('returns open when all probes succeed', () => {
    const probe: CspProbeResult = { evalOk: true, fnOk: true, ttPolicyCreated: true, ttPolicyNameRejected: false };
    expect(classifyCspProbe(probe)).toBe<CspMode>('open');
  });
  it('returns tt-strict when TT API exists and policy created but eval-via-string blocked', () => {
    const probe: CspProbeResult = { evalOk: false, fnOk: false, ttPolicyCreated: true, ttPolicyNameRejected: false };
    expect(classifyCspProbe(probe)).toBe<CspMode>('tt-strict');
  });
  it('returns eval-blocked when script-src lacks unsafe-eval, no TT enforcement', () => {
    const probe: CspProbeResult = { evalOk: false, fnOk: false, ttPolicyCreated: false, ttPolicyNameRejected: false };
    expect(classifyCspProbe(probe)).toBe<CspMode>('eval-blocked');
  });
  it('returns hard-block when TT policy name is rejected by trusted-types allowlist', () => {
    const probe: CspProbeResult = { evalOk: false, fnOk: false, ttPolicyCreated: false, ttPolicyNameRejected: true };
    expect(classifyCspProbe(probe)).toBe<CspMode>('hard-block');
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run test/unit/security/csp-mode.test.ts`
Expected: FAIL with "Cannot find module '.../csp-mode.js'"

- [ ] **Step 3: Implement**

```typescript
// src/security/csp-mode.ts
/**
 * Per-tab CSP mode classification for v0.1.34 CSP bypass.
 *
 * - 'open'        — page CSP permissive or unset; MAIN-world execution works (v0.1.33 default).
 * - 'tt-strict'   — page sets require-trusted-types-for 'script'. ISOLATED-world routing.
 * - 'eval-blocked'— page's script-src lacks unsafe-eval & trusted-types-eval. ISOLATED-world routing.
 * - 'hard-block'  — page sets trusted-types <allowlist> that rejects our policy name. No MAIN, ISOLATED routing
 *                   succeeds for executes but Layer 3 policy registration failed.
 */
export type CspMode = 'open' | 'tt-strict' | 'eval-blocked' | 'hard-block';

export interface CspProbeResult {
  evalOk: boolean;            // direct `eval('1')` succeeds in MAIN
  fnOk: boolean;              // `new Function('return 1')()` succeeds in MAIN
  ttPolicyCreated: boolean;   // `trustedTypes.createPolicy('safari-pilot', {...})` succeeded
  ttPolicyNameRejected: boolean; // policy creation threw TypeError (allowlist excludes us)
}

export function classifyCspProbe(p: CspProbeResult): CspMode {
  if (p.ttPolicyNameRejected) return 'hard-block';
  if (p.evalOk && p.fnOk) return 'open';
  if (p.ttPolicyCreated) return 'tt-strict';
  return 'eval-blocked';
}

const tabCspMode = new Map<string, CspMode>();

/** Record cspMode for a tab. Called by background.js → daemon → TS bridge on probe completion. */
export function setCspMode(tabUrl: string, mode: CspMode): void {
  tabCspMode.set(tabUrl, mode);
}

/** Read cspMode for a tab. Defaults to 'open' (v0.1.33-identical) if unknown. */
export function getCspMode(tabUrl: string): CspMode {
  return tabCspMode.get(tabUrl) ?? 'open';
}

/** Clear cspMode (called when tab is closed). */
export function clearCspMode(tabUrl: string): void {
  tabCspMode.delete(tabUrl);
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `npx vitest run test/unit/security/csp-mode.test.ts`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/security/csp-mode.ts test/unit/security/csp-mode.test.ts
git commit -m "feat(security): cspMode classification + per-tab state (v0.1.34 Task 3)"
```

---

### Task 4: CSP detection probe sentinel in content-isolated.js

**Files:**
- Modify: `extension/content-isolated.js` (add `__SP_CSP_PROBE__` sentinel above existing file_upload sentinels)
- Modify: `extension/background.js` (call probe on `webNavigation.onCompleted`)

- [ ] **Step 1: Add the probe sentinel to content-isolated.js**

Insert after the `__SP_EXECUTE_ISOLATED__` block from Task 2:

```javascript
    // v0.1.34 CSP probe — runs three sub-checks in the page and reports the
    // raw outcomes. Classification (open/tt-strict/eval-blocked/hard-block)
    // happens TypeScript-side in src/security/csp-mode.ts::classifyCspProbe.
    // The probe is sent automatically on webNavigation.onCompleted (background.js).
    if (cmd.method === 'execute_script' && typeof cmd.params?.script === 'string'
        && cmd.params.script === '__SP_CSP_PROBE__') {
      // Probe must run in MAIN world (the page's world) to actually test page CSP.
      // We postMessage to MAIN and wait for the response — same pattern as the
      // existing SAFARI_PILOT_CMD bridge below.
      const requestId = `sp_probe_${++nextRequestId}_${Date.now()}`;
      const timer = setTimeout(() => {
        const fallback = { evalOk: false, fnOk: false, ttPolicyCreated: false, ttPolicyNameRejected: false };
        browser.storage.local.set({
          [makeSpResultKey(cmd.commandId)]: {
            commandId: cmd.commandId, result: { ok: true, value: fallback }, timestamp: Date.now(),
          },
        }).catch(() => {});
      }, 2000);
      const onMsg = (ev) => {
        if (ev.data?.type === 'SAFARI_PILOT_PROBE_RESULT' && ev.data.requestId === requestId) {
          clearTimeout(timer);
          window.removeEventListener('message', onMsg);
          browser.storage.local.set({
            [makeSpResultKey(cmd.commandId)]: {
              commandId: cmd.commandId, result: { ok: true, value: ev.data.value }, timestamp: Date.now(),
            },
          }).catch(() => {});
        }
      };
      window.addEventListener('message', onMsg);
      window.postMessage({ type: 'SAFARI_PILOT_PROBE_RUN', requestId }, window.location.origin);
      return;
    }
```

- [ ] **Step 2: Add the MAIN-world half of the probe in content-main.js**

Insert near the top of content-main.js, in the postMessage listener block (search for `case '__SP_SCROLL_TO_ELEMENT__'` or similar sentinel intercepts and add alongside):

```javascript
      if (ev.data?.type === 'SAFARI_PILOT_PROBE_RUN') {
        const requestId = ev.data.requestId;
        const result = { evalOk: false, fnOk: false, ttPolicyCreated: false, ttPolicyNameRejected: false };
        try { eval('1'); result.evalOk = true; } catch (e) { /* blocked */ }
        try { new Function('return 1')(); result.fnOk = true; } catch (e) { /* blocked */ }
        try {
          if (window.trustedTypes && typeof window.trustedTypes.createPolicy === 'function') {
            window.trustedTypes.createPolicy('safari-pilot-probe-' + requestId, {
              createScript: (s) => s, createHTML: (s) => s, createScriptURL: (s) => s,
            });
            result.ttPolicyCreated = true;
          }
        } catch (e) {
          if (String(e?.message || e).toLowerCase().includes('policy')) {
            result.ttPolicyNameRejected = true;
          }
        }
        window.postMessage({ type: 'SAFARI_PILOT_PROBE_RESULT', requestId, value: result }, window.location.origin);
        return;
      }
```

- [ ] **Step 3: Hook the probe into background.js webNavigation.onCompleted**

In `extension/background.js`, find the existing `webNavigation` listener (or add one if absent). After tab info is captured:

```javascript
  browser.webNavigation.onCompleted.addListener(async (details) => {
    if (details.frameId !== 0) return;  // only top frame
    // Wait 200ms for content scripts to settle, then probe.
    await new Promise((r) => setTimeout(r, 200));
    const probeCmdId = `csp_probe_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await browser.storage.local.set({
      [`sp_cmd_${probeCmdId}`]: {
        commandId: probeCmdId,
        method: 'execute_script',
        params: { script: '__SP_CSP_PROBE__' },
        timestamp: Date.now(),
        deadline: Date.now() + 3000,
        tabId: details.tabId,
      },
    });
    // Poll for result key.
    const startedAt = Date.now();
    while (Date.now() - startedAt < 3000) {
      const r = await browser.storage.local.get([`sp_result_${probeCmdId}`]);
      const res = r[`sp_result_${probeCmdId}`];
      if (res?.result?.value) {
        // Post to daemon so TS-side csp-mode.ts can record it.
        try {
          await fetch('http://127.0.0.1:19475/csp-mode', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tabUrl: details.url, probe: res.result.value }),
          });
        } catch (_) { /* daemon may be down — non-fatal */ }
        await browser.storage.local.remove([`sp_result_${probeCmdId}`, `sp_cmd_${probeCmdId}`]);
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    // Probe timed out; default cspMode stays 'open' (safe default).
  });
```

- [ ] **Step 4: Rebuild + reload extension**

```bash
bash scripts/build-extension.sh
open "bin/Safari Pilot.app"
```

- [ ] **Step 5: Manual smoke test**

Open Safari, navigate to `http://127.0.0.1:<your test port>/` running the TT fixture from Task 1.
Check `~/.safari-pilot/daemon.log` for an entry like `POST /csp-mode` from extension. Verify the body contains `"probe":{"evalOk":false,"fnOk":false,...}`.

(The `/csp-mode` daemon route doesn't exist yet — that's Task 5. For now, smoke-confirm the extension POSTs SOMETHING; the daemon will 404 and that's fine.)

- [ ] **Step 6: Commit**

```bash
git add extension/content-isolated.js extension/content-main.js extension/background.js
git commit -m "feat(ext): CSP probe sentinel + webNavigation.onCompleted hook (Task 4)"
```

---

### Task 5: Daemon `/csp-mode` HTTP route + TS bridge

**Files:**
- Modify: `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift` (add route)
- Modify: `src/server.ts` or new file `src/security/csp-mode-bridge.ts` (consume POSTs into csp-mode.ts state)

- [ ] **Step 1: Add the daemon route**

In `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift`, find the route table (search for `router.post` or `app.post`). Add:

```swift
        router.post("/csp-mode") { request, _ -> HTTPResponse.Status in
            // Body: { "tabUrl": "...", "probe": { evalOk, fnOk, ttPolicyCreated, ttPolicyNameRejected } }
            // Forward verbatim onto the daemon's internal command channel so the
            // MCP server's TS bridge picks it up.
            if let bodyData = try? await request.body.collect(upTo: 8192) {
                let payload = String(buffer: bodyData) ?? "{}"
                logger.debug("csp-mode probe received: \(payload)")
                // Push to the in-memory broadcast for the MCP server (via stdio JSON).
                await CommandDispatcher.shared.broadcastCspMode(payload)
            }
            return .ok
        }
```

- [ ] **Step 2: Add the broadcastCspMode method**

In `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift` (or wherever the dispatcher lives), add:

```swift
    /// Forwarded from the extension's CSP probe. Writes a "csp-mode" event
    /// onto stdout so the TS MCP server can pick it up via its existing
    /// NDJSON stdout reader.
    func broadcastCspMode(_ payload: String) {
        let event = #"{"event":"csp-mode","data":"# + payload + "}"
        FileHandle.standardOutput.write(Data((event + "\n").utf8))
    }
```

- [ ] **Step 3: Write the TS-side test**

```typescript
// test/unit/security/csp-mode-bridge.test.ts
import { describe, it, expect } from 'vitest';
import { setCspMode, getCspMode } from '../../../src/security/csp-mode.js';
import { handleCspModeEvent } from '../../../src/security/csp-mode-bridge.js';

describe('handleCspModeEvent', () => {
  it('classifies and stores cspMode from raw probe data', () => {
    handleCspModeEvent({
      tabUrl: 'https://flights.google.com/',
      probe: { evalOk: false, fnOk: false, ttPolicyCreated: true, ttPolicyNameRejected: false },
    });
    expect(getCspMode('https://flights.google.com/')).toBe('tt-strict');
  });
  it('classifies hard-block when policy name rejected', () => {
    handleCspModeEvent({
      tabUrl: 'https://example-google-allowlist/',
      probe: { evalOk: false, fnOk: false, ttPolicyCreated: false, ttPolicyNameRejected: true },
    });
    expect(getCspMode('https://example-google-allowlist/')).toBe('hard-block');
  });
});
```

- [ ] **Step 4: Implement the bridge**

```typescript
// src/security/csp-mode-bridge.ts
import { classifyCspProbe, setCspMode, type CspProbeResult } from './csp-mode.js';

export interface CspModeEvent {
  tabUrl: string;
  probe: CspProbeResult;
}

export function handleCspModeEvent(ev: CspModeEvent): void {
  if (!ev.tabUrl || !ev.probe) return;
  const mode = classifyCspProbe(ev.probe);
  setCspMode(ev.tabUrl, mode);
}
```

- [ ] **Step 5: Wire into the daemon's stdout reader**

In `src/engines/daemon.ts`, find the NDJSON line handler (search for `JSON.parse` near stdout reading). Add a branch:

```typescript
      if (parsed.event === 'csp-mode' && parsed.data) {
        // Late import to avoid circular dep
        const { handleCspModeEvent } = await import('../security/csp-mode-bridge.js');
        handleCspModeEvent(parsed.data);
        continue;
      }
```

- [ ] **Step 6: Build daemon + rebuild MCP**

```bash
bash scripts/update-daemon.sh
npm run build
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run test/unit/security/csp-mode-bridge.test.ts`
Expected: 2 tests pass.

- [ ] **Step 8: Commit**

```bash
git add daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift daemon/Sources/SafariPilotdCore/CommandDispatcher.swift src/security/csp-mode-bridge.ts src/engines/daemon.ts test/unit/security/csp-mode-bridge.test.ts
git commit -m "feat(daemon+ts): /csp-mode HTTP route + TS bridge (Task 5)"
```

---

### Task 6: Route execute_script via ISOLATED when cspMode !== 'open'

**Files:**
- Modify: `src/engines/extension.ts` (in `executeJsInTab`, prepend script with sentinel if cspMode != open)
- Create: `test/unit/engines/extension-csp-routing.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/engines/extension-csp-routing.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { setCspMode } from '../../../src/security/csp-mode.js';
import { buildExecuteScriptPayload } from '../../../src/engines/extension.js';

describe('extension engine — CSP routing', () => {
  beforeEach(() => {
    // Reset state by setting to 'open' before each test (effectively clearing).
    setCspMode('https://safe.example.com/', 'open');
    setCspMode('https://tt-strict.example.com/', 'tt-strict');
    setCspMode('https://allowlist.example.com/', 'hard-block');
  });

  it('passes script verbatim when cspMode is open', () => {
    expect(buildExecuteScriptPayload('https://safe.example.com/', 'return document.title')).toEqual({
      script: 'return document.title', routing: 'main',
    });
  });
  it('wraps script with __SP_EXECUTE_ISOLATED__ when cspMode is tt-strict', () => {
    expect(buildExecuteScriptPayload('https://tt-strict.example.com/', 'return document.title')).toEqual({
      script: '__SP_EXECUTE_ISOLATED__:return document.title', routing: 'isolated',
    });
  });
  it('passes verbatim sentinels (__SP_*) through unmodified regardless of cspMode', () => {
    expect(buildExecuteScriptPayload('https://tt-strict.example.com/', '__SP_TAKE_SCREENSHOT__'))
      .toEqual({ script: '__SP_TAKE_SCREENSHOT__', routing: 'sentinel' });
  });
  it('wraps script with __SP_EXECUTE_ISOLATED__ when cspMode is hard-block', () => {
    expect(buildExecuteScriptPayload('https://allowlist.example.com/', 'return 1'))
      .toEqual({ script: '__SP_EXECUTE_ISOLATED__:return 1', routing: 'isolated' });
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run test/unit/engines/extension-csp-routing.test.ts`
Expected: FAIL with "Cannot find export buildExecuteScriptPayload".

- [ ] **Step 3: Implement the helper**

In `src/engines/extension.ts`, add a new exported function (used internally by `executeJsInTab`):

```typescript
import { getCspMode } from '../security/csp-mode.js';

export type ExecuteRouting = 'main' | 'isolated' | 'sentinel';

export function buildExecuteScriptPayload(
  tabUrl: string, script: string,
): { script: string; routing: ExecuteRouting } {
  // Sentinels (pre-bundled handlers) ALWAYS pass through unchanged — they
  // don't go through new Function on either side.
  if (script.startsWith('__SP_') && !script.startsWith('__SP_EXECUTE_ISOLATED__:')) {
    return { script, routing: 'sentinel' };
  }
  const mode = getCspMode(tabUrl);
  if (mode === 'open') return { script, routing: 'main' };
  return { script: `__SP_EXECUTE_ISOLATED__:${script}`, routing: 'isolated' };
}
```

Modify the existing `executeJsInTab` body (search for where script is sent to extension via storage / postMessage). Wrap the script:

```typescript
  async executeJsInTab(tabUrl: string, script: string, timeoutMs?: number): Promise<EngineResult> {
    const payload = buildExecuteScriptPayload(tabUrl, script);
    // ...existing code, but use payload.script instead of raw `script`
  }
```

- [ ] **Step 4: Run, verify tests pass**

Run: `npx vitest run test/unit/engines/extension-csp-routing.test.ts`
Expected: 4 tests pass.

Also run the full unit suite to verify no regression:

```bash
npm run test:unit
```

Expected: all tests pass (669+ existing).

- [ ] **Step 5: Commit**

```bash
git add src/engines/extension.ts test/unit/engines/extension-csp-routing.test.ts
git commit -m "feat(engine): route execute_script via ISOLATED when cspMode != open (Task 6)"
```

---

### Task 7: CSP_BLOCKED + CSP_HARD_BLOCK error codes + tool-suggesting hint

**Files:**
- Modify: `src/errors.ts` (add codes + metadata)
- Modify: `src/server.ts` (intercept CSP failures and reformat with hint)
- Create: `test/unit/errors-csp.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/errors-csp.test.ts
import { describe, it, expect } from 'vitest';
import { ERROR_CODES, ERROR_METADATA, formatCspBlockedError } from '../../src/errors.js';

describe('CSP error codes', () => {
  it('CSP_BLOCKED is registered', () => {
    expect(ERROR_CODES.CSP_BLOCKED).toBe('CSP_BLOCKED');
    expect(ERROR_METADATA.CSP_BLOCKED?.retryable).toBe(false);
  });
  it('CSP_HARD_BLOCK is registered', () => {
    expect(ERROR_CODES.CSP_HARD_BLOCK).toBe('CSP_HARD_BLOCK');
    expect(ERROR_METADATA.CSP_HARD_BLOCK?.retryable).toBe(false);
  });
  it('formatCspBlockedError returns structured hint with alternative tools', () => {
    const e = formatCspBlockedError('tt-strict', 'Refused to evaluate ...');
    expect(e.code).toBe('CSP_BLOCKED');
    expect(e.message).toMatch(/safari_evaluate is unavailable/);
    expect(e.hints).toContain('safari_get_page_info');
    expect(e.hints).toContain('safari_get_meta_tags');
    expect(e.hints).toContain('safari_extract_text_window');
    expect(e.hints).toContain('safari_click');
    expect(e.hints).toContain('safari_fill');
    expect(e.hints).toContain('safari_snapshot');
  });
  it('formatCspBlockedError returns CSP_HARD_BLOCK for hard-block mode', () => {
    const e = formatCspBlockedError('hard-block', 'TT policy name rejected');
    expect(e.code).toBe('CSP_HARD_BLOCK');
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run test/unit/errors-csp.test.ts`
Expected: FAIL ("Cannot find export").

- [ ] **Step 3: Implement**

In `src/errors.ts`, add inside the `ERROR_CODES` object:

```typescript
  CSP_BLOCKED: 'CSP_BLOCKED',
  CSP_HARD_BLOCK: 'CSP_HARD_BLOCK',
```

In `ERROR_METADATA`:

```typescript
  CSP_BLOCKED: {
    retryable: false,
    hints: [
      'safari_get_page_info', 'safari_get_meta_tags', 'safari_extract_text_window',
      'safari_click', 'safari_fill', 'safari_snapshot',
    ],
  },
  CSP_HARD_BLOCK: {
    retryable: false,
    hints: [
      'safari_get_page_info', 'safari_get_meta_tags', 'safari_extract_text_window',
      'safari_click', 'safari_fill', 'safari_snapshot',
    ],
  },
```

Add the helper at the bottom of the file:

```typescript
import type { CspMode } from './security/csp-mode.js';

export function formatCspBlockedError(mode: CspMode, originalMessage: string): {
  code: 'CSP_BLOCKED' | 'CSP_HARD_BLOCK';
  message: string;
  hints: string[];
  rationale: string;
} {
  const code = mode === 'hard-block' ? 'CSP_HARD_BLOCK' : 'CSP_BLOCKED';
  const message =
    `This page enforces CSP (${mode}). safari_evaluate is unavailable here ` +
    `because ISOLATED-world execution either failed (page-context globals not visible) ` +
    `or the page rejected our Trusted Types policy. Original: ${originalMessage}`;
  const hints = ERROR_METADATA[code]?.hints?.slice() ?? [];
  const rationale =
    'safari_evaluate executes in ISOLATED world on CSP-strict tabs (CSP-exempt by W3C spec) ' +
    'BUT cannot read page-context globals like window.someApp.state. ' +
    'Use the named alternative tools for DOM reads and DOM interaction — ' +
    'they route through CSP-safe handlers on this tab.';
  return { code, message, hints, rationale };
}
```

- [ ] **Step 4: Wire into server.ts**

In `src/server.ts`'s `executeToolWithSecurity` (or wherever tool errors are formatted), add interception:

```typescript
  } catch (err) {
    // CSP detection: classify error message + tab's cspMode
    const message = err instanceof Error ? err.message : String(err);
    if (message.match(/Trusted Type|trusted-types-eval|unsafe-eval/i)) {
      const { getCspMode } = await import('./security/csp-mode.js');
      const { formatCspBlockedError } = await import('./errors.js');
      const tabUrl = (params as { tabUrl?: string })?.tabUrl ?? '';
      const mode = getCspMode(tabUrl);
      throw new Error(JSON.stringify(formatCspBlockedError(mode, message)));
    }
    throw err;
  }
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run test/unit/errors-csp.test.ts`
Expected: 4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/errors.ts src/server.ts test/unit/errors-csp.test.ts
git commit -m "feat(errors): CSP_BLOCKED + CSP_HARD_BLOCK codes with tool-suggesting hints (Task 7)"
```

---

### Task 8: safari_get_page_info tool

**Files:**
- Modify: `src/tools/extraction.ts` (add definition + handler)
- Create: `test/unit/tools/page-info.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/tools/page-info.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ExtractionTools } from '../../../src/tools/extraction.js';
import type { IEngine } from '../../../src/engines/engine.js';

function makeEngine(value: unknown): IEngine {
  return {
    name: 'extension' as const,
    isAvailable: async () => true,
    execute: vi.fn(),
    executeJsInTab: vi.fn(async () => ({ ok: true, value, elapsed_ms: 1 })),
    executeJsInFrame: vi.fn(async () => ({ ok: true, value, elapsed_ms: 1 })),
    shutdown: vi.fn(async () => {}),
  } as unknown as IEngine;
}

describe('safari_get_page_info', () => {
  it('returns title, url, body_snippet, meta_description from extension result', async () => {
    const engineValue = {
      title: 'Apple', url: 'https://apple.com/', body_snippet: 'Welcome to Apple...',
      meta_description: 'Discover the innovative world of Apple', meta_og_image: 'https://apple.com/og.png',
      lang: 'en-US',
    };
    const tools = new ExtractionTools(makeEngine(engineValue));
    const handler = tools.getHandler('safari_get_page_info')!;
    const res = await handler({ tabUrl: 'https://apple.com/' });
    const text = (res.content[0] as { text: string }).text;
    expect(text).toContain('Apple');
    expect(text).toContain('https://apple.com/');
    expect(text).toContain('Welcome to Apple');
    expect(text).toContain('en-US');
  });
  it('passes max_chars as snippet length', async () => {
    const tools = new ExtractionTools(makeEngine({ title: '', url: '', body_snippet: '', meta_description: '', meta_og_image: null, lang: null }));
    const handler = tools.getHandler('safari_get_page_info')!;
    await handler({ tabUrl: 'https://example.com/', max_chars: 500 });
    const engine = (tools as unknown as { engine: IEngine }).engine;
    const calls = (engine.executeJsInTab as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][1]).toContain('500');  // the JS snippet embeds max_chars
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run test/unit/tools/page-info.test.ts`
Expected: FAIL ("getHandler returned undefined" — the tool doesn't exist yet).

- [ ] **Step 3: Implement in extraction.ts**

Add the definition to `getDefinitions()` in `ExtractionTools`:

```typescript
      {
        name: 'safari_get_page_info',
        description:
          'Returns structured page info (title, URL, body text snippet, meta description, og:image, lang). ' +
          'CSP-safe: works on Trusted-Types-strict pages where safari_evaluate fails. ' +
          'Use this instead of safari_evaluate when you need basic page metadata.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string' },
            frameId: { type: 'number', description: 'Optional frame id (default: top frame).' },
            max_chars: { type: 'number', description: 'Max length of body_snippet. Default 2000.', default: 2000 },
          },
          required: ['tabUrl'],
        },
        requirements: { requiresDom: true },
      },
```

Register the handler in the constructor (look for the pattern with `this.handlers.set('safari_take_screenshot', ...)` and follow it):

```typescript
    this.handlers.set('safari_get_page_info', this.handleGetPageInfo.bind(this));
```

Add the method:

```typescript
  private async handleGetPageInfo(params: Record<string, unknown>): Promise<ToolResponse> {
    const tabUrl = params['tabUrl'] as string;
    const maxChars = typeof params['max_chars'] === 'number' ? params['max_chars'] : 2000;
    const start = Date.now();
    const js = `
      const result = {
        title: document.title || '',
        url: location.href,
        body_snippet: (document.body?.innerText || '').slice(0, ${maxChars}),
        meta_description: document.querySelector('meta[name="description"]')?.getAttribute('content') || '',
        meta_og_image: document.querySelector('meta[property="og:image"]')?.getAttribute('content') || null,
        lang: document.documentElement.getAttribute('lang') || null,
      };
      return result;
    `;
    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) {
      const err = new Error(result.error?.message ?? 'page-info read failed');
      (err as Error & { code?: string }).code = result.error?.code ?? 'CAPTURE_FAILED';
      throw err;
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result.value, null, 2) }],
      metadata: { engine: 'extension', latencyMs: Date.now() - start },
    };
  }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/unit/tools/page-info.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/extraction.ts test/unit/tools/page-info.test.ts
git commit -m "feat(tools): safari_get_page_info — CSP-safe page metadata read (Task 8)"
```

---

### Task 9: safari_get_meta_tags tool

**Files:**
- Modify: `src/tools/extraction.ts`
- Create: `test/unit/tools/meta-tags.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/tools/meta-tags.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ExtractionTools } from '../../../src/tools/extraction.js';
import type { IEngine } from '../../../src/engines/engine.js';

function makeEngine(value: unknown): IEngine {
  return {
    name: 'extension' as const, isAvailable: async () => true,
    execute: vi.fn(),
    executeJsInTab: vi.fn(async () => ({ ok: true, value, elapsed_ms: 1 })),
    executeJsInFrame: vi.fn(),
    shutdown: vi.fn(async () => {}),
  } as unknown as IEngine;
}

describe('safari_get_meta_tags', () => {
  it('returns all meta tags when no names filter is given', async () => {
    const meta = [
      { name: 'description', content: 'Welcome', attr_source: 'name' },
      { name: 'og:title', content: 'Apple', attr_source: 'property' },
    ];
    const tools = new ExtractionTools(makeEngine(meta));
    const handler = tools.getHandler('safari_get_meta_tags')!;
    const res = await handler({ tabUrl: 'https://example.com/' });
    expect((res.content[0] as { text: string }).text).toContain('description');
    expect((res.content[0] as { text: string }).text).toContain('og:title');
  });
  it('embeds names filter in the JS payload', async () => {
    const tools = new ExtractionTools(makeEngine([]));
    const handler = tools.getHandler('safari_get_meta_tags')!;
    await handler({ tabUrl: 'https://example.com/', names: ['description', 'og:title'] });
    const engine = (tools as unknown as { engine: IEngine }).engine;
    const calls = (engine.executeJsInTab as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][1]).toContain('description');
    expect(calls[0][1]).toContain('og:title');
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run test/unit/tools/meta-tags.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement in extraction.ts**

Add definition to `getDefinitions()`:

```typescript
      {
        name: 'safari_get_meta_tags',
        description:
          'Returns all <meta> tags or a filtered subset. CSP-safe. Use for og:image, twitter:card, ' +
          'description, keywords, viewport, etc. Each entry: {name, content, attr_source}.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string' },
            names: { type: 'array', items: { type: 'string' }, description: 'Whitelist of meta names. Omit = all.' },
            frameId: { type: 'number' },
          },
          required: ['tabUrl'],
        },
        requirements: { requiresDom: true },
      },
```

Register and implement:

```typescript
    this.handlers.set('safari_get_meta_tags', this.handleGetMetaTags.bind(this));

  private async handleGetMetaTags(params: Record<string, unknown>): Promise<ToolResponse> {
    const tabUrl = params['tabUrl'] as string;
    const namesArg = Array.isArray(params['names']) ? (params['names'] as string[]) : null;
    const namesJs = namesArg ? JSON.stringify(namesArg) : 'null';
    const start = Date.now();
    const js = `
      const filter = ${namesJs};
      const out = [];
      for (const m of document.querySelectorAll('meta')) {
        const name = m.getAttribute('name');
        const prop = m.getAttribute('property');
        const httpEquiv = m.getAttribute('http-equiv');
        const key = name || prop || httpEquiv;
        if (!key) continue;
        if (filter && !filter.includes(key)) continue;
        out.push({
          name: key,
          content: m.getAttribute('content') || '',
          attr_source: name ? 'name' : (prop ? 'property' : 'http-equiv'),
        });
      }
      return out;
    `;
    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) {
      const err = new Error(result.error?.message ?? 'meta-tags read failed');
      (err as Error & { code?: string }).code = result.error?.code ?? 'CAPTURE_FAILED';
      throw err;
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result.value, null, 2) }],
      metadata: { engine: 'extension', latencyMs: Date.now() - start },
    };
  }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/unit/tools/meta-tags.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/extraction.ts test/unit/tools/meta-tags.test.ts
git commit -m "feat(tools): safari_get_meta_tags — CSP-safe meta-tag enumeration (Task 9)"
```

---

### Task 10: safari_extract_text_window tool

**Files:**
- Modify: `src/tools/extraction.ts`
- Create: `test/unit/tools/extract-text-window.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/tools/extract-text-window.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ExtractionTools } from '../../../src/tools/extraction.js';
import type { IEngine } from '../../../src/engines/engine.js';

function makeEngine(value: unknown): IEngine {
  return {
    name: 'extension' as const, isAvailable: async () => true,
    execute: vi.fn(),
    executeJsInTab: vi.fn(async () => ({ ok: true, value, elapsed_ms: 1 })),
    executeJsInFrame: vi.fn(),
    shutdown: vi.fn(async () => {}),
  } as unknown as IEngine;
}

describe('safari_extract_text_window', () => {
  it('returns text capped at max_chars with truncated flag', async () => {
    const result = { text: 'lorem ipsum dolor sit amet', truncated: false, selector_matched_count: 1 };
    const tools = new ExtractionTools(makeEngine(result));
    const handler = tools.getHandler('safari_extract_text_window')!;
    const res = await handler({ tabUrl: 'https://example.com/', selector: '#main', max_chars: 5000 });
    expect((res.content[0] as { text: string }).text).toContain('lorem ipsum');
    expect((res.content[0] as { text: string }).text).toContain('selector_matched_count');
  });
  it('errors if selector arg missing', async () => {
    const tools = new ExtractionTools(makeEngine(null));
    const handler = tools.getHandler('safari_extract_text_window')!;
    await expect(handler({ tabUrl: 'https://example.com/' })).rejects.toThrow(/selector/);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run test/unit/tools/extract-text-window.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Definition:

```typescript
      {
        name: 'safari_extract_text_window',
        description:
          'Extract textContent of a selector subtree, capped at max_chars. CSP-safe. ' +
          'Returns {text, truncated, selector_matched_count}. Use for "read all body text near X".',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string' },
            selector: { type: 'string', description: 'CSS selector for the root of the subtree' },
            max_chars: { type: 'number', default: 5000 },
            frameId: { type: 'number' },
          },
          required: ['tabUrl', 'selector'],
        },
        requirements: { requiresDom: true },
      },
```

Handler:

```typescript
    this.handlers.set('safari_extract_text_window', this.handleExtractTextWindow.bind(this));

  private async handleExtractTextWindow(params: Record<string, unknown>): Promise<ToolResponse> {
    const tabUrl = params['tabUrl'] as string;
    const selector = params['selector'] as string | undefined;
    if (!selector) {
      const err = new Error('selector required');
      (err as Error & { code?: string }).code = 'INVALID_PARAMS';
      throw err;
    }
    const maxChars = typeof params['max_chars'] === 'number' ? params['max_chars'] : 5000;
    const start = Date.now();
    const selectorEscaped = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const js = `
      const els = document.querySelectorAll('${selectorEscaped}');
      let combined = '';
      for (const el of els) {
        combined += (el.textContent || '') + '\\n';
        if (combined.length > ${maxChars + 1000}) break;
      }
      const truncated = combined.length > ${maxChars};
      return { text: combined.slice(0, ${maxChars}), truncated, selector_matched_count: els.length };
    `;
    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) {
      const err = new Error(result.error?.message ?? 'extract-text-window failed');
      (err as Error & { code?: string }).code = result.error?.code ?? 'CAPTURE_FAILED';
      throw err;
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(result.value, null, 2) }],
      metadata: { engine: 'extension', latencyMs: Date.now() - start },
    };
  }
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/unit/tools/extract-text-window.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/tools/extraction.ts test/unit/tools/extract-text-window.test.ts
git commit -m "feat(tools): safari_extract_text_window — CSP-safe subtree text read (Task 10)"
```

---

### Task 11: Layer 3 — Trusted Types policy registration

**Files:**
- Modify: `extension/content-main.js` (add at top of file, before any DOM access)

- [ ] **Step 1: Add policy registration**

Insert at the very top of `extension/content-main.js`, before any existing code:

```javascript
// v0.1.34 Layer 3 — Trusted Types policy registration.
// On pages that enforce require-trusted-types-for 'script', this provides
// a same-origin policy our (legacy) MAIN-world code can route string→sink
// writes through. On pages with a trusted-types ALLOWLIST that excludes us,
// createPolicy throws — we flag __SP_TT_HARD_BLOCK so the CSP probe in
// content-isolated.js sees the failure and classifies the tab as hard-block.
(() => {
  if (typeof window.trustedTypes !== 'undefined' && typeof window.trustedTypes.createPolicy === 'function') {
    try {
      const policy = window.trustedTypes.createPolicy('safari-pilot', {
        createScript: (s) => s,
        createHTML: (s) => s,
        createScriptURL: (s) => s,
      });
      window.__SP_TT_POLICY__ = policy;
    } catch (e) {
      window.__SP_TT_HARD_BLOCK = true;
      window.__SP_TT_HARD_BLOCK_REASON = String(e && e.message ? e.message : e);
    }
  }
})();
```

- [ ] **Step 2: Rebuild + reload extension**

```bash
bash scripts/build-extension.sh
open "bin/Safari Pilot.app"
```

- [ ] **Step 3: Write Slice 2 fixture + e2e test**

```typescript
// test/fixtures/csp-trusted-types-allowlist.ts
import { createServer, Server } from 'node:http';

export function startTrustedTypesAllowlistFixture(port = 0): { server: Server; url: () => string } {
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8">
<title>TT-allowlist fixture</title>
</head><body>
<h1>TT with policy-name allowlist</h1>
<p>This page requires Trusted Types AND restricts policy names to "google#safe".</p>
</body></html>`;
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "require-trusted-types-for 'script'; trusted-types google#safe",
    });
    res.end(page);
  });
  server.listen(port);
  return {
    server,
    url: () => {
      const addr = server.address();
      if (typeof addr === 'string' || addr === null) throw new Error('no addr');
      return `http://127.0.0.1:${addr.port}/`;
    },
  };
}
```

```typescript
// test/e2e/csp-tt-allowlist.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTrustedTypesAllowlistFixture } from '../fixtures/csp-trusted-types-allowlist.js';
import { McpTestClient } from '../helpers/mcp-client.js';

describe('CSP Trusted Types allowlist (hard-block) — Slice 2', () => {
  let fx: ReturnType<typeof startTrustedTypesAllowlistFixture>;
  let client: McpTestClient;
  let tabUrl: string;

  beforeAll(async () => {
    fx = startTrustedTypesAllowlistFixture();
    client = await McpTestClient.spawn();
    const r = await client.callTool('safari_new_tab', { url: fx.url() });
    tabUrl = (r.content[0] as { text: string }).text.match(/tabUrl":"([^"]+)/)?.[1] ?? fx.url();
    // Wait 1s for CSP probe to land.
    await new Promise((r) => setTimeout(r, 1500));
  });
  afterAll(async () => {
    await client?.callTool('safari_close_tab', { tabUrl }).catch(() => {});
    await client?.shutdown();
    fx?.server.close();
  });

  it('safari_evaluate fails with CSP_HARD_BLOCK on policy-allowlist page', async () => {
    let thrown: unknown;
    try { await client.callTool('safari_evaluate', { tabUrl, script: 'return 1' }); }
    catch (e) { thrown = e; }
    expect(String(thrown)).toMatch(/CSP_HARD_BLOCK/);
    expect(String(thrown)).toMatch(/safari_get_page_info/);
  });
  it('safari_get_page_info succeeds on the same page (CSP-safe)', async () => {
    const r = await client.callTool('safari_get_page_info', { tabUrl });
    expect((r.content[0] as { text: string }).text).toContain('TT-allowlist fixture');
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/e2e/csp-tt-allowlist.test.ts`
Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add extension/content-main.js test/fixtures/csp-trusted-types-allowlist.ts test/e2e/csp-tt-allowlist.test.ts
git commit -m "feat(ext+test): Layer 3 TT policy + allowlist fixture + Slice 2 e2e (Task 11)"
```

---

### Task 12: Slice 1 graduation — Apple Shop e2e

**Files:**
- Create: `test/e2e/csp-apple-shop.test.ts`

- [ ] **Step 1: Write the e2e**

```typescript
// test/e2e/csp-apple-shop.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { McpTestClient } from '../helpers/mcp-client.js';

describe('Slice 1 graduation — Apple Shop CSP-strict (smoke against live site)', () => {
  let client: McpTestClient;
  let tabUrl = 'https://www.apple.com/shop/';

  beforeAll(async () => {
    client = await McpTestClient.spawn();
    const r = await client.callTool('safari_new_tab', { url: tabUrl });
    tabUrl = (r.content[0] as { text: string }).text.match(/tabUrl":"([^"]+)/)?.[1] ?? tabUrl;
    await new Promise((r) => setTimeout(r, 2000)); // wait for CSP probe + content scripts
  });
  afterAll(async () => {
    await client?.callTool('safari_close_tab', { tabUrl }).catch(() => {});
    await client?.shutdown();
  });

  it('safari_get_page_info returns title containing "Apple"', async () => {
    const r = await client.callTool('safari_get_page_info', { tabUrl });
    const text = (r.content[0] as { text: string }).text;
    expect(text).toMatch(/"title":"[^"]*Apple/);
  });
  it('safari_get_meta_tags returns at least the description', async () => {
    const r = await client.callTool('safari_get_meta_tags', { tabUrl, names: ['description'] });
    expect((r.content[0] as { text: string }).text).toMatch(/description/);
  });
  it('safari_evaluate via ISOLATED returns document.title without CSP error', async () => {
    // Routes via __SP_EXECUTE_ISOLATED__ because apple.com/shop is CSP-strict.
    const r = await client.callTool('safari_evaluate', { tabUrl, script: 'return document.title' });
    expect((r.content[0] as { text: string }).text).toMatch(/Apple/);
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run test/e2e/csp-apple-shop.test.ts`
Expected: 3 tests pass. **This is Slice 1's graduation criterion.**

If any fails: re-check Tasks 2, 4, 5, 6, 8, 9 wiring. The cspMode probe in Task 4 may not be reaching the daemon — check `~/.safari-pilot/daemon.log` for `csp-mode probe received`.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/csp-apple-shop.test.ts
git commit -m "test(e2e): Slice 1 graduation — Apple Shop CSP-strict (Task 12)"
```

---

### Task 13: Slice 3 — script-src no-eval fixture + X.com smoke

**Files:**
- Create: `test/fixtures/csp-script-src-no-eval.ts`
- Create: `test/e2e/csp-script-src-mode.test.ts`

- [ ] **Step 1: Create the fixture**

```typescript
// test/fixtures/csp-script-src-no-eval.ts
import { createServer, Server } from 'node:http';

export function startScriptSrcNoEvalFixture(port = 0): { server: Server; url: () => string } {
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>script-src no-eval</title></head><body>
<h1>script-src lacks unsafe-eval and trusted-types-eval</h1>
<form><input id="user" type="text"><input id="pw" type="password"><button type="submit">Submit</button></form>
</body></html>`;
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "script-src 'self' 'unsafe-inline'",
    });
    res.end(page);
  });
  server.listen(port);
  return {
    server,
    url: () => {
      const addr = server.address();
      if (typeof addr === 'string' || addr === null) throw new Error('no addr');
      return `http://127.0.0.1:${addr.port}/`;
    },
  };
}
```

- [ ] **Step 2: Write the e2e**

```typescript
// test/e2e/csp-script-src-mode.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startScriptSrcNoEvalFixture } from '../fixtures/csp-script-src-no-eval.js';
import { McpTestClient } from '../helpers/mcp-client.js';

describe('CSP script-src no-eval (Mode B) — Slice 3', () => {
  let fx: ReturnType<typeof startScriptSrcNoEvalFixture>;
  let client: McpTestClient;
  let tabUrl: string;
  beforeAll(async () => {
    fx = startScriptSrcNoEvalFixture();
    client = await McpTestClient.spawn();
    const r = await client.callTool('safari_new_tab', { url: fx.url() });
    tabUrl = (r.content[0] as { text: string }).text.match(/tabUrl":"([^"]+)/)?.[1] ?? fx.url();
    await new Promise((r) => setTimeout(r, 1500));
  });
  afterAll(async () => {
    await client?.callTool('safari_close_tab', { tabUrl }).catch(() => {});
    await client?.shutdown();
    fx?.server.close();
  });

  it('safari_fill works on Mode B fixture (login field)', async () => {
    const r = await client.callTool('safari_fill', { tabUrl, selector: '#user', value: 'testuser' });
    expect(r.content?.[0]).toBeDefined();
  });
  it('safari_evaluate via ISOLATED returns user input value', async () => {
    const r = await client.callTool('safari_evaluate', { tabUrl, script: 'return document.querySelector("#user")?.value' });
    expect((r.content[0] as { text: string }).text).toContain('testuser');
  });
});
```

- [ ] **Step 3: Run**

Run: `npx vitest run test/e2e/csp-script-src-mode.test.ts`
Expected: 2 tests pass.

- [ ] **Step 4: Commit**

```bash
git add test/fixtures/csp-script-src-no-eval.ts test/e2e/csp-script-src-mode.test.ts
git commit -m "test(e2e): Slice 3 — script-src no-eval (Mode B) (Task 13)"
```

---

### Task 14: Rollback feature flag — SAFARI_PILOT_LEGACY_MAIN_WORLD

**Files:**
- Modify: `safari-pilot.config.json` (add `cspBypass.legacyMainWorld`)
- Modify: `extension/background.js` (read flag from storage on startup; push to content scripts)
- Modify: `src/engines/extension.ts` `buildExecuteScriptPayload` (skip ISOLATED routing if flag set)
- Create: `test/e2e/csp-legacy-flag.test.ts`

- [ ] **Step 1: Add config field**

In `safari-pilot.config.json`, add a new top-level block:

```json
  "cspBypass": {
    "legacyMainWorld": false,
    "_comment": "v0.1.34 rollback flag. Set true to revert ISOLATED-world routing to v0.1.33 MAIN behavior on all tabs."
  },
```

- [ ] **Step 2: Read flag in background.js**

```javascript
// Near the top of background.js, after imports
let LEGACY_MAIN_WORLD = false;
(async () => {
  try {
    const cfg = await browser.storage.local.get(['safari_pilot_config']);
    LEGACY_MAIN_WORLD = !!cfg?.safari_pilot_config?.cspBypass?.legacyMainWorld;
  } catch (_) {}
})();
```

- [ ] **Step 3: Honor flag in buildExecuteScriptPayload**

```typescript
// In src/engines/extension.ts buildExecuteScriptPayload, after sentinel passthrough:
  if (process.env.SAFARI_PILOT_LEGACY_MAIN_WORLD === '1') {
    return { script, routing: 'main' };
  }
```

(Alternatively, read from a config import; environment variable is simpler for rollback diagnosis. Document this in the spec's Section 3 rollback path.)

- [ ] **Step 4: Write the e2e**

```typescript
// test/e2e/csp-legacy-flag.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startTrustedTypesFixture } from '../fixtures/csp-trusted-types.js';
import { McpTestClient } from '../helpers/mcp-client.js';

describe('Rollback feature flag: SAFARI_PILOT_LEGACY_MAIN_WORLD', () => {
  let fx: ReturnType<typeof startTrustedTypesFixture>;
  let client: McpTestClient;
  let tabUrl: string;
  beforeAll(async () => {
    fx = startTrustedTypesFixture();
    client = await McpTestClient.spawn({ env: { SAFARI_PILOT_LEGACY_MAIN_WORLD: '1' } });
    const r = await client.callTool('safari_new_tab', { url: fx.url() });
    tabUrl = (r.content[0] as { text: string }).text.match(/tabUrl":"([^"]+)/)?.[1] ?? fx.url();
    await new Promise((r) => setTimeout(r, 1500));
  });
  afterAll(async () => {
    await client?.callTool('safari_close_tab', { tabUrl }).catch(() => {});
    await client?.shutdown();
    fx?.server.close();
  });

  it('with flag set, safari_evaluate on TT-strict page fails (v0.1.33 behavior)', async () => {
    let thrown: unknown;
    try { await client.callTool('safari_evaluate', { tabUrl, script: 'return 1' }); }
    catch (e) { thrown = e; }
    // Note: with the flag, we expect a Trusted Types error (NOT CSP_BLOCKED reformatting)
    // because routing skips ISOLATED.
    expect(String(thrown)).toMatch(/Trusted Type|trusted-types-eval/i);
  });
});
```

- [ ] **Step 5: Run**

Run: `npx vitest run test/e2e/csp-legacy-flag.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add safari-pilot.config.json extension/background.js src/engines/extension.ts test/e2e/csp-legacy-flag.test.ts
git commit -m "feat(rollback): SAFARI_PILOT_LEGACY_MAIN_WORLD env flag (Task 14)"
```

---

### Task 15: Stats CLI observability for new error codes

**Files:**
- Modify: `src/cli/stats.ts`
- Create: `test/unit/cli/stats-csp-codes.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/unit/cli/stats-csp-codes.test.ts
import { describe, it, expect } from 'vitest';
import { aggregateCallStats } from '../../../src/cli/stats.js';

describe('stats CLI — CSP error code aggregation', () => {
  it('counts CSP_BLOCKED occurrences in tool-calls.jsonl', () => {
    const lines = [
      '{"name":"safari_evaluate","error":{"code":"CSP_BLOCKED"}}',
      '{"name":"safari_evaluate","error":{"code":"CSP_BLOCKED"}}',
      '{"name":"safari_evaluate","error":{"code":"CSP_HARD_BLOCK"}}',
      '{"name":"safari_click","ok":true}',
    ];
    const stats = aggregateCallStats(lines);
    expect(stats.errorCounts.CSP_BLOCKED).toBe(2);
    expect(stats.errorCounts.CSP_HARD_BLOCK).toBe(1);
  });
});
```

- [ ] **Step 2: Run, fail**

Run: `npx vitest run test/unit/cli/stats-csp-codes.test.ts`
Expected: FAIL (function probably doesn't exist with that signature).

- [ ] **Step 3: Implement / extend the stats aggregator**

Inspect `src/cli/stats.ts` for the existing aggregation function. Add or extend `aggregateCallStats` to surface error codes:

```typescript
export function aggregateCallStats(lines: string[]): { errorCounts: Record<string, number>; total: number } {
  const errorCounts: Record<string, number> = {};
  let total = 0;
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      total++;
      const code = entry?.error?.code;
      if (code) errorCounts[code] = (errorCounts[code] || 0) + 1;
    } catch (_) { /* skip malformed */ }
  }
  return { errorCounts, total };
}
```

- [ ] **Step 4: Run**

Run: `npx vitest run test/unit/cli/stats-csp-codes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/stats.ts test/unit/cli/stats-csp-codes.test.ts
git commit -m "feat(cli): stats CLI counts CSP_BLOCKED and CSP_HARD_BLOCK (Task 15)"
```

---

### Task 16: Promote the inline-bench harness

**Files:**
- Create: `bench/webvoyager/run-one-task.sh` (port from `/tmp/run-one-task.sh` with the macOS-mktemp + perl-alarm cleanup fixes from v0.1.33)

- [ ] **Step 1: Copy and adapt**

Copy `/tmp/run-one-task.sh` into the repo. Replace any GNU mktemp templates with macOS-compatible ones (`/tmp/wv-prompt.XXXXXX` — X's at the end). Replace `osascript "$CLEANUP_SCRIPT"` with `perl -e 'alarm 8; exec @ARGV' osascript "$CLEANUP_SCRIPT"`.

- [ ] **Step 2: Verify it runs on one task**

```bash
bash bench/webvoyager/run-one-task.sh "Allrecipes--2" /tmp/wv-test
```

Expected: completes with score.json written.

- [ ] **Step 3: Commit**

```bash
git add bench/webvoyager/run-one-task.sh
git commit -m "infra(bench): promote inline-bench harness with macOS fixes (Task 16)"
```

---

### Task 17: Bench gate Slice 4 — run 47 failures + 50 spot-check + judge

**Files:**
- Create: `bench-runs/webvoyager-v0.1.34-<timestamp>/` (output dir)

- [ ] **Step 1: List the 47 failing tasks from v0.1.33**

```bash
python3 -c "
import json, glob, os
canonical = set(json.loads(l)['id'] for l in open('/tmp/wv-175-tasks.jsonl'))
failed = []
for p in glob.glob('/tmp/wv-inline-runs/*-r1.score.json'):
    tid = os.path.basename(p).replace('-r1.score.json','')
    if tid not in canonical: continue
    d = json.load(open(p))
    if d['verdict'] in ('FAILURE','UNKNOWN'):
        failed.append(tid)
print('\\n'.join(sorted(failed)))
" > /tmp/v0134-failing-tasks.txt
wc -l /tmp/v0134-failing-tasks.txt   # should be 47
```

- [ ] **Step 2: Build a 50-task spot-check (stratified)**

```bash
python3 -c "
import json, glob, os, random
from collections import defaultdict
canonical = {json.loads(l)['id']: json.loads(l)['web_name'] for l in open('/tmp/wv-175-tasks.jsonl')}
passed = []
for p in glob.glob('/tmp/wv-inline-runs/*-r1.score.json'):
    tid = os.path.basename(p).replace('-r1.score.json','')
    if tid not in canonical: continue
    d = json.load(open(p))
    if d['verdict'] == 'SUCCESS':
        passed.append(tid)
random.seed(34)
by_site = defaultdict(list)
for t in passed: by_site[canonical[t]].append(t)
selected = []
for site, tasks in by_site.items():
    random.shuffle(tasks)
    selected.extend(tasks[:max(3, len(tasks)*50//128)])
print('\\n'.join(selected[:50]))
" > /tmp/v0134-spot-check-tasks.txt
wc -l /tmp/v0134-spot-check-tasks.txt   # should be ~50
```

- [ ] **Step 3: Run all 97 tasks**

```bash
mkdir -p /tmp/wv-v0134-runs
for tid in $(cat /tmp/v0134-failing-tasks.txt /tmp/v0134-spot-check-tasks.txt); do
  bash bench/webvoyager/run-one-task.sh "$tid" /tmp/wv-v0134-runs
done
```

Expected: ~6-8 hours wall-clock, ~$60-80 API spend.

- [ ] **Step 4: Judge**

```bash
mkdir -p /tmp/wv-v0134-runs
# Adapt judge-inline-runs.ts if needed (it reads from /tmp/wv-inline-runs by default — duplicate or env-var the path).
RUNS_DIR=/tmp/wv-v0134-runs TASKS_PATH=/tmp/wv-175-tasks.jsonl npx tsx bench/webvoyager/judge-inline-runs.ts
```

Expected: scoreboard.json written to `/tmp/wv-v0134-runs/`.

- [ ] **Step 5: Compute per-site delta vs v0.1.33**

```bash
python3 -c "
import json
v33 = json.load(open('/tmp/wv-inline-runs/scoreboard.json'))
v34 = json.load(open('/tmp/wv-v0134-runs/scoreboard.json'))
print(f'{\"Site\":25} {\"v0.1.33\":<12} {\"v0.1.34\":<12} {\"Δ\":<5}')
for site in sorted(v33['per_site']):
    a, b = v33['per_site'][site], v34['per_site'].get(site, {})
    delta = b.get('tasks_success',0) - a['tasks_success']
    sign = '+' if delta >= 0 else ''
    print(f'{site:25} {a[\"tasks_success\"]}/{a[\"tasks_total\"]:<8} {b.get(\"tasks_success\",0)}/{b.get(\"tasks_total\",\"-\"):<8} {sign}{delta}')
"
```

- [ ] **Step 6: Acceptance check**

Per spec Section 1:
- [ ] ≥30 of 47 failing tasks now SUCCESS
- [ ] 0 regressions on 50-task spot-check
- [ ] Google Flights ≥6/11
- [ ] Apple ≥7/12
- [ ] Google Search ≥9/11
- [ ] capture_failure_rate stays 0.0%

If any criterion fails: STOP, do not tag. Open `docs/upp/specs/...` Section 7 v0.1.35 carry-forwards and prioritize.

- [ ] **Step 7: Copy scoreboard into the repo**

```bash
ts=$(date +%Y%m%d-%H%M%S)
mkdir -p "bench-runs/webvoyager-v0.1.34-inline-bench-${ts}"
cp /tmp/wv-v0134-runs/scoreboard.json "bench-runs/webvoyager-v0.1.34-inline-bench-${ts}/scoreboard.json"
```

(bench-runs/ is gitignored — the copy is for local audit only. The delta numbers go into TRACES iter 80.)

- [ ] **Step 8: Commit (TRACES + CHANGELOG + version bump)**

Update `TRACES.md` with iter 80 containing the per-site delta table from Step 5 and the acceptance verdict.

Update `CHANGELOG.md` with a v0.1.34 entry listing:
- Layer 1 ISOLATED-world routing
- 3 new capability tools
- Layer 3 TT policy
- CSP detection
- CSP_BLOCKED error UX
- Rollback flag
- Bench delta summary

Bump versions:

```bash
# package.json + extension/manifest.json
sed -i.bak 's/"version": "0.1.33"/"version": "0.1.34"/' package.json extension/manifest.json
rm package.json.bak extension/manifest.json.bak
```

- [ ] **Step 9: Pre-tag check**

```bash
bash scripts/build-extension.sh
bash scripts/pre-tag-check.sh
```

Expected: ALL CHECKS PASSED.

- [ ] **Step 10: Commit, tag, push, watch CI**

```bash
git add TRACES.md CHANGELOG.md package.json extension/manifest.json bin/
git commit -m "chore(release): v0.1.34 — CSP/Trusted-Types bypass + 3 new capability tools"
git tag -a v0.1.34 -m "release v0.1.34 — CSP/Trusted-Types bypass

Bench delta v0.1.33 → v0.1.34: <fill in from Step 5>

ISOLATED-world routing for execute_script on CSP-blocked tabs.
3 new capability tools: safari_get_page_info, safari_get_meta_tags, safari_extract_text_window.
TT policy registration as defense-in-depth.
CSP_BLOCKED / CSP_HARD_BLOCK error codes with tool-suggesting hints.
SAFARI_PILOT_LEGACY_MAIN_WORLD env flag for rollback."
git push origin main
git push origin v0.1.34
gh run watch $(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```

- [ ] **Step 11: Verify npm published**

```bash
npm view safari-pilot version   # expect: 0.1.34
```

If 404 (token issue per v0.1.33 incident): refresh `NPM_TOKEN` GitHub secret then `gh run rerun --failed <runId>`.

---

## Self-Review

**1. Spec coverage:**
- Spec §1 Goal & Bench acceptance → Task 17 Steps 5-6 ✓
- Spec §2 Root-cause synthesis → Tasks 2 (sentinel), 6 (routing) ✓
- Spec §3 Architecture — duplicate dispatcher → Task 2 + Task 6 ✓
- Spec §3 cspMode detection → Tasks 4 + 5 ✓
- Spec §3 Layer 3 TT policy → Task 11 ✓
- Spec §3 capability tools → Tasks 8, 9, 10 ✓
- Spec §3 CSP_BLOCKED error UX → Task 7 ✓
- Spec §3 rollback flag → Task 14 ✓
- Spec §3 observability → Task 15 ✓
- Spec §4 Slice 1 → Tasks 1, 2, 3, 4, 5, 6, 7, 8, 12 ✓
- Spec §4 Slice 2 → Tasks 9, 10, 11 ✓
- Spec §4 Slice 3 → Tasks 13, 14, 15 ✓
- Spec §4 Slice 4 → Tasks 16, 17 ✓
- Spec §5 fixture infrastructure → Tasks 1, 11, 13 (3 fixtures) ✓
- Spec §6 risks: ISOLATED `new Function` empirically blocked → Task 2 Step 4 STOP gate ✓
- Spec §8 fallback path → referenced in Task 2 Step 4 ✓
- Spec §9 open questions: frameId semantics → defers; cspMode location → Tasks 3 + 5 (src/security/) ✓

**2. Placeholder scan:** No "TBD", "TODO" in the plan body. All code blocks are complete (real function bodies, real test code, real shell commands). ✓

**3. Type consistency:** `CspMode` type defined in Task 3, used in Task 7's `formatCspBlockedError` (matches). `CspProbeResult` defined in Task 3, used in Tasks 4/5. `ExecuteRouting` type defined in Task 6. All names consistent across tasks.

---

**Plan complete and saved to `docs/upp/plans/2026-05-13-safari-pilot-v0134-csp-bypass.md`.**

**Execute with:** the executing-plans skill.
