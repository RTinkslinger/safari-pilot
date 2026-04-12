# pkd Tombstone Research: Clearing a Persistent `pluginkit -r` Entry on macOS

**Date:** 2026-04-12
**Context:** After running `pluginkit -r` on Safari Web Extension `com.safari-pilot.app.Extension`, a persistent tombstone (23-byte stub binary plist, UUID `ECF19A18-7AA6-4141-B4DC-A2E5123B2B5C`) blocks re-registration via `pluginkit -a`. Survives pkd restarts, app re-opens, lsregister re-registration, and fresh app downloads.

---

## 1. Where Does pkd Store Its Database/State?

### The pkd Registry (Ephemeral)

According to the `pkd(8)` man page, the PlugInKit registry file is located at:

```
$(getconf DARWIN_USER_CACHE_DIR)/PlugInKit/Registry
```

This resolves to a path like:
```
/private/var/folders/XX/XXXXXXXXXX/C/PlugInKit/Registry
```

The `pkd` daemon also accepts a `-d database` flag to use an alternate registry database file, and `-W` to print the PlugInKit directory location to stdout.

**Key insight:** This registry is **ephemeral**. According to Howard Oakley's detailed analysis at The Eclectic Light Company, "each of those appears to be built from scratch during startup." The pkd daemon rebuilds its registry during every user login by performing a "discovery" process that reads from the LaunchServices database. The registry contains annotations like when appexes were last managed and whether they have been "elected."

### pkd Working Directory

pkd uses "working files and folders buried in a locked directory deep in `/var/folders`." These are also transient -- they do not persist the tombstone.

### The Persistent Store: LaunchServices csstore

The **actually persistent** database is the LaunchServices csstore file:

```
$(getconf DARWIN_USER_DIR)/com.apple.LaunchServices.dv/com.apple.LaunchServices-<VERSION>-v2.csstore
```

Typical path example:
```
/private/var/folders/zz/zyxvpxvq6csfxvn_n0000000000000/0/com.apple.LaunchServices-231-v2.csstore
```

This is a per-user file in a proprietary, undocumented "CoreServicesStore" format (binary plist variant). Of the four services involved (LaunchServices, RunningBoard, DAS, PlugInKit), **only LaunchServices maintains a database that persists across restarts**.

---

## 2. How to Clear a pluginkit Tombstone

### Method A: Targeted Safari Re-registration (Preferred -- Minimal Disruption)

Discovered by Jeff Johnson (lapcatsoftware.com) while investigating disappearing Safari web extensions:

```bash
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f -R /Applications/Safari.app
```

This forces LaunchServices to re-register Safari and all its extension points (including `com.apple.Safari.web-extension`). Johnson confirmed via `lsregister -dump` that the extension point was missing before and present after this command. After running it, `pluginkit --match` correctly listed previously-missing extensions.

**For a custom app like safari-pilot**, the equivalent command would target the app bundle:

```bash
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f -R /path/to/SafariPilot.app
```

### Method B: Full LaunchServices Database Reset (Nuclear Option)

```bash
/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -kill -r -domain local -domain system -domain user
```

This resets the **entire** LaunchServices database for all domains. Requires a reboot or logout/login afterward. Side effects:
- All "Open With..." associations temporarily reset until apps are relaunched
- All app registrations are rebuilt from scratch
- PlugInKit discovery will run fresh against the clean database

### Method C: Delete the pkd Registry Cache Directly

Since the pkd registry at `$(getconf DARWIN_USER_CACHE_DIR)/PlugInKit/Registry` is rebuilt from scratch on startup, deleting it forces a full rediscovery. However, **this alone may not work** if the LaunchServices csstore still contains the stale/tombstoned state, because pkd will simply rebuild from the same corrupted source. Use in combination with Method A or B.

### Method D: Change Bundle Identifier (Developer Workaround)

The tombstone is keyed to the bundle identifier (`com.safari-pilot.app.Extension`). Changing the extension's bundle ID in `Info.plist` and rebuilding causes the system to treat it as a completely new extension. This is a temporary development workaround, not a real fix.

