# Browser Automation Benchmarks & Evaluation Frameworks

Research report for designing Safari Pilot's benchmark suite. Covers the major web agent evaluation ecosystems, their methodologies, scores, limitations, and concrete recommendations for Safari Pilot.

---

## 1. The Benchmark Landscape: An Overview

The web agent evaluation space has matured rapidly since 2023. Nine major benchmarks now exist, each testing different facets of browser automation capability. They fall into three tiers:

**Sandboxed environments** (WebArena, VisualWebArena, WorkArena) -- self-hosted Docker containers with deterministic state, programmatic evaluation, full reproducibility. The gold standard for rigorous measurement but limited in website diversity.

**Live-web benchmarks** (Mind2Web / Online-Mind2Web, WebVoyager, AssistantBench) -- agents interact with real websites, testing generalization and robustness to layout changes. Higher ecological validity but lower reproducibility.

**Meta-frameworks** (BrowserGym, AgentLab) -- unified interfaces that wrap multiple benchmarks under a single observation/action API, enabling apples-to-apples comparison.

| Benchmark | Tasks | Environment | Evaluation | Top Score | Human |
|---|---|---|---|---|---|
| WebArena | 812 | Self-hosted Docker (5 sites) | Programmatic | 71.6% (OpAgent) | ~78% |
| WebArena Verified | 812 (audited) | Same Docker containers | Programmatic + backend state | -- | ~78% |
| VisualWebArena | 910 | Self-hosted (3 sites + images) | Programmatic | ~26% (GPT-4V + SoM) | -- |
| Mind2Web | 2,350 | Cached real websites (137 sites) | Element accuracy, step F1 | ~23% strict (GPT-4) | -- |
| Online-Mind2Web | 300 | Live websites (136 sites) | WebJudge (LLM, ~85% agreement) | 97% (Browser Use Cloud) | -- |
| WebVoyager | 643 | Live websites (15 sites) | GPT-4V auto-eval (85.3% agreement) | ~73% (Agent-E) | -- |
| AssistantBench | 214 | Live open web (258 sites) | Token F1 against gold answers | <25% (any model) | -- |
| WorkArena | 29 tasks / 18,050 instances | ServiceNow cloud platform | Programmatic | ~55% (GPT-4) | -- |
| BrowserGym | Wraps 6+ benchmarks | Unified Gym API over Playwright | Benchmark-specific | Per-benchmark | -- |

---

## 2. Benchmark Deep Dives

### 2.1 WebArena

**The reference benchmark.** Introduced July 2023 (NeurIPS 2024 Oral), WebArena provides 812 tasks across five self-hosted web applications: an e-commerce store (OneStopShop), a social forum (Reddit clone), GitLab, a CMS (Joomla), and a map tool. Tasks are defined in JSON with fields for `intent` (natural language instruction), `start_url`, `eval` (evaluation function specification), and `require_login`.

**Task categories:**
- Information seeking (text-based answers): exact match, must-include, fuzzy match via GPT-4
- Site navigation: programmatic URL verification
- Content/config modification: database state verification via REST API queries

**Success measurement** is execution-based: the evaluation harness checks whether the final state (URL, page content, database row) matches the expected outcome. No LLM judge is needed for the core evaluation, making it fully deterministic.

**Leaderboard evolution:** GPT-4 baseline scored 14.41% in July 2023. By early 2026, OpAgent (CodeFuse AI) reached 71.6%, and agents like Kimi-K2.5 hit 58.9%. The leap from 14% to ~60% came not from a single breakthrough but from converging on a Planner-Executor-Memory architecture with specialized training data.

**WebArena Verified** (ServiceNow, 2025) audited all 812 tasks, finding 257 with evaluation issues -- 46 with misaligned reference answers, 211 with ambiguous task specifications. It replaced brittle string matching with backend state verification and introduced a structured JSON response schema for deterministic scoring. WebArena Verified Hard is a 137-task subset that preserves ranking fidelity while reducing compute by 83%.

**WebArena-Infinity** (2026) addresses scalability: 10 auto-generated environments with 1,260 tasks spanning careers, DevOps, finance, healthcare, productivity, and project management. Success rates are notably lower (Kimi-K2.5: 45.9% vs. 58.9% on original WebArena), suggesting the generated tasks are meaningfully harder.

**Limitations:** Only five website types. English-only. Static environments don't capture real-world dynamism. The Docker setup requires significant compute (each environment is a separate container).

