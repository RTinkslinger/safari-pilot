#!/bin/bash
# PreToolUse hook for Edit/Write — injects distribution pipeline reminders
# when modifying files that affect the extension, daemon, or plugin distribution.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)

[ -z "$FILE_PATH" ] && exit 0

# ── Extension files — full Xcode pipeline required ───────────────────────────

if echo "$FILE_PATH" | grep -qE '/extension/(background|content|manifest)'; then
  cat <<'CONTEXT'
{
  "hookSpecificOutput": {
    "additionalContext": "DISTRIBUTION ALERT — EXTENSION FILE MODIFIED: This file is part of the Safari extension. Source changes alone reach NOBODY. After completing all extension changes, the full pipeline is:\n1. bash scripts/build-extension.sh (Xcode archive → export → sign → notarize)\n2. Verify entitlements: codesign -d --entitlements - 'bin/Safari Pilot.app'\n3. Verify in Safari: open app → Settings > Extensions → enable → test\n4. Only then: bump version, tag, release\nNever use manual codesign — it strips entitlements. Never run pluginkit or lsregister.\n\nThree distribution personas must all work:\n- npm user: gets pre-built .app from package\n- git clone user: downloads .app from GitHub Releases\n- Developer (Aakash): builds locally via build-extension.sh"
  }
}
CONTEXT
  exit 0
fi

# ── Daemon Swift source — rebuild + restart required ─────────────────────────

if echo "$FILE_PATH" | grep -qE '/daemon/Sources/'; then
  cat <<'CONTEXT'
{
  "hookSpecificOutput": {
    "additionalContext": "DISTRIBUTION ALERT — DAEMON SOURCE MODIFIED: After completing daemon changes:\n1. bash scripts/update-daemon.sh (builds, atomic binary swap, launchctl restart)\n2. The release pipeline builds universal (arm64+x86_64) binaries — local builds are single-arch\n3. Pre-built binary ships in npm package — npm users don't need Swift\n4. Git clone users download from GitHub Releases if they don't have Swift"
  }
}
CONTEXT
  exit 0
fi

# ── Build scripts — warn about pipeline integrity ────────────────────────────

if echo "$FILE_PATH" | grep -qE '/scripts/(build-extension|update-daemon|postinstall)\.sh'; then
  cat <<'CONTEXT'
{
  "hookSpecificOutput": {
    "additionalContext": "PIPELINE FILE MODIFIED: This script is part of the distribution pipeline. Changes affect all three user paths:\n- npm user: postinstall.sh runs on npm install\n- git clone user: postinstall.sh downloads binaries from GitHub Releases\n- Developer: build-extension.sh / update-daemon.sh for local builds\nVerify the script works for ALL three paths. Test with: npm pack --dry-run to check what ships."
  }
}
CONTEXT
  exit 0
fi

# ── Plugin metadata — session restart needed ─────────────────────────────────

if echo "$FILE_PATH" | grep -qE '\.claude-plugin/(plugin\.json|commands/|hooks/)'; then
  cat <<'CONTEXT'
{
  "hookSpecificOutput": {
    "additionalContext": "PLUGIN METADATA MODIFIED: Changes to plugin.json, commands, or hooks take effect on Claude Code session restart. The plugin ships in the npm package (files array includes .claude-plugin/). Verify plugin.json is valid JSON after editing."
  }
}
CONTEXT
  exit 0
fi

# ── Config schema changes — verify backwards compat ──────────────────────────

if echo "$FILE_PATH" | grep -qE '/src/config\.ts|safari-pilot\.config\.json'; then
  cat <<'CONTEXT'
{
  "hookSpecificOutput": {
    "additionalContext": "CONFIG FILE MODIFIED: The config ships in the npm package. Changes must be backwards-compatible (new fields get defaults via deep-merge). Verify: loadConfig() with no file returns all defaults, loadConfig() with partial config merges correctly, sensitive domain protections cannot be overridden via config."
  }
}
CONTEXT
  exit 0
fi

exit 0
