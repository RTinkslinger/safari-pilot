import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, normalize, resolve } from 'node:path';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml; charset=utf-8',
};

export class FixtureServer {
  private server: Server;
  private port: number = 0;
  private stopped: boolean = false;

  constructor(
    private readonly fixturesDir: string,
    private readonly requestedPort: number,
  ) {
    this.server = createServer((req, res) => {
      const url = req.url ?? '/';

      // Generate unique download file for testing (must come before generic /download/ handler)
      if (url.startsWith('/download/generate')) {
        const params = new URL(url, 'http://localhost').searchParams;
        const size = parseInt(params.get('size') ?? '1024', 10);
        const name = params.get('name') ?? `test-${Date.now()}.bin`;
        const data = Buffer.alloc(Math.min(size, 10_000_000), 0x42);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${name}"`,
          'Content-Length': data.length.toString(),
        });
        res.end(data);
        return;
      }

      // Download endpoint: serve files with Content-Disposition: attachment
      if (url.startsWith('/download/')) {
        const filename = decodeURIComponent(url.slice('/download/'.length).split('?')[0]);
        const downloadFixturesDir = resolve(this.fixturesDir, 'downloads');
        const filePath = resolve(downloadFixturesDir, filename);

        if (!filePath.startsWith(downloadFixturesDir)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }

        try {
          const data = readFileSync(filePath);
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Content-Length': data.length.toString(),
          });
          res.end(data);
        } catch {
          res.writeHead(404);
          res.end('Not Found');
        }
        return;
      }

      // Download page
      if (url === '/download-page') {
        const pagePath = resolve(this.fixturesDir, 'downloads', 'download-page.html');
        try {
          const data = readFileSync(pagePath, 'utf-8');
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(data);
        } catch {
          res.writeHead(404);
          res.end('Not Found');
        }
        return;
      }

      // Resolve and verify path stays within fixtures dir
      const safePath = normalize(url.startsWith('/') ? url.slice(1) : url);
      const filePath = resolve(this.fixturesDir, safePath);
      const resolvedBase = resolve(this.fixturesDir);
      if (!filePath.startsWith(resolvedBase + '/') && filePath !== resolvedBase) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      readFile(filePath)
        .then((data) => {
          const ext = extname(filePath).toLowerCase();
          const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';
          res.writeHead(200, {
            'Content-Type': contentType,
            'Access-Control-Allow-Origin': '*',
          });
          res.end(data);
        })
        .catch(() => {
          res.writeHead(404, {
            'Content-Type': 'text/plain',
            'Access-Control-Allow-Origin': '*',
          });
          res.end('Not Found');
        });
    });
  }

  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.requestedPort, '127.0.0.1', () => {
        const addr = this.server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('Unexpected server address format'));
          return;
        }
        this.port = addr.port;
        resolve(this.port);
      });
    });
  }

  getPort(): number {
    return this.port;
  }

  stop(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.stopped = true;
    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}
