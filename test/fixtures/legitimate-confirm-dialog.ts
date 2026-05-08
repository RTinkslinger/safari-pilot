import { createServer, Server } from 'node:http';

// DANGER FIXTURE: a LEGITIMATE confirmation dialog that the agent must NEVER
// auto-dismiss. It deliberately uses a similar shape to allowlist patterns
// (role=dialog, modal positioning, close button) but the content is a
// destructive action confirmation. If safari_dismiss_overlays dismisses
// THIS, real users lose state. The e2e test in Task 12 asserts dismissed=[]
// against this fixture. This is the safety regression test for the highest-
// risk capability shipped in v0.1.31.

export function startLegitimateConfirmFixture(port = 0): { server: Server; url: () => string } {
  const html = `<!DOCTYPE html>
<html><body>
<main><h1>Settings</h1><p>You have unsaved changes.</p></main>
<div role="dialog" aria-label="Confirm: discard your unsaved changes?"
     style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#fff;padding:2em;border:2px solid #c00;z-index:9999">
  <h2>Discard unsaved changes?</h2>
  <p>This action cannot be undone.</p>
  <button>Cancel</button>
  <button>Discard</button>
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
