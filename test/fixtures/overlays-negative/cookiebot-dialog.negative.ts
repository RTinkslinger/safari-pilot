import { createServer, Server } from 'node:http';

// Negative fixture for the cookiebot-dialog pattern.
// DOM has #CybotCookiebotDialog (matches signal 1: selector) and the element
// IS a [role=dialog] (would match signal 2). To make the two-signal rule
// catch this, this fixture omits role=dialog from the matching element so the
// second signal fails — the cookiebot-dialog id is reused, but for a "Save
// your draft?" confirmation that uses role=alertdialog instead of dialog.
// safari_dismiss_overlays must NOT match — the aria-role signal fails.
// This represents a LEGITIMATE UI: an editor's unsaved-draft prompt the user
// must consciously decide to save vs. discard.
export function startCookiebotDialogNegativeFixture(port = 0): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head><body>
<main><h1>Document editor</h1><p>Your draft has unsaved changes.</p></main>
<div id="CybotCookiebotDialog" role="alertdialog" aria-label="Save your draft?"
     style="position:fixed;top:30%;left:30%;background:#fff;border:1px solid #ccc;padding:1.5em;z-index:9999">
  <p>You have unsaved edits to "Q3 Strategy Memo". Save your draft before closing?</p>
  <button id="save-draft-btn">Save Draft</button>
  <button id="discard-draft-btn">Discard</button>
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
