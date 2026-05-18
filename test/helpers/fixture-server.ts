// T55a — cross-origin iframe fixture server.
// Spawns two Node http.createServer instances on different ports.
// Different ports = different origins per same-origin policy, which is exactly
// what cross-origin iframe e2e needs without spinning up DNS or a second
// hostname. Both servers serve from test/fixtures/cross-frame/.
//
// Lifecycle: call startFixtureServer() in beforeAll, server.close() in afterAll.
// Override ports via SAFARI_PILOT_FIXTURE_PORT_HOST / _INNER env vars (default
// 19476 / 19477).

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const FIXTURE_DIR = resolve(__filename, '../../fixtures/cross-frame');

export interface FixtureServer {
  readonly hostPort: number;
  readonly innerPort: number;
  close(): Promise<void>;
}

function makeHandler() {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = (req.url ?? '/').split('?')[0];

    // 5A.8 cookie fixture: serve a page that triggers a Set-Cookie response
    // header with HttpOnly. This is the only way to install an httpOnly
    // cookie in the browser — the JS API can't. Asserting safari_get_cookies
    // sees this cookie back with httpOnly:true is the litmus for the
    // extension routing actually working end-to-end.
    // 5A.9 basic-auth fixture: respond 401 with WWW-Authenticate until the
    // request carries the expected Authorization: Basic <b64(testuser:testpass)>
    // header. Used by the auth e2e to verify safari_authenticate's DNR
    // injection actually lands on the wire.
    if (url === '/auth-protected') {
      const expected = 'Basic ' + Buffer.from('testuser:testpass', 'utf-8').toString('base64');
      const header = req.headers['authorization'];
      if (header === expected) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!DOCTYPE html><html><body><h1 id="ok">authenticated</h1></body></html>');
        return;
      }
      res.writeHead(401, {
        'Content-Type': 'text/html; charset=utf-8',
        'WWW-Authenticate': 'Basic realm="test"',
      });
      res.end('<!DOCTYPE html><html><body><h1 id="denied">401 unauthorized</h1></body></html>');
      return;
    }

    if (url === '/cookie-fixture') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': [
          'srv_session=server-set-secret; Path=/; HttpOnly; SameSite=Lax',
          'srv_visible=normal-value; Path=/; SameSite=Lax',
        ],
      });
      res.end('<!DOCTYPE html><html><body><h1>5A.8 cookie fixture</h1></body></html>');
      return;
    }

    // 5A.7 HAR fixture: returns deterministic JSON keyed by `id` query param,
    // PLUS a server-time timestamp that changes per request. The test uses the
    // timestamp to differentiate "served live by the server" from "replayed by
    // the mock layer": after dump_har + route_from_har, a subsequent fetch to
    // the same URL must return the CAPTURED timestamp, not a fresh one. The
    // `id` lets the test capture multiple distinct entries deterministically.
    if (url === '/har-fixture') {
      const idMatch = (req.url ?? '').match(/[?&]id=([^&]*)/);
      const id = idMatch ? decodeURIComponent(idMatch[1] ?? '') : 'unknown';
      const echoMatch = (req.url ?? '').match(/[?&]echo=([^&]*)/);
      const echo = echoMatch ? decodeURIComponent(echoMatch[1] ?? '') : null;
      const now = Date.now();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Har-Id': id,
        'X-Server-Timestamp': String(now),
      });
      const body: Record<string, unknown> = { id, capturedAt: now };
      if (echo !== null) body['echo'] = echo;
      res.end(JSON.stringify(body));
      return;
    }

    // 5A.1 file_upload — multipart echo. POSTs return per-file
    // {name,size,mimeType,sha256}. The sha256 lets e2e assert byte fidelity
    // through the entire daemon-stage / extension-fetch / File-construction /
    // FormData round-trip.
    if (url === '/upload-fixture' && req.method === 'POST') {
      const ct = req.headers['content-type'] || '';
      const boundaryMatch = ct.match(/boundary=([^\s;]+)/);
      if (!boundaryMatch) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('missing boundary');
        return;
      }
      const boundary = '--' + boundaryMatch[1];
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const parts = splitMultipart(body, boundary);
        const files = parts.map((p) => {
          const dispMatch = p.headers['content-disposition']?.match(/filename="([^"]*)"/);
          const name = dispMatch ? dispMatch[1] : 'unknown';
          const mime = p.headers['content-type'] || 'application/octet-stream';
          const sha256 = createHash('sha256').update(p.body).digest('hex');
          return { name, size: p.body.length, mimeType: mime, sha256 };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ files }));
      });
      return;
    }

    // 5A.1 — validation surface. Returns 400 + role=alert in HTML body so the
    // validation probe (Task 13's collectFileUploadValidation) surfaces it.
    if (url === '/upload-validate' && req.method === 'POST') {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html><body><div role="alert" id="err">File too large per site rules</div></body></html>');
      return;
    }

    // 5A.1 — static form page with multiple <input type=file> shapes:
    //   #file-input (multiple), #single-input (single), #hidden-input under <label>.
    // Submit handler stores response on window.__lastUploadResponse for e2e probe.
    if (url === '/upload-form') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body>
    <form id="f" action="/upload-fixture" method="POST" enctype="multipart/form-data">
      <input id="file-input" name="upload" type="file" multiple />
      <input id="single-input" name="single" type="file" />
      <label id="hidden-label">
        Pick file
        <input id="hidden-input" name="hidden" type="file" style="display:none" />
      </label>
      <button id="submit" type="submit">Submit</button>
    </form>
    <script>
      document.getElementById('f').addEventListener('submit', async function(e) {
        e.preventDefault();
        var fd = new FormData(e.target);
        var resp = await fetch('/upload-fixture', { method: 'POST', body: fd });
        window.__lastUploadResponse = await resp.json();
      });
    </script>
  </body></html>`);
      return;
    }

    // 5A.1 — React Hook Form fixture page (Task 16).
    // Renders a controlled <input type=file> registered via RHF useForm().
    // Hidden behind a <label>, so the label locator must unwrap to the inner input.
    // T65 — local replacement for httpbin.org/forms/post. The phase3 3.1 test
    // discriminates on a real-MouseEvent click being dispatched (SD-03 strict
    // oracle). The pre-T65 test used httpbin.org's `/forms/post` and asserted
    // a pathname change post-click. Both httpbin AND a local equivalent
    // exhibit an unidentified browser-side behaviour where filling
    // `input[name="custname"]` causes the tab to navigate BEFORE the test's
    // explicit click — dropping the original tabUrl from the extension cache
    // and surfacing TAB_NOT_FOUND on click. Root cause filed as T74.
    //
    // Workaround: discriminator switched from pathname change to a state
    // variable set by an explicit `click` event handler on the submit
    // button. The form `preventDefault`s on submit so the page does NOT
    // navigate, sidestepping the T74 navigation. The oracle stays strong:
    // a stub `safari_click` that fabricates `{clicked:true}` without
    // dispatching a real MouseEvent does not fire the handler, so
    // `window.__t65_clicked` stays undefined and the test fails.
    // T43 — storage tools fixture. Seeds an IndexedDB database "t43db" with
    // an object store "items" containing two records (id=1, id=2). All
    // T43-storage e2e tests target this single page.
    // T43 — observation fixture. Contains: an <img>, a <table> with header
    // + 2 data rows, several <a>, a <meta description>, and an inline script
    // that emits a known console.log seed string on load. All T43-observation
    // e2e tests target this single page.
    // T43 — interaction fixture. Exposes named target elements for
    // hover / dblclick / drag / press_key / type / select / scroll / check
    // tests; an inline script records events into window.__t43_int = [].
    // T43 — network fixture. Issues a fetch on page load so the network
    // log has at least one entry; exposes a #t43-monitor-target div for
    // monitor_page DOM-watch.
    // T43 — misc fixture. Has a <video>, a Shadow DOM host with an inner
    // button, and basic structure for smart_scrape / paginate_scrape.
    // T43 — download fixture. /t43-download-page serves a page with an
    // anchor that downloads /t43-download-file (Content-Disposition: attachment).
    if (url === '/t43-download-page') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body>
    <a id="t43-dl" href="/t43-download-file" download="t43-download.txt">download</a>
  </body></html>`);
      return;
    }
    if (url.startsWith('/t43-download-file')) {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="t43-download.txt"',
      });
      res.end('T43 download payload — ' + new Date().toISOString());
      return;
    }

    if (url === '/t43-misc') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body>
    <h1>T43 misc fixture</h1>
    <video id="t43-video" muted loop playsinline width="200" height="100" preload="auto">
      <source src="data:video/mp4;base64,AAAA" type="video/mp4" />
    </video>
    <div id="t43-shadow-host"></div>
    <p id="t43-misc-content">Some scrapeable content for smart_scrape.</p>
    <script>
      // Open shadow root with a button that records its click via a global
      // window flag — proves safari_click_shadow pierces the boundary.
      var host = document.getElementById('t43-shadow-host');
      var root = host.attachShadow({ mode: 'open' });
      var btn = document.createElement('button');
      btn.id = 'shadow-btn';
      btn.textContent = 'shadow click';
      btn.addEventListener('click', function () {
        window.__t43_shadow_clicked = true;
      });
      root.appendChild(btn);
    </script>
  </body></html>`);
      return;
    }

    if (url === '/t43-network') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body>
    <h1>T43 network fixture</h1>
    <div id="t43-monitor-target">initial-content</div>
    <script>
      // Page-load fetch. Hits /t43-net-fixture-fetch (defined as a 200 OK
      // route below) so list_network_requests + get_network_request have
      // a stable entry to find.
      fetch('/t43-net-fixture-fetch?ts=' + Date.now()).catch(function () {});
    </script>
  </body></html>`);
      return;
    }
    if (url.startsWith('/t43-net-fixture-fetch')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true,"marker":"t43-fixture-fetch"}');
      return;
    }

    if (url === '/t43-interaction') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body>
    <h1 id="page-title">T43 interaction fixture</h1>
    <div id="t43-hover" style="padding:8px;background:#eee;">hover target</div>
    <div id="t43-dblclick" style="padding:8px;background:#ddd;">dblclick target</div>
    <div id="t43-drag-src" draggable="true" style="padding:8px;background:#cce;">drag source</div>
    <div id="t43-drag-tgt" style="padding:8px;background:#ecc;">drop target</div>
    <input id="t43-keys" type="text" style="margin:8px;" />
    <input id="t43-type" type="text" style="margin:8px;" />
    <select id="t43-select">
      <option value="alpha">Alpha</option>
      <option value="beta">Beta</option>
      <option value="gamma">Gamma</option>
    </select>
    <input id="t43-check" type="checkbox" />
    <div id="spacer" style="height:2000px;"></div>
    <script>
      window.__t43_int = [];
      function record(ev, extra) {
        window.__t43_int.push(Object.assign({ type: ev.type }, extra || {}));
      }
      var hover = document.getElementById('t43-hover');
      hover.addEventListener('mouseover', function (e) { record(e); });
      var dbl = document.getElementById('t43-dblclick');
      dbl.addEventListener('dblclick', function (e) { record(e, { detail: e.detail }); });
      var src = document.getElementById('t43-drag-src');
      src.addEventListener('mousedown', function (e) { record(e); });
      src.addEventListener('dragstart', function (e) { record(e); });
      var tgt = document.getElementById('t43-drag-tgt');
      tgt.addEventListener('mouseup', function (e) { record(e); });
      tgt.addEventListener('drop', function (e) { record(e); });
      // Use a body-level keydown listener so safari_press_key (which targets
      // the active document) lands here regardless of focus.
      document.addEventListener('keydown', function (e) {
        record(e, { key: e.key });
      });
      // safari_select_option's change observer.
      document.getElementById('t43-select').addEventListener('change', function (e) {
        record(e, { selectedValue: e.target.value });
      });
    </script>
  </body></html>`);
      return;
    }

    if (url === '/t43-observation') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html>
  <head>
    <title>T43 observation fixture</title>
    <meta name="description" content="seeded for safari_extract_metadata" />
    <meta name="author" content="T43" />
  </head>
  <body>
    <h1>T43 observation</h1>
    <img src="data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>" alt="t43-observation-image" />
    <table id="t43-table">
      <thead><tr><th>Col A</th><th>Col B</th></tr></thead>
      <tbody>
        <tr><td>row1a</td><td>row1b</td></tr>
        <tr><td>row2a</td><td>row2b</td></tr>
      </tbody>
    </table>
    <a href="https://example.com/one">t43 anchor one</a>
    <a href="https://example.com/two">t43 anchor two</a>
    <script>
      console.log('T43 console seed marker');
      console.warn('T43 warn marker');
    </script>
  </body></html>`);
      return;
    }

    if (url === '/t43-storage') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body>
    <h1 id="t43-storage-page">T43 storage fixture</h1>
    <script>
      // Seed t43db on load. Every page navigation re-seeds — idempotent
      // (records already present are overwritten with put()).
      (function () {
        var open = indexedDB.open('t43db_v2', 1);
        open.onupgradeneeded = function (e) {
          var db = e.target.result;
          if (!db.objectStoreNames.contains('items')) {
            db.createObjectStore('items', { keyPath: 'id' });
          }
        };
        open.onsuccess = function (e) {
          var db = e.target.result;
          var tx = db.transaction(['items'], 'readwrite');
          var store = tx.objectStore('items');
          // Clear any prior-run data so the seeded set is deterministic.
          store.clear();
          store.put({ id: 1, name: 'first' });
          store.put({ id: 2, name: 'second' });
          tx.oncomplete = function () {
            window.__t43_idb_seeded = true;
            db.close();
          };
        };
        open.onerror = function () { window.__t43_idb_error = true; };
      })();
    </script>
  </body></html>`);
      return;
    }

    // T77 — locator chaining + T80 strict mode fixture.
    // Three list items with per-item Add-to-cart buttons, one Cancel button,
    // and one Cancel link. Used by T77 chaining tests and T80 strictness tests.
    if (url === '/t77-list') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html><head><title>T77 list</title></head><body>
  <ul id="products">
    <li data-product="p1">Product 1 <button>Add to cart</button></li>
    <li data-product="p2">Product 2 <button>Add to cart</button></li>
    <li data-product="p3">Product 3 <button>Add to cart</button></li>
  </ul>
  <button data-testid="cancel">Cancel</button>
  <a href="#" data-testid="cancel-link">Cancel</a>
</body></html>`);
      return;
    }

    // T79 — selectorPack custom engines fixture.
    // 3 rows with data-status; pack engines query by status value.
    if (url === '/t79-pack') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html><head><title>T79 pack</title></head><body>
  <div data-status="approved">Row A</div>
  <div data-status="pending">Row B</div>
  <div data-status="approved">Row C</div>
