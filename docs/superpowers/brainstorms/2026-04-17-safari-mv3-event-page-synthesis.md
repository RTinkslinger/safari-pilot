# Safari Pilot — MV3 Event-Page Pivot Research Synthesis

**Date:** 2026-04-17
**Mode:** FULL pipeline (Phases 0-7)
**Supersedes:** `docs/superpowers/specs/2026-04-16-push-wake-design.md` (push-wake via `SFSafariApplication.dispatchMessage`, rejected for foreground-steal bug FB9804951)
**Drives:** upcoming `upp:brainstorming` session (Task #3) — this synthesis is the evidence base, not the spec

---

## 1. Problem statement

Safari Pilot's Extension engine (the product differentiator: closed Shadow DOM, CSP bypass, network interception, cross-origin frames) fails 100% of `extension_execute` roundtrips in production. The current extension polls the daemon via `browser.runtime.sendNativeMessage` inside a chained-Promise `pollLoop` that was designed to keep Safari's MV3 service worker alive. Observed behaviour is 0 `extension_result` entries across hundreds of deliveries. We need an architecture that actually works on Safari 18.x / macOS 26, without the foreground-steal bug that killed the prior push-wake design, and without violating user constraints (no tab-switching, no system-state manipulation).

---

## 2. Sources analyzed

| ID | Source | Type | What it covers |
|----|--------|------|----------------|
| **S1** | `safari-mv3-event-page-wake-2026-04-17.md` (ultra2x-fast, 2026-04-17) | Deep research | Event-page manifest acceptance on Safari 18+/macOS 26, wake events, multi-profile behaviour, production-extension survey, packaging/signing gotchas |
| **S2** | `safari-mv3-event-page-native-messaging-2026-04-17.md` (ultra2x-fast, 2026-04-17) | Deep research | Event-page lifecycle specifics: `sendNativeMessage`/`connectNative` behaviour across unload, state survival, IIFE risk, Promise-keepalive validity, alarm behaviour, in-flight command durability |
| **S3** | `safari-mv3-alternatives-2026-04-17.md` (ultra2x-fast, 2026-04-17) | Deep research | Fallback architectures: connectNative, handler-held context, `SFSafariApplication` APIs, Darwin notifications, reactive-only, helper tab, WKWebView pivot, daemon-drives-browser |
| **S4** | `CHECKPOINT.md` + `ARCHITECTURE.md` + `extension/background.js` + `extension/manifest.json` + `daemon/Sources/SafariPilotdCore/ExtensionBridge.swift` + `extension/native/SafariWebExtensionHandler.swift` + `TRACES.md` | Project ground truth | Actual current architecture, observed 0-roundtrip failure, existing daemon-side long-poll + `delivered` flag + 30s timeout, handler TCP proxy, current IIFE + pollLoop + keepalive alarm code |
| **S5** | Prior research summarized in CHECKPOINT: Apple Developer Forums thread 721222, FB9804951 (dispatchMessage foregrounds Safari), Apple's "Optimizing your web extension for Safari" docs, `safari-alarms-*.json` + `sfsafariapplication-dispatchmessage-availability.json` | Historical distillation | Why push-wake was rejected; Apple's forum-recommended workaround is event-page form |

---

## 3. Convergence map

Rows below record substantive cross-source agreement and disagreement. "Qualifies" = source takes a nuanced position compatible with another's. Empty columns were re-checked — Silent is used honestly (source didn't address) not as a dodge.

