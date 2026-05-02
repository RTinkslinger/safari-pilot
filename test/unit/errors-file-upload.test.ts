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
