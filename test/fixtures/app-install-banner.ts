import { createServer, Server } from 'node:http';

export function startAppInstallFixture(port = 0): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html><head>
<meta name="apple-itunes-app" content="app-id=12345">
</head><body>
<main><h1>Mobile site</h1></main>
<div class="smart-app-banner" style="position:fixed;top:0;left:0;right:0;background:#eee;padding:1em;z-index:9999">
  <span>Open in App</span>
  <button aria-label="Close banner">×</button>
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
