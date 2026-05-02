# `safari_file_upload` (T41) — Design Spec

**Date:** 2026-05-03
**Tracker:** T41 / Phase 5A · Group A · Chunk 2 item 2 (5A.1)
**Target rebuild checkpoint:** v0.1.22
**Status:** Design approved; awaiting writing-plans handoff.

## Goal

Add `safari_file_upload` to the tool registry so AI agents can attach files to standard `<input type=file>` elements in Safari. Closes a Cluster 1 (file IO) gap on the Playwright-parity matrix. The tool is currently absent — agents fall back to `safari_evaluate` with brittle, framework-fragile DataTransfer hacks.

Out of v1 scope (deferred or rejected): drag-drop dropzones, AX-driven NSOpenPanel automation, custom-picker fallbacks, paths > 25 MB, batches > 4 files.

## Non-goals

- "Make every upload UI work." This is a structurally-incomplete tool; ~60–70% of modern SaaS upload UIs use `<input type=file>` (often hidden behind a styled label) and will work. Drag-drop-only sites with no fallback `<input>` will not, and the tool's MCP description must say so.
- Path security restrictions. The agent (Claude Code) is the trust boundary, not safari-pilot's daemon. Matches Playwright/Selenium baseline.
- File-bytes virus scanning, content-type sniffing, or encoding transcoding. Bytes pass through verbatim.

## Architecture summary

| Layer | Choice |
|---|---|
| Engine | Extension-required (throws `ENGINE_REQUIRED` for daemon/applescript engines, mirroring 5A.9 auth) |
| Element targeting | Existing locator chain (`selector` / `role` / `text` / `label` / `placeholder` / `xpath` / `ref`); post-resolve `tagName === 'INPUT' && type === 'file'` validation |
| Byte transport | **Approach 3 — out-of-band HTTP fetch.** TS reads bytes via Node `fs` → ships to daemon as base64 NDJSON `stage_file` command → daemon stores in TTL-keyed in-memory map → extension `content-isolated.js` fetches `GET http://127.0.0.1:19475/file-bytes/<token>` → constructs `File` objects in extension-permission context → window.postMessage to `content-main.js` (structured-clone preserves Files) → `Object.defineProperty(input, 'files', { value: dt.files })` + `input` + `change` events |
| Pre-flight probe | Lightweight `__SP_FILE_UPLOAD_PROBE__:<json>` sentinel runs locator + element-type validation BEFORE byte staging — saves up to 100MB of wasted IO on a typo'd selector |
| Atomicity | Pre-flight probe + all reads complete before any page-side state mutation. The DataTransfer assignment is a single atomic operation; events fire once. No partial-success state ever exists. |
| Limits | 25 MB per file, 4 files per call. TS handler rejects normatively; daemon `stage_file` enforces defense-in-depth. No quota concern (storage bus carries only metadata). |
| Security model | No path allowlist. Agent trust boundary. Symlinks resolved via `fs.realpath()` and divergence logged to `server-trace.ndjson` for forensic trail (not blocked). |

### Why Approach 3 over Approach 1

The simpler approach — base64 in storage bus sentinel — was rejected on engineering review. Existing `__SP_COOKIE_*__` and `__SP_DNR_*__` sentinels short-circuit inside `background.js` and never traverse `browser.storage.local`, so they provide zero empirical evidence about multi-MB writes. Safari Web Extensions document `storage.local` quota as ~5 MB without `unlimitedStorage`. Adding `unlimitedStorage` to the manifest is a deployment-affecting change (sign + notarize cycle, marketing version bump per `feedback-extension-version-both-fields`, Safari extension cache invalidation for every existing user).

Approach 3 sidesteps the entire question. Storage bus carries ~1 KB metadata regardless of file size; bytes flow over a dedicated HTTP route the extension already speaks (`http://127.0.0.1:19475/poll` and `/result` exist via Hummingbird; adding `/file-bytes/<token>` is one new route). Token-keyed in-memory map with one-shot consumption + 60s TTL cleanup keeps memory bounded.

## Components