### 2.2 Mind2Web and Online-Mind2Web

**Mind2Web** (NeurIPS 2023 Spotlight, Ohio State) is a dataset of 2,350 tasks from 137 real websites spanning 31 domains. Each task includes crowdsourced action sequences (average 7.3 actions per task). The key innovation is testing generalization at three levels: cross-task (same website), cross-website (same domain), and cross-domain.

**Evaluation metrics** are step-level: element accuracy (did the agent select the right HTML element?), operation F1 (correct action type?), and step success rate (both correct?). This is fundamentally different from WebArena's outcome-based evaluation -- Mind2Web measures trajectory quality, not just final state.

**The offline problem:** Original Mind2Web uses cached website snapshots, which cannot capture dynamic content. The agent follows the annotated reference trajectory rather than exploring freely. This led to inflated scores.

**Online-Mind2Web** (April 2025) addresses this with 300 tasks on 136 live websites, stratified by difficulty: 83 easy (<=5 steps), 143 medium (6-10), 74 hard (>=11). It introduced WebJudge, an LLM-based evaluation pipeline achieving ~85% agreement with human annotators. The benchmark exposed a harsh truth: agents claiming ~90% on the original WebVoyager scored only ~30% under strict live evaluation. As of early 2026, Browser Use Cloud reached 97% by using an auto-research loop with Claude Code, while OpenAI Operator scored 61%.

**Mind2Web 2** (NeurIPS 2025 D&B Track) pivots to evaluating agentic search systems with 130 long-horizon tasks requiring real-time web browsing and extensive information synthesis, using an Agent-as-a-Judge framework.

### 2.3 WebVoyager

**WebVoyager** (ACL 2024) is the standard multimodal web agent benchmark with 643 tasks across 15 popular websites (Amazon, Apple, Arxiv, GitHub, Google Flights, Google Maps, Google Search, Hugging Face, etc.). It was the first to demonstrate vision-language agents operating on real websites with screenshot-based observation.

**Action space:** CLICK, TYPE, SCROLL, WAIT, BACK, JUMP/GOOGLE, ANSWER. Each step, the agent sees a screenshot with numbered bounding boxes over interactive elements plus auxiliary text (element type, aria-label).

**Evaluation** uses GPT-4V as an automatic judge, achieving 85.3% agreement with human evaluation. Tasks have two answer classes: golden answers (fixed, short) and possible answers (time-sensitive or open-ended). Scoring is binary per task -- no partial credit.

**Emergence WebVoyager** (2025) is an enhanced version with improved task formulation achieving 95.9% inter-annotator agreement. It demonstrated that OpenAI Operator scored 68.6% under rigorous evaluation, substantially lower than the 87% OpenAI self-reported, highlighting the importance of independent evaluation.

**Limitations:** 15 websites is a narrow sample. Live websites change, making reproducibility difficult. The GPT-4V judge can disagree with humans on edge cases. No measurement of step efficiency -- an agent succeeding in 100 steps and one succeeding in 5 score identically.

### 2.4 VisualWebArena

**VisualWebArena** (ACL 2024, CMU) extends WebArena with 910 tasks requiring visual understanding: image comprehension, visual grounding, and multimodal reasoning. It adds three websites: a Classifieds site with product images, a Reddit clone with image posts, and shopping with visual product comparisons.

**What visual benchmarks measure that DOM-based ones miss:**
- Recognizing products from images rather than text descriptions
- Understanding charts, graphs, and visual layouts
- Interpreting screenshots where the relevant information is rendered visually (not in the DOM text)
- Spatial reasoning about where elements appear on screen

**Results** were sobering: GPT-4V + Set-of-Mark (the best approach at publication) achieved only ~16.4% on the full benchmark. Even with oracle accessibility trees, performance barely reached 26%. This demonstrated that current multimodal agents struggle significantly with visual web understanding.

### 2.5 WorkArena

**WorkArena** (ServiceNow, 2024) evaluates agents on 29 task types with 18,050 unique instances built on the ServiceNow enterprise platform -- a real cloud-based SaaS application. Tasks represent common knowledge worker activities: creating records, filling forms, navigating complex enterprise UIs, updating database entries, and using dashboards.

**Enterprise-specific challenges:**
- Massive DOM sizes (100k+ tokens per page)
- Non-standard HTML and complex UI components (iframes, shadow DOMs)
- Domain-specific knowledge requirements (ServiceNow concepts)
- Memory management for partially observable MDPs

