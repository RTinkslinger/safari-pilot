import { createServer, Server } from 'node:http';

// Negative fixture for the bloomberg-overlay pattern.
// DOM has .paywall-banner (matches signal 1: selector) but uses
// position: static (NOT fixed), so signal 2 (fixed-position: true) fails.
// safari_dismiss_overlays must NOT match this — the second signal fails.
// This represents a LEGITIMATE UI: an inline editorial banner element
// (e.g., a "subscriber-only newsletter" promo embedded in article flow)
// that uses a class collision with .paywall-banner but is part of normal
// article layout, not an overlaid wall. Removing it would damage page layout
// and silently delete editorial content.
export function startBloombergOverlayNegativeFixture(port = 0): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<main><h1>Markets daily</h1>
<article>
  <p>Lead paragraph of the article.</p>
  <div class="paywall-banner" role="region" aria-label="Newsletter promo"
       style="position:static;background:#f0f0f0;border:1px solid #ddd;padding:1em;margin:1em 0">
    <p><strong>Get our markets newsletter:</strong> Curated daily by our editors.</p>
    <a href="/newsletter">Browse newsletters</a>
  </div>
  <p>More body content below the inline promo.</p>
</article>
</main>
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
