# Checkpoint
*Written: 2026-04-12 18:45*

## Current Task
Execute Tasks A-H: wire native messaging bridge, rebuild extension, E2E test extension features, sign + notarize extension, publish. Also fix CI/CD errors on GitHub.

## Progress
- [x] Phases 1-8 built (74 tools, 1167+ tests, Swift daemon, extension source)
- [x] Extension installed in Safari (unsigned, "Allow Unsigned Extensions" enabled)
- [x] Extension content scripts confirmed injected (window.__safariPilot with 7 functions)
- [x] Dialog interception, Shadow DOM traversal, framework detection tested live via AppleScript→extension functions
- [x] GitHub repo: https://github.com/RTinkslinger/safari-pilot
- [x] Ultra research on Xcode signing/notarization complete — saved to docs/research-xcode-signing-notarization.md
- [x] Ultra research on certificate installation complete — Xcode is the correct path, not openssl CLI
- [x] Developer ID Application certificate installed: `Developer ID Application: Aakash Kumar (V37WLKRXUJ)`
- [x] Notarytool credentials stored: `--keychain-profile "apple-notarytool"` (validated, uses hi@aacash.me)
- [x] npm authenticated as `aacash`
- [ ] **Task A: Wire SafariWebExtensionHandler as message relay**
- [ ] **Task B: Update daemon to use bridge directory IPC**
- [ ] **Task C: Update background.js to use sendNativeMessage**
- [ ] **Task D: Rebuild extension**
- [ ] **Task E: Real E2E tests (CSP bypass, network capture, closed Shadow DOM, full round-trip)**
- [ ] **Task F: Restore weakened network test**
- [ ] **Task G: Sign + notarize extension with Developer ID**
- [ ] **Task H: Publish signed extension + update distribution**
- [ ] **Fix CI/CD errors on GitHub**

## Key Decisions (not yet persisted)
1. System Apple ID (`itouch.aakash@gmail.com`) is DIFFERENT from Developer Apple ID (`hi@aacash.me`) — all build scripts MUST explicitly pass `DEVELOPMENT_TEAM=V37WLKRXUJ` and `CODE_SIGN_IDENTITY="Developer ID Application: Aakash Kumar (V37WLKRXUJ)"` — never auto-detect
2. Notarytool profile named `apple-notarytool` (NOT app-specific — reusable for all apps)
3. Signing order: .appex FIRST, then .app container (inside-out, never --deep)
4. Must use `--options runtime --timestamp` for Hardened Runtime (required for notarization)
5. Do NOT include `com.apple.security.get-task-allow = true` entitlement (breaks notarization)
6. Safari native messaging goes through SafariWebExtensionHandler.beginRequest(with:) — NOT direct stdin/stdout to daemon
7. Weakened network test must be restored to a REAL test — corner-cutting was called out

## Next Steps
1. Start Task A: Modify `app/Safari Pilot/Safari Pilot Extension/SafariWebExtensionHandler.swift`
   - Currently a stub that echoes messages
   - Needs to: receive commands from extension, execute AppleScript or relay to daemon, send results back
   - IPC options: shared directory at `~/.safari-pilot/bridge/`, or direct AppleScript execution within the handler
2. Task B: Update daemon ExtensionBridge for the chosen IPC mechanism
3. Task C: Update `extension/background.js` — switch from `connectNative()` to `sendNativeMessage()`
4. Task D: Rebuild with `bash scripts/build-extension.sh`
5. Task E: Write real E2E tests for CSP bypass, network capture, closed Shadow DOM
6. Task F: Restore weakened test in `test/e2e/extension-live.test.ts`
7. Task G: Update build-extension.sh with signing:
   ```bash
   codesign --force --options runtime --timestamp \
     --sign "Developer ID Application: Aakash Kumar (V37WLKRXUJ)" \
     "Safari Pilot.app/Contents/PlugIns/Safari Pilot Extension.appex"
   codesign --force --options runtime --timestamp \
     --sign "Developer ID Application: Aakash Kumar (V37WLKRXUJ)" \
     "Safari Pilot.app"
   ditto -c -k --keepParent "Safari Pilot.app" "Safari Pilot.zip"
   xcrun notarytool submit "Safari Pilot.zip" --keychain-profile "apple-notarytool" --wait
   xcrun stapler staple "Safari Pilot.app"
   ```
8. Task H: Upload to GitHub Releases, update postinstall, publish npm
9. Check and fix CI/CD errors on GitHub Actions

## Context
- Signing identity hash: `6E5C7C7ED0FBBFB9349B725A2C7E8F034A6C0B5F`
- Full identity: `Developer ID Application: Aakash Kumar (V37WLKRXUJ)`
- Team ID: `V37WLKRXUJ`
- Apple ID (developer): `hi@aacash.me`
- System Apple ID (DO NOT USE for signing): `itouch.aakash@gmail.com`
- Notarytool profile: `apple-notarytool`
- npm user: `aacash`
- SafariWebExtensionHandler stub at: `app/Safari Pilot/Safari Pilot Extension/SafariWebExtensionHandler.swift`
- Extension background.js currently uses `browser.runtime.connectNative('com.safari-pilot.daemon')` — needs to switch to `browser.runtime.sendNativeMessage()`
- GitHub repo has CI errors that need fixing after push
- Safari's native messaging: extension calls sendNativeMessage → Safari routes to SafariWebExtensionHandler.beginRequest(with:) → handler processes → responds via context.completeRequest
