---
name: start
description: Start the Safari Pilot daemon (idempotent — safe to call if already running)
allowed-tools: Bash
---

Start the SafariPilotd daemon process. This is idempotent — if the daemon is already running, report its PID and exit.

## Steps

1. Check if the daemon is already running:
   ```bash
   pgrep -f SafariPilotd
   ```

2. **If already running**, report the PID and exit:
   > Safari Pilot daemon already running (PID: {pid})

3. **If not running**, start it:
   ```bash
   DAEMON_BIN="${CLAUDE_PLUGIN_ROOT}/bin/SafariPilotd"
   DATA_DIR="${HOME}/.safari-pilot"
   mkdir -p "$DATA_DIR"
   "$DAEMON_BIN" --daemon >> "$DATA_DIR/daemon.log" 2>&1 &
   echo $! > "$DATA_DIR/daemon.pid"
   ```

4. Verify it started (check PID is alive):
   ```bash
   kill -0 $(cat ~/.safari-pilot/daemon.pid) 2>/dev/null
   ```

5. Report the result:
   > Safari Pilot daemon started (PID: {pid})
   >
   > The Safari extension is managed separately in Safari > Settings > Extensions.

## If the daemon binary is missing

Report:
> SafariPilotd not found at {path}. Run `npm install` in the safari-pilot directory to build it, or install Xcode Command Line Tools if Swift is not available.
