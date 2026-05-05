import { describe, it, expect } from 'vitest';
import { SafariPilotServer } from '../../../src/server.js';
import { SelectorPackTools } from '../../../src/tools/selector-pack.js';
import { loadConfig } from '../../../src/config.js';

const findToolDesc = (name: string): string => {
  const server = new SafariPilotServer(loadConfig());
  return server.listToolDefinitions().find((t) => t.name === name)?.description ?? '';
};

/** safari_register_selector is feature-gated (selectorPack.enabled=false by default).
 *  Instantiate SelectorPackTools directly with enabled:true to test the description. */
const selectorPackDesc = (name: string): string => {
  const fakeEngine = {
    name: 'applescript' as const,
    executeJsInTab: async () => ({ ok: true, value: '{}', elapsed_ms: 0 }),
  };
  const tools = new SelectorPackTools(fakeEngine as never, { enabled: true });
  return tools.getDefinitions().find((t) => t.name === name)?.description ?? '';
};

describe('Cluster C — locator v2 adoption signals', () => {
  it('safari_query_all description references chain ops', () => {
    expect(findToolDesc('safari_query_all')).toMatch(/chain/i);
  });

  it('safari_click description steers to query_all + chain on multi-match', () => {
    const d = findToolDesc('safari_click');
    expect(d).toMatch(/query_all|chain/i);
  });

  it('safari_get_text description steers to query_all when answer is a list', () => {
    const d = findToolDesc('safari_get_text');
    expect(d).toMatch(/query_all|list|multi/i);
  });

  it('safari_register_selector description shows pack:<name>=<arg> usage shape', () => {
    expect(selectorPackDesc('safari_register_selector')).toMatch(/pack:.*=/);
  });
});
