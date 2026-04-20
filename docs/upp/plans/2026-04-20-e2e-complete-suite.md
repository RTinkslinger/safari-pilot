# E2E Complete Suite — Implementation Plan (Draft)

> **Status:** PLANNED — not yet specced or scheduled. Created from coverage audit 2026-04-20.

**Goal:** Bring e2e test coverage from 25% (20/79 tools) to 90%+ by testing every tool through the real MCP protocol → server → engine → Safari stack.

**Current state:** 97 tests across 20 files prove infrastructure works (engine routing, security pipeline, MCP protocol, extension IPC). But 59/79 tools have zero e2e proof they work through the shipped stack.

---

## Priority Order (by risk and user impact)

### Phase 1: High-Risk Gaps (extension differentiators + core automation)

**Network tools (8 tools) — zero coverage:**
- `safari_list_network_requests`
- `safari_get_network_request`
- `safari_intercept_requests`
- `safari_mock_request`
- `safari_network_throttle`
- `safari_network_offline`
- `safari_websocket_listen`
- `safari_websocket_filter`

**Storage/cookies (12 tools) — zero coverage:**
- `safari_get_cookies`
- `safari_set_cookie`
- `safari_delete_cookie`
- `safari_local_storage_get`
- `safari_local_storage_set`
- `safari_session_storage_get`
- `safari_session_storage_set`
- `safari_storage_state_export`
- `safari_storage_state_import`
- `safari_idb_list`
- `safari_idb_get`

**Frames (3 tools) — zero coverage:**
- `safari_list_frames`
- `safari_switch_frame`
- `safari_eval_in_frame`

### Phase 2: Core Interaction Verbs

**Interaction tools (7 tools) — zero coverage:**
- `safari_type`
- `safari_press_key`
- `safari_select_option`
- `safari_scroll`
- `safari_hover`
- `safari_double_click`
- `safari_drag`

**Extraction tools (6 tools) — zero coverage:**
- `safari_get_attribute`
- `safari_extract_tables`
- `safari_extract_links`
- `safari_extract_images`
- `safari_extract_metadata`
- `safari_smart_scrape`

### Phase 3: Compound & Scenario Tests

**Compound tools (2 tools):**
- `safari_test_flow`
- `safari_paginate_scrape`

**Scenario tests (multi-tool workflows):**
- Multi-page navigation flow (navigate → interact → navigate → verify)
- Form submission flow (fill → click → wait_for → verify state change)
- Authentication flow (navigate login → fill credentials → submit → verify session)
- SPA interaction (navigate → wait_for → extract dynamic content)
- API mock testing (mock_request → navigate → verify mocked data shown)

### Phase 4: Utility & Observability

**Wait/dynamic (1 tool):**
- `safari_wait_for`

**Performance (4 tools):**
- `safari_begin_trace`
- `safari_end_trace`
- `safari_get_page_metrics`
- `safari_monitor_page`

**Overrides (4 tools):**
- `safari_override_geolocation`
- `safari_override_timezone`
- `safari_override_locale`
- `safari_override_useragent`

**Other (8 tools):**
- `safari_take_screenshot`
- `safari_handle_dialog`
- `safari_clipboard_read`
- `safari_clipboard_write`
- `safari_sw_list`
- `safari_sw_unregister`
- `safari_permission_get`
- `safari_permission_set`

---

## Test Design Principles

1. Every test spawns a real MCP server over stdio (no imports from src/)
2. Every test asserts `meta.engine` to prove which engine ran
3. Every test uses `safari_new_tab` for tab isolation (never touches user tabs)
4. Test fixtures: local HTTP server for network/storage tests (see `test/fixtures/`)
5. Each tool must have at least: happy path + one error/edge case
6. Scenario tests chain 3+ tools and verify end-state

## Estimated Scope

- ~59 tool-level tests (one per uncovered tool minimum)
- ~5 scenario tests (multi-tool workflows)
- ~8 test files (grouped by tool module)
- Total new tests: ~70-80

## Dependencies

- Production stack must be running (daemon + extension + Safari)
- Local HTTP fixture server for network/cookie/frame tests
- May need test pages with specific DOM structures (shadow DOM, iframes, forms)

---

## Current Coverage (for reference)

| Metric | Before | Target |
|--------|--------|--------|
| Tools with e2e | 20/79 (25%) | 71/79 (90%) |
| Scenarios covered | 2/14 | 12/14 |
| Test count | 97 | ~170 |
