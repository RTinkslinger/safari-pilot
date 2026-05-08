import { createServer, Server } from 'node:http';

// Negative fixture for the twitter-open-in-app pattern.
// DOM has [data-testid=BottomBar] (matches signal 1: selector) but aria-label
// is "Compose tweet" — does NOT contain "open in" (fails signal 2).
// safari_dismiss_overlays must NOT match this — the second signal fails.
// This represents a LEGITIMATE UI: the active compose-tweet bottom bar where
// the user is mid-draft. Auto-dismissing would discard the user's draft.
export function startTwitterOpenInAppNegativeFixture(port = 0): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<main><h1>Home</h1><p>Your timeline.</p></main>
<div data-testid="BottomBar" role="region" aria-label="Compose tweet"
     style="position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid #eee;padding:0.75em;z-index:9999">
  <textarea id="compose-textarea" placeholder="What's happening?">Working on a long thread about...</textarea>
  <button id="compose-tweet-btn">Tweet</button>
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
