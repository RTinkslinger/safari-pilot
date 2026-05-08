import { createServer, Server } from 'node:http';

// Negative fixture for the didomi-notice pattern.
// DOM has #didomi-notice (matches signal 1: selector) but the element uses
// role=alertdialog (NOT role=dialog), so signal 2 (aria-role: dialog) fails.
// safari_dismiss_overlays must NOT match this — the second signal fails.
// This represents a LEGITIMATE UI: a "Send notification email?" confirmation
// in a CRM-style app where the user is about to send a message to customers.
// Auto-dismissing this would silently send (or not send) bulk email.
export function startDidomiNoticeNegativeFixture(port = 0): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<main><h1>Customer outreach</h1><p>About to send announcement to 4,213 contacts.</p></main>
<div id="didomi-notice" role="alertdialog" aria-label="Send notification email?"
     style="position:fixed;top:30%;left:30%;background:#fff;border:1px solid #ccc;padding:1.5em;z-index:9999">
  <p>Send "Q3 Product Launch" email to 4,213 contacts now?</p>
  <button id="send-email-btn">Send Now</button>
  <button id="cancel-email-btn">Cancel</button>
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
