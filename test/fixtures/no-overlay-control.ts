import { createServer, Server } from 'node:http';

export function startNoOverlayFixture(port = 0): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html><body><main><h1>Clean page</h1><p>No overlays here.</p></main></body></html>`;
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
