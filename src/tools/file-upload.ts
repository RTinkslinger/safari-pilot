import { readFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename } from 'node:path';
import type { IEngine } from '../engines/engine.js';
import type { DaemonEngine } from '../engines/daemon.js';
import type { Engine, ToolResponse, ToolRequirements } from '../types.js';
import { EngineRequiredError,
  FileUploadEmptyPathsError,
  FileUploadTooManyFilesError,
  FileUploadInvalidParamsError,
  FileUploadPathNotFoundError,
  FileUploadPathNotReadableError,
  FileUploadFileTooLargeError,
  FileUploadInvalidElementError,
  FileUploadElementDetachedError,
  FileUploadMultipleNotAllowedError,
  wrapEngineError,
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
  private daemon: DaemonEngine;
  private handlers = new Map<string, Handler>();

  constructor(engine: IEngine, daemon: DaemonEngine) {
    this.engine = engine;
    this.daemon = daemon;
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
      throw new EngineRequiredError('safari_file_upload');
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
    if (!probeResult.ok) throw wrapEngineError(probeResult.error, 'probe dispatch failed');
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

        // Stage to daemon: NDJSON `stage_file` via DaemonEngine.command()
        const token = randomBytes(32).toString('hex');
        const stageRes = await this.daemon.command('stage_file', {
          token,
          mimeType,
          bytesB64: buf.toString('base64'),
        });
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
      throw wrapEngineError(finalResult.error, 'file upload dispatch failed');
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
