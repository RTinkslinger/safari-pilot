# Safari Pilot v0.1.35 — Bench Integrity, Honesty & Regression Recovery

*Status: revised spec. Written 2026-05-14 after Phase 1 systematic-debugging + Phase 2 deep research. Supersedes the starter spec at `2026-05-14-safari-pilot-v0135-starter-superseded.md`. Rooted in `bench-runs/webvoyager-v0.1.34-bench-20260514/phase1-diagnostic.md` + `research-r1-r10.md`.*

---

## 1. Diagnosis (corrected)

### 1.1 The v0.1.34 bench gate failure was misdiagnosed

The earlier deep-analysis assumed the "10 persistent regressions" were product bugs in v0.1.34's sentinel refactor. Phase 1 systematic-debugging refuted this:

| Category | Count | Root cause |
|---|---|---|
| Judge-strictness false negatives | 5 | GPT-4V/4o judge requires VISUAL screenshot confirmation; correct text answers fail when evidence is off-screen, behind a cookie banner, or requires arithmetic/scrolling |
| Stale-date tasks | 3 | Google Flights tasks reference Jan-Mar 2024; site rejects past dates in May 2026 |
| Real agent bugs | 2 | Booking--5 (shortcut to hallucinated hotel), Google Search--14 (wrong "James Smith") |

The **sentinel envelope drift hypothesis is FULLY REFUTED** — all 7 refactored tools (click/fill/type/scroll/get_text/query_all/snapshot) verified byte-equivalent shapes to v0.1.33 originals.

### 1.2 The bench itself is the dominant signal-to-noise problem

- **41% of v0.1.33 baseline FAILUREs (19/46) are stale-date tasks** unrecoverable for ANY agent.
- The spec acceptance criterion `≥30/47 recovery` was unrealistic: the upper bound is ~28 if charitably excluding stale-date.
- The single-run protocol on a 184-task subset of a 643-task bench has high variance.

### 1.3 The real v0.1.34 product behavior: the 4-nudge stack

Three new tool descriptions ("Use in place of safari_evaluate"), safari_evaluate's existing description ("prefer query_all"), and `requiresCspBypass: true` on 7 refactored tools combined to halve safari_evaluate usage (2.17 → 1.07/task) and pivot the agent toward `query_all + click` combos that compound to 2× tool calls on multi-step tasks. Same-task-pair median is BETTER (-1 turn, -$0.027). Aggregate is +5 net (133/184 vs 128/184).

### 1.4 What the field actually does (from Phase 2 research)

| Agent | Score | How |
|---|---|---|
| Magnitude | 93.9% | `patches.json` for stale-date + impossible-task removals; manual judge review |
| Browserable | 90.4% | Removed 56 tasks (643→567) + updated others; ~$70 LLM cost |
| Kura | 87% | Documented "Benchmark Adjustments"; 90% vs Anthropic Computer Use 56% on 50-task subset |
| Original WebVoyager paper | — | 3-run mean ± std, κ≈0.70 vs human |

**All SOTA agents patch the bench.** Single-run unpatched is below the canonical protocol.

---

## 2. Sprint goal

Ship v0.1.34's CSP-bypass infrastructure (sentinels, Layer 3 TT policy, locator port, capability tools) as v0.1.35 with three concurrent corrections:

1. **Bench integrity** — patched WebVoyager protocol + multi-run judge + dual-metric reporting + anti-thrash controls.
2. **Product honesty** — abstention policy for impossible tasks, evidence-grounded final-proof tool to combat judge-strictness.
3. **Behavioral correction** — unwind the 4-nudge stack, fix the 2 real agent bugs, add light cross-cutting playbooks (date normalization, cookie/captcha handling, rate-aware pacing).

---

## 3. New acceptance criteria

### 3.1 Bench protocol (locked)

