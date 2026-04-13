# Safari Pilot: Benchmark Suite, Recipe System & Eval Framework

**Date:** 2026-04-13
**Status:** Design approved, pending implementation plan
**Research inputs:** 5 competitive research reports in `docs/research/competitive-*.md`

---

## Vision

Safari Pilot should operate like a skilled human browsing the web — inferring page structure, knowing where to look, trying different paths when the first doesn't work, and getting better at each domain with experience. No other browser automation tool does this. The benchmark measures progress toward that vision; the recipe system delivers it.

**Build order:** Benchmark first (measure before optimize) → Traces accumulate → Recipe system built last in roadmap, seeded by trace data.

---

## 1. Benchmark Suite

### 1.1 Task Categories

**120 tasks across 11 categories, 4 difficulty tiers:**

| Category | Count | Tier | Description |
|----------|-------|------|-------------|
| Navigation | 15 | Core | Open URLs, follow links, back/forward, tab management |
| Form interaction | 15 | Core | Fill inputs, select dropdowns, checkboxes, date pickers |
| Data extraction | 15 | Core | Read text, extract tables, scrape structured data |
| Multi-step workflows | 12 | Core | Search + filter + extract + compare across tabs |
| DOM complexity | 8 | Core | Shadow DOM, iframes, dynamic content, lazy loading |
| Authentication flows | 8 | Core | Login forms, OAuth redirects, session management |
| Accessibility-first | 8 | Core | Navigate entirely via a11y tree/refs, no CSS selectors |
| Error recovery | 8 | Core | Handle popups, cookie banners, stale elements, timeouts |
| Safari-specific | 7 | Core | Engine selection, daemon/extension health, AppleScript edge cases |
| **Intelligence** | **12** | **Aspirational** | **Real-world goals requiring inference (see 1.2)** |
| **Competitive dual-mode** | **12** | **Comparative** | **Same task on Safari Pilot vs Playwright MCP** |

**Difficulty distribution:**
- Easy (1-2 tool calls): 25%
- Medium (3-5 tool calls): 35%
- Hard (6-15 tool calls): 25%
- **Intelligence-tier** (open-ended, may need 15+ calls, inference, exploration): 15%

### 1.2 Intelligence-Tier Tasks

These test human-like browsing intelligence. Low success rates expected initially — they're the signal that the recipe system works when it's built.

**Example tasks:**

| ID | Intent | What it tests |
|----|--------|--------------|
| intel-001 | "On Hacker News, find the most discussed post today and summarize its top 3 comments" | Requires: identifying "most discussed" (sort by comments), clicking into a post, loading comment thread, extracting nested content |
| intel-002 | "On X, find what @elonmusk posted most recently about AI and get the reply count" | Requires: navigating to profile, scrolling feed, filtering by topic, extracting engagement metrics from dynamic UI |
| intel-003 | "On LinkedIn, find 3 software engineers at Anthropic and list their current titles" | Requires: search, filtering results, navigating profiles, handling pagination, extracting structured data |
| intel-004 | "On Reddit, go to r/programming, find a post about Rust, and extract the top-voted comment" | Requires: subreddit navigation, scanning posts, topic matching, comment loading, sorting |
| intel-005 | "On Wikipedia, find the current population of Tokyo and compare it to the population listed 5 years ago" | Requires: search, navigating to revision history, comparing across page versions |
| intel-006 | "Fill out the HN login form with test credentials, submit, detect the error message, and report what it says" | Requires: form discovery, filling, submission, error detection, text extraction |
| intel-007 | "On GitHub, find the most-starred repo created this week and get its README summary" | Requires: trending/explore navigation, date filtering, repo navigation, markdown extraction |
| intel-008 | "On X, open the Explore page, find a trending topic, click into it, and extract 3 tweet texts" | Requires: navigation, dynamic content loading, content extraction from timeline |
| intel-009 | "On Reddit, find a post with an embedded image, extract the image URL, and describe the post title" | Requires: content type detection, media handling, multi-attribute extraction |
| intel-010 | "Navigate to LinkedIn Jobs, search for 'AI Engineer' in 'San Francisco', and extract the first 5 job titles and companies" | Requires: multi-field form filling, result parsing, pagination awareness |
| intel-011 | "On Wikipedia, find the 'References' section of the 'Safari (web browser)' article and count how many external links it contains" | Requires: page structure comprehension, section navigation, link counting |
| intel-012 | "On HN, find a Show HN post from today, visit the linked project, and extract the project's one-line description" | Requires: content filtering, external navigation, cross-site extraction |

