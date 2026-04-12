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

## P0 — Must Have (Foundations + Closes 80% of the Playwright Gap)

### Daemon Lifecycle + Configuration File (NEXT UP)

**Plugin commands for daemon management + user-editable config file.** Currently the daemon has no lifecycle management and all settings (rate limits, circuit breaker, polling) are hardcoded in TypeScript source.

**What to build:**
- `safari-pilot.config.json` — ships with sensible defaults, user-editable and Claude Code-editable. MCP server reads config on startup. Settings include rate limits, circuit breaker thresholds, polling intervals, domain policies, kill switch, audit logging.
- `/safari-pilot start` — starts SafariPilotd, outputs PID, confirms running (idempotent)
- `/safari-pilot stop` — stops daemon gracefully; if shutdown fails, outputs `kill <PID>` fallback
- Both commands note that the extension is managed in Safari > Settings > Extensions
- Fix postinstall to properly `launchctl load` the LaunchAgent
- Conversational config: user says "set rate limit to 60/min" → Claude Code edits the config file

**Hardcoded (not configurable):** tab ownership, IDPI scanner patterns, protocol version, extension bundle ID.

**Mac app stays unchanged** — extension container only.

**Research:** `mcp-plugin-config-best-practices.md` (plugin root)
**Plan:** `.claude/plans/daemon-lifecycle-config-plan.md`
**Estimated effort:** 1 session.

---

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

