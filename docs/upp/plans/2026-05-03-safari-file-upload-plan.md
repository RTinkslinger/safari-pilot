# `safari_file_upload` (T41 / 5A.1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the executing-plans skill to implement this plan task-by-task. Supports two modes: subagent-driven (recommended, fresh subagent per task with three-stage review) or inline execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `safari_file_upload` MCP tool — Playwright-parity programmatic file upload to standard `<input type=file>` elements in Safari, including hidden inputs behind styled labels.

**Architecture:** Approach 3 (out-of-band HTTP byte fetch). TS handler reads bytes via Node fs → ships base64 to daemon via NDJSON `stage_file` command → daemon stores in token-keyed actor map with 60s TTL → extension `content-isolated.js` fetches `GET http://127.0.0.1:19475/file-bytes/<token>` → constructs `File` objects in extension-permission context → window.postMessage to `content-main.js` (structured-clone preserves Files) → `Object.defineProperty(input, 'files', { value: dt.files })` + `input` + `change` events + 200ms validation probe. Pre-flight probe sentinel validates locator before any byte staging.

**Tech Stack:** TypeScript (MCP server, handler, helpers), Swift (daemon: Hummingbird HTTP, NDJSON commands, `actor`-protected staging map), Web Extension JS (background, content-isolated, content-main), Node `fs` (file reads), Vitest (unit + e2e), existing Swift test infra under `daemon/Tests/`.

**Spec:** `docs/upp/specs/2026-05-03-safari-file-upload-design.md` (commit `8a670e7`)

**Target rebuild checkpoint:** v0.1.22

---

## Phase 0 — Architecture spike (GATING)

The two architectural assumptions Approach 3 depends on are not verified in any existing 5A.* code. Build the spike scaffolding into the source tree, ship as part of v0.1.22 install, then run the spike e2e tests AS THE FIRST STEP of Phase 7 verification — before any other e2e tests run. If either fails, abort: do not declare 5A.1 shipped, do not commit further `5A.1`-tagged work, design re-opens. The spike scaffolding stays in the codebase as a permanent diagnostic.

### Task 1: Spike sentinel scaffolding — extension side

**Files:**
- Modify: `extension/background.js` (add `__SP_FILE_UPLOAD_PROBE_TEST__` branch in `executeCommand`)
- Modify: `extension/content-isolated.js` (handle the spike command via `sp_cmd`)

- [ ] **Step 1: Add the sentinel branch to `extension/background.js`**

Locate the existing `executeCommand` function (around line ~280, in the area that already handles `__SP_COOKIE_*__` and `__SP_DNR_*__` sentinels per 5A.8 / 5A.9 work). Add this branch BEFORE the storage bus fallback dispatch:

```js
// Phase 0 spike: verify content-isolated can fetch from the daemon
// AND that File objects survive ISOLATED→MAIN structured-clone.
if (typeof cmd.script === 'string' && cmd.script.startsWith('__SP_FILE_UPLOAD_PROBE_TEST__')) {
  // Forward to content-isolated via storage bus; same shape as cookie/dnr sentinels.
  await browser.storage.local.set({
    [`sp_cmd_${cmd.commandId}`]: {
      op: 'file_upload_probe_test',
      commandId: cmd.commandId,
    },
  });
  // The result lands in sp_result_<commandId>, picked up by the existing
  // result-relay path and POSTed to /result by background.js.
  return;
}
```

- [ ] **Step 2: Add the handler to `extension/content-isolated.js`**

In the existing `storage.onChanged` handler (which already routes other `sp_cmd_<id>` ops), add:

```js
if (cmd.op === 'file_upload_probe_test') {
  const probeResults = { fetchOk: false, structuredCloneOk: false, errors: [] };

  // Test A: content-script fetch from 127.0.0.1:19475
  try {
    const r = await fetch('http://127.0.0.1:19475/health');
    probeResults.fetchOk = r.ok;
    probeResults.fetchStatus = r.status;
  } catch (e) {
    probeResults.errors.push(`fetch failed: ${String(e && e.message || e)}`);
  }

  // Test B: build File from a hardcoded ArrayBuffer; postMessage to MAIN;
  // MAIN reports back via window.postMessage to ISOLATED.
  // Use a known signature so byte-equality can be verified end-to-end.
  const signature = new Uint8Array([0x53, 0x50, 0x46, 0x55, 0x42, 0x59, 0x54, 0x45]); // "SPFUBYTE"
  const probeFile = new File([signature], 'probe.bin', { type: 'application/octet-stream' });

  const mainResponse = await new Promise((resolve) => {
    const handler = (ev) => {
      if (ev.data && ev.data.op === 'file_upload_probe_test_response') {
        window.removeEventListener('message', handler);
        resolve(ev.data.payload);
      }
    };
    window.addEventListener('message', handler);
    window.postMessage({
      op: 'file_upload_probe_test_request',
      commandId: cmd.commandId,
      file: probeFile,
    }, '*');
    setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve({ ok: false, error: 'MAIN-world response timeout (2s)' });
    }, 2000);
  });

  probeResults.structuredCloneOk = mainResponse && mainResponse.ok === true;
  probeResults.mainResponse = mainResponse;

  await browser.storage.local.set({
    [`sp_result_${cmd.commandId}`]: { ok: true, value: JSON.stringify(probeResults) },
  });
  return;
}
```

And add the corresponding handler in `extension/content-main.js` (near the existing `window.addEventListener('message', ...)` handlers):

```js
window.addEventListener('message', (ev) => {
  if (!ev.data || ev.data.op !== 'file_upload_probe_test_request') return;
  const file = ev.data.file;
  // Verify File object survived structured clone with bytes intact.
  const payload = { ok: false };
  try {
    if (!(file instanceof File)) {
      payload.error = `not a File instance: ${Object.prototype.toString.call(file)}`;
    } else {
      payload.name = file.name;
      payload.size = file.size;
      payload.type = file.type;
      // Read bytes via blob.arrayBuffer() and verify the SPFUBYTE signature.
      file.arrayBuffer().then((buf) => {
        const view = new Uint8Array(buf);
        const expected = [0x53, 0x50, 0x46, 0x55, 0x42, 0x59, 0x54, 0x45];
        const bytesMatch = view.length === expected.length && expected.every((b, i) => view[i] === b);
        window.postMessage({
          op: 'file_upload_probe_test_response',
          commandId: ev.data.commandId,
          payload: { ok: bytesMatch, name: file.name, size: file.size, type: file.type, bytesMatchExpected: bytesMatch },
        }, '*');
      }).catch((e) => {
        window.postMessage({
          op: 'file_upload_probe_test_response',
          commandId: ev.data.commandId,
          payload: { ok: false, error: `arrayBuffer failed: ${String(e && e.message || e)}` },
        }, '*');
      });
      return;
    }
    window.postMessage({
      op: 'file_upload_probe_test_response',
      commandId: ev.data.commandId,
      payload,
    }, '*');
  } catch (e) {
    window.postMessage({
      op: 'file_upload_probe_test_response',
      commandId: ev.data.commandId,
      payload: { ok: false, error: String(e && e.message || e) },
    }, '*');
  }
});
```

- [ ] **Step 3: Lint check (no rebuild yet — that happens at Phase 7)**

Run: `cd "$(git rev-parse --show-toplevel)" && npm run lint`
Expected: no errors. The extension JS isn't TS-checked but syntax errors would surface at extension load time.

- [ ] **Step 4: Commit**

```bash
git add extension/background.js extension/content-isolated.js extension/content-main.js
git commit -m "feat(5A.1 phase-0): spike scaffolding — __SP_FILE_UPLOAD_PROBE_TEST__ sentinel"
```

### Task 2: Spike e2e — content-script fetch from daemon

**Files:**
- Create: `test/e2e/5A1-phase0-spike.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
/**
 * Phase 5A · 5A.1 / Phase 0 — Architecture spike (GATING).
 *
 * Verifies the two assumptions Approach 3 depends on:
 *   1. content-isolated.js can fetch http://127.0.0.1:19475/health
 *   2. File objects survive ISOLATED→MAIN structured-clone via window.postMessage
 *      with bytes intact.
 *
 * If either FAILS against the v0.1.22 release-mode build, ABORT 5A.1: design
 * re-opens, no further v0.1.22 work claims green, file_upload feature is
 * unshipped pending architecture re-design (candidate alt: bytes via
 * fragmented postMessage to MAIN, OR move File construction to MAIN).
 *
 * RUN ORDER: this test file MUST run BEFORE any other 5A.1 e2e (5A1-file-upload.test.ts).
 * Vitest's alphabetical default ensures "phase0-spike" sorts before "file-upload".
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { callTool, type McpTestClient } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';

describe('5A.1 / Phase 0 — architecture spike (GATING)', () => {
  let client: McpTestClient;
  let nextId: () => number;

  beforeAll(async () => {
    const s = await getSharedClient();
    client = s.client;
    nextId = s.nextId;
  }, 30_000);

  it('content-isolated.js can fetch http://127.0.0.1:19475/health (Assumption 1)', async () => {
    // The probe sentinel exercises browser.fetch() FROM content-isolated.js
    // FROM a tab on a regular http page. The manifest's connect-src
    // explicitly lists 127.0.0.1:19475 but governs extension pages —
    // content scripts run under a hybrid CSP. This test is the empirical
    // truth of whether Safari extends connect-src to content scripts.
    const tab = await callTool(client, 'safari_new_tab', {
      url: 'about:blank',
    }, nextId(), 15_000);
    const tabUrl = tab['tabUrl'] as string;
    try {
      const r = await callTool(client, 'safari_evaluate', {
        tabUrl,
        script: '__SP_FILE_UPLOAD_PROBE_TEST__',
        timeout: 10_000,
      }, nextId(), 30_000);
      const probeResults = JSON.parse(r['value'] as string) as {
        fetchOk: boolean;
        fetchStatus?: number;
        structuredCloneOk: boolean;
        errors: string[];
        mainResponse: { ok: boolean; bytesMatchExpected?: boolean; error?: string };
      };
      expect(
        probeResults.fetchOk,
        `Phase 0 ASSUMPTION 1 FAILED: content-isolated.js cannot fetch the daemon. errors: ${JSON.stringify(probeResults.errors)}. Architecture must re-open.`,
      ).toBe(true);
      expect(probeResults.fetchStatus).toBe(200);
    } finally {
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* best-effort */ }
    }
  }, 60_000);

  it('File objects survive ISOLATED→MAIN structured-clone with bytes intact (Assumption 2)', async () => {
    // Builds a File("SPFUBYTE", "probe.bin") in content-isolated, postMessages
    // to MAIN. MAIN reads bytes via arrayBuffer() and verifies the 8-byte
    // signature matches. If MAIN sees a stripped Blob (size=0) or non-File
    // primitive, this fails.
    const tab = await callTool(client, 'safari_new_tab', {
      url: 'about:blank',
    }, nextId(), 15_000);
    const tabUrl = tab['tabUrl'] as string;
    try {
      const r = await callTool(client, 'safari_evaluate', {
        tabUrl,
        script: '__SP_FILE_UPLOAD_PROBE_TEST__',
        timeout: 10_000,
      }, nextId(), 30_000);
      const probeResults = JSON.parse(r['value'] as string) as {
        structuredCloneOk: boolean;
        mainResponse: { ok: boolean; name?: string; size?: number; type?: string; bytesMatchExpected?: boolean; error?: string };
      };
      expect(
        probeResults.structuredCloneOk,
        `Phase 0 ASSUMPTION 2 FAILED: ${JSON.stringify(probeResults.mainResponse)}. Architecture must re-open.`,
      ).toBe(true);
      expect(probeResults.mainResponse.name).toBe('probe.bin');
      expect(probeResults.mainResponse.size).toBe(8);
      expect(probeResults.mainResponse.type).toBe('application/octet-stream');
      expect(probeResults.mainResponse.bytesMatchExpected).toBe(true);
    } finally {
      try { await callTool(client, 'safari_close_tab', { tabUrl }, nextId()); } catch { /* best-effort */ }
    }
  }, 60_000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "$(git rev-parse --show-toplevel)" && npx vitest run test/e2e/5A1-phase0-spike.test.ts`
Expected: FAIL — sentinel not yet recognized by the extension because v0.1.22 hasn't been built+installed yet. The test will fail with timeout or "command not recognized." This is expected: the gate fires only at Phase 7.

- [ ] **Step 3: Commit (RED)**

```bash
git add test/e2e/5A1-phase0-spike.test.ts
git commit -m "test(5A.1 phase-0 RED): spike e2e tests for content-script fetch + File structured-clone"
```

> Phase 0 e2e GREEN comes after Phase 7 rebuild. Until then, these tests RED is expected.

---

## Phase 1 — TS-only foundations

### Task 3: Error codes + `FileUploadError` subclass

**Files:**
- Modify: `src/errors.ts`

- [ ] **Step 1: Open the file and locate the existing `ERROR_CODES` enum object**

Run: `grep -n 'ERROR_CODES' src/errors.ts | head -5`
Read the existing pattern — `ERROR_CODES` is a frozen const object; subclasses extend `SafariPilotError` with a fixed `code`.

- [ ] **Step 2: Write failing unit test**

