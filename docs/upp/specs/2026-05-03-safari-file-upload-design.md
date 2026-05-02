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
| Errors | `src/errors.ts` | +35 | Add **9 new error codes** + `FileUploadError` subclass(es): `FILE_UPLOAD_PATH_NOT_FOUND` (with `suggestion` field), `FILE_UPLOAD_PATH_NOT_READABLE`, `FILE_UPLOAD_PATH_NOT_ABSOLUTE`, `FILE_UPLOAD_FILE_TOO_LARGE`, `FILE_UPLOAD_TOO_MANY_FILES`, `FILE_UPLOAD_EMPTY_PATHS`, `FILE_UPLOAD_INVALID_ELEMENT`, `FILE_UPLOAD_ELEMENT_DETACHED`, `FILE_UPLOAD_MULTIPLE_NOT_ALLOWED`. Implemented in **Phase 1** (TS-only foundations) so handler code in Phase 2 can throw them. |
| Server wiring | `src/server.ts` | +2 | Register `FileUploadTools` in modules array (same shape as `AuthTools`) |
| Daemon command | `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift` | ~80 | New `stage_file` NDJSON case (Swift signatures below); validates 25MB cap, decodes base64, stores `Data` in `[token: StagedFile]` map, schedules 60s TTL cleanup |
| Daemon HTTP route | `daemon/Sources/SafariPilotdCore/ExtensionHTTPServer.swift` | ~40 | Add `GET /file-bytes/<token>` route. Returns raw bytes with `Content-Type: <stored-mime>`. **Token consumption rule:** entry deleted from staging map ONLY after extension's `r.arrayBuffer()` resolves successfully (signaled by a follow-up `DELETE /file-bytes/<token>` from the extension). 404 on miss/expired. Failure of the GET leaves the entry in the map for retry until TTL eviction. |
| Daemon TTL cleanup | `daemon/Sources/SafariPilotdCore/CommandDispatcher.swift` | ~30 | Background `Task` running every 30s; scans staging map and evicts entries with `expiresAt < .now`. Started from `SafariPilotd.start()`, not lazy on first stage. Map protected by Swift `actor` for thread safety with Hummingbird async/await. |
| Extension dispatch | `extension/background.js` | ~50 | New sentinel branches: `__SP_FILE_UPLOAD_PROBE__` (small payload — locator probe via storage bus) and `__SP_FILE_UPLOAD__` (writes `sp_cmd = {op: 'file_upload_stage', ref, tokens: [{token, name, mimeType, mimeFallback?}], probeOpts: {force, timeout, validationProbeMs}}` — no bytes) |
| Page injection (isolated) | `extension/content-isolated.js` | ~80 | Reads `sp_cmd` for `file_upload_stage`. For each token: `fetch('http://127.0.0.1:19475/file-bytes/' + token).then(r => r.arrayBuffer())` → `new File([buf], name, {type: mimeType})` → on all-resolve, `fetch(url, {method: 'DELETE'})` per token to release daemon memory → `window.postMessage({op: 'file_upload', ref, files: [File...], probeOpts}, '*')` to content-main. On any fetch failure: postMessage with typed error, no DELETE (lets daemon retain bytes for retry until TTL). |
| Page injection (main) | `extension/content-main.js` | ~110 | Receives postMessage; resolves input via existing locator helpers (respecting `force` to skip visibility check); `document.contains(input)` check → `FILE_UPLOAD_ELEMENT_DETACHED`; tagName/type re-check; `multiple` attribute check vs files.length → `FILE_UPLOAD_MULTIPLE_NOT_ALLOWED` if `!input.multiple && files.length > 1`; `DataTransfer` build; `Object.defineProperty(input, 'files', { value: dt.files, writable: false, configurable: true })`; dispatches `input` + `change` events with `bubbles: true`; runs **validation probe** (see "Validation field contract" below); writes `sp_result`. |

**Justification for new file vs extending interaction.ts:** interaction.ts is already 900+ lines covering pointer events / form fills / drag / dialogs. File upload has its own concerns (filesystem IO, base64, multipart fixture, byte transport architecture) that don't belong with pointer-event tools. Same pattern used for 5A.9 `auth.ts`.

### Daemon Swift signatures (informative; firmed up during implementation)

