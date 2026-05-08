import { createServer, Server } from 'node:http';

export function startShadowCookieFixture(port = 0): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<main><h1>Article body</h1></main>
<div id="cookie-host" style="position:fixed;bottom:0;left:0;right:0;z-index:9999"></div>
<script>
  const host = document.getElementById('cookie-host');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = \`
    <div id="onetrust-banner-sdk" role="dialog" aria-label="cookie consent">
      <p>Cookies, etc.</p>
      <button id="onetrust-accept-btn-handler">Accept</button>
    </div>
  \`;
</script>
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
