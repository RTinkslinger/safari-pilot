# Safari Pilot — Roadmap

## Shipped (v0.1.0)

- 74 MCP tools across 14 categories
- Three engine tiers: AppleScript (fallback) → Swift Daemon (1ms p50) → Safari Web Extension (deep DOM)
- 9-layer security pipeline (tab ownership, domain policy, rate limiter, circuit breaker, IDPI scanner, human approval, screenshot redaction, kill switch, audit logging)
- Signed and notarized Safari Web Extension (Developer ID, persists across restarts)
- Published to npm (`safari-pilot`) and GitHub Releases
- CI/CD via GitHub Actions
- Live tested against Hacker News and X.com (authenticated bookmarks)

---

## Vision: Full Playwright Replacement for Mac Safari Users

The goal: **no Mac user running Claude Code should ever need Playwright or Chrome for browser automation.** Safari Pilot should match or exceed every Playwright capability, while adding what Playwright fundamentally can't do (real authenticated sessions, native WebKit, zero CPU overhead).

---

## P0 — Must Have (Closes 80% of the Playwright Gap)

### Structured Accessibility Snapshots

**The single biggest gap.** This is how Claude Code's Playwright MCP actually works — `browser_snapshot()` returns a structured ARIA tree with refs:

```
[button "Submit" ref=e42]
[textbox "Email" ref=e43 value=""]
[link "Sign in" ref=e44]
```

Claude uses `ref=e42` to click, fill, etc. It's the PRIMARY way the agent understands page structure. Without this, the agent falls back to CSS selectors which are fragile and require more reasoning.

**What to build:**
- Enhance `safari_snapshot` to return Playwright-compatible ARIA tree format
- Walk the accessibility tree via JS (`TreeWalker` + ARIA role computation)
- Assign stable element refs (hash of xpath + role + name)
- All interaction tools accept `ref` as a targeting strategy alongside `selector`
- Output format: YAML or structured text matching Playwright's snapshot format

**Requires research on:** ARIA role computation algorithm, how Playwright builds its accessibility tree, ref stability across page mutations.

**Estimated effort:** 1-2 sessions research + spec, 2 sessions implementation.

---

### Auto-Waiting on All Actions

Every Playwright action auto-waits for the target element to be visible, enabled, and stable before executing. Safari Pilot requires manual `safari_wait_for` before each action — more round-trips, more tokens, more timing bugs.

**What to build:**
- Add built-in polling to every interaction tool (click, fill, type, select, check, hover, drag)
- Before executing, poll for: element exists, element visible, element not disabled, element stable (bounding rect unchanged for 2 frames)
- Configurable timeout per action (default 5s)
- If element never becomes actionable, return structured error with hints

**Not a new tool — a behavior change in existing tools.**

**Estimated effort:** 1 session.

---

## P1 — Important (Resilience + Common Workflows)

### Locator-Style Element Targeting

Playwright has `getByRole('button', {name: 'Submit'})`, `getByText('Sign in')`, `getByLabel('Email')`, `getByTestId('submit-btn')`. CSS selectors are fragile — they break when HTML restructures. Role/text/label targeting is resilient.

**What to build:**
- Extend all interaction/extraction tools to accept: `role` + `name`, `text` (visible text match), `label` (associated label text), `testId` (data-testid attribute), `placeholder`
- Internal resolver: locator → CSS selector → DOM element
- Combine with auto-waiting: resolve locator → wait for actionable → execute

**Requires research on:** How Playwright resolves locators internally, ARIA role-to-element mapping, text matching strategies (exact vs contains vs regex).

**Estimated effort:** 1 session research, 1-2 sessions implementation.

---

### File Download Handling

Playwright has `page.waitForDownload()` — intercepts downloads, saves to path, returns metadata. Safari Pilot can't detect or handle downloads at all.

