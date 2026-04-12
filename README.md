# Safari Pilot

**Native Safari browser automation for AI agents on macOS.**

Safari Pilot gives Claude Code direct control of Safari through AppleScript and a persistent Swift daemon — no Chrome, no Playwright, no third-party code touching your browser. Your real Safari, with all your logins, automated natively.

> **74 tools** | **3 engine tiers** | **92x faster than raw AppleScript** | **9 security layers** | **macOS 12+**

---

## Why Safari Pilot?

| Problem with Chrome-based tools | Safari Pilot solution |
|---|---|
| Chrome heats your Mac to 97C during automation | Native WebKit — ~60% less CPU |
| Playwright/Puppeteer launch clean browsers without your logins | Uses your **real Safari** — Gmail, GitHub, Slack already signed in |
| Chrome steals window focus mid-work | Safari stays in background, never interrupts |
| Third-party MCP packages have MAIN world access to your banking tabs | Every line of code is first-party, auditable, open source |
| 80ms per command via osascript | Persistent Swift daemon: **p50 = 1ms** |

## Installation

### As a Claude Code Plugin (Recommended)

```bash
claude plugin add --from npm safari-pilot
```

This installs the MCP server, Swift daemon, and skill definition. The plugin activates automatically on macOS.

### From npm (standalone)

```bash
npm install -g safari-pilot
```

### From Source

```bash
git clone https://github.com/RTinkslinger/safari-pilot.git
cd safari-pilot
npm install
npm run build
cd daemon && swift build -c release && cp .build/release/SafariPilotd ../bin/
```

## Setup

### 1. Enable JavaScript from Apple Events (Required, one-time)

1. Open **Safari > Settings > Advanced**
2. Check **"Show features for web developers"**
3. Go to **Safari > Develop** menu
4. Check **"Allow JavaScript from Apple Events"**

This persists across Safari restarts.

### 2. Install the Safari Extension (Recommended)

The extension unlocks advanced features that are impossible without it.

