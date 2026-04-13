import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import type { ToolResponse, ToolRequirements, ClickContext, Engine } from '../types.js';
import type { SafariPilotServer } from '../server.js';

const execFileAsync = promisify(execFile);

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}

type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;

// ── Plist helpers ────────────────────────────────────────────────────────────

interface DownloadPlistEntry {
  DownloadEntryURL?: string;
  DownloadEntryPath?: string;
  DownloadEntryDateAddedKey?: string;
  DownloadEntryProgressTotalToLoad?: number;
  DownloadEntryProgressBytesSoFar?: number;
}

interface DownloadMetadata {
  filename: string;
  path: string;
  url: string | undefined;
  size: number;
  mimeType: string | undefined;
  source: 'daemon' | 'plist_poll';
}

const POLL_INTERVAL_MS = 200;

async function resolveDownloadDir(): Promise<string> {
  try {
    const { stdout } = await execFileAsync('defaults', [
      'read', 'com.apple.Safari', 'DownloadsPath',
    ], { timeout: 5_000 });
    const raw = stdout.trim();
    // Replace leading ~ with actual home dir
    if (raw.startsWith('~')) {
      return join(homedir(), raw.slice(1));
    }
    return raw;
  } catch {
    return join(homedir(), 'Downloads');
  }
}

async function snapshotDir(dir: string): Promise<Set<string>> {
  try {
    const entries = await readdir(dir);
    return new Set(entries);
  } catch {
    return new Set();
  }
}

