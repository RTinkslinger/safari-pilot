import { createServer, Server } from 'node:http';

export function startOneTrustFixture(port = 0): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<main><h1>Article body</h1><p>Content the user came for.</p></main>
<div id="onetrust-banner-sdk" role="dialog" aria-label="We value your privacy. Cookie preferences."
     style="position:fixed;bottom:0;left:0;right:0;background:#222;color:#fff;padding:1em;z-index:9999">
  <p>This site uses cookies.</p>
  <button id="onetrust-accept-btn-handler">Accept All Cookies</button>
  <button id="onetrust-reject-all-handler">Reject All</button>
</div>
<script>
  // Mimic OneTrust's real behavior: Accept/Reject removes the banner.
  // Without this the pattern's verify (node-removed) fails and dismissal lands in skipped[].
  function removeBanner(){var n=document.getElementById('onetrust-banner-sdk');if(n)n.parentNode.removeChild(n);}
  document.getElementById('onetrust-accept-btn-handler').addEventListener('click',removeBanner);
  document.getElementById('onetrust-reject-all-handler').addEventListener('click',removeBanner);
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
