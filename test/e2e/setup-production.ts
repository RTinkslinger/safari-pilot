/**
 * E2E Production Stack Precondition Checks
 *
 * Verifies the system daemon, Safari extension, and Safari browser are
 * running before e2e tests execute. Skips checks for unit/integration runs.
 *
 * Does NOT verify the MCP server binary itself — that used to spawn a
 * throwaway `node dist/index.js` which created its own Safari session
 * window (cleaned by T10, but a waste of ~10s per run). Post-T-Harness the
 * shared client's own init sequence IS the MCP binary validation: the
 * first test's `getSharedClient()` call either succeeds (binary good) or
 * fails with a clear MCP-level error. No pre-flight spawn needed.
 *
 * Uses raw TCP/NDJSON — does NOT import from src/ (e2e rule).
 */
import { createConnection } from 'node:net';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = fileURLToPath(new URL('.', import.meta.url));

export async function setup() {
  const isE2eRun = process.env['SAFARI_PILOT_E2E'] === '1'
    || (() => {
      const filter = process.env['VITEST_INCLUDE'] ?? process.argv.join(' ');
      return filter.includes('test/e2e') || filter.includes('test:e2e');
    })();

  const daemonUp = await checkTcp(19474);
  if (!daemonUp) {
    if (!isE2eRun) { console.log('E2E setup: daemon not running (skipped — not an e2e run)'); return; }
    throw new Error(
      'E2E PRECONDITION FAILED: System daemon not running on TCP:19474.\n' +
      'Start it: launchctl load ~/Library/LaunchAgents/com.safari-pilot.daemon.plist'
    );
  }

  const health = await queryExtensionHealth();
  if (health?.ipcMechanism !== 'http') {
    if (!isE2eRun) { console.log('E2E setup: extension not connected (skipped — not an e2e run)'); return; }
    throw new Error(
      'E2E PRECONDITION FAILED: Extension not connected (ipcMechanism: ' + health?.ipcMechanism + ').\n' +
      'Open "bin/Safari Pilot.app" and enable the extension in Safari > Settings > Extensions'
    );
  }

  let safariOk = false;
  try {
    const count = execSync('osascript -e \'tell application "Safari" to count of windows\'').toString().trim();
    safariOk = parseInt(count) > 0;
  } catch { /* Safari not running or JS from Apple Events disabled */ }
  if (!safariOk) {
    if (!isE2eRun) { console.log('E2E setup: Safari not open (skipped — not an e2e run)'); return; }
    throw new Error(
      'E2E PRECONDITION FAILED: Safari not running, has no windows, or JS from Apple Events not enabled.'
    );
  }

  // Cheap "forgot to rebuild" check — presence, not functional. Functional
  // validation is implicit in the shared client's first MCP handshake.
  const mcpBinary = join(__dir, '../../dist/index.js');
  if (!existsSync(mcpBinary)) {
    if (!isE2eRun) { console.log('E2E setup: dist/index.js missing (skipped — not an e2e run)'); return; }
    throw new Error(
      'E2E PRECONDITION FAILED: dist/index.js not found. Run: npm run build'
    );
  }

  console.log('E2E preconditions passed: daemon running, extension connected, Safari open, MCP binary present');
}

export function teardown() {
  // No persistent state to clean up — all probes are stateless.
}

function checkTcp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.setTimeout(3000, () => { sock.destroy(); resolve(false); });
  });
}

async function queryExtensionHealth(): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const sock = createConnection({ host: '127.0.0.1', port: 19474 }, () => {
      const cmd = JSON.stringify({
        id: 'setup-health',
        method: 'execute',
        params: { script: '__SAFARI_PILOT_INTERNAL__ extension_health' },
      }) + '\n';
      sock.write(cmd);
      let buf = '';
      sock.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        if (buf.includes('\n')) {
          try {
            const resp = JSON.parse(buf.split('\n')[0]);
            sock.destroy();
            if (resp.ok && typeof resp.value === 'object') {
              resolve(resp.value);
            } else if (resp.ok && typeof resp.value === 'string') {
              resolve(JSON.parse(resp.value));
            } else {
              resolve(null);
            }
          } catch { sock.destroy(); resolve(null); }
        }
      });
    });
    sock.on('error', () => resolve(null));
    sock.setTimeout(5000, () => { sock.destroy(); resolve(null); });
  });
}