async function getMimeType(filePath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('file', ['--mime-type', '-b', filePath], {
      timeout: 5_000,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

async function readPlistAsJson(plistPath: string): Promise<DownloadPlistEntry[]> {
  try {
    const { stdout } = await execFileAsync('plutil', [
      '-convert', 'json', '-o', '-', plistPath,
    ], { timeout: 5_000 });
    const parsed = JSON.parse(stdout);
    // The plist is an array of download entry dicts
    if (Array.isArray(parsed)) return parsed as DownloadPlistEntry[];
    // Some macOS versions nest under a key
    if (parsed.DownloadHistory && Array.isArray(parsed.DownloadHistory)) {
      return parsed.DownloadHistory as DownloadPlistEntry[];
    }
    return [];
  } catch {
    return [];
  }
}

async function getPlistMtime(plistPath: string): Promise<number> {
  try {
    const st = await stat(plistPath);
    return st.mtimeMs;
  } catch {
    return 0;
  }
}

// ── Module ───────────────────────────────────────────────────────────────────

export class DownloadTools {
  private server: SafariPilotServer;
  private handlers: Map<string, Handler> = new Map();

  constructor(server: SafariPilotServer) {
    this.server = server;
    this.handlers.set('safari_wait_for_download', this.handleWaitForDownload.bind(this));
  }

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_wait_for_download',
        description:
          'Wait for a file download to complete after a click that triggers a download. ' +
          'Call this IMMEDIATELY after safari_click on a download link — click context ' +
          '(href, download attribute) is captured automatically and expires after 60 seconds. ' +
          'Returns download metadata (filename, path, size, MIME type) on success. ' +
          'Detects inline rendering (e.g. PDF opened in-tab instead of downloading). ' +
          'Prerequisites: Safari must be running, a download-triggering click must have occurred.',
        inputSchema: {
          type: 'object',
          properties: {
            timeout: {
              type: 'number',
              description: 'Maximum time to wait for download in milliseconds (default: 30000)',
            },
            filenamePattern: {
              type: 'string',
              description: 'Regex pattern to match the expected filename (optional)',
            },
            tabUrl: {
              type: 'string',
              description: 'URL of the tab where the download was initiated (optional — used for inline render detection)',
            },
          },
        },
        requirements: {} as ToolRequirements,
      },
    ];
  }

  getHandler(name: string): Handler | undefined {
    return this.handlers.get(name);
  }

  // ── Handler ──────────────────────────────────────────────────────────────────

  private async handleWaitForDownload(
    params: Record<string, unknown>,
  ): Promise<ToolResponse> {
    const start = Date.now();
    const timeout = typeof params['timeout'] === 'number' ? params['timeout'] : 30_000;
    const filenamePattern = params['filenamePattern'] as string | undefined;
    const paramTabUrl = params['tabUrl'] as string | undefined;

    // 1. Consume click context (one-shot — cleared on read)
    const clickCtx = this.server.consumeClickContext();

    // 2. Inline render detection
    const inlineResult = await this.detectInlineRender(clickCtx, paramTabUrl);
    if (inlineResult) {
      return inlineResult;
    }

    // 3. Try daemon path first
    const daemonResult = await this.tryDaemonPath(clickCtx, timeout, filenamePattern);
    if (daemonResult) {
      return daemonResult;
    }

    // 4. Fallback: plist + directory polling
    return this.pollForDownload(clickCtx, timeout, filenamePattern, start);
  }

  // ── Inline render detection ────────────────────────────────────────────────

  private async detectInlineRender(
    clickCtx: ClickContext | null,
    paramTabUrl: string | undefined,
  ): Promise<ToolResponse | null> {
    if (!clickCtx?.href) return null;

    // We need to check if Safari navigated the tab to the href (inline render)
    // rather than starting a download
    const engine = this.server.getEngine();
    if (!engine) return null;

    const tabUrl = paramTabUrl ?? clickCtx.tabUrl;
    if (!tabUrl) return null;

    try {
      const script = 'tell application "Safari" to return URL of current tab of front window';
      const result = await engine.execute(script, 3_000);

      if (result.ok && result.value) {
        const currentUrl = result.value.trim();
        // If the current tab navigated to the clicked href, it was rendered inline
        if (currentUrl.startsWith(clickCtx.href)) {
          return this.makeErrorResponse(
            'DOWNLOAD_INLINE_RENDER',
            `File was opened inline in the browser tab instead of downloading. ` +
            `Current tab URL: ${currentUrl}`,
            'applescript',
            Date.now(),
          );
        }
      }
    } catch {
      // Best-effort detection — don't block download waiting on this
    }

    return null;
  }

  // ── Daemon path ────────────────────────────────────────────────────────────

  private async tryDaemonPath(
    clickCtx: ClickContext | null,
    timeout: number,
    filenamePattern: string | undefined,
  ): Promise<ToolResponse | null> {
    const daemon = this.server.getDaemonEngine();
    if (!daemon) return null;

    const available = await daemon.isAvailable();
    if (!available) return null;

    const daemonParams: Record<string, unknown> = {
      timeout,
      filenamePattern: filenamePattern ?? null,
      clickContext: clickCtx
        ? {
            href: clickCtx.href ?? null,
            downloadAttr: clickCtx.downloadAttr ?? null,
            isDownloadLink: clickCtx.isDownloadLink,
            tabUrl: clickCtx.tabUrl,
            timestamp: clickCtx.timestamp,
          }
        : null,
    };

    const result = await daemon.command('watch_download', daemonParams, timeout + 5_000);

    if (result.ok && result.value) {
      try {
        const parsed = JSON.parse(result.value);
        const metadata: DownloadMetadata = {
          filename: parsed.filename ?? basename(parsed.path ?? ''),
          path: parsed.path ?? '',
          url: parsed.url ?? clickCtx?.href,
          size: parsed.size ?? 0,
          mimeType: parsed.mimeType ?? parsed.mime_type,
          source: 'daemon',
        };
        return this.makeSuccessResponse(metadata, 'daemon', Date.now());
      } catch {
        // Daemon returned non-JSON — treat as success with raw value
        return this.makeSuccessResponse(
          {
            filename: 'unknown',
            path: '',
            url: clickCtx?.href,
            size: 0,
            mimeType: undefined,
            source: 'daemon',
          },
          'daemon',
          Date.now(),
        );
      }
    }

    // Daemon returned error — fall through to plist polling
    if (result.error?.code === 'TIMEOUT') {
      // Daemon timed out — don't retry with plist, just return the timeout
      return this.makeErrorResponse(
        'TIMEOUT',
        `Download did not complete within ${timeout}ms`,
        'daemon',
        Date.now(),
      );
    }

    // Other daemon errors → fall through to plist fallback
    return null;
  }

  // ── Plist polling fallback ──────────────────────────────────────────────────

  private async pollForDownload(
    clickCtx: ClickContext | null,
    timeout: number,
    filenamePattern: string | undefined,
    startTime: number,
  ): Promise<ToolResponse> {
    const downloadDir = await resolveDownloadDir();
    const plistPath = join(
      homedir(),
      'Library',
      'Safari',
      'Downloads.plist',
    );

    // Snapshot directory before polling
    const beforeFiles = await snapshotDir(downloadDir);
    let lastPlistMtime = 0;
    const filenameRe = filenamePattern ? new RegExp(filenamePattern) : null;

    const deadline = startTime + timeout;

    while (Date.now() < deadline) {
      // Check for new files in download directory
      const currentFiles = await snapshotDir(downloadDir);
      const newFiles: string[] = [];
      for (const f of currentFiles) {
        if (!beforeFiles.has(f) && !f.endsWith('.download') && !f.startsWith('.')) {
          // Skip partial download files (.download suffix) and hidden files
          if (filenameRe && !filenameRe.test(f)) continue;
          newFiles.push(f);
        }
      }

      if (newFiles.length > 0) {
        // Found a new completed file
        const filename = newFiles[0];
        const filePath = join(downloadDir, filename);

        // Get file stats and MIME type
        let size = 0;
        try {
          const st = await stat(filePath);
          size = st.size;
        } catch {
          // File may have been moved — report what we know
        }

        const mimeType = await getMimeType(filePath);

        // Try to find URL from plist
        let url: string | undefined = clickCtx?.href;
        const currentMtime = await getPlistMtime(plistPath);
        if (currentMtime > 0) {
          const entries = await readPlistAsJson(plistPath);
          const match = entries.find(
            (e) => e.DownloadEntryPath && basename(e.DownloadEntryPath) === filename,
          );
          if (match?.DownloadEntryURL) {
            url = match.DownloadEntryURL;
          }
        }

        const metadata: DownloadMetadata = {
          filename,
          path: filePath,
          url,
          size,
          mimeType,
          source: 'plist_poll',
        };
        return this.makeSuccessResponse(metadata, 'applescript', startTime);
      }

      // mtime-gated plist check: only read plist when it has changed
      const currentMtime = await getPlistMtime(plistPath);
      if (currentMtime > lastPlistMtime) {
        lastPlistMtime = currentMtime;
        const entries = await readPlistAsJson(plistPath);

        // Look for a recently-added entry that matches
        for (const entry of entries) {
          if (!entry.DownloadEntryPath) continue;
          const entryFilename = basename(entry.DownloadEntryPath);

          // Check filename pattern
          if (filenameRe && !filenameRe.test(entryFilename)) continue;

          // Check if download is complete (bytes match total)
          const total = entry.DownloadEntryProgressTotalToLoad ?? 0;
          const soFar = entry.DownloadEntryProgressBytesSoFar ?? 0;
          if (total > 0 && soFar >= total) {
            const filePath = entry.DownloadEntryPath.startsWith('~')
              ? join(homedir(), entry.DownloadEntryPath.slice(1))
              : entry.DownloadEntryPath;

            // Verify the file actually exists on disk
            try {
              const st = await stat(filePath);
              const mimeType = await getMimeType(filePath);
              const metadata: DownloadMetadata = {
                filename: entryFilename,
                path: filePath,
                url: entry.DownloadEntryURL,
                size: st.size,
                mimeType,
                source: 'plist_poll',
              };
              return this.makeSuccessResponse(metadata, 'applescript', startTime);
            } catch {
              // File doesn't exist yet — plist updated before write completed
            }
          }
        }
      }

      // Sleep before next poll iteration
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    // Timeout
    return this.makeErrorResponse(
      'TIMEOUT',
      `Download did not complete within ${timeout}ms`,
      'applescript',
      startTime,
    );
  }

  // ── Response builders ──────────────────────────────────────────────────────

  private makeSuccessResponse(
    metadata: DownloadMetadata,
    engine: Engine,
    startTime: number,
  ): ToolResponse {
    return {
      content: [{ type: 'text', text: JSON.stringify(metadata) }],
      metadata: {
        engine,
        degraded: engine !== 'daemon',
        degradedReason: engine !== 'daemon' ? 'Daemon unavailable, used plist polling fallback' : undefined,
        latencyMs: Date.now() - startTime,
      },
    };
  }

  private makeErrorResponse(
    code: string,
    message: string,
    engine: Engine,
    startTime: number,
  ): ToolResponse {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: code, message }) }],
      metadata: {
        engine,
        degraded: false,
        latencyMs: Date.now() - startTime,
      },
    };
  }
}