```swift
// CommandDispatcher.swift — new NDJSON command case
struct StageFileRequest: Codable {
  let cmd: String       // "stage_file"
  let token: String     // 64-char hex (32 random bytes)
  let mimeType: String
  let bytesB64: String
}

struct StageFileResponse: Codable {
  let staged: Bool      // true on success
  let token: String
}

// Staging store
struct StagedFile {
  let bytes: Data
  let mimeType: String
  let expiresAt: Date   // = .now + 60s
}

actor FileStagingStore {
  private var entries: [String: StagedFile] = [:]
  func stage(_ token: String, _ file: StagedFile) { entries[token] = file }
  func consume(_ token: String) -> StagedFile? { return entries[token] }  // peek; DELETE removes
  func release(_ token: String) { entries.removeValue(forKey: token) }
  func evictExpired(now: Date) -> Int {
    let beforeCount = entries.count
    entries = entries.filter { $0.value.expiresAt > now }
    return beforeCount - entries.count
  }
}

// ExtensionHTTPServer.swift — two new Hummingbird routes
// GET /file-bytes/<token>: peek bytes, return; do NOT remove from store
// DELETE /file-bytes/<token>: explicit release after extension confirms success

// SafariPilotd.start() — kick off TTL cleanup
Task {
  while !Task.isCancelled {
    try? await Task.sleep(for: .seconds(30))
    let evicted = await stagingStore.evictExpired(now: .now)
    if evicted > 0 { logger.info("file-stage: evicted \(evicted) expired tokens") }
  }
}
```

