/**
 * Phase 5A · 5A.1 — safari_file_upload e2e (real Safari, full pipeline).
 *
 * Phase 0 spike (test/e2e/5A1-phase0-spike.test.ts) MUST PASS first —
 * vitest's alphabetical default ensures phase0-spike runs before file-upload.
 *
 * Coverage (14 tests per spec):
 *   1. Single PNG upload via vanilla <input type=file>
 *   2. Multi-file (3 different MIMEs)
 *   3. clear: true on input with prior file
 *   4. paths: [] → FILE_UPLOAD_EMPTY_PATHS
 *   5. Hidden input behind <label> (force: true)
 *   6. React Hook Form fixture (deferred to separate task — Task 16)
 *   7. Detached-element race (Task 17)
 *   8. Wrong-element-type → INVALID_ELEMENT
 *   9. Shadow-host → INVALID_ELEMENT
 *   10. Validation surface
 *   11. multiple=false + 2 paths → MULTIPLE_NOT_ALLOWED
 *   12. accept="image/*" + .pdf — pass-through
 *   13. Concurrent multi-MB uploads (Task 18)
 *   14. validationProbeMs: 0 disables probe
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';
import { startFixtureServer, type FixtureServer } from '../helpers/fixture-server.js';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('5A.1 — safari_file_upload e2e (core)', () => {
  let client: McpTestClient;
  let nextId: () => number;
  let fixture: FixtureServer;
  let workDir: string;
  let tabUrl: string | null = null;
  let pngFile: string;
  let pngBytes: Buffer;
  let pdfFile: string;
  let pdfBytes: Buffer;
  let csvFile: string;
  let csvBytes: Buffer;

  beforeAll(async () => {
    fixture = await startFixtureServer();
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
    workDir = mkdtempSync(join(tmpdir(), 'sp-5a1-e2e-'));
    pngBytes = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    pdfBytes = Buffer.from('%PDF-1.4\n');
    csvBytes = Buffer.from('a,b,c\n1,2,3\n');
    pngFile = join(workDir, 'pic.png');
    pdfFile = join(workDir, 'doc.pdf');
    csvFile = join(workDir, 'data.csv');
    writeFileSync(pngFile, pngBytes);
    writeFileSync(pdfFile, pdfBytes);
    writeFileSync(csvFile, csvBytes);

    const target = `http://127.0.0.1:${fixture.hostPort}/upload-form?sp_t5A1=${Date.now()}`;
    const r = await callTool(client, 'safari_new_tab', { url: target }, nextId(), 15_000);
    tabUrl = r['tabUrl'] as string;
    await new Promise((r) => setTimeout(r, 1500));
  }, 60_000);

  afterAll(async () => {
    if (tabUrl) {
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* */ }
    }
    if (fixture) await fixture.close();
    if (workDir) rmSync(workDir, { recursive: true, force: true });
  }, 30_000);

  it('uploads a single PNG via vanilla <input type=file>; fixture sha256 matches', async () => {
    await callTool(client, 'safari_file_upload', {
      tabUrl: tabUrl!, selector: '#file-input', paths: [pngFile],
    }, nextId(), 30_000);
    await callTool(client, 'safari_click', { tabUrl: tabUrl!, selector: '#submit' }, nextId(), 15_000);
    await new Promise((r) => setTimeout(r, 1500));
    const respCheck = await callTool(client, 'safari_evaluate', {
      tabUrl: tabUrl!, script: 'return window.__lastUploadResponse;', timeout: 5000,
    }, nextId(), 15_000);
    const resp = respCheck['value'] as { files: { name: string; size: number; mimeType: string; sha256: string }[] };
    const uploaded = resp.files.find((f) => f.name === 'pic.png');
    expect(uploaded, `pic.png not in response: ${JSON.stringify(resp)}`).toBeDefined();
    expect(uploaded!.size).toBe(pngBytes.length);
    expect(uploaded!.mimeType).toBe('image/png');
    expect(uploaded!.sha256).toBe(sha256(pngBytes));
  }, 60_000);

  it('uploads 3 files of different MIMEs; all 3 echoed with correct sha256', async () => {
    await callTool(client, 'safari_navigate', {
      tabUrl: tabUrl!, url: `http://127.0.0.1:${fixture.hostPort}/upload-form?sp_t5A1=${Date.now()}`,
    }, nextId(), 15_000);
    await new Promise((r) => setTimeout(r, 1500));

    await callTool(client, 'safari_file_upload', {
      tabUrl: tabUrl!, selector: '#file-input',
      paths: [pngFile, pdfFile, csvFile],
    }, nextId(), 30_000);
    await callTool(client, 'safari_click', { tabUrl: tabUrl!, selector: '#submit' }, nextId(), 15_000);
    await new Promise((r) => setTimeout(r, 1500));
    const respCheck = await callTool(client, 'safari_evaluate', {
      tabUrl: tabUrl!, script: 'return window.__lastUploadResponse;', timeout: 5000,
    }, nextId(), 15_000);
    const resp = respCheck['value'] as { files: { name: string; sha256: string }[] };
    expect(resp.files.find((f) => f.name === 'pic.png')?.sha256).toBe(sha256(pngBytes));
    expect(resp.files.find((f) => f.name === 'doc.pdf')?.sha256).toBe(sha256(pdfBytes));
    expect(resp.files.find((f) => f.name === 'data.csv')?.sha256).toBe(sha256(csvBytes));
  }, 60_000);

  it('clear: true empties the input', async () => {
    await callTool(client, 'safari_file_upload', {
      tabUrl: tabUrl!, selector: '#file-input', paths: [pngFile],
    }, nextId(), 30_000);
    const r = await callTool(client, 'safari_file_upload', {
      tabUrl: tabUrl!, selector: '#file-input', clear: true,
    }, nextId(), 30_000);
    const payload = r as { uploaded: number };
    expect(payload.uploaded).toBe(0);
    const verify = await callTool(client, 'safari_evaluate', {
      tabUrl: tabUrl!, script: 'return document.getElementById("file-input").files.length;', timeout: 5000,
    }, nextId(), 15_000);
    expect(verify['value']).toBe(0);
  }, 60_000);

  it('paths: [] → throws FILE_UPLOAD_EMPTY_PATHS with hint', async () => {
    let caught: { code?: string; message?: string } | null = null;
    try {
      await callTool(client, 'safari_file_upload', {
        tabUrl: tabUrl!, selector: '#file-input', paths: [],
      }, nextId(), 30_000);
    } catch (e) {
      caught = e as { code?: string; message?: string };
    }
    expect(caught).toBeDefined();
    expect(caught!.message || JSON.stringify(caught)).toContain('FILE_UPLOAD_EMPTY_PATHS');
  }, 60_000);

  it('uploads to a hidden input behind a styled label (force: true)', async () => {
    await callTool(client, 'safari_navigate', {
      tabUrl: tabUrl!, url: `http://127.0.0.1:${fixture.hostPort}/upload-form?sp_t5A1=${Date.now()}`,
    }, nextId(), 15_000);
    await new Promise((r) => setTimeout(r, 1500));

    await callTool(client, 'safari_file_upload', {
      tabUrl: tabUrl!, selector: '#hidden-input', paths: [pdfFile], force: true,
    }, nextId(), 30_000);
    const verify = await callTool(client, 'safari_evaluate', {
      tabUrl: tabUrl!, script: 'return document.getElementById("hidden-input").files.length;', timeout: 5000,
    }, nextId(), 15_000);
    expect(verify['value']).toBe(1);
  }, 60_000);

  it('wrong-element-type (selector matches button) → FILE_UPLOAD_INVALID_ELEMENT', async () => {
    let caught: { code?: string; message?: string } | null = null;
    try {
      await callTool(client, 'safari_file_upload', {
        tabUrl: tabUrl!, selector: '#submit', paths: [pngFile],
      }, nextId(), 30_000);
    } catch (e) {
      caught = e as { code?: string; message?: string };
    }
    expect(caught!.message || JSON.stringify(caught)).toContain('FILE_UPLOAD_INVALID_ELEMENT');
  }, 60_000);

  it('multiple=false + 2 paths → FILE_UPLOAD_MULTIPLE_NOT_ALLOWED', async () => {
    let caught: { code?: string; message?: string } | null = null;
    try {
      await callTool(client, 'safari_file_upload', {
        tabUrl: tabUrl!, selector: '#single-input', paths: [pngFile, pdfFile],
      }, nextId(), 30_000);
    } catch (e) {
      caught = e as { code?: string; message?: string };
    }
    expect(caught!.message || JSON.stringify(caught)).toContain('FILE_UPLOAD_MULTIPLE_NOT_ALLOWED');
  }, 60_000);

  it('accept="image/*" + .pdf upload — pass-through (Playwright parity)', async () => {
    await callTool(client, 'safari_evaluate', {
      tabUrl: tabUrl!,
      script: 'document.getElementById("single-input").setAttribute("accept", "image/*"); return true;',
      timeout: 5000,
    }, nextId(), 15_000);
    const r = await callTool(client, 'safari_file_upload', {
      tabUrl: tabUrl!, selector: '#single-input', paths: [pdfFile],
    }, nextId(), 30_000);
    const payload = r as { uploaded: number; files: { name: string }[] };
    expect(payload.uploaded).toBe(1);
    expect(payload.files[0]!.name).toBe('doc.pdf');
  }, 60_000);

  it('validationProbeMs: 0 disables the probe (validation always omitted)', async () => {
    const r = await callTool(client, 'safari_file_upload', {
      tabUrl: tabUrl!, selector: '#file-input', paths: [pngFile], validationProbeMs: 0,
    }, nextId(), 30_000);
    const payload = r as { uploaded: number; validation?: unknown };
    expect(payload.uploaded).toBe(1);
    expect(payload.validation).toBeUndefined();
  }, 60_000);

  it('React Hook Form: locator finds inner hidden input; change registers in RHF state', async () => {
    await callTool(client, 'safari_navigate', {
      tabUrl: tabUrl!, url: `http://127.0.0.1:${fixture.hostPort}/rhf-upload-form?sp_t5A1=${Date.now()}`,
    }, nextId(), 15_000);
    await new Promise((r) => setTimeout(r, 2500)); // RHF init

    // Locate via the LABEL text — verifies locator finds the inner <input>, not the wrapper.
    // NOTE: v1 minimal locator (selector/xpath/ref) does NOT yet implement `label` —
    // this test will fail even after v0.1.22 ships, flagging the locator-coverage gap.
    await callTool(client, 'safari_file_upload', {
      tabUrl: tabUrl!, label: 'Pick file:', paths: [pdfFile], force: true,
    }, nextId(), 30_000);

    // Verify RHF saw the change: submit button should be enabled and rhf-state visible
    const verify = await callTool(client, 'safari_evaluate', {
      tabUrl: tabUrl!,
      script: `return {
        submitDisabled: document.getElementById('rhf-submit').disabled,
        stateText: (document.getElementById('rhf-state') || {}).textContent || null,
      };`,
      timeout: 5000,
    }, nextId(), 15_000);
    const v = verify['value'] as { submitDisabled: boolean; stateText: string | null };
    expect(v.submitDisabled).toBe(false);
    expect(v.stateText).toContain('doc.pdf');
  }, 60_000);

  it('detached-element race: input replaced post-probe → FILE_UPLOAD_ELEMENT_DETACHED', async () => {
    await callTool(client, 'safari_navigate', {
      tabUrl: tabUrl!, url: `http://127.0.0.1:${fixture.hostPort}/upload-form?sp_t5A1=${Date.now()}`,
    }, nextId(), 15_000);
    await new Promise((r) => setTimeout(r, 1500));

    // Monkey-patch addEventListener so the message-handler installation captures
    // file_upload_inject and races to replace #file-input with a clone before the
    // MAIN-world handler (Task 13) runs. The clone is a fresh element — the original
    // is detached, and Task 13's `document.contains(input)` check should fire.
    await callTool(client, 'safari_evaluate', {
      tabUrl: tabUrl!,
      script: `
        const orig = window.addEventListener;
        window.addEventListener = function(type, handler, opts) {
          if (type === 'message') {
            const wrapped = function(ev) {
              if (ev.data && ev.data.op === 'file_upload_inject') {
                const old = document.getElementById('file-input');
                if (old) {
                  const clone = old.cloneNode(true);
                  old.parentNode.replaceChild(clone, old);
                }
              }
              return handler(ev);
            };
            return orig.call(this, type, wrapped, opts);
          }
          return orig.call(this, type, handler, opts);
        };
        return true;
      `,
      timeout: 5000,
    }, nextId(), 15_000);

    let caught: { message?: string } | null = null;
    try {
      await callTool(client, 'safari_file_upload', {
        tabUrl: tabUrl!, selector: '#file-input', paths: [pngFile],
      }, nextId(), 30_000);
    } catch (e) { caught = e as { message?: string }; }
    expect(caught!.message || JSON.stringify(caught)).toContain('FILE_UPLOAD_ELEMENT_DETACHED');
  }, 90_000);

  it('shadow-host failure mode: locator on shadow host → FILE_UPLOAD_INVALID_ELEMENT', async () => {
    await callTool(client, 'safari_navigate', {
      tabUrl: tabUrl!, url: `http://127.0.0.1:${fixture.hostPort}/upload-form?sp_t5A1=${Date.now()}`,
    }, nextId(), 15_000);
    await new Promise((r) => setTimeout(r, 1500));
    // Custom element with a closed-by-default shadow input — selector resolves to the
    // host (a <shadow-file>), NOT to <input type=file>. Task 13's tagName check fires.
    await callTool(client, 'safari_evaluate', {
      tabUrl: tabUrl!,
      script: `
        class ShadowFile extends HTMLElement {
          constructor() {
            super();
            this.attachShadow({ mode: 'open' }).innerHTML = '<input id="inner" type="file" />';
          }
        }
        if (!customElements.get('shadow-file')) customElements.define('shadow-file', ShadowFile);
        const host = document.createElement('shadow-file');
        host.id = 'shadow-host';
        document.body.appendChild(host);
        return true;
      `,
      timeout: 5000,
    }, nextId(), 15_000);

    let caught: { message?: string } | null = null;
    try {
      await callTool(client, 'safari_file_upload', {
        tabUrl: tabUrl!, selector: '#shadow-host', paths: [pngFile],
      }, nextId(), 30_000);
    } catch (e) { caught = e as { message?: string }; }
    expect(caught!.message || JSON.stringify(caught)).toContain('FILE_UPLOAD_INVALID_ELEMENT');
  }, 60_000);

  it('validation surface: site rejects via aria-invalid → response.validation populated', async () => {
    // Real-world pattern: site listens to change event on the file input, runs custom
    // validity, sets a [role=alert] sibling. Task 13's collectFileUploadValidation
    // should pick up both the validationMessage and the alert text within probeMs.
    await callTool(client, 'safari_navigate', {
      tabUrl: tabUrl!, url: `http://127.0.0.1:${fixture.hostPort}/upload-form?sp_t5A1=${Date.now()}`,
    }, nextId(), 15_000);
    await new Promise((r) => setTimeout(r, 1500));
    await callTool(client, 'safari_evaluate', {
      tabUrl: tabUrl!,
      script: `
        const wrap = document.createElement('div');
        wrap.innerHTML = '<input id="validating-input" type="file" /><div role="alert">File rejected by site rules: too large.</div>';
        document.body.appendChild(wrap);
        document.getElementById('validating-input').addEventListener('change', function() {
          this.setCustomValidity('Site says: file too large');
        });
        return true;
      `,
      timeout: 5000,
    }, nextId(), 15_000);
    const r = await callTool(client, 'safari_file_upload', {
      tabUrl: tabUrl!, selector: '#validating-input', paths: [pngFile], validationProbeMs: 300,
    }, nextId(), 30_000);
    const payload = r as { validation?: { message?: string; alerts?: string[] } };
    expect(payload.validation).toBeDefined();
    expect(
      payload.validation!.message || (payload.validation!.alerts && payload.validation!.alerts.join(' ')),
    ).toMatch(/site|rejected|too large/i);
  }, 60_000);

  it('concurrent uploads in same tab: each response surfaces only its own bytes (commandId isolation)', async () => {
    // Two parallel safari_file_upload calls against two different inputs in the
    // same tab. Each upload uses its own token + commandId; they MUST NOT collide
    // in the storage bus, the daemon's FileStagingStore, or the MAIN-world
    // postMessage routing. The litmus is sha256-equality per input — if tokens
    // crossed wires, the wrong bytes land in the wrong input and the hashes mismatch.
    await callTool(client, 'safari_navigate', {
      tabUrl: tabUrl!, url: `http://127.0.0.1:${fixture.hostPort}/upload-form?sp_t5A1=${Date.now()}`,
    }, nextId(), 15_000);
    await new Promise((r) => setTimeout(r, 1500));

    // Add a second input so the two parallel calls target distinct elements.
    await callTool(client, 'safari_evaluate', {
      tabUrl: tabUrl!,
      script: `
        const i = document.createElement('input');
        i.id = 'second-input';
        i.type = 'file';
        document.body.appendChild(i);
        return true;
      `,
      timeout: 5000,
    }, nextId(), 15_000);

    const fileA = join(workDir, 'concurrentA.bin');
    const fileB = join(workDir, 'concurrentB.bin');
    const bufA = Buffer.alloc(2 * 1024 * 1024, 0xAA);
    const bufB = Buffer.alloc(2 * 1024 * 1024, 0xBB);
    writeFileSync(fileA, bufA);
    writeFileSync(fileB, bufB);
    const shaA = sha256(bufA);
    const shaB = sha256(bufB);

    await Promise.all([
      callTool(client, 'safari_file_upload', {
        tabUrl: tabUrl!, selector: '#file-input', paths: [fileA],
      }, nextId(), 60_000),
      callTool(client, 'safari_file_upload', {
        tabUrl: tabUrl!, selector: '#second-input', paths: [fileB],
      }, nextId(), 60_000),
    ]);

    const verifyA = await callTool(client, 'safari_evaluate', {
      tabUrl: tabUrl!,
      script: `
        const f = document.getElementById('file-input').files[0];
        const buf = await f.arrayBuffer();
        const hash = await crypto.subtle.digest('SHA-256', buf);
        const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
        return { name: f.name, sha256: hex };
      `,
      timeout: 10_000,
    }, nextId(), 30_000);
    const verifyB = await callTool(client, 'safari_evaluate', {
      tabUrl: tabUrl!,
      script: `
        const f = document.getElementById('second-input').files[0];
        const buf = await f.arrayBuffer();
        const hash = await crypto.subtle.digest('SHA-256', buf);
        const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
        return { name: f.name, sha256: hex };
      `,
      timeout: 10_000,
    }, nextId(), 30_000);

    expect((verifyA['value'] as { sha256: string }).sha256).toBe(shaA);
    expect((verifyB['value'] as { sha256: string }).sha256).toBe(shaB);
  }, 120_000);
});
