import { createServer, Server } from 'node:http';

// Negative fixture for the generic-aria-cookie pattern.
// Pattern signal 1 selector: [role=dialog][aria-label*=cookie i], [role=dialog][aria-label*=consent i]
// This DOM has [role=dialog] (the structural shape) but aria-label is
// "Document upload" — does NOT contain "cookie" or "consent", so the
// pattern's selector itself does not match. Even if a future relaxation
// dropped the aria-label clauses out of the selector, signal 2
// (fixed-position: true) would still need to hold: this fixture also uses
// position: static so the second signal also fails.
// safari_dismiss_overlays must NOT match this.
// This represents a LEGITIMATE UI: a file upload dialog where the user is
// actively staging a document for upload. Auto-dismissing would discard work.
export function startGenericAriaCookieNegativeFixture(port = 0): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<main><h1>File upload</h1><p>Drop your file to upload.</p></main>
<div role="dialog" aria-label="Document upload"
     style="position:static;background:#fff;border:1px solid #ccc;padding:1.5em;margin:2em auto;max-width:480px">
  <p>Upload "annual-report-2026.pdf" (3.2MB)?</p>
  <button id="upload-confirm-btn">Upload</button>
  <button id="upload-cancel-btn">Cancel</button>
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