Token format: `crypto.randomBytes(32).toString('hex')` from TS — 64 hex chars; cryptographically unguessable. Daemon stores under that exact string; URL path `/file-bytes/<64-hex>` validated by route regex.

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
    'On success: dispatches input + change events on the resolved input element, then probes for client-side validation errors. ' +
    "Check `response.validation` to detect site-side rejection (wrong file type, oversized per site rules, etc.) — a successful tool call does NOT guarantee the site accepted the file. " +
    "To clear the input's existing files, pass clear: true (passing an empty paths array is rejected with FILE_UPLOAD_EMPTY_PATHS). " +
    'Override MIME type via the parallel mimeOverrides map: `paths: ["~/foo.bin"], mimeOverrides: {"~/foo.bin": "application/x-custom"}`. ' +
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
        items: { type: 'string' },
        description: '1-4 file paths (absolute or ~-prefixed). Use clear: true to empty the input instead of passing an empty array.',
      },
      mimeOverrides: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Optional path → MIME type map. Keys must exactly match entries in `paths`. Default is extension lookup → application/octet-stream fallback (signaled per-file in response.files[].mimeFallback).',
      },
      clear: { type: 'boolean', description: 'Remove all files currently attached to the input. Mutually exclusive with paths.' },
      timeout: { type: 'number', default: 5000, description: 'Auto-wait for the input element resolution (ms). Applies to step 3 probe.' },
      force: { type: 'boolean', default: false, description: 'Skip visibility check — common for hidden file inputs behind styled labels.' },
      validationProbeMs: { type: 'number', default: 200, minimum: 0, maximum: 2000, description: 'Delay after change event before probing for client-side validation errors. 0 disables probing.' },
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
  validation?: {                         // populated only when probe found a problem
    message?: string,                    // input.validationMessage (raw browser-localized string)
    alerts?: string[],                   // textContent of [role=alert] / [aria-invalid=true] within probe scope
    probedAtMs: number,                  // actual probe delay; agents must NOT trust validation:undefined as "all good" if probedAtMs is short
  },
}
```

**Removed from earlier draft (per Product M2/M3 review):**
- `cleared: true` — redundant; agent already knows `clear: true` was passed and call succeeded.
- `warnings[]` — no agent contract. Symlink resolution events go to `server-trace.ndjson` for forensic use; the resolved path is already in `files[].path`.

### Validation field contract

Probed page-side immediately after `change` event dispatch. The contract:

| Aspect | Decision |
|---|---|
| **Scope** | The closest ancestor `<form>` of the resolved input. Within that form, collect all elements matching `[role=alert]`, `[aria-invalid=true]`, or `[aria-errormessage]` references. Falls back to immediate-DOM-parent + sibling search if no `<form>` ancestor exists. This handles MUI/RHF wrapper patterns where the alert is the input's *uncle* rather than literal sibling. |
| **Timing** | Single probe at `+validationProbeMs` (default 200, configurable 0–2000) after the `change` event. NOT a polling loop; sites with async validation (>2s) won't be captured. Agents must not trust `validation: undefined` as "site accepted" — `probedAtMs` is in the response so callers know how stale the read is. |
| **Locale** | `input.validationMessage` is the browser's localized string (e.g., `"Veuillez sélectionner un fichier."` on French Safari). Returned as raw string; agents must not regex-match content. Treat as forensic evidence only. |
| **Length cap** | Max 3 alerts. Each alert's `textContent` truncated to 500 chars with `…` suffix on overflow. Prevents a 50KB collapsed-error-tree from ballooning the response. |
| **Empty result** | If both `validationMessage` is empty AND no alerts found, `validation` is omitted from the response (NOT `validation: {}`). |

### Error codes (9 new)

| Code | When | Response field + hint |
|---|---|---|
| `ENGINE_REQUIRED` | Extension engine unavailable | (existing — unchanged) |
| `FILE_UPLOAD_EMPTY_PATHS` | `paths.length === 0` and `clear !== true` | `hint: 'pass clear: true to clear the input'` |
| `FILE_UPLOAD_TOO_MANY_FILES` | `paths.length > 4` | `hint: 'v1 limit. To upload more, call multiple times — note that subsequent calls REPLACE the FileList, not append.'` |
| `FILE_UPLOAD_PATH_NOT_ABSOLUTE` | Relative path passed | `hint: 'use absolute path or ~/...'` |
| `FILE_UPLOAD_PATH_NOT_FOUND` | `fs.stat` ENOENT | `path`, optional `suggestion: 'did you mean: <levenshtein-closest>?'` (stretch goal — drop if implementation cost > 30 lines) |
| `FILE_UPLOAD_PATH_NOT_READABLE` | EACCES / EISDIR / NUL byte in path | `path` |
| `FILE_UPLOAD_FILE_TOO_LARGE` | `stat.size > 25 * 1024 * 1024` OR post-read TOCTOU re-check | `path`, `size`, `cap: 26_214_400`, `hint: 'v1 cap is 25 MB. For larger files, upload via a custom site mechanism (e.g., a direct API call from the agent).'` |
| `FILE_UPLOAD_INVALID_ELEMENT` | Locator resolved but element is not `<input type=file>` | `tagName`, `type`, `hint: 'safari_file_upload only operates on <input type=file>. If the page uses a custom picker, look for the hidden <input> sibling — usually inside the same <label>. Try locating by the label text.'` |
| `FILE_UPLOAD_ELEMENT_DETACHED` | `document.contains(input) === false` between probe and inject | `ref`, `hint: 'page re-rendered between probe and inject. Retry the call.'` |
| `FILE_UPLOAD_MULTIPLE_NOT_ALLOWED` | `paths.length > 1` AND resolved input has `multiple === false` | `hint: 'input does not have the multiple attribute. Pass exactly 1 path.'` |

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
      File names with NUL bytes rejected via Node fs error → FILE_UPLOAD_PATH_NOT_READABLE
   ↓
3. TS handler: PROBE — engine.executeJsInTab(tabUrl,
      '__SP_FILE_UPLOAD_PROBE__:' + JSON.stringify({
        ref, locator, force, timeoutMs: timeout
      })
   )
   Probe sentinel auto-waits up to `timeout` for element resolution (respects
   `force` to skip visibility check). Returns {ok: true, frameId?, isFileInput,
   multiple, accept} or typed error.
   - paths.length > 1 AND multiple === false → throw FILE_UPLOAD_MULTIPLE_NOT_ALLOWED
   - The `accept` attribute is read but NOT enforced TS-side. Pass-through
     matches Playwright behavior; site-side rejection (if any) surfaces via
     the validation field at step 11g.
   ↓
4. TS handler: pre-flight reads (only if probe ok and clear !== true)
   For each path:
     a. fs.stat → reject if size > 25 MB (FILE_UPLOAD_FILE_TOO_LARGE)
     b. fs.readFile → bytes
     c. **TOCTOU re-check**: if buffer.byteLength > 25 * 1024 * 1024 → throw
        FILE_UPLOAD_FILE_TOO_LARGE (file grew between stat and read)
     d. resolve MIME: mimeOverrides[path] OR mimeFromExtension(name) OR
        'application/octet-stream' with mimeFallback: true
   File names are passed through as UTF-8 (e.g., '简历.pdf'); no transcoding.
   Any failure: throw typed error, NO bytes shipped to daemon.
   ↓
5. TS handler: stage each file via NDJSON to daemon
   stage_file: { token: <64-hex-string>, mimeType, bytesB64 }
   Daemon stores in actor-protected [token: StagedFile] map with
   expiresAt = now + 60s
   ↓
6. TS handler: dispatch sentinel
   '__SP_FILE_UPLOAD__:' + JSON.stringify({
     ref, locator, tokens: [{token, name, mimeType, mimeFallback?}, ...],
     probeOpts: { force, validationProbeMs }
   })
   Storage bus payload: ~1 KB regardless of file size.
   ↓
7. Daemon → /poll → extension picks up sentinel
   ↓
8. background.js: parse sentinel, write storage.local sp_cmd
   ↓
9. content-isolated.js: storage.onChanged → reads sp_cmd
   For each token: fetch('http://127.0.0.1:19475/file-bytes/' + token)
                   → arrayBuffer()
                   → new File([buf], name, { type: mimeType })
   On all-resolve: fetch(url, {method: 'DELETE'}) per token → daemon releases bytes.
   On any fetch error: postMessage typed error to content-main; daemon
   retains bytes for retry (TTL eviction at 60s if no retry comes).
   ↓
10. content-isolated.js: window.postMessage to content-main:
    { op: 'file_upload', ref, files: [File, File, ...], probeOpts }
    Structured-clone preserves File objects across worlds (verified Phase 0).
    ↓
11. content-main.js:
    a. resolve input via locator helpers (probe verified ~50ms ago); respects `force`
    b. document.contains(input) check → throw FILE_UPLOAD_ELEMENT_DETACHED if false
    c. tagName/type re-check (paranoia in case of probe-vs-inject divergence)
    d. multiple-attr re-check (probe-vs-inject divergence) → MULTIPLE_NOT_ALLOWED
    e. dt = new DataTransfer(); for each File: dt.items.add(file)
    f. Object.defineProperty(input, 'files', {
         value: dt.files, writable: false, configurable: true
       })
    g. input.dispatchEvent(new Event('input', {bubbles: true}))
       input.dispatchEvent(new Event('change', {bubbles: true}))
    h. **Validation probe** at +probeOpts.validationProbeMs (default 200, 0 disables):
       - Collect input.validationMessage (raw localized string)
       - Find scope: closest <form> ancestor, or fallback to immediate parent
       - Within scope: query [role=alert], [aria-invalid=true],
         and elements referenced by input[aria-errormessage]
       - Truncate per-alert textContent to 500 chars; cap to 3 alerts
       - If both message empty and no alerts: omit validation from response
    i. write sp_result: { uploaded, files, validation? }
    ↓
12. Result flows back via existing sp_result → background.js → daemon /result → MCP response
    ↓
13. Daemon: tokens released by extension's DELETE on success;
    unreleased tokens TTL-evicted after 60s (e.g., extension fetch failed
    or page closed mid-flow).
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

### Unit tests (~42 total)

| File | Coverage | Approx. count |
|---|---|---|
| `test/unit/tools/mime.test.ts` | `mimeFromExtension` pure helper: known extensions, case-insensitivity, fallback flag, no-extension files, dotfiles | ~8 |
| `test/unit/tools/path-resolve.test.ts` | `resolveUploadPath` pure helper: `~/foo` expansion, relative rejection, absolute pass-through, ENOENT, NUL byte rejection. Levenshtein suggestion test only if implemented (stretch). Real fs in tmpdir. | ~10 |
| `test/unit/tools/file-upload-dispatch.test.ts` | Recording-engine dispatch boundary: probe sentinel content, stage_file count + payload structure, final sentinel content, engine-required gate, paths/clear mutual exclusion, paths-too-many gate, ENOENT pre-flight, size-too-large pre-flight, TOCTOU re-check, token threading, locator threading, mimeOverrides honored, validationProbeMs threading, response shape (uploaded, files, mimeFallback, validation) | ~18 |
| `test/unit/daemon/file-stage-ttl.test.ts` (Swift) | `FileStagingStore` actor: stage + peek-on-GET + release-on-DELETE + 60s TTL eviction + concurrent stage from multiple tasks (actor isolation). Existing Swift test infrastructure pattern. | ~6 |

**Pure helpers** (no engine, no Safari):

- `mimeFromExtension(filename) → {mimeType, fallback}` — testable
- `resolveUploadPath(input) → {ok, absolute, warnings} | typed error` — testable
- `validateFileUploadParams(params)` — pure shape validation (mutual exclusion, length bounds)

### E2E tests (13 total)

| Test | What it pins |
|---|---|
| Single PNG upload via vanilla `<input type=file>` | Fixture echoes `{name, size, sha256}` matching local file (proves byte fidelity through the whole pipe) |
| Multi-file (3 different MIMEs: .png, .pdf, .csv) | All 3 echoed with correct sha256 |
| `clear: true` on input with prior file | `input.files.length === 0` after call; `response.uploaded === 0` |
| `paths: []` → throws `FILE_UPLOAD_EMPTY_PATHS` with hint | Litmus for the divergence-from-Playwright UX choice |
| Hidden input behind styled `<label>` (force: true) | Upload succeeds without throwing on visibility |
| **React Hook Form fixture page** | MUI-style wrapper pattern; locator finds inner `<input type=file>` not wrapper; `change` event registers in RHF state; submit button enables |
| Detached-element race | Mount input → microtask-replace via React state → upload → asserts `FILE_UPLOAD_ELEMENT_DETACHED` |
| Wrong-element-type (selector matches `<button>`) | Throws `FILE_UPLOAD_INVALID_ELEMENT` |
| Shadow-host failure mode | Locator resolves to shadow host → `FILE_UPLOAD_INVALID_ELEMENT` not silent no-op |
| Validation surface (`/upload-validate` returns 400 + aria-invalid) | `response.validation.message` populated; `response.validation.alerts` includes the textContent within 500-char cap; `validation.probedAtMs === 200` |
| `multiple === false` + 2 paths | Throws `FILE_UPLOAD_MULTIPLE_NOT_ALLOWED` pre-flight |
| `accept="image/*"` + .pdf upload | Concrete assertion: tool succeeds, response includes file regardless; **Safari does NOT filter via `accept` for programmatically-set FileList** (verified via Playwright behavior + spec). Site-side rejection (if any) appears in `validation` field. |
| Concurrent multi-MB uploads in same tab | Two simultaneous calls with distinct files (sha256 A and B); each response's `files[].sha256` matches its own input bytes; neither response surfaces the other's bytes (proves commandId-keyed isolation). |

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

### Phase 0: Architecture spike (GATING — must pass before Phase 4–5 commit)

Two technical assumptions Approach 3 depends on are **not verified in any existing 5A.* code**. Phase 0 is a small disposable test that proves both before we commit to ~770 LOC of implementation. If either fails, architecture re-opens.

**Assumption 1: content-script `fetch('http://127.0.0.1:19475/...')` from `content-isolated.js`.**
The manifest's `connect-src 'self' http://127.0.0.1:19475` (extension/manifest.json:19) governs extension pages (background, popup). Content scripts run under a hybrid CSP that includes the page's CSP plus the extension's whitelist. Safari's enforcement of content-script CSP has historically diverged from Chrome. No content script in the existing codebase fetches the daemon — all daemon calls go through `background.js`.

