import { createServer, Server } from 'node:http';

// Negative fixture for the ft-modal-paywall pattern.
// DOM has .o-modal[data-o-component=o-overlay] (matches signal 1: selector)
// but aria-label is "Cookie preferences" — does NOT contain "subscribe"
// (fails signal 2).
// safari_dismiss_overlays must NOT match this paywall pattern — the second
// signal fails. (Note: a separate cookie-consent pattern would handle the
// cookie banner case via a different category; that's correct routing.)
// This represents a LEGITIMATE UI on the FT site reusing the o-overlay
// component for a cookie preferences modal — distinct from the subscribe gate.
export function startFtModalPaywallNegativeFixture(port = 0): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<main><h1>Front page</h1><p>Top stories.</p></main>
<div class="o-modal" data-o-component="o-overlay" role="dialog" aria-label="Cookie preferences"
     style="position:fixed;top:20%;left:25%;background:#fff;border:1px solid #ccc;padding:1.5em;width:50%;z-index:9999">
  <h2>Cookie preferences</h2>
  <p>Adjust your cookie settings for this site.</p>
  <label><input type="checkbox" checked /> Strictly necessary</label><br/>
  <label><input type="checkbox" /> Analytics</label><br/>
  <button id="cookie-prefs-save-btn">Save preferences</button>
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