### 1.3 Competitive Dual-Mode Tasks

12 tasks executed on BOTH Safari Pilot and Playwright MCP. Same model (Claude), same prompt, same task — different tool set.

**Execution**: The benchmark runner disables one tool set, runs the task, records metrics. Then disables the other, reruns.

**Metrics compared per task:**
- Binary success (did it complete?)
- Step count (how many tool calls?)
- Token usage (input + output tokens for the full task)
- Wall-clock time (end-to-end)
- Error recovery count (retries/fallbacks)

**Task selection**: Mix of tasks where each tool has structural advantages:
- **Safari Pilot advantages**: authenticated sessions (X feed, LinkedIn search), native Safari features, security pipeline
- **Playwright advantages**: element screenshots, HAR recording, multi-browser contexts
- **Neutral**: Wikipedia extraction, form filling, navigation

### 1.4 Environment

| Tier | % | What | Purpose |
|------|---|------|---------|
| Local fixtures | 30% | Static HTML in `benchmark/fixtures/` | Deterministic core: DOM complexity, engine-specific, error recovery |
| Stable live sites | 40% | Wikipedia, HN, GitHub, example.com, gov sites | Real-world generalization |
| Authenticated live sites | 20% | X, Reddit, LinkedIn (logged-in Safari) | Safari Pilot's unfair advantage |
| Competitive dual-mode | 10% | Same tasks on both tools | Head-to-head comparison |

### 1.5 Task Definition Format

```json
{
  "id": "intel-003",
  "category": "intelligence",
  "difficulty": "intelligence",
  "intent": "On LinkedIn, find 3 software engineers at Anthropic and list their current titles",
  "start_url": "https://www.linkedin.com/feed/",
  "requires_auth": true,
  "auth_domain": "linkedin.com",
  "eval": {
    "type": "structured_output",
    "schema": {
      "engineers": {
        "type": "array",
        "minItems": 3,
        "items": { "properties": { "name": { "type": "string" }, "title": { "type": "string" } } }
      }
    }
  },
  "eval_fallback": {
    "type": "llm_judge",
    "criteria": "Did the agent find at least 3 people who work at Anthropic with engineering-related titles?"
  },
  "timeout_ms": 120000,
  "competitive_mode": false,
  "tags": ["intelligence", "search", "multi-step", "authenticated", "linkedin"]
}
```

**Eval types** (ordered by reliability):
1. `exact_match` — string/URL comparison
2. `contains` — substring check
3. `state_check` — verify page state via safari_evaluate
4. `structured_output` — JSON schema validation on extracted data
5. `llm_judge` — Claude evaluates the result (fallback only, for intelligence-tier)

### 1.6 Per-Task Metrics

```json
{
  "task_id": "intel-003",
  "success": true,
  "steps": 14,
  "tokens": { "input": 12400, "output": 3200 },
  "wall_clock_ms": 28500,
  "engine_usage": { "applescript": 12, "daemon": 2, "extension": 0 },
  "retries": 1,
  "auto_wait_triggers": 3,
  "recipe_hints_used": 2,
  "eval_method": "structured_output"
}
```

### 1.7 Aggregate Metrics (per benchmark run)

