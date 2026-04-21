# Session Test Findings — 2026-04-22

Findings from running two headless Claude CLI sessions with three tasks each (X bookmarks, YouTube playlists, LinkedIn profile). All bugs discovered during this test and any unresolved issues from the session.

---

## BUG 1: engineAvailability.extension set once at startup, never refreshed (ROOT CAUSE)

**File:** `src/server.ts` — `start()` method
**Severity:** Critical — blocks the entire extension engine pipeline

`engineAvailability` is set during `start()` and never updated:
```typescript
private engineAvailability = { daemon: false, extension: false };
// Set once in start():
this.setEngineAvailability({ daemon: daemonAvailable, extension: extensionAvailable });
```

If the extension isn't connected at the moment the MCP server starts (which is almost always — the session tab hasn't opened yet), `extension: false` is locked in for the entire session. The engine selector ALWAYS picks daemon. The extension engine is never used.

**Fix needed:** Either refresh `engineAvailability` periodically or on each tool call, OR check extension availability dynamically in the engine selector instead of using a stale cached value.

---

## BUG 2: ensureExtensionReady() gated by selectedEngineName === 'extension' (chicken-and-egg)

**File:** `src/server.ts` — `executeToolWithSecurity()` ~line 537
**Severity:** Critical — the bootstrap can never fire

```typescript
if (selectedEngineName === 'extension') {
  const ready = await this.ensureExtensionReady(traceId);
  ...
}
```

Since Bug 1 means `selectedEngineName` is ALWAYS `daemon`, this block never executes. The session tab is never opened. The extension is never bootstrapped.

**Fix needed:** Move `ensureExtensionReady()` BEFORE engine selection, or make engine selection dynamic (re-check availability after bootstrap).

---

## BUG 3: No _sessionWindowId → tabs open in front window (wrong window)

**File:** `src/server.ts`, `src/engines/applescript.ts`
**Severity:** High — agent tabs invade user's windows

When `_sessionWindowId` is undefined (because `ensureExtensionReady()` never ran — Bug 2), `buildNewTabScript` falls back to `tell front window`. This means agent tabs open in whatever window the user is looking at — including the session tab window from a different session or the user's own browsing window.

**Observed behavior:** Tasks opened tabs in the user's active Safari window instead of a dedicated agent window.

**Fix needed:** Depends on fixing Bugs 1 and 2 first. Once the session tab is properly opened, `_sessionWindowId` will be set and tabs will target the correct window.

---

## BUG 4: Session tab overridden by task tab

**Observed:** One of the two test sessions navigated a page ON TOP of the persistent session tab. The session page (health dashboard at 127.0.0.1:19475/session) was replaced by a task URL.

**Root cause:** Same as Bug 3 — without `_sessionWindowId`, a `safari_navigate` call targeting the front tab could hit the session tab if it's the active tab in the front window.

**Fix needed:** The session tab should be protected. Either:
- Track the session tab URL and skip it in `buildNavigateScript`
- Or ensure session tab is never the `current tab` of the front window after opening

---

## BUG 5: /status endpoint blocked by Hummingbird long-poll serialization

**File:** `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift`
**Severity:** High — causes ensureExtensionReady() to always timeout

The Hummingbird HTTP server serializes requests. When the extension's `GET /poll` is holding a 5-second long-poll connection, `GET /status` requests queue behind it. The `ensureExtensionReady()` bootstrap polls `/status` every 1s for 10s — but each `/status` request may wait up to 5s for the poll to release.

**Observed:** In Session 1 trace, the bootstrap ran `extension_health` checks for 80+ seconds (pairs of them), all timing out.

**Fix needed:** Either:
- Serve `/status` on a separate HTTP listener (different port or thread)
- Make `/status` bypass the Hummingbird request queue
- Or use a different mechanism for the fast check (e.g., read HealthStore directly without HTTP)

---

## BUG 6: Storage bus timeout after navigation (content script not ready)

**File:** Filed as `docs/upp/specs/2026-04-21-storage-bus-timeout-after-navigation.md`
**Severity:** Medium — blocks interaction-tools e2e tests 2 and 3

After `safari_navigate` loads a fresh page, the content script hasn't injected yet. The next `safari_evaluate` writes `sp_cmd` to storage but no content script is listening → 30s timeout.

**Fix needed:** Content-script-ready probe, or retry logic with shorter timeout.

---

## BUG 7: domainMatches removed but some ownership misses still occur

**Observed in telemetry:** Several tool calls show `NO_OWNERSHIP_CHECK` — the ownership check was skipped or failed:
- `safari_wait_for` on `x.com/eglyman/status/...` (navigated URL not in registry)
- `safari_wait_for` on `youtube.com/feed/library` (redirect from youtube.com)
- `safari_evaluate` on `youtube.com/feed/playlists` (redirect from youtube.com)

These didn't throw errors (the calls succeeded via daemon engine which doesn't enforce ownership), but they represent URL tracking failures. After `safari_navigate` changes the URL, the registry isn't updated because:
1. No `_meta` (daemon engine, not extension)
2. The no-_meta fallback in post-verify only updates for `safari_navigate` tool calls, not for all tools

**Fix needed:** When ALL tools use extension engine (Bug 1 fixed), `_meta` will flow and URLs will be tracked automatically. This bug is a consequence of daemon fallback.

---

## BUG 8: Orphaned daemon processes (from old test runs)

**Observed:** ~130 orphaned `SafariPilotd` processes from April 13 (each 704 bytes RSS). Not causing issues but wasting PIDs.

**Fix needed:** `scripts/update-daemon.sh` should kill ALL `SafariPilotd` processes, not just the LaunchAgent one. Or add a cleanup script.

---

## ISSUE 9: alarm_fire telemetry still not reporting to daemon

**Status:** Background.js now has `emitTrace('alarm', 'alarm_fire', {})` in the alarm handler — but this goes through `__trace__` sentinel, not `extension_log` with "alarm_fire" prefix. The HealthStore's `lastAlarmFireTimestamp` is still updated by the `extension_log` path (CommandDispatcher line 160) which background.js never calls.

**Fix needed:** Either:
- Have background.js send `extension_log` with "alarm_fire" prefix (matching what CommandDispatcher expects)
- Or have the `__trace__` path also update `lastAlarmFireTimestamp` when event is "alarm_fire"

---

## Priority Order for Fixes

1. **Bug 1 + Bug 2** — These are the same fix: make extension availability dynamic. Without this, nothing else matters.
2. **Bug 5** — /status serialization. Without a fast status check, the bootstrap can't work even after Bug 1 is fixed.
3. **Bug 3 + Bug 4** — Window targeting. Depends on Bugs 1+2 being fixed first.
4. **Bug 6** — Storage bus timeout. Independent fix.
5. **Bug 7** — Ownership misses. Self-resolves when extension engine is used (Bugs 1+2).
6. **Issue 9** — Telemetry gap. Low priority.
7. **Bug 8** — Cleanup. Low priority.

---

## What Worked

Despite the bugs, both sessions completed all 3 tasks successfully using daemon engine (AppleScript):
- X bookmarks fetched correctly
- YouTube playlists listed (Session 2; Session 1 wasn't signed in)
- LinkedIn activity found correctly
- Telemetry captured all 419 tool call events (Session 2)
- Session tab page was served and displayed
- Keepalive pings were received by daemon
- MCP connection tracking worked (`mcp: true` in /status)

The daemon fallback path is reliable. The extension engine pipeline needs the fixes above to actually be used.
