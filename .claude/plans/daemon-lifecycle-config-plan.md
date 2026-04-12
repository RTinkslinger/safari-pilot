# Assessment: Safari Pilot Mac App Scope

## Verdict: Keep Minimal + Plugin Commands

## Key Findings
- The Mac app should remain a pure extension container — open once, enable extension, never touch again
- Daemon lifecycle management belongs in the Claude Code plugin as `/safari-pilot start` and `/safari-pilot stop`
- All configuration (rate limits, domain policies, security settings) is conversational through Claude Code
- No GUI dashboard, menu bar presence, or configuration UI — the user lives in Claude Code, not a Mac app

## Design

### Mac App (unchanged)
- Extension onboarding page: "Enable Safari Pilot in Safari Settings"
- "Quit and Open Safari Extensions Preferences" button
- Nothing else — no daemon controls, no config, no status

### Plugin Commands
- `/safari-pilot start` — starts the daemon, outputs PID, confirms running
- `/safari-pilot stop` — stops the daemon gracefully. If graceful shutdown fails, outputs `kill <PID>` fallback command
- Both commands note: "Extension is managed in Safari > Settings > Extensions"

### Configuration File (`safari-pilot.config.json`)
- Ships with sensible defaults in the plugin root — user-editable, Claude Code-editable
- Claude Code reads the file, user can edit it manually or conversationally ("set rate limit to 60/min" → Claude edits the config file)
- MCP server reads config on startup and exposes a reload mechanism

**Configurable settings (currently hardcoded):**
- `rateLimit.maxActionsPerMinute` (default: 120)
- `rateLimit.perDomain` (default: true)
- `circuitBreaker.errorThreshold` (default: 5)
- `circuitBreaker.cooldownSeconds` (default: 120)
- `polling.idleIntervalMs` (default: 5000)
- `polling.activeIntervalMs` (default: 200)
- `polling.cooldownMs` (default: 10000)
- `domainPolicy.blocked` (default: [])
- `domainPolicy.trusted` (default: [])
- `killSwitch.autoActivation` (default: false)
- `killSwitch.maxErrors` (default: 5)
- `killSwitch.windowSeconds` (default: 60)
- `audit.enabled` (default: true)
- `audit.logPath` (default: "~/.safari-pilot/audit.log")

**Hardcoded (never configurable):**
- Tab ownership enforcement (always on)
- IDPI scanner patterns (security-critical)
- Protocol version
- Extension bundle ID

**Schema versioning:** `schemaVersion: "1.0"` for future migration

## Strengths
- Dead simple — two commands cover the only lifecycle action users need
- User stays in Claude Code for everything
- No GUI maintenance burden
- Extension enablement is inherently a Safari Settings action — no point duplicating it

## Risks
- If the daemon crashes and Claude Code isn't running, user has no way to know — but this is acceptable since the daemon is only useful when Claude Code IS running

## If Proceeding
1. Create `safari-pilot.config.json` with all configurable settings and sensible defaults
2. Update MCP server to read config from file instead of hardcoded values
3. Create `/safari-pilot start` and `/safari-pilot stop` plugin commands
4. Implement daemon process management in the command scripts (find PID, start/stop, health check)
5. Fix postinstall to properly load the LaunchAgent
6. Update README to document commands and config file
7. Tests for config loading, default values, and validation
