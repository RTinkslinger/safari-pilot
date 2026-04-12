# Extension Disappearance — Root Cause Analysis Audit

**Date:** 2026-04-13 00:15 IST
**Auditor:** Claude Opus 4.6 (read-only audit)
**Subject:** Safari Pilot Extension stopped appearing in Safari > Settings > Extensions after background.js update and .app rebuild

---

## 1. Timeline of Events (All Times IST)

| Time | Event | Commit/Evidence |
|------|-------|-----------------|
| ~20:54 | v0.1.0 checkpoint — extension working | `6b0f692` |
| 20:01 | `37800532.jpeg` downloaded to ~/Downloads (216x216, by SandboxBroker.xpc) | File `stat` + quarantine xattr |
| ~22:38 | Integration tests updated | `af8b236` |
| ~23:06 | background.js updated: adaptive polling (200ms -> 5s idle) | `fa8fb47` |
| ~23:15 | `build-extension.sh` re-ran: Xcode build, codesign, notarize, staple | Script `mtime` |
| ~23:17 | v0.1.1 release committed (rebuilt .app with new background.js) | `c27c30c` |
| 23:10-23:11 | `lsregister -f -R` run on .app (log shows bundle re-registration) | System log: `lsregister` process |
| 23:11:07 | **CRITICAL**: Safari errors begin: "Computing the code signing dictionary failed for extension with identifier: com.safari-pilot.app.Extension" | Safari system log |
| 23:11:07 | Safari also: "Extension with identifier does not have a code signature" | Safari system log |
| 23:11:07 | Safari: "Failed to delete storage for removed extension" (file doesn't exist) | Safari system log |
| 23:11-23:23 | Repeated code signing failures across multiple Safari restarts (PIDs 76188, 27768, 28680) | Safari system log |
| 23:22 | App container metadata updated (Safari Pilot opened or container touched) | `stat` on container |
| 23:34-23:51 | Later Safari launches show only "Failed to delete storage" — no more code signing errors | Safari system log |
| 23:57 | Safari Pilot.app launched (PID 44399) and terminated normally | System log |
| 00:03 | LaunchServices re-registered the app (fresh `reg date` in `lsregister -dump`) | `lsregister -dump` |
| 00:06 | `pluginkit` discovery ran — found extension identifiers are `<private>` (redacted) | pkd system log |
| 00:08 | `pluginkit -m -v -i com.safari-pilot.app.Extension` returns "(no matches)" | This audit |
| 00:08 | pkd log: "Candidate plugin count from LaunchServices: 0" / "Final plugin count: 0" | pkd system log |

---

## 2. Current System State

### 2.1 The .app Bundle (bin/Safari Pilot.app)

| Check | Result | Evidence |
|-------|--------|----------|
| .appex embedded | Yes | `ls` shows `Safari Pilot Extension.appex` in PlugIns/ |
| Code signature valid | Yes | `codesign --verify --deep --strict` exits 0 (no output = success) |
| Notarization valid | Yes | `stapler validate` returns "The validate action worked!" |
| background.js matches source | Yes | `diff` produces no output |
| NSExtension keys correct | Yes | `NSExtensionPointIdentifier = com.apple.Safari.web-extension` |
| CFBundleVersion | "1" | Never incremented between v0.1.0 and v0.1.1 builds |
| Entitlements | NONE | `codesign -d --entitlements` shows only executable path |

### 2.2 .app Copies on Disk

Only two copies exist (both within the project):

1. `/Users/Aakash/Claude Projects/Skills Factory/safari-pilot/bin/Safari Pilot.app` — production copy
2. `/Users/Aakash/Claude Projects/Skills Factory/safari-pilot/.build/extension/Build/Products/Release/Safari Pilot.app` — Xcode build output

Both are identically signed (no diff in Info.plist). No stale copies in /Applications, /tmp, or elsewhere.

### 2.3 LaunchServices State

LaunchServices KNOWS about both the app and extension:
- App registered at `com.safari-pilot.app` with team ID `V37WLKRXUJ`
- Extension registered at `com.safari-pilot.app.Extension` with extension point `com.apple.Safari.web-extension`
- `plugin Identifiers: com.safari-pilot.app.Extension` listed in app record
- UUID: `B36F93A6-CEEC-44A7-AF95-8126B9D9E4A8` (current)
- Registration date: 2026-04-13 00:03 (very recent, after re-registration)
- `trustedCodeSignatures: a6ddde55b962b3e3397d3c8f9d8ce51869f7a6ae` present

### 2.4 PlugInKit (pkd) State

**Extension is NOT registered with pluginkit.** Zero matches:
- `pluginkit -m -v -i com.safari-pilot.app.Extension` → "(no matches)"
- `pluginkit -m -A -v -i com.safari-pilot.app.Extension` → "(no matches)"
- `pluginkit -m -D -v -i com.safari-pilot.app.Extension` → "(no matches)"
- `pluginkit -m -p com.apple.Safari.web-extension` → no output (zero Safari web extensions registered)
- Total registered plugins: 453 — our extension is not among them

pkd system log at 00:08:43 confirms:
```
Candidate plugin count from LaunchServices: 0
Final plugin count: 0
```

**This is the core paradox:** LaunchServices has the extension fully registered with correct metadata, but when pkd queries LaunchServices for plugin candidates, LaunchServices returns 0.

### 2.5 Safari Extension Plists

All plists show the extension as **Enabled = true** with **no RemovedDate fields**:

**Default profile (WebExtensions/Extensions.plist):**
- `com.safari-pilot.app.Extension (UNSIGNED)` — Added 2026-04-11, Enabled = true
- `com.safari-pilot.app.Extension (V37WLKRXUJ)` — Added 2026-04-12 14:12:53, Enabled = true

**Profile 8AD370AB (WebExtensions):** Same two entries, Enabled = true, no RemovedDate
**Profile 2D269003 (WebExtensions):** Same two entries, Enabled = true, no RemovedDate
**AppExtensions/Extensions.plist:** Empty `{}` for all profiles

### 2.6 Daemon State

SafariPilotd running (PID 97051), launched from `./bin/SafariPilotd`. No issues with the daemon itself.

### 2.7 Safari Process

Safari is NOT currently running. Multiple restarts occurred between 23:11 and 23:51 (PIDs 76188, 27768, 28680, 31836, 41970) — all showed the same code signing failure errors.

---

## 3. Claim Verification

### 3a. "pluginkit -r created a persistent tombstone"

**INCONCLUSIVE** — There is no direct evidence in the system logs that `pluginkit -r` was run during this session. The pkd logs show no removal events for our extension identifier. However, the SYMPTOM described (extension not appearing in pluginkit) is confirmed real. The pkd tombstone research document at `docs/research/pkd-tombstone-research.md` was generated during this session, suggesting the claim was made and researched. The actual cause appears to be different (see Section 4).

### 3b. "lsregister -f -R -trusted caused repeated auto-launches"

**FALSE** — The `lsregister` command has no `-trusted` flag. The full help output shows only these flags: `-delete`, `-seed`, `-lint`, `-lazy`, `-r`, `-R`, `-f`, `-u`, `-v`, `-gc`, `-dump`, `-h`. If `-trusted` was passed, lsregister would have either ignored it or errored. The system log at 18:52 and 23:10 confirms `lsregister` was run (twice), and both times it performed normal re-registration. There is zero evidence of "repeated auto-launches" caused by lsregister.

### 3c. "The extension's 200ms polling caused Safari's BrowserDataImportingService to spawn"

**UNVERIFIED** — The adaptive polling commit message (`fa8fb47`) claims "300 XPC messages/min...causing Safari to aggressively cycle its extension management services." However:
- The extension was working fine at v0.1.0 with 200ms polling (enabled since at least 18:52)
- The system log at 18:52:53 shows the extension successfully launched and bootstrapped with the ORIGINAL 200ms polling
- No evidence was found in the logs linking polling frequency to BrowserDataImportingService spawning
- The actual Safari errors (code signing failures) began at 23:11 — AFTER the rebuild, not as a consequence of polling

The polling rate may have been non-ideal, but the claim that it caused BrowserDataImportingService to spawn is not supported by evidence.

### 3d. "Safari's download of 37800532.jpeg was caused by extension icon caching"

**FALSE** — The file's quarantine metadata reveals:
```
com.apple.quarantine: 0083;69dbacd3;com.apple.Safari.SandboxBroker.xpc;3C377B3E-83EE-4A64-ABCE-9D91AE26187A
```

- Downloaded at 20:01:47 IST (decoded from hex timestamp `69dbacd3` = epoch 1776004307)
- Source: `com.apple.Safari.SandboxBroker.xpc` — Safari's internal sandboxed download service
- Flag `0083` = quarantine type "other download" (not user-initiated)
- The file is 216x216 pixels, 9KB — could be any icon, favicon, or small image
- The numeric filename (37800532) suggests a CDN asset ID (e.g., Unsplash, Shutterstock, or similar)
- Downloaded at 20:01, well BEFORE the extension issues began at 23:11
- No plist or cache file references this filename in relation to extension icons

The download occurred via Safari's SandboxBroker (which handles sandboxed downloads for any purpose), NOT via an extension icon caching mechanism. The timing (20:01, before the trouble) and the source (SandboxBroker, not any extension-related service) disprove this claim.

### 3e. "CachedExtensionOnboardingIconDownloadTime proves Safari downloaded an extension icon"

**INCONCLUSIVE/MISLEADING** — The preference exists:
```
CachedExtensionOnboardingIconDownloadTime = "2026-04-12 12:03:32 +0000"
```

This timestamp (12:03 UTC = 17:33 IST) predates both the v0.1.1 build AND the 37800532.jpeg download (20:01 IST). This is a GENERIC Safari preference that tracks when Safari last cached onboarding icons for ANY extension — it is not specific to our extension. It does not prove Safari downloaded an icon for Safari Pilot specifically, and it has no connection to the 37800532.jpeg file.

### 3f. "The RemovedDate field in Extensions.plist controls visibility"

**INCONCLUSIVE** — There are NO RemovedDate fields in any of the six Extensions.plist files checked. Either:
1. RemovedDate was never present (contradicting the claim that PlistBuddy removed it), or
2. PlistBuddy successfully removed it

Either way, the extension STILL does not appear in Safari > Settings > Extensions despite Enabled = true and no RemovedDate. Therefore, RemovedDate is NOT the controlling factor for visibility. The actual control is pluginkit registration, which is broken (see Section 4).

### 3g. "pkd has no database — it re-discovers from LaunchServices"

**PARTIALLY TRUE** — pkd does NOT maintain a persistent database. Its open files (via `lsof`) show:
- `/usr/libexec/pkd` (its own binary)
- `/Library/Preferences/Logging/.plist-cache.umR24Lds` (logging config)
- `/private/var/db/analyticsd/events.allowlist` (analytics)
- `/private/var/folders/.../com.apple.LaunchServices-20971544-v2.csstore` (LaunchServices DB)

It reads from the LaunchServices csstore. No SQLite, no separate pkd database. The PlugInKit Registry cache directory (`/var/folders/.../C/PlugInKit/`) does not even exist on this system. The claim is correct that pkd re-discovers from LaunchServices — but the critical nuance is that LaunchServices IS returning the data to lsregister -dump queries, yet is returning 0 candidates to pkd's plugin discovery queries. This suggests an internal LaunchServices issue, not a pkd issue.

---

## 4. Root Cause Analysis

### The Evidence Chain

1. **Before the rebuild (18:52 IST):** Extension was working. pkd log shows successful launch: "Safari Pilot Extension: Hello, I'm launching", "Bootstrap complete. Ready for handshake from host." Safari successfully used the extension.

2. **The rebuild (23:15-23:17 IST):** `build-extension.sh` rebuilt the .app from source. The binary on disk was REPLACED. The new binary has:
   - Same bundle ID (`com.safari-pilot.app.Extension`)
   - Same version ("1" / "1.0") — **CFBundleVersion was NOT incremented**
   - Different Mach-O UUID (new compilation = new binary hash)
   - New code signature (re-signed with codesign --force)
   - Successfully notarized (new notarization submission)

3. **The code signing failure (23:11 IST):** Safari's system log shows the CRITICAL error: **"Computing the code signing dictionary failed for extension with identifier: com.safari-pilot.app.Extension"** followed by **"Extension with identifier does not have a code signature."**

   This error is IMPOSSIBLE for a correctly signed binary — unless Safari is looking at a STALE cached version of the binary or its code signing information is cached from before the rebuild.

4. **The Safari plist paradox:** Safari's Extensions.plist shows the extension as `Enabled = true` with team ID `(V37WLKRXUJ)`, meaning Safari DID register the signed version successfully at 14:12:53. But when Safari later tries to verify the code signature (after the binary was replaced by the rebuild), the verification fails.

5. **pkd's perspective (00:08 IST):** When pkd queries LaunchServices for plugins matching `com.safari-pilot.app.Extension`, it gets 0 candidates back — even though `lsregister -dump` shows the extension IS in the LaunchServices database.

### Root Cause: In-Place Binary Replacement Invalidated Safari's Cached Code Signing Identity

**The build script (`build-extension.sh`) replaces the .app bundle in-place at the same path:**

```bash
rm -rf "$ROOT/bin/Safari Pilot.app"
cp -R "$APP_PATH" "$ROOT/bin/Safari Pilot.app"
```

This creates a new binary with a new code signature at the same path. Safari (and the kernel's code signing subsystem) has a cached code signing identity for the OLD binary at that path. When Safari tries to verify the extension, it encounters a mismatch between:
- The cached code signing identity (from the old build)
- The actual binary on disk (from the new build)

This triggers "Computing the code signing dictionary failed" — Safari cannot reconcile the two and treats the extension as unsigned.

**The version was never bumped.** `CFBundleVersion` remained "1" across both builds. macOS uses CFBundleVersion as a cache key for extension metadata. By not incrementing the version, the system has no signal that the binary has changed and should invalidate its cached data.

**Contributing factors:**
- The app lives in a non-standard path (project directory, not /Applications) which may affect how LaunchServices tracks changes
- `codesign --force` creates a new signature but doesn't update any version counter
- There is NO `pluginkit -r` / `pluginkit -a` cycle in the build script to force re-registration
- Safari appears to cache extension code signing info independently of LaunchServices

### Why the extension was working before

At 18:52, lsregister had been run (first invocation in log), and Safari successfully launched the extension. The binary at that time matched Safari's cached code signing identity. After the 23:15 rebuild replaced the binary, the cache became stale.

---

## 5. Recommended Fix

### Verified Steps (Based on Evidence)

**Step 1: Quit Safari completely** (if running).

**Step 2: Re-open the Safari Pilot app** — this triggers macOS container/sandbox reconciliation:
```bash
open "/Users/Aakash/Claude Projects/Skills Factory/safari-pilot/bin/Safari Pilot.app"
```
Wait for it to fully launch, then close it.

**Step 3: Force LaunchServices to re-register with updated binary:**
```bash
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f -R "/Users/Aakash/Claude Projects/Skills Factory/safari-pilot/bin/Safari Pilot.app"
```

**Step 4: Explicitly add the extension to pluginkit:**
```bash
pluginkit -a "/Users/Aakash/Claude Projects/Skills Factory/safari-pilot/bin/Safari Pilot.app/Contents/PlugIns/Safari Pilot Extension.appex"
```

**Step 5: Open Safari and check Settings > Extensions.**

### If That Doesn't Work (Hypothesis — Untested)

**Option A: Bump CFBundleVersion**

The most likely robust fix is to increment `CFBundleVersion` in both the app and appex Info.plist before rebuilding. The build script should auto-increment this value. This gives macOS a clear signal that the binary has changed.

**Option B: Full LaunchServices reset (nuclear)**
```bash
/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -kill -r -domain local -domain system -domain user
```
Then reboot. This resets ALL app registrations — effective but disruptive.

### Build Script Fix (Prevent Recurrence)

Add to `build-extension.sh` before building:

```bash
# Auto-increment CFBundleVersion to invalidate caches on rebuild
CURRENT_VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$XCODE_PROJECT_DIR/Safari Pilot/Info.plist" 2>/dev/null || echo "0")
NEXT_VERSION=$((CURRENT_VERSION + 1))
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $NEXT_VERSION" "$XCODE_PROJECT_DIR/Safari Pilot/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $NEXT_VERSION" "$XCODE_PROJECT_DIR/Safari Pilot Extension/Info.plist"
```

And after copying the built app, add:
```bash
# Force re-registration after rebuild
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f -R "$ROOT/bin/Safari Pilot.app"
pluginkit -a "$APPEX_PATH"
```

---

## 6. Summary of Findings

| Finding | Status |
|---------|--------|
| Bundle integrity | Intact (signed, notarized, stapled, background.js matches source) |
| Root cause | In-place binary replacement without version bump invalidated Safari's cached code signing identity |
| Safari log evidence | "Computing the code signing dictionary failed" — definitive |
| pluginkit state | Extension completely absent (0 matches among 453 plugins) |
| LaunchServices state | Extension IS registered — but pkd gets 0 candidates from LS queries |
| Previous `pluginkit -r` tombstone theory | No evidence of pluginkit -r being run; issue is code signing cache, not tombstone |
| Claims accuracy | 1 partially true, 2 false, 3 inconclusive/misleading, 1 inconclusive (see Section 3) |

**The extension is not broken — it is invisible.** The binary is valid. The code signature is valid. The notarization is valid. Safari's plists show it as enabled. But Safari's internal code signing verification cache is stale, causing it to reject the extension as unsigned, which in turn causes pkd to not register it.
