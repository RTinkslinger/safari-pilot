import { describe, it, expect, beforeEach } from 'vitest';
import { DaemonEngine } from '../../../src/engines/daemon.js';

describe('DaemonEngine traceId injection', () => {
  let engine: DaemonEngine;

  beforeEach(() => {
    engine = new DaemonEngine({ daemonPath: '/nonexistent', tcpPort: 0 });
  });

  it('setTraceId stores and getLastTraceId retrieves', () => {
    engine.setTraceId('req-custom-1');
    expect(engine.getLastTraceId()).toBe('req-custom-1');
  });

  it('getLastTraceId returns undefined when not set', () => {
    expect(engine.getLastTraceId()).toBeUndefined();
  });

  it('clearTraceId resets to undefined', () => {
    engine.setTraceId('req-custom-2');
    engine.clearTraceId();
    expect(engine.getLastTraceId()).toBeUndefined();
  });
});