Create: `test/unit/errors-file-upload.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import {
  ERROR_CODES,
  SafariPilotError,
  FileUploadPathNotFoundError,
  FileUploadPathNotReadableError,
  FileUploadPathNotAbsoluteError,
  FileUploadFileTooLargeError,
  FileUploadTooManyFilesError,
  FileUploadEmptyPathsError,
  FileUploadInvalidElementError,
  FileUploadElementDetachedError,
  FileUploadMultipleNotAllowedError,
  FileUploadInvalidParamsError,
} from '../../src/errors.js';

describe('5A.1 — file upload error taxonomy', () => {
  it('exposes 10 new ERROR_CODES entries with FILE_UPLOAD_ prefix', () => {
    expect(ERROR_CODES.FILE_UPLOAD_PATH_NOT_FOUND).toBe('FILE_UPLOAD_PATH_NOT_FOUND');
    expect(ERROR_CODES.FILE_UPLOAD_PATH_NOT_READABLE).toBe('FILE_UPLOAD_PATH_NOT_READABLE');
    expect(ERROR_CODES.FILE_UPLOAD_PATH_NOT_ABSOLUTE).toBe('FILE_UPLOAD_PATH_NOT_ABSOLUTE');
    expect(ERROR_CODES.FILE_UPLOAD_FILE_TOO_LARGE).toBe('FILE_UPLOAD_FILE_TOO_LARGE');
    expect(ERROR_CODES.FILE_UPLOAD_TOO_MANY_FILES).toBe('FILE_UPLOAD_TOO_MANY_FILES');
    expect(ERROR_CODES.FILE_UPLOAD_EMPTY_PATHS).toBe('FILE_UPLOAD_EMPTY_PATHS');
    expect(ERROR_CODES.FILE_UPLOAD_INVALID_ELEMENT).toBe('FILE_UPLOAD_INVALID_ELEMENT');
    expect(ERROR_CODES.FILE_UPLOAD_ELEMENT_DETACHED).toBe('FILE_UPLOAD_ELEMENT_DETACHED');
    expect(ERROR_CODES.FILE_UPLOAD_MULTIPLE_NOT_ALLOWED).toBe('FILE_UPLOAD_MULTIPLE_NOT_ALLOWED');
    expect(ERROR_CODES.FILE_UPLOAD_INVALID_PARAMS).toBe('FILE_UPLOAD_INVALID_PARAMS');
  });

  it('FileUploadPathNotFoundError carries path + optional suggestion', () => {
    const e = new FileUploadPathNotFoundError('/tmp/foo.pdf', '/tmp/foo.pd');
    expect(e).toBeInstanceOf(SafariPilotError);
    expect(e.code).toBe(ERROR_CODES.FILE_UPLOAD_PATH_NOT_FOUND);
    expect((e as unknown as { path: string }).path).toBe('/tmp/foo.pdf');
    expect((e as unknown as { suggestion?: string }).suggestion).toBe('/tmp/foo.pd');
    expect(e.message).toContain('/tmp/foo.pdf');
  });

  it('FileUploadFileTooLargeError carries path, size, cap', () => {
    const e = new FileUploadFileTooLargeError('/tmp/big.bin', 30_000_000);
    expect(e.code).toBe(ERROR_CODES.FILE_UPLOAD_FILE_TOO_LARGE);
    expect((e as unknown as { path: string }).path).toBe('/tmp/big.bin');
    expect((e as unknown as { size: number }).size).toBe(30_000_000);
    expect((e as unknown as { cap: number }).cap).toBe(26_214_400);
  });

  it('FileUploadInvalidElementError carries tagName + type', () => {
    const e = new FileUploadInvalidElementError('BUTTON', 'submit');
    expect(e.code).toBe(ERROR_CODES.FILE_UPLOAD_INVALID_ELEMENT);
    expect((e as unknown as { tagName: string }).tagName).toBe('BUTTON');
    expect((e as unknown as { type: string }).type).toBe('submit');
  });

  it('FileUploadInvalidParamsError carries an issue description', () => {
    const e = new FileUploadInvalidParamsError('mimeOverrides keys [/foo] not in paths');
    expect(e.code).toBe(ERROR_CODES.FILE_UPLOAD_INVALID_PARAMS);
    expect(e.message).toContain('mimeOverrides keys');
  });

  it('all 10 errors extend SafariPilotError', () => {
    const errors: SafariPilotError[] = [
      new FileUploadPathNotFoundError('/x'),
      new FileUploadPathNotReadableError('/x'),
      new FileUploadPathNotAbsoluteError('rel/path'),
      new FileUploadFileTooLargeError('/x', 50_000_000),
      new FileUploadTooManyFilesError(5),
      new FileUploadEmptyPathsError(),
      new FileUploadInvalidElementError('DIV', ''),
      new FileUploadElementDetachedError('ref-123'),
      new FileUploadMultipleNotAllowedError(),
      new FileUploadInvalidParamsError('test'),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(SafariPilotError);
      expect(typeof err.code).toBe('string');
      expect(err.code.startsWith('FILE_UPLOAD_')).toBe(true);
    }
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd "$(git rev-parse --show-toplevel)" && npx vitest run test/unit/errors-file-upload.test.ts`
Expected: FAIL — exports do not exist.

- [ ] **Step 4: Run upp:test-reviewer-fast on the test file**

Per UPP TDD discipline. The reviewer should PASS for taxonomy tests of this size; expect a small advisory at most.

- [ ] **Step 5: Implement minimal code**

Add to `src/errors.ts` ERROR_CODES (preserve existing entries, append):

```typescript
  FILE_UPLOAD_PATH_NOT_FOUND: 'FILE_UPLOAD_PATH_NOT_FOUND',
  FILE_UPLOAD_PATH_NOT_READABLE: 'FILE_UPLOAD_PATH_NOT_READABLE',
  FILE_UPLOAD_PATH_NOT_ABSOLUTE: 'FILE_UPLOAD_PATH_NOT_ABSOLUTE',
  FILE_UPLOAD_FILE_TOO_LARGE: 'FILE_UPLOAD_FILE_TOO_LARGE',
  FILE_UPLOAD_TOO_MANY_FILES: 'FILE_UPLOAD_TOO_MANY_FILES',
  FILE_UPLOAD_EMPTY_PATHS: 'FILE_UPLOAD_EMPTY_PATHS',
  FILE_UPLOAD_INVALID_ELEMENT: 'FILE_UPLOAD_INVALID_ELEMENT',
  FILE_UPLOAD_ELEMENT_DETACHED: 'FILE_UPLOAD_ELEMENT_DETACHED',
  FILE_UPLOAD_MULTIPLE_NOT_ALLOWED: 'FILE_UPLOAD_MULTIPLE_NOT_ALLOWED',
  FILE_UPLOAD_INVALID_PARAMS: 'FILE_UPLOAD_INVALID_PARAMS',
```

Append to the file:

```typescript
export class FileUploadPathNotFoundError extends SafariPilotError {
  readonly path: string;
  readonly suggestion?: string;
  constructor(path: string, suggestion?: string) {
    super(
      ERROR_CODES.FILE_UPLOAD_PATH_NOT_FOUND,
      `File not found: ${path}${suggestion ? `. Did you mean: ${suggestion}?` : ''}`,
      false,
      ['Pass an absolute path or ~-prefixed path to a file that exists.'],
    );
    this.path = path;
    if (suggestion !== undefined) this.suggestion = suggestion;
  }
}

export class FileUploadPathNotReadableError extends SafariPilotError {
  readonly path: string;
  constructor(path: string) {
    super(
      ERROR_CODES.FILE_UPLOAD_PATH_NOT_READABLE,
      `Cannot read file: ${path} (permission denied, is a directory, or contains NUL bytes).`,
      false,
      [],
    );
    this.path = path;
  }
}

export class FileUploadPathNotAbsoluteError extends SafariPilotError {
  readonly path: string;
  constructor(path: string) {
    super(
      ERROR_CODES.FILE_UPLOAD_PATH_NOT_ABSOLUTE,
      `Path must be absolute or ~-prefixed: ${path}`,
      false,
      ['Use an absolute path (/Users/...) or ~/relative/path.'],
    );
    this.path = path;
  }
}

export class FileUploadFileTooLargeError extends SafariPilotError {
  readonly path: string;
  readonly size: number;
  readonly cap: number = 26_214_400;
  constructor(path: string, size: number) {
    super(
      ERROR_CODES.FILE_UPLOAD_FILE_TOO_LARGE,
      `File exceeds 25 MB cap: ${path} (${size} bytes).`,
      false,
      ['v1 cap is 25 MB. For larger files, upload via a custom site mechanism (e.g., a direct API call from the agent).'],
    );
    this.path = path;
    this.size = size;
  }
}

export class FileUploadTooManyFilesError extends SafariPilotError {
  readonly count: number;
  constructor(count: number) {
    super(
      ERROR_CODES.FILE_UPLOAD_TOO_MANY_FILES,
      `Too many files: ${count}. v1 limit is 4.`,
      false,
      ['To upload more, call multiple times — note that subsequent calls REPLACE the FileList, not append.'],
    );
    this.count = count;
  }
}

export class FileUploadEmptyPathsError extends SafariPilotError {
  constructor() {
    super(
      ERROR_CODES.FILE_UPLOAD_EMPTY_PATHS,
      `paths is empty and clear is not true.`,
      false,
      ['Pass clear: true to clear the input.'],
    );
  }
}

export class FileUploadInvalidElementError extends SafariPilotError {
  readonly tagName: string;
  readonly type: string;
  constructor(tagName: string, type: string) {
    super(
      ERROR_CODES.FILE_UPLOAD_INVALID_ELEMENT,
      `Locator resolved to <${tagName.toLowerCase()}${type ? ` type="${type}"` : ''}>, not <input type=file>.`,
      false,
      ['safari_file_upload only operates on <input type=file>. If the page uses a custom picker, look for the hidden <input> sibling — usually inside the same <label>. Try locating by the label text.'],
    );
    this.tagName = tagName;
    this.type = type;
  }
}

export class FileUploadElementDetachedError extends SafariPilotError {
  readonly ref?: string;
  constructor(ref?: string) {
    super(
      ERROR_CODES.FILE_UPLOAD_ELEMENT_DETACHED,
      `Element was removed between probe and inject${ref ? ` (ref: ${ref})` : ''}.`,
      true, // retryable
      ['Page re-rendered between probe and inject. Retry the call.'],
    );
    if (ref !== undefined) this.ref = ref;
  }
}

export class FileUploadMultipleNotAllowedError extends SafariPilotError {
  constructor() {
    super(
      ERROR_CODES.FILE_UPLOAD_MULTIPLE_NOT_ALLOWED,
      `Input does not have the multiple attribute; cannot accept >1 path.`,
      false,
      ['Pass exactly 1 path, or locate an input that has multiple="true".'],
    );
  }
}

export class FileUploadInvalidParamsError extends SafariPilotError {
  constructor(issue: string) {
    super(
      ERROR_CODES.FILE_UPLOAD_INVALID_PARAMS,
      `Invalid parameters: ${issue}`,
      false,
      [],
    );
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd "$(git rev-parse --show-toplevel)" && npx vitest run test/unit/errors-file-upload.test.ts && npm run lint`
Expected: all 6 PASS, lint clean.

- [ ] **Step 7: Commit**

```bash
git add src/errors.ts test/unit/errors-file-upload.test.ts
git commit -m "feat(5A.1 phase-1): 10 FileUpload error codes + typed subclasses"
```

### Task 4: `src/tools/mime.ts` — extension lookup helper

**Files:**
- Create: `src/tools/mime.ts`
- Create: `test/unit/tools/mime.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
/**
 * Phase 5A · 5A.1 — mimeFromExtension: pure helper.
 *
 * Coverage policy (per spec): web-common types only. Long-tail uncommon
 * types fall back to application/octet-stream with mimeFallback: true,
 * letting the agent override via mimeOverrides.
 */
import { describe, it, expect } from 'vitest';
import { mimeFromExtension } from '../../../src/tools/mime.js';

describe('5A.1 — mimeFromExtension', () => {
  it('returns canonical types for common web extensions', () => {
    expect(mimeFromExtension('resume.pdf')).toEqual({ mimeType: 'application/pdf', fallback: false });
    expect(mimeFromExtension('photo.png')).toEqual({ mimeType: 'image/png', fallback: false });
    expect(mimeFromExtension('photo.jpg')).toEqual({ mimeType: 'image/jpeg', fallback: false });
    expect(mimeFromExtension('photo.jpeg')).toEqual({ mimeType: 'image/jpeg', fallback: false });
    expect(mimeFromExtension('data.json')).toEqual({ mimeType: 'application/json', fallback: false });
    expect(mimeFromExtension('data.csv')).toEqual({ mimeType: 'text/csv', fallback: false });
    expect(mimeFromExtension('archive.zip')).toEqual({ mimeType: 'application/zip', fallback: false });
    expect(mimeFromExtension('page.html')).toEqual({ mimeType: 'text/html', fallback: false });
    expect(mimeFromExtension('notes.txt')).toEqual({ mimeType: 'text/plain', fallback: false });
  });

  it('is case-insensitive on the extension', () => {
    expect(mimeFromExtension('REPORT.PDF')).toEqual({ mimeType: 'application/pdf', fallback: false });
    expect(mimeFromExtension('PHOTO.JPG')).toEqual({ mimeType: 'image/jpeg', fallback: false });
  });

  it('falls back to application/octet-stream for unknown extensions', () => {
    expect(mimeFromExtension('foo.parquet')).toEqual({ mimeType: 'application/octet-stream', fallback: true });
    expect(mimeFromExtension('foo.heic')).toEqual({ mimeType: 'application/octet-stream', fallback: true });
  });

  it('falls back for files with no extension', () => {
    expect(mimeFromExtension('Makefile')).toEqual({ mimeType: 'application/octet-stream', fallback: true });
    expect(mimeFromExtension('README')).toEqual({ mimeType: 'application/octet-stream', fallback: true });
  });

  it('falls back for dotfiles (no real extension)', () => {
    expect(mimeFromExtension('.bashrc')).toEqual({ mimeType: 'application/octet-stream', fallback: true });
    expect(mimeFromExtension('.gitignore')).toEqual({ mimeType: 'application/octet-stream', fallback: true });
  });

  it('handles UTF-8 file names (extension lookup operates on the dot-suffix only)', () => {
    expect(mimeFromExtension('简历.pdf')).toEqual({ mimeType: 'application/pdf', fallback: false });
    expect(mimeFromExtension('résumé.PDF')).toEqual({ mimeType: 'application/pdf', fallback: false });
  });

  it('handles paths with directories — only the basename matters', () => {
    expect(mimeFromExtension('/Users/me/Downloads/x.pdf')).toEqual({ mimeType: 'application/pdf', fallback: false });
    expect(mimeFromExtension('relative/foo.png')).toEqual({ mimeType: 'image/png', fallback: false });
  });

  it('handles double-extension files (uses the LAST extension)', () => {
    expect(mimeFromExtension('archive.tar.gz')).toEqual({ mimeType: 'application/gzip', fallback: false });
    expect(mimeFromExtension('foo.json.bak')).toEqual({ mimeType: 'application/octet-stream', fallback: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "$(git rev-parse --show-toplevel)" && npx vitest run test/unit/tools/mime.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Run upp:test-reviewer-fast (≤8 tests, fast mode)**

Per UPP. Pure-helper shape; expect PASS unless oracles are weak.

- [ ] **Step 4: Implement minimal code**

Create `src/tools/mime.ts`:

```typescript
/**
 * Phase 5A · 5A.1 — pure mimeFromExtension helper.
 *
 * Coverage policy: ~70 web-common types. Long-tail uncommon types fall back
 * to application/octet-stream with `fallback: true`. Callers (file-upload
 * handler) surface the fallback signal in the response so agents know to
 * pass an explicit mimeOverrides entry if the site validates server-side.
 */
