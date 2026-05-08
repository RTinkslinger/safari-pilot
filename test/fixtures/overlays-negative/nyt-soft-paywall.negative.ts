import { createServer, Server } from 'node:http';

// Negative fixture for the nyt-soft-paywall pattern.
// DOM has #gateway-content (matches signal 1: selector) but aria-label is
// "Sign in to comment" — does NOT contain "subscribe" (fails signal 2).
// safari_dismiss_overlays must NOT match this — the second signal fails.
// This represents a LEGITIMATE UI: a sign-in gate for a non-paywall feature
// (commenting). Removing this overlay would not bypass anything (the comment
// composer below is still gated server-side) but auto-dismissing it
// communicates the WRONG thing — the user might think they're past the
// paywall when in fact they were never gated by one. Two-signal saves us.
export function startNytSoftPaywallNegativeFixture(port = 0): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<main><h1>Article</h1><p>Article body, fully readable.</p>
<section id="comments-section"><h2>Comments (143)</h2></section></main>
<div id="gateway-content" role="dialog" aria-label="Sign in to comment"
     style="position:fixed;bottom:0;left:0;right:0;background:#fff;border-top:1px solid #eee;padding:1em;z-index:9999">
  <p>Want to join the conversation? Sign in to leave a comment.</p>
  <button id="signin-comment-btn">Sign In</button>
  <button id="signin-cancel-btn">Maybe later</button>
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
