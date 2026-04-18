# Gate B Results — HTTP Long-Poll Keepalive Test

**Date:** 2026-04-18
**Verdict:** PARTIAL PASS — HTTP fetch works, but does NOT keep event page alive past 30s

## Test Setup

- Gate B HTTP server on `127.0.0.1:19475` with:
  - `GET /long-poll` — holds response for 60s
  - `POST /heartbeat` — logs alive time
  - CORS support (Access-Control-Allow-Origin: *)
- Extension background.js probes:
  - Long-poll fetch to `/long-poll` (60s hold)
  - Heartbeat POST every 5s with `aliveMs` counter
- Extension manifest with `content_security_policy` allowing `connect-src` to localhost:19475

## Results

### Observed Behavior

```
02:07:26 - Long-poll started
02:07:31 - Heartbeat: alive 5s
02:07:36 - Heartbeat: alive 10s
02:07:41 - Heartbeat: alive 15s
02:07:46 - Heartbeat: alive 20s
02:07:51 - Heartbeat: alive 25s
02:07:56 - CLIENT DISCONNECTED (event page killed at ~30s)
```

Pattern repeated consistently across 3 wake cycles: event page lives for ~25-30 seconds, then Safari kills it regardless of active fetch() requests.

### Check Results

| Check | Result | Evidence |
|-------|--------|----------|
| fetch() to localhost works | **PASS** | Multiple heartbeat POSTs received successfully |
| Long-poll response received | **FAIL** | 60s hold always interrupted at ~30s by event page kill |
| Active fetch keeps page alive | **FAIL** | Event page killed at 30s despite pending fetch response |
| Heartbeat fetch works | **PASS** | 5-6 successful heartbeat POSTs per 30s wake window |
| Alarm reconnect re-wakes page | **PASS** | New long-poll + heartbeats started after each kill |
| CORS handled correctly | **PASS** | No CORS errors observed |

### Key Finding

**Safari's 30s event page kill is absolute.** An active `fetch()` with a pending response does NOT extend the event page lifetime. This contradicts the reference repo's comment ("This active fetch keeps the service worker alive in Safari") — but the reference repo uses a **service worker**, not an event page. Service workers and event pages have different lifecycle semantics in Safari.

### Architecture Implications

HTTP long-polling is VIABLE but must use **short poll holds** (≤5 seconds):

- 30s window / 5s hold = 5-6 poll cycles per wake
- Command delivered within 0-5s if the page is active (polling)
- After 30s kill, alarm re-wakes within 60s
- Worst-case command latency: ~65s (killed right after last poll + 60s alarm wait)
- Average case when page is active: ~2.5s

This matches the reference repo's design (5s poll hold) and is strictly better than `sendNativeMessage`:
- No `SFErrorDomain error 3` (no handler spawning)
- No concurrent message budget issues
- Cleaner reconnect (just resume polling on re-wake)
- Storage-backed pending queue handles crash recovery