- **Overall success rate** (and per-category)
- **Intelligence-tier success rate** (tracked separately — this is the recipe system's KPI)
- **Mean steps per successful task** (efficiency)
- **Competitive win rate** (Safari Pilot vs Playwright per-task)
- **P50/P95 task duration**
- **Flaky task count** (pass/fail non-deterministically)
- **Recipe utilization** (how often domain hints were present and how often they were relevant)

---

## 2. Trace Capture System

### 2.1 What Gets Captured

Every benchmark run produces a trace file per task:

```json
{
  "task_id": "intel-003",
  "run_id": "bench-20260413-001",
  "timestamp": "2026-04-13T06:45:00Z",
  "success": true,
  "domain": "linkedin.com",
  "steps": [
    {
      "tool": "safari_snapshot",
      "params": { "tabUrl": "https://www.linkedin.com/feed/" },
      "result_summary": "412 elements, 87 interactive, 87 refs",
      "elapsed_ms": 520,
      "engine": "applescript",
      "domain_hints_injected": ["Search requires click-to-focus"]
    },
    {
      "tool": "safari_click",
      "params": { "ref": "e15" },
      "result_summary": "clicked: true, element: INPUT.search-global-typeahead__input",
      "elapsed_ms": 89,
      "auto_wait": { "checks": ["visible", "stable", "enabled"], "waited_ms": 45 }
    }
  ],
  "domain_observations": [
    "LinkedIn search combobox requires click to activate before fill",
    "Search results load asynchronously — need snapshot after 2s wait",
    "People cards show name, title, connection degree — extractable via a11y tree"
  ],
  "errors": [],
  "model_reasoning_excerpts": [
    "The search input has role=combobox and appears collapsed. I'll click it first to activate.",
    "Results loaded. I can see 10 people cards. Filtering for Anthropic employees."
  ]
}
```

### 2.2 Storage

Traces stored in `benchmark/traces/{run_id}/{task_id}.json`. One directory per benchmark run.

### 2.3 Trace → Recipe Pipeline

```
Benchmark run completes
    ↓
Post-processing script extracts domain_observations from all traces
    ↓
Groups observations by domain
    ↓
Deduplicates (fuzzy match against existing recipes)
    ↓
New observations become CANDIDATE recipes in recipes/candidates/
    ↓
Human review (you): promote to active, edit, or discard
    ↓
Active recipes in recipes/domains/{domain}.json
    ↓
Next benchmark run: recipes injected into tool responses
    ↓
Success delta measured: did recipes help?
```

---

## 3. Recipe System (3 Layers)

### 3.1 Layer 1: Domain Knowledge (Facts)

Curated facts about how specific sites work. Stored per-domain.

**File**: `recipes/domains/{domain}.json`

```json
{
  "domain": "linkedin.com",
  "facts": [
    {
      "id": "li-001",
      "fact": "Search combobox requires click-to-focus before fill",
      "confidence": 0.9,
      "votes": { "up": 5, "down": 0 },
      "source": ["bench-20260413-001", "manual:aakash"],
      "valid_since": "2026-04-13",
      "tags": ["search", "interaction"]
    },
    {
      "id": "li-002",
      "fact": "Feed posts load dynamically on scroll — snapshot captures only visible portion. Scroll + re-snapshot to see more.",
      "confidence": 0.85,
      "votes": { "up": 3, "down": 1 },
      "source": ["bench-20260413-002"],
      "valid_since": "2026-04-13",
      "tags": ["feed", "dynamic-content"]
    }
  ],
  "last_verified": "2026-04-13"
}
```

**Delivery**: Injected into `safari_snapshot` response as `domain_hints[]` when the tab URL matches the domain.

### 3.2 Layer 2: Recorded Workflows (AWM-style)

Abstracted multi-step procedures, parameterized for reuse across domains.

**File**: `recipes/workflows/{workflow-id}.json`

```json
{
  "id": "wf-search-extract",
  "name": "Search and extract results",
  "description": "Find the site's search input, enter a query, submit, extract N results",
  "parameters": {
    "query": "The search terms",
    "result_count": "Number of results to extract (default: 5)"
  },
  "steps": [
    "snapshot → find element with role=searchbox or role=combobox containing 'search'",
    "If combobox: click to activate first",
    "fill search input with {query}",
    "press Enter or click search/submit button",
    "wait 2s for results",
    "snapshot → extract first {result_count} result items"
  ],
  "applicable_domains": ["*"],
  "success_rate": 0.82,
  "avg_steps": 6,
  "source_traces": ["bench-20260413-001", "bench-20260413-003", "bench-20260414-002"]
}
```

**Delivery**: Listed in `safari_snapshot` response as `applicable_workflows[]` when relevant to the page state (e.g., if a search input is detected).

### 3.3 Layer 3: Learned Heuristics (ExpeL-style)

Cross-domain behavioral rules extracted from success/failure patterns. Confidence-scored via voting.

**File**: `recipes/heuristics.json`

```json
{
  "heuristics": [
    {
      "id": "h-001",
      "rule": "On SPAs (no full page reload after navigation), always take a fresh snapshot after clicking a link — the DOM updates in-place without URL change",
      "confidence": 0.92,
      "votes": { "up": 12, "down": 1 },
      "evidence": ["bench-20260413-002", "bench-20260414-001", "bench-20260415-003"],
      "scope": "global"
    },
    {
      "id": "h-002",
      "rule": "When a fill action fails with 'element not editable', try clicking the element first — many comboboxes and custom inputs require focus activation",
      "confidence": 0.88,
      "votes": { "up": 7, "down": 1 },
      "evidence": ["bench-20260413-001"],
      "scope": "global"
    }
  ]
}
```

**Delivery**: Top-N heuristics (by confidence * votes) injected into `safari_snapshot` response as `heuristics[]`. Always included regardless of domain — these are universal patterns.

### 3.4 Recipe Lifecycle

```
CANDIDATE → ACTIVE → VALIDATED → GRADUATED
    ↓           ↓          ↓
 (discard)  (downvoted → demoted)  (promoted to heuristic if cross-domain)
```

- **Candidate**: Auto-extracted from traces or manually added. Not yet delivered to Claude.
- **Active**: Promoted by human review. Delivered in tool responses.
- **Validated**: Confirmed by subsequent benchmark runs (task using this hint succeeded).
- **Graduated**: Domain fact that generalizes → becomes a heuristic.

### 3.5 Manual Input

You can add recipes directly:

```bash
# Add a domain fact
echo '{"fact": "X feed auto-refreshes — new posts appear at top without scroll", "tags": ["feed", "dynamic"]}' | npx safari-pilot recipe add --domain x.com

# Add a heuristic
echo '{"rule": "Always check for cookie consent banners before interacting with page content"}' | npx safari-pilot recipe add --heuristic
```

---

## 4. Eval Framework

### 4.1 Post-Merge Automation

```
git merge to main
    ↓
post-merge hook: npx safari-pilot-bench
    ↓
Run Tier 1 (local fixtures) — <2 minutes
    ↓
Run Tier 2 (live sites) — 5-10 minutes
    ↓
Run Tier 3 (authenticated) — 5-10 minutes
    ↓
Run competitive tasks (if Playwright available) — 5-10 minutes
    ↓
Generate report → benchmark/reports/{date}-{commit}.md
    ↓
Compare to previous baseline → highlight deltas
    ↓
If regression >2% on any category → flag prominently
```

### 4.2 Delta Report Format

```markdown
# Safari Pilot Benchmark Report
**Run:** bench-20260413-003 | **After:** feat/file-downloads | **Commit:** abc1234

## Overall: 96/120 tasks passed (80.0%) — ↑ 4.2% from baseline

| Category | Pass | Rate | Delta |
|----------|------|------|-------|
| Navigation | 15/15 | 100% | — |
| Form interaction | 14/15 | 93% | ↑ 6.7% |
| Multi-step workflows | 9/12 | 75% | ↑ 8.3% |
| Intelligence-tier | 3/12 | 25% | ↑ 8.3% ← improving! |
| Competitive (vs PW) | 8/12 | 67% | ↑ 8.3% |

## Competitive Breakdown
Safari Pilot: 8/12 (67%) | Playwright: 7/12 (58%)
SP wins: authenticated (5/5 vs 0/5), form filling (2/2 vs 1/2)
PW wins: element screenshot (0/1 vs 1/1), HAR replay (0/1 vs 1/1)

## Intelligence Tier Progress
3/12 passing (25%) — up from 2/12 (16.7%) last run
Newly passing: intel-006 (HN login error detection)
Still failing: intel-002 (X profile navigation), intel-003 (LinkedIn people search)

## New Recipe Candidates (from traces)
- "Reddit: comment threads load lazily — click 'load more' to expand" (from intel-004 failure)
- "GitHub: trending page uses date-range selector, not scroll-based loading" (from intel-007 success)

## Regression Alerts
None — all categories stable or improved.
```

### 4.3 Historical Tracking

`benchmark/history.json` accumulates run-over-run metrics:

```json
{
  "runs": [
    {
      "id": "bench-20260412-001",
      "commit": "841d36e",
      "after": "baseline",
      "overall": 0.767,
      "intelligence": 0.167,
      "competitive_win_rate": 0.583
    },
    {
      "id": "bench-20260413-003",
      "commit": "abc1234",
      "after": "feat/file-downloads",
      "overall": 0.800,
      "intelligence": 0.250,
      "competitive_win_rate": 0.667
    }
  ]
}
```

This powers an improvement graph: X axis = roadmap items shipped, Y axis = success rates. The intelligence-tier line climbing is the recipe system's KPI.

---

## 5. Roadmap Integration

### Sequencing

| Phase | What | When |
|-------|------|------|
| **Phase 1** | Benchmark suite v1 (task definitions, runner, eval, reporting) | Next roadmap item |
| **Phase 2** | Trace capture (auto-generated from benchmark runs) | Built into Phase 1 |
| **Phase 3** | Run benchmarks after every subsequent roadmap item | Ongoing |
| **Phase 4** | Recipe system (domain knowledge, workflows, heuristics, MCP delivery) | Back-end of roadmap |
| **Phase 5** | Close the loop (recipes improve benchmark scores, tracked automatically) | After Phase 4 |

### New Roadmap Items

Add to existing roadmap:

- **P1: Benchmark Suite** — task definitions, runner, eval engine, delta reports, competitive mode
- **P3: Recipe System** — 3-layer architecture, MCP-native delivery, trace-to-recipe pipeline, manual input CLI
- **P3: Intelligence Eval** — intelligence-tier tasks, LLM-judge fallback eval, historical tracking

---

## 6. What This Enables

**Short-term (Phases 1-3):** Every roadmap item ships with a measurable improvement number. "File downloads added: +4.2% overall, +8.3% on multi-step workflows." Competitive comparison shows where Safari Pilot leads and trails.

**Medium-term (Phase 4):** Recipes inject domain knowledge into tool responses. Claude doesn't need to rediscover that LinkedIn search requires click-to-focus — it's told upfront. Success rates climb.

**Long-term (Phase 5):** The system improves itself. Each benchmark run generates traces → traces become recipes → recipes improve next run → cycle repeats. The intelligence-tier success rate is the ultimate metric: when it crosses 80%, Safari Pilot operates like a skilled human on the web.

**Competitive moat:** No other browser tool has this feedback loop. Playwright, Browser Use, Stagehand — they're all stateless. Safari Pilot gets better with every use. That's the moat.