**Assumption 2: `File` object structured-clone across ISOLATED→MAIN worlds via `window.postMessage`.**
Storage bus has only ever carried JSON-serializable metadata. None of the 5A.* work transports binary objects across worlds. If `File` reaches MAIN as a stripped clone (e.g., empty Blob, missing name), the entire injection plan dies.

**The spike** — implement minimally in v0.1.22-spike build (or as scaffolding within the v0.1.22 plan):
- Add `__SP_FILE_UPLOAD_PROBE_TEST__` sentinel branch to `background.js` that triggers content-isolated to (a) `fetch('http://127.0.0.1:19475/health')` and capture the response status, (b) build a small `File` from a hardcoded ArrayBuffer and postMessage to MAIN, where MAIN reports back `{name, size, type, bytesMatchExpected}`.
- Two e2e tests assert success.
- If spike fails: open a follow-up design pass; candidate alternatives include moving File construction to MAIN world (with bytes shipped via fragmented postMessage) or abandoning Approach 3.

Total spike cost: ~80 lines + 2 tests + 1 build cycle.

### Phase 1: TS-only foundations (no rebuild)

- `src/errors.ts`: 9 new error codes + `FileUploadError` subclasses
- `src/tools/mime.ts`: pure `mimeFromExtension(filename)` + unit tests
- `src/path-resolve.ts`: pure `resolveUploadPath(input)` + unit tests (Levenshtein suggestion is stretch — drop if cost > 30 lines)
- Reviewer gates per pure helper

