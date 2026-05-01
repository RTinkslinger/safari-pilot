import { describe, it, expect } from 'vitest';
import {
  FrameNotFoundError,
  FrameNavigatedError,
  FrameUnreachableError,
  FrameNotSupportedError,
  ERROR_CODES,
} from '../../../src/errors.js';

describe('Frame error classes (T55a)', () => {
  it('FrameNotFoundError has code FRAME_NOT_FOUND, retryable=false, hint mentions safari_list_frames', () => {
    const e = new FrameNotFoundError(5);
    expect(e.code).toBe(ERROR_CODES.FRAME_NOT_FOUND);
    expect(e.retryable).toBe(false);
    expect(e.hints.join(' ')).toMatch(/safari_list_frames/);
    expect(e.message).toMatch(/5/);
  });

  it('FrameNavigatedError has code FRAME_NAVIGATED, retryable=true', () => {
    const e = new FrameNavigatedError(5, 'https://old', 'https://new');
    expect(e.code).toBe(ERROR_CODES.FRAME_NAVIGATED);
    expect(e.retryable).toBe(true);
    expect(e.message).toMatch(/old/);
    expect(e.message).toMatch(/new/);
  });

  it('FrameUnreachableError has code FRAME_UNREACHABLE, retryable=false, hint enumerates causes', () => {
    const e = new FrameUnreachableError(5);
    expect(e.code).toBe(ERROR_CODES.FRAME_UNREACHABLE);
    expect(e.retryable).toBe(false);
    expect(e.hints.join(' ')).toMatch(/sandbox|CSP|injection/i);
  });

  it('FrameNotSupportedError has code FRAME_NOT_SUPPORTED, retryable=false, hint mentions extension', () => {
    const e = new FrameNotSupportedError();
    expect(e.code).toBe(ERROR_CODES.FRAME_NOT_SUPPORTED);
    expect(e.retryable).toBe(false);
    expect(e.hints.join(' ')).toMatch(/extension/i);
  });
});