</body></html>`);
      return;
    }

    // T78 — safari_query_all multi-element extraction fixture.
    // 4 cells, each with a Buy button. Used to verify rich-payload shape, limit
    // capping, and ref flow into action tools.
    if (url === '/t78-grid') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html><head><title>T78 grid</title></head><body>
  <div id="grid">
    <div class="cell" data-id="c1">Alpha <button>Buy</button></div>
    <div class="cell" data-id="c2">Beta <button>Buy</button></div>
    <div class="cell" data-id="c3">Gamma <button>Buy</button></div>
    <div class="cell" data-id="c4">Delta <button>Buy</button></div>
  </div>
</body></html>`);
      return;
    }

    if (url === '/t65-form') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body>
    <form id="t65-form" action="/t65-result" method="POST">
      <input id="custname" name="custname" type="text" autocomplete="off" />
      <input id="custtel" name="custtel" type="tel" autocomplete="off" />
      <button id="submit" type="submit">Submit</button>
    </form>
    <script>
      // Capture an explicit click event before the form's submit default.
      // window.__t65_clicked is the test's discriminator — set ONLY when a
      // real MouseEvent reaches the button.
      document.getElementById('submit').addEventListener('click', function (e) {
        window.__t65_clicked = { ts: Date.now(), button: e.button, isTrusted: e.isTrusted };
      });
      // Suppress navigation so the tab URL stays put for the verify-eval call.
      document.getElementById('t65-form').addEventListener('submit', function (e) {
        e.preventDefault();
      });
    </script>
  </body></html>`);
      return;
    }

    if (url === '/rhf-upload-form') {
      try {
        const body = readFileSync(resolve(FIXTURE_DIR, 'rhf-upload-form.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(body);
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('rhf fixture not found');
      }
      return;
    }

    // bench-* fixture routes for agent benchmark tasks (T2)
    if (url === '/bench-smoke') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><h1>Hello from Smoke</h1></body></html>');
      return;
    }
    if (url === '/bench-h1') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><h1>Quarterly Report 2026</h1><p>Body content</p></body></html>');
      return;
    }
    if (url === '/bench-list') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><ul class="product-list"><li>Apple</li><li>Banana</li><li>Cherry</li></ul></body></html>');
      return;
    }
    if (url === '/bench-form') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body>
    <form id="f"><label>Email <input name="email" id="email"/></label>
    <button type="button" id="submit">Submit</button></form>
    <div id="msg"></div>
    <script>
      document.getElementById('submit').onclick = () => {
        const v = document.getElementById('email').value;
        document.getElementById('msg').innerText = 'Thanks, ' + v;
      };
    </script></body></html>`);
      return;
    }
    if (url === '/bench-paginate') {
      const rawUrl = req.url ?? '/bench-paginate';
      const u = new URL(rawUrl, 'http://x');
      const page = u.searchParams.get('page') ?? '1';
      const items =
        page === '1' ? ['Item-1A', 'Item-1B'] :
        page === '2' ? ['Item-2A', 'Item-2B'] :
        ['Item-3A', 'Item-3B'];
      const next =
        page === '3'
          ? ''
          : `<a href="/bench-paginate?page=${Number(page) + 1}" class="next">Next</a>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body>${items.map((i) => `<div class="item">${i}</div>`).join('')}${next}</body></html>`);
      return;
    }
    if (url === '/bench-strict') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><body>
    <button>Sign In</button>
    <button>Sign In</button>
    <button data-test="primary-signin">Sign In</button>
    <script>
      document.querySelectorAll('button').forEach(b => {
        if (b.dataset.test === 'primary-signin') {
          b.onclick = () => { location.href = '/signed-in'; };
        }
      });
    </script></body></html>`);
      return;
    }
    if (url === '/signed-in') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><h1>Signed In</h1></body></html>');
      return;
    }

    // v0.1.35 Task 10: fixture for safari_query_all interactability hints.
    // Four targets, one per axis the buildInteractability builder reports:
    //   - <button>Click me</button>             → clickable, focusable, role=button
    //   - <button disabled aria-disabled=...>   → !clickable, isAriaDisabled
    //   - <input type="text" />                  → fillable, focusable, role=textbox
    //   - <a href="#">A link</a>                 → clickable, focusable, role=link
    if (url === '/interactivity') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body>
<button>Click me</button>
<button disabled aria-disabled="true">No</button>
<input type="text" />
<a href="#">A link</a>
</body></html>`);
      return;
    }

    // v0.1.35 Task 9: fixture for safari_dismiss_cookie_consent. Mirrors the
    // OneTrust pattern in src/overlays/cookie-consent.json — both signals must
    // match (selector #onetrust-banner-sdk AND aria-label containing "cookie")
    // for findPatternRoot to identify the banner. The dismiss button selector
    // (#onetrust-accept-btn-handler) is what L.dismissPattern clicks.
    if (url === '/cookie-banner') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html><body>
