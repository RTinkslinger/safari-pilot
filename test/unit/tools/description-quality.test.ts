// test/unit/tools/description-quality.test.ts
import { describe, it, expect } from 'vitest';
import { SafariPilotServer } from '../../../src/server.js';
import { loadConfig } from '../../../src/config.js';

const PARITY_TOOLS = new Set([
  'safari_navigate','safari_navigate_back','safari_navigate_forward','safari_reload','safari_new_tab','safari_close_tab','safari_list_tabs',
  'safari_click','safari_type','safari_fill','safari_press_key','safari_hover','safari_select_option','safari_double_click','safari_drag','safari_scroll','safari_check','safari_handle_dialog',
  'safari_get_text','safari_get_html','safari_get_attribute','safari_snapshot','safari_extract_tables','safari_extract_links','safari_extract_images','safari_extract_metadata','safari_smart_scrape','safari_paginate_scrape','safari_evaluate','safari_eval_in_frame','safari_get_console_messages','safari_query_all',
  'safari_query_shadow','safari_click_shadow','safari_list_frames',
  'safari_wait_for','safari_wait_for_download',
  'safari_register_selector','safari_unregister_selector',
  'safari_set_cookie','safari_get_cookies','safari_delete_cookie','safari_local_storage_get','safari_local_storage_set','safari_session_storage_get','safari_session_storage_set','safari_storage_state_export','safari_storage_state_import',
]);

describe('Cluster A — tool descriptions meet quality bar', () => {
  it('every parity-tier tool has a "Use when" trigger phrase', () => {
    const cfg = loadConfig();
    const server = new SafariPilotServer(cfg);
    const tools = server.listToolDefinitions();
    const offenders: string[] = [];
    for (const t of tools) {
      if (!PARITY_TOOLS.has(t.name)) continue;
      const desc = t.description ?? '';
      if (!/Use when\b/i.test(desc)) offenders.push(t.name);
    }
    expect(offenders, `tools missing "Use when" trigger: ${offenders.join(', ')}`).toEqual([]);
  });

  it('every parity-tier tool description is <= 400 chars', () => {
    const cfg = loadConfig();
    const server = new SafariPilotServer(cfg);
    const tools = server.listToolDefinitions();
    const offenders: Array<[string, number]> = [];
    for (const t of tools) {
      if (!PARITY_TOOLS.has(t.name)) continue;
      const len = (t.description ?? '').length;
      if (len > 400) offenders.push([t.name, len]);
    }
    expect(offenders, `tools over 400 chars: ${JSON.stringify(offenders)}`).toEqual([]);
  });

  it('every parity-tier tool description fits in 1-2 sentences (max 2 sentence-ending tokens)', () => {
    const cfg = loadConfig();
    const server = new SafariPilotServer(cfg);
    const tools = server.listToolDefinitions();
    const offenders: string[] = [];
    for (const t of tools) {
      if (!PARITY_TOOLS.has(t.name)) continue;
      const desc = t.description ?? '';
      const sentences = desc.split(/[.!?]\s+/).filter((s) => s.trim().length > 0);
      if (sentences.length > 2) offenders.push(`${t.name} (${sentences.length} sentences)`);
    }
    expect(offenders, `tools with >2 sentences: ${offenders.join(', ')}`).toEqual([]);
  });
});