| Claim area | S1 | S2 | S3 | S4 (reality) |
|------------|----|----|----|------|
| **Event-page form accepted by Safari MV3 on macOS 26** | Supports — "Safari 18.x explicitly accepts and honors… no warnings, silent conversion, or rejection" (C1) | Silent | Implicit via its recommendation (C24) | Untested in our Xcode/.appex pipeline |
| **Event page fixes wake-reliability vs service worker** | Supports — "event-page model has been reported by the developer community to be more resilient… reliably unloading when idle and, crucially, waking up to handle new events" (C3) | Qualifies — "functionally very similar [unload behavior]… primary advantage is a more predictable, albeit still ephemeral, lifecycle" (C12) | Silent | SW → 0 roundtrips observed (C32) |
| **Pending `sendNativeMessage` Promise keeps the background alive** | Silent | **Contradicts — "an in-flight `browser.runtime.sendNativeMessage` promise is not considered an activity that prevents this unloading" (C13). Finding: FALSE.** | Implicit agreement via fallback architecture design (C24) | Our current pollLoop premise (C33) |
| **`connectNative` port survives event-page unload** | Silent | **Contradicts — "port does NOT survive unload… Safari does NOT auto-reconnect" (C15)** | Supports — "persistent port… potentially lower latency" (C24) | Not currently used |
| **`.appex` handler can push unsolicited messages to the extension** | Silent | Silent | **Contradicts — "the `.appex` handler… cannot push unsolicited messages… strictly request-response, JS-initiated" (C25)** | Our handler is one-shot request-response (C35) |
| **`browser.alarms` is the authoritative wake mechanism** | Qualifies — "<1-min intervals unreliable" (C4) | Supports — "only reliable, browser-managed mechanism to guarantee code execution after a period of inactivity" (C21) | Qualifies — "reactive-only" too slow; alarms needed as floor (C28) | Keepalive alarm already at 1-min (C33) |
| **IIFE-wrapped background script is safe for event-page model** | Silent | **Contradicts — "Apple's own sample code… does not use an IIFE… risk of listener double-binding or accumulation" (C18)** | Silent | Current code is IIFE-wrapped (C33) |
| **Production Safari MV3 extensions use event-page form** | Contradicts own recommendation — "Bitwarden… shift to a service worker model" (C9), same for AdGuard and uBlock Origin Lite — all use SW + declarative-first | Silent | Bitwarden cited as native-companion pattern (C24) | N/A — we'd be an early-mover |
| **Reactive-only (no push, no keepalive) is viable for interactive agent UX** | Silent | Silent | **Contradicts — "1-60 seconds or longer… unacceptable for an interactive agent user experience" (C28)** | N/A |
| **Daemon → AppleScript → content-script as alternative delivery** | Silent | Silent | Qualifies — "functional fallback… but only works for active tab, requires explicit user permissions for Automation, and carries a high risk of focus-stealing" (C31) | User memory forbids: never activate Safari, never navigate existing tabs |
| **WebKit Bugzilla 171934: localhost WebSockets broken in Safari** | Silent | Contradicts any WS-based fallback (C23) | Silent | Rules out `ws://127.0.0.1:…` option |
| **Storage.local + alarms persist across unload; everything else resets** | Silent | Supports — authoritative (C16, C17) | Implicit | — |

**Gate check:** At least four substantive Contradicts entries (Promise-keepalive invalidity, connectNative port lifetime, IIFE safety, production extensions using SW not event-page). Map is not confirmation-biased.

---

## 4. Competing hypotheses

### H1 — Manifest-flip only ("the Apple-forum fix, literally")