| Layer | Path | Lines (est) | Responsibility |
|---|---|---|---|
| TS handler | `src/tools/file-upload.ts` (NEW) | ~250 | Locator validation; `requireExtension()` gate; path expansion (`~` → `os.homedir()`) + relative rejection; pre-flight probe dispatch; pre-flight `fs.realpath` + `fs.stat` + `fs.readFile`; symlink trace event; MIME resolution; `stage_file` NDJSON; final `__SP_FILE_UPLOAD__` sentinel dispatch; response shaping |
| MIME helper | `src/tools/mime.ts` (NEW) | ~120 | Pure `mimeFromExtension(filename: string): { mimeType: string; fallback: boolean }` — ~70 common types, default `application/octet-stream` with fallback flag. Documented coverage policy (web-common types only; agent override is the escape hatch for the long tail) |
| Path util | `src/path-resolve.ts` (NEW) | ~40 | Pure helper: `resolveUploadPath(input)` returns absolute path or typed error; expands `~`, `~/`, rejects relative, computes Levenshtein "did you mean?" hint on ENOENT against the parent directory's siblings |
| Errors | `src/errors.ts` | +30 | Add 7 new error codes + `FileUploadError` subclass(es): `FILE_UPLOAD_PATH_NOT_FOUND` (with `suggestion` field), `FILE_UPLOAD_PATH_NOT_READABLE`, `FILE_UPLOAD_PATH_NOT_ABSOLUTE`, `FILE_UPLOAD_FILE_TOO_LARGE`, `FILE_UPLOAD_TOO_MANY_FILES`, `FILE_UPLOAD_EMPTY_PATHS`, `FILE_UPLOAD_INVALID_ELEMENT`, `FILE_UPLOAD_ELEMENT_DETACHED` |
| Server wiring | `src/server.ts` | +2 | Register `FileUploadTools` in modules array (same shape as `AuthTools`) |
| Daemon command | `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift` | ~80 | New `stage_file` NDJSON case: validates 25MB cap, decodes base64, stores `Data` in `[token: (Data, Date)]` map, schedules 60s TTL cleanup |
| Daemon HTTP route | `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift` | ~40 | Add `GET /file-bytes/<token>` route: looks up token, returns raw bytes with `Content-Type: <stored-mime>`, removes from map (one-shot consumption), 404 on miss/expired |
| Daemon TTL cleanup | `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift` | ~30 | Background timer task — every 30s scans the staging map and evicts entries older than 60s |
| Extension dispatch | `extension/background.js` | ~40 | New sentinel branches: `__SP_FILE_UPLOAD_PROBE__` (forwards to content-isolated for locator probe; tiny payload) and `__SP_FILE_UPLOAD__` (writes `sp_cmd = {op: 'file_upload_stage', ref, files: [{token, name, mimeType}]}` — no bytes) |
| Page injection (isolated) | `extension/content-isolated.js` | ~60 | Reads `sp_cmd` for `file_upload_stage`; for each file → `fetch('http://127.0.0.1:19475/file-bytes/' + token).then(r => r.arrayBuffer())` → `new File([buf], name, {type: mimeType})` → `window.postMessage({op: 'file_upload', ref, files: [File...]})` to content-main |
| Page injection (main) | `extension/content-main.js` | ~80 | Receives postMessage; resolves input via existing locator helpers; `document.contains(input)` check → `FILE_UPLOAD_ELEMENT_DETACHED`; tagName/type re-check; `DataTransfer` build; `Object.defineProperty(input, 'files', { value: dt.files, writable: false, configurable: true })`; dispatches `input` + `change` events with `bubbles: true`; 200ms after change, reads `input.validationMessage` + sibling `[role=alert]`/`[aria-invalid=true]` for the validation field; writes `sp_result` |

**Justification for new file vs extending interaction.ts:** interaction.ts is already 900+ lines covering pointer events / form fills / drag / dialogs. File upload has its own concerns (filesystem IO, base64, multipart fixture, byte transport architecture) that don't belong with pointer-event tools. Same pattern used for 5A.9 `auth.ts`.

## API surface (MCP tool definition)

