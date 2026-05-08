import { createServer, Server } from 'node:http';

// Negative fixture for the smart-app-banner pattern.
// DOM has <meta name="apple-itunes-app"> (matches signal 1: selector) but
// does NOT have a .smart-app-banner or [class*=smartbanner] element (fails
// signal 2 — the second selector signal).
// safari_dismiss_overlays must NOT match this — the second signal fails.
// This represents a LEGITIMATE UI: a regular content page that declares an
// associated iOS app via the meta tag (a common SEO/deep-linking practice)
// but renders no install banner at all. Aggressively dismissing on the meta
// tag alone would touch nothing on the page, but the structural test confirms
// we never trigger dismiss logic on this signature alone.
export function startSmartAppBannerNegativeFixture(port = 0): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8" />
<meta name="apple-itunes-app" content="app-id=123456789, app-argument=https://example.com/article/42" />
</head><body>
<main><h1>Long-form article</h1>
<p>This page declares an associated iOS app via meta tag (for Universal Links / Smart App Banners
   when a user opts in via Safari settings) but does NOT render any install banner element.
   No .smart-app-banner. No [class*=smartbanner]. Just content.</p>
<article>
  <p>Body paragraph one.</p>
  <p>Body paragraph two.</p>
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
