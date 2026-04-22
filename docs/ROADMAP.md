# Safari Pilot — Saving The Project Roadmap

## Objective

**Replace Playwright + Chrome as Claude Code's browser automation.** No Mac user running Claude Code should need Chrome. Safari Pilot matches or exceeds every Playwright MCP capability, with structural advantages Playwright can never have (real authenticated sessions, native WebKit, zero CPU overhead, macOS-native lifecycle).

## Shipped

| # | Capability | Date | Proof |
|---|---|---|---|
| 0.1 | Initialization system — session window on MCP init, all-green gate, pre-call live health check, transparent 10s recovery, multi-session detection | 2026-04-23 | `test/e2e/initialization.test.ts` — 4 tests pass against real Safari. Init blocks until extension connects (1.8s). Health check confirms all systems. new_tab routes through extension engine. Pre-call gate verified. |

### Known blockers for next phases
- **Bug 6:** `safari_evaluate` via extension engine times out in newly opened tabs (content script not ready). Storage bus command never reaches the tab. This blocks Phase 1 item 1.5 (evaluate) and Phase 2+ (all extraction/interaction tools that use JS execution). Must be fixed before any tool beyond navigate/new_tab/list_tabs can be validated.

---

## Current State (honest)

Code exists for most P0 and P1 capabilities from the original roadmap. But execution was catastrophically flawed:

- **Tests were fake.** 1200+ unit tests ran against mocks. 33 "e2e" tests called server classes directly, skipping the MCP protocol entirely. 64/74 tools never touched real Safari. The extension engine — the core differentiator — was dead code for the entire project history.
- **Claims were false.** Features were marked "shipped" based on unit tests passing. The MCP server was broken from v0.1.0-v0.1.4 (STDIO transport never wired). The extension engine never executed a single real command.
- **TDD was impossible.** Mock-based tests pass when the product is broken. The test suite provided false confidence that blocked real debugging.

**All existing unit tests and e2e tests are deleted.** They were liabilities, not assets. Development restarts from zero with live-validated tests only.

## How This Works

Each Playwright capability is an independent work item. For each one:

1. **Validate** — Does the code path actually work through the real stack? Spawn the MCP server, send JSON-RPC, verify Safari does the thing.
2. **Fix** — If broken, use `upp:systematic-debugging`. No guessing, no band-aids.
3. **Test** — Write ONE real test that proves it works. Real MCP process, real Safari, Real extension, real result. No mocks.
4. **Prove** — Run the test. Show the output. If it fails, go back to step 2.
5. **Ship** — Only marked shipped when the live test passes and the user is satisfied.

Full UPP pipeline (brainstorm → spec → plan → TDD → verify) for any capability that needs new code. For capabilities where code exists but is unproven, steps 1-4 above.

---

## Phase 1: Core Navigation + Evaluation (Must Work First)

Everything else depends on these. If navigate/evaluate/new_tab don't work through the real stack, nothing else matters.

| # | Capability | Playwright equivalent | Safari Pilot tool | Code exists? |
|---|---|---|---|---|
| 1.1 | Navigate to URL | `browser_navigate(url)` | `safari_navigate` | Yes |
| 1.2 | Open new tab | `browser_new_tab(url)` | `safari_new_tab` | Yes |
| 1.3 | Close tab | `browser_close_tab` | `safari_close_tab` | Yes |
| 1.4 | List tabs | `browser_tab_list` | `safari_list_tabs` | Yes |
| 1.5 | Evaluate JavaScript | `browser_evaluate(js)` | `safari_evaluate` | Yes |
| 1.6 | Take screenshot | `browser_take_screenshot` | `safari_take_screenshot` | Yes |
| 1.7 | Navigate back/forward | `browser_navigate_back` | `safari_navigate_back/forward` | Yes |

**Validation approach:** Spawn `node dist/index.js`, send MCP `tools/call` for each tool, verify Safari actually does it. Must work through extension engine (not just AppleScript fallback).

---

## Phase 2: Page Understanding (The Playwright Gap Closer)

This is how Claude Code actually uses Playwright — snapshot returns ARIA tree with refs, agent uses refs to interact.

| # | Capability | Playwright equivalent | Safari Pilot tool | Code exists? |
|---|---|---|---|---|
| 2.1 | ARIA tree snapshot with refs | `browser_snapshot` | `safari_snapshot` | Yes (aria.ts) |
| 2.2 | Get page text | `browser_snapshot` (text mode) | `safari_get_text` | Yes |
| 2.3 | Get page HTML | N/A (Playwright uses snapshot) | `safari_get_html` | Yes |
| 2.4 | Extract tables | N/A | `safari_extract_tables` | Yes |
| 2.5 | Extract links | N/A | `safari_extract_links` | Yes |
| 2.6 | Extract images | N/A | `safari_extract_images` | Yes |
| 2.7 | Extract metadata | N/A | `safari_extract_metadata` | Yes |
| 2.8 | Smart scrape | N/A (Safari Pilot extra) | `safari_smart_scrape` | Yes |

**Validation approach:** Navigate to a real page, call each tool, verify the output contains real content from the page. ARIA snapshot must return refs that can be used in Phase 3.

---

## Phase 3: Interaction (Click, Fill, Type)