```ts
{
  name: 'safari_file_upload',
  description:
    'Attach files to an <input type=file> element. ' +
    'Does not support drag-and-drop dropzones, custom file pickers, or native OS file dialogs — ' +
    'only standard file inputs, including those hidden behind a <label>. ' +
    'Locator: same chain as safari_click / safari_fill (selector / role / text / label / placeholder / xpath / ref). ' +
    'Paths must be absolute or ~-prefixed; relative paths are rejected. ' +
    'Limits: 25 MB per file, 4 files per call. ' +
    'On success: dispatches input + change events on the resolved input element. ' +
    "To clear the input's existing files, pass clear: true (passing an empty paths array is rejected with FILE_UPLOAD_EMPTY_PATHS). " +
    'Example: safari_file_upload({ tabUrl, label: "Resume", paths: ["~/Downloads/resume.pdf"] })',
  inputSchema: {
    type: 'object',
    properties: {
      tabUrl: { type: 'string', description: 'Current URL of the tab' },
      // Locator (one required) — schema cross-references safari_click for brevity
      selector: { type: 'string' },
      ref: { type: 'string' },
      role: { type: 'object' },
      text: { type: 'string' },
      label: { type: 'string' },
      placeholder: { type: 'string' },
      xpath: { type: 'string' },
      paths: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        description: '1-4 file paths to attach. Each entry is either a string (path) or {path, mimeType?}. Use clear: true to empty the input instead of passing an empty array.',
        items: {
          oneOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: {
                path: { type: 'string' },
                mimeType: { type: 'string', description: 'Override the inferred Content-Type (default: extension lookup, fallback application/octet-stream)' },
              },
              required: ['path'],
            },
          ],
        },
      },
      clear: { type: 'boolean', description: 'Remove all files currently attached to the input. Mutually exclusive with paths.' },
      timeout: { type: 'number', default: 5000, description: 'Auto-wait for the input element (ms)' },
      force: { type: 'boolean', default: false, description: 'Skip visibility check — common for hidden file inputs behind styled labels' },
    },
    required: ['tabUrl'],
    // exactly one of: paths, clear (with truthy value); validated in handler
  },
  requirements: { idempotent: false },
}
```

### Response shape

```ts
{
  uploaded: number,                      // file count installed (0 for clear)
  files: [
    {
      name: string,
      size: number,
      mimeType: string,
      path: string,                      // resolved absolute path (post ~-expansion, post realpath)
      mimeFallback?: true,               // present when MIME defaulted to octet-stream
    },
  ],
  cleared?: true,                        // present when clear: true was used
  validation?: {                         // populated only when site flagged a problem
    message?: string,                    // input.validationMessage at +200ms
    alerts?: string[],                   // textContent of nearby [role=alert] / [aria-invalid=true]
  },
  warnings?: string[],                   // e.g., 'symlink resolved: /tmp/link.pdf -> /home/user/real.pdf'
}
```

### Error codes

| Code | When | Response field |
|---|---|---|
| `ENGINE_REQUIRED` | Extension engine unavailable | (existing) |
| `FILE_UPLOAD_EMPTY_PATHS` | `paths.length === 0` and `clear !== true` | `hint: 'use clear: true to clear the input'` |
| `FILE_UPLOAD_TOO_MANY_FILES` | `paths.length > 4` | `hint: 'v1 limit. To upload more, call multiple times — note that subsequent calls REPLACE the FileList, not append.'` |
| `FILE_UPLOAD_PATH_NOT_ABSOLUTE` | Relative path passed | `hint: 'use absolute path or ~/...'` |
| `FILE_UPLOAD_PATH_NOT_FOUND` | `fs.stat` ENOENT | `path`, optional `suggestion: 'did you mean: <levenshtein-closest>?'` |
| `FILE_UPLOAD_PATH_NOT_READABLE` | EACCES / EISDIR | `path` |
| `FILE_UPLOAD_FILE_TOO_LARGE` | `stat.size > 25 * 1024 * 1024` | `path`, `size`, `cap: 26_214_400` |
| `FILE_UPLOAD_INVALID_ELEMENT` | Locator resolved, but not `<input type=file>` | `tagName`, `type` |
| `FILE_UPLOAD_ELEMENT_DETACHED` | `document.contains(input) === false` between probe and inject | `ref` |

## Data flow (full path, top-to-bottom)

