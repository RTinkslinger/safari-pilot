/**
 * v0.1.34 CSP fixture — TT-strict pages that ALSO restrict policy names
 * to an allowlist excluding 'safari-pilot'.
 *
 * Used by Task 2's e2e test to verify Layer 3's hard-block branch:
 * when the page's `trusted-types` directive doesn't allow our policy name,
 * `trustedTypes.createPolicy('safari-pilot', ...)` throws TypeError and
 * content-main.js sets `window.__SP_TT_HARD_BLOCK = true`. T3 will surface
 * this as CSP_HARD_BLOCK (vs the ordinary CSP_BLOCKED on TT-strict pages
 * without an allowlist, where Layer 3 succeeds at registering the policy
 * but `new Function` is still rejected).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export function startTrustedTypesAllowlistFixture(port = 0): { server: Server; url: () => string } {
  const page = `<!DOCTYPE html><html><head>
<meta charset="utf-8"><title>TT-strict allowlist fixture</title>
<meta name="description" content="Trusted Types strict fixture with allowlist excluding safari-pilot">
</head><body>
<h1 id="hero">TT-strict allowlist fixture body</h1>
<p>This page enforces Trusted Types AND restricts policy names to an allowlist that excludes 'safari-pilot'.</p>
</body></html>`;
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "require-trusted-types-for 'script'; trusted-types google#safe goog#html",
    });
    res.end(page);
  });
  server.listen(port);
  const addr = server.address() as AddressInfo;
  return { server, url: () => `http://127.0.0.1:${addr.port}/` };
}
