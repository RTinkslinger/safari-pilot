# Xcode Code Signing, Notarization & Safari Extension Distribution — Ultra Research

**Date:** 2026-04-12
**Source:** Parallel Ultra Research (trun_4719934bf63647789acfe8439d1a8342)
**Purpose:** Complete guide for signing, notarizing, and distributing Safari Pilot extension

---

## Key Facts

1. **Developer ID Application certificate** required (NOT Apple Distribution — that's App Store only)
2. **No provisioning profile needed** for Developer ID distribution
3. **Sign inside-out**: .appex FIRST, then .app container. Never use `--deep` for signing.
4. **Hardened Runtime mandatory**: `--options runtime` flag required for notarization
5. **notarytool** (not altool — deprecated Nov 2023)
6. **Staple after notarization**: `xcrun stapler staple` on the .app, then re-zip for distribution
7. **Signed extensions persist permanently** across Safari restarts — no "Allow Unsigned Extensions" needed
8. **5-year certificate validity** — apps signed with timestamp remain valid after cert expires

## Signing Commands

```bash
# 1. Sign the extension (.appex) FIRST
codesign --force --options runtime --timestamp \
  --sign "Developer ID Application: Your Name (TEAM_ID)" \
  "Safari Pilot.app/Contents/PlugIns/Safari Pilot Extension.appex"

# 2. Sign the host app (.app)
codesign --force --options runtime --timestamp \
  --sign "Developer ID Application: Your Name (TEAM_ID)" \
  "Safari Pilot.app"

# 3. Verify
codesign --verify --deep --strict --verbose=2 "Safari Pilot.app"
spctl -a -t exec -vv "Safari Pilot.app"
```

## Notarization Commands

```bash
# 1. Create ZIP
ditto -c -k --keepParent "Safari Pilot.app" "Safari Pilot.zip"

# 2. Submit and wait
xcrun notarytool submit "Safari Pilot.zip" \
  --keychain-profile "notarytool-password" --wait

# 3. Staple the ticket to the .app (NOT the .zip)
xcrun stapler staple "Safari Pilot.app"

# 4. Re-zip the stapled .app for distribution
ditto -c -k --keepParent "Safari Pilot.app" "Safari Pilot-notarized.zip"
```

## GitHub Actions CI Secrets

| Secret | Purpose |
|---|---|
| BUILD_CERTIFICATE_BASE64 | Base64-encoded .p12 Developer ID cert |
| P12_PASSWORD | Password for .p12 |
| KEYCHAIN_PASSWORD | Temp CI keychain password |
| NOTARYTOOL_PASSWORD | App-specific password for Apple ID |

## npm Distribution Strategy

Do NOT embed .app in npm tarball. Instead:
1. Upload stapled .zip to GitHub Releases
2. Ship Node.js wrapper in npm that downloads from Releases at runtime
3. Avoid postinstall scripts (supply chain risk)

## Entitlements

- DO: Enable Hardened Runtime (`--options runtime`)
- DO: Include `--timestamp` for long-term validity
- DO NOT: Include `com.apple.security.get-task-allow = true` (breaks notarization)

## Troubleshooting

| Issue | Fix |
|---|---|
| "App is damaged" | Verify with `spctl -a -t exec -vv`. Ensure stapled. |
| Notarization fails: "signature invalid" | Re-sign inside-out. Don't modify .app after signing. |
| Notarization fails: "hardened runtime" | Add `--options runtime` to codesign. |
| Extension not in profiles | Safari 17+: enable per-profile in Settings > Profiles. |
| Extension disappears on restart | Not signed with Developer ID. Sign + notarize. |

## References

1. Apple: Distributing Safari web extensions
2. Apple: Notarizing macOS software
3. Apple: TN2206 Code Signing In Depth
4. Apple: Developer ID certificates
5. Apple: Resolving notarization issues
6. GitHub Docs: Installing Apple cert on macOS runners
7. Apple: Safari 17 Release Notes (per-profile extensions)