```
1. agent → MCP safari_file_upload(tabUrl, ref, paths)
   ↓
2. TS handler (file-upload.ts):
   a. requireExtension() — throw ENGINE_REQUIRED if engine !== 'extension'
   b. Mutual-exclusion validation: exactly one of {paths, clear=true} required
   c. paths.length 1..4 validation
   d. For each path: resolveUploadPath() — expand ~, reject relative, fs.realpath
      Symlink divergence: trace event 'file_upload_path_resolved' to server-trace.ndjson
   ↓
3. TS handler: PROBE — engine.executeJsInTab(tabUrl,
      '__SP_FILE_UPLOAD_PROBE__:' + JSON.stringify({ref, ...locatorParams})
   )
   Probe sentinel runs in extension; locates element + validates tagName/type
   Returns {ok: true, frameId?, isFileInput, multiple, accept} or typed error
   ↓
4. TS handler: pre-flight reads (only if probe ok and paths !== empty)
   For each path: fs.stat → reject if size > 25MB (FILE_UPLOAD_FILE_TOO_LARGE)
                  fs.readFile → bytes
                  resolve MIME (agent override OR mimeFromExtension)
   Any failure: throw typed error, NO bytes shipped to daemon
   ↓
5. TS handler: stage each file via NDJSON to daemon
   stage_file: { token: <random-uuid>, mimeType, bytesB64 }
   Daemon stores in [token: (Data, Date)] map
   ↓
6. TS handler: dispatch sentinel
   '__SP_FILE_UPLOAD__:' + JSON.stringify({
     ref, tokens: [{token, name, mimeType, mimeFallback?}, ...]
   })
   Storage bus payload: ~1 KB
   ↓
7. Daemon → /poll → extension picks up sentinel
   ↓
8. background.js: parse sentinel, write storage.local sp_cmd = {
     op: 'file_upload_stage',
     ref, tokens: [{token, name, mimeType, mimeFallback?}, ...]
   }
   ↓
9. content-isolated.js: storage.onChanged → reads sp_cmd
   For each token: fetch('http://127.0.0.1:19475/file-bytes/' + token)
                   → arrayBuffer()
                   → new File([buf], name, { type: mimeType })
   ↓
10. content-isolated.js: window.postMessage to content-main:
    { op: 'file_upload', ref, files: [File, File, ...] }
    Structured-clone preserves File objects across worlds.
    ↓
11. content-main.js:
    a. resolve input via locator helpers (probe verified ~50ms ago)
    b. document.contains(input) check → throw FILE_UPLOAD_ELEMENT_DETACHED if false
    c. tagName/type re-check (paranoia in case of probe-vs-inject divergence)
    d. dt = new DataTransfer(); for each File: dt.items.add(file)
    e. Object.defineProperty(input, 'files', {
         value: dt.files, writable: false, configurable: true
       })
    f. input.dispatchEvent(new Event('input', {bubbles: true}))
       input.dispatchEvent(new Event('change', {bubbles: true}))
    g. setTimeout(200ms): probe input.validationMessage + sibling
       [role=alert] / [aria-invalid=true] textContent
    h. write sp_result: { uploaded, files, validation? }
    ↓
12. Result flows back via existing sp_result → background.js → daemon /result → MCP response
    ↓
13. Daemon: tokens consumed by /file-bytes fetch (one-shot); 60s TTL evicts unused
```

### Clear-path variant

`paths: undefined, clear: true` skips steps 4–9: TS handler dispatches `__SP_FILE_UPLOAD__:{ref, tokens: [], clear: true}`; content-main.js builds an empty `DataTransfer`, assigns, fires events. Symmetric path; ~50% the LOC inside content-main.

## Security model

**Stance:** No filesystem allowlist. Agent (Claude Code) is the trust boundary. Matches Playwright/Selenium baseline. The user has accepted this risk explicitly during brainstorming.

**Risks documented:**

1. **Path-based exfiltration.** Agent can request upload of any file the user has read access to. If the agent is compromised or coerced, it can upload `/Users/me/Documents/private.pdf` to `attacker.com`. Mitigation: agent operates under Claude Code's filesystem permissions; user reviews tool calls. This is the same risk profile as `read_file` in any agent toolchain.

2. **Symlink-aided exfiltration.** `fs.readFile` follows symlinks. An agent passes `/tmp/innocent.txt` symlinked to `/etc/passwd`. Mitigation: `fs.realpath()` resolves before read; if resolved path differs from input, log to `server-trace.ndjson` event `file_upload_path_resolved` with `{input, resolved, divergent: true}`. Forensic trail without restriction.

3. **Token-bytes-in-memory exposure.** Daemon holds bytes in memory between `stage_file` and the extension's `/file-bytes/<token>` fetch. Window: typically <100ms; bounded by 60s TTL. 127.0.0.1-bound; Hummingbird does not expose externally. Token is a 32-byte cryptographically-random UUID — unguessable. One-shot consumption (token deleted on first fetch).

4. **Concurrent multi-MB upload memory pressure.** Daemon's staging map is unbounded; a hostile or buggy agent could stage many large files. Mitigation: cap-per-call (4 × 25MB = 100MB) is small; map cleanup runs every 30s; out-of-memory is the system's job. We do NOT add a global staging limit in v1.