- **Core claim:** Change `background.service_worker` → `background.scripts` + `persistent:false`, drop `type:"module"`. Leave `background.js` internals (pollLoop, IIFE, nativeMessageChain) alone. Event-page's better wake resilience is enough to unlock the Extension engine.
- **Mechanism:** Event pages reliably resurrect on alarms/`runtime.onStartup`/content-script messages where service workers permanently die under memory pressure (C3, C5). Our existing keepalive alarm + pollLoop combination resumes after each unload; eventually one roundtrip completes.
- **Evidence FOR:** C1, C2, C3, C11 — Apple-blessed config; minimum code change; shortest ship path.
- **Evidence AGAINST:** C13 (pollLoop's pending-Promise keepalive premise is explicitly invalid in event-page form), C12, C14, C17.
- **Fails if:** pending Promises don't keep event page alive AND event page unloads as aggressively as service workers (both confirmed with HIGH confidence).

### H2 — Deep ephemeral refactor ("Apple-idiomatic rewrite")

- **Core claim:** Event-page manifest + *delete pollLoop entirely* + `connectNative` persistent port + storage-backed command queue + idempotent content-script execution + drop IIFE. The background script is treated as genuinely ephemeral; every wake is cold and resumes from `storage.local`.
- **Mechanism:**
  - On every wake: re-run top-level listeners, establish `connectNative` port, drain pending commands the daemon pushes via `port.onMessage`.
  - Before dispatching each command to content scripts, persist commandId + target-tab + status to `storage.local`.
  - Daemon keeps commands in its existing queue with `delivered=false`; pushes via the open port; if the port closes mid-execution, flips `delivered=false` again so the next port-connection re-picks-up.
  - 1-minute keepalive alarm = safety-net wake only (calls `initialize()` which re-establishes port and drains queue). Not for keep-alive.
  - `nativeMessageChain` Promise-serializer deleted — `connectNative`'s single-port model has no SFErrorDomain-error-3 concurrency issue.
  - Drop IIFE; listeners at top level with `listenersAttached` idempotency flag.
- **Evidence FOR:** C2, C3, C11, C15, C16, C17, C18, C19, C20, C21, C24, C34 (our existing `delivered` flag is the correct primitive for resurrection-based redelivery).
- **Evidence AGAINST:** C4 (sub-minute alarms unreliable; 1-min alarm itself may be 90-180s in practice under power policy), C15 (connectNative reconnect complexity), C20 (in-flight `tabs.sendMessage` losses require idempotency at content-script level).
- **Fails if:** Safari throttles 1-minute alarms below product-acceptable reliability under LPM/lid-closed AND/OR `connectNative` in our sandboxed `.appex` + TCP-proxy-to-daemon architecture provides no push-ability benefit over `sendNativeMessage` (UNVERIFIED) AND/OR content-script idempotency can't be achieved for side-effect tools (click-delete, submit-form).

### H3 — Strategic descoping ("ship only what works, honestly")

- **Core claim:** Safari MV3's lifecycle is structurally incompatible with live imperative polling + our UX constraints (no foregrounding, no tab manipulation). Remove Extension engine from production; ship Daemon + AppleScript only; document scope honestly; freeze Extension-engine code behind an off-by-default flag.
- **Mechanism:** `engine-selector.ts` returns only `daemon`/`applescript`; tools declaring `requiresShadowDom`/`cspBypass`/`networkIntercept` throw `EngineUnavailableError` with a clear diagnostic; benchmark filtered to tasks solvable by Daemon+AppleScript; ExtensionEngine/handler/bridge/socket remain in-tree behind `SAFARI_PILOT_EXTENSION_ENGINE=1` feature flag for future revival if Safari's lifecycle improves.
- **Evidence FOR:** C9 (Bitwarden/AdGuard/uBOL all minimize background-script reliance), C34 (daemon IPC is proven), C32 (current Extension engine = 0 roundtrips), the pattern that production extensions dodge this problem rather than solve it.
- **Evidence AGAINST:** Loses closed Shadow DOM / CSP bypass / network interception / cross-origin frames — these are the Extension-engine differentiator versus an AppleScript-only MCP.
- **Fails if:** Real Claude Code user tasks genuinely require Extension-engine capabilities (closed Shadow DOM, fine-grained network interception), and `EngineUnavailableError` feels like a product hole rather than a scope boundary.

---

## 5. Pre-mortems

### H1 pre-mortem

1. **pollLoop hangs on first idle (C13 mechanism):** pollLoop awaits the daemon's 8-second long-poll inside `sendNativeRequest`. Event page unloads at ~30s idle mid-await (C12). Daemon's response arrives into a dead JS context (C14) and is silently dropped. pollLoop's Promise hangs forever. Alarm fires at 60s → `initialize('keepalive alarm')` → new pollLoop starts → hangs on the same issue. **Outcome: same 0-roundtrip state as today, now with a different manifest key.** This is the one failure mode that kills H1 unconditionally.
2. **`onStartup` + `onInstalled` double-initialize race:** Safari fires both events on fresh launch with an installed extension. Two `initialize()` calls race; two pollLoops start simultaneously; both block inside `nativeMessageChain`; Safari unloads the page at 30s before either completes. No forward progress.
3. **LPM / lid-closed alarm throttling (C4):** 1-minute alarm delayed to 5-15 minutes under macOS power policy. `extension_execute` times out at daemon's 30s timeout long before the alarm-triggered wake. Caller sees `EXTENSION_TIMEOUT` repeatedly.

Paste test: failure mode 1 is specific to H1's pollLoop-with-pending-Promise-keepalive design. Moved to H2, which deletes pollLoop, it doesn't apply. Real.

### H2 pre-mortem

1. **`connectNative` provides no push-ability benefit in our specific handler (UNVERIFIED):** HIGH-confidence research (C15) says the port dies on unload and doesn't auto-reconnect. What's UNVERIFIED is whether `connectNative` in Safari 18+ routes through our `NSExtensionRequestHandling.beginRequest` the same way as `sendNativeMessage` — which would mean zero push-ability benefit (daemon still can't initiate a message; only the extension can). If true, we pay the reconnect-logic complexity cost without the bidirectional-push benefit. Mitigated by Validation Gate A below.
2. **1-minute alarm is practically 2-3 minutes under mixed power/load (C4 mechanism):** Apple docs list 1-minute minimum; community reports <1-min unreliable. Empirically 1-min itself may be 90-180s under LPM / lid-closed / heavy load. Worst-case wake latency becomes 2-3 min. For `extension_execute` calls where the caller is Claude Code waiting on a tool response, even 90s is borderline; 3 min is product-unacceptable. Mitigated by Validation Gate B; fallback by bumping daemon timeout to 120-180s.
3. **Content-script idempotency for side-effect tools:** `safari_click` clicks a "delete" button. Event page unloads after `tabs.sendMessage` dispatches but before ack arrives. Daemon times out at 30/90s; redelivers command on next port-open; content script sees the same commandId, but the click has already happened (DOM state changed). Mitigation: `window.__safariPilotExecutedCommands` Set tracks commandIds within a page session. But page-navigation resets the Set. Additional mitigation: daemon-side "executed" log that the content script acks into.
4. **Multi-profile thundering-herd (C8 mechanism):** Each of 3 Safari profiles has an independent event page + alarm schedule. All 3 wake within seconds of each other on the minute-boundary; all 3 establish `connectNative` ports; daemon's `delivered` flag handles the de-duplication but log noise and partial-delivery scenarios multiply. For a single-user single-profile installation this is moot, but our current user runs 3 profiles so this is concrete, not hypothetical.
5. **Storage.local write races when page unloads mid-write:** Event page calls `await storage.local.set({pendingCommands})` with a fresh commandId; unloads mid-write; next wake reads a storage state that's missing that commandId (write aborted) or has partial state. Mitigation: write command state BEFORE posting to port; use atomic set operations; daemon-side is authoritative source anyway.

Paste test: failure mode 1 is specific to H2's reliance on `connectNative` as primary IPC. Moved to H1, which keeps `sendNativeMessage`, it doesn't apply. Real. Failure mode 3 is specific to H2's retry-across-wakes idempotency design — H1's pollLoop doesn't retry because it never completes. Real.

### H3 pre-mortem

1. **Real user tasks need Extension-engine capabilities:** closed Shadow DOM traversal (Reddit, Stripe checkout), CSP bypass (hostile-CSP SaaS pages), network interception (API-response inspection in agent workflows) — these ARE product differentiators. Descoping produces `EngineUnavailableError` for these tasks. If even 10-20% of realistic Claude Code tasks need them, H3 produces visible product holes rather than a cleanly bounded product.
2. **Product positioning collapse:** "Native Safari automation for AI agents" without the Extension engine = "MCP wrapper over AppleScript." The moat versus alternatives (a simple AppleScript MCP) evaporates. Rational user picks the simpler alternative.
3. **Code rot in disabled Extension-engine paths:** ExtensionEngine, handler, bridge, socket server, 14 e2e test files, 42 Swift daemon tests — all remain behind a feature flag. Over 6-12 months of changes to server.ts/engines/tools, the flag-gated code diverges, stops compiling, and becomes unmaintained. "Temporary" descope becomes permanent; future Safari improvement can't be adopted without a separate revival project.
4. **Benchmark-descope is a feedback-memory adjacency:** user's `benchmarks-are-sacred` rule says never modify thresholds or remove tasks to hide failures. Descoping the benchmark to exclude Extension-engine tasks is arguably legitimate (the engine is explicitly disabled, not failing tasks it's supposed to handle), but the reviewer-audit lens may read it as goalpost-moving. The framing needs care.

Paste test: failure mode 1 (product holes from descoping) is specific to H3. Moved to H2, it doesn't apply because H2 retains the Extension engine. Real. Failure mode 3 (code rot) is specific to H3's flag-gated-disable approach. Real.

### Pre-mortem verdict

- **H1 dies on failure mode 1 (pollLoop-keepalive invariant broken).** This is not a "might fail" — it's a definite repeat of the current 0-roundtrip outcome. H1 is not a real candidate.
- **H2 has real failure modes but all are mitigatable via validation gates or fallback logic.** The biggest unknowns are `connectNative`'s behaviour in our specific handler (Gate A) and empirical alarm reliability (Gate B).
- **H3 ships with certainty but forfeits the product's differentiator.**

Comparison: H2 > H3 > H1.

---

## 6. Integrated recommendation

**Primary: H2 (Deep ephemeral refactor) with two hard-gated validation checks and a pre-agreed fallback to H3 if both gates fail beyond two remediation cycles.**

### The load-bearing insight (novel — not present in any single source)

> The root cause of Safari Pilot's prior failure was **NOT wake-unreliability.** It was the false architectural premise that a pending `sendNativeMessage` Promise keeps the worker alive. Apple's forum-suggested workaround (switch to event page) doesn't fix this on its own — it fixes wake-*reliability* (event pages resurrect where service workers permanently die), but both forms unload just as aggressively after ~30-45s idle with pending Promises. H1 preserves the broken premise on a better manifest — still broken. The correct Safari Pilot architecture is "accept the worker dies constantly; design for fast and reliable resurrection from persisted state." That's H2.

This reframes the problem. S1 says "event page is viable with workarounds" and is right. S2 says "pending Promises don't keep pages alive" and is right. Single-source reading of S1 leads to H1 (manifest flip only). Single-source reading of S2 leads to panic / descoping / H3. Cross-source reading produces H2: switch manifest AND delete the pollLoop AND adopt genuinely ephemeral design.

### The concrete refactor (all of H2, fully specified)

| # | Change | Driven by |
|---|--------|-----------|
| 1 | Manifest: `{"service_worker": "background.js", "type": "module"}` → `{"scripts": ["background.js"], "persistent": false}` | C1, C2, C21 |
| 2 | **Delete `pollLoop` and `pollForCommands` functions entirely.** Delete `pollLoopRunning` guard. | C13, C17 |
| 3 | **Delete `nativeMessageChain` Promise-serializer.** `connectNative`'s single-port model eliminates SFErrorDomain-error-3 concurrency; if we stay with `sendNativeMessage` (Gate A fallback), messages remain serial by virtue of being at-most-one-in-flight from a single caller. | C13 |
| 4 | Drop IIFE wrapper `(function(){ 'use strict'; … })()`. Move listener registrations to top level with a `listenersAttached` idempotency flag. | C17, C18 |
| 5 | Switch IPC from `browser.runtime.sendNativeMessage` to `browser.runtime.connectNative('com.safari-pilot.app')` persistent port. `port.onMessage` receives daemon-pushed commands; `port.postMessage` sends results; `port.onDisconnect` triggers exponential-backoff reconnect (250ms → 500ms → 1s → 2s → 5s cap). **If Gate A fails, revert to `sendNativeMessage` and keep the rest of the refactor.** | C15, C21, C24 |
| 6 | Persist command-state (commandId, target-tab, status, timestamp) to `storage.local` BEFORE posting to the port. On every wake, read `storage.local.pendingCommands` and reconcile with daemon via an initial `{type:'reconcile', pendingIds:[…]}` message. | C16, C20, C21 |
| 7 | **Daemon: when port connects, push all `delivered=false` queued commands via port; when port disconnects, for every command with `delivered=true` but un-acked `result`, flip `delivered=false` so next port-connection re-picks-up.** This is a small extension of the existing `ExtensionBridge` (`handlePoll` becomes `handlePortConnect`; new `handlePortDisconnect`; reuse existing `delivered` flag + 30s/90s timeout). | C34 (reuse existing) |
| 8 | Keepalive alarm (1 minute) = safety-net wake. Its handler calls `initialize()` which re-runs listener setup (idempotent) and re-establishes `connectNative` port. Not for aliveness. | C19 |
| 9 | Content-script idempotency: each command carries a unique commandId. Content script maintains `window.__safariPilotExecutedCommands` Set scoped to page session. On receipt: if commandId already in Set → return cached result (`{ok:true, cached:true}`); else execute, add to Set, return result. Daemon-side ALSO logs executedCommandIds for cross-page durability; on redeliver, daemon first checks its log. | C20 |
| 10 | Extend `extension_execute` daemon timeout: 30s → 90s. Accommodates: cold-wake (0-60s alarm) + `connectNative` port establishment (100-500ms) + command reconcile + execute + result round-trip. | C10 |

### Validation gates (hedge against H2's two biggest unknowns)

**Gate A — `connectNative` empirical suitability** (prototype in a disposable branch, week 1 of implementation):

Build a minimal connectNative prototype:
- Modify `SafariWebExtensionHandler.swift` to accept a persistent begin stream (research: is this possible? does `beginRequest` get called per-connection or per-message?).
- Modify `background.js` to `connectNative` and send/receive via port.
- Measure: (i) does daemon → handler → port.onMessage actually push messages to a live event page without JS initiating? (ii) does `onDisconnect` fire reliably when event page unloads? (iii) is total roundtrip latency < sendNativeMessage equivalent?

**PASS** = proceed with H2-with-connectNative. **FAIL** = adopt H2-with-sendNativeMessage (polling-on-wake instead of push): every wake → extension initiates a `{type:'drain'}` sendNativeMessage → daemon returns all un-delivered commands in one batch → extension executes in loop → posts results back with individual sendNativeMessage calls. Rest of refactor (delete pollLoop, drop IIFE, ephemeral design, storage.local state) unchanged.

**Gate B — 1-minute alarm empirical reliability** (instrument production build, week 2):

Instrument `extension/background.js` to log alarm-fire timestamps to daemon via `extension_log`. Collect 2-hour windows covering:
- Idle Safari (no active browsing, default profile)
- Active Safari (agent user normal browsing, 3 profiles)
- Safari + Low Power Mode on
- Safari + lid briefly closed/reopened
- Safari backgrounded (another app in foreground)

**PASS** = median inter-fire interval ≤ 90s across all scenarios. **FAIL** = consider: bump daemon timeout higher (up to 300s), reduce alarm period to 30s if Safari permits (even with reduced reliability per C4, more attempts may compensate), OR trigger the descope path.

### Descope trigger

If BOTH gates fail AND two further remediation cycles (≤1 week each) don't fix either gate, pivot to H3: ship with Extension engine explicitly disabled in production, documented as "experimental — re-enable when Safari's background-script lifecycle allows reliable push delivery." Keep Extension-engine code in-tree behind `SAFARI_PILOT_EXTENSION_ENGINE=1` feature flag; reactivate scheduled review in 6 months as Safari versions ship.

### What H2 survives that H1/H3 don't

- Survives the **Promise-keepalive invalidity (C13)** because pollLoop is deleted — H2 never assumes pending Promises keep the page alive.
- Survives the **port-disconnect problem (C15)** because reconnection is explicit via `onDisconnect` handler and state is persisted in `storage.local`.
- Survives the **`.appex` handler push-limitation (C25)** because commands are pushed via the open `connectNative` port while event page is alive; when dormant, alarm-triggered wake re-establishes the port.
- Survives the **multi-profile coordination challenge (C8)** because the daemon's existing `delivered` flag de-duplicates at the queue level; multi-profile just means multiple port connections, which the daemon already tolerates (ExtensionSocketServer accepts concurrent TCP connections).
- Survives the **production-extension lesson (C9)** because while Bitwarden et al. dodge this by going declarative-first, we acknowledge our product is inherently imperative and solve the lifecycle problem rather than dodge it.
- Retains the **Extension-engine differentiator** that H3 forfeits.

### What H2 explicitly cannot solve (acknowledged, not hidden)

- **Sub-60s worst-case wake latency is architecturally impossible without foreground-stealing.** Every path that provides sub-60s guaranteed wake of a dormant event page either requires `dispatchMessage` (foreground-steals) or a user-driven browser event (unpredictable). H2 accepts 0-60s as the realistic worst case for cold wake; daemon timeout 90s covers it.
- **LPM / sleep users may see degraded Extension-engine reliability.** Alarms throttle further under aggressive power policy. No code-side fix. Product-side mitigation: document the tradeoff; surface a "Extension engine degraded — system under power policy" metadata flag when detected.
- **Commands with destructive side effects (`safari_click` on "delete") are not perfectly idempotent.** The `__safariPilotExecutedCommands` Set and daemon-side executed log reduce the risk; they don't eliminate it if a page-navigation clears the Set between send and retry. Accept this risk; document it; make retries opt-in per-tool or bounded.
- **`connectNative` push-ability is UNVERIFIED on Safari 18+ in our sandboxed `.appex` architecture.** Gate A resolves this, but until the gate runs, the design's headline latency benefit is provisional.

---

## 7. Open questions (validation work, not synthesis gaps)

1. **Gate A — `connectNative` push-ability in our handler.** Does Safari's `browser.runtime.connectNative` deliver daemon-side messages to an event page via a persistent handler path, or does it route through `NSExtensionRequestHandling.beginRequest` the same one-shot way `sendNativeMessage` does? Empirical answer needed.
2. **Gate B — Empirical alarm fire distribution on Safari 18.x / macOS 26** under idle / active / LPM / lid-closed / backgrounded scenarios. Needed to size daemon timeout and decide if H2 is viable for our worst-case users.
3. **Content-script Set survival.** Does `window.__safariPilotExecutedCommands` survive typical tab interactions? SPA route changes? `history.pushState`? Needed to decide if daemon-side executed log is additive or replacement.
4. **Multi-profile concurrency in practice.** What happens when 3 profiles wake simultaneously and all establish `connectNative` ports within 1-2s? Does `ExtensionSocketServer`'s current concurrent-connection handling produce clean behaviour, or does the thundering-herd produce race conditions in the `delivered` flag logic? Small Swift test needed.
5. **Apple's sample Safari Web Extension code** — does it use IIFE or top-level? Worth a quick look at Apple's WWDC Safari-Web-Extensions sample project to confirm the pattern before committing to "drop the IIFE."
6. **Safari profile storage partitioning** — is `storage.local` truly per-profile? If yes, command-queue state lives in the profile that received the daemon-push; if user switches profiles, pending commands in profile A are unreachable from profile B. Daemon-side state is authoritative but this affects recovery UX.

---

## 8. Next step

This synthesis is the evidence base. It is NOT a spec. The next step per the user's protocol is `upp:brainstorming` (Task #3) — an interactive 5-lens discovery session that takes this synthesis plus the project constraints and produces the spec. Once the spec is approved, `upp:writing-plans` produces the implementation plan, then `upp:executing-plans` executes it with verification gates inline.

Do NOT skip directly to a plan from this document. The synthesis surfaces the architecture direction and the unknowns; the brainstorming session surfaces the user-experience, scope, and sequencing tradeoffs that turn direction into a buildable spec.