The agent acts on the page. Every interaction must work with both CSS selectors AND ref-based targeting from Phase 2.

| # | Capability | Playwright equivalent | Safari Pilot tool | Code exists? |
|---|---|---|---|---|
| 3.1 | Click element | `browser_click(ref)` | `safari_click` | Yes |
| 3.2 | Fill input | `browser_fill(ref, value)` | `safari_fill` | Yes |
| 3.3 | Type text | `browser_type(text)` | `safari_type` | Yes |
| 3.4 | Press key | `browser_press_key(key)` | `safari_press_key` | Yes |
| 3.5 | Select option | `browser_select_option` | `safari_select_option` | Yes |
| 3.6 | Hover | `browser_hover` | `safari_hover` | Yes |
| 3.7 | Drag and drop | `browser_drag` | `safari_drag` | Yes |
| 3.8 | Double click | N/A | `safari_double_click` | Yes |
| 3.9 | Wait for condition | `browser_wait_for` | `safari_wait_for` | Yes |

**Validation approach:** Navigate to a form page (local fixture or live), snapshot to get refs, click/fill/type using refs, verify the page state changed. Must prove auto-waiting works (element not ready → wait → succeed).

---

## Phase 4: Multi-Tab Workflows

The scenario that exposed all the architectural bugs: agent works across multiple tabs, website opens tabs, session isolation.

| # | Capability | What to prove | Code exists? |
|---|---|---|---|
| 4.1 | Session window isolation | Each CC session gets its own Safari window | Yes (today's fix) |
| 4.2 | Tab targeting by position | Navigate/evaluate hits the RIGHT tab, not URL match | Yes (today's fix) |
| 4.3 | Website-opened tab adoption | Click opens new tab → agent can interact with it | Yes (today's fix) |
| 4.4 | Multi-session parallel work | Two CC sessions working simultaneously without interference | Partially |

**Validation approach:** Open multiple tabs, navigate between them, verify operations hit the correct tab. Open a link that spawns a new tab, verify the agent can read the new tab's content.

---

## Phase 5: Extension Engine Proof

The entire differentiator. If extension engine doesn't work, Safari Pilot is just an AppleScript wrapper.

| # | Capability | What to prove | Code exists? |
|---|---|---|---|
| 5.1 | Extension bootstrap | Session tab opens → extension connects → engine available | Yes (today's fix) |
| 5.2 | Extension command execution | JS executes through storage bus, result flows back | Yes |
| 5.3 | Shadow DOM access | Query/click inside shadow roots (impossible via AppleScript) | Yes |
| 5.4 | Engine selection metadata | Tool responses include which engine ran | Yes |
| 5.5 | Extension → daemon fallback | Extension down → daemon engine takes over gracefully | Yes |

**Validation approach:** Verify engine metadata in tool responses shows `engine: "extension"`. Execute on a page with shadow DOM. Kill extension, verify fallback works.

---

## Phase 6: Advanced Capabilities

Only after Phases 1-5 are proven live.

| # | Capability | Safari Pilot tool | Code exists? |
|---|---|---|---|
| 6.1 | File downloads | `safari_wait_for_download` | Yes |
| 6.2 | PDF export | `safari_export_pdf` | Yes |
| 6.3 | Cookie management | `safari_get/set/delete_cookie` | Yes |
| 6.4 | Local/session storage | `safari_local_storage_get/set` | Yes |
| 6.5 | Network request monitoring | `safari_list_network_requests` | Yes |
| 6.6 | Request interception/mocking | `safari_mock_request` | Yes |
| 6.7 | Geolocation/timezone override | `safari_override_*` | Yes |
| 6.8 | Frame handling | `safari_list_frames`, `safari_eval_in_frame` | Yes |
| 6.9 | Service workers | `safari_sw_list`, `safari_sw_unregister` | Yes |
| 6.10 | Performance tracing | `safari_begin/end_trace` | Yes |

---

## Phase 7: Benchmark

Only after Phases 1-6 are proven. Run the benchmark suite against real sites, measure against Playwright. The benchmark runner and task definitions exist but have never been validated.

---

## What Safari Pilot Beats Playwright On (Structural)

These are architectural advantages — not claims to verify, they're inherent to the design:

| Advantage | Why |
|---|---|
| Real authenticated sessions | Uses actual Safari cookies/sessions, not isolated contexts |
| 60% less CPU | WebKit-native, no Chromium overhead |
| No focus stealing | AppleScript + extension don't activate Safari |
| Real Safari rendering | Actual Safari WebKit, not Playwright's fork |
| macOS-native lifecycle | launchd, ScreenCaptureKit, system integration |
| Session persistence | Survives restarts, uses real browser state |

---

## Rules (Non-Negotiable)

1. **No mocks in any test.** If it can't be tested against real Safari, document it as untested.
2. **No claiming shipped without live proof.** "Unit tests pass" means nothing.
3. **No fixing tests to match broken code.** If the test fails, the product is wrong.
4. **No building new features before existing ones are proven.** Phase order matters.
5. **Full UPP pipeline for new code.** Brainstorm → spec → plan → TDD → verify.
6. **Systematic debugging only.** No ad-hoc fixes, no "let me try this quick change."
7. **Extension engine is the default.** If a test works through AppleScript but not extension, it's not done.