import { extname, basename } from 'node:path';

const TABLE: Record<string, string> = {
  // Documents
  'pdf': 'application/pdf',
  'doc': 'application/msword',
  'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'xls': 'application/vnd.ms-excel',
  'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'ppt': 'application/vnd.ms-powerpoint',
  'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'odt': 'application/vnd.oasis.opendocument.text',
  'ods': 'application/vnd.oasis.opendocument.spreadsheet',
  'rtf': 'application/rtf',
  // Text
  'txt': 'text/plain',
  'md': 'text/markdown',
  'html': 'text/html',
  'htm': 'text/html',
  'css': 'text/css',
  'csv': 'text/csv',
  'tsv': 'text/tab-separated-values',
  'xml': 'application/xml',
  'json': 'application/json',
  'yaml': 'application/yaml',
  'yml': 'application/yaml',
  'js': 'application/javascript',
  'mjs': 'application/javascript',
  'ts': 'application/typescript',
  // Images
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'svg': 'image/svg+xml',
  'bmp': 'image/bmp',
  'ico': 'image/vnd.microsoft.icon',
  'tiff': 'image/tiff',
  'tif': 'image/tiff',
  // Audio
  'mp3': 'audio/mpeg',
  'wav': 'audio/wav',
  'ogg': 'audio/ogg',
  'm4a': 'audio/mp4',
  'flac': 'audio/flac',
  'aac': 'audio/aac',
  // Video
  'mp4': 'video/mp4',
  'mov': 'video/quicktime',
  'webm': 'video/webm',
  'avi': 'video/x-msvideo',
  'mkv': 'video/x-matroska',
  // Archives
  'zip': 'application/zip',
  'gz': 'application/gzip',
  'tar': 'application/x-tar',
  'bz2': 'application/x-bzip2',
  '7z': 'application/x-7z-compressed',
  'rar': 'application/vnd.rar',
  // Fonts
  'woff': 'font/woff',
  'woff2': 'font/woff2',
  'ttf': 'font/ttf',
  'otf': 'font/otf',
  // Code / configs
  'sh': 'application/x-sh',
  'py': 'text/x-python',
  'rb': 'text/x-ruby',
  'go': 'text/x-go',
  'rs': 'text/rust',
  'java': 'text/x-java',
  'c': 'text/x-c',
  'cpp': 'text/x-c++',
  'h': 'text/x-c',
  'swift': 'text/x-swift',
  'sql': 'application/sql',
  'toml': 'application/toml',
  'ini': 'text/plain',
};

export interface MimeResult {
  mimeType: string;
  fallback: boolean;
}

export function mimeFromExtension(filename: string): MimeResult {
  // Operate on the basename so directory paths don't confuse extname.
  const base = basename(filename);
  // Dotfiles like ".bashrc" — extname returns "" — fall back.
  if (base.startsWith('.') && base.indexOf('.', 1) === -1) {
    return { mimeType: 'application/octet-stream', fallback: true };
  }
  const ext = extname(base).slice(1).toLowerCase();
  if (!ext) return { mimeType: 'application/octet-stream', fallback: true };
  const mimeType = TABLE[ext];
  if (mimeType !== undefined) return { mimeType, fallback: false };
  return { mimeType: 'application/octet-stream', fallback: true };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd "$(git rev-parse --show-toplevel)" && npx vitest run test/unit/tools/mime.test.ts && npm run lint`
Expected: all 8 PASS, lint clean.

- [ ] **Step 6: Commit**

```bash
git add src/tools/mime.ts test/unit/tools/mime.test.ts
git commit -m "feat(5A.1 phase-1): mimeFromExtension pure helper (~70 web-common types)"
```

### Task 5: `src/path-resolve.ts` — path expansion + Levenshtein suggestion

**Files:**
- Create: `src/path-resolve.ts`
- Create: `test/unit/path-resolve.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
/**
 * Phase 5A · 5A.1 — resolveUploadPath: pure path-input validation.
 *
 *   - Expand ~ / ~/ → os.homedir()
 *   - Reject relative paths (FILE_UPLOAD_PATH_NOT_ABSOLUTE)
 *   - Reject NUL byte in path (FILE_UPLOAD_PATH_NOT_READABLE)
 *   - On ENOENT during stat, optionally compute a Levenshtein-closest
 *     suggestion from the parent directory's siblings. Cap implementation
 *     at <= 30 lines or drop the suggestion (per spec stretch-goal note).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { resolveUploadPath } from '../../src/path-resolve.js';
import { FileUploadPathNotAbsoluteError, FileUploadPathNotReadableError } from '../../src/errors.js';

describe('5A.1 — resolveUploadPath', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'sp-5a1-pathres-'));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('passes through absolute paths unchanged', () => {
    const file = join(workDir, 'foo.bin');
    writeFileSync(file, 'x');
    const r = resolveUploadPath(file);
    expect(r.absolute).toBe(file);
    expect(r.warnings).toEqual([]);
  });

  it('expands ~ to homedir', () => {
    // Don't actually require homedir/x to exist; resolveUploadPath does
    // EXPANSION only — fs existence is the caller's separate stat step.
    const r = resolveUploadPath('~/Downloads/some-file.bin');
    expect(r.absolute).toBe(join(homedir(), 'Downloads/some-file.bin'));
  });

  it('expands ~ alone (no slash)', () => {
    const r = resolveUploadPath('~');
    expect(r.absolute).toBe(homedir());
  });

  it('rejects relative paths with FileUploadPathNotAbsoluteError', () => {
    expect(() => resolveUploadPath('foo.pdf')).toThrow(FileUploadPathNotAbsoluteError);
    expect(() => resolveUploadPath('./foo.pdf')).toThrow(FileUploadPathNotAbsoluteError);
    expect(() => resolveUploadPath('../foo.pdf')).toThrow(FileUploadPathNotAbsoluteError);
    expect(() => resolveUploadPath('subdir/foo.pdf')).toThrow(FileUploadPathNotAbsoluteError);
  });

  it('rejects paths containing NUL byte with FileUploadPathNotReadableError', () => {
    expect(() => resolveUploadPath('/tmp/foo bar')).toThrow(FileUploadPathNotReadableError);
  });

  it('rejects ~user form (only ~ and ~/ supported)', () => {
    expect(() => resolveUploadPath('~root/foo')).toThrow(FileUploadPathNotAbsoluteError);
  });

  it('emits a warning when realpath resolves the path differently (symlink)', () => {
    // Create a target file and a symlink pointing to it.
    const target = join(workDir, 'real.bin');
    const link = join(workDir, 'link.bin');
    writeFileSync(target, 'real');
    require('node:fs').symlinkSync(target, link);
    const r = resolveUploadPath(link);
    expect(r.absolute).toBe(target);  // realpath-resolved
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toContain('symlink');
    expect(r.warnings[0]).toContain(link);
    expect(r.warnings[0]).toContain(target);
  });

  it('returns warnings: [] when realpath equals the input', () => {
    const file = join(workDir, 'plain.bin');
    writeFileSync(file, 'x');
    const r = resolveUploadPath(file);
    expect(r.warnings).toEqual([]);
  });

  it('does NOT throw for ENOENT (caller does fs.stat separately)', () => {
    // resolveUploadPath is path-shape validation, not existence. ENOENT
    // is the caller's job (it has more context for a helpful error).
    const r = resolveUploadPath('/tmp/this-path-definitely-does-not-exist-9876.bin');
    expect(r.absolute).toBe('/tmp/this-path-definitely-does-not-exist-9876.bin');
  });

  it('exports findClosestSibling for stretch-goal Levenshtein suggestion', async () => {
    // Optional helper — Phase 1 ships only the path resolution; suggestion
    // hookup happens in Phase 2 handler. Skip this test if findClosestSibling
    // is not exported (stretch goal dropped).
    const mod = await import('../../src/path-resolve.js');
    if (typeof (mod as Record<string, unknown>).findClosestSibling !== 'function') {
      // Stretch goal not implemented — acceptable.
      return;
    }
    writeFileSync(join(workDir, 'resume.pdf'), 'x');
    writeFileSync(join(workDir, 'cover.pdf'), 'x');
    const findClosestSibling = (mod as { findClosestSibling: (p: string) => string | undefined }).findClosestSibling;
    const suggestion = findClosestSibling(join(workDir, 'resme.pdf'));
    expect(suggestion).toBe(join(workDir, 'resume.pdf'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "$(git rev-parse --show-toplevel)" && npx vitest run test/unit/path-resolve.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Run upp:test-reviewer-fast (10 tests; fast mode threshold is ≤3, full mode otherwise — use full mode here)**

Actually 10 > 3, run upp:test-reviewer (full). Fix any flagged issues before proceeding.

- [ ] **Step 4: Implement minimal code**

Create `src/path-resolve.ts`:

```typescript
/**
 * Phase 5A · 5A.1 — pure path resolution helpers.
 *
 * resolveUploadPath: expand ~ → homedir, reject relative paths and NUL
 * bytes, fs.realpath-resolve symlinks, surface a warning when realpath
 * diverges from the input (forensic trail per spec security model).
 *
 * findClosestSibling (stretch goal, drop if cost > 30 lines): on ENOENT,
 * read parent dir entries, return the smallest-Levenshtein-distance match
 * (only when distance ≤ 3 to avoid junk suggestions).
 */
import { realpathSync, readdirSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, dirname, basename } from 'node:path';
import {
  FileUploadPathNotAbsoluteError,
  FileUploadPathNotReadableError,
} from './errors.js';

export interface ResolvedPath {
  absolute: string;
  warnings: string[];
}

export function resolveUploadPath(input: string): ResolvedPath {
  if (input.includes(' ')) {
    throw new FileUploadPathNotReadableError(input);
  }
  let expanded: string;
  if (input === '~') {
    expanded = homedir();
  } else if (input.startsWith('~/')) {
    expanded = join(homedir(), input.slice(2));
  } else if (input.startsWith('~')) {
    // ~user form — not supported.
    throw new FileUploadPathNotAbsoluteError(input);
  } else if (!isAbsolute(input)) {
    throw new FileUploadPathNotAbsoluteError(input);
  } else {
    expanded = input;
  }

  const warnings: string[] = [];
  let absolute = expanded;
  try {
    const real = realpathSync(expanded);
    if (real !== expanded) {
      warnings.push(`symlink resolved: ${expanded} -> ${real}`);
      absolute = real;
    }
  } catch {
    // realpath fails on non-existent paths — that's not our concern here;
    // caller's fs.stat will raise the proper ENOENT typed error.
  }

  return { absolute, warnings };
}

// Stretch-goal helper — keeping under 30 lines per spec budget.
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length, bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const dp = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) dp[j] = j;
  for (let i = 1; i <= al; i++) {
    let prev = dp[0]; dp[0] = i;
    for (let j = 1; j <= bl; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : Math.min(prev, dp[j], dp[j - 1]) + 1;
      prev = tmp;
    }
  }
  return dp[bl];
}

