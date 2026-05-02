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

    // 5A.8 cookie fixture: serve a page that triggers a Set-Cookie response
    // header with HttpOnly. This is the only way to install an httpOnly
    // cookie in the browser — the JS API can't. Asserting safari_get_cookies
    // sees this cookie back with httpOnly:true is the litmus for the
    // extension routing actually working end-to-end.
    // 5A.9 basic-auth fixture: respond 401 with WWW-Authenticate until the
    // request carries the expected Authorization: Basic <b64(testuser:testpass)>
    // header. Used by the auth e2e to verify safari_authenticate's DNR
    // injection actually lands on the wire.
    if (url === '/auth-protected') {
      const expected = 'Basic ' + Buffer.from('testuser:testpass', 'utf-8').toString('base64');
      const header = req.headers['authorization'];
      if (header === expected) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!DOCTYPE html><html><body><h1 id="ok">authenticated</h1></body></html>');
        return;
      }
      res.writeHead(401, {
        'Content-Type': 'text/html; charset=utf-8',
        'WWW-Authenticate': 'Basic realm="test"',
      });
      res.end('<!DOCTYPE html><html><body><h1 id="denied">401 unauthorized</h1></body></html>');
      return;
    }

    if (url === '/cookie-fixture') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': [
          'srv_session=server-set-secret; Path=/; HttpOnly; SameSite=Lax',
          'srv_visible=normal-value; Path=/; SameSite=Lax',
        ],
      });
      res.end('<!DOCTYPE html><html><body><h1>5A.8 cookie fixture</h1></body></html>');
      return;
    }

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
