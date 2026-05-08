import { createServer, Server } from 'node:http';

// Negative fixture for the trustarc-banner pattern.
// DOM has #truste-consent-track (matches signal 1: selector) but aria-label
// is "Trust score notification" — does NOT contain "cookie" (fails signal 2).
// safari_dismiss_overlays must NOT match this — the second signal fails.
// This represents a LEGITIMATE UI: a security/trust score notification (e.g.,
// a SaaS dashboard surfacing an account trust health alert) that happens to
// reuse the trustarc id. Auto-dismissing would hide a security signal.
export function startTrustarcBannerNegativeFixture(port = 0): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<main><h1>Account dashboard</h1><p>Your account health summary.</p></main>
<div id="truste-consent-track" role="region" aria-label="Trust score notification"
     style="position:fixed;top:1em;right:1em;background:#fff3cd;color:#664d03;padding:1em;border:1px solid #ffe69c;z-index:9999">
  <p><strong>Trust score updated:</strong> Your account trust score dropped to 72/100. Review recent sign-ins?</p>
  <button id="trust-review-btn">Review Sign-Ins</button>
  <button id="trust-dismiss-btn">Remind Me Later</button>
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