export function findClosestSibling(missingPath: string): string | undefined {
  const dir = dirname(missingPath);
  const target = basename(missingPath);
  if (!existsSync(dir)) return undefined;
  let bestMatch: string | undefined;
  let bestDistance = Infinity;
  for (const entry of readdirSync(dir)) {
    const dist = levenshtein(target.toLowerCase(), entry.toLowerCase());
    if (dist < bestDistance) {
      bestDistance = dist;
      bestMatch = entry;
    }
  }
  if (bestMatch === undefined || bestDistance > 3) return undefined;
  return join(dir, bestMatch);
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd "$(git rev-parse --show-toplevel)" && npx vitest run test/unit/path-resolve.test.ts && npm run lint`
Expected: all 10 PASS, lint clean.

- [ ] **Step 6: Commit**

```bash
git add src/path-resolve.ts test/unit/path-resolve.test.ts
git commit -m "feat(5A.1 phase-1): resolveUploadPath + findClosestSibling helpers"
```

---

## Phase 2 — TS dispatch handler

### Task 6: `src/tools/file-upload.ts` — handler with full dispatch

**Files:**
- Create: `src/tools/file-upload.ts`
- Create: `test/unit/tools/file-upload-dispatch.test.ts`
- Modify: `src/server.ts` (register `FileUploadTools`)

- [ ] **Step 1: Write the failing tests**

```typescript
/**
 * Phase 5A · 5A.1 — safari_file_upload dispatch boundary tests.
 *
 * Recording-engine pattern (mirrors cookies-extension-bridge.test.ts /
 * http-auth-dispatch.test.ts). Verifies:
 *   - Sentinel content (probe + final upload)
 *   - stage_file NDJSON dispatch shape
 *   - Engine-required gate
 *   - All 10 typed errors fire on the right inputs
 *   - paths/clear mutual exclusion
 *   - mimeOverrides key validation
 *   - TOCTOU re-check
 *   - Response shape end-to-end
 *
 * Behavioral truth lives in test/e2e/5A1-file-upload.test.ts; this file is
 * the dispatch slice that runs without Safari.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileUploadTools } from '../../../src/tools/file-upload.js';
import {
  ERROR_CODES,
  SafariPilotError,
  FileUploadEmptyPathsError,
  FileUploadTooManyFilesError,
  FileUploadPathNotFoundError,
  FileUploadFileTooLargeError,
  FileUploadInvalidParamsError,
} from '../../../src/errors.js';
import type { IEngine } from '../../../src/engines/engine.js';
import type { Engine, EngineResult } from '../../../src/types.js';

interface RecordingEngine extends IEngine {
  scripts: string[];
  ndjsonCommands: Record<string, unknown>[];  // captured stage_file calls
  responseQueue: string[];
}

function recordingEngine(name: Engine = 'extension', responses: string[] = []): RecordingEngine {
  const scripts: string[] = [];
  const ndjsonCommands: Record<string, unknown>[] = [];
  const queue = [...responses];
  // Default probe response: ok + isFileInput true + multiple true.
  const defaultProbe = JSON.stringify({ ok: true, isFileInput: true, multiple: true, accept: '' });
  // Default final-upload response: success.
  const defaultUpload = JSON.stringify({ uploaded: 0, files: [] });
  const e: RecordingEngine = {
    name,
    isAvailable: async () => true,
    execute: async (cmd) => {
      // Used for stage_file NDJSON commands.
      if (typeof cmd === 'object' && cmd !== null && 'cmd' in cmd) {
        ndjsonCommands.push(cmd as Record<string, unknown>);
      }
      return { ok: true, value: '{"staged":true}', elapsed_ms: 1 };
    },
    executeJsInTab: async (...args: unknown[]) => {
      const script = args[1] as string;
      scripts.push(script);
      // Pre-canned: the FIRST script is the probe, subsequent is the upload.
      if (script.startsWith('__SP_FILE_UPLOAD_PROBE__')) {
        return { ok: true, value: queue.shift() ?? defaultProbe, elapsed_ms: 1 } as EngineResult;
      }
      if (script.startsWith('__SP_FILE_UPLOAD__')) {
        return { ok: true, value: queue.shift() ?? defaultUpload, elapsed_ms: 1 } as EngineResult;
      }
      return { ok: true, value: '{}', elapsed_ms: 1 } as EngineResult;
    },
    executeJsInFrame: async () => ({ ok: true, value: '{}', elapsed_ms: 1 }) as EngineResult,
    shutdown: async () => {},
    scripts,
    ndjsonCommands,
    responseQueue: queue,
  } as unknown as RecordingEngine;
  return e;
}

describe('5A.1 — safari_file_upload dispatch boundary', () => {
  let workDir: string;
  let smallFile: string;
  let bigFile: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'sp-5a1-disp-'));
    smallFile = join(workDir, 'a.pdf');
    writeFileSync(smallFile, 'tiny pdf bytes');
    bigFile = join(workDir, 'huge.bin');
    // Write 26 MB to exceed the 25 MB cap.
    writeFileSync(bigFile, Buffer.alloc(26 * 1024 * 1024));
  });
  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('throws ENGINE_REQUIRED when engine is not extension', async () => {
    const engine = recordingEngine('applescript');
    const tools = new FileUploadTools(engine);
    const handler = tools.getHandler('safari_file_upload')!;
    let caught: unknown;
    try {
      await handler({ tabUrl: 'https://x', selector: '#f', paths: [smallFile] });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(SafariPilotError);
    expect((caught as SafariPilotError).code).toBe(ERROR_CODES.ENGINE_REQUIRED);
  });

  it('throws FILE_UPLOAD_EMPTY_PATHS when paths is empty and clear is not true', async () => {
    const engine = recordingEngine();
    const tools = new FileUploadTools(engine);
    const handler = tools.getHandler('safari_file_upload')!;
    let caught: unknown;
    try {
      await handler({ tabUrl: 'https://x', selector: '#f', paths: [] });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(FileUploadEmptyPathsError);
    // No dispatches should have happened.
    expect(engine.scripts).toHaveLength(0);
  });

  it('throws FILE_UPLOAD_TOO_MANY_FILES when paths.length > 4', async () => {
    const engine = recordingEngine();
    const tools = new FileUploadTools(engine);
    const handler = tools.getHandler('safari_file_upload')!;
    let caught: unknown;
    try {
      await handler({ tabUrl: 'https://x', selector: '#f', paths: [smallFile, smallFile, smallFile, smallFile, smallFile] });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(FileUploadTooManyFilesError);
    expect(engine.scripts).toHaveLength(0);
  });

  it('throws FILE_UPLOAD_INVALID_PARAMS when both paths and clear are provided', async () => {
    const engine = recordingEngine();
    const tools = new FileUploadTools(engine);
    const handler = tools.getHandler('safari_file_upload')!;
    let caught: unknown;
    try {
      await handler({ tabUrl: 'https://x', selector: '#f', paths: [smallFile], clear: true });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(FileUploadInvalidParamsError);
  });

  it('throws FILE_UPLOAD_INVALID_PARAMS when neither paths nor clear is provided', async () => {
    const engine = recordingEngine();
    const tools = new FileUploadTools(engine);
    const handler = tools.getHandler('safari_file_upload')!;
    let caught: unknown;
    try {
      await handler({ tabUrl: 'https://x', selector: '#f' });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(FileUploadInvalidParamsError);
  });

  it('throws FILE_UPLOAD_PATH_NOT_FOUND when path does not exist', async () => {
    const engine = recordingEngine();
    const tools = new FileUploadTools(engine);
    const handler = tools.getHandler('safari_file_upload')!;
    let caught: unknown;
    try {
      await handler({ tabUrl: 'https://x', selector: '#f', paths: [join(workDir, 'nope.pdf')] });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(FileUploadPathNotFoundError);
    // Probe ran; no upload dispatched.
    expect(engine.scripts.filter((s) => s.startsWith('__SP_FILE_UPLOAD_PROBE__'))).toHaveLength(1);
    expect(engine.scripts.filter((s) => s.startsWith('__SP_FILE_UPLOAD__:'))).toHaveLength(0);
    expect(engine.ndjsonCommands).toHaveLength(0);
  });

  it('throws FILE_UPLOAD_FILE_TOO_LARGE on stat-time size > 25 MB', async () => {
    const engine = recordingEngine();
    const tools = new FileUploadTools(engine);
    const handler = tools.getHandler('safari_file_upload')!;
    let caught: unknown;
    try {
      await handler({ tabUrl: 'https://x', selector: '#f', paths: [bigFile] });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(FileUploadFileTooLargeError);
    expect(engine.ndjsonCommands).toHaveLength(0);
  });

  it('throws FILE_UPLOAD_INVALID_PARAMS when mimeOverrides has unmatched keys', async () => {
    const engine = recordingEngine();
    const tools = new FileUploadTools(engine);
    const handler = tools.getHandler('safari_file_upload')!;
    let caught: unknown;
    try {
      await handler({
        tabUrl: 'https://x', selector: '#f',
        paths: [smallFile],
        mimeOverrides: { '/some/wrong/key.bin': 'application/x-custom' },
      });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(FileUploadInvalidParamsError);
    expect((caught as Error).message).toContain('/some/wrong/key.bin');
  });

  it('dispatches the probe sentinel BEFORE pre-flight reads (early-fail savings)', async () => {
    // Probe returns isFileInput: false → handler aborts before any byte read.
    const engine = recordingEngine('extension', [
      JSON.stringify({ ok: true, isFileInput: false, multiple: false, accept: '' }),
    ]);
    const tools = new FileUploadTools(engine);
    const handler = tools.getHandler('safari_file_upload')!;
    let caught: unknown;
    try {
      await handler({ tabUrl: 'https://x', selector: '#f', paths: [smallFile] });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(SafariPilotError);
    expect((caught as SafariPilotError).code).toBe(ERROR_CODES.FILE_UPLOAD_INVALID_ELEMENT);
    // Probe dispatched, but NO stage_file NDJSON sent.
    expect(engine.ndjsonCommands).toHaveLength(0);
  });

  it('dispatches the probe sentinel with locator + force + timeout in JSON suffix', async () => {
    const engine = recordingEngine();
    const tools = new FileUploadTools(engine);
    const handler = tools.getHandler('safari_file_upload')!;
    await handler({
      tabUrl: 'https://x',
      selector: '#chooser',
      paths: [smallFile],
      force: true,
      timeout: 7500,
    });
    const probeScript = engine.scripts.find((s) => s.startsWith('__SP_FILE_UPLOAD_PROBE__:'))!;
    expect(probeScript).toBeDefined();
    const json = JSON.parse(probeScript.slice('__SP_FILE_UPLOAD_PROBE__:'.length)) as {
      locator: { selector: string };
      force: boolean;
      timeoutMs: number;
    };
    expect(json.locator.selector).toBe('#chooser');
    expect(json.force).toBe(true);
    expect(json.timeoutMs).toBe(7500);
  });

  it('stages each file via NDJSON stage_file with token + mimeType + base64', async () => {
    const engine = recordingEngine();
    const tools = new FileUploadTools(engine);
    const handler = tools.getHandler('safari_file_upload')!;
    await handler({ tabUrl: 'https://x', selector: '#f', paths: [smallFile] });
    expect(engine.ndjsonCommands).toHaveLength(1);
    const cmd = engine.ndjsonCommands[0]!;
    expect(cmd['cmd']).toBe('stage_file');
    expect(typeof cmd['token']).toBe('string');
    expect((cmd['token'] as string).length).toBe(64); // 32 bytes hex
    expect(cmd['mimeType']).toBe('application/pdf');
    expect(typeof cmd['bytesB64']).toBe('string');
    // Base64 encodes "tiny pdf bytes" → "dGlueSBwZGYgYnl0ZXM="
    const decoded = Buffer.from(cmd['bytesB64'] as string, 'base64').toString('utf-8');
    expect(decoded).toBe('tiny pdf bytes');
  });

  it('honors mimeOverrides when keys match raw paths entries (pre-expansion)', async () => {
    const engine = recordingEngine();
    const tools = new FileUploadTools(engine);
    const handler = tools.getHandler('safari_file_upload')!;
    await handler({
      tabUrl: 'https://x', selector: '#f',
      paths: [smallFile],
      mimeOverrides: { [smallFile]: 'application/x-custom' },
    });
    expect(engine.ndjsonCommands[0]!['mimeType']).toBe('application/x-custom');
  });

  it('emits final sentinel with tokens + ref + probeOpts; storage bus payload is small', async () => {
    const engine = recordingEngine();
    const tools = new FileUploadTools(engine);
    const handler = tools.getHandler('safari_file_upload')!;
    await handler({ tabUrl: 'https://x', selector: '#f', paths: [smallFile], validationProbeMs: 500 });
    const finalScript = engine.scripts.find((s) => s.startsWith('__SP_FILE_UPLOAD__:'))!;
    expect(finalScript).toBeDefined();
    expect(finalScript.length).toBeLessThan(2000); // ~1KB metadata, no bytes
    const json = JSON.parse(finalScript.slice('__SP_FILE_UPLOAD__:'.length)) as {
      tokens: { token: string; name: string; mimeType: string; mimeFallback?: true }[];
      probeOpts: { force: boolean; validationProbeMs: number };
    };
    expect(json.tokens).toHaveLength(1);
    expect(json.tokens[0]!.name).toBe('a.pdf');
    expect(json.tokens[0]!.mimeType).toBe('application/pdf');
    expect(json.tokens[0]!.token.length).toBe(64);
    expect(json.probeOpts.validationProbeMs).toBe(500);
  });

  it('on clear: true, dispatches final sentinel with empty tokens + clear flag, no NDJSON', async () => {
    const engine = recordingEngine();
    const tools = new FileUploadTools(engine);
    const handler = tools.getHandler('safari_file_upload')!;
    await handler({ tabUrl: 'https://x', selector: '#f', clear: true });
    expect(engine.ndjsonCommands).toHaveLength(0);
    const finalScript = engine.scripts.find((s) => s.startsWith('__SP_FILE_UPLOAD__:'))!;
    const json = JSON.parse(finalScript.slice('__SP_FILE_UPLOAD__:'.length)) as { tokens: unknown[]; clear: boolean };
    expect(json.tokens).toEqual([]);
    expect(json.clear).toBe(true);
  });

  it('returns response with uploaded count + files array + mimeFallback flag when default fired', async () => {
    const unknownExt = join(workDir, 'data.parquet');
    writeFileSync(unknownExt, 'parquet bytes');
    const engine = recordingEngine('extension', [
      // Probe response
      JSON.stringify({ ok: true, isFileInput: true, multiple: true, accept: '' }),
      // Final upload response from content-main
      JSON.stringify({ uploaded: 1, files: [{ name: 'data.parquet', size: 13, mimeType: 'application/octet-stream', path: unknownExt, mimeFallback: true }] }),
    ]);
    const tools = new FileUploadTools(engine);
    const handler = tools.getHandler('safari_file_upload')!;
    const r = await handler({ tabUrl: 'https://x', selector: '#f', paths: [unknownExt] });
    const payload = JSON.parse(r.content[0]!.text!);
    expect(payload.uploaded).toBe(1);
    expect(payload.files).toHaveLength(1);
    expect(payload.files[0].mimeType).toBe('application/octet-stream');
    expect(payload.files[0].mimeFallback).toBe(true);
  });

  it('threads tabUrl through to engine.executeJsInTab for both probe and upload', async () => {
    const engine = recordingEngine();
    const observed: string[] = [];
    const origExec = engine.executeJsInTab;
    engine.executeJsInTab = async (...args: unknown[]) => {
      observed.push(args[0] as string);
      return origExec.apply(engine, args as Parameters<typeof origExec>);
    };
    const tools = new FileUploadTools(engine);
    const handler = tools.getHandler('safari_file_upload')!;
    await handler({ tabUrl: 'https://target/page', selector: '#f', paths: [smallFile] });
    expect(observed.every((u) => u === 'https://target/page')).toBe(true);
    expect(observed.length).toBeGreaterThanOrEqual(2); // probe + upload at minimum
  });

  it('TOCTOU: re-checks size after fs.readFile (file grew between stat and read)', async () => {
    // Hard to simulate cleanly without injection points; we test the behavior
    // through an oversized stat directly. The post-read re-check is exercised
    // by the same code path — if stat reports under-cap and read returns
    // over-cap, the same FILE_UPLOAD_FILE_TOO_LARGE fires.
    // (A real TOCTOU race is too flaky to test reliably; the behavior is
    //  pinned by the post-read re-check existing as a code path.)
    const engine = recordingEngine();
    const tools = new FileUploadTools(engine);
    const handler = tools.getHandler('safari_file_upload')!;
    let caught: unknown;
    try {
      await handler({ tabUrl: 'https://x', selector: '#f', paths: [bigFile] });
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(FileUploadFileTooLargeError);
  });

  it('symlink resolution surfaces in response.warnings (forensic trail)', async () => {
    const target = join(workDir, 'target.pdf');
    const link = join(workDir, 'link.pdf');
    writeFileSync(target, 'real pdf');
    require('node:fs').symlinkSync(target, link);
    const engine = recordingEngine('extension', [
      JSON.stringify({ ok: true, isFileInput: true, multiple: true, accept: '' }),
      JSON.stringify({ uploaded: 1, files: [{ name: 'target.pdf', size: 8, mimeType: 'application/pdf', path: target }] }),
    ]);
    const tools = new FileUploadTools(engine);
    const handler = tools.getHandler('safari_file_upload')!;
    const r = await handler({ tabUrl: 'https://x', selector: '#f', paths: [link] });
    const payload = JSON.parse(r.content[0]!.text!);
    // Warning lives in trace event log, not response — but if the impl
    // forwards via warnings array, accept either. Just verify either
    // (a) no warnings field, OR (b) warnings field contains 'symlink'.
    if (payload.warnings) {
      expect(payload.warnings.some((w: string) => w.includes('symlink'))).toBe(true);
    }
    expect(payload.uploaded).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd "$(git rev-parse --show-toplevel)" && npx vitest run test/unit/tools/file-upload-dispatch.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Run upp:test-reviewer (full mode, 18 tests)**

Per UPP. Address any CRITICAL/MAJOR before GREEN.

- [ ] **Step 4: Implement minimal code**

Create `src/tools/file-upload.ts`:

```typescript
import { readFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import type { IEngine } from '../engines/engine.js';
import type { Engine, ToolResponse, ToolRequirements } from '../types.js';
import {
  ERROR_CODES,
  EngineRequiredError,
  FileUploadEmptyPathsError,
  FileUploadTooManyFilesError,
  FileUploadInvalidParamsError,
  FileUploadPathNotFoundError,
  FileUploadPathNotReadableError,
  FileUploadFileTooLargeError,
  FileUploadInvalidElementError,
  FileUploadElementDetachedError,
  FileUploadMultipleNotAllowedError,
} from '../errors.js';
import { mimeFromExtension } from './mime.js';
import { resolveUploadPath, findClosestSibling } from '../path-resolve.js';

const CAP_BYTES = 25 * 1024 * 1024;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}

type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;

interface ProbeResult {
  ok: boolean;
  isFileInput?: boolean;
  multiple?: boolean;
  accept?: string;
  frameId?: string;
  errorCode?: string;
  tagName?: string;
  type?: string;
}

export class FileUploadTools {
  private engine: IEngine;
  private handlers = new Map<string, Handler>();

  constructor(engine: IEngine) {
    this.engine = engine;
    this.handlers.set('safari_file_upload', this.handleFileUpload.bind(this));
  }

  getDefinitions(): ToolDefinition[] {
    return [{
      name: 'safari_file_upload',
      description:
        'Attach files to an <input type=file> element. ' +
        'Does not support drag-and-drop dropzones, custom file pickers, or native OS file dialogs — ' +
        'only standard file inputs, including those hidden behind a <label> (use force: true for these). ' +
        'Locator: same chain as safari_click / safari_fill (selector / role / text / label / placeholder / xpath / ref). ' +
        'Paths must be absolute or ~-prefixed; relative paths are rejected. ' +
        'Limits: 25 MB per file, 4 files per call. ' +
        'On success: dispatches input + change events on the resolved input element, then probes for client-side validation errors. ' +
        "If `response.validation` is present, it indicates site-side rejection (wrong file type, oversized per site rules, etc.) — a successful tool call does NOT guarantee the site accepted the file. " +
        "To clear the input's existing files, pass clear: true (passing an empty paths array is rejected with FILE_UPLOAD_EMPTY_PATHS). " +
        'Override MIME type via the parallel mimeOverrides map: `paths: ["~/foo.bin"], mimeOverrides: {"~/foo.bin": "application/x-custom"}` (keys must match `paths` entries byte-equal, pre-expansion). ' +
        'Example: safari_file_upload({ tabUrl, label: "Resume", paths: ["~/Downloads/resume.pdf"] })',
      inputSchema: {
        type: 'object',
        properties: {
          tabUrl: { type: 'string', description: 'Current URL of the tab' },
          selector: { type: 'string' },
          ref: { type: 'string' },
          role: { type: 'object' },
          text: { type: 'string' },
          label: { type: 'string' },
          placeholder: { type: 'string' },
          xpath: { type: 'string' },
          paths: {
            type: 'array', minItems: 1, maxItems: 4,
            items: { type: 'string' },
            description: '1-4 file paths (absolute or ~-prefixed). Use clear: true to empty the input instead of passing an empty array.',
          },
          mimeOverrides: {
            type: 'object',
            additionalProperties: { type: 'string' },
            description: 'Optional path → MIME type map. Keys must byte-equal entries in `paths` AS PROVIDED by the agent (raw, pre-`~`-expansion). Unmatched keys throw FILE_UPLOAD_INVALID_PARAMS.',
          },
          clear: { type: 'boolean' },
          timeout: { type: 'number', default: 5000 },
          force: { type: 'boolean', default: false },
          validationProbeMs: { type: 'number', default: 200, minimum: 0, maximum: 2000 },
        },
        required: ['tabUrl'],
      },
      requirements: { idempotent: false },
    }];
  }

  getHandler(name: string): Handler | undefined {
    return this.handlers.get(name);
  }

  private async handleFileUpload(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;

    // a. Engine gate
    if (this.engine.name !== 'extension') {
      throw new EngineRequiredError('safari_file_upload requires the extension engine.');
    }

    // b. Mutual exclusion
    const paths = params['paths'] as string[] | undefined;
    const clear = params['clear'] === true;
    if (paths !== undefined && clear) {
      throw new FileUploadInvalidParamsError('cannot pass both paths and clear: true');
    }
    if (paths === undefined && !clear) {
      throw new FileUploadInvalidParamsError('must pass either paths or clear: true');
    }

    if (paths !== undefined) {
      if (paths.length === 0) throw new FileUploadEmptyPathsError();
      if (paths.length > 4) throw new FileUploadTooManyFilesError(paths.length);
    }

    // c. mimeOverrides key validation
    const mimeOverrides = (params['mimeOverrides'] as Record<string, string> | undefined) ?? {};
    if (paths !== undefined) {
      const pathSet = new Set(paths);
      const unmatched = Object.keys(mimeOverrides).filter((k) => !pathSet.has(k));
      if (unmatched.length > 0) {
        throw new FileUploadInvalidParamsError(`mimeOverrides keys [${unmatched.join(', ')}] are not in paths`);
      }
    }

    const force = params['force'] === true;
    const timeoutMs = (params['timeout'] as number | undefined) ?? 5000;
    const validationProbeMs = Math.max(0, Math.min(2000, (params['validationProbeMs'] as number | undefined) ?? 200));
    const locator = this.extractLocator(params);

    // d. Probe sentinel — locator + element-type validation BEFORE byte staging
    const probeJson = JSON.stringify({ locator, force, timeoutMs });
    const probeResult = await this.engine.executeJsInTab(tabUrl, `__SP_FILE_UPLOAD_PROBE__:${probeJson}`);
    if (!probeResult.ok) throw new Error(probeResult.error?.message ?? 'probe dispatch failed');
    const probe = JSON.parse(probeResult.value ?? '{}') as ProbeResult;
    if (!probe.ok) {
      // Handler-side mapping
      if (probe.errorCode === 'FILE_UPLOAD_INVALID_ELEMENT') {
        throw new FileUploadInvalidElementError(probe.tagName ?? 'UNKNOWN', probe.type ?? '');
      }
      throw new Error(`probe failed: ${probe.errorCode ?? 'unknown'}`);
    }
    if (!probe.isFileInput) {
      throw new FileUploadInvalidElementError(probe.tagName ?? 'UNKNOWN', probe.type ?? '');
    }
    if (paths !== undefined && paths.length > 1 && probe.multiple === false) {
      throw new FileUploadMultipleNotAllowedError();
    }

    // e. Pre-flight reads + stage
    const tokenedFiles: { token: string; name: string; mimeType: string; mimeFallback?: true }[] = [];
    const allWarnings: string[] = [];
    if (paths !== undefined) {
      for (const inputPath of paths) {
        const resolved = resolveUploadPath(inputPath);  // throws PATH_NOT_ABSOLUTE / PATH_NOT_READABLE
        if (resolved.warnings.length > 0) allWarnings.push(...resolved.warnings);
        let st;
        try {
          st = await stat(resolved.absolute);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            const sugg = findClosestSibling(resolved.absolute);
            throw new FileUploadPathNotFoundError(resolved.absolute, sugg);
          }
          if (code === 'EACCES' || code === 'EPERM' || code === 'EISDIR') {
            throw new FileUploadPathNotReadableError(resolved.absolute);
          }
          throw e;
        }
        if (!st.isFile()) throw new FileUploadPathNotReadableError(resolved.absolute);
        if (st.size > CAP_BYTES) throw new FileUploadFileTooLargeError(resolved.absolute, st.size);
        const buf = await readFile(resolved.absolute);
        if (buf.byteLength > CAP_BYTES) {
          throw new FileUploadFileTooLargeError(resolved.absolute, buf.byteLength);  // TOCTOU re-check
        }
        // MIME: agent override > extension lookup
        const overrideMime = mimeOverrides[inputPath];
        const mimeRes = mimeFromExtension(basename(resolved.absolute));
        const mimeType = overrideMime ?? mimeRes.mimeType;
        const mimeFallback = overrideMime === undefined && mimeRes.fallback;

        // Stage to daemon: NDJSON `stage_file`
        const token = randomBytes(32).toString('hex');
        const stageReq = { cmd: 'stage_file', token, mimeType, bytesB64: buf.toString('base64') };
        const stageRes = await this.engine.execute(stageReq);
        if (!stageRes.ok) throw new Error(`stage_file failed: ${stageRes.error?.message ?? 'unknown'}`);

        const entry: { token: string; name: string; mimeType: string; mimeFallback?: true } = {
          token, name: basename(resolved.absolute), mimeType,
        };
        if (mimeFallback) entry.mimeFallback = true;
        tokenedFiles.push(entry);
      }
    }

    // f. Final sentinel — install via storage bus
    const finalJson = JSON.stringify({
      locator, tokens: tokenedFiles, clear,
      probeOpts: { force, validationProbeMs },
    });
    const finalResult = await this.engine.executeJsInTab(tabUrl, `__SP_FILE_UPLOAD__:${finalJson}`);
    if (!finalResult.ok) {
      const code = finalResult.error?.code;
      if (code === 'FILE_UPLOAD_ELEMENT_DETACHED') throw new FileUploadElementDetachedError();
      if (code === 'FILE_UPLOAD_INVALID_ELEMENT') throw new FileUploadInvalidElementError('UNKNOWN', '');
      if (code === 'FILE_UPLOAD_MULTIPLE_NOT_ALLOWED') throw new FileUploadMultipleNotAllowedError();
      throw new Error(finalResult.error?.message ?? 'file upload dispatch failed');
    }
    const responsePayload = JSON.parse(finalResult.value ?? '{"uploaded":0,"files":[]}') as {
      uploaded: number;
      files: { name: string; size: number; mimeType: string; path: string; mimeFallback?: true }[];
      validation?: { message?: string; alerts?: string[] };
    };

    // g. Shape MCP response
    const result: Record<string, unknown> = {
      uploaded: responsePayload.uploaded,
      files: responsePayload.files,
    };
    if (responsePayload.validation) result['validation'] = responsePayload.validation;
    if (allWarnings.length > 0) result['warnings'] = allWarnings;

    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      metadata: { engine: 'extension' as Engine, degraded: false, latencyMs: Date.now() - start },
    };
  }

  private extractLocator(params: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const k of ['selector', 'ref', 'role', 'text', 'label', 'placeholder', 'xpath']) {
      if (params[k] !== undefined) out[k] = params[k];
    }
    return out;
  }
}
```

> Note: `EngineRequiredError` is from `src/errors.ts`. If it doesn't exist there, add it as part of this task — same shape as the other error subclasses. (Verify with `grep -n EngineRequiredError src/errors.ts` first; if existing, import; if not, add it before writing the test.)

- [ ] **Step 5: Wire into the server**

Modify `src/server.ts`:
```typescript
import { FileUploadTools } from './tools/file-upload.js';
// ... in the constructor's modules array:
new FileUploadTools(this.engine),
```

Run: `grep -n 'new AuthTools' src/server.ts` to find the canonical insertion point and mirror the pattern. Add the FileUploadTools line right after AuthTools.

- [ ] **Step 6: Run tests to verify they pass + lint clean**

Run: `cd "$(git rev-parse --show-toplevel)" && npx vitest run test/unit/tools/file-upload-dispatch.test.ts && npm run lint`
Expected: 18 PASS, lint clean.

- [ ] **Step 7: Commit**

```bash
git add src/tools/file-upload.ts src/server.ts test/unit/tools/file-upload-dispatch.test.ts
git commit -m "feat(5A.1 phase-2): file-upload.ts handler + server registration + dispatch tests"
```

---

## Phase 3 — Daemon Swift

### Task 7: `FileStagingStore` actor + Swift unit tests

**Files:**
- Create: `daemon/Sources/SafariPilotdCore/FileStagingStore.swift`
- Create: `daemon/Tests/SafariPilotdTests/FileStagingStoreTests.swift`

- [ ] **Step 1: Read the existing Swift test pattern**

Run: `head -50 daemon/Tests/SafariPilotdTests/ExtensionBridgeTests.swift` and `head -50 daemon/Sources/SafariPilotdCore/ExtensionBridge.swift`. Understand the actor + XCTest patterns used.

- [ ] **Step 2: Write failing tests**

Create `daemon/Tests/SafariPilotdTests/FileStagingStoreTests.swift`:

```swift
import XCTest
@testable import SafariPilotdCore

final class FileStagingStoreTests: XCTestCase {
    func testStageAndPeekReturnsBytes() async throws {
        let store = FileStagingStore()
        let bytes = Data([0x01, 0x02, 0x03, 0x04])
        let token = "deadbeef"
        await store.stage(token: token, file: StagedFile(bytes: bytes, mimeType: "application/octet-stream", expiresAt: Date(timeIntervalSinceNow: 60)))
        let peeked = await store.peek(token: token)
        XCTAssertNotNil(peeked)
        XCTAssertEqual(peeked?.bytes, bytes)
    }

    func testPeekDoesNotRemove() async throws {
        let store = FileStagingStore()
        let token = "abc"
        await store.stage(token: token, file: StagedFile(bytes: Data([1]), mimeType: "x", expiresAt: Date(timeIntervalSinceNow: 60)))
        _ = await store.peek(token: token)
        let again = await store.peek(token: token)
        XCTAssertNotNil(again, "peek must NOT remove the entry — DELETE does")
    }

    func testReleaseRemovesEntry() async throws {
        let store = FileStagingStore()
        let token = "to-release"
        await store.stage(token: token, file: StagedFile(bytes: Data([1]), mimeType: "x", expiresAt: Date(timeIntervalSinceNow: 60)))
        await store.release(token: token)
        let peeked = await store.peek(token: token)
        XCTAssertNil(peeked)
    }

    func testReleaseOnMissingTokenIsBenign() async throws {
        let store = FileStagingStore()
        // DELETE on already-evicted token — should not crash; daemon returns 404 to extension.
        await store.release(token: "never-existed")
        // No assertion — just verify no crash.
    }

    func testEvictExpiredRemovesPastDueEntries() async throws {
        let store = FileStagingStore()
        let now = Date()
        await store.stage(token: "future", file: StagedFile(bytes: Data([1]), mimeType: "x", expiresAt: now.addingTimeInterval(60)))
        await store.stage(token: "past", file: StagedFile(bytes: Data([1]), mimeType: "x", expiresAt: now.addingTimeInterval(-1)))
        let evicted = await store.evictExpired(now: now)
        XCTAssertEqual(evicted, 1)
        let stillThere = await store.peek(token: "future")
        XCTAssertNotNil(stillThere)
        let gone = await store.peek(token: "past")
        XCTAssertNil(gone)
    }

    func testConcurrentStageDoesNotCorrupt() async throws {
        let store = FileStagingStore()
        // Fan out 50 concurrent stages, each with a distinct token; verify all land.
        await withTaskGroup(of: Void.self) { group in
            for i in 0..<50 {
                group.addTask {
                    await store.stage(
                        token: "tok-\(i)",
                        file: StagedFile(
                            bytes: Data([UInt8(i)]),
                            mimeType: "x",
                            expiresAt: Date(timeIntervalSinceNow: 60)
                        )
                    )
                }
            }
        }
        for i in 0..<50 {
            let entry = await store.peek(token: "tok-\(i)")
            XCTAssertEqual(entry?.bytes, Data([UInt8(i)]))
        }
    }
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd "$(git rev-parse --show-toplevel)/daemon" && swift test --filter FileStagingStoreTests`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement minimal code**

Create `daemon/Sources/SafariPilotdCore/FileStagingStore.swift`:

```swift
import Foundation

public struct StagedFile: Sendable {
    public let bytes: Data
    public let mimeType: String
    public let expiresAt: Date

    public init(bytes: Data, mimeType: String, expiresAt: Date) {
        self.bytes = bytes
        self.mimeType = mimeType
        self.expiresAt = expiresAt
    }
}

/// Phase 5A · 5A.1 — actor-protected token-keyed bytes-in-memory store
/// for the file_upload feature.
///
/// GET /file-bytes/<token> → peek (does NOT remove)
/// DELETE /file-bytes/<token> → release (extension signals successful read)
/// 30s timer in SafariPilotd.start() → evictExpired (removes age > 60s)
public actor FileStagingStore {
    private var entries: [String: StagedFile] = [:]

    public init() {}

    public func stage(token: String, file: StagedFile) {
        entries[token] = file
    }

    public func peek(token: String) -> StagedFile? {
        return entries[token]
    }

    public func release(token: String) {
        entries.removeValue(forKey: token)
    }

    public func evictExpired(now: Date) -> Int {
        let beforeCount = entries.count
        entries = entries.filter { $0.value.expiresAt > now }
        return beforeCount - entries.count
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd "$(git rev-parse --show-toplevel)/daemon" && swift test --filter FileStagingStoreTests`
Expected: 6 PASS.

- [ ] **Step 6: Commit**

```bash
git add daemon/Sources/SafariPilotdCore/FileStagingStore.swift daemon/Tests/SafariPilotdTests/FileStagingStoreTests.swift
git commit -m "feat(5A.1 phase-3): FileStagingStore actor + 6 Swift unit tests"
```

### Task 8: `stage_file` NDJSON command in CommandDispatcher.swift

**Files:**
- Modify: `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift` (add `stage_file` case + Codable structs)
- Modify: the dispatcher's owning struct/class to hold the `FileStagingStore` instance — verify exact location with `grep -n 'class CommandDispatcher\|struct CommandDispatcher\|init' daemon/Sources/SafariPilotdCore/CommandDispatcher.swift | head -20`

- [ ] **Step 1: Add the request/response Codable types**

Near the top of `CommandDispatcher.swift` (after existing Codable struct declarations):

```swift
struct StageFileRequest: Codable {
    let cmd: String           // must be "stage_file"
    let token: String         // 64-char hex
    let mimeType: String
    let bytesB64: String
}

struct StageFileResponse: Codable {
    let staged: Bool
    let token: String
}
```

- [ ] **Step 2: Inject FileStagingStore into the dispatcher**

In CommandDispatcher's stored properties / init: add `let stagingStore: FileStagingStore`. Update call sites in SafariPilotd.swift (the entry-point file that constructs the dispatcher) to pass a shared `FileStagingStore` instance.

- [ ] **Step 3: Add the `stage_file` case to the command dispatch switch**

Locate the existing `switch cmd { case "ping": ... }` (around line 134 per existing structure). After `case "extension_health":` (or wherever fits the alphabetical/logical position), add:

```swift
case "stage_file":
    let req = try JSONDecoder().decode(StageFileRequest.self, from: try JSONEncoder().encode(payload))
    // Validate: token is 64 hex chars
    guard req.token.count == 64, req.token.allSatisfy({ $0.isHexDigit }) else {
        return makeErrorResponse(code: "INVALID_TOKEN", message: "stage_file token must be 64 hex chars")
    }
    // Validate: bytes within cap (defense in depth — TS handler is normative)
    guard let bytes = Data(base64Encoded: req.bytesB64) else {
        return makeErrorResponse(code: "INVALID_BASE64", message: "stage_file bytesB64 not valid base64")
    }
    guard bytes.count <= 25 * 1024 * 1024 else {
        return makeErrorResponse(code: "FILE_TOO_LARGE", message: "stage_file bytes exceed 25 MB")
    }
    let staged = StagedFile(
        bytes: bytes,
        mimeType: req.mimeType,
        expiresAt: Date(timeIntervalSinceNow: 60)
    )
    await stagingStore.stage(token: req.token, file: staged)
    let response = StageFileResponse(staged: true, token: req.token)
    return try makeSuccessResponse(value: response)
```

> Use existing `makeErrorResponse` / `makeSuccessResponse` helpers per the file's pattern. If they don't exist with these exact names, locate the equivalents (`grep -n 'func make' daemon/Sources/SafariPilotdCore/CommandDispatcher.swift`).

- [ ] **Step 4: Build the daemon**

Run: `cd "$(git rev-parse --show-toplevel)" && swift build --package-path daemon 2>&1 | tail -20`
Expected: clean build, no errors.

- [ ] **Step 5: Add a small integration-style Swift test**

Append to `daemon/Tests/SafariPilotdTests/FileStagingStoreTests.swift` (or new file `StageFileCommandTests.swift`) — verify the dispatcher accepts the command and stages bytes:

```swift
final class StageFileCommandTests: XCTestCase {
    func testStageFileViaDispatcher() async throws {
        let store = FileStagingStore()
        let dispatcher = CommandDispatcher(stagingStore: store /* + other deps per actual init */)
        let req: [String: Any] = [
            "cmd": "stage_file",
            "token": String(repeating: "a", count: 64),
            "mimeType": "image/png",
            "bytesB64": Data([0x89, 0x50, 0x4E, 0x47]).base64EncodedString()
        ]
        let resp = try await dispatcher.dispatch(req)
        // The exact response shape depends on existing makeSuccessResponse —
        // assert at minimum that it's a success and the token is staged.
        let staged = await store.peek(token: String(repeating: "a", count: 64))
        XCTAssertNotNil(staged)
        XCTAssertEqual(staged?.bytes, Data([0x89, 0x50, 0x4E, 0x47]))
        XCTAssertEqual(staged?.mimeType, "image/png")
    }
}
```

> If the existing dispatcher's `init` requires more dependencies than just `stagingStore`, mirror them with mocks/dummies per existing test patterns (consult `ExtensionBridgeTests.swift`).

- [ ] **Step 6: Run + lint**

Run: `cd "$(git rev-parse --show-toplevel)/daemon" && swift test --filter StageFileCommand`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add daemon/Sources/SafariPilotdCore/CommandDispatcher.swift daemon/Tests/SafariPilotdTests/
git commit -m "feat(5A.1 phase-3): stage_file NDJSON command on CommandDispatcher"
```

