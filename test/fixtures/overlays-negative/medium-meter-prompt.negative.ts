import { createServer, Server } from 'node:http';

// Negative fixture for the medium-meter-prompt pattern.
// DOM has [data-testid=metered-prompt] (matches signal 1: selector) but the
// element uses role=alertdialog (NOT role=dialog), so signal 2 fails.
// safari_dismiss_overlays must NOT match this — the second signal fails.
// This represents a LEGITIMATE UI: a usage-meter ALERT — e.g., "You have
// 3 articles left this month. Save your reading progress?" — that demands
// a real user choice, not a drive-by dismiss.
export function startMediumMeterPromptNegativeFixture(port = 0): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<main><h1>Article reader</h1><p>You're enjoying our content.</p></main>
<div data-testid="metered-prompt" role="alertdialog" aria-label="Reading progress alert"
     style="position:fixed;bottom:1em;right:1em;background:#fff3cd;color:#664d03;padding:1em;border:1px solid #ffe69c;z-index:9999">
  <p><strong>Heads up:</strong> Your reading session has been active for 90 minutes. Save your progress before logging out?</p>
  <button id="save-progress-btn">Save Progress</button>
  <button id="dismiss-progress-btn">Continue Reading</button>
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
