import { createServer, Server } from 'node:http';

// Negative fixture for the onetrust-banner pattern.
// DOM has #onetrust-banner-sdk (matches signal 1: selector) but aria-label is
// about a purchase confirmation, NOT containing "cookie" (fails signal 2).
// safari_dismiss_overlays must NOT match this — the second signal fails.
// This represents a LEGITIMATE UI: a real purchase confirmation modal that
// happens to reuse the OneTrust container ID (e.g., a misconfigured site or a
// custom-built confirmation that collides on ID). Auto-dismissing this would
// silently confirm a $49.99 charge against the user's intent.
export function startOnetrustBannerNegativeFixture(port = 0): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<main><h1>Checkout</h1><p>Review your order before confirming.</p></main>
<div id="onetrust-banner-sdk" role="dialog" aria-label="Confirm your purchase: $49.99"
     style="position:fixed;bottom:0;left:0;right:0;background:#fff;color:#222;padding:1em;z-index:9999">
  <p>You are about to be charged <strong>$49.99</strong> for "Pro Plan (Annual)".</p>
  <button id="confirm-purchase-btn">Confirm Purchase</button>
  <button id="cancel-purchase-btn">Cancel</button>
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
