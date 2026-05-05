import { describe, it, expect } from 'vitest';
import { ToolIndex } from '../../../src/discovery/tool-index.js';

const fixture = [
  { name: 'safari_navigate', description: 'Navigate to a URL. Use when starting a task.' },
  { name: 'safari_extract_tables', description: 'Extract tables. Use when the answer is in a table.' },
  { name: 'safari_query_all', description: 'Return all elements matching a locator. Use for lists.' },
  { name: 'safari_get_text', description: 'Read visible text. Use to capture a label.' },
];

describe('ToolIndex', () => {
  it('builds index from tool definitions', () => {
    const idx = new ToolIndex(fixture);
    expect(idx.size()).toBe(4);
  });

  it('search returns matches for keyword in description', () => {
    const idx = new ToolIndex(fixture);
    const hits = idx.search('table');
    expect(hits.map((h) => h.name)).toContain('safari_extract_tables');
  });

  it('search respects topK limit', () => {
    const idx = new ToolIndex(fixture);
    const hits = idx.search('use', 2);
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it('extracts tag from tool name segment', () => {
    const idx = new ToolIndex(fixture);
    expect(idx.tagsFor('safari_extract_tables')).toContain('extract');
    expect(idx.tagsFor('safari_query_all')).toContain('query');
  });

  it('search returns empty array on no matches', () => {
    const idx = new ToolIndex(fixture);
    const hits = idx.search('zzznonexistent');
    expect(hits).toEqual([]);
  });
});
