---
name: stop
description: Stop the Safari Pilot daemon gracefully
allowed-tools: Bash
---

Stop the SafariPilotd daemon process. Attempts graceful SIGTERM shutdown, falls back to SIGKILL if needed.

## Steps

1. Find the daemon PID from the PID file or process list:
   ```bash
   PID_FILE="${HOME}/.safari-pilot/daemon.pid"
   if [ -f "$PID_FILE" ]; then
     PID=$(cat "$PID_FILE")
   else
     PID=$(pgrep -f SafariPilotd)
   fi
   ```

2. **If PID was found**, verify the process is actually alive:
   ```bash
   kill -0 "$PID" 2>/dev/null
   ```
   If the process is not alive, clean up the stale PID file and report:
   ```bash
   rm -f "${HOME}/.safari-pilot/daemon.pid"
   ```
   > Safari Pilot daemon is not running (cleaned up stale PID file).

3. **If no PID was found or process is dead**, report and exit:
   > Safari Pilot daemon is not running.

4. **If running**, send SIGTERM for graceful shutdown:
   ```bash
   kill "$PID" 2>/dev/null
   ```

5. Wait up to 3 seconds for the process to exit:
   ```bash
   for i in 1 2 3; do
     kill -0 "$PID" 2>/dev/null || break
     sleep 1
   done
   ```

6. Check if it stopped:
   - **If stopped**: clean up the PID file and report:
     ```bash
     rm -f "${HOME}/.safari-pilot/daemon.pid"
     ```
     > Safari Pilot daemon stopped (was PID: {pid})
   - **If still running after 3s**: report the fallback command:
     > Daemon did not stop gracefully. To force kill: `kill -9 {pid}`

7. Always note:
   > The Safari extension remains active independently in Safari > Settings > Extensions.
