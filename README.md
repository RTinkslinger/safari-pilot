# Safari Pilot

Native Safari browser automation for AI agents on macOS. Safari Pilot gives Claude Code direct control of Safari through AppleScript and a native daemon — no Chrome, no Playwright, no third-party bridge. The browser you already use, automated natively.

## Installation

```bash
claude plugin add safari-pilot
```

## Prerequisites

- **macOS 12.0 (Monterey) or later**
- **Safari** (comes with macOS)
- **"Allow JavaScript from Apple Events"** enabled in Safari

To enable JS from Apple Events:
1. Open Safari
2. If you don't see a Develop menu: Safari → Settings → Advanced → check "Show features for web developers"
3. Develop → Allow JavaScript from Apple Events

For advanced features (network interception, shadow DOM, service workers), also install the Safari Web Extension bundled with this plugin.

## Quick Start

Once installed, Safari Pilot activates automatically when Claude Code detects browser tasks. You can also invoke it directly:

```
Browse to github.com/trending and extract the top 5 repositories with their star counts
```

```
Go to my company's login page at app.example.com, sign in with my saved credentials, and download the monthly report from the dashboard
```

```
Test the checkout flow on staging.mystore.com — add a product to cart, fill in test payment details, and verify the order confirmation page loads
```

## Tool Categories

Safari Pilot registers 74 tools across 14 categories:

| Category | Tools | What it does |
|----------|-------|--------------|
| Navigation | 7 | Navigate URLs, manage tabs, back/forward/reload |
| Interaction | 11 | Click, fill forms, select, type, scroll, drag, handle dialogs |
| Extraction | 7 | Snapshots, text, HTML, attributes, screenshots, console logs |
| Network | 8 | Inspect/intercept requests, throttling, offline mode, WebSocket |
| Storage | 11 | Cookies, localStorage, sessionStorage, IndexedDB |
| Shadow DOM | 2 | Query and click inside shadow roots |
| Frames | 3 | List, switch, and eval in iframes |
| Permissions | 6 | Geolocation, timezone, locale, user-agent overrides |
| Clipboard | 2 | Read and write clipboard |
| Service Workers | 2 | List and unregister service workers |
| Performance | 3 | Begin/end trace, page metrics |
| Structured Extraction | 5 | Smart scrape, tables, links, images, metadata |
| Wait | 1 | Wait for selectors, network idle, custom conditions |
| Compound | 4 | Multi-step flows, page monitoring, paginated scraping, media control |

Plus `safari_health_check` and `safari_emergency_stop` system tools.

## Architecture

```
Claude Code
    |
    | MCP protocol
    v
SafariPilotServer (src/server.ts)
    |
    |-- Security Pipeline
    |   |-- Kill Switch       (emergency stop, session-scoped)
    |   |-- Tab Ownership     (you can only touch tabs you opened)
    |   |-- Domain Policy     (rate limits per domain)
    |   |-- Rate Limiter      (actions per minute ceiling)
    |   |-- Circuit Breaker   (backs off on repeated failures)
    |   |-- Audit Log         (every action recorded)
    |
    |-- Engine Selector
    |   |-- Daemon Engine     (native macOS process, fast path)
    |   |-- AppleScript       (osascript bridge, always available)
    |   '-- Extension Engine  (Safari Web Extension, deep DOM)
    |
    v
Safari (macOS native browser)
```

## Security Model

Safari Pilot is designed to run on your local machine with your real Safari profile. The security model reflects that:

**Tab Ownership** — Claude can only interact with tabs it opened. Existing tabs (your banking, email, personal browsing) are untouchable. Ownership is enforced at the server level, not just the skill level.

**Audit Log** — Every tool call is logged with tool name, URL, parameters, result, and timestamp. The session-end hook summarizes and archives the log.

**Kill Switch** — `safari_emergency_stop` immediately halts all automation and blocks further tool calls in the session. One command, full stop.

**Domain Policy + Rate Limiter** — Per-domain rate limits prevent runaway automation. The circuit breaker backs off automatically on repeated failures to a domain.

**No Credential Storage** — Safari Pilot never reads, stores, or transmits your Safari keychain or saved passwords. Authentication happens through real browser interaction (same as you clicking).

## Contributing

Issues and PRs are welcome. Key areas for contribution:

- Extension features (additional deep-DOM capabilities)
- New compound tools (common multi-step patterns)
- Test coverage (see `test/` directory)
- Performance improvements to the daemon

When contributing, read `src/server.ts` to understand the tool registration pattern, then add your tool to the appropriate module in `src/tools/`. All tools must pass the security pipeline — there are no bypass escape hatches.

## License

MIT — see [LICENSE](LICENSE).