**Download the signed, notarized extension** from the [latest GitHub Release](https://github.com/RTinkslinger/safari-pilot/releases/latest):

1. Download `Safari Pilot.zip`
2. Extract it
3. Open `Safari Pilot.app`
4. Go to **Safari > Settings > Extensions**
5. Enable **Safari Pilot**
6. Set to **"Allow on all websites"** when prompted
7. Click **"Manage Profiles"** and enable for your active profile

The extension is signed with Developer ID and notarized by Apple — it persists permanently across Safari restarts.

> **Troubleshooting:** If Safari shows **"Safari detected an app or service that interfered with clicking"** when you try to enable the extension, this is a Safari security feature triggered by other apps on your Mac that have Accessibility, Screen Recording, or Input Monitoring permissions (e.g., terminal emulators, screen sharing tools, window managers). To work around it:
> 1. Go to **Safari > Develop > Allow Unsigned Extensions** (check it temporarily)
> 2. Enable Safari Pilot in **Safari > Settings > Extensions**
> 3. Quit and reopen Safari
> 4. Optionally uncheck "Allow Unsigned Extensions" — the notarized extension stays enabled

**What the extension adds:**

| Feature | Without Extension | With Extension |
|---|---|---|
| Closed Shadow DOM | Invisible | Full traversal via `queryShadow` |
| Strict CSP sites (GitHub, etc.) | JS execution blocked | Bypassed via MAIN world |
| alert()/confirm()/prompt() | Blocks JS forever | Intercepted, returns instantly |
| Network request capture | Read-only via Performance API | Full intercept, mock, throttle |
| React/Vue internal state | Basic native setter | Deep framework manipulation |

Without the extension, Safari Pilot still works for ~80% of use cases (navigation, form filling, text extraction, screenshots, cookies, tab management).

### System Requirements

- **macOS 12.0 (Monterey)** or later
- **Safari** (pre-installed on every Mac)
- **Node.js 20+**

## Quick Start

Once installed, Safari Pilot activates when Claude Code detects browser tasks:

```
Browse to github.com/trending and extract the top 10 repositories
```

```
Go to my company dashboard at app.example.com and download the monthly report
```

```
Test the checkout flow on staging.mystore.com — add to cart, fill payment, verify confirmation
```

```
Monitor news.ycombinator.com for any post about our company
```

```
Open my X.com bookmarks and extract the top 5 posts with author profiles
```

## Tool Catalog (74 Tools)

### Navigation (7)
`safari_navigate` | `safari_navigate_back` | `safari_navigate_forward` | `safari_reload` | `safari_new_tab` | `safari_close_tab` | `safari_list_tabs`

### Interaction (11)
`safari_click` | `safari_double_click` | `safari_fill` | `safari_select_option` | `safari_check` | `safari_hover` | `safari_type` | `safari_press_key` | `safari_scroll` | `safari_drag` | `safari_handle_dialog`

### Extraction (7)
`safari_snapshot` | `safari_get_text` | `safari_get_html` | `safari_get_attribute` | `safari_evaluate` | `safari_take_screenshot` | `safari_get_console_messages`

### Network (8)
`safari_list_network_requests` | `safari_get_network_request` | `safari_intercept_requests` | `safari_network_throttle` | `safari_network_offline` | `safari_mock_request` | `safari_websocket_listen` | `safari_websocket_filter`

### Storage (11)
`safari_get_cookies` | `safari_set_cookie` | `safari_delete_cookie` | `safari_storage_state_export` | `safari_storage_state_import` | `safari_local_storage_get` | `safari_local_storage_set` | `safari_session_storage_get` | `safari_session_storage_set` | `safari_idb_list` | `safari_idb_get`

### Shadow DOM (2)
`safari_query_shadow` | `safari_click_shadow`

### Frames (3)
`safari_list_frames` | `safari_switch_frame` | `safari_eval_in_frame`

### Permissions & Overrides (6)
`safari_permission_get` | `safari_permission_set` | `safari_override_geolocation` | `safari_override_timezone` | `safari_override_locale` | `safari_override_useragent`

### Clipboard (2)
`safari_clipboard_read` | `safari_clipboard_write`

### Service Workers (2)
`safari_sw_list` | `safari_sw_unregister`

### Performance (3)
`safari_begin_trace` | `safari_end_trace` | `safari_get_page_metrics`

### Structured Extraction (5)
`safari_smart_scrape` | `safari_extract_tables` | `safari_extract_links` | `safari_extract_images` | `safari_extract_metadata`

### Compound Workflows (4)
`safari_test_flow` | `safari_monitor_page` | `safari_paginate_scrape` | `safari_media_control`

### Wait (1)
`safari_wait_for` — 7 condition types: selector, selectorHidden, text, textGone, urlMatch, networkidle, function

### System (2)
`safari_health_check` | `safari_emergency_stop`

## Architecture

```
Claude Code
    |
    | MCP Protocol (stdio)
    v
+--------------------------------------------------+
|  Safari Pilot MCP Server (TypeScript)             |
|                                                    |
|  Security Pipeline:                                |
|  Kill Switch -> Tab Ownership -> Domain Policy     |
|  -> Rate Limiter -> Circuit Breaker -> Audit Log   |
|                                                    |
|  Engine Selector:                                  |
|  +-----------+  +-----------+  +----------------+ |
|  | Extension |  |  Daemon   |  |  AppleScript   | |
|  | (deep DOM)|  | (1ms p50) |  | (fallback)     | |
|  +-----------+  +-----------+  +----------------+ |
+--------------------------------------------------+
    |                   |                |
    v                   v                v
+--------------------------------------------------+
|  Safari Web Extension    Swift Daemon    osascript|
|  (MAIN world access)    (persistent)   (fallback) |
+--------------------------------------------------+
    |                   |                |
    v                   v                v
+--------------------------------------------------+
|              Safari (macOS native)                 |
|  Your real browser with all your sessions          |
+--------------------------------------------------+
```

### Three Engine Tiers

| Engine | Latency | Capabilities | When Used |
|---|---|---|---|
| **Safari Web Extension** | ~10ms | Shadow DOM, CSP bypass, dialog interception, network mocking | Extension installed + feature requires it |
| **Swift Daemon** | **1ms p50** | All AppleScript capabilities, persistent process | Default when daemon is running |
| **AppleScript (osascript)** | ~90ms | Basic navigation, forms, extraction, screenshots | Fallback when daemon unavailable |

The engine selector automatically picks the best available engine for each command. Each tier falls back gracefully to the next — no configuration needed.

## Performance

Benchmarked on Apple Silicon (M-series), 20 consecutive commands:

| Metric | Daemon | AppleScript | Speedup |
|---|---|---|---|
| p50 | 0-1ms | 81-92ms | **92x** |
| p95 | 62ms | 116ms | ~2x |
| avg | 5ms | 85ms | **17x** |

Over a 500-command session, the daemon saves ~40 seconds of pure overhead vs raw AppleScript.

## Security Model

Safari Pilot runs on your local machine with access to your real browser sessions. The security model is defense-in-depth:

**Tab Ownership** — The agent can **only** interact with tabs it created via `safari_new_tab`. Your existing tabs (banking, email, personal) are untouchable. Enforced at the server level — no bypass.

**Domain Policy** — Per-domain rate limits prevent runaway automation. Banking and financial domains flagged as untrusted by default.

**Rate Limiter + Circuit Breaker** — Configurable via `safari-pilot.config.json`. Defaults: 120 actions/minute, circuit breaker trips at 5 errors with 120s cooldown.

**IDPI Scanner** — Indirect Prompt Injection defense. Scans extracted text for 9 known injection patterns.

**Kill Switch** — `safari_emergency_stop` immediately halts all automation. Configurable auto-activation on error threshold.

**Human Approval** — Sensitive actions (OAuth consent, financial forms, downloads) flagged for explicit approval.

**Audit Logging** — Every tool call logged with timestamp, tool name, URL, parameters (passwords redacted), result, and latency.

**Screenshot Redaction** — Cross-origin iframes blurred. Password fields redacted.

**No Credential Access** — Safari Pilot **never** accesses the macOS Keychain. Authentication works through real browser interaction.

## Configuration

All security settings are tunable via `safari-pilot.config.json` in the package root:

```json
{
  "schemaVersion": "1.0",
  "rateLimit": { "maxActionsPerMinute": 120, "windowMs": 60000 },
  "circuitBreaker": { "errorThreshold": 5, "windowMs": 60000, "cooldownMs": 120000 },
  "domainPolicy": { "defaultMaxActionsPerMinute": 60, "blocked": [], "trusted": [] },
  "killSwitch": { "autoActivation": false, "maxErrors": 5, "windowSeconds": 60 },
  "audit": { "maxEntries": 10000, "logPath": "~/.safari-pilot/audit.log" },
  "daemon": { "timeoutMs": 30000 },
  "healthCheck": { "timeoutMs": 3000 }
}
```

Missing file → all defaults. Partial file → deep-merge with defaults. Sensitive domain protections (banking, PayPal, etc.) cannot be overridden via config.

Set `SAFARI_PILOT_CONFIG` env var to use a custom config path.

### Daemon Lifecycle

```bash
/safari-pilot start   # Start daemon, report PID (idempotent)
/safari-pilot stop    # Graceful shutdown with SIGKILL fallback
```

## Development

### Building from Source

```bash
# TypeScript server
npm run build

# Swift daemon (rebuild + atomic swap + launchctl restart)
bash scripts/update-daemon.sh

# Safari extension (Xcode archive → sign → notarize)
bash scripts/build-extension.sh
```

### Testing

```bash
# All tests
npm test

# By category
npm run test:unit          # 777 tests, no Safari needed
npm run test:integration   # Multi-component workflows
npm run test:security      # 27 security-focused tests
npm run test:e2e           # Against real Safari (optional)

# Swift daemon tests
cd daemon && swift run SafariPilotdTests
```

### Adding a New Tool

1. Add the handler to the appropriate module in `src/tools/`
2. Follow the pattern: `getDefinitions()` returns schema, `getHandler()` returns handler
3. Write tests in `test/unit/tools/`
4. The server auto-registers tools from all modules in `initialize()`
5. Add the tool name to `skills/safari-pilot/SKILL.md` allowed-tools

## What Safari Pilot Does NOT Replace

| Use Case | Keep Using |
|---|---|
| Lighthouse / Core Web Vitals auditing | Chrome DevTools MCP |
| Cross-platform automation (Linux/Windows) | Playwright MCP |
| Headless CI browser testing | Playwright |
| Pure text extraction (no interaction needed) | Jina Reader / Firecrawl |
| Visual regression testing | Playwright snapshots |

Safari Pilot is for **interactive browsing on Mac** — especially authenticated sessions.

## FAQ

**Q: Does this work on Linux/Windows?**
No. Safari is macOS only. The plugin gracefully disables itself on non-macOS systems.

**Q: Can the agent see my banking tabs?**
No. Tab ownership enforcement means the agent can only interact with tabs it opened via `safari_new_tab`. Your existing tabs are invisible to tool calls.

**Q: What if Safari crashes during automation?**
The daemon detects Safari crashes (error codes -600/-609) and retries with exponential backoff. If Safari restarts, automation resumes.

**Q: How is this different from safari-mcp?**
Safari Pilot is built from scratch — no code from third-party Safari MCP packages. Every line that touches your browser is first-party and auditable. We also add 9 security layers, a persistent Swift daemon (92x faster), and structured extraction tools.

**Q: Does the Swift daemon run all the time?**
The daemon starts on Claude Code session start (via the SessionStart hook) and stays running between sessions for fast restart. Use `/safari-pilot stop` to shut it down manually. The LaunchAgent auto-restarts it if it crashes.

**Q: Do I need the Safari extension?**
No — Safari Pilot works without it for ~80% of use cases. The extension adds Shadow DOM traversal, CSP bypass, dialog interception, and network mocking. Install it from the [GitHub Release](https://github.com/RTinkslinger/safari-pilot/releases/latest) if you need those features.

## License

MIT — see [LICENSE](LICENSE).

## Author

Built by [Aakash Kumar](https://github.com/RTinkslinger) with Claude.