**Research:** `docs/research/p0-accessibility-snapshots-research.md`
**Key findings:** Safari supports `computedRole`/`computedName` since 16.4. Refs are monotonic counters (not hashes). ~300-400 lines JS. Native macOS AX APIs not recommended (too slow, can't correlate to DOM).
**Estimated effort:** 2-3 sessions (revised from research).

---

### Auto-Waiting on All Actions

Every Playwright action auto-waits for the target element to be visible, enabled, and stable before executing. Safari Pilot requires manual `safari_wait_for` before each action — more round-trips, more tokens, more timing bugs.

**What to build:**
- Add built-in polling to every interaction tool (click, fill, type, select, check, hover, drag)
- Before executing, poll for: element exists, element visible, element not disabled, element stable (bounding rect unchanged for 2 frames)
- Configurable timeout per action (default 5s)
- If element never becomes actionable, return structured error with hints

**Not a new tool — a behavior change in existing tools.**

**Research:** `docs/research/p0-auto-waiting-research.md`
**Key findings:** Entire wait+action executes in one JS injection (no round-trips). rAF-based stability check. Playwright uses backoff schedule `[0, 20, 50, 100, 100, 500]ms`. Must verify Safari's `do JavaScript` awaits Promises.
**Estimated effort:** 1 session.

---

## P1 — Important (Resilience + Common Workflows)

### Locator-Style Element Targeting

Playwright has `getByRole('button', {name: 'Submit'})`, `getByText('Sign in')`, `getByLabel('Email')`, `getByTestId('submit-btn')`. CSS selectors are fragile — they break when HTML restructures. Role/text/label targeting is resilient.

**What to build:**
- Extend all interaction/extraction tools to accept: `role` + `name`, `text` (visible text match), `label` (associated label text), `testId` (data-testid attribute), `placeholder`
- Internal resolver: locator → CSS selector → DOM element
- Combine with auto-waiting: resolve locator → wait for actionable → execute

**Research:** `docs/research/p1-locator-targeting-research.md`
**Key findings:** CSS pre-filter + AccName post-filter. ~300 lines JS, no external libs. Substring matching is default (not exact). Playwright's retry backoff: `[0, 20, 100, 100, 500]ms`.
**Estimated effort:** 1-2 sessions (research done).

---

### File Download Handling

Playwright has `page.waitForDownload()` — intercepts downloads, saves to path, returns metadata. Safari Pilot can't detect or handle downloads at all.

**What to build:**
- `safari_wait_for_download` tool
- Monitor `~/Downloads/` (or configured path) for new files after a triggering action
- Use macOS FSEvents via the daemon for fast file-appearance detection
- Return `{filename, path, size, mimeType, duration}`
- Option to move the downloaded file to a specified location

**Research:** `docs/research/p1-file-downloads-research.md`
**Key findings:** FSEvents + DispatchSource hybrid. Safari's `.download` bundle rename = completion signal. ~50ms detection latency. `kMDItemWhereFroms` xattr for source URL.
**Estimated effort:** 1 session.

---

### PDF Generation

Playwright has `page.pdf()` with margins, scale, headers/footers. Safari CAN print to PDF via AppleScript but we haven't exposed it.

**What to build:**
- `safari_export_pdf` tool
- Uses AppleScript print command with PDF destination
- Parameters: path, margins, scale, paperSize, landscape
- Returns `{path, pageCount, fileSize}`

**Research:** `docs/research/p1-pdf-generation-research.md`
**Key findings:** Playwright can't do PDF from WebKit at all (structural advantage). `WKWebView.printOperationWithPrintInfo` via daemon is the path. AppleScript print has no output path control. CSS `@page` supported since Safari 18.2.
**Estimated effort:** 2-3 sessions (revised up — WKWebView daemon path needed for full Playwright parity).

---

## P2 — Valuable (Testing Infrastructure)

### CI Browser Testing

**Already on roadmap.** Test runner CLI, JUnit/TAP output, fixture serving, screenshot-on-failure, parallel execution.

**Research:** `docs/research/p2-ci-browser-testing-research.md`
**Key findings:** Safari Pilot doesn't need safaridriver. Daemon/extension engines avoid TCC. No headless Safari exists. Tab-level isolation with AppleScript mutex for parallelism. `sudo safaridriver --enable` is the only reliable CI setup.
**Estimated effort:** 4-5 sessions (revised — 3 phases: MVP, parallel+retries, CI templates).

---

### Visual Regression Testing

**Already on roadmap.** Pixel-level diffing, baseline management, threshold config, Retina handling, diff image generation.

**Research:** `docs/research/p2-visual-regression-research.md`
**Key findings:** pixelmatch + pHash triage + SSIM on failure. Store baselines at native 2x. macOS version must be part of baseline key (font smoothing changes). Threshold 0.15-0.2 for Safari (default 0.1 too strict).
**Estimated effort:** 2-3 sessions.

---

### Video Recording

Playwright records video of entire browser sessions for debugging test failures.

**What to build:**
- `safari_start_recording` / `safari_stop_recording` tools
- Use macOS ScreenCaptureKit (available since macOS 12.3) via the Swift daemon
- Record only the Safari window (not entire screen)
- Output as .mp4 or .mov
- Return `{path, duration, fileSize, resolution}`

**Research:** `docs/research/p2-video-recording-research.md`
**Key findings:** ScreenCaptureKit with `SCContentFilter(desktopIndependentWindow:)` for window-specific capture. H.264 via VideoToolbox (hardware-accelerated). 8-25% CPU on Apple Silicon at 720p/20fps. No viable alternatives (screencapture CLI can't do window-specific video).
**Estimated effort:** 1-2 sessions.

---

## P3 — Nice to Have (Edge Cases)

### Full Request/Response Route Modification

Upgrade from basic mocking (`safari_mock_request`) to full route modification — modify headers, rewrite URLs, transform response bodies in flight.

**What to build:**
- `safari_route_request` tool — register a handler that intercepts matching requests
- Parameters: urlPattern, modifyHeaders?, rewriteUrl?, transformResponse?
- Extension's MAIN world interceptor handles the modification before the page sees the response

**Research:** `docs/research/p3-route-modification-research.md`
**Key findings:** DNR + MAIN world JS interceptor hybrid achieves ~85% Playwright coverage. Full engine-level interception impossible (no WebKit Inspector Protocol). Existing extension infra already supports DNR rules and MAIN world monkey-patching.
**Estimated effort:** 1 session.

---

### HTTP Authentication

Playwright handles Basic/NTLM auth prompts via `page.authenticate()`. Safari shows a native dialog.

**What to build:**
- Extend `safari_handle_dialog` to detect and fill HTTP auth dialogs
- Or: inject credentials via the extension before the auth challenge fires
- Parameters: username, password, urlPattern

**Research:** `docs/research/p3-http-auth-research.md`
**Key findings:** DNR header injection (`Authorization: Basic`) is the primary path — existing `dnr_add_rule`/`dnr_remove_rule` in background.js already supports it. Manifest may need `declarativeNetRequestWithHostAccess`. NTLM needs multi-step challenge-response (different approach).
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

| Priority | Items | Sessions (revised from research) |
|---|---|---|
| P0 | Daemon lifecycle + a11y snapshots + auto-waiting | 1 + 2-3 + 1 = **4-5** |
| P1 | Locators + downloads + PDF | 1-2 + 1 + 2-3 = **4-6** |
| P2 | CI runner + visual regression + video | 4-5 + 2-3 + 1-2 = **7-10** |
| P3 | Route modification + HTTP auth | 1 + 0.5 = **1.5** |
| **Total** | **11 items** | **~17-22 sessions** |

After P0 + P1 (~9-11 sessions), Safari Pilot would cover 95%+ of what any Mac Claude Code user needs from a browser automation tool.

**Additional research (post-roadmap):**
- Auth strategy: `docs/research/auth-strategy-research.md` + `.claude/plans/auth-strategy-assessment.md`
- Extension enablement: `docs/research/safari-extension-enablement-research.md`
- Extension RCA: `docs/research/extension-rca-audit.md`