- **Multi-run majority-of-3** on every gate task. Aggregate by majority verdict.
- **Dual-bench reporting:** `patched-2026` set (date-substituted + impossible-removed) + `comparable-original` subset (unpatched tasks still valid in 2026).
- **Dual-metric reporting per set:** Pass@1 (majority-of-3), median steps/task, median wall/task, total LLM $.
- **Hard caps:** 25 turns/task and 20-min wall/task (matches Magnitude's protocol).

### 3.2 Quality gates

- **patched-2026 set:** Pass@1 ≥ 80%. (Realistic ceiling given a 643-task bench with ~20% stale-date that we patch.)
- **comparable-original subset:** Pass@1 ≥ v0.1.33 baseline + 0 (no regression on tasks where staleness isn't a factor).
- **Median steps/task:** ≤ 12 (currently 17.7 in v0.1.34 first-run).
- **Median LLM cost/task:** ≤ $0.30 (currently $0.36 v0.1.33 baseline; targets -17%).
- **Eval-contamination audit:** 0 instances of agent searching for benchmark name / answer keys in trace audit.
- **Tool-usage shape:** safari_evaluate usage within ±25% of v0.1.33 baseline (corrects the 4-nudge halving).

### 3.3 Per-site mins (revised, post-patching)

Computed against the patched-2026 set:
- Google Flights ≥ 7/8 (after removing 3 stale-date)
- Booking ≥ 9/10 (after removing 1 stale-date)
- Apple ≥ 9/12 (HOLD — already strong)
- Google Search ≥ 9/11 (HOLD)
- ESPN ≥ 6/12 (HOLD)
- BBC News ≥ 8/12 (recover 1, hold rest)

Sites unchanged: Allrecipes, Cambridge Dictionary, Coursera, GitHub, Huggingface, Wolfram Alpha, Amazon, Maps, ArXiv.

---

## 4. Slices (in execution order)

Each slice ends with a verifiable check. Bench protocol slices land FIRST so the rest of the sprint runs against trustworthy signal.

### Slice 0 — Patched WebVoyager protocol (1.5 days)

**Files:**
- `bench/webvoyager/patches.json` (NEW) — date substitutions + removal list
- `bench/webvoyager/apply-patches.py` (NEW) — applies patches to 643-task input, emits patched task set
- `bench/webvoyager/run-bench.sh` (MODIFIED) — adds `--patched` and `--comparable` modes
- `bench/webvoyager/README.md` (NEW) — documents protocol

**Steps:**
1. Audit all 643 tasks for hardcoded dates / time-sensitivity. Categorize: substitute (e.g., "Jan 10-24, 2024" → "+2 years from today"), remove (impossible to refresh), keep.
2. Write `patches.json` with `{taskId: {action: 'substitute'|'remove', ...}}`.
3. `apply-patches.py` produces two outputs: `patched-2026.json` (substitutions applied, removals omitted) and `comparable-original.json` (only tasks NOT in patches.json — i.e. the unpatched, still-valid tasks).
4. Verify: `comparable-original` is a strict subset of `patched-2026` minus substitutions; no overlap with removed tasks.
5. Commit with full rationale per patch (one paragraph each).

**Acceptance:** Apply patches to v0.1.33 baseline; verify ≤5% of patched-2026 tasks now hit "site rejects past dates" errors.

### Slice 1 — Multi-run majority-of-3 judge + dual-metric reporting (1 day)

**Files:**
- `bench/webvoyager/runner.ts` (MODIFIED) — adds `--runs N` flag, runs each task N times
- `bench/webvoyager/judge.py` (MODIFIED) — supports majority-of-N verdict aggregation
- `bench/webvoyager/score.py` (MODIFIED) — emits dual-metric report (Pass@1, median steps, median wall, total $)

**Steps:**
1. Add `--runs 3` flag. Default to single-run for dev loop, multi-run only for ship gates.
2. Verdict aggregation: `MAJORITY` if ≥2/3 pass. Track per-run verdicts in scoreboard for audit.
3. Score report includes new columns: `runs`, `pass_majority`, `median_steps`, `median_wall_ms`, `total_cost_usd`.
4. E2E: run a 5-task pilot with `--runs 3`; verify deterministic verdict aggregation + correct cost summing.

**Acceptance:** 3-run pilot completes; majority verdict matches manual review on the pilot tasks.

### Slice 2 — Anti-thrash controls (1 day)

**Files:**
- `src/server.ts` (MODIFIED) — adds session-level step-cap + wall-cap
- `src/security/loop-detector.ts` (NEW) — detects N consecutive identical tool calls or N consecutive identical-result snapshots
- `bench/webvoyager/run-one-task.sh` (MODIFIED) — passes hard caps via env

**Steps:**
1. Server tracks tool-call sequence per session. If same `(tool, key-args)` fires N=5 times in a row, return `LOOP_DETECTED` error with the agent's own trace as context.
2. If `safari_snapshot` returns identical content N=4 times in a row, return `THRASH_DETECTED` error.
3. Bench harness enforces 25-turn / 20-min hard caps via `MAX_TURNS` and `MAX_WALL_MS` env vars passed to claude --bare.
4. E2E: induce a thrash loop in a fixture page; verify `LOOP_DETECTED` fires after 5 identical calls; verify caps abort at 25 turns.

**Acceptance:** New e2e tests for both detectors; sentinel snapshot count on a stale-date Google Flights task drops to ≤4 (was 14-15 in v0.1.34).

### Slice 3 — 4-nudge unwind + 2 real agent bug fixes (0.5 day)

**Files:**
- `src/tools/page-info.ts` (MODIFIED) — remove "Use in place of safari_evaluate" from 3 descriptions
- `src/tools/extraction.ts` (MODIFIED) — soften safari_evaluate description (remove "prefer query_all"); rewrite CSP_BLOCKED hint to be informational, not prescriptive
- `src/tools/interaction.ts` + `src/tools/extraction.ts` (MODIFIED) — review `requiresCspBypass: true` flags; downgrade tools that have AppleScript fallbacks to `requiresCspBypass: 'preferred'` (new soft-preference)
- `src/engine-selector.ts` (MODIFIED) — handle `'preferred'` value (try Extension first, fall back to AppleScript with a metadata flag, no error)

**Steps:**
1. Edit 3 tool descriptions per spec.
2. Soften CSP_BLOCKED error: was `hint.alternative_tools: [...]`, now `hint.fallback_available: true` + `hint.note: "if the page enforces CSP, this script can't run"`. No "use these instead" language.
3. Add `'preferred'` value to `requiresCspBypass` type. Engine-selector uses Extension when available, otherwise AppleScript with metadata `degraded_to_applescript: true`.
4. Booking--5 fix: investigate the shortcut pattern. Likely needs an `EVIDENCE_REQUIRED` error when agent answers without taking a final screenshot of results page.
5. Google Search--14 fix: investigate. Likely needs a "verify person identity matches" pattern in the prompt template — research-driven, not a code fix.

**Acceptance:** Re-run the 10 persistent regressions on `--patched` + `--runs 3`; expect ≥7 to flip to PASS (3 stale-date already removed, 5 judge-strictness addressed in Slice 4, 2 real bugs addressed here).

### Slice 4 — Evidence-grounded final-proof tool (1 day)

**Files:**
- `src/tools/final-proof.ts` (NEW) — `safari_compose_final_evidence(tabUrl, claim)`
- `extension/content-main.js` (MODIFIED) — `__SP_COMPOSE_FINAL_EVIDENCE__` sentinel
- `src/tools/screenshot.ts` (MODIFIED) — supports `highlight_region` parameter

**Steps:**
1. Tool signature: `safari_compose_final_evidence({tabUrl, claim: string, evidence_locator?: Locator})`. Returns: `{screenshot_path, dom_snippet, claim_grounded: boolean}`.
2. Behavior: scrolls to evidence (if locator provided), captures screenshot with optional highlighted region around evidence, extracts the DOM snippet that contains the claim text. Returns all three so the agent can include them in its final answer.
3. Tool description guides the agent: "Call before answering with text that references on-page evidence. The screenshot will visually confirm your claim to a screenshot-based judge."
4. E2E: fixture page with claim text; verify final-proof composes a screenshot with the claim region highlighted + extracts the matching DOM text.

**Acceptance:** Re-run the 5 judge-strictness tasks (Allrecipes--6, Cambridge--26, Coursera--29, ESPN--16, ESPN--37) on `--patched` + `--runs 3` with the agent prompted to use final-proof; expect ≥4/5 to flip to PASS.

### Slice 5 — Abstention policy (0.5 day)

**Files:**
- `bench/webvoyager/prompt-template.md` (MODIFIED) — add abstention guidance
- `bench/webvoyager/judge.py` (MODIFIED) — recognize `ABSTAIN: <reason>` answer prefix as a third verdict (not pass, not fail, audit-only)

**Steps:**
1. Prompt template addition: "If the task is impossible (e.g., the site rejects past dates, the requested entity doesn't exist, you're rate-limited and waiting won't help), respond with `ABSTAIN: <one-sentence reason>` rather than fabricating an answer. Abstentions are scored separately."
2. Judge recognizes `ABSTAIN:` prefix and emits verdict `ABSTAIN` in scoreboard.
3. Score report tracks abstention rate per site as a new column.

**Acceptance:** Re-run Google Flights stale-date tasks (--13, --21, --24 if any survive patching); verify agent abstains rather than fabricating; verify scoreboard records ABSTAIN cleanly.

### Slice 6 — Light cross-cutting playbooks (1.5 days)

NOT site-specific recipes. Cross-cutting interaction patterns surfaced as MCP tools the agent can opt into.

**Files:**
- `src/tools/playbooks.ts` (NEW) — `safari_normalize_date`, `safari_dismiss_cookie_consent` (already exists as part of overlays — verify), `safari_wait_for_rate_limit_clear`
- `extension/content-main.js` (MODIFIED) — relevant sentinels for new playbook tools

**Steps:**
1. `safari_normalize_date({input: "Jan 10, 2026"})` → `{iso: "2026-01-10", components: {year, month, day}}`. Pure function, no DOM.
2. `safari_dismiss_cookie_consent({tabUrl})` — wraps existing `safari_dismiss_overlays` with a 'cookie-consent' filter. Returns `{dismissed: boolean, banner_type?: string}`.
3. `safari_wait_for_rate_limit_clear({tabUrl, max_wait_ms: 30000})` — polls page for HTTP 429 indicator / rate-limit message; waits or aborts. Returns `{ready: boolean, waited_ms: number}`.
4. E2E for each tool against fixture pages.

**Acceptance:** 3 new tools registered + 3 e2e tests passing; bench cluster wins: BBC News +1 (rate limit handling), Google Flights date-substitution flows cleaner.

### Slice 7 — query_all interactivity hints (1 day)

Carry-forward H4 from old spec — keeps independent value.

**Files:**
- `extension/locator.js` (MODIFIED) — `resolveLocatorAll` envelope adds `interactability` per element
- `src/locator.ts` (MODIFIED) — type definition update
- `test/unit/locators/drift-detector.test.ts` (MODIFIED) — drift detector covers new fields

**Steps:**
1. Each returned element gains: `interactability: {clickable, fillable, focusable, role, accessibleName, isVisible, boundingBox, isCovered, isAriaDisabled}`.
2. Drift-detector test verifies parity between src/ and extension/ implementations.
3. E2E: fixture with mix of disabled/hidden/covered elements; verify each field correctly populated.

**Acceptance:** Drift-detector PASS; e2e PASS; agent's median query_all repeats per task drops on Google Flights archetype.

### Slice 8 — Eval-contamination guards (0.5 day)

**Files:**
- `bench/webvoyager/runner.ts` (MODIFIED) — audits trace for benchmark-name searches
- `bench/webvoyager/audit-contamination.py` (NEW) — post-bench audit script

**Steps:**
1. Audit script scans all `tool-calls.jsonl` traces for queries containing "WebVoyager", "MinorJerry", task IDs, or known answer-key URLs.
2. Audit emits report; >0 hits = ship-block on the bench gate.
3. Document mitigation: "If found, address with system-prompt addition or input filter."

**Acceptance:** Audit script passes against current v0.1.34 traces (expect 0 contamination — sanity check).

### Slice 9 — Bench gate (1 day)

**Steps:**
1. Run `bench/webvoyager/run-bench.sh --patched --runs 3` over the patched-2026 task set.
2. Run `bench/webvoyager/run-bench.sh --comparable --runs 3` over the comparable-original subset.
3. Apply majority-of-3 verdict aggregation.
4. Compute dual-metric report.
5. Run contamination audit.
6. Verify all Section 3 acceptance criteria.

**Estimated cost:** patched (~600 tasks × 3 runs × ~$0.30) ≈ $540. Comparable subset (~150 tasks × 3 runs × ~$0.30) ≈ $135. Plus retries. Budget $750.

**Acceptance:** All Section 3 criteria PASS. Decision: ship v0.1.35 OR escalate specific gaps.

### Slice 10 — Ship (1 day)

1. Final extension rebuild at v0.1.35.
2. `pre-tag-check.sh`.
3. Tag, push, npm publish, CI watch.
4. ARCHITECTURE.md + CHANGELOG.md updates with bench numbers + new tools.

**Total estimate: ~10 eng days + ~$750 bench cost.**

---

## 5. Out of scope (deferred)

Decisions documented here so future sessions don't re-litigate.

| Item | Why deferred |
|---|---|
| Compound `safari_evaluate_then_act` tool (old H2) | Phase 2 research found no specific evidence this archetype helps; Claude computer-use coordinates clicks but that's mouse/keyboard, not DOM scripts. Revisit if Slice 3's 4-nudge unwind doesn't restore safari_evaluate usage. |
| Site-specific recipes for Google Flights / Booking / Maps (old H3a/b/c) | H3a refuted: stale-date tasks unrecoverable. H3b/c reframed into Slice 6 light playbooks. |
| Tier surface (basic 15 vs advanced 76) (old H6) | No research evidence it moves the needle; adds risk. Revisit v0.1.36+. |
| Drop `--bare` for non-CI bench (old H8) | `--bare` is API-key-only by design; orthogonal to root cause. |
| Multi-benchmark portfolio (VisualWebArena, Online-Mind2Web) | Recommended by research but adds 5+ days; v0.1.36 if WebVoyager improvements stabilize. |
| AX engine | Carry-forward from v0.1.34 spec Section 7. |
| Daemon `Models.swift` AnyCodable bool/int coercion | v0.1.32 carry-forward. |
| 5 secondary interaction tools refactor (`safari_check`, `safari_hover`, `safari_double_click`, `safari_select_option`, `safari_drag`) | Not bench-critical. |
| Replacing `safari_evaluate` itself | Out of scope; Slice 3 + Slice 6 should reduce its load. |

---

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| `patches.json` introduces selection bias toward easier tasks | Publish dual scores: patched + comparable-original. Make patches reviewable line-by-line. |
| Slice 3's softening of CSP nudging brings back evaluate-on-CSP failures | Layer 3 TT policy + sentinel infrastructure stays. CSP_BLOCKED still fires; just less prescriptive. |
| Final-proof tool isn't adopted by the agent → no flip on judge-strictness tasks | Add 2-3 examples in tool description; dogfood in 5 hand-picked tasks before bench. |
| Multi-run 3× protocol triples bench cost ($250 → $750 per gate) | Budget approved upfront. Single-run remains the dev-loop default. |
| Anti-thrash hard caps abort tasks the agent could've solved with one more turn | Caps are deliberately generous (25 turns, 20 min — Magnitude uses 20 min). Audit any cap-aborted tasks in scoreboard. |
| Patches drift from upstream WebVoyager dataset | Tag patches.json with date + WebVoyager dataset SHA; refresh quarterly. |
| Abstention policy used as escape hatch on solvable tasks | Abstention rate per-site is tracked; if a single agent abstains on >20% of one site's tasks, investigate. |

---

## 7. v0.1.34 disposition

Branch `feat/v0134-csp-bypass` (HEAD `4960ae3`) stays unmerged. v0.1.34 ships nothing externally. The work IS preserved as v0.1.35 foundation:
- 16 sentinels in `extension/content-main.js`
- Layer 3 Trusted-Types policy registration
- `extension/locator.js` full port
- 3 new ISOLATED capability tools (page_info, meta_tags, extract_text_window)
- `legacyMainWorld` rollback flag
- `requiresCspBypass` engine routing

v0.1.35 will:
1. Layer Slice 0-9 changes on top of `feat/v0134-csp-bypass`
2. Re-bench with the patched + multi-run protocol
3. Ship as v0.1.35 directly (no v0.1.34 intermediate release)

---

## 8. Inputs / preserved artifacts

- This spec
- `bench-runs/webvoyager-v0.1.34-bench-20260514/phase1-diagnostic.md` (Phase 1)
- `bench-runs/webvoyager-v0.1.34-bench-20260514/research-r1-r10.md` + `.json` (Phase 2)
- `bench-runs/webvoyager-v0.1.34-bench-20260514/scoreboard-final.json`
- `bench-runs/webvoyager-v0.1.34-bench-20260514/runner.log` + `retry2.log`
- `/tmp/wv-inline-runs-baseline-v0.1.33/` (preserved baseline, 184 score files)
- `/tmp/wv-inline-runs-v0.1.34/` (v0.1.34 first bench, 106 score files)
- `/tmp/wv-inline-runs/` (overlaid + judged, 184 score files)
- All v0.1.34 sentinel infrastructure (commits `d1f9e59` through `cf84574` on `feat/v0134-csp-bypass`)
- Old starter spec (superseded): `2026-05-14-safari-pilot-v0135-starter-superseded.md`
