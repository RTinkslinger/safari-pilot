import { describe, it, expect } from 'vitest';
import { shouldProcess } from '../../../extension/lib/route-command.js';

describe('shouldProcess routing rule (T55a)', () => {
  it('rejects when tabId mismatches', () => {
    expect(shouldProcess({ tabId: 1, frameId: 0 }, 2, 0)).toBe(false);
  });

  it('omitted frameId targets only top frame', () => {
    expect(shouldProcess({ tabId: 1 }, 1, 0)).toBe(true);
    expect(shouldProcess({ tabId: 1 }, 1, 3)).toBe(false);
  });

  it('explicit frameId targets only that frame', () => {
    expect(shouldProcess({ tabId: 1, frameId: 3 }, 1, 3)).toBe(true);
    expect(shouldProcess({ tabId: 1, frameId: 3 }, 1, 0)).toBe(false);
  });

  it('myFrameId null (handshake not complete) means no decision yet — caller queues', () => {
    expect(shouldProcess({ tabId: 1, frameId: 0 }, 1, null)).toBe(null);
  });

  it('frameUrl mismatch returns false (will emit FRAME_NAVIGATED upstream)', () => {
    expect(shouldProcess({ tabId: 1, frameId: 3, frameUrl: 'https://old' }, 1, 3, 'https://new')).toBe(false);
  });

  it('frameUrl match returns true', () => {
    expect(shouldProcess({ tabId: 1, frameId: 3, frameUrl: 'https://x' }, 1, 3, 'https://x')).toBe(true);
  });

  it('frameUrl absent on cmd is permissive', () => {
    expect(shouldProcess({ tabId: 1, frameId: 3 }, 1, 3, 'https://x')).toBe(true);
  });
});
