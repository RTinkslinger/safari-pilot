#!/bin/bash
# PreToolUse hook for Bash — enforces Safari Pilot build safety rules.
# Hard-blocks dangerous system commands. Injects verification checklists on publish.

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)

[ -z "$COMMAND" ] && exit 0

# ── HARD BLOCKS — exit 2 with reason ─────────────────────────────────────────

# Block pluginkit (caused unrecoverable extension deregistration in v0.1.1)
if echo "$COMMAND" | grep -qiE '\bplugink?it\b'; then
  echo "BLOCKED: pluginkit commands are forbidden." >&2
  echo "pluginkit -r caused permanent extension deregistration in v0.1.1." >&2
  echo "If the extension doesn't show up, the problem is the BUILD — fix it with: bash scripts/build-extension.sh" >&2
  exit 2
fi

# Block lsregister (caused repeated app auto-launches in v0.1.1)
if echo "$COMMAND" | grep -qiE '\blsregister\b'; then
  echo "BLOCKED: lsregister is not for Safari extensions." >&2
  echo "This caused repeated auto-launch popups in v0.1.1. Use: bash scripts/build-extension.sh" >&2
  exit 2
fi

# Block killing Safari (destructive — loses user tabs)
if echo "$COMMAND" | grep -qiE '(pkill|killall|kill -9).*Safari|tell application "Safari" to quit'; then
  echo "BLOCKED: Never kill Safari programmatically — it destroys user tabs." >&2
  echo "If Safari needs restarting, tell the user to do it themselves." >&2
  exit 2
fi

# Block killing pkd (plugin kit daemon — no evidence this helps anything)
if echo "$COMMAND" | grep -qiE '(pkill|killall|kill).*pkd'; then
  echo "BLOCKED: Never kill the pkd daemon." >&2
  exit 2
fi

# Block editing Safari's internal plists
if echo "$COMMAND" | grep -qiE '(plutil|PlistBuddy|defaults write).*Safari.*(Extensions|WebExtensions)'; then
  echo "BLOCKED: Never edit Safari's internal extension plists." >&2
  echo "This didn't fix anything in v0.1.1. Fix the build instead." >&2
  exit 2
fi

# Block manual codesign on the extension .app (strips entitlements)
# Match any codesign --force on a path containing "Safari" and "Pilot" (handles escaping variations)
if echo "$COMMAND" | grep -qiE 'codesign.*--force.*--sign' && echo "$COMMAND" | grep -qi 'Safari' && echo "$COMMAND" | grep -qi 'Pilot'; then
  echo "BLOCKED: Manual codesign on Safari Pilot .app strips entitlements (app-sandbox)." >&2
  echo "This was the root cause of the v0.1.1-v0.1.2 extension invisibility." >&2
  echo "Use the full pipeline: bash scripts/build-extension.sh" >&2
  exit 2
fi

# ── PUBLISH GATE — inject verification checklist ─────────────────────────────

if echo "$COMMAND" | grep -qiE 'npm publish|gh release create|git push.*--tags'; then
  cat <<'GATE'
{
  "hookSpecificOutput": {
    "additionalContext": "SAFARI PILOT PUBLISH GATE: Before publishing, verify ALL of these:\n1. Extension entitlements present: codesign -d --entitlements - 'bin/Safari Pilot.app' (must show app-sandbox)\n2. Extension works: open 'bin/Safari Pilot.app' → Safari > Settings > Extensions → enable → test\n3. Version synced: package.json version matches CFBundleVersion in the built .app\n4. All tests pass: npm run test:unit && npm run test:security\n5. Config loads: node -e 'import(\"./dist/config.js\").then(m => console.log(m.loadConfig()))'\nDo NOT publish if any check fails. v0.1.1 and v0.1.2 shipped broken because this wasn't done."
  }
}
GATE
  exit 0
fi

# ── DAEMON BUILD — remind about version + restart ────────────────────────────

if echo "$COMMAND" | grep -qiE 'swift build.*-c release' && echo "$COMMAND" | grep -qiE 'daemon'; then
  cat <<'REMIND'
{
  "hookSpecificOutput": {
    "additionalContext": "DAEMON BUILD REMINDER: After building, copy to bin/ and restart: cp daemon/.build/release/SafariPilotd bin/SafariPilotd && bash scripts/update-daemon.sh. Or use the update script directly which handles atomic swap + launchctl restart."
  }
}
REMIND
  exit 0
fi

exit 0
