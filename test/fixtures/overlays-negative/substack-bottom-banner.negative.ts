import { createServer, Server } from 'node:http';

// Negative fixture for the substack-bottom-banner pattern.
// DOM has .main-modal (matches signal 1: selector) but aria-label is
// "Account preferences" — does NOT contain "subscribe" (fails signal 2).
// safari_dismiss_overlays must NOT match this — the second signal fails.
// This represents a LEGITIMATE UI: an account preferences modal on a blog
// platform that uses the same .main-modal class. Auto-dismissing would lose
// the user's in-flight settings changes.
export function startSubstackBottomBannerNegativeFixture(port = 0): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<main><h1>Profile</h1><p>Update your account preferences.</p></main>
<div class="main-modal" role="dialog" aria-label="Account preferences"
     style="position:fixed;top:20%;left:25%;background:#fff;border:1px solid #ccc;padding:1.5em;width:50%;z-index:9999">
  <h2>Account preferences</h2>
  <label>Display name <input type="text" value="Aakash" /></label><br/>
  <label>Time zone <input type="text" value="America/Los_Angeles" /></label><br/>
  <button id="prefs-save-btn">Save</button>
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
