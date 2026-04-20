/**
 * E2E Production Stack Precondition Checks
 *
 * Verifies the system daemon, Safari extension, Safari browser, and MCP server
 * are all running before e2e tests execute. Skips checks for unit/integration runs.
 *
 * Uses raw TCP/NDJSON — does NOT import from src/ (e2e rule).
 */
import { createConnection } from 'node:net';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = fileURLToPath(new URL('.', import.meta.url));

export async function setup() {
  const testFilter = process.env['VITEST_INCLUDE'] ?? process.argv.join(' ');
  const isE2eRun = testFilter.includes('test/e2e') || testFilter.includes('test:e2e')
    || (!testFilter.includes('test/unit') && !testFilter.includes('test:unit')
       && !testFilter.includes('test/integration'));

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

  const mcpOk = await checkMcpServerSpawns();
  if (!mcpOk) {
    if (!isE2eRun) { console.log('E2E setup: MCP server failed to start (skipped — not an e2e run)'); return; }
    throw new Error(
      'E2E PRECONDITION FAILED: MCP server failed to start. Run: npm run build'
    );
  }

  console.log('E2E preconditions passed: daemon running, extension connected, Safari open, MCP server valid');
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

function checkMcpServerSpawns(): Promise<boolean> {
  return new Promise((resolve) => {
    const serverPath = join(__dir, '../../dist/index.js');
    const proc: ChildProcess = spawn('node', [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); resolve(false); }, 10_000);
    const initMsg = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'setup-check', version: '1.0' } },
    }) + '\n';
    proc.stdin!.write(initMsg);
    let buf = '';
    proc.stdout!.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      if (buf.includes('"result"')) {
        clearTimeout(timer);
        proc.kill('SIGTERM');
        resolve(true);
      }
    });
    proc.on('error', () => { clearTimeout(timer); resolve(false); });
    proc.on('close', () => { clearTimeout(timer); resolve(false); });
  });
}
