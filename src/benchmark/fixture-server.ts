import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

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

      // Path traversal protection
      if (url.includes('..')) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request');
        return;
      }

      // Resolve file path within fixtures dir
      const safePath = normalize(url.startsWith('/') ? url.slice(1) : url);
      const filePath = join(this.fixturesDir, safePath);

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