### Phase 2: TS dispatch handler

- `src/tools/file-upload.ts`: handler with recording-engine dispatch tests
- `src/server.ts`: register `FileUploadTools`
- Reviewer gate. RED → GREEN.

### Phase 3: Daemon Swift

- `CommandDispatcher.swift`: `stage_file` NDJSON case + `FileStagingStore` actor + TTL cleanup task started from `SafariPilotd.start()`
- `ExtensionHTTPServer.swift`: `GET /file-bytes/<token>` (peek) + `DELETE /file-bytes/<token>` (release) routes
- Swift unit tests (existing test infra under `daemon/Tests/`)
- Build via `bash scripts/update-daemon.sh`

### Phase 4: Extension JS (depends on Phase 0 spike PASS)

- `extension/background.js`: sentinel branches for probe + main upload
- `extension/content-isolated.js`: `fetch` from daemon; `File` construction; DELETE on success; postMessage to MAIN
- `extension/content-main.js`: locator + detached check + multiple check + DataTransfer + `Object.defineProperty` + events + validation probe
- Single rebuild via `bash scripts/build-extension.sh`

### Phase 5: Fixture endpoint

- `test/helpers/fixture-server.ts`: `/upload-fixture` (multipart parser + sha256 echo) + `/upload-validate` (returns 400 with `aria-invalid="true"` on `tooLarge` field)