---

## 3. Is There a `pluginkit` Flag to Force Re-registration?

**No.** The `pluginkit(8)` man page documents these flags:

| Flag | Purpose |
|------|---------|
| `-a` | Explicitly add plugins (temporary -- "database clean-ups may eventually remove them") |
| `-r` | Explicitly remove plugins ("automatic discovery procedures may add them back") |
| `-e` | Set user election: `use`, `ignore`, or `default` |
| `-m` | Match/query registered plugins |
| `--raw` | Show raw XML from pkd |

There is **no** `--force`, `--override`, or `--clear-tombstone` flag. The man page explicitly states: "They cannot make permanent alterations of the automatic registry state."

The `-e use` election flag is worth trying (`pluginkit -e use -i com.safari-pilot.app.Extension`) but this only sets a user preference, it does not override a missing registration.

---

## 4. Can the LaunchServices csstore Contain pluginkit State?

**Yes -- this is exactly where the tombstone lives.**

The architecture is:

```
LaunchServices csstore (PERSISTENT, survives reboots)
    |
    |-- contains app registrations, extension points, appex metadata
    |-- includes PKDict (PlugInKit dictionary) for each appex
    |-- includes NSExtensionPointIdentifier, SDK data
    |
    v
pkd daemon (EPHEMERAL, rebuilt every login)
    |
    |-- reads from LaunchServices during "discovery"
    |-- builds in-memory registry in /var/folders/.../PlugInKit/Registry
    |-- adds annotations (elected status, timestamps)
```

When `pluginkit -r` removes an extension, it modifies the registration state. If the LaunchServices database records this removal in a way that blocks rediscovery (the "tombstone"), then pkd will faithfully replicate that blocked state on every startup.

Jeff Johnson's `lsregister -dump` analysis proved this: the `com.apple.Safari.web-extension` extension point was **missing from the LaunchServices dump** before the fix and **present after** re-registration with `lsregister -f -R`.

---

## 5. Does a Reboot Clear pkd Tombstones?

**No.** A reboot clears pkd's ephemeral registry (which is rebuilt anyway), but the LaunchServices csstore database **persists across reboots**. Since pkd rebuilds from LaunchServices on every login, it will reconstruct the same tombstoned state from the same corrupted source data.

The reboot does cause a fresh pkd discovery cycle, but that discovery reads from LaunchServices. If LaunchServices still shows the extension point or the specific appex as removed/missing, pkd will not register it.

---

## 6. Apple Developer Forum Posts About `pluginkit -r` Irreversibility

There are **no official Apple posts** confirming `pluginkit -r` creates an irreversible tombstone. The man page explicitly says the opposite: "automatic discovery procedures may add them back if they are still present."

However, the broader problem of disappearing/unregisterable extensions is widely documented:

- **Jeff Johnson (lapcatsoftware.com)** documented the "disappearing Safari extensions" bug extensively in 2021-2022, showing it's a LaunchServices-level issue affecting all Safari web extensions on Big Sur+
- **Apple Developer Forums thread 78231** ("Unreliable pluginkit behavior on macOS") describes similar registration failures
- **Apple Developer Forums thread 112057** covers troubleshooting Safari App Extension registration
- **Apple Radar 45603310** (mirrored on GitHub) reports "pkd/pluginkit does not register Safari App Extensions installed in /Library/Services"
- **Apple Developer Forums thread 756711** ("FinderSync extensions gone") describes extensions disappearing after macOS updates

The consistent pattern: the extension framework is fragile, LaunchServices can lose track of extension points, and the fix is always some variant of forcing LaunchServices to re-register.

---

## 7. Is the Tombstone in the Per-User LaunchServices Database or a Separate pkd-Managed File?

**The tombstone is in the per-user LaunchServices database (csstore).**

This is the definitive finding from all sources:

1. The pkd man page says the registry is "inside the user's posix cache directory" and is a cache
2. Howard Oakley (Eclectic Light Company) confirmed "only LaunchServices appears to maintain a database that persists across restarts" and pkd's registry "appears to be built from scratch during startup"
3. Jeff Johnson proved via `lsregister -dump` diffs that the extension point data lives in LaunchServices and can go missing there
4. The fix in all documented cases is `lsregister` (a LaunchServices tool), not any pkd-specific intervention

The pkd Registry file at `$(getconf DARWIN_USER_CACHE_DIR)/PlugInKit/Registry` is a **derived cache**, not the source of truth.

---

## Recommended Action Plan

### Step 1: Diagnose (Read-Only)

```bash
# Find the exact pkd registry path
getconf DARWIN_USER_CACHE_DIR
# Registry is at: <that path>/PlugInKit/Registry

# Find the LaunchServices csstore path
getconf DARWIN_USER_DIR
# csstore is at: <that path>/com.apple.LaunchServices.dv/com.apple.LaunchServices-*-v2.csstore

# Check current pluginkit state for the extension
pluginkit -m -v -i com.safari-pilot.app.Extension

# Check with all versions flag
pluginkit -m -A -D -v -i com.safari-pilot.app.Extension

# Check the raw XML state
pluginkit -m --raw -i com.safari-pilot.app.Extension

# Dump LaunchServices and search for the extension
lsregister -dump | grep -A 20 "com.safari-pilot"

# Check if the web-extension extension point exists
lsregister -dump | grep "com.apple.Safari.web-extension"

# Stream pkd logs for live debugging
log stream --predicate 'subsystem == "com.apple.PlugInKit"'
```

### Step 2: Fix (Choose One)

**Option A -- Targeted re-registration (try first):**
```bash
# Re-register the specific app
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f -R /path/to/SafariPilot.app

# Also re-register Safari itself to restore extension point
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f -R /Applications/Safari.app

# Then explicitly add the extension
pluginkit -a /path/to/SafariPilot.app/Contents/PlugIns/Extension.appex
```

**Option B -- Full LaunchServices reset (if Option A fails):**
```bash
/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister -kill -r -domain local -domain system -domain user

# MUST reboot after this
```

### Step 3: Verify

```bash
# Confirm extension appears in pluginkit
pluginkit -m -v -i com.safari-pilot.app.Extension

# Confirm extension point exists in LaunchServices
lsregister -dump | grep "com.apple.Safari.web-extension"
```

---

## Sources

- [How PlugInKit enables app extensions -- The Eclectic Light Company (Howard Oakley, 2025)](https://eclecticlight.co/2025/04/16/how-pluginkit-enables-app-extensions/)
- [An overview of app extensions and plugins in macOS Sequoia -- The Eclectic Light Company](https://eclecticlight.co/2025/04/23/an-overview-of-app-extensions-and-plugins-in-macos-sequoia/)
- [Disappearing Safari extensions -- lapcatsoftware (Jeff Johnson, 2021)](https://lapcatsoftware.com/articles/disappearing-safari.html)
- [More disappearing Safari extensions -- lapcatsoftware (Jeff Johnson, 2022)](https://lapcatsoftware.com/articles/disappearing-safari2.html)
- [pluginkit(8) man page](https://keith.github.io/xcode-man-pages/pluginkit.8.html)
- [pkd(8) man page](https://www.manpagez.com/man/8/pkd/)
- [Troubleshooting your Safari web extension -- Apple Developer Documentation](https://developer.apple.com/documentation/safariservices/troubleshooting-your-safari-web-extension)
- [Unreliable pluginkit behavior on macOS -- Apple Developer Forums](https://developer.apple.com/forums/thread/78231)
- [pkd/pluginkit does not register Safari App Extensions -- Apple Radar 45603310](https://github.com/lionheart/openradar-mirror/issues/20628)
- [NSExtension & PlugInKit -- A brief intro (Aditya Vaidyam)](https://medium.com/@avaidyam/nsextension-pluginkit-a-brief-intro-2803be91a777)
