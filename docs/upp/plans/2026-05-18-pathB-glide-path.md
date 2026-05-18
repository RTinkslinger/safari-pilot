# Path B Glide Path — v0.1.36 → v0.1.37 first candidate

> **Decision locked 2026-05-18**: Safari Pilot stays an MCP plugin (no full agent rewrite). Path B = low-level safari_* tools + 3-5 natural-language meta-tools on top (Stagehand pattern). Path C deferred indefinitely.

This doc sequences the work from the current worktree state (`feat/v0136-track-a-infra` @ `d454046`, dev.10 built + installed) to a shippable v0.1.37 first Path B candidate.

---

## State today (2026-05-18)

### Already committed to `feat/v0136-track-a-infra` (24 commits since Track A HEAD `3863737`)

| Commit | Layer | Status |
|---|---|---|
| `3ca7055` errors: wrapEngineError + EngineExecutionError | F3.1 | ✅ unit-tested |
| `3576775` server: convert EngineExecutionError to isError MCP response | F3.1 | ✅ unit-tested |
| `d9893e3`…`0751d0d` (12 commits) tools/*: 72 sites use wrapEngineError | F3.1 | ✅ unit-tested |
| `740d858` F1.2: session-scoped tab cache + extension filter | F1.2 | ✅ TS unit-tested; e2e flaky |
| `9204c82` test/e2e: F3.1 envelope + F1.2 cross-session | F3.1+F1.2 | ⚠️ F1.2 e2e times out |
| `2ec1f16` bench: REPO_ROOT derivation + Max-migration | infra | ✅ smoke-verified |
| `8f78a8c` security: WallCapEnforcer | infra | ✅ unit + smoke |
| `ded69cb` engines: drop default 90s → 15s | perf | ✅ −41% wall verified |
| `9be4a18` bench: envelope-aware prompt | bench-only | ✅ −39% wall (BENCH ONLY — end users don't get this) |
| `a547d95` docs/architecture: native-messaging design | docs | ✅ |
| `b25756d` tools: safari_batch | path-B-prep | ✅ 8 new unit tests |
| `d454046` build(release): 0.1.36-dev.10 + batch prompt | build | ✅ dev.10 notarized + installed |

### Outstanding right now

1. **Probe `bdlk91u1g`** (50-task probe with dev.10 + bench prompt teaching batching). Started 13:23. ETA ~14:30 IST. **Will determine whether v0.1.36 ships with the batch prompt as-is or with adjustments.**
2. **F1.2 e2e test is flaky** — timed out at 15s rather than failing with TAB_NOT_FOUND. Not a release blocker (F1.2 was extra protection; bench doesn't use multi-session). Investigation deferred.
3. **Tool descriptions don't carry the envelope-awareness/batching guidance** — this is the Path A subset of Path B. Currently this guidance lives in the bench prompt only, so end users don't get the wins.

---

## v0.1.36 close-out (TODAY)

This is the release that ships everything from today's worktree EXCEPT meta-tools.

### Gate 1: probe-bdlk91u1g completes

- If median wall ≤ 350s → ship as-is. Numbers are SOTA-acceptable for an MCP plugin claim. Stage = pass.
- If median wall 350-500s → still ship; numbers are "−60% from baseline" which is a credible release. Stage = pass.
- If median wall > 500s → debug before shipping. Most likely cause would be safari_batch regressing some flows (e.g., agent batches when it shouldn't and loses adaptiveness).

### Gate 2: bake envelope-awareness + batching into tool descriptions (Path A subset)

This is the **only NEW work** before shipping v0.1.36 — gives end users some of what the bench prompt does.

**Scope**: each of the ~70 tool descriptions gets a 1-2 line addition about error envelope + batching where relevant.

- Update `getDefinitions()` in every tool module (interaction, extraction, network, storage, etc.) to extend the `description` field. Char budget: keep total under ~600 chars per description.
- For high-error-rate tools (safari_get_text, safari_query_all, safari_snapshot, safari_wait_for): add "On error: parse `content[0].text` JSON for `{error, retryable, hints}`. retryable:false → switch tools, do not retry same op."
- For action tools (safari_click, safari_fill, safari_type): same envelope note + "Group with safari_batch when sequencing 2+ actions in a row."
- For `safari_batch` itself: explicit usage example in the description.
- Unit-test: a guard that asserts every tool description either contains "envelope" OR is in an exempt list (small set of always-pure-info tools like safari_health_check).

**Effort**: 1-2 days (one engineer focused).

### Gate 3: ship pipeline (locked path per memory rules)

After Gate 1 + Gate 2:

1. Bump `package.json` + `extension/manifest.json` from `0.1.36-dev.10` → `0.1.36`.
2. Append CHANGELOG.md entry — honest numbers (the in-bench median 324s + envelope-aware bench prompt note; end-user-visible wins from 15s default + tool-description guidance + safari_batch tool + WallCap).
3. Rebuild extension via `bash scripts/build-extension.sh` (signs, notarizes, staples).
4. Local user-install rehearsal: `open "bin/Safari Pilot.app"`, verify in Safari > Settings > Extensions that 0.1.36 appears and works on one canned task.
5. Run `bash scripts/pre-tag-check.sh` (per memory rule — never push tag without this).
6. `git commit` the version bump + CHANGELOG. `git tag -a v0.1.36 -m "..."`. `git push origin v0.1.36` triggers `release.yml`.
7. Watch CI; verify `gh release view v0.1.36` + `npm view safari-pilot version` show 0.1.36 (per memory rule about npm token expiry).
8. Merge worktree → main: `git checkout main && git pull && git merge feat/v0136-track-a-infra --no-ff`. Resolve any conflicts. Push main.
9. Cleanup: `git worktree remove ../safari-pilot-v0136-track-a` (per session-management rule, after absorbing).

**ETA from probe completion**: 0.5-1 day (most of the day is the tool-description bake).

---

## v0.1.37 first Path B candidate — meta-tools

This is the v0.1.37 release. Goal: 3-5 meta-tools that let end users get Browserbase/Stagehand-style natural-language convenience inside their normal Claude Code conversations.

### Stage 1: inner-LLM client (`src/inner-llm/`)

The bottom of the stack. Every meta-tool calls this.

- New module: `src/inner-llm/client.ts`. Exposes `InnerLLMClient.chat(messages, opts) → string`.
- Implementation: subprocess `claude --bare --output-format text -p "<prompt>"` (or non-bare for Max auth — mirror `bench/webvoyager/run-one-task.sh`'s WV_AUTH=max pattern).
- Why subprocess (not Anthropic SDK direct): inherits the user's existing Claude Code auth — no new API key required, Max-subscription users pay $0 actual.
- Config: respect `SAFARI_PILOT_INNER_LLM_MODE` env (`max` | `apikey` | `subprocess`). Default = inherit from `claude` CLI's default.
- Failure modes: claude CLI not in PATH → throw `INNER_LLM_UNAVAILABLE` (structured error, retryable:false, hints: "Install Claude Code or set ANTHROPIC_API_KEY").
- Streaming: not in v0.1.37. Synchronous request/response.
- Token limits: meta-tools sized to fit in claude's default context (no chunking yet).

**Tests**:
- Unit: mock the subprocess, verify request/response wiring.
- Integration (gated): real `claude -p "say HELLO"`, expect "HELLO" in output. Skipped if claude not in PATH.

**Effort**: 2-3 days.

### Stage 2: meta-tool framework + first meta-tool `safari_observe`

`safari_observe` is the simplest meta-tool — it doesn't take action, just answers "what's actionable on this page?"

- New file: `src/tools/meta.ts`. Houses MetaTools class.
- New low-level helper inside meta.ts: `pageContextSnapshot(tabUrl)` — calls safari_snapshot + safari_take_screenshot internally, returns the AX tree + a screenshot path. This is the "perception" input to every meta-tool.
- `safari_observe({tabUrl, intent})` flow:
  1. Call low-level safari_snapshot + safari_take_screenshot (in a single batch internally).
  2. Compose a prompt: "Given this AX tree and screenshot, list 5 actions the agent could take to satisfy the intent: <intent>. Format as `[{intent_action_label, low_level_tool_call}, ...]`."
  3. Send via InnerLLMClient.
  4. Parse the response; return `{actions: [...]}`.
- Return shape: structured list of suggested actions. The OUTER agent (Claude Code) can pick one and either invoke it directly via low-level tools, or call `safari_act(intent)` with the chosen one.

**Tests**:
- Unit (with mocked InnerLLMClient): assert the prompt template is well-formed, output parsing is robust to malformed LLM responses.
- E2E (against a fixture page): observe a simple page, expect actions like "click login", "fill search". This is end-to-end but gated on real LLM availability.

**Effort**: 2-3 days.

### Stage 3: `safari_act` meta-tool

Takes a natural-language action intent + a tabUrl. Plans + executes in a single MCP call.

- `safari_act({tabUrl, intent, maxSteps=4})`:
  1. Internal observe loop:
     - Call pageContextSnapshot.
     - InnerLLMClient: "Given AX tree + screenshot, what low-level safari_* tool call accomplishes intent: <intent>?"
     - Parse response → a tool name + args.
  2. Execute the tool call via `executeToolWithSecurity` (full pipeline).
  3. If result is OK and intent satisfied (LLM verifies): return.
  4. If not satisfied after maxSteps: ABSTAIN with hint.
- Stops on: success, hard failure (retryable:false), maxSteps exceeded.

**Tests**: unit (mock LLM responses + mock tool dispatch), e2e (action on fixture page).

**Effort**: 3-4 days.

### Stage 4: `safari_extract` meta-tool

Takes a natural-language extraction intent + tabUrl. Returns structured data.

- `safari_extract({tabUrl, intent, schema?})`:
  1. pageContextSnapshot.
  2. InnerLLMClient: "Given AX tree, extract the data matching intent: <intent>. Format as JSON matching schema: <schema or 'auto-infer'>".
  3. Return the JSON.
- The inner LLM does the "reading" — no separate get_text/query_all loop required for simple extractions.
- For complex extractions (e.g., paginated lists), v0.1.38 territory — out of scope.

**Tests**: same shape as safari_act.

**Effort**: 2-3 days.

### Stage 5: `safari_navigate_to_intent` meta-tool

Multi-step navigation: "find vegetarian lasagna with 100+ reviews on Allrecipes."

- `safari_navigate_to_intent({startUrl, intent, maxSteps=8})`:
  1. safari_new_tab to startUrl.
  2. Loop up to maxSteps:
     - pageContextSnapshot.
     - InnerLLMClient: "Given current page and intent: <intent>, are we done? If not, what's the next action?"
     - If done: return current state + screenshot path.
     - If not done: execute next action via safari_act.
  3. Return final state or ABSTAIN.

**Tests**: e2e on 1-2 fixture multi-step flows.

**Effort**: 4-5 days.

### Stage 6: tool-description maturation

The Path A subset already landed in v0.1.36. v0.1.37 refines: meta-tools' descriptions teach the agent WHEN to use them vs the low-level tools.

- safari_act description: "Use for single-step actions when you have a natural-language intent. For exact-selector clicks, use safari_click directly."
- safari_extract: "Use for structured-data extraction from a known page. For raw text dumps, use safari_get_text."
- safari_observe: "Use when you don't know what actions are available on a page. Returns a list of suggested action intents."
- safari_navigate_to_intent: "Use for multi-step task completion when the path is not pre-known. For known URLs, use safari_navigate."

**Effort**: 0.5 day.

### Stage 7: validation bench

Re-run WebVoyager 50-task probe **with the bench prompt stripped of envelope-awareness guidance** — simulate a "naive end user" who doesn't write expert prompts. Compare to:
- v0.1.36 with naive prompt: should still see ~530s median (from 15s default).
- v0.1.37 with naive prompt + meta-tools available: hypothesis is that the OUTER agent (Claude Code) will discover and use meta-tools just from the tool descriptions, getting close to the bench-prompt-using median (~324s) without the user writing any prompt.

If hypothesis holds → end users get the wins for free.
If not → the meta-tool descriptions need stronger discovery hooks, or the meta-tools themselves need to be more aggressive.

**Effort**: 1 day setup + 1.5-2h probe wall.

### Stage 8: v0.1.37 ship

- Version bump 0.1.37-dev.1.
- Build dev.1 via scripts/build-extension.sh.
- Smoke + e2e validation against meta-tools.
- Bench results (Stage 7) feed CHANGELOG.
- Tag v0.1.37, merge worktree → main, npm publish.

**Effort**: 0.5-1 day.

---

## Sequencing summary

```
TODAY (2026-05-18)
├── wait for probe-bdlk91u1g (~14:30 IST)
├── Gate 1: probe verdict → ship/debug
├── Gate 2: tool-description bake (Path A subset, 1-2 days)
├── Gate 3: ship v0.1.36 (0.5-1 day)
└── v0.1.36 RELEASED

v0.1.37 sprint (2026-05-19 → 2026-06-02, ~2 weeks)
├── Day 1-3: Stage 1 — inner-LLM client
├── Day 4-6: Stage 2 — safari_observe
├── Day 7-10: Stage 3 — safari_act
├── Day 11-12: Stage 4 — safari_extract
├── Day 12-14: Stage 5 — safari_navigate_to_intent  (parallel with 3-4 if capacity allows)
├── Day 13: Stage 6 — tool-description refinements
├── Day 14: Stage 7 — naive-prompt validation bench
└── Day 14-15: Stage 8 — v0.1.37 ship
```

Realistic critical path: **2-3 weeks** for v0.1.37 first Path B candidate. Optimistic: 10 days.

---

## v0.1.36 + Path B claim shape (for release notes)

**v0.1.36 claims** (honest, end-user-visible):
- −41% median bench wall via Track A Fix 2 completion (15s default extension timeout).
- F3.1 structured error envelopes — content[0].text now carries `{error, retryable, hints}` JSON. Agents that read it can recover smarter.
- WallCapEnforcer (`MAX_WALL_MS` env var actually enforced).
- safari_batch tool — up to 4 actions per MCP call.
- F1.2 session-scoped tab matcher — cross-session pollution fixed.
- Bench harness routing fix (REPO_ROOT derivation).
- 24 commits, all tests green except one pre-existing description-quality failure.

**v0.1.37 target** (after Path B Stage 8):
- `safari_act`, `safari_extract`, `safari_observe`, `safari_navigate_to_intent` — natural-language meta-tools.
- Inner-LLM via the user's installed `claude` CLI (no new API key required, Max users pay $0).
- Naive-prompt WebVoyager bench result: claim parity with the expert-prompt v0.1.36 result.
- Path B v1 — "Stagehand-style high-level tools on top of low-level Safari Pilot tools."

---

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Inner-LLM subprocess (`claude -p`) adds 10-30s latency per meta-tool call | High | Acceptable for natural-language convenience; outer agent stops calling meta-tools when latency is hostile (a turn cap kicks in) |
| Meta-tool prompts drift from model versions | Medium | Pin a prompt template version field; revalidate on minor model bumps |
| Users without `claude` CLI in PATH | Low | Fallback to `ANTHROPIC_API_KEY` env var; meta-tools return INNER_LLM_UNAVAILABLE with a clear hint otherwise |
| Meta-tools succeed where low-level fail (e.g., parses garbled page) but at 30s latency | Low | Outer agent decides; meta-tools are advisory |
| Path B never gets to claimed numbers because Claude Code doesn't autonomously discover meta-tools | Medium | Stage 7 validates exactly this; if fails, escalate to Stage 6.5 (system prompt for plugin? — out of scope today) |

---

## Decision points reopened during execution

1. **After Gate 1 (probe verdict)**: do we ship v0.1.36 with the bench-prompt safari_batch teaching included? If yes, the prompt-template change goes with v0.1.36; end users still don't get those wins (since they don't see the bench prompt), but the bench numbers are claimable.
2. **End of Stage 1**: does the `claude -p` subprocess auth flow work in CI / for users without their Claude Code session open? May need to fall back to direct API key earlier than planned.
3. **End of Stage 7**: if naive-prompt bench falls short, decision to bake a system-prompt injection vs. accept lower numbers. System-prompt injection is invasive (changes Claude Code's behaviour outside Safari Pilot tools) — would need explicit user opt-in.

---

## Out of scope for v0.1.37

- **Native messaging transport** (`browser.runtime.connectNative` replacing HTTP poll). Designed in `docs/upp/architecture/native-messaging-transport.md`, 3-5 day implementation. Schedule after v0.1.37 if bench data still shows transport latency dominating.
- **Multi-step extraction** (paginated lists, recursive following). Stage 4 covers single-page only.
- **Action streaming / cancellation**. Synchronous request/response for v0.1.37; agentic streaming later.
- **Browser-Use-style "set and forget" Python SDK distribution**. Path C territory, not pursuing.
