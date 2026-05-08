import { createServer, Server } from 'node:http';

export function startSameOriginIframeServer(port = 0): { server: Server; url: () => string } {
  const inner = `<!DOCTYPE html><html><body><h2 id="iframe-target">Inside Iframe</h2></body></html>`;
  const outer = `<!DOCTYPE html><html><body><h1>Outer</h1>
<iframe src="/inner" id="inner-frame" style="width:600px;height:400px"></iframe>
</body></html>`;
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(req.url === '/inner' ? inner : outer);
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