## Test strategy

### Unit tests

| File | Coverage | Approx. count |
|---|---|---|
| `test/unit/tools/mime.test.ts` | `mimeFromExtension` pure helper: known extensions, case-insensitivity, fallback flag, no-extension files, dotfiles | ~8 |
| `test/unit/tools/path-resolve.test.ts` | `resolveUploadPath` pure helper: `~/foo` expansion, relative rejection, absolute pass-through, ENOENT with Levenshtein suggestion (real fs in tmpdir) | ~10 |
| `test/unit/tools/file-upload-dispatch.test.ts` | Recording-engine dispatch boundary: probe sentinel content, stage_file count + payload structure, final sentinel content, engine-required gate, paths/clear mutual exclusion, paths-too-many gate, ENOENT pre-flight, size-too-large pre-flight, token threading, locator threading, response shape (uploaded, files, mimeFallback, validation, warnings) | ~18 |
| `test/unit/daemon/file-stage-ttl.test.ts` (Swift) | Daemon `stage_file` map: store + retrieve + one-shot consumption + 60s TTL eviction. Existing Swift test infrastructure pattern (per `daemon/Tests/`). | ~6 |

**Pure helpers** (no engine, no Safari):

- `mimeFromExtension(filename) → {mimeType, fallback}` — testable
- `resolveUploadPath(input) → {ok, absolute, warnings} | typed error` — testable
- `validateFileUploadParams(params)` — pure shape validation (mutual exclusion, length bounds)

### E2E tests

| Test | What it pins |
|---|---|
| Single PNG upload via vanilla `<input type=file>` | Fixture echoes `{name, size, sha256}` matching local file (proves byte fidelity through the whole pipe) |
| Multi-file (3 different MIMEs: .png, .pdf, .csv) | All 3 echoed with correct sha256 |
| `clear: true` on input with prior file | `input.files.length === 0` after call; response includes `cleared: true` |
| `paths: []` → throws `FILE_UPLOAD_EMPTY_PATHS` with hint | (litmus for the divergence-from-Playwright UX choice) |
| Hidden input behind styled `<label>` (force: true) | Upload succeeds without throwing on visibility |
| **React Hook Form fixture page** | MUI-style wrapper pattern; locator finds inner `<input type=file>` not wrapper; `change` event registers in RHF state; submit button enables |
| Detached-element race | Mount input → microtask-replace via React state → upload → asserts `FILE_UPLOAD_ELEMENT_DETACHED` |
| Wrong-element-type (selector matches `<button>`) | Throws `FILE_UPLOAD_INVALID_ELEMENT` |
| Shadow-host failure mode | Locator resolves to shadow host → `FILE_UPLOAD_INVALID_ELEMENT` not silent no-op |
| Validation surface (oversized client-side rejection) | Site's client-side check rejects → response.validation.message populated within 200ms |
| Concurrent multi-MB uploads in same tab | Two simultaneous calls; commandId-keyed isolation holds; both succeed |
| `accept` attribute behavior | Document Safari's behavior (does it filter by MIME or pass through) |

### Pre-ship smoke test (manual, NOT automated)

Before declaring 5A.1 done, manually verify against five real production sites and document the verified-sites list in the v0.1.22 changelog:

- Notion (file uploads in pages)
- Slack (file attach in message composer)
- GitHub (issue/PR attachments via drag-drop dropzone with hidden `<input>`)
- Gmail (attachment in compose window)
- Linear (attachment in issue creation)

If any fail, document the failure mode in the changelog ("does not work on Linear because…"). The MCP tool description is updated honestly: do not promise "drag-drop sites work" — promise "standard file inputs work, including those hidden behind labels on [verified-list]."

### Test fixture

`test/helpers/fixture-server.ts` — new `/upload-fixture` route accepts `POST multipart/form-data`, parses each part with a small home-rolled multipart parser (no new deps; the project has zero deps beyond `@modelcontextprotocol/sdk`). Responds JSON `{ files: [{ name, size, mimeType, sha256 }] }`. The sha256 is the litmus for byte fidelity end-to-end.

A second route `/upload-validate` returns 400 with `aria-invalid="true"` on any input named `tooLarge` to exercise the validation field.

## Migration / rollout

