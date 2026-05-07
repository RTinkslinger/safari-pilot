// bench/webvoyager/mcp-direct.ts
//
// Tiny in-process MCP client used by the WebVoyager harness for two post-hoc
// purposes that don't go through `claude -p`:
//   1. snapshotExistingTabs() — record tab URLs before spawning the agent
//   2. captureScreenshotPostHoc(diffSet, path) — screenshot the agent's tab
//      (the most recently created tab not in the snapshot)
//   3. cleanupTabsByUrl(urls) — close exactly the URLs in the diff set
//
// We don't try to use any safari-pilot ownership metadata; we operate on
// (current_tabs - snapshot_tabs) instead.
import { spawn, type ChildProcess, execFile } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const DIST_INDEX = resolve(REPO_ROOT, 'dist/index.js');

interface RawTab { url: string; title: string; index: number }
interface ListTabsResponse { tabs: RawTab[] }

class TinyMcpClient {
  private proc: ChildProcess;
  private buf = '';
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;

  constructor() {
    // Spawn with SAFARI_PILOT_SURFACE=full so safari_take_screenshot is in the default surface
    // even after Phase 3 lands (the screenshot tool is in midset, not hotset).
    this.proc = spawn('node', [DIST_INDEX], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: REPO_ROOT,
      env: { ...process.env, SAFARI_PILOT_SURFACE: 'full' },
    });
    this.proc.stdout!.on('data', (chunk: Buffer) => {
      this.buf += chunk.toString();
      const lines = this.buf.split('\n');
      this.buf = lines.pop()!;
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          const id = msg['id'] as number | undefined;
          if (id !== undefined && this.pending.has(id)) {
            this.pending.get(id)!.resolve(msg);
            this.pending.delete(id);
          }
        } catch { /* skip non-JSON server stderr */ }
      }
    });
  }

  private send(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolveSend, rejectSend) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        rejectSend(new Error(`MCP timeout for ${method}`));
      }, 30_000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolveSend(v as Record<string, unknown>); },
        reject: rejectSend,
      });
      this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async init(): Promise<void> {
    await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'wv-adapter', version: '1.0' },
    });
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }

  async listTabUrls(): Promise<string[]> {
    try {
      const res = await this.send('tools/call', { name: 'safari_list_tabs', arguments: {} });
      const text = ((res['result'] as Record<string, unknown> | undefined)?.['content'] as Array<{ text?: string }> | undefined)?.[0]?.text ?? '{"tabs":[]}';
      const parsed = JSON.parse(text) as ListTabsResponse;
      return (parsed.tabs ?? []).map((t) => t.url).filter((u): u is string => typeof u === 'string' && u.length > 0);
    } catch {
      return [];
    }
  }

  async takeScreenshot(tabUrl: string, path: string): Promise<boolean> {
    try {
      await this.send('tools/call', { name: 'safari_take_screenshot', arguments: { tabUrl, path } });
      return true;
    } catch {
      return false;
    }
  }

  async closeTab(tabUrl: string): Promise<void> {
    try {
      await this.send('tools/call', { name: 'safari_close_tab', arguments: { tabUrl } });
    } catch { /* best effort */ }
  }

  close(): void {
    this.proc.kill('SIGTERM');
  }
}

/**
 * Capture the URLs of every Safari tab visible right now. Call BEFORE spawning
 * `claude -p`. The returned set is the baseline; tabs that appear after the
 * agent exits but were not in this set are the agent's tabs.
 */
export async function snapshotExistingTabs(): Promise<Set<string>> {
  const c = new TinyMcpClient();
  try {
    await c.init();
    const urls = await c.listTabUrls();
    return new Set(urls);
  } finally {
    setTimeout(() => c.close(), 500);
  }
}

/**
 * Compute (current tabs minus snapshot), screenshot the most recently listed
 * one (the last entry from `safari_list_tabs`, which mirrors macOS Safari's
 * tab order — newer tabs appear later in the list).
 *
 * Returns the URL we screenshotted, or null if the diff was empty.
 */
export async function captureScreenshotPostHoc(
  snapshot: Set<string>,
  path: string,
): Promise<string | null> {
  const c = new TinyMcpClient();
  try {
    await c.init();
    const current = await c.listTabUrls();
    const newUrls = current.filter((u) => !snapshot.has(u));
    if (newUrls.length === 0) return null;
    const target = newUrls[newUrls.length - 1]!;  // most recent of the diff
    const ok = await c.takeScreenshot(target, path);
    return ok ? target : null;
  } finally {
    setTimeout(() => c.close(), 500);
  }
}

/**
 * Close every tab whose URL is in (current - snapshot). Best-effort.
 *
 * Known limitation: this can leak the agent's last tab. `safari_close_tab`
 * fails CLOSED on cross-process tab ownership (the agent's `claude -p` MCP
 * server registered the tab; the harness's separate MCP server doesn't
 * recognize it), so we fall through to a direct AppleScript that closes by
 * exact URL match. Empirically the AppleScript reports success but Safari
 * sometimes does not actually close the tab when invoked from the harness
 * environment — the same script run from a standalone Node process closes
 * reliably. Root cause is architectural (cross-process tab ownership /
 * lack of a `createdByPilot` flag on `safari_list_tabs`) and is tracked
 * separately. The benchmark runner can sweep stragglers via URL marker
 * scan if the leak rate becomes material at full-WebVoyager scale.
 *
 * No `activate`, no `set current tab` — closing a non-frontmost tab does
 * NOT switch the user's view.
 */
export async function cleanupNewTabs(snapshot: Set<string>): Promise<void> {
  // Compute diff via the MCP client (cheap and gives us a consistent view of
  // current tabs through the same surface used for the snapshot).
  const c = new TinyMcpClient();
  let newUrls: string[] = [];
  try {
    await c.init();
    const current = await c.listTabUrls();
    newUrls = current.filter((u) => !snapshot.has(u));
  } finally {
    setTimeout(() => c.close(), 500);
  }
  if (newUrls.length === 0) return;

  // Build an AppleScript list literal from the URL set, then close any tab
  // whose URL is in the list (exact match). Iterate tab indices in REVERSE
  // because closing a tab shifts subsequent indices and a forward `repeat
  // with t in tList` skips elements when items are removed mid-iteration.
  const escaped = newUrls.map((u) => `"${u.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(', ');
  const script = `
    tell application "Safari"
      set targetUrls to {${escaped}}
      repeat with w in (every window)
        try
          set tCount to count of tabs of w
          repeat with i from tCount to 1 by -1
            try
              set t to tab i of w
              if (URL of t) is in targetUrls then close t
            end try
          end repeat
        end try
      end repeat
    end tell
  `;
  try {
    await execFileP('osascript', ['-e', script], { timeout: 10_000 });
  } catch { /* best effort */ }
}
