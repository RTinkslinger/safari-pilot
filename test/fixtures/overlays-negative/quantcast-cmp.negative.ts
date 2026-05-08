import { createServer, Server } from 'node:http';

// Negative fixture for the quantcast-cmp pattern.
// DOM has .qc-cmp2-container (matches signal 1: selector) but aria-label is
// "age verification" — does NOT contain "consent" (fails signal 2).
// safari_dismiss_overlays must NOT match this — the second signal fails.
// This represents a LEGITIMATE UI: an NSFW/age-gate the user must explicitly
// affirm. Auto-dismissing this would silently bypass legally-required age
// verification on alcohol, gambling, or adult-content sites.
export function startQuantcastCmpNegativeFixture(port = 0): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<main><h1>Welcome</h1><p>Please verify your age to continue.</p></main>
<div class="qc-cmp2-container" role="dialog" aria-label="age verification"
     style="position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.9);color:#fff;padding:2em;z-index:9999">
  <p>You must be 21 or older to enter this site.</p>
  <button id="age-verify-yes">I am 21 or older</button>
  <button id="age-verify-no">I am under 21</button>
</div>
</body></html>`;
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  server.listen(port);
  return {
    server,
    url: () => {
      const a = server.address();
      if (typeof a === 'string' || a === null) throw new Error('no addr');
      return `http://127.0.0.1:${a.port}/`;
    },
  };
}
