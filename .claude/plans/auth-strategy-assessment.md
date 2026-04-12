# Assessment: Safari Pilot Authentication Strategy

## Verdict: Needs More Research (then Build)

This started as "should we add a passkey/Touch ID toggle?" and revealed a larger gap: Safari Pilot has no coherent authentication strategy. The "real browser, real sessions" value proposition breaks down when sessions expire and the agent can't re-authenticate. Solving this makes Safari Pilot categorically superior to Playwright — which *can never* leverage stored credentials or existing sessions by design.

The strategy is sound, but 4 of 5 critical assumptions are unvalidated. Quick experiments (30 min total) should run before this becomes a roadmap commitment.

## Key Findings

- Fully automated passkey auth is **architecturally impossible** — Apple's Secure Enclave enforces per-interaction biometric verification by design. No API, MDM, or accessibility hack bypasses this. This is not a limitation to solve, it's a security guarantee to respect.
- Automated **password** auth (Keychain read → JS fill) is likely feasible via the macOS `security` CLI or Security framework, with explicit user opt-in. This is the "toggle" that makes sense.
- OAuth popup windows are invisible to the agent under current tab ownership rules — popups spawned by website JS aren't agent-owned. This blocks "Sign in with Google/GitHub/Apple" flows that use popup mode.
- "Sign in with Apple" on Safari shows a **native macOS system sheet**, not a web page. Safari Pilot cannot interact with it. User must be physically present.
- The most common personal-use case (already signed into providers in real Safari) often results in auto-SSO — the agent clicks "Sign in with X", the provider sees the existing session, and redirects back without prompting. Safari Pilot should handle this today if redirect-based, but popup-based flows are blocked.

## Strengths

- **Structural competitive advantage.** Playwright uses isolated browser contexts — it literally cannot access stored credentials. Safari Pilot controls the *real* Safari with *real* sessions. Auth support doubles down on this unique strength.
- **Clear two-mode design.** Assisted auth (user present, biometric when needed) and Keychain read (automated password fill, opt-in) cover the full spectrum from passkeys to passwords without overreaching.
- **Popup adoption is a clean security extension.** "Agent owns popups spawned from agent-owned tabs" is a defensible security rule — the agent initiated the action that created the popup. No new trust boundary is crossed.
- **Aligned with existing roadmap.** Auto-waiting (P0) and auth completion detection share infrastructure. Auth strategy benefits from and motivates the auto-waiting work.

## Risks

- **Safari may not trigger autofill on synthetic JS events.** Safari's autofill UI may only appear on trusted user gestures (real mouse/keyboard events from the OS), not JavaScript-dispatched events. If true, the "natural autofill appears" flow doesn't work, and Keychain read becomes the only automated option. This is the single biggest technical risk.
- **Keychain access approval UX.** The macOS `security` CLI prompts a system dialog asking the user to allow access. If this prompt appears on every password read (no caching), the UX is worse than just Touch ID-ing into the site directly. Need to test the caching/grace-period behavior.
- **Auth completion detection is heuristic.** There's no universal signal that auth succeeded. URL change, cookie set, DOM mutation, and page title change are all heuristics that work on most sites but fail on SPAs, progressive auth, and multi-step verification. This needs to be robust enough that the agent doesn't resume too early or wait forever.
- **Scope creep.** "Auth strategy" is 4 pillars, each non-trivial. Risk of building too much infrastructure before validating the basics work.

## Assumptions

### Validated
- Passkeys require per-interaction biometric (WebAuthn spec + Secure Enclave enforcement) — fully automated passkey auth is off the table
- Safari Pilot's current security pipeline doesn't *actively block* native auth (tab ownership, domain policy operate at the Safari Pilot layer, not at the Safari/macOS layer)
- The user wants this for all three scenarios: personal browsing, dev/testing, research

### Unvalidated
- **Safari shows autofill UI on synthetic JS focus/click** — must test: `safari_click` on a login field, observe whether Keychain/Passwords autofill dropdown appears
- **`security find-internet-password` can read Safari's stored passwords** — must test: run the command, check if it returns credentials for a known site, observe the approval prompt behavior
- **Agent can see popup windows via `safari_list_tabs`** — must test: navigate to a site with OAuth popup login, click it, check if the popup appears in tab listing
- **Auth completion can be reliably detected** — must test: measure URL change timing, cookie appearance, DOM mutations during real OAuth flows
- **Touch ID approval has a grace period for Keychain reads** — if recently authenticated, does macOS skip the re-prompt? This determines whether Keychain read mode is fluid or interruptive

## Open Questions

- Should Keychain read be implemented in the Swift daemon (Security framework) or via `security` CLI from Node? Daemon is more native but adds Swift complexity. CLI is simpler but spawns a process per read.
- How should the agent notify the user that auth is needed? macOS notification (via daemon)? Console message? Claude Code's human approval mechanism?
- Should popup adoption be automatic or require the human approval security layer? Auto-adopt is smoother but expands the trust boundary without user awareness.
- Where does this sit in the roadmap priority? It touches P0 (auto-waiting for auth completion) and creates new items. Is it P0.5? A new P1 item? Or integrated across existing items?
- Should the agent attempt to detect *what kind* of auth a page requires (password form vs. passkey vs. OAuth vs. MFA) and choose strategy accordingly? Or is that over-engineering for v1?

## If Proceeding

### Step 1: Validation Experiments (30 min, before any roadmap commitment)

Run these 4 quick tests in a single session:

1. **Synthetic autofill test:** Use `safari_click` on a login field (e.g., github.com/login). Does Safari's password autofill dropdown appear?
2. **Keychain read test:** Run `security find-internet-password -s github.com` in terminal. Does it return credentials? What approval prompt appears? Does re-running skip the prompt?
3. **Popup visibility test:** Navigate to a site with OAuth popup login (e.g., any "Sign in with Google" button). Click it. Run `safari_list_tabs`. Is the popup listed?
4. **Auth completion signal test:** Complete a real OAuth flow manually while monitoring DOM/URL/cookies via Safari Pilot's extraction tools. What signals reliably indicate auth completed?

### Step 2: Design Spec (informed by experiment results)

Write a spec for the auth strategy with these 4 pillars:

1. **Popup Adoption** — Auto-claim ownership of popups spawned from agent-owned tabs. Modify `TabOwnership` to track parent-child tab relationships.
2. **Assisted Auth** — Detect auth wall (login form, passkey prompt, OAuth redirect) → pause execution → notify user → wait for completion signal → resume. Uses auto-waiting infrastructure from P0.
3. **Keychain Read Mode (opt-in)** — Toggle in Safari Pilot config. When enabled, daemon reads stored passwords via Security framework, agent fills forms directly via JS. Passwords only.
4. **OAuth Redirect Handling** — Relax domain policy for cross-domain redirects within OAuth flows from agent-owned tabs. Detect OAuth patterns (redirect to known providers, presence of `redirect_uri` params).

### Step 3: Implement incrementally

Recommended order based on impact and dependency:
1. Popup adoption (unblocks OAuth, prerequisite for everything else)
2. Assisted auth + auth completion detection (the "pause and resume" flow)
3. OAuth redirect handling (domain policy relaxation)
4. Keychain read mode (the opt-in toggle, highest risk, most testing needed)
