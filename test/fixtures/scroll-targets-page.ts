import { createServer, Server } from 'node:http';

export function startScrollTargetsServer(port = 0): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Scroll Targets Fixture</title>
<style>body{margin:0;font-family:sans-serif}.spacer{height:1200px;background:#eee}</style>
</head><body>
<div class="spacer">top</div>
<div class="spacer">middle</div>
<h2 id="answer-h2" data-testid="answer">A15 Bionic</h2>
<div class="spacer">bottom</div>
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
