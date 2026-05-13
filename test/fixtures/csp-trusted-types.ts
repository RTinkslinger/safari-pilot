/**
 * v0.1.34 CSP fixture — pages serving `require-trusted-types-for 'script'`.
 *
 * Used by Slice 1 verification test to assert (a) MAIN-world `new Function`
 * is blocked here (v0.1.33 regression check) and (b) once Task 2 lands the
 * `__SP_CSP_VERIFY__` sentinel, ISOLATED-world `new Function` succeeds.
 * The empirical answer to (b) gates the entire sprint architecture.
 */
import { createServer, Server } from 'node:http';

export function startTrustedTypesFixture(port = 0): { server: Server; url: () => string } {
  const page = `<!DOCTYPE html><html><head>
<meta charset="utf-8"><title>TT-strict fixture</title>
<meta name="description" content="Trusted Types strict fixture">
</head><body>
<h1 id="hero">TT-strict fixture body</h1>
<p id="lede">This page enforces require-trusted-types-for 'script'.</p>
<button id="btn-action" type="button">Action</button>
<input id="input-name" type="text" placeholder="Your name">
<div id="shadow-host"></div>
</body></html>`;
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "require-trusted-types-for 'script'",
    });
    res.end(page);
  });
  server.listen(port);
  return {
    server,
    url: () => {
      const addr = server.address();
      if (typeof addr === 'string' || addr === null) throw new Error('no addr');
      return `http://127.0.0.1:${addr.port}/`;
    },
  };
}
