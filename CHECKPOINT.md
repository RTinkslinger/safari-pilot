# Checkpoint
*Written: 2026-04-12 20:00*

## Current Task
Safari Pilot v0.1.0 shipped. All tasks complete. Next work: P0 roadmap items (structured a11y snapshots + auto-waiting).

## Progress
- [x] Phases 1-8 built (74 tools, 1133+ tests, Swift daemon, extension)
- [x] Tasks A-H complete (native messaging bridge, real E2E tests, signing, notarization, publishing)
- [x] Extension signed with Developer ID: `Developer ID Application: Aakash Kumar (V37WLKRXUJ)`
- [x] Extension notarized by Apple — persists across Safari restarts without "Allow Unsigned Extensions"
- [x] Published to npm: `safari-pilot@0.1.0`
- [x] GitHub Release: https://github.com/RTinkslinger/safari-pilot/releases/tag/v0.1.0
- [x] CI/CD green on GitHub Actions
- [x] README updated with correct install instructions and extension setup
- [x] Roadmap with 10 items for full Playwright parity: docs/ROADMAP.md

## Key Decisions (persisted)
- Apple Developer ID: hi@aacash.me, Team ID: V37WLKRXUJ (in memory: reference_apple_developer.md)
- System Apple ID (itouch.aakash@gmail.com) is DIFFERENT from Developer ID — always pass signing identity explicitly
- Notarytool profile: `apple-notarytool` (reusable across all apps)
- npm user: `aacash`
- Native messaging uses file-based IPC at `~/.safari-pilot/bridge/` (handler ↔ daemon)
- Extension installed via signed .app from GitHub Releases (not build-from-source)

## Next Steps
1. Read `docs/ROADMAP.md` for the full Playwright parity plan
2. P0 first: Structured accessibility snapshots (the biggest gap — how Claude reasons about pages)
3. P0 second: Auto-waiting on all interaction tools
4. Then P1: Locator-style targeting, file downloads, PDF generation
5. Each item needs: deep research → spec → implementation → E2E testing

## Context
- Repo: https://github.com/RTinkslinger/safari-pilot
- npm: https://www.npmjs.com/package/safari-pilot
- Design spec: docs/superpowers/specs/2026-04-11-safari-browser-skill-design.md
- Implementation plan: docs/superpowers/plans/2026-04-11-safari-browser-skill-plan.md
- Signing research: docs/research-xcode-signing-notarization.md
- Signing identity hash: 6E5C7C7ED0FBBFB9349B725A2C7E8F034A6C0B5F
