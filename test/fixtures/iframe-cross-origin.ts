import { createServer, Server } from 'node:http';

export function startCrossOriginIframeServers(): {
  outer: Server;
  inner: Server;
  outerUrl: () => string;
  stop: () => void;
} {
  const innerHtml = `<!DOCTYPE html><html><body><h2 id="cross-origin-target">Cross-Origin Iframe Content</h2></body></html>`;
  const inner = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(innerHtml);
  });
  inner.listen(0);
  const innerAddr = inner.address();
  if (typeof innerAddr === 'string' || innerAddr === null) throw new Error('no addr');
  const innerUrl = `http://127.0.0.1:${innerAddr.port}/`;

  const outerHtml = `<!DOCTYPE html><html><body><h1>Outer</h1>
<iframe src="${innerUrl}" id="cross-frame" style="width:600px;height:400px"></iframe>
</body></html>`;
  const outer = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(outerHtml);
  });
  outer.listen(0);

  return {
    outer,
    inner,
    outerUrl: () => {
      const addr = outer.address();
      if (typeof addr === 'string' || addr === null) throw new Error('no addr');
      // Use localhost (different host) to ensure cross-origin from 127.0.0.1
      return `http://localhost:${addr.port}/`;
    },
    stop: () => {
      outer.close();
      inner.close();
    },
  };
}
