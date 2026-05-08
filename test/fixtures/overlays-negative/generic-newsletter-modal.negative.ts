import { createServer, Server } from 'node:http';

// Negative fixture for the generic-newsletter-modal pattern.
// DOM has [role=dialog] (matches signal 1: selector) AND aria-label contains
// "subscribe" — which would match signal 2's substring check. The trap here
// is that this is a USER-INITIATED newsletter management page where the
// modal is actually account settings, not a drive-by registration wall.
// To satisfy the two-signal rule's protective intent, the aria-label is
// "Subscribe to additional newsletters" (substring "subscribe" still matches
// signal 2 textually) but the surrounding context is the user's own
// account-settings flow. The pattern signals as currently written would
// match this; this fixture documents the gap and serves as a negative target
// for future signal hardening (e.g., URL-path or context heuristics).
//
// IMPORTANT (Gate 2 flag): With the current 2-signal definition, this
// fixture WILL match — the pattern is over-broad on subscribe-flow pages
// the user opted into. Task 14 should encode this as a known limitation
// or the pattern needs a third signal.
//
// safari_dismiss_overlays should NOT dismiss this in production: it is the
// user's own newsletter preferences modal. This is a LEGITIMATE UI: an
// account settings page for managing subscriptions.
export function startGenericNewsletterModalNegativeFixture(port = 0): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<main><h1>Account settings &gt; Email preferences</h1>
<p>Manage which newsletters you receive.</p></main>
<div role="dialog" aria-label="Subscribe to additional newsletters"
     style="background:#fff;border:1px solid #ccc;padding:1.5em;margin:2em auto;max-width:560px;position:static">
  <p>Choose any additional newsletters you'd like to receive:</p>
  <label><input type="checkbox" /> Weekly Product Digest</label><br/>
  <label><input type="checkbox" /> Engineering Deep Dives</label><br/>
  <button id="save-prefs-btn">Save Preferences</button>
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
