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
import { createHash } from 'node:crypto';
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

    // 5A.7 HAR fixture: returns deterministic JSON keyed by `id` query param,
    // PLUS a server-time timestamp that changes per request. The test uses the
    // timestamp to differentiate "served live by the server" from "replayed by
    // the mock layer": after dump_har + route_from_har, a subsequent fetch to
    // the same URL must return the CAPTURED timestamp, not a fresh one. The
    // `id` lets the test capture multiple distinct entries deterministically.
    if (url === '/har-fixture') {
      const idMatch = (req.url ?? '').match(/[?&]id=([^&]*)/);
      const id = idMatch ? decodeURIComponent(idMatch[1] ?? '') : 'unknown';
      const echoMatch = (req.url ?? '').match(/[?&]echo=([^&]*)/);
      const echo = echoMatch ? decodeURIComponent(echoMatch[1] ?? '') : null;
      const now = Date.now();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Har-Id': id,
        'X-Server-Timestamp': String(now),
      });
      const body: Record<string, unknown> = { id, capturedAt: now };
      if (echo !== null) body['echo'] = echo;
      res.end(JSON.stringify(body));
      return;
    }

    // 5A.1 file_upload — multipart echo. POSTs return per-file
    // {name,size,mimeType,sha256}. The sha256 lets e2e assert byte fidelity
    // through the entire daemon-stage / extension-fetch / File-construction /
    // FormData round-trip.
    if (url === '/upload-fixture' && req.method === 'POST') {
      const ct = req.headers['content-type'] || '';
      const boundaryMatch = ct.match(/boundary=([^\s;]+)/);
      if (!boundaryMatch) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('missing boundary');
        return;
      }
      const boundary = '--' + boundaryMatch[1];
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const parts = splitMultipart(body, boundary);
        const files = parts.map((p) => {
          const dispMatch = p.headers['content-disposition']?.match(/filename="([^"]*)"/);
          const name = dispMatch ? dispMatch[1] : 'unknown';
          const mime = p.headers['content-type'] || 'application/octet-stream';
          const sha256 = createHash('sha256').update(p.body).digest('hex');
          return { name, size: p.body.length, mimeType: mime, sha256 };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files }));
      });
      return;
    }

    // 5A.1 — validation surface. Returns 400 + role=alert in HTML body so the
    // validation probe (Task 13's collectFileUploadValidation) surfaces it.
    if (url === '/upload-validate' && req.method === 'POST') {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html><body><div role="alert" id="err">File too large per site rules</div></body></html>');
      return;
    }

    // 5A.1 — static form page with multiple <input type=file> shapes:
    //   #file-input (multiple), #single-input (single), #hidden-input under <label>.
    // Submit handler stores response on window.__lastUploadResponse for e2e probe.
    if (url === '/upload-form') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body>
    <form id="f" action="/upload-fixture" method="POST" enctype="multipart/form-data">
      <input id="file-input" name="upload" type="file" multiple />
      <input id="single-input" name="single" type="file" />
      <label id="hidden-label">
        Pick file
        <input id="hidden-input" name="hidden" type="file" style="display:none" />
      </label>
      <button id="submit" type="submit">Submit</button>
    </form>
    <script>
      document.getElementById('f').addEventListener('submit', async function(e) {
        e.preventDefault();
        var fd = new FormData(e.target);
        var resp = await fetch('/upload-fixture', { method: 'POST', body: fd });
        window.__lastUploadResponse = await resp.json();
      });
    </script>
  </body></html>`);
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

interface MultipartPart {
  headers: Record<string, string>;
  body: Buffer;
}

function splitMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const boundaryBuf = Buffer.from(boundary);
  const parts: MultipartPart[] = [];
  let pos = 0;
  while (pos < body.length) {
    const start = body.indexOf(boundaryBuf, pos);
    if (start < 0) break;
    const partStart = start + boundaryBuf.length + 2; // skip \r\n
    const next = body.indexOf(boundaryBuf, partStart);
    if (next < 0) break;
    const partEnd = next - 2; // skip trailing \r\n
    if (partEnd <= partStart) { pos = next; continue; }
    const slice = body.subarray(partStart, partEnd);
    const sep = slice.indexOf('\r\n\r\n');
    if (sep < 0) { pos = next; continue; }
    const headerBlock = slice.subarray(0, sep).toString('utf-8');
    const partBody = slice.subarray(sep + 4);
    const headers: Record<string, string> = {};
    for (const line of headerBlock.split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
    }
    parts.push({ headers, body: partBody });
    pos = next;
  }
  return parts;
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