GPT-4 achieved ~55% success rate; open-source models scored far lower. The benchmark revealed a significant performance gap between closed and open-source LLMs on enterprise tasks.

**WorkArena++** expanded to more complex, compositional tasks involving multi-step reasoning across ServiceNow modules.

### 2.6 AssistantBench

**AssistantBench** (EMNLP 2024) is the hardest benchmark for open-web navigation: 214 realistic, time-consuming tasks requiring interaction with multiple websites (525+ pages across 258 sites). Example task: "What's the highest price a high-rise apartment was sold for in Mission Bay, San Francisco, in 2021?"

**Evaluation** uses token F1 against gold-standard answers, measuring both accuracy (did you find the right information?) and precision (did you hallucinate?).

**Results are brutal:** No model exceeds 25% accuracy. State-of-the-art web agents (SeeAct) scored near zero. Even closed-book LLMs that guess answers score higher than web agents, though they hallucinate heavily. The SeePlanAct (SPA) agent improved over prior agents, and an ensemble of SPA + closed-book model reached the best overall performance.

### 2.7 BrowserGym

**BrowserGym** (ServiceNow, TMLR 2025) is not a benchmark but the unifying framework. It implements a POMDP architecture with standardized observation and action spaces, built on Chromium/Playwright.

**Observation space:** DOM snapshot, accessibility tree, viewport screenshot, chat messages, error feedback from last action -- all configurable.

**Action space:** Hierarchical, from raw Playwright Python code (maximum flexibility, maximum risk) to a constrained high-level set (`click(bid)`, `type(bid, text)`, `scroll(direction)`, etc.).

**Currently wraps:** MiniWoB++, WebArena, VisualWebArena, WorkArena, AssistantBench, and WebLINX. Any new benchmark can be integrated by implementing four functions: `setup()`, `teardown()`, `validate()`, and optionally `cheat()`.

**AgentLab** is the companion framework for building agents, running experiments, and analyzing results at scale. The BrowserGym ecosystem includes a public leaderboard on HuggingFace.

### 2.8 SWE-bench Methodology Lessons

SWE-bench (Princeton, 2023) evaluates coding agents on 2,294 real GitHub issues. While not browser-focused, its methodology is instructive:

**Anti-contamination design:** Solutions are evaluated against held-out test suites the agent never sees. SWE-bench Pro (2026) goes further with a three-tier split: public (731 instances), commercial/private (276), and held-out (858). The held-out set exists solely to detect future overfitting against the public set.

**Automated verification:** Every solution is tested by running the project's actual test suite -- no LLM judge needed for pass/fail. This is maximally objective.

**Saturation awareness:** OpenAI's February 2026 analysis found that 59.4% of audited SWE-bench Verified problems had material issues (ambiguous specs, flawed tests), and training data contamination was detectable in frontier models. This led to SWE-bench Pro with contamination-resistant design.

**Key lessons for Safari Pilot:**
1. Hold-out test sets are essential for detecting overfitting
2. Contamination from public data is a real risk for public benchmarks
3. Difficulty calibration matters -- mix easy tasks (high baseline) with genuinely hard tasks
4. Automated verification beats LLM judges for determinism

---

## 3. How Teams Track Benchmark Improvement Over Time

### 3.1 Evaluation Infrastructure Patterns

**Capability evals vs. regression evals** (LangChain pattern): Capability evals start with low pass rates and measure progress on hard tasks. Regression evals should maintain ~100% pass rates and catch backsliding. The two serve different purposes and should be tracked separately.

**CI/CD integration flow:**
1. Code/prompt change triggers pipeline
2. Offline evals run (unit tests, integration tests, curated datasets)
3. Preview deployment if offline evals pass
4. Online evals against preview with live data
5. Promote to production only if all quality gates pass

**Anti-overfitting in auto-research loops** (Browser Use approach): Train/validation splits where the optimization loop only sees training data. Reject task-specific solutions during merge review. Run on old datasets the loop has never seen to verify generalization.

### 3.2 Metrics That Matter

From Playwright's test quality tracking, adapted for agent benchmarks:

| Metric | Definition | Target |
|---|---|---|
| Task success rate | % of benchmark tasks completed correctly | Track over time |
| Flaky rate | % of tasks that pass/fail non-deterministically | Below 2% |
| Step efficiency | Average actions per successful task | Decreasing |
| Token cost | Average LLM tokens consumed per task | Track for budget |
| Duration | Wall-clock time per task | Stable or decreasing |
| Engine degradation rate | % of tasks requiring fallback to lower engine | Decreasing |

