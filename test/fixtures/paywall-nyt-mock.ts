import { createServer, Server } from 'node:http';

export function startPaywallNytMockFixture(port = 0): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html><body>
<main><article><h1 data-testid="article-headline">The Article Headline</h1>
<div data-testid="article-body"><p>Article body that becomes visible only after paywall removal.</p></div>
</article></main>
<div id="gateway-content" role="dialog" aria-label="Subscribe to continue reading"
     style="position:fixed;bottom:0;left:0;right:0;background:#fff;padding:2em;z-index:9999;border-top:2px solid #000">
  <h2>Subscribe to The Times</h2>
  <button>Subscribe</button>
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