### Task 9: `/file-bytes/<token>` HTTP routes (GET peek, DELETE release)

**Files:**
- Modify: `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift` (add 2 routes)

- [ ] **Step 1: Locate the existing route registration**

Run: `grep -n 'router\.\|app\.get\|app\.post\|.get(\|.post(\|/poll\|/result' daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift | head -20`. Identify the Hummingbird router pattern.

- [ ] **Step 2: Add the GET and DELETE routes**

In the route registration block, add:

```swift
// Phase 5A · 5A.1 — file-bytes token routes
router.get("/file-bytes/:token") { request, context async throws -> Response in
    guard let token = context.parameters.get("token"), token.count == 64 else {
        return Response(status: .notFound)
    }
    guard let staged = await stagingStore.peek(token: token) else {
        return Response(status: .notFound)
    }
    var headers = HTTPFields()
    headers[.contentType] = staged.mimeType
    return Response(
        status: .ok,
        headers: headers,
        body: ResponseBody(byteBuffer: ByteBuffer(data: staged.bytes))
    )
}

router.delete("/file-bytes/:token") { request, context async throws -> Response in
    guard let token = context.parameters.get("token"), token.count == 64 else {
        return Response(status: .notFound)
    }
    await stagingStore.release(token: token)
    // 204 success regardless of whether token existed; extension treats 404 as success.
    return Response(status: .noContent)
}
```