### 3.3 Playwright's Own Quality Patterns

Playwright's framework offers patterns directly applicable to Safari Pilot's benchmark:

**Flakiness detection:** Tests that fail on first attempt but pass on retry are automatically tagged "flaky." The `--fail-on-flaky-tests` flag treats any retry-required pass as a hard failure -- critical for benchmark integrity.

**Trace analysis:** Compressed archives containing DOM snapshots, screenshots, network waterfall, console logs, and action timeline at every step. Comparing traces from passing vs. failing runs reveals the exact divergence point.

**Key metrics tracked:** Pass rate, flaky rate, MTTR (mean time to resolution), duration trends, environment correlation (failures tied to specific runners).

---

## 4. Comparison: What Each Benchmark Tests vs. Misses

| Capability | WebArena | Mind2Web | WebVoyager | Visual WA | WorkArena | AssistantBench |
|---|---|---|---|---|---|---|
| Navigation | Strong | Strong | Strong | Strong | Strong | Strong |
| Form filling | Strong | Moderate | Moderate | Moderate | Strong | Weak |
| Data extraction | Moderate | Moderate | Moderate | Weak | Strong | Strong |
| Multi-step workflows | Strong | Moderate | Moderate | Moderate | Strong | Strong |
| Visual understanding | None | None | Strong | Core focus | None | None |
| Cross-site tasks | Weak (5 sites) | Strong (137) | Moderate (15) | Weak (3) | Weak (1) | Strong (258) |
| Enterprise UI | None | None | None | None | Core focus | None |
| Dynamic content | Weak | Cached only | Real-time | Weak | Real-time | Real-time |
| Authentication | Basic | None | None | Basic | Full | None |
| Reproducibility | Excellent | Good (cached) | Poor (live) | Excellent | Good (cloud) | Poor (live) |

**What no current benchmark tests:**
- Safari-specific behaviors (AppleScript, Web Extension API, macOS integration)
- Shadow DOM traversal and CSP bypass scenarios
- Cross-origin iframe interaction
- Tab management across multiple windows
- Accessibility tree navigation as primary strategy
- Performance under degraded conditions (slow network, large DOM)

---

## 5. Recommendations for Safari Pilot's Benchmark Suite

### 5.1 Task Categories

Based on Safari Pilot's 74-tool surface area and three-tier engine model:

| Category | Example Tasks | Count Target | Engine Coverage |
|---|---|---|---|
| **Navigation** | Open URL, follow links, back/forward, tab management | 15-20 | All engines |
| **Form interaction** | Fill text, select dropdowns, checkboxes, date pickers | 15-20 | All engines |
| **Data extraction** | Read text, extract tables, scrape structured data | 15-20 | All engines |
| **Multi-step workflows** | Search + filter + extract + compare across tabs | 10-15 | Extension preferred |
| **DOM complexity** | Shadow DOM elements, iframes, dynamic content | 8-12 | Extension required |
| **Authentication flows** | Login, handle OAuth redirects, session management | 5-8 | AppleScript + Extension |
| **Accessibility** | Navigate via a11y tree, screen reader compatible actions | 5-8 | All engines |
| **Error recovery** | Handle popups, cookie banners, stale elements, timeouts | 5-8 | All engines |
| **Performance** | Large DOM pages, image-heavy sites, slow networks | 5-8 | Daemon preferred |
| **Safari-specific** | AppleScript execution, tab ID scheme, extension health | 5-8 | Engine-specific |

**Target: 90-130 tasks total**, spanning easy (single tool call), medium (3-5 tools), and hard (10+ tools, multi-tab, error recovery). Difficulty calibration: aim for 30% easy, 45% medium, 25% hard based on the WebArena/Online-Mind2Web stratification pattern.

### 5.2 Success Metrics

For each task, measure:

1. **Binary success** -- did the task complete correctly? (Primary metric, matches WebArena)
2. **Step count** -- how many tool calls to completion? (Efficiency, matches Agent-E)
3. **Engine used** -- which engine handled it? Track degradation patterns
4. **Wall-clock time** -- end-to-end duration including engine selection
5. **Error recovery count** -- how many retries/fallbacks occurred?