**What to build:**
- `safari_wait_for_download` tool
- Monitor `~/Downloads/` (or configured path) for new files after a triggering action
- Use macOS FSEvents via the daemon for fast file-appearance detection
- Return `{filename, path, size, mimeType, duration}`
- Option to move the downloaded file to a specified location

**Estimated effort:** 1 session.

---

### PDF Generation

Playwright has `page.pdf()` with margins, scale, headers/footers. Safari CAN print to PDF via AppleScript but we haven't exposed it.

**What to build:**
- `safari_export_pdf` tool
- Uses AppleScript print command with PDF destination
- Parameters: path, margins, scale, paperSize, landscape
- Returns `{path, pageCount, fileSize}`

**Estimated effort:** Half session. AppleScript already supports this.

---

## P2 — Valuable (Testing Infrastructure)

### CI Browser Testing

**Already on roadmap.** Test runner CLI, JUnit/TAP output, fixture serving, screenshot-on-failure, parallel execution.

**Estimated effort:** 1-2 sessions research + spec, 2-3 sessions implementation.

---

### Visual Regression Testing

**Already on roadmap.** Pixel-level diffing, baseline management, threshold config, Retina handling, diff image generation.

**Estimated effort:** 1 session research + spec, 2-3 sessions implementation.

---

### Video Recording

Playwright records video of entire browser sessions for debugging test failures.

**What to build:**
- `safari_start_recording` / `safari_stop_recording` tools
- Use macOS ScreenCaptureKit (available since macOS 12.3) via the Swift daemon
- Record only the Safari window (not entire screen)
- Output as .mp4 or .mov
- Return `{path, duration, fileSize, resolution}`

**Requires research on:** ScreenCaptureKit API for window-specific capture, video encoding options, performance impact of recording during automation.

**Estimated effort:** 1-2 sessions.

---

## P3 — Nice to Have (Edge Cases)

### Full Request/Response Route Modification

Upgrade from basic mocking (`safari_mock_request`) to full route modification — modify headers, rewrite URLs, transform response bodies in flight.

**What to build:**
- `safari_route_request` tool — register a handler that intercepts matching requests
- Parameters: urlPattern, modifyHeaders?, rewriteUrl?, transformResponse?
- Extension's MAIN world interceptor handles the modification before the page sees the response

**Estimated effort:** 1 session.

---

### HTTP Authentication

Playwright handles Basic/NTLM auth prompts via `page.authenticate()`. Safari shows a native dialog.

**What to build:**
- Extend `safari_handle_dialog` to detect and fill HTTP auth dialogs
- Or: inject credentials via the extension before the auth challenge fires
- Parameters: username, password, urlPattern

**Estimated effort:** Half session.

---

## What Safari Pilot Will Always Beat Playwright On

These are structural advantages — no amount of Playwright development can match them:

| Advantage | Why Playwright Can't Match It |
|---|---|
| **Real authenticated sessions** | Playwright uses isolated contexts by design |
| **60% less CPU** | Chromium is inherently heavier than WebKit-native |
| **No focus stealing** | Playwright's headed mode steals focus too |
| **Real Safari rendering** | Playwright's WebKit is a fork, not actual Safari |
| **Security pipeline** | Playwright has no concept of tab ownership or IDPI defense |
| **macOS-native lifecycle** | launchd, Keychain integration, ScreenCaptureKit — native OS integration |
| **Session persistence across restarts** | Playwright contexts are ephemeral by design |

---

## Estimated Total Effort to Full Parity

| Priority | Items | Sessions |
|---|---|---|
| P0 | Accessibility snapshots + auto-waiting | 4-5 |
| P1 | Locators + downloads + PDF | 3-4 |
| P2 | CI runner + visual regression + video | 6-8 |
| P3 | Route modification + HTTP auth | 1.5 |
| **Total** | **10 items** | **~15-18 sessions** |

After P0 + P1 (~8 sessions), Safari Pilot would cover 95%+ of what any Mac Claude Code user needs from a browser automation tool.