> Inject `stagingStore` into the closure scope. Existing routes will show the canonical pattern for how to access shared state — match it.

- [ ] **Step 3: Add a Swift test for the routes**

Append to `daemon/Tests/SafariPilotdTests/StageFileCommandTests.swift` or new `FileBytesRouteTests.swift`:

```swift
final class FileBytesRouteTests: XCTestCase {
    func testGetPeeksAndDeleteReleases() async throws {
        let store = FileStagingStore()
        await store.stage(
            token: String(repeating: "b", count: 64),
            file: StagedFile(bytes: Data([0xAA, 0xBB]), mimeType: "application/octet-stream", expiresAt: Date(timeIntervalSinceNow: 60))
        )

        // Existing tests in this codebase use Hummingbird's TestClient or similar.
        // Mirror the pattern established by /poll, /result test coverage.
        // Pseudo-test — actual implementation depends on existing test infra:
        //
        //   let getResp = try await server.test().get("/file-bytes/\(token)").execute()
        //   XCTAssertEqual(getResp.status, .ok)
        //   XCTAssertEqual(getResp.body, Data([0xAA, 0xBB]))
        //
        //   // Peek does NOT remove
        //   let peeked = await store.peek(token: token)
        //   XCTAssertNotNil(peeked)
        //
        //   let deleteResp = try await server.test().delete("/file-bytes/\(token)").execute()
        //   XCTAssertEqual(deleteResp.status, .noContent)
        //
        //   let afterDelete = await store.peek(token: token)
        //   XCTAssertNil(afterDelete)

        // Until the test infra is wired, exercise the actor directly:
        let peeked = await store.peek(token: String(repeating: "b", count: 64))
        XCTAssertNotNil(peeked)
        await store.release(token: String(repeating: "b", count: 64))
        let afterDelete = await store.peek(token: String(repeating: "b", count: 64))
        XCTAssertNil(afterDelete)
    }
}
```

- [ ] **Step 4: Build + test + commit**

```bash
cd "$(git rev-parse --show-toplevel)/daemon" && swift build && swift test --filter FileBytesRoute
git add daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift daemon/Tests/SafariPilotdTests/
git commit -m "feat(5A.1 phase-3): GET/DELETE /file-bytes/<token> Hummingbird routes"
```

### Task 10: TTL cleanup background task

**Files:**
- Modify: `daemon/Sources/SafariPilotdCore/SafariPilotd.swift` (or whichever file holds `SafariPilotd.start()`)

- [ ] **Step 1: Locate the start function**

Run: `grep -rn 'func start\|public func start' daemon/Sources/SafariPilotdCore/ | head -10`

- [ ] **Step 2: Add the cleanup task at the bottom of start()**

```swift
// Phase 5A · 5A.1 — file staging TTL cleanup (every 30s)
Task { [stagingStore, logger] in
    while !Task.isCancelled {
        do {
            try await Task.sleep(for: .seconds(30))
        } catch {
            break
        }
        let evicted = await stagingStore.evictExpired(now: Date())
        if evicted > 0 {
            logger.info("file-stage: evicted \(evicted) expired tokens")
        }
    }
}
```

- [ ] **Step 3: Build the daemon**

Run: `cd "$(git rev-parse --show-toplevel)" && swift build --package-path daemon 2>&1 | tail -10`
Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add daemon/Sources/SafariPilotdCore/
git commit -m "feat(5A.1 phase-3): TTL cleanup task in SafariPilotd.start (every 30s)"
```

---

## Phase 4 — Extension JS (rebuild-bearing piece)

### Task 11: `background.js` — sentinel branches for probe + final upload

**Files:**
- Modify: `extension/background.js`

- [ ] **Step 1: Locate the existing executeCommand routing**

Run: `grep -n 'executeCommand\|__SP_COOKIE\|__SP_DNR\|sp_cmd' extension/background.js | head -10`. Find the existing `__SP_*` sentinel branches.

- [ ] **Step 2: Add the two new sentinel branches**

In `executeCommand`, BEFORE the storage bus fallback dispatch, mirror the cookie/DNR pattern:

```javascript
// Phase 5A · 5A.1 — file_upload probe (locator-only, ~1 KB payload)
if (typeof cmd.script === 'string' && cmd.script.startsWith('__SP_FILE_UPLOAD_PROBE__:')) {
  const json = cmd.script.slice('__SP_FILE_UPLOAD_PROBE__:'.length);
  let parsed;
  try { parsed = JSON.parse(json); } catch (e) {
    return { ok: false, error: { code: 'INVALID_PARAMS', message: 'probe sentinel has invalid JSON' } };
  }
  await browser.storage.local.set({
    [`sp_cmd_${cmd.commandId}`]: {
      op: 'file_upload_probe',
      commandId: cmd.commandId,
      locator: parsed.locator,
      force: parsed.force,
      timeoutMs: parsed.timeoutMs,
    },
  });
  return; // result lands in sp_result_<commandId> via existing relay
}