**Aggregate metrics per benchmark run:**
- Task success rate (overall and per category)
- Mean steps per successful task
- Engine utilization distribution
- P50/P95 task duration
- Flaky task count (tasks that pass/fail non-deterministically across runs)

### 5.3 Task Definition Format

Adopt a JSON schema inspired by WebArena Verified's structured approach:

```json
{
  "id": "nav-001",
  "category": "navigation",
  "difficulty": "easy",
  "intent": "Navigate to https://example.com and extract the page title",
  "start_state": {
    "url": "about:blank",
    "tabs": 1
  },
  "tools_expected": ["safari_new_tab", "safari_navigate", "safari_get_text"],
  "engine_requirement": null,
  "eval": {
    "type": "exact_match",
    "field": "extracted_text",
    "expected": "Example Domain"
  },
  "eval_fallback": {
    "type": "contains",
    "field": "extracted_text",
    "expected": "Example"
  },
  "timeout_ms": 30000,
  "tags": ["navigation", "extraction", "basic"]
}
```

For state-modification tasks, verify via a secondary extraction:
```json
{
  "eval": {
    "type": "state_check",
    "verify_action": "safari_get_text",
    "verify_params": {"selector": "#result"},
    "expected_contains": "Form submitted successfully"
  }
}
```

### 5.4 Environment Approach

**Hybrid: sandboxed local sites for core tests, live sites for generalization tests.**

**Tier 1: Local sandboxed sites (70% of tasks)**
- Ship simple static HTML test fixtures in `test/fixtures/benchmark/` for navigation, forms, extraction
- Use a lightweight local HTTP server (already vitest pattern in the project)
- Deterministic, fast, reproducible -- can run in CI without network
- Cover all engine-specific capabilities (Shadow DOM, iframes, CSP scenarios)

