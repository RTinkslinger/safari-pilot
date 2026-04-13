# Competitive Research: AI-Native Browser Automation Agents

**Date:** 2026-04-13
**Purpose:** Inform Safari Pilot's benchmark suite and learning/recipe system design
**Sources:** GitHub repos, official documentation, blog posts, arxiv papers, benchmark publications

---

## 1. Browser Use

**Repo:** [github.com/browser-use/browser-use](https://github.com/browser-use/browser-use) | **Stars:** 87.4k | **Language:** Python | **License:** MIT
**Latest version:** v0.12.6 (Apr 2026) | **Growth rate:** 24x in 2025, from ~3k to 74k stars

### Page State Representation

Browser Use employs a **DOM distillation** approach. It parses the page's DOM tree and strips it down to essential interactive elements, assigning each a numeric index. The agent sees a flat list of interactive elements with their type, text content, and index number rather than raw HTML. It also supports **screenshot-based vision** as a secondary input for multimodal models. The `highlight_elements` option renders colored bounding boxes over interactive elements for vision models. A `paint_order_filtering` option removes elements hidden behind others to reduce token consumption.

### Element Targeting

Integer-indexed element references. The agent calls actions like `click(index=5)` or `type(index=12, text="hello")`. This was the approach that pioneered the "numbered element" paradigm now widely copied. Also supports coordinate-based clicking for elements not captured by DOM distillation.

### Action Model

Agentic loop with **structured memory parameter**. Each tool call includes `evaluation_previous_goal`, `memory` (agent-written summary of progress), and `next_goal`. This self-narration pattern, originally introduced by Browser Use, has become the standard approach. The agent operates in a loop: observe state, reason about next action, execute, evaluate result. Supports multi-tab operations and task chaining via `agent.add_new_task()` with persistent browser sessions.

### Learning/Memory

**No cross-session learning in core**. Within a session, the memory parameter provides compressed history. A rolling buffer of the last 40-50 steps is kept in full detail; older steps are summarized. The community has proposed extensions (see Discussion #1176: "self-learning and memory") but the core framework does not persist domain knowledge. The research paper "WebCoach" (arxiv 2511.12997) demonstrates that adding cross-session episodic memory to Browser Use agents consistently improves WebVoyager scores across multiple LLM backbones.

### Benchmarks

- **WebVoyager:** 89.1% success rate (586 tasks) -- current state-of-the-art for open-source agents
- Referenced in the arxiv paper "Building Browser Agents" (2511.19477) as achieving highest open-source WebVoyager scores

### Architecture

Python SDK built on **Playwright**. Runs locally or connects to cloud browsers. Model-agnostic via LiteLLM (OpenAI, Anthropic, Google, local models). Also offers a **CLI** (`browser-use open`, `browser-use state`, `browser-use click`) with a persistent daemon for fast iteration (~50ms latency). Cloud platform available at cloud.browser-use.com.

### Key Differentiator

Most popular open-source framework. Pioneered the DOM distillation + numbered index + memory parameter pattern that has become the industry standard. Model-agnostic design and strong community.

### Weakness

No built-in cross-session learning. No visual grounding beyond optional screenshots. Token consumption can be high on complex pages despite distillation. The CLI and cloud product are relatively new (2026).

---

## 2. Stagehand

**Repo:** [github.com/browserbase/stagehand](https://github.com/browserbase/stagehand) | **Stars:** 21.8k | **Language:** TypeScript | **License:** MIT
**Latest version:** v2.1.0 (Apr 2026); v3 (CDP-native) in development

### Page State Representation

Stagehand takes a **hybrid code + AI** approach. Developers write the automation flow in TypeScript; AI handles the flexible parts. v3 moved to a **CDP-native architecture** that talks directly to the browser through Chrome DevTools Protocol, removing the Playwright dependency. It processes the DOM to identify interactive elements and collapses redundant text nodes into parent elements for efficiency.

### Element Targeting

Three primary methods:
- **`act(instruction)`**: Natural language instruction translated to browser actions. Under the hood, Stagehand identifies elements via DOM analysis and LLM reasoning.
- **`observe()`**: Returns a list of possible actions on the current page for the agent to choose from.
- **`extract(instruction, schema)`**: Pulls structured data matching a Zod schema. Supports targeted extraction via XPath `selector` parameter.

v3 added `agent()` for multi-step autonomous tasks: `stagehand.agent().execute("Get to the latest PR")`.

### Action Model

Hybrid: deterministic code paths for reliable steps, AI for variable elements. This is fundamentally different from fully autonomous agents like Browser Use. Developers maintain control of the workflow structure while delegating element identification and adaptation to AI. Supports element caching to reduce repeated LLM calls.

### Learning/Memory

**Server-side caching** on Browserbase. Repeated `extract()` calls with the same inputs return cached results without consuming LLM tokens. Self-healing: when DOM structures change, the AI adapts without breaking automation. No persistent cross-session learning.

### Benchmarks

No publicly published benchmark results. Stagehand is positioned as a developer tool, not an autonomous agent, so standard agent benchmarks like WebVoyager are less applicable.

### Architecture

TypeScript SDK. v2 built on Playwright; v3 is CDP-native (44% performance improvement on complex DOM interactions). Designed to run on **Browserbase** cloud infrastructure. Supports iframe and Shadow DOM handling natively. Multi-model: OpenAI, Anthropic, Google Gemini, Cerebras, Groq.

### Key Differentiator

The hybrid AI + code model. Unlike fully autonomous agents, Stagehand gives developers deterministic control with AI flexibility where needed. This makes it more predictable and debuggable for production automation. Tight integration with Browserbase infrastructure.

### Weakness

Not a fully autonomous agent -- requires developer-written workflow structure. Smaller community than Browser Use (21k vs 87k stars). No standalone operation without Browserbase for optimal experience.

---

## 3. AgentQL

**Website:** [agentql.com](https://www.agentql.com) | **Company:** TinyFish | **Type:** Commercial product + SDKs
**GitHub:** [github.com/tinyfish-io/agentql](https://github.com/tinyfish-io/agentql)

### Page State Representation

AgentQL uses both the page's **HTML structure** and the **accessibility tree** as dual input sources. The HTML provides structural layout; the accessibility tree provides semantic understanding (roles, labels). Inputs are pre-processed to remove noise (metadata, scripts, unnecessary hierarchy layers), creating a clean representation.

### Element Targeting

A **custom query language** that uses natural language selectors:
```
{ products[] { product_name product_price(include currency symbol) } }
```
This is neither CSS selectors nor XPath -- it is a structured query that describes what you want semantically. AgentQL's AI analyzes page structure to locate the matching data. Queries are **self-healing**: they continue working when page structures change. Also offers `get_by_prompt()` for single-element targeting via natural language description.

### Action Model

Two distinct pipelines selected dynamically:
- **Data scraping pipeline**: Optimized for locating actual data, prioritizes accuracy and completeness over speed.
- **Web automation pipeline**: Optimized for locating interactive elements (buttons, forms), prioritizes reliability and execution speed. Assumes 1-to-1 mapping between query terms and web elements.

Available as Python SDK, JavaScript SDK, and REST API. Integrates with Playwright for browser control.

### Learning/Memory

**No explicit learning system**. LLM selection is dynamic based on task complexity, and validation/grounding steps verify output accuracy. Scheduled scraping workflows persist configurations but do not learn from past runs.

### Benchmarks

No publicly published benchmark results.

### Architecture

API-first: REST API endpoint at `api.agentql.com`. SDKs wrap Playwright for browser automation. Chrome extension ("AgentQL IDE") for real-time query debugging. Integrates with LangChain, LlamaIndex, MCP, Zapier, Google ADK, AgentStack, Dify, Langflow.

### Key Differentiator

The query language itself. While others use natural language instructions or code, AgentQL's structured query syntax provides a middle ground: more precise than natural language, more resilient than CSS/XPath selectors. Designed specifically for the scraping/extraction use case.

### Weakness

Narrow focus on scraping and element targeting. Not a full browser agent framework -- needs Playwright or another framework for complex multi-step automation. Closed-source AI backend. No published benchmarks.

---

## 4. LaVague

**Repo:** [github.com/lavague-ai/LaVague](https://github.com/lavague-ai/LaVague) | **Stars:** 6.1k | **Language:** Python | **License:** Apache 2.0
**Last updated:** Jan 2025 (development appears to have slowed significantly)

### Page State Representation

Dual input: **screenshots** and **HTML source code**. The World Model receives both visual and structural representations of the current page state. Architecture inspired by Yann LeCun's paper "A Path Towards Autonomous Machine Intelligence," with modules for perception, world modeling, memory, and action generation.

### Element Targeting

The Action Engine generates **Selenium or Playwright automation code** from natural language instructions. It retrieves relevant HTML chunks ("source nodes") and produces executable Python code that targets elements via standard selectors.

### Action Model

Two-component architecture:
- **World Model**: Takes the user's global objective + current page state (screenshot + HTML) and generates the next natural language instruction.
- **Action Engine**: "Compiles" instructions into automation code (Selenium/Playwright) and executes them.

This loops until the objective is achieved or `n_steps` limit is reached (default: 10). Short-term memory provides information about past actions to the World Model.

### Learning/Memory

Short-term memory within a session (past actions and observations). Telemetry data collection includes action success/failure, token costs, and chain-of-thought traces. No cross-session persistent learning.

### Benchmarks

Claimed to "outperform" competitors in earlier Reddit posts, but no specific benchmark numbers published. The project appears to have stalled -- last commit was January 2025, 87 open issues, and 5 contributors.

### Architecture

Python framework using Selenium or Playwright drivers. Integrates with OpenAI, Anthropic, Azure, Fireworks, and Google Gemini. Offers a Gradio-based demo UI and a VS Code extension.

### Key Differentiator

The code generation approach: instead of mapping instructions to predefined actions, LaVague generates actual automation code. The LeCun-inspired architecture with separate World Model and Action Engine is architecturally clean.

### Weakness

**Development has stalled** (no commits since Jan 2025). Small community (6.1k stars). The code generation approach means higher latency per step compared to direct action execution. No cross-session learning.

---

## 5. MultiOn

**Website:** [multion.ai](https://www.multion.ai) | **Type:** Commercial API platform
**GitHub (AgentQ paper):** Published research, core platform is closed-source

### Page State Representation

MultiOn crawls raw HTML to extract relevant visual components and highlights interactive elements. The observation space uses an **intermediate state representation** that filters HTML down to actionable elements. For their AgentQ research, they designed a representation that exposes interactive elements with numeric IDs.

### Element Targeting

Action space includes: `CLICK [ID]`, `GOTO [URL]`, `TYPE [ID] [TEXT]`, `SUBMIT [ID]`, `CLEAR [ID]`, `SCROLL [UP/DOWN]`, and `ASK USER HELP`. Standard ID-based element references from the processed DOM.

### Action Model

Session-based API with two modes:
- **`browse()`**: Fully autonomous -- agent steps automatically until completion or needing input.
- **`step()`**: Human-in-the-loop -- agent takes one step, user can provide additional guidance.

Sessions are stateful and isolated. The agent generates a plan on session creation and executes steps against it. The **Retrieve** API provides structured data extraction from any webpage, usable standalone or within an agent session.

**AgentQ** (research): Combines Monte Carlo Tree Search with DPO (Direct Preference Optimization) for self-improvement. Took LLaMA 3 70B from 18.6% to 95% accuracy on OpenTable booking scenarios. This is a training-time improvement, not runtime learning.

### Learning/Memory

**AgentQ uses reinforcement learning** at training time -- the model learns from good and bad decisions via MCTS + DPO alignment. At runtime, sessions maintain state but there is no cross-session persistent memory in the production API. The "Skills" feature allows pre-defined workflow templates.

### Benchmarks

- **AgentQ on OpenTable:** 95% success rate (LLaMA 3 70B with MCTS + DPO)
- **REAL Bench:** MultiOn's own benchmark for evaluating web agent performance, security, and AI interactions
- Competitive on GAIA, AssistantBench, and WebArena

### Architecture

Cloud API (REST). Remote browser sessions with native proxy support for bot protection. Chrome extension for local mode. Infinite scalability with parallel agents. Agent API released April 2023; AgentQ research published August 2024; Agent V2 with AgentQ in development.

### Key Differentiator

AgentQ's self-improvement via MCTS + DPO. This is the most sophisticated learning approach in the space -- the model actually gets better at web navigation through training, not just prompt engineering. Also the "Motor Cortex" framing: positioning as infrastructure for autonomous web actions at scale.

### Weakness

Closed-source platform. AgentQ improvements are training-time only (not available for arbitrary LLMs). Agent V1 is labeled as Beta. Smaller developer community than open-source alternatives. Limited documentation depth.

---

## 6. Browserbase

**Website:** [browserbase.com](https://www.browserbase.com) | **Type:** Cloud browser infrastructure
**Stars (Stagehand):** 21.8k | **Funding:** $40M Series B at $300M valuation (June 2025)
**Customers:** 1,000+ | **Sessions processed (2025):** 50M+

### Page State Representation

Browserbase is **infrastructure, not an agent**. It provides the browser environment that agents run on. Through Stagehand (its SDK), it offers DOM processing and accessibility tree analysis. The platform provides session recordings, console/network logs, and element targeting through Stagehand's AI layer.

### Element Targeting

Via Stagehand's `act()`, `observe()`, `extract()` methods (see Stagehand section above). Also compatible with Playwright and Puppeteer selectors as a drop-in replacement for local browser instances.

### Action Model

Not applicable directly. Browserbase provides the execution environment. Developers bring their own agent logic (Browser Use, Stagehand, custom). The platform handles: fleet management, scaling, region routing, anti-bot measures (CAPTCHA solving, residential proxies, fingerprint generation), and session persistence.

### Learning/Memory

**Contexts API**: Persists cookies, localStorage, and other browser state across multiple sessions. This is infrastructure-level state persistence, not AI learning. Session recordings provide observability for debugging.

### Benchmarks

Not applicable (infrastructure layer).

### Architecture

Cloud-hosted headless browsers accessible via API. Playwright/Puppeteer compatible. Key features:
- **Session management**: Persistent browser sessions with cookie/localStorage persistence
- **Stealth mode**: Anti-detection, managed CAPTCHA solving, residential proxies
- **Session recordings**: Visual replay for debugging
- **Director.ai**: New product letting non-developers automate web tasks
- **Stagehand for Python**: Launched alongside Series B (2025)

### Key Differentiator

Purpose-built cloud browser infrastructure for AI agents. The "AWS for headless browsers" positioning. Economies of scale: managing browser fleet complexity so agent developers don't have to. Stagehand as the SDK layer creates a full-stack offering.

### Weakness

Not an agent itself. Vendor lock-in risk for Stagehand users. Pricing can add up at scale (browser sessions are metered). Self-hosted alternative (Steel) exists for teams wanting more control.

---

## 7. Skyvern

**Repo:** [github.com/Skyvern-AI/skyvern](https://github.com/Skyvern-AI/skyvern) | **Stars:** 21.1k | **Language:** Python | **License:** AGPL-3.0
**Users:** 500+ enterprise | **Workflows run:** 10M+ | **SLA:** 99.9% uptime

### Page State Representation

**Dual visual + DOM approach**. Skyvern processes both screenshots (via computer vision) and the DOM tree to build a complete understanding of page structure. Vision models identify interactive elements by appearance (shape, color, surrounding text), not just HTML tags. This means a styled `<div>` acting as a button is recognized as clickable.

### Element Targeting

Vision-based + semantic reasoning. Elements are identified by their visual appearance and purpose rather than CSS selectors or XPath. This makes Skyvern resistant to layout changes: if a button moves or changes its HTML structure, the vision model still recognizes it functionally.

### Action Model

**Multi-agent architecture**:
- **Planner Agent**: Decomposes high-level goals into step-by-step plans (working memory of completed vs. pending tasks).
- **Actor Agent**: Executes individual steps using browser interactions.
- **Validator Agent**: Confirms whether goals were actually achieved; feeds errors back to Planner.

Evolution from Skyvern 1.0 (single prompt loop, ~45% WebVoyager) through adding planning (~68.7%) to the full planner-actor-validator loop (85.85%).

Also offers multiple workflow creation methods: Copilot Chat (natural language), SOP upload, browser recording, visual builder, and native SDKs (Python/JavaScript).

### Learning/Memory

Within a session, the Planner maintains working memory of completed and pending sub-tasks. **Prompt caching** is on the roadmap to "memorize" actions on previously visited sites for cost reduction. Browser Sessions feature allows state persistence between runs for human-in-the-loop workflows. Video recording (added late 2025) enables visual replay for debugging. No cross-session AI learning currently shipped.

### Benchmarks

- **WebVoyager:** 85.85% (state-of-the-art at time of publication, Jan 2025)
- **WebBench:** 64.4% accuracy (SOTA on this newer benchmark)
- All results published with full transparency at eval.skyvern.com

### Architecture

Python SDK with Playwright. Cloud platform (app.skyvern.com) with async cloud browsers. Supports GPT-4o, GPT-4o-mini, Claude 3.5 Sonnet, and other models. Native support for CAPTCHAs, 2FA/TOTP, file uploads, and proxy networks. No-code workflow builder alongside SDK. Integrations: n8n, MCP server.

### Key Differentiator

The computer vision approach. While most competitors rely primarily on DOM parsing, Skyvern's vision-first design handles layout changes, unfamiliar websites, and non-standard UI elements that break DOM-dependent tools. The transparent benchmarking (full eval runs published) builds trust. Enterprise focus with 2FA, CAPTCHA, and compliance features.

### Weakness

Vision-based approach is more expensive (screenshot processing costs). AGPL license may deter some commercial users. Newer ecosystem compared to established tools. Prompt caching (for cross-session learning) is still on the roadmap.

---

## 8. OpenAI Operator / CUA

**Product:** [operator.chatgpt.com](https://operator.chatgpt.com) (now integrated as ChatGPT Agent Mode)
**Model:** Computer-Using Agent (CUA) | **Release:** January 2025
**Status:** Integrated into ChatGPT as "Agent Mode" (July 2025); standalone site sunsetting

### Page State Representation

**Pure vision-based**: CUA operates entirely on screenshots. It captures screenshots of web pages, analyzes the visual layout, and identifies interactive elements (buttons, text fields, links, menus) by processing raw pixels. This is the most human-like approach -- it sees the page exactly as a user would, including JavaScript-rendered content, CSS styling, and dynamic elements.

### Element Targeting

**Visual coordinates + GUI reasoning**. CUA identifies elements by their visual appearance and position. Reinforcement learning trained the model to interact with GUIs (buttons, menus, text fields) using virtual mouse and keyboard inputs. No DOM parsing or accessibility tree required -- it works from pixels alone.

### Action Model

**Iterative perception-action loop**:
1. **Perceive**: Capture screenshot of current browser state
2. **Reason**: Plan chain of thought for next action (includes a "Thinking" architecture for pause-and-reason)
3. **Act**: Click, type, scroll using virtual mouse/keyboard
4. **Self-correct**: If something goes wrong, leverage reasoning to recover

Operates in a remote browser hosted on OpenAI's servers. Hands control back to user when stuck. Since July 2025 integration into ChatGPT, it runs as "Agent Mode" within the standard ChatGPT interface.

### Learning/Memory

CUA was trained via **reinforcement learning** on web interaction tasks. The model itself has learned web navigation patterns from training. At runtime, within a session, it maintains conversation context for self-correction. No explicit cross-session learning in the user-facing product.

### Benchmarks

- **WebVoyager:** 87% success rate
- **WebArena:** 58.1% success rate (new state-of-the-art at launch for this harder benchmark)
- The gap between WebVoyager (simple tasks) and WebArena (complex tasks) highlights where CUA still needs improvement

### Architecture

Cloud-hosted virtual browser on OpenAI's servers. CUA model combines GPT-4o vision with reinforcement learning. Available as ChatGPT Agent Mode (consumer) and planned API release for developers. No open-source components. Safety layers include: usage policies, human handback for sensitive actions, login credential verification with user.

### Key Differentiator

The most powerful model backing it (GPT-4o + RL). The pure-vision approach requires no DOM parsing, making it theoretically capable of automating any visual interface. OpenAI's distribution advantage: integrated directly into ChatGPT for hundreds of millions of users. State-of-the-art on WebArena.

### Weakness

Closed platform with no developer SDK yet (API planned). Expensive to operate (vision model processing per screenshot). Reliability varies significantly based on prompt specificity (3/10 vs 8/10 on same task with different prompts). No customization or extension points. U.S.-only initially. Cannot handle unfamiliar UIs or complex text editing well.

---

## Comparison Matrix

| Dimension | Browser Use | Stagehand | AgentQL | LaVague | MultiOn | Browserbase | Skyvern | Operator/CUA |
|---|---|---|---|---|---|---|---|---|
| **GitHub Stars** | 87.4k | 21.8k | N/A (closed) | 6.1k | N/A (closed) | (via Stagehand) | 21.1k | N/A (closed) |
| **Page State** | DOM distillation + optional screenshots | DOM + CDP native | HTML + accessibility tree | Screenshots + HTML | Processed HTML | Infrastructure only | Vision + DOM dual | Pure screenshots |
| **Element Targeting** | Numbered indices | NL instruction (act/observe) | Custom query language | Generated code selectors | Numeric IDs | Via Stagehand | Visual + semantic | Visual coordinates |
| **Action Model** | Autonomous agentic loop | Hybrid code + AI | Scrape/automate pipelines | World Model + Action Engine | Session API (browse/step) | N/A (infra) | Planner-Actor-Validator | Perception-action loop |
| **Learning/Memory** | In-session memory param | Server-side caching | None | Short-term only | AgentQ (training-time RL) | Contexts API (state) | Working memory, caching planned | Training-time RL |
| **WebVoyager** | **89.1%** | Not published | Not published | Not published | 95% (AgentQ, OpenTable) | N/A | 85.85% | 87% |
| **WebArena** | Not published | Not published | Not published | Not published | Competitive | N/A | Not published | **58.1%** |
| **Architecture** | Python + Playwright | TypeScript + CDP | REST API + SDKs | Python + Selenium/Playwright | Cloud API | Cloud browsers | Python + Playwright | Cloud virtual browser |
| **Model Support** | Any (via LiteLLM) | Multiple (OpenAI, Anthropic, Google, Groq, Cerebras) | Internal LLMs | OpenAI, Anthropic, Google, Azure | GPT-4o, LLaMA | Via agent framework | GPT-4o, Claude 3.5 | GPT-4o + RL (fixed) |
| **Self-Healing** | Via AI reasoning | Built-in DOM adaptation | Self-healing queries | Via World Model re-planning | Via AgentQ MCTS | N/A | Vision-based adaptation | Via RL self-correction |
| **Open Source** | Yes (MIT) | Yes (MIT) | Partial (SDKs) | Yes (Apache 2.0) | No | No | Yes (AGPL) | No |
| **Active Development** | Very active | Very active | Active | **Stalled (Jan 2025)** | Active | Very active | Very active | Very active |
| **Best For** | Autonomous agent tasks | Developer-controlled automation | Web scraping + data extraction | (Dormant project) | Scaled cloud agent API | Browser infra at scale | Enterprise workflow automation | Consumer task delegation |

---

## Key Findings for Safari Pilot

### Benchmark Landscape

The standard benchmarks are **WebVoyager** (simpler, 15 websites, most agents score 85-89%) and **WebArena** (harder, complex multi-step tasks, best score ~58%). **WebBench** is emerging as a newer evaluation. Skyvern deserves credit for publishing full eval runs transparently -- this is rare and builds trust. Browser Use holds the open-source WebVoyager record at 89.1%.

### Convergent Architecture Patterns

The industry has converged on what the arxiv paper (2511.19477) calls the "standard model":
1. **Planner** (decomposes objectives into sub-tasks)
2. **Executor** (performs individual browser actions)
3. **Memory** (compresses history, tracks progress)

Browser Use's memory parameter pattern (evaluation + memory + next_goal per action) has become the de facto standard, adopted by multiple frameworks.

### The Learning Gap

**Cross-session learning is the biggest unsolved problem** in this space. No production tool truly learns from past runs. MultiOn's AgentQ shows the most promise (training-time RL via MCTS + DPO), but this requires model training, not runtime adaptation. The WebCoach paper demonstrates that adding episodic memory to Browser Use improves performance across LLM backbones. This is a major opportunity for Safari Pilot's recipe system.

### Page State Representation Spectrum

From most to least structured:
1. **Accessibility tree** (AgentQL, Browser Use) -- most token-efficient, semantically rich
2. **Distilled DOM** (Browser Use, Stagehand) -- filtered interactive elements
3. **Raw HTML** (LaVague, MultiOn) -- noisier, more complete
4. **Screenshots** (Operator, Skyvern) -- most human-like, most expensive

The trend is toward **hybrid** approaches (Skyvern's vision + DOM, Browser Use's DOM + optional vision). Safari Pilot's accessibility tree approach via the extension aligns well with the most token-efficient end of the spectrum.

### Safari-Specific Opportunity

Every tool in this space targets Chrome/Chromium (via Playwright, Puppeteer, or CDP). Safari Pilot's native Safari integration through AppleScript + daemon + Web Extension is genuinely unique. The three-tier engine model (Extension > Daemon > AppleScript) maps to the capability hierarchy that these tools implement through a single browser engine. Safari's accessibility tree output (via AX API) could provide the same structured state representation that Browser Use and AgentQL use, but natively for Safari.

### Implications for Recipe/Learning System

Based on the competitive landscape:
1. **Episodic memory** (store successful navigation trajectories per domain) would differentiate Safari Pilot -- no competitor ships this in production.
2. **Domain-specific recipes** (pre-optimized workflows for common sites) map to MultiOn's "Skills" concept but with runtime adaptation.
3. **Cross-session state** (remember form patterns, navigation paths, element locations per domain) is what every competitor lists as "future work."
4. The Planner-Actor-Validator pattern (pioneered by Skyvern) is proven to improve benchmark scores by 40+ percentage points over single-loop agents.