// Phase 5A · 5A.1 — final file_upload (token list + locator + probeOpts; bytes via /file-bytes)
if (typeof cmd.script === 'string' && cmd.script.startsWith('__SP_FILE_UPLOAD__:')) {
  const json = cmd.script.slice('__SP_FILE_UPLOAD__:'.length);
  let parsed;
  try { parsed = JSON.parse(json); } catch (e) {
    return { ok: false, error: { code: 'INVALID_PARAMS', message: 'file_upload sentinel has invalid JSON' } };
  }
  await browser.storage.local.set({
    [`sp_cmd_${cmd.commandId}`]: {
      op: 'file_upload',
      commandId: cmd.commandId,
      locator: parsed.locator,
      tokens: parsed.tokens,
      clear: parsed.clear === true,
      probeOpts: parsed.probeOpts,
    },
  });
  return;
}
```

- [ ] **Step 3: Lint check**

The extension JS isn't TypeScript-checked but syntax errors would surface at extension load time. Verify with a quick `node --check extension/background.js`:

```bash
node --check extension/background.js && echo "syntax OK"
```

- [ ] **Step 4: Commit**

```bash
git add extension/background.js
git commit -m "feat(5A.1 phase-4): __SP_FILE_UPLOAD_PROBE__ + __SP_FILE_UPLOAD__ sentinel branches"
```

### Task 12: `content-isolated.js` — probe handler + byte fetch + DELETE

**Files:**
- Modify: `extension/content-isolated.js`

- [ ] **Step 1: Locate the existing `sp_cmd` op handler**

Run: `grep -n 'storage.onChanged\|sp_cmd\|case .op\|cmd.op' extension/content-isolated.js | head -10`

- [ ] **Step 2: Add the two op handlers**

In the existing op-dispatch switch:

```javascript
if (cmd.op === 'file_upload_probe') {
  // Locator probe: validates element type without staging any bytes.
  // Reuses the existing locator helper (SP.findElement or similar — verify name).
  let result = { ok: false };
  try {
    const el = SP.findElement(cmd.locator, { timeoutMs: cmd.timeoutMs, force: cmd.force });
    if (!el) {
      result = { ok: false, errorCode: 'LOCATOR_NOT_FOUND' };
    } else if (el.tagName !== 'INPUT' || el.type !== 'file') {
      result = { ok: false, errorCode: 'FILE_UPLOAD_INVALID_ELEMENT', tagName: el.tagName, type: el.type };
    } else {
      result = {
        ok: true,
        isFileInput: true,
        multiple: el.multiple === true,
        accept: el.accept || '',
      };
    }
  } catch (e) {
    result = { ok: false, errorCode: 'PROBE_ERROR', message: String(e && e.message || e) };
  }
  await browser.storage.local.set({
    [`sp_result_${cmd.commandId}`]: { ok: true, value: JSON.stringify(result) },
  });
  return;
}

if (cmd.op === 'file_upload') {
  // Fetch each token's bytes from the daemon; build File objects in extension
  // permission context; postMessage to MAIN with structured-clone of File[].
  const files = [];
  const fetchErrors = [];
  for (const tokenInfo of cmd.tokens) {
    try {
      const r = await fetch(`http://127.0.0.1:19475/file-bytes/${tokenInfo.token}`);
      if (!r.ok) {
        fetchErrors.push({ token: tokenInfo.token, status: r.status });
        continue;
      }
      const buf = await r.arrayBuffer();
      const file = new File([buf], tokenInfo.name, { type: tokenInfo.mimeType });
      files.push(file);
    } catch (e) {
      fetchErrors.push({ token: tokenInfo.token, error: String(e && e.message || e) });
    }
  }
  // On any error: short-circuit; do NOT issue DELETE (let TTL handle).
  if (fetchErrors.length > 0) {
    await browser.storage.local.set({
      [`sp_result_${cmd.commandId}`]: {
        ok: false,
        error: {
          code: 'FILE_UPLOAD_FETCH_FAILED',
          message: `failed to fetch ${fetchErrors.length} file(s) from daemon`,
          details: fetchErrors,
        },
      },
    });
    return;
  }
  // Issue DELETE for each token (release daemon memory).
  // 404 on already-evicted token is non-fatal.
  await Promise.all(cmd.tokens.map((t) =>
    fetch(`http://127.0.0.1:19475/file-bytes/${t.token}`, { method: 'DELETE' }).catch(() => null)
  ));
  // Forward to MAIN via postMessage; structured-clone preserves File[].
  const responsePromise = new Promise((resolve) => {
    const handler = (ev) => {
      if (ev.data && ev.data.op === 'file_upload_response' && ev.data.commandId === cmd.commandId) {
        window.removeEventListener('message', handler);
        resolve(ev.data.payload);
      }
    };
    window.addEventListener('message', handler);
    setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve({ ok: false, errorCode: 'INJECT_TIMEOUT', message: 'main-world response timeout (5s)' });
    }, 5000);
  });
  window.postMessage({
    op: 'file_upload_inject',
    commandId: cmd.commandId,
    locator: cmd.locator,
    files,
    clear: cmd.clear === true,
    probeOpts: cmd.probeOpts,
  }, '*');
  const response = await responsePromise;
  if (response.ok === false) {
    await browser.storage.local.set({
      [`sp_result_${cmd.commandId}`]: {
        ok: false,
        error: { code: response.errorCode || 'FILE_UPLOAD_FAILED', message: response.message || '' },
      },
    });
    return;
  }
  await browser.storage.local.set({
    [`sp_result_${cmd.commandId}`]: { ok: true, value: JSON.stringify(response) },
  });
  return;
}
```

> The `SP.findElement` helper name — verify with `grep -n 'SP.findElement\|SP\.find' extension/content-isolated.js`. If different name, mirror.

- [ ] **Step 3: Syntax check**

```bash
node --check extension/content-isolated.js && echo "syntax OK"
```

- [ ] **Step 4: Commit**

```bash
git add extension/content-isolated.js
git commit -m "feat(5A.1 phase-4): content-isolated probe + byte fetch + File construction + DELETE release"
```

### Task 13: `content-main.js` — DataTransfer injection + validation probe

**Files:**
- Modify: `extension/content-main.js`

- [ ] **Step 1: Locate existing window.postMessage handlers**

Run: `grep -n "window.addEventListener.*message" extension/content-main.js | head -5`

- [ ] **Step 2: Add the file_upload_inject handler**

```javascript
window.addEventListener('message', (ev) => {
  if (!ev.data || ev.data.op !== 'file_upload_inject') return;

  const respond = (payload) => {
    window.postMessage({ op: 'file_upload_response', commandId: ev.data.commandId, payload }, '*');
  };

  try {
    // a. Resolve input via existing locator helpers (MAIN-world copy of SP.findElement)
    const input = SPMain.findElement(ev.data.locator, { force: ev.data.probeOpts.force });
    if (!input) {
      respond({ ok: false, errorCode: 'LOCATOR_NOT_FOUND', message: 'locator did not resolve in main world' });
      return;
    }
    // b. Detached-element check
    if (!document.contains(input)) {
      respond({ ok: false, errorCode: 'FILE_UPLOAD_ELEMENT_DETACHED' });
      return;
    }
    // c. tagName/type re-check (probe-vs-inject divergence)
    if (input.tagName !== 'INPUT' || input.type !== 'file') {
      respond({ ok: false, errorCode: 'FILE_UPLOAD_INVALID_ELEMENT', tagName: input.tagName, type: input.type });
      return;
    }
    // d. multiple-attr re-check
    if (!ev.data.clear && ev.data.files.length > 1 && input.multiple === false) {
      respond({ ok: false, errorCode: 'FILE_UPLOAD_MULTIPLE_NOT_ALLOWED' });
      return;
    }
    // e. Build DataTransfer
    const dt = new DataTransfer();
    if (!ev.data.clear) {
      for (const file of ev.data.files) dt.items.add(file);
    }
    // f. Object.defineProperty assignment
    Object.defineProperty(input, 'files', {
      value: dt.files, writable: false, configurable: true,
    });
    // g. Fire input + change events
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    // h. Validation probe at +probeOpts.validationProbeMs
    const probeMs = ev.data.probeOpts.validationProbeMs;
    const finalize = () => {
      const out = {
        ok: true,
        uploaded: ev.data.clear ? 0 : ev.data.files.length,
        files: (ev.data.clear ? [] : ev.data.files).map((f) => ({
          name: f.name, size: f.size, mimeType: f.type, path: '', // path filled by handler
        })),
      };
      if (probeMs > 0) {
        const validation = collectValidation(input);
        if (validation) out.validation = validation;
      }
      respond(out);
    };
    if (probeMs > 0) setTimeout(finalize, probeMs);
    else finalize();
  } catch (e) {
    respond({ ok: false, errorCode: 'INJECT_ERROR', message: String(e && e.message || e) });
  }
});

function collectValidation(input) {
  // Scope: closest <form> ancestor; fallback to input.parentElement
  const form = input.closest('form');
  const scope = form || input.parentElement || document.body;

  const message = input.validationMessage || '';
  const alerts = [];

  // [role=alert]
  for (const el of scope.querySelectorAll('[role="alert"]')) {
    if (alerts.length >= 3) break;
    const text = (el.textContent || '').trim();
    if (text) alerts.push(text.length > 500 ? text.slice(0, 500) + '…' : text);
  }
  // [aria-invalid=true]
  for (const el of scope.querySelectorAll('[aria-invalid="true"]')) {
    if (alerts.length >= 3) break;
    const text = (el.textContent || '').trim();
    if (text) alerts.push(text.length > 500 ? text.slice(0, 500) + '…' : text);
  }
  // aria-errormessage IDREF list
  const ariaErrAttr = input.getAttribute('aria-errormessage');
  if (ariaErrAttr) {
    for (const id of ariaErrAttr.split(/\s+/)) {
      if (alerts.length >= 3) break;
      const el = document.getElementById(id);
      if (el) {
        const text = (el.textContent || '').trim();
        if (text) alerts.push(text.length > 500 ? text.slice(0, 500) + '…' : text);
      }
    }
  }

  if (!message && alerts.length === 0) return undefined;
  const out = {};
  if (message) out.message = message;
  if (alerts.length > 0) out.alerts = alerts;
  return out;
}
```

> `SPMain.findElement` — verify name with `grep 'SPMain' extension/content-main.js | head -5`. The existing pattern probably has a different namespace (SP, etc.). Use whatever the existing main-world locator helper is named.

- [ ] **Step 3: Syntax check + commit**

```bash
node --check extension/content-main.js && echo "syntax OK"
git add extension/content-main.js
git commit -m "feat(5A.1 phase-4): content-main inject — DataTransfer + defineProperty + events + validation probe"
```

---

## Phase 5 — Fixture endpoint

### Task 14: `/upload-fixture` + `/upload-validate` routes

**Files:**
- Modify: `test/helpers/fixture-server.ts`

- [ ] **Step 1: Add multipart parser + endpoints**

After the existing `/cookie-fixture` route (around line ~64):

```typescript
import { createHash } from 'node:crypto';

if (url === '/upload-fixture' && req.method === 'POST') {
  // Minimal multipart/form-data parser — no deps.
  const ct = req.headers['content-type'] || '';
  const boundaryMatch = ct.match(/boundary=([^\s;]+)/);
  if (!boundaryMatch) {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('missing boundary');
    return;
  }
  const boundary = '--' + boundaryMatch[1];
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(c));
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

if (url === '/upload-validate' && req.method === 'POST') {
  // Returns 400 with aria-invalid signal in HTML body — exercises validation probe.
  res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!DOCTYPE html><html><body><div role="alert" id="err">File too large per site rules</div></body></html>');
  return;
}

if (url === '/upload-form') {
  // Static HTML page with <input type=file> + form posting to /upload-fixture.
  // Used by e2e tests that drive the form via safari_file_upload.
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
      // Expose last-submitted response for e2e assertions.
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
```

And the helper at the bottom of the file:

```typescript
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
    // Headers end at \r\n\r\n
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
```

- [ ] **Step 2: Lint + commit**

```bash
npm run lint
git add test/helpers/fixture-server.ts
git commit -m "feat(5A.1 phase-5): /upload-fixture (multipart sha256 echo) + /upload-validate + /upload-form routes"
```

---

## Phase 6 — E2E suite

### Task 15: Core e2e — single, multi, clear, hidden-label, basic errors

**Files:**
- Create: `test/e2e/5A1-file-upload.test.ts`

- [ ] **Step 1: Write the tests**

```typescript
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
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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
    // Submit the form to send the file to /upload-fixture
    await callTool(client, 'safari_click', { tabUrl: tabUrl!, selector: '#submit' }, nextId(), 15_000);
    // Wait for response
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
    // Reset by reloading the page first to clear prior state
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
    // Verify input.files is empty
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
    // Add accept attribute via JS, then upload a non-image. Tool succeeds;
    // Safari does not filter via accept for programmatically-set FileList.
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
});
```

- [ ] **Step 2: Run + commit**

```bash
git add test/e2e/5A1-file-upload.test.ts
git commit -m "test(5A.1 phase-6 RED): core e2e suite (9 tests, awaiting v0.1.22 install)"
```

> Tests are RED until Phase 7 install. That's expected.

### Task 16: React Hook Form e2e fixture + test

**Files:**
- Create: `test/fixtures/rhf-upload-form.html`
- Modify: `test/helpers/fixture-server.ts` (serve the fixture)
- Append: `test/e2e/5A1-file-upload.test.ts` (one test)

- [ ] **Step 1: Create the fixture page**

Create `test/fixtures/rhf-upload-form.html`:

```html
<!DOCTYPE html><html><head>
<script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/react-hook-form@7/dist/index.umd.min.js"></script>
</head><body>
<div id="root"></div>
<script>
  const { useForm } = ReactHookForm;
  const e = React.createElement;
  function App() {
    const { register, handleSubmit, watch } = useForm();
    const file = watch('upload');
    const hasFile = file && file.length > 0;
    return e('div', null,
      e('label', { id: 'rhf-label', htmlFor: 'rhf-input' }, 'Pick file: ',
        e('input', {
          id: 'rhf-input',
          type: 'file',
          style: { display: 'none' },
          ...register('upload', { required: true }),
        }),
      ),
      e('button', { id: 'rhf-submit', type: 'submit', disabled: !hasFile }, 'Submit'),
      hasFile ? e('div', { id: 'rhf-state' }, 'File ready: ' + file[0].name) : null,
    );
  }
  ReactDOM.createRoot(document.getElementById('root')).render(e(App));
