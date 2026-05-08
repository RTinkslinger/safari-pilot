import { createServer, Server } from 'node:http';

export function startNewsletterFixture(port = 0): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html><body>
<main><article><h1>The Article</h1><p>Read the rest after subscribing.</p></article></main>
<div role="dialog" aria-label="Subscribe to our newsletter"
     style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;padding:2em;border:1px solid #ccc;z-index:9999">
  <h2>Subscribe to read</h2>
  <input type="email" placeholder="email@example.com">
  <button>Subscribe</button>
  <button aria-label="Close">×</button>
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
