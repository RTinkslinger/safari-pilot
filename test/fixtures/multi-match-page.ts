import { createServer, Server } from 'node:http';

export function startMultiMatchServer(port = 0): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Multi-match Fixture</title></head>
<body>
<h2>A15 Bionic</h2>
<p>Some text mentions A15 Bionic.</p>
<div><span>A15 Bionic</span></div>
<footer>A15 Bionic</footer>
</body></html>`;
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  server.listen(port);
  return {
    server,
    url: () => {
      const addr = server.address();
      if (typeof addr === 'string' || addr === null) throw new Error('no addr');
      return `http://127.0.0.1:${addr.port}/`;
    },
  };
}
