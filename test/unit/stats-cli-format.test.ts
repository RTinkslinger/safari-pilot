import { describe, it, expect } from 'vitest';
import { formatTable, p, pct, warnPercentile } from '../../src/cli/format.js';

describe('format helpers', () => {
  it('formatTable pads columns', () => {
    const out = formatTable(['A', 'B'], [['xx', 'y'], ['z', 'longer']]);
    expect(out.split('\n')).toHaveLength(4); // header + sep + 2 rows
  });

  it('p() returns percentile', () => {
    expect(p([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.5)).toBe(6);
    expect(p([], 0.5)).toBe(0);
  });

  it('pct() handles zero denom', () => {
    expect(pct(0, 0)).toBe('0.0%');
    expect(pct(1, 4)).toBe('25.0%');
  });

  it('warnPercentile flags elevated p95', () => {
    expect(warnPercentile('safari_navigate', 600)).toBe('⚠');
    expect(warnPercentile('safari_navigate', 100)).toBe('');
    expect(warnPercentile('safari_take_screenshot', 1500)).toBe('');
    expect(warnPercentile('safari_take_screenshot', 2500)).toBe('⚠');
  });
});