**Tier 2: Stable public sites (20% of tasks)**
- Use high-stability sites: Wikipedia, government sites, major platforms with stable layouts
- Resilient assertions: check for content patterns, not exact strings (lessons from Mind2Web's cached snapshots becoming stale)
- Accept some flakiness -- track flaky rate separately, quarantine with `@flaky` tags

**Tier 3: Regression snapshots (10% of tasks)**
- Record HAR files from live site interactions during manual verification
- Replay against recorded network responses for deterministic testing
- Update snapshots quarterly or when flakiness exceeds threshold

### 5.5 Automated Execution After Every Roadmap Ship

```
roadmap item ships
    |
    v
git merge to main
    |
    v
postmerge hook triggers benchmark run
    |
    v
Tier 1 (local fixtures) -- runs in <2 minutes
    |
    v
Tier 2 (live sites) -- runs in <10 minutes, non-blocking
    |
    v
Results appended to benchmark-results.json
    |
    v
Compare against previous run:
  - Success rate delta (alert if >5% regression)
  - New failures (list specific task IDs)
  - Flaky task changes
    |
    v
Summary in PR comment or commit message
```

**Implementation:** A `scripts/run-benchmark.sh` that:
1. Starts the MCP server in benchmark mode
2. Iterates through task definitions
3. Executes each task's tool sequence
4. Evaluates results against expected outcomes
5. Writes structured results JSON
6. Compares against baseline and outputs delta report

### 5.6 Tracking Improvement Over Time

**Storage:** `benchmark-results/` directory (gitignored, but baseline committed):
```
benchmark-results/
  baseline.json          # Committed: initial benchmark scores
  latest.json            # Gitignored: most recent run
  history/
    2024-04-13-a1b2c3.json  # Gitignored: per-run results keyed by date + commit
```

**Dashboard (lightweight):** A `scripts/benchmark-report.sh` that reads `history/*.json` and outputs:
- Task success rate trend (ASCII sparkline or markdown table)
- Per-category trends
- Newly passing tasks (capabilities gained)
- Newly failing tasks (regressions)
- Flaky task list with stability scores

**Regression detection:** If overall success rate drops by more than 2 percentage points compared to the running 3-run average, flag it in the commit output. This catches both single-commit regressions and gradual degradation.

**Anti-gaming:** Since this is an internal benchmark (not a public leaderboard), the main risk is tasks becoming trivially easy over time. Mitigate by:
1. Adding new hard tasks when overall success rate exceeds 85%
2. Periodically refreshing Tier 2 live-site tasks when sites change
3. Never optimizing specifically for benchmark tasks -- the benchmark measures the tools, not the test suite
4. Maintaining a "held-out" set of 10-15 tasks that are only run quarterly, not after every ship

---

## 6. Key Insights for Safari Pilot

1. **Outcome-based evaluation beats trajectory-based.** WebArena's "did the final state match?" approach is more robust than Mind2Web's "did the agent click the right element at each step?" Safari Pilot should verify results, not paths.

2. **Programmatic evaluation beats LLM judges.** WebArena Verified's shift to backend state verification and structured JSON schemas eliminated the non-determinism of LLM-as-judge evaluation. For a tool-level benchmark, every evaluation should be code, not an LLM call.

3. **Flakiness is the benchmark killer.** Online-Mind2Web and WebVoyager scores vary wildly between evaluations because live sites change. Safari Pilot's Tier 1 local fixtures solve this for core capability testing.

4. **The 14% to 60% WebArena journey shows tools matter.** The biggest performance gains came from better tool design (specialized executors, structured memory), not better models. Safari Pilot's benchmark directly measures tool quality -- the right thing to optimize.

5. **Enterprise and accessibility are underserved.** WorkArena is the only enterprise benchmark; no benchmark specifically tests accessibility-first navigation. Safari Pilot's a11y tree approach and macOS integration are differentiated capabilities worth benchmarking explicitly.

6. **Start small, grow deliberately.** AssistantBench has only 214 tasks but provides strong signal. Safari Pilot should start with ~90 well-crafted tasks covering all tool categories, then expand based on failure analysis rather than trying to build 800+ tasks upfront.

---

## Sources

- WebArena: Zhou et al., 2023. [arxiv.org/abs/2307.13854](https://arxiv.org/abs/2307.13854), [webarena.dev](https://webarena.dev)
- WebArena Verified: El Hattami et al., 2025. [openreview.net/pdf?id=94tlGxmqkN](https://openreview.net/pdf?id=94tlGxmqkN)
- WebArena-Infinity: [webarena.dev/webarena-infinity](https://webarena.dev/webarena-infinity/)
- Mind2Web: Deng et al., 2023. [arxiv.org/abs/2306.06070](https://arxiv.org/abs/2306.06070)
- Online-Mind2Web: Xue et al., 2025. [arxiv.org/abs/2504.01382](https://arxiv.org/html/2504.01382v4)
- Mind2Web 2: [osu-nlp-group.github.io/Mind2Web-2](https://osu-nlp-group.github.io/Mind2Web-2/)
- WebVoyager: He et al., 2024. [arxiv.org/abs/2401.13919](https://arxiv.org/abs/2401.13919)
- Emergence WebVoyager: [arxiv.org/html/2603.29020v1](https://arxiv.org/html/2603.29020v1)
- VisualWebArena: Koh et al., 2024. [github.com/web-arena-x/visualwebarena](https://github.com/web-arena-x/visualwebarena)
- WorkArena: Drouin et al., 2024. [arxiv.org/abs/2403.07718](https://arxiv.org/html/2403.07718v2)
- AssistantBench: Yoran et al., 2024. [arxiv.org/abs/2407.15711](https://arxiv.org/abs/2407.15711)
- BrowserGym: Le Sellier de Chezelles et al., 2025. [arxiv.org/abs/2412.05467](https://openreview.net/pdf/1b24a5f7440305cc3a2c96de2c7917e5fb4cbd5b.pdf)
- SWE-bench: Jimenez et al., 2024. [swebench.com](https://www.swebench.com)
- SWE-bench Pro: [static.scale.com/uploads/.../SWEAP_Eval_Scale.pdf](https://static.scale.com/uploads/654197dc94d34f66c0f5184e/SWEAP_Eval_Scale%20(9).pdf)
- BrowseComp: Wei et al., 2025. [openai.com/index/browsecomp](https://openai.com/index/browsecomp/)
- Browser Use Online-Mind2Web results: [browser-use.com/posts/online-mind2web-benchmark](https://browser-use.com/posts/online-mind2web-benchmark)
- LangChain Agent Eval Checklist: [blog.langchain.com/agent-evaluation-readiness-checklist](https://blog.langchain.com/agent-evaluation-readiness-checklist/)
- Steel.dev Leaderboard: [leaderboard.steel.dev](https://leaderboard.steel.dev/)
- Playwright Trace Viewer: [playwright.dev/docs/trace-viewer](https://playwright.dev/docs/trace-viewer)
- Playwright Retries: [playwright.dev/docs/test-retries](https://playwright.dev/docs/test-retries)
