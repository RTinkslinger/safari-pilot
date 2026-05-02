// T55a — cross-origin iframe fixture server.
// Spawns two Node http.createServer instances on different ports.
// Different ports = different origins per same-origin policy, which is exactly
// what cross-origin iframe e2e needs without spinning up DNS or a second
// hostname. Both servers serve from test/fixtures/cross-frame/.
//
// Lifecycle: call startFixtureServer() in beforeAll, server.close() in afterAll.
// Override ports via SAFARI_PILOT_FIXTURE_PORT_HOST / _INNER env vars (default
// 19476 / 19477).

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const FIXTURE_DIR = resolve(__filename, '../../fixtures/cross-frame');

export interface FixtureServer {
  readonly hostPort: number;
  readonly innerPort: number;
  close(): Promise<void>;
}

function makeHandler() {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = (req.url ?? '/').split('?')[0];
    const file = url === '/' ? 'host.html' : url.replace(/^\/+/, '');
    try {
      const body = readFileSync(resolve(FIXTURE_DIR, file));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  };
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', rejectListen);
      resolveListen();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const hostPort = Number.parseInt(process.env['SAFARI_PILOT_FIXTURE_PORT_HOST'] ?? '19476', 10);
  const innerPort = Number.parseInt(process.env['SAFARI_PILOT_FIXTURE_PORT_INNER'] ?? '19477', 10);

  const hostServer = createServer(makeHandler());
  const innerServer = createServer(makeHandler());

  await Promise.all([listen(hostServer, hostPort), listen(innerServer, innerPort)]);

  return {
    hostPort,
    innerPort,
    close: () => Promise.all([close(hostServer), close(innerServer)]).then(() => undefined),
  };
}