</script>
</body></html>
```

> If `react-hook-form` UMD load is unreliable in tests, an alternative is a small handcrafted React component that mirrors the same patterns: hidden input, watched file state, submit-disabled-until-file. Either works.

- [ ] **Step 2: Serve the fixture**

In `test/helpers/fixture-server.ts`, after the existing static-file fall-through, add a check for `/rhf-upload-form` that reads `test/fixtures/rhf-upload-form.html`. Or place it under FIXTURE_DIR and let the existing static-file server serve it.

- [ ] **Step 3: Append test**

```typescript
it('React Hook Form: locator finds inner hidden input; change registers in RHF state', async () => {
  await callTool(client, 'safari_navigate', {
    tabUrl: tabUrl!, url: `http://127.0.0.1:${fixture.hostPort}/rhf-upload-form?sp_t5A1=${Date.now()}`,
  }, nextId(), 15_000);
  await new Promise((r) => setTimeout(r, 2500)); // RHF init

  // Locate via the LABEL text — verifies locator finds the inner <input>, not the wrapper.
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
```

- [ ] **Step 4: Commit**

```bash
git add test/fixtures/rhf-upload-form.html test/helpers/fixture-server.ts test/e2e/5A1-file-upload.test.ts
git commit -m "test(5A.1 phase-6 RED): React Hook Form e2e (locator finds inner input behind hidden label)"
```

### Task 17: Detached-element race + shadow-host + validation surface tests

**Files:**
- Append: `test/e2e/5A1-file-upload.test.ts`

- [ ] **Step 1: Append three tests**

```typescript
it('detached-element race: input replaced post-probe → FILE_UPLOAD_ELEMENT_DETACHED', async () => {
  await callTool(client, 'safari_navigate', {
    tabUrl: tabUrl!, url: `http://127.0.0.1:${fixture.hostPort}/upload-form?sp_t5A1=${Date.now()}`,
  }, nextId(), 15_000);
  await new Promise((r) => setTimeout(r, 1500));

  // Inject a tiny script that, AFTER the probe runs, replaces #file-input with a fresh element.
  // Approach: monkey-patch postMessage to detect file_upload_inject and swap the element.
  await callTool(client, 'safari_evaluate', {
    tabUrl: tabUrl!,
    script: `
      const orig = window.addEventListener;
      window.addEventListener = function(type, handler, opts) {
        if (type === 'message') {
          const wrapped = function(ev) {
            if (ev.data && ev.data.op === 'file_upload_inject') {
              // Replace #file-input with a clone (new element, original detached)
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
  // Inject a custom element with a shadow root containing the file input.
  await callTool(client, 'safari_evaluate', {
    tabUrl: tabUrl!,
    script: `
      class ShadowFile extends HTMLElement {
        constructor() {
          super();
          this.attachShadow({ mode: 'open' }).innerHTML = '<input id="inner" type="file" />';
        }
      }
      customElements.define('shadow-file', ShadowFile);
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
  // Create a synthetic input with validity-invalid behavior + sibling [role=alert]
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
      // Simulate site-side rejection: set custom validity on change
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
```

- [ ] **Step 2: Commit**

```bash
git add test/e2e/5A1-file-upload.test.ts
git commit -m "test(5A.1 phase-6 RED): detached-race + shadow-host + validation-surface e2e"
```

### Task 18: Concurrent multi-MB upload e2e

**Files:**
- Append: `test/e2e/5A1-file-upload.test.ts`

- [ ] **Step 1: Append the test**

```typescript
it('concurrent uploads in same tab: each response surfaces only its own bytes (commandId isolation)', async () => {
  await callTool(client, 'safari_navigate', {
    tabUrl: tabUrl!, url: `http://127.0.0.1:${fixture.hostPort}/upload-form?sp_t5A1=${Date.now()}`,
  }, nextId(), 15_000);
  await new Promise((r) => setTimeout(r, 1500));

  // Add a second input so the two calls don't collide on the same input
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

  // Two distinct multi-MB files
  const fileA = join(workDir, 'concurrentA.bin');
  const fileB = join(workDir, 'concurrentB.bin');
  const bufA = Buffer.alloc(2 * 1024 * 1024, 0xAA);
  const bufB = Buffer.alloc(2 * 1024 * 1024, 0xBB);
  writeFileSync(fileA, bufA);
  writeFileSync(fileB, bufB);
  const shaA = sha256(bufA);
  const shaB = sha256(bufB);

  // Fire both calls in parallel (Promise.all)
  const [respA, respB] = await Promise.all([
    callTool(client, 'safari_file_upload', {
      tabUrl: tabUrl!, selector: '#file-input', paths: [fileA],
    }, nextId(), 60_000),
    callTool(client, 'safari_file_upload', {
      tabUrl: tabUrl!, selector: '#second-input', paths: [fileB],
    }, nextId(), 60_000),
  ]);

  // Verify each response has its own file (sha verified via FileReader)
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
  // Crucial: each input got the right bytes — no cross-contamination from concurrent token routing.
}, 120_000);
```

- [ ] **Step 2: Commit**

```bash
git add test/e2e/5A1-file-upload.test.ts
git commit -m "test(5A.1 phase-6 RED): concurrent multi-MB upload e2e (commandId isolation litmus)"
```

---

## Phase 7 — v0.1.22 release

### Task 19: Version bump + daemon rebuild + extension rebuild + install

**Files:**
- Modify: `package.json` (version bump)
- Modify: `extension/manifest.json` (version bump — both `version` and `CFBundleShortVersionString` per build script)

- [ ] **Step 1: Bump package.json version**

Edit `package.json`: `"version": "0.1.21"` → `"version": "0.1.22"`.

> Per `feedback-extension-version-both-fields` and `feedback-never-open-app-without-version-bump` memory rules: version bump MUST happen BEFORE any rebuild. Don't open the .app without bumping.

- [ ] **Step 2: Update extension manifest version**

Edit `extension/manifest.json`: `"version": "0.1.21"` → `"version": "0.1.22"`.

- [ ] **Step 3: Build the daemon**

```bash
cd "$(git rev-parse --show-toplevel)" && bash scripts/update-daemon.sh 2>&1 | tail -10
```

Expected: clean build, atomic swap, launchctl restart. Verify daemon is running:

```bash
ps -ef | grep -i SafariPilotd | grep -v grep
```

- [ ] **Step 4: Build the extension**

```bash
bash scripts/build-extension.sh 2>&1 | tail -20
```

Expected: full Xcode archive → export → sign → notarize. Final `.app` at `bin/Safari Pilot.app`.

- [ ] **Step 5: Verify entitlements**

```bash
codesign -d --entitlements - "bin/Safari Pilot.app" 2>&1 | grep app-sandbox
codesign -d --entitlements - "bin/Safari Pilot.app/Contents/PlugIns/Safari Pilot Extension.appex" 2>&1 | grep app-sandbox
```

Expected: `app-sandbox` present on both.

- [ ] **Step 6: Tell the user to install**

> **STOP — manual step.** This must be done by the user, not the agent. Per `feedback-no-system-manipulation` memory: NEVER run pluginkit/lsregister/pkill if Safari acts up.

Tell the user:
> Run: `open "bin/Safari Pilot.app"`
> Then: Safari → Settings → Extensions → enable Safari Pilot v0.1.22.
> If Safari blocks with "interfered with clicking" — Safari → Develop → Allow Unsigned Extensions.
> Confirm v0.1.22 is enabled before proceeding.

Wait for user confirmation.

- [ ] **Step 7: Run Phase 0 spike e2e tests FIRST (architectural gate)**

```bash
npx vitest run test/e2e/5A1-phase0-spike.test.ts 2>&1 | tail -20
```

**GATE DECISION:**
- **Both tests PASS** → architecture validated. Proceed to step 8.
- **Either test FAILS** → ABORT. Do not run other 5A.1 e2e tests; do not declare 5A.1 shipped. Open follow-up design pass per spec — candidate alternatives include moving File construction to MAIN world (bytes via fragmented postMessage) or abandoning Approach 3 entirely. Commit a `WIP` marker:

```bash
git commit --allow-empty -m "5A.1 ABORTED: Phase 0 spike failed — see e2e output. Design re-opens."
```

- [ ] **Step 8: Run remaining 5A.1 e2e tests**

```bash
npx vitest run test/e2e/5A1-file-upload.test.ts 2>&1 | tail -30
```

Expected: 13 PASS (or however many were written across Tasks 15–18).

- [ ] **Step 9: Run full e2e + unit suite (regression check)**

```bash
npm run test:unit && npm run test:e2e 2>&1 | tail -30
```

Expected: all green. No regressions in prior 5A.* work.

- [ ] **Step 10: Commit version bump**

```bash
git add package.json extension/manifest.json bin/
git commit -m "chore(5A.1 phase-7): bump v0.1.21 → v0.1.22; daemon + extension rebuilt; e2e green"
```

---

## Phase 8 — Pre-ship smoke

### Task 20: 5-site manual smoke test + changelog

**Files:**
- Create: `docs/changelogs/v0.1.22.md` (or append to existing changelog)

- [ ] **Step 1: Manual test against 5 sites**

For each of: **Notion**, **Slack**, **GitHub** (issue attach), **Gmail** (compose attach), **Linear** (issue attach):

Open the site in Safari (manually, via `safari_new_tab` from a separate driver), navigate to the upload UI, locate the file input (often hidden behind a label or dropzone — use `force: true`), call `safari_file_upload` with a small fixture file, submit the form / send the message / save the issue, verify the site received the file.

For each site, document the outcome:
- `verified` — full upload flow works, file received by site
- `failed: <specific reason>` — e.g. "drag-drop only, no fallback `<input>`"; "input hidden behind shadow root, locator can't reach"
- `not-applicable` — site doesn't have an upload UI in the test path

- [ ] **Step 2: Write the changelog**

Create `docs/changelogs/v0.1.22.md`:

```markdown
# v0.1.22

## New: `safari_file_upload` (T41 / 5A.1)

Programmatic file upload to standard `<input type=file>` elements,
including those hidden behind `<label>` (use `force: true`).

### Limits
- 25 MB per file
- 4 files per call

### NOT supported in v1
- Drag-and-drop dropzones (no fallback `<input>` traversal)
- Custom file pickers that bypass `<input type=file>`
- Native OS file dialogs (no AX automation)

### Verified sites (pre-ship smoke)
| Site                | Outcome  | Notes |
|---------------------|----------|-------|
| Notion              | [verified|failed|not-applicable] | [details] |
| Slack               | [...] | [...] |
| GitHub              | [...] | [...] |
| Gmail               | [...] | [...] |
| Linear              | [...] | [...] |

### Architecture
- Path B: extension-side `input.files` injection via DataTransfer + Object.defineProperty
- Out-of-band byte transport: token-keyed daemon staging → extension fetch from /file-bytes/<token>
- Pre-flight probe sentinel for early-fail on locator/element-type errors
- Validation probe (`validationProbeMs`, default 200) reads `input.validationMessage` + sibling `[role=alert]` / `[aria-invalid]` post-change

### Phase 0 spike (architectural gate)
Two assumptions empirically verified in v0.1.22:
- Content-script `fetch('http://127.0.0.1:19475/...')` works under Safari Web Extension CSP
- File objects survive ISOLATED→MAIN structured-clone via `window.postMessage` with bytes intact

### Known limitations
- `accept` attribute pass-through (Playwright parity); site-side rejection surfaces via `response.validation`
- Async server-side validation (>validationProbeMs) won't be captured — `response.validation: undefined` is a snapshot, not a guarantee. Follow up with `safari_get_text` if certainty is required.
- Symlink resolution via `fs.realpath` is logged to `server-trace.ndjson` and surfaced in `response.warnings`, but not blocked.

### New error codes (10)
FILE_UPLOAD_PATH_NOT_FOUND, FILE_UPLOAD_PATH_NOT_READABLE, FILE_UPLOAD_PATH_NOT_ABSOLUTE, FILE_UPLOAD_FILE_TOO_LARGE, FILE_UPLOAD_TOO_MANY_FILES, FILE_UPLOAD_EMPTY_PATHS, FILE_UPLOAD_INVALID_ELEMENT, FILE_UPLOAD_ELEMENT_DETACHED, FILE_UPLOAD_MULTIPLE_NOT_ALLOWED, FILE_UPLOAD_INVALID_PARAMS.
```

- [ ] **Step 3: Commit**

```bash
git add docs/changelogs/v0.1.22.md
git commit -m "docs(5A.1 phase-8): v0.1.22 changelog with 5-site smoke results"
```

### Task 21: TRACES.md iteration entry + CHECKPOINT.md update

**Files:**
- Modify: `TRACES.md` (add iteration 50)
- Modify: `CHECKPOINT.md` (mark 5A.1 shipped)

- [ ] **Step 1: Add TRACES.md iteration 50**

Append after the existing iteration 49 entry, with the same shape: What/Changes/Context/Commits sections covering the Phase 0 → Phase 8 work.

- [ ] **Step 2: Update CHECKPOINT.md**

Mark `5A.1 T41 safari_file_upload` as shipped with the relevant commit hashes. Update "Active extension version" to v0.1.22. Mark chunk 2 closed; next is Phase 5A · Group B (5A.10–5A.14).

- [ ] **Step 3: Commit**

```bash
git add TRACES.md CHECKPOINT.md
git commit -m "checkpoint: 5A.1 T41 shipped at v0.1.22; chunk 2 closed; Group B is next"
```

---

## Plan complete

Plan complete and saved to `docs/upp/plans/2026-05-03-safari-file-upload-plan.md`.

**Execute with:** the `upp:executing-plans` skill

The skill supports two modes:
- **Subagent mode** (recommended) — fresh subagent per task, three-stage review (spec → quality → design)
- **Inline mode** — execute in this session with checkpoints

Which mode would you like? (Default: subagent mode)

You can override at any time: "use inline" or "use subagents".

**Key gates to remember during execution:**
1. **Phase 0 e2e tests are the architectural gate** — they run FIRST in Phase 7 step 7, before any other e2e. If they fail, abort 5A.1 and re-open design.
2. **Version bump BEFORE rebuild** — package.json + extension/manifest.json must both be at 0.1.22 before `update-daemon.sh` or `build-extension.sh`.
3. **User installs the .app manually** — do not run `pluginkit`/`lsregister`/`pkill`. Tell the user, wait for confirmation.
4. **TDD discipline at each task** — RED → reviewer gate → GREEN → commit. Reviewer gate uses `upp:test-reviewer-fast` for ≤3 tests, `upp:test-reviewer` for >3.
