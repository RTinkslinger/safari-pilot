import { describe, it, expect } from 'vitest';
import { callTool } from '../helpers/mcp-client.js';
import { getSharedClient } from '../helpers/shared-client.js';

describe('safari_list_skills + safari_run_skill e2e', () => {
  it('safari_list_skills returns the 3 bundled skills', async () => {
    const { client, nextId } = await getSharedClient();
    const r = await callTool(client, 'safari_list_skills', {}, nextId(), 10_000);
    const names = ((r['skills'] ?? []) as Array<{ name: string }>).map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['login', 'paginate-and-scrape', 'robust-form-fill']));
  });
});