<div id="onetrust-banner-sdk" role="dialog" aria-label="Cookie Notice" style="position:fixed;bottom:0;left:0;right:0;padding:1em;background:#000;color:#fff">
  <p>This site uses cookies.</p>
  <button id="onetrust-accept-btn-handler" onclick="document.getElementById('onetrust-banner-sdk').remove()">Accept</button>
</div>
<p>Page content here.</p>
</body></html>`);
      return;
    }

    // v0.1.35 Task 7: fixture for safari_compose_final_evidence — a small
    // recipe-style page with a discrete rating block we can locator-target.
    if (url === '/with-claim') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html><html>
<head><title>Recipe</title></head>
<body>
<h1>Spinach Lasagna</h1>
<div id="rating-block">4.5 stars &middot; 563 ratings</div>
<p>This is a delicious vegetarian recipe.</p>
</body>
</html>`);
      return;
    }

    const file = url === '/' ? 'host.html' : url.replace(/^\/+/, '');
    try {
      const body = readFileSync(resolve(FIXTURE_DIR, file));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  };
}

interface MultipartPart {
  headers: Record<string, string>;
  body: Buffer;
}

function splitMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const boundaryBuf = Buffer.from(boundary);
  const parts: MultipartPart[] = [];
  let pos = 0;
  while (pos < body.length) {
    const start = body.indexOf(boundaryBuf, pos);
    if (start < 0) break;
    const partStart = start + boundaryBuf.length + 2; // skip \r\n
    const next = body.indexOf(boundaryBuf, partStart);
    if (next < 0) break;
    const partEnd = next - 2; // skip trailing \r\n
    if (partEnd <= partStart) { pos = next; continue; }
    const slice = body.subarray(partStart, partEnd);
    const sep = slice.indexOf('\r\n\r\n');
    if (sep < 0) { pos = next; continue; }
    const headerBlock = slice.subarray(0, sep).toString('utf-8');
    const partBody = slice.subarray(sep + 4);
    const headers: Record<string, string> = {};
    for (const line of headerBlock.split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
    }
    parts.push({ headers, body: partBody });
    pos = next;
  }
  return parts;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', rejectListen);
      resolveListen();
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

export async function startFixtureServer(): Promise<FixtureServer> {
  const hostPort = Number.parseInt(process.env['SAFARI_PILOT_FIXTURE_PORT_HOST'] ?? '19476', 10);
  const innerPort = Number.parseInt(process.env['SAFARI_PILOT_FIXTURE_PORT_INNER'] ?? '19477', 10);

  const hostServer = createServer(makeHandler());
  const innerServer = createServer(makeHandler());

  await Promise.all([listen(hostServer, hostPort), listen(innerServer, innerPort)]);

  return {
    hostPort,
    innerPort,
    close: () => Promise.all([close(hostServer), close(innerServer)]).then(() => undefined),
  };
}
