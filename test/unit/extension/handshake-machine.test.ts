import { describe, it, expect } from 'vitest';
import { frameIdHandshakeReducer, INITIAL_STATE } from '../../../extension/lib/handshake-machine.js';

describe('frameIdHandshakeReducer (T55a)', () => {
  it('starts in IDLE with empty queue and null myFrameId', () => {
    expect(INITIAL_STATE).toEqual({ phase: 'IDLE', myFrameId: null, queue: [] });
  });

  it('IDLE + first sp_cmd → AWAITING, queues cmd, emits sp_getFrameId effect', () => {
    const cmd = { tabId: 1, commandId: 'c1' };
    const next = frameIdHandshakeReducer(INITIAL_STATE, { type: 'sp_cmd_arrived', cmd });
    expect(next.state.phase).toBe('AWAITING_FRAME_ID');
    expect(next.state.queue).toEqual([cmd]);
    expect(next.effects).toContainEqual({ type: 'send_sp_getFrameId' });
  });

  it('AWAITING + additional sp_cmd → enqueues, no new handshake effect', () => {
    const s1 = { phase: 'AWAITING_FRAME_ID', myFrameId: null, queue: [{ commandId: 'c1' }] };
    const next = frameIdHandshakeReducer(s1, { type: 'sp_cmd_arrived', cmd: { commandId: 'c2' } });
    expect(next.state.queue.map((c: any) => c.commandId)).toEqual(['c1', 'c2']);
    expect(next.effects).not.toContainEqual({ type: 'send_sp_getFrameId' });
  });

  it('AWAITING + handshake response → READY, drains queue as drain effects', () => {
    const queue = [{ commandId: 'c1' }, { commandId: 'c2' }];
    const s1 = { phase: 'AWAITING_FRAME_ID', myFrameId: null, queue };
    const next = frameIdHandshakeReducer(s1, { type: 'sp_getFrameId_response', frameId: 7 });
    expect(next.state.phase).toBe('READY');
    expect(next.state.myFrameId).toBe(7);
    expect(next.state.queue).toEqual([]);
    expect(next.effects).toEqual([
      { type: 'process_cmd', cmd: { commandId: 'c1' } },
      { type: 'process_cmd', cmd: { commandId: 'c2' } },
    ]);
  });

  it('AWAITING + handshake error → IDLE (queue dropped, next cmd retries)', () => {
    const s1 = { phase: 'AWAITING_FRAME_ID', myFrameId: null, queue: [{ commandId: 'c1' }] };
    const next = frameIdHandshakeReducer(s1, { type: 'sp_getFrameId_error' });
    expect(next.state.phase).toBe('IDLE');
    expect(next.state.queue).toEqual([]);
  });

  it('READY + sp_cmd → process immediately, no queue', () => {
    const s1 = { phase: 'READY', myFrameId: 7, queue: [] };
    const cmd = { commandId: 'c1' };
    const next = frameIdHandshakeReducer(s1, { type: 'sp_cmd_arrived', cmd });
    expect(next.state).toEqual(s1);
    expect(next.effects).toEqual([{ type: 'process_cmd', cmd }]);
  });
});
