/**
 * v0.1.34 Task 3 — Mode B CSP fixture (script-src 'self' without unsafe-eval).
 *
 * Pure CSP eval block (no Trusted Types). Used by csp-evaluate-blocked-error
 * to assert that safari_evaluate's failure-path wrapper recognizes
 * "Refused to evaluate ... unsafe-eval" errors as CSP_BLOCKED and emits the
 * structured error + alternative_tools hint.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export function startScriptSrcNoEvalFixture(port = 0): { server: Server; url: () => string } {
  const page = `<!DOCTYPE html><html><head>
<meta charset="utf-8"><title>script-src no-eval fixture</title>
</head><body>
<h1 id="hero">script-src 'self' (no eval) fixture body</h1>
<form id="login"><input id="user" type="text"><button type="submit">Sign in</button></form>
</body></html>`;
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      // No 'unsafe-eval'; no Trusted Types. Pure CSP eval block.
      'Content-Security-Policy': "script-src 'self'",
    });
    res.end(page);
  });
  server.listen(port);
  const addr = server.address() as AddressInfo;
  return { server, url: () => `http://127.0.0.1:${addr.port}/` };
}
