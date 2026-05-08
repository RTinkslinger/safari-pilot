export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] || '').length)),
  );
  const fmt = (cells: string[]): string =>
    cells.map((c, i) => (c || '').padEnd(widths[i])).join('  ');
  const sep = widths.map((w) => '─'.repeat(w)).join('  ');
  return [fmt(headers), sep, ...rows.map(fmt)].join('\n');
}

export function p(arr: number[], pct: number): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * pct)] ?? 0;
}

export function pct(num: number, denom: number): string {
  if (denom === 0) return '0.0%';
  return `${((num / denom) * 100).toFixed(1)}%`;
}

export function warnPercentile(tool: string, p95Ms: number): string {
  const thresholds: Record<string, number> = {
    safari_take_screenshot: 2000,
  };
  const t = thresholds[tool] ?? 500;
  return p95Ms > t ? '⚠' : '';
}