### Phase 6: e2e suite (12 tests below)

### Phase 7: v0.1.22 release

- `package.json` 0.1.21 → 0.1.22 BEFORE any rebuild (per `feedback-extension-version-both-fields`)
- Daemon rebuild → extension rebuild → user installs → run e2e against release-mode build

### Phase 8: Pre-ship smoke

5-site manual test against Notion / Slack / GitHub / Gmail / Linear. Per-site outcome documented in v0.1.22 changelog as one of:

- `verified` — full upload flow works, file received by site
- `failed: <reason>` — specific failure mode (e.g., "drag-drop only, no fallback `<input>`")
- `not-applicable` — site doesn't have an upload UI in the test path

Tightening over the prior phrasing prevents a vague "tested 5 sites" entry.

## Open questions (resolved during brainstorm + reviewer rounds)

- ~~Architecture: extension injection vs AX vs hybrid?~~ → Extension injection only (v1).
- ~~File source: paths vs inline bytes?~~ → Filesystem paths.
- ~~Security model?~~ → No restriction, Playwright parity, symlink trace.
- ~~Element targeting?~~ → Full locator suite + post-resolve type validation.
- ~~Limits?~~ → 25 MB × 4 (raised from 10 MB after switching to Approach 3).
- ~~MIME strategy?~~ → Extension lookup + parallel `mimeOverrides` map override + `mimeFallback` signal in response.
- ~~Multi-file atomicity?~~ → Pre-flight all reads, fail whole call.
- ~~Test fixture?~~ → Multipart sha256-echo endpoint + validation route.
- ~~Empty paths semantics?~~ → Reject; `clear: true` for explicit clearing.
- ~~Path semantics?~~ → Expand `~`, accept absolute, reject relative, reject NUL byte.
- ~~Wire encoding?~~ → Approach 3 (out-of-band HTTP fetch from extension).
- ~~Pre-flight reordering?~~ → Probe sentinel before byte staging.
- ~~Detached-element race?~~ → `document.contains` check + new error code.
- ~~Validation surface?~~ → Configurable `validationProbeMs` (default 200, max 2000); scope = closest `<form>` ancestor; raw localized strings; max 3 alerts × 500 chars; agents check `probedAtMs` to gauge staleness.
- ~~Polymorphic paths schema?~~ → Replaced `oneOf [string, {path,mimeType}]` with `paths: string[]` + parallel `mimeOverrides?: Record<string,string>` map.
- ~~Redundant response fields?~~ → Dropped `cleared` (agent already knows) and `warnings` (no agent contract; symlink resolution still goes to `server-trace.ndjson`).
- ~~`accept` attribute mismatch?~~ → Pass-through (Playwright parity); site-side rejection surfaces via validation field.
- ~~`multiple=false` + multi-path?~~ → Pre-validate via probe; throw new `FILE_UPLOAD_MULTIPLE_NOT_ALLOWED` (no silent truncation).
- ~~TOCTOU stat→read race?~~ → Re-check buffer.byteLength against cap after fs.readFile.
- ~~Token format?~~ → `crypto.randomBytes(32).toString('hex')` — 64 hex chars; cryptographically unguessable; URL path validated by route regex.
- ~~`/file-bytes` fetch failure semantics?~~ → Token consumption split: `GET` peeks (does NOT remove from store); extension issues `DELETE` only after `r.arrayBuffer()` resolves successfully. Failed GET leaves entry for retry until 60s TTL eviction.
- ~~Architecture spike?~~ → Phase 0 GATING test for content-script `fetch` + cross-world `File` structured-clone; both must pass before Phase 4–5 commit.

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
