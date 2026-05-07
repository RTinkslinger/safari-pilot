/**
 * Red-page fixture server for the screenshot-WebView e2e (Task 11, v0.1.30).
 *
 * Serves a single deterministic page at `/red.html` whose body fills the
 * viewport with pure red (#ff0000). The screenshot e2e captures this page
 * and proves the WebView pixels reach the PNG (any colour drift, blank
 * capture, or screen-of-something-else fails the test).
 *
 * Bind port is 0 (random) — the test reads `server.address()` to discover
 * the actual port. Lifecycle is per-test-file: startRedPageServer() in
 * beforeAll, server.close() in afterAll.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RedPageServer {
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

const RED_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>red-pixel fixture</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; width: 100%; }
    body { background: #ff0000; }
  </style>
</head>
<body></body>
</html>`;

function handler(req: IncomingMessage, res: ServerResponse): void {
  const url = (req.url ?? '/').split('?')[0];
  if (url === '/red.html' || url === '/' || url === '/red') {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(RED_HTML);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}

function listen(server: Server): Promise<number> {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', rejectListen);
      const addr = server.address() as AddressInfo;
      resolveListen(addr.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

export async function startRedPageServer(): Promise<RedPageServer> {
  const server = createServer(handler);
  const port = await listen(server);
  return {
    port,
    url: `http://127.0.0.1:${port}/red.html`,
    close: () => close(server),
  };
}