- **One rebuild checkpoint:** v0.1.22 ships ALL of the above. Daemon Swift changes (`stage_file` + `/file-bytes/<token>` + TTL cleanup) require build via `bash scripts/update-daemon.sh`. Extension changes (`background.js` + `content-isolated.js` + `content-main.js`) require build via `bash scripts/build-extension.sh`. Both per the existing distribution-builds memory rule.
- **Version bump first** per `feedback-extension-version-both-fields`: package.json 0.1.21 → 0.1.22 BEFORE any rebuild.
- **No `unlimitedStorage` permission added** — Approach 3 makes it unnecessary. Manifest unchanged for permissions.

## Implementation phasing

The plan from writing-plans should sequence roughly:

1. **TS-only foundations** (no rebuild): pure helpers (`mime.ts`, `path-resolve.ts`, validation) + their unit tests + reviewer gate × 2.
2. **TS dispatch handler**: `file-upload.ts` with recording-engine dispatch tests. RED → reviewer gate → GREEN.
3. **Errors + server wiring**: error codes, `FileUploadError` subclass, `server.ts` registration. Trivial.
4. **Daemon Swift**: `stage_file` command + `/file-bytes/<token>` HTTP route + TTL cleanup + Swift unit tests. Build via `update-daemon.sh`.
5. **Extension JS** (the rebuild-bearing piece): `background.js` sentinel branches, `content-isolated.js` byte fetch + File construction, `content-main.js` injection + validation probe. Single rebuild via `build-extension.sh`.
6. **Fixture endpoint**: `/upload-fixture` + `/upload-validate` routes.
7. **e2e suite**: 12 tests above.
8. **v0.1.22 release**: package.json bump → daemon rebuild → extension rebuild → user installs → e2e validation.
9. **Pre-ship smoke**: 5-site manual test → changelog verified-sites list.

## Open questions (resolved during brainstorm)

- ~~Architecture: extension injection vs AX vs hybrid?~~ → Extension injection only (v1).
- ~~File source: paths vs inline bytes?~~ → Filesystem paths.
- ~~Security model?~~ → No restriction, Playwright parity, symlink trace.
- ~~Element targeting?~~ → Full locator suite + post-resolve type validation.
- ~~Limits?~~ → 25 MB × 4 (raised from 10 MB after switching to Approach 3).
- ~~MIME strategy?~~ → Extension lookup + agent override + mimeFallback signal.
- ~~Multi-file atomicity?~~ → Pre-flight all reads, fail whole call.
- ~~Test fixture?~~ → Multipart sha256-echo endpoint + validation route.
- ~~Empty paths semantics?~~ → Reject; `clear: true` for explicit clearing.
- ~~Path semantics?~~ → Expand `~`, accept absolute, reject relative.
- ~~Wire encoding?~~ → Approach 3 (out-of-band HTTP fetch from extension).
- ~~Pre-flight reordering?~~ → Probe sentinel before byte staging.
- ~~Detached-element race?~~ → `document.contains` check + new error code.
- ~~Validation surface?~~ → 200ms post-change probe of `validationMessage` + sibling alerts.

## Acceptance criteria

This spec is implemented when:

1. All unit tests pass (counts above are minimums; reviewer gates may add more)
2. All e2e tests pass against a v0.1.22 release-mode build
3. The 5-site pre-ship smoke is documented in the v0.1.22 changelog
4. The MCP tool description text is verified by reading `tools/list` output from a fresh agent session — could the agent write a correct call from the description alone? (Per the product reviewer's "30-second discovery sanity check.")
5. Both reviewer agents (engineering + product) sign off on the writing-plans artifact at plan-review time
6. CHECKPOINT.md is updated marking 5A.1 shipped
7. TRACES.md iteration entry covers the chunk

## References

- Tracker entry: `docs/TRACKER.md` row T41
- Roadmap: `docs/ROADMAP.md` row 5A.1 (Phase 5A · Group A)
- Architectural baseline: `ARCHITECTURE.md` (three-tier engine model, sentinel pattern, storage bus IPC)
- Sibling features (5A.8 / 5A.9): `src/tools/storage.ts`, `src/tools/auth.ts` (closest patterns)
- Existing extension flow: `extension/background.js` `executeCommand`, `extension/content-isolated.js` `sp_cmd` reader, `extension/content-main.js` framework-aware setters (`fillReact` etc.)
- `feedback-extension-version-both-fields` memory: bump package.json BEFORE rebuild
- `feedback-distribution-builds` memory: source changes mandate full rebuild + sign + notarize
- `feedback-e2e-means-e2e` memory: zero mocks in `test/e2e/`
