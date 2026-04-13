# Computer Use Tools and Visual Agent Benchmarks: Competitive Landscape

*Research Date: April 2026 | For: Safari Pilot competitive positioning*

---

## 1. Computer Use Tools

### 1.1 Claude Computer Use (Anthropic)

**Status:** Beta (API header `computer-use-2025-11-24` for Opus 4.6/Sonnet 4.6/Opus 4.5). Consumer preview launched March 23, 2026 for Pro/Max subscribers via Claude Cowork and Claude Code. macOS-only at consumer launch.

**Screen State Representation:** Pure screenshot-based perception loop. Claude captures screenshots of the user's screen, processes them through its vision capabilities, determines actions, and executes via simulated mouse/keyboard. The API constrains images to 1568px on the longest edge (~1.15 megapixels). Developers must handle coordinate scaling between the downsampled image Claude analyzes and the actual screen resolution. No accessibility tree or DOM access -- entirely visual.

**Action Space (Coordinate-Based):**
- `screenshot` -- capture current screen state
- `left_click`, `right_click`, `middle_click`, `double_click` -- at `coordinate: [x, y]`
- `type` -- text input with `text` parameter
- `key` -- keyboard shortcuts (e.g., `ctrl+c`)
- `scroll` -- directional scrolling at coordinates with `scroll_amount`
- `zoom` -- (Opus 4.6/Sonnet 4.6/Opus 4.5 only) view a specific `region: [x1, y1, x2, y2]` at full resolution
- Modifier keys supported with click/scroll actions

**Element Targeting:** Exclusively coordinate-based. Claude identifies elements visually from screenshots and returns pixel coordinates for actions. No semantic element IDs or accessibility tree references. The zoom action (new in `computer_20251124`) allows Claude to inspect regions at higher resolution for small UI elements.

**Tool Definition:** Passed as a tool in the Messages API with `type: "computer_20251124"`, `display_width_px`, `display_height_px`, and optional `enable_zoom`. The model returns `tool_use` content blocks with structured action JSON.

**Benchmark Performance (OSWorld-Verified):**
- Claude Sonnet 3.5 v2 (Oct 2024): ~3.5% (original OSWorld)
- Claude Sonnet 3.7: 28.0% (3rd-party verified)
- Claude Sonnet 4.5: improved significantly over 3.7
- Claude Opus 4.6: **72.7%** (self-reported, approaching human baseline of 72.4%)

The trajectory from 3.5% to 72.7% across 16 months represents one of the most rapid capability improvements documented in AI benchmarks. Anthropic notes scores prior to Sonnet 4.5 used original OSWorld; Sonnet 4.5 onward use OSWorld-Verified (released July 2025).

**WebArena:** Anthropic claims state-of-the-art among single-agent systems. Claude Code + GBOX achieves 68.0% on the official leaderboard.

**Failure Recovery:** The screenshot loop is inherently self-correcting -- Claude can observe the result of each action and adjust. Human-in-the-loop handback when stuck. No persistent memory across sessions.

**Key Architectural Choice:** Desktop-first. Claude controls the user's actual desktop, can interact with native apps, files, and system UI -- not limited to browser. This is a fundamental architectural difference from OpenAI's browser-only approach.

---

### 1.2 OpenAI CUA (Computer-Using Agent) / Operator

**Status:** CUA launched January 23, 2025 as the engine behind Operator. Initially for Pro users only. Operator integrated into ChatGPT as "agent mode" (July 2025). GPT-5.4 (March 2026) added native computer use to the API with the `computer` tool type. CUA API available for developers.

**Screen State Representation:** Screenshot-based, same as Claude. CUA processes raw pixel data to understand screen state. Operates through a perception-reasoning-action loop:
1. **Perception:** Screenshots captured and added to model context
2. **Reasoning:** Chain-of-thought over current and past screenshots/actions
3. **Action:** Click, scroll, or type until task complete or user input needed

**Action Space:** Virtual mouse and keyboard in a cloud-hosted browser (Operator) or local computer (API). Similar coordinate-based actions to Claude. GPT-5.4 introduces the `computer` tool as a GA feature with structured action vocabulary.

**Architecture:** Combines GPT-4o's vision capabilities with advanced reasoning through reinforcement learning. The key differentiator is the RL training specifically for GUI interaction, not just vision-language pre-training.

**Operator Product Design:** Browser-first, cloud-hosted. Unlike Claude's desktop-first approach:
- Operates in a remote browser hosted on OpenAI's servers
- Safety-focused containment -- everything within OpenAI's infrastructure
- Seeks user confirmation for sensitive actions (login, purchases, CAPTCHAs)
- Hands control back to user when stuck

**Benchmark Performance:**
- OSWorld: 38.1% (original CUA, Jan 2025), CUA with o3: 42.9% (3rd-party verified)
- GPT-5.4: **75.0%** on OSWorld-Verified (self-reported, March 2026) -- surpassing human baseline
- WebArena: 58.1% (Operator launch), ColorBrowserAgent (GPT-5): 71.2%
- WebVoyager: 87% (CUA original)

**Failure Recovery:** Self-correction through reasoning capabilities. Can backtrack and retry alternative approaches. When stuck, control returns to user. Operator maintains task state across retries.

**Key Distinction from Claude CU:** Browser-only (Operator) vs. desktop-first (Claude). GPT-5.4's API-level computer tool bridges this gap by supporting arbitrary desktop environments, similar to Claude's approach.

---

### 1.3 UI-TARS (ByteDance)

**Status:** Open-source (Apache 2.0). Three generations: UI-TARS (Jan 2025), UI-TARS-1.5 (April 2025), UI-TARS-2 (September 2025). Models on Hugging Face. Desktop app available at github.com/bytedance/UI-TARS-desktop.

**Architecture:**
- **UI-TARS v1** (arXiv:2501.12326): End-to-end native GUI agent model. Takes only screenshots as input, outputs keyboard/mouse operations. Available in 7B and 72B parameter variants. Based on Qwen-VL architecture.
- **UI-TARS-1.5**: Added reinforcement learning for reasoning. Open-sourced UI-TARS-1.5-7B. Integrated Qwen 2.5-VL as base. Absolute coordinate grounding.
- **UI-TARS-2** (arXiv:2509.02544): Major architectural leap. 532M-parameter vision encoder + Mixture-of-Experts LLM with 23B active parameters (230B total). Initialized from Seed-thinking-1.6. Key innovations:
  - **Data Flywheel:** Automated scalable data generation through reflective trace bootstrapping
  - **Multi-turn RL:** Stabilized framework for learning from multi-step interactions
  - **Hybrid GUI-SDK Environment:** Integrates file systems and terminals alongside GUI
  - **Working + Episodic Memory:** High-fidelity working memory (last N steps) + compressed episodic memory

**Core Capabilities (Native Agent):**
1. Perception -- real-time environmental understanding from screenshots
2. Action -- accurate prediction and grounding within predefined action space
3. Reasoning -- System 1 (fast, intuitive) and System 2 (deliberate, reflective) thinking
4. Memory -- task-specific information, prior experiences, background knowledge

**Screen State:** Pure screenshot input. No accessibility tree, no DOM. The model directly perceives and grounds UI elements from pixels.

**Benchmark Performance:**
| Benchmark | UI-TARS v1 (7B) | UI-TARS-1.5 | UI-TARS-2 |
|-----------|-----------------|-------------|-----------|
| OSWorld (50 steps) | 24.6% | 42.5% | 47.5% |
| AndroidWorld | 46.6% | -- | 73.3% |
| Online-Mind2Web | -- | -- | 88.2% |
| WindowsAgentArena | -- | -- | 50.6% |

UI-TARS-2 outperforms Claude and OpenAI agents on several benchmarks. On its 15-game suite, it reaches ~60% of human-level performance.

**Significance for Safari Pilot:** UI-TARS demonstrates that open-source, screenshot-only models can match or exceed commercial agents. Its desktop app (UI-TARS-desktop) and Midscene.js web automation integration show the pattern of a visual model connected to browser/OS control -- architecturally similar to Safari Pilot's approach but with a fundamentally different engine (visual AI vs. structured accessibility tree + AppleScript).

---

### 1.4 Visual Grounding Models

#### SeeClick (arXiv:2401.10935)

**Architecture:** Built on Qwen-VL. Screenshot-only visual GUI agent that relies entirely on visual perception for task automation. Key contribution is demonstrating that GUI grounding -- accurately locating screen elements from instructions -- is the critical bottleneck for visual agents.

**GUI Grounding Pre-training:** Automated curation of GUI grounding data. Created ScreenSpot, the first realistic GUI grounding benchmark spanning mobile, desktop, and web environments.

**Performance:** Improvements in GUI grounding directly correlate with downstream agent task performance. State-of-the-art on ScreenSpot at time of publication. Later surpassed by UGround and CogAgent.

**GitHub:** github.com/njucckevin/SeeClick

#### CogAgent (arXiv:2312.08914, CVPR 2024 Highlight)

**Architecture:** 18B-parameter VLM from Tsinghua University/Zhipu AI. Novel dual-encoder design:
- **Low-resolution encoder:** EVA2-CLIP-E (224x224px) from CogVLM base
- **High-resolution cross-module:** Lightweight 0.30B-parameter encoder supporting 1120x1120 input
- Cross-attention mechanism fuses high-res features into the language decoder

The dual-resolution approach is computationally efficient -- FLOPs for CogAgent-18B at 1120x1120 are less than half of CogVLM-17B at 490x490.

**Training Data:** Three categories: (1) GUI screenshots + OCR text (18M web page images), (2) Natural image OCR (18M from COYO/LAION), (3) Academic documents (9M from arXiv). Plus 40M visual grounding images.

**Performance:** SOTA on 9 VQA benchmarks (VQAv2, OK-VQA, TextVQA, ST-VQA, ChartQA, infoVQA, DocVQA, MM-Vet, POPE). First generalist VLM to outperform LLM-based methods (using extracted HTML) on both Mind2Web and AITW benchmarks using only screenshots. Updated CogAgent-9B-20241220 available.

**GitHub:** github.com/THUDM/CogVLM, github.com/THUDM/CogAgent

#### Ferret-UI (arXiv:2404.05719, Apple)

**Architecture:** MLLM tailored for mobile UI understanding, built on the Ferret model. Key innovations:
- **"Any resolution" processing:** Handles elongated mobile screen aspect ratios by dividing screens into 2 sub-images based on aspect ratio (horizontal division for portrait, vertical for landscape)
- Each sub-image encoded separately before being sent to LLMs
- Equipped with referring, grounding, and reasoning capabilities

**Training:** Meticulously gathered samples from elementary UI tasks: icon recognition, text finding, widget listing. Formatted for instruction-following with region annotations. Advanced task dataset includes detailed description, perception/interaction conversations, and function inference.

**Performance:** Excels beyond most open-source UI MLLMs. Surpasses GPT-4V on all elementary UI tasks. Ferret-UI Lite achieves 19.8% on OSWorld-Verified (50 steps) and 28.0% on AndroidWorld -- significantly lower than specialized agents, showing the gap between understanding and acting.

#### UGround (arXiv:2410.05243, ICLR 2025 Oral)

**Architecture:** Built on LLaVA-NeXT. Trained on the largest GUI visual grounding dataset: 10M GUI elements and their referring expressions over 1.3M screenshots. Uses pixel-coordinate output format (e.g., "(1344, 1344)") without normalization.

**Performance:** Substantially outperforms SeeClick, CogAgent, GPT-4, and GPT-4o on ScreenSpot by up to 20% absolute. Agents using UGround outperform state-of-the-art agents that use additional text-based input (HTML, accessibility trees), while UGround uses only visual perception.

**Significance:** Demonstrates that a "simple recipe" of web-based synthetic data + slight LLaVA adaptation is surprisingly effective. Validates the pure-visual approach to GUI grounding.

---

## 2. Benchmarks and Evaluation Frameworks

### 2.1 WebArena

**Paper:** arXiv:2307.13854 (Zhou et al., CMU, July 2023)
**GitHub:** github.com/web-arena-x/webarena
**Website:** webarena.dev

**Task Count:** 812 tasks across 5 self-hosted website domains

**Categories:** E-commerce (Shopping), Social forums (Reddit), Collaborative development (GitLab), Content management (CMS), plus supplementary map (OpenStreetMap) and Wikipedia tools.

**Environment:** Fully self-hosted Docker containers. Functional clones of real websites with realistic data. OpenAI Gym-style interface. Supports accessibility tree and screenshot observation modes. Reproducible setup -- every research group runs identical environments.

**Success Metric:** Execution-based programmatic evaluation. No LLM judge. Each task has a custom validator checking functional correctness of the end state. Binary pass/fail -- no partial credit. This is why WebArena is considered the gold standard for reproducible evaluation.

**Human Baseline:** ~78.24%

**Best Published Scores (as of April 2026):**
| Agent | Score | Model | Source |
|-------|-------|-------|--------|
| DeepSeek v3.2 | 74.3% | DeepSeek | 3rd-party |
| OpAgent | 71.6% | Qwen3-VL-32B + RL | 3rd-party |
| ColorBrowserAgent | 71.2% | GPT-5 | 3rd-party |
| Claude Code + GBOX | 68.0% | Claude Code | 3rd-party |
| DeepSky Agent | 66.9% | Proprietary | Self |
| IBM CUGA | 61.7% | Proprietary | 3rd-party |
| OpenAI Operator (CUA) | 58.1% | CUA | Self |

**Key Insight:** OpAgent (open-source, Qwen3-VL-32B with RL fine-tuning) leads the leaderboard, demonstrating that specialized training on web navigation data matters more than raw model scale. Its Planner-Grounder-Reflector-Summarizer architecture specifically optimized for web navigation outperforms agents backed by GPT-5 and Claude.

**Limitations:**
- Tasks are relatively short-horizon compared to real-world web workflows
- Self-hosted environments may drift from live web complexity
- No visual reasoning tasks (addressed by VisualWebArena)
- Narrow performance spectrum -- top agents cluster near each other
- Human trajectory recordings only available for ~170 tasks

**Extensions:** VisualWebArena (visual tasks), WebChoreArena (tedious/memory-intensive tasks, 532 tasks), VideoWebArena (video understanding), BrowserGym ecosystem.

---

### 2.2 Mind2Web

**Paper:** arXiv:2306.06070 (Deng et al., Ohio State University)
**GitHub:** github.com/OSU-NLP-Group/Mind2Web

**Task Count:** 2,350 tasks from 137 websites spanning 31 domains

**Key Difference from WebArena:** Mind2Web uses **real-world websites** (not self-hosted clones) and focuses on **generalization** -- testing agents on unseen websites, unseen domains, and unseen tasks. WebArena tests execution in controlled environments; Mind2Web tests the breadth of web understanding.

**Task Categories:** Diverse practical use cases: flight booking, apartment searching, restaurant reservation, product comparison, form filling, multi-step information gathering. Tasks range from simple (1-2 actions) to complex (10+ action sequences requiring reasoning about calendars, filters, and multi-step forms).

**Evaluation Methodology:** Three generalization settings:
1. **Cross-Task:** New tasks on seen websites
2. **Cross-Website:** New websites in seen domains
3. **Cross-Domain:** Entirely new domains

Metrics include element accuracy (did the agent click the right element?), action F1, and step success rate. Offline evaluation using pre-collected trajectories (not live web interaction).

**Online-Mind2Web:** A live-web version where agents interact with actual websites in real-time. UI-TARS-2 achieves 88.2% on this variant; SeeAct + GPT-5 achieves 42.33% (3rd-party).

**What Mind2Web Measures That WebArena Doesn't:**
- Generalization to unseen websites and domains
- Robustness to diverse real-world web design patterns
- Performance on the long tail of website implementations
- Element identification across wildly varying DOM structures

**Limitations:**
- Offline evaluation may not capture real-time interaction dynamics
- Pre-collected trajectories may have a single "correct" path, penalizing valid alternative approaches
- Dataset based on a snapshot in time; websites evolve

---

### 2.3 WebVoyager

**Paper:** arXiv:2401.13919 (He et al.)

**Task Count:** Variable; designed as a flexible evaluation suite for multimodal web agents

**Design:** End-to-end web agent benchmark using large multimodal models. Agents interact with live websites using screenshots + text understanding. Tasks span real web services.

**Evaluation:** GPT-4V as judge (not programmatic). This makes evaluation more flexible but less reproducible than WebArena's programmatic validators.

**Best Published Scores:**
| Agent | Score |
|-------|-------|
| Surfer 2 (H Company) | 97.1% |
| Magnitude | 93.9% |
| AIME Browser-Use | 92.34% |
| OpenAI CUA (original) | 87.0% |
| WebVoyager (original) | 59.1% |

**What It Reveals:** WebVoyager scores tend to be much higher than WebArena, suggesting either easier tasks, more lenient evaluation (LLM judge vs. programmatic), or both. The gap between WebVoyager and WebArena scores for the same agent indicates that evaluation methodology matters enormously.

**Limitations:**
- LLM-judged evaluation introduces variability and potential bias
- Live website interaction means tasks may become stale or break
- Less reproducible than self-hosted benchmarks
- Not directly comparable to WebArena due to different evaluation rigor

---

### 2.4 VisualWebArena

**Paper:** arXiv:2401.13649 (Koh et al., CMU, ACL 2024)
**GitHub:** github.com/web-arena-x/visualwebarena

**Task Count:** 910 tasks across Classifieds (new environment with real-world data), Shopping, and Reddit sites

**Key Difference from WebArena:** Tasks **necessitate visual comprehension**. While WebArena tasks can theoretically be solved with DOM/accessibility tree alone, VisualWebArena requires the agent to understand visual content -- images, layouts, visual styling, spatial relationships.

**What Visual Benchmarks Reveal:**
- DOM-based agents fail on tasks requiring visual reasoning (e.g., "find the red jacket" when color isn't in the DOM attributes)
- Screenshot-based agents struggle with precise element grounding in visually complex pages
- The gap between visual and text-based performance exposes whether an agent truly "sees" the page or just processes its structure
- Visual tasks are harder for current agents -- scores are generally lower than text-only WebArena

**Environment:** Same self-hosted Docker infrastructure as WebArena. Execution-based evaluation. Reproducible.

**Limitations:**
- Smaller task set than WebArena
- Visual tasks may conflate visual understanding with general reasoning difficulty
- Limited to web; doesn't test native application visual understanding

---

### 2.5 WorkArena

**Paper:** ServiceNow Research
**GitHub:** servicenow.github.io/WorkArena/

**Task Count:** Enterprise-scale tasks within ServiceNow platform

**Key Difference from Academic Benchmarks:**
- Tests **enterprise/workplace** browser tasks, not consumer web
- ServiceNow's complex, deeply nested UI represents real enterprise software
- Tasks involve IT service management, HR workflows, incident management
- Multi-step workflows with form dependencies, approval chains, and data validation
- Reflects the "long tail" of enterprise software that API-less automation must handle

**Why It Matters for Safari Pilot:** Enterprise automation is a primary use case for computer-use agents. WorkArena exposes whether agents can handle:
- Complex form layouts with conditional fields
- Data tables with sorting, filtering, and pagination
- Role-based access patterns
- Multi-step approval workflows

**Limitations:**
- Single-platform (ServiceNow) -- may not generalize to other enterprise software
- Enterprise UI patterns evolve independently from consumer web

---

### 2.6 OSWorld

**Paper:** arXiv:2404.07972 (Xie et al., HKU/Salesforce/CMU/Waterloo)
**GitHub:** github.com/xlang-ai/osworld
**Website:** os-world.github.io

**Task Count:** 369 tasks (+ 43 supplementary Windows tasks). OSWorld-Verified (July 2025) improved task quality and evaluation grading.

**Categories:** Cross-application desktop tasks involving real software: Chrome, LibreOffice (Calc, Writer, Impress), VS Code, GIMP, Thunderbird, VLC, and more. Task types include:
- File operations across applications
- Multi-application workflows (e.g., extract data from web, process in spreadsheet, compose email)
- System configuration and settings changes
- Document editing and formatting

**Environment:** Real computer environments via VMware, VirtualBox, Docker, or AWS. Supports Ubuntu, Windows, and macOS. Agents interact through pyautogui actions. Supports screenshot, accessibility tree, and combined observation modes.

**Success Metric:** Execution-based. Each task has a custom evaluation script that checks whether the agent achieved the correct end state. No LLM judge.

**Human Baseline:** 72.36%

**Best Published Scores (OSWorld-Verified, as of April 2026):**
| Agent | Score | Type | Source |
|-------|-------|------|--------|
| GPT-5.4 | 75.0% | General model | Self-reported |
| Claude Opus 4.6 | 72.7% | General model | Self-reported |
| UiPath ScreenAgent | 72.1% | Specialized | Self-reported |
| Agent S3 (Simular AI) | 69.9% | Agentic framework | 3rd-party |
| AskUI VisionAgent | 66.2% | Specialized | Self-reported |
| CoACT-1 (USC/Salesforce) | 60.76% | Agentic framework | 3rd-party |
| Agent S2.5 w/ o3 | 56.0% | Agentic framework | 3rd-party |
| GTA1 w/ o3 (Salesforce) | 53.1% | Agentic framework | 3rd-party |
| UI-TARS-2 | 47.5% | Specialized (open) | 3rd-party |
| OpenAI CUA (o3) | 42.9% | General model | 3rd-party |
| UI-TARS-1.5 | 42.5% | Specialized (open) | 3rd-party |

**Analysis:** Three model paradigms compete:
1. **General models** (GPT-5.4, Claude Opus 4.6) -- broad capability, elicited via prompting
2. **Specialized models** (UI-TARS, AskUI) -- trained specifically for computer use
3. **Agentic frameworks** (Agent S3, CoACT-1) -- structured workflows orchestrating multiple models

The general model approach has surged ahead, with GPT-5.4 and Claude Opus 4.6 both exceeding the human baseline. But specialized and framework approaches show strong results with smaller models.

**Relevance to Safari Pilot:** OSWorld is the most relevant benchmark for Safari Pilot's macOS-native approach. Key insights:
- Screenshot observation is competitive with accessibility tree, but combined mode performs best
- Higher screenshot resolution improves performance
- Longer text-based trajectory history helps, but screenshot-only history doesn't
- Performance correlates across OS -- insights from Ubuntu/Windows transfer to macOS
- Current agents are not robust to UI layout changes and visual noise

**Limitations:**
- 369 tasks is relatively small
- Self-reported scores from labs not yet independently verified for newest models
- Benchmark may saturate quickly as agents approach/exceed human baseline
- macOS support exists but most evaluation happens on Ubuntu
- No specific Safari browser testing -- Chrome is the primary web browser tested

---

### 2.7 AndroidWorld

**Paper:** arXiv:2405.14573 (Rawles et al., Google DeepMind, ICLR 2025)
**GitHub:** github.com/google-research/android_world

**Task Count:** 116 programmatic tasks across 20 real-world Android apps. Dynamic task construction with parameterized natural language instructions.

**Key Design:** Unlike static benchmarks, AndroidWorld **dynamically generates task variations** with unlimited parameterization. Each task includes initialization, success-checking, and tear-down logic that modifies and inspects device system state.

**Human Baseline:** ~80%

**Best Scores:**
| Agent | Score |
|-------|-------|
| AGI-0 | 97.4% |
| AskUI | 94.8% |
| DroidRun | 91.4% |
| Surfer 2 | 87.1% |
| UI-TARS-2 | 73.3% |
| Agent S3 | 66.8% |
| M3A (Gemini 1.5) | 30.0% (original baseline) |

**Approaching Saturation:** With top agents exceeding 90%, AndroidWorld is considered nearly saturated. MobileWorld (arXiv:2512.19432) was introduced as a harder successor with 201 tasks, ~2x more steps per task, and 62.2% multi-app tasks (vs. 9.5% in AndroidWorld).

**Relevance to Safari Pilot:** Mobile automation patterns inform macOS automation:
- Touch targets map to click targets
- Mobile app navigation patterns increasingly appear in macOS apps (especially Catalyst/SwiftUI)
- Parameterized task generation methodology applicable to Safari Pilot evaluation
- Android's accessibility services parallel macOS Accessibility API

---

## 3. Comparative Analysis

### 3.1 Benchmark Comparison Table

| Benchmark | Tasks | Environment | Eval Method | Human Score | Best Agent Score | Primary Focus |
|-----------|-------|-------------|-------------|-------------|-----------------|---------------|
| **WebArena** | 812 | Self-hosted Docker | Programmatic | ~78% | 74.3% (DeepSeek v3.2) | Web navigation |
| **VisualWebArena** | 910 | Self-hosted Docker | Programmatic | -- | -- | Visual web tasks |
| **Mind2Web** | 2,350 | Real websites (offline) | Element accuracy, F1 | -- | 88.2% (UI-TARS-2, online) | Generalization |
| **WebVoyager** | Variable | Live websites | LLM-judged | -- | 97.1% (Surfer 2) | Multimodal web |
| **OSWorld** | 369 | Real VM (Ubuntu/Win/Mac) | Programmatic | 72.4% | 75.0% (GPT-5.4) | Desktop OS |
| **AndroidWorld** | 116 | Real Android device | Programmatic | 80% | 97.4% (AGI-0) | Mobile OS |
| **WorkArena** | Varies | ServiceNow platform | Task completion | -- | -- | Enterprise |
| **WebChoreArena** | 532 | Self-hosted Docker | Programmatic | -- | -- | Memory/calc tasks |

### 3.2 Computer Use Tool Comparison

| Dimension | Claude CU | OpenAI CUA/Operator | UI-TARS-2 |
|-----------|-----------|-------------------|-----------|
| **Screen Input** | Screenshot only | Screenshot only | Screenshot only |
| **Action Space** | Coordinates + keyboard | Coordinates + keyboard | Coordinates + keyboard |
| **Element Targeting** | Visual/coordinate | Visual/coordinate | Visual/coordinate |
| **Environment** | User's desktop (macOS) | Cloud browser (Operator) / Local (API) | Local desktop |
| **Failure Recovery** | Screenshot loop, human handback | Self-correction via CoT, human handback | Multi-turn RL, episodic memory |
| **Persistent Memory** | None across sessions | None across sessions | Working + episodic memory |
| **OSWorld-Verified** | 72.7% (Opus 4.6) | 75.0% (GPT-5.4) | 47.5% |
| **Open Source** | No | No | Yes (Apache 2.0) |
| **Training Approach** | Undisclosed | RL on GUI interaction | SFT + multi-turn RL + RFT |
| **API Available** | Yes (beta) | Yes (GA with GPT-5.4) | Self-hosted |
| **Cost** | $3/$15 per 1M tokens (Sonnet 4.6) | Similar API pricing | Free (self-hosted) |

### 3.3 What Benchmarks Don't Measure

None of the current benchmarks adequately capture:

1. **Real-time responsiveness** -- p50/p99 latency for interactive use. Safari Pilot's 5-10ms daemon latency vs. screenshot-loop agents at 1-3 seconds per action.
2. **Graceful degradation** -- what happens when the primary approach fails? Safari Pilot's three-tier engine fallback (Extension > Daemon > AppleScript) is unmatched.
3. **Security posture** -- no benchmark tests whether agents respect domain policies, tab ownership, rate limits, or detect prompt injection.
4. **Browser-specific capabilities** -- Shadow DOM traversal, CSP bypass, cross-origin frame handling, cookie management.
5. **Long-running workflows** -- tasks spanning hours or days with state persistence.
6. **Error specificity** -- do agents provide actionable error messages? Safari Pilot's 21-error-code hierarchy with retry hints vs. generic "I couldn't complete the task."
7. **Concurrent tab management** -- most benchmarks test single-tab workflows.

---

## 4. Implications for Safari Pilot

### 4.1 Positioning

Safari Pilot occupies a unique architectural niche: **structured automation** (accessibility tree, DOM, AppleScript) rather than **visual automation** (screenshots + coordinate clicking). This has distinct advantages and disadvantages:

**Advantages over visual agents:**
- **Speed:** 5-10ms per action vs. 1-3 seconds per screenshot-analyze-act cycle
- **Precision:** Semantic element targeting via ARIA tree, locators, CSS selectors -- no coordinate miss-clicks
- **Reliability:** Deterministic element selection vs. probabilistic visual grounding
- **Efficiency:** No vision model inference cost per action
- **Accessibility:** ARIA tree provides semantic information visual agents must infer

**Disadvantages:**
- **Scope:** Limited to Safari (one browser) vs. any GUI on screen
- **Visual understanding:** Cannot reason about visual content (colors, layout aesthetics, image content)
- **Adaptability:** Requires structured access (DOM, accessibility API) rather than working with any interface

### 4.2 Benchmark Opportunity

No existing benchmark specifically tests Safari-native automation. Safari Pilot could define a benchmark that measures:
- Safari-specific capabilities (Reading List, iCloud Keychain integration, Tab Groups, Profiles)
- macOS-native integration (Shortcuts, AppleScript, Notification Center)
- Security properties (tab isolation, domain policies, injection detection)
- Performance (actions per second, latency percentiles)
- Degradation behavior (engine fallback paths)

### 4.3 Convergence Trends

The field is converging toward hybrid approaches:
- **UI-TARS-2's hybrid GUI-SDK environment** adds terminal/file system access alongside visual GUI
- **OSWorld-MCP** (2025) benchmarks agents that combine GUI actions with API/tool calls
- **MobileWorld** tests agents that mix GUI manipulation with MCP server calls
- **Agent S3** uses multiple models in structured workflows -- planner + grounder + reflector

Safari Pilot's three-tier engine model (Extension > Daemon > AppleScript) and structured security pipeline align with this convergence. The next generation of agents will likely combine visual understanding with structured access, exactly the kind of hybrid that Safari Pilot's architecture supports.

---

## 5. Key Papers and Resources

| Resource | ID/URL | Focus |
|----------|--------|-------|
| Claude Computer Use Docs | platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool | API reference |
| OpenAI CUA | openai.com/index/computer-using-agent/ | Architecture + benchmarks |
| UI-TARS v1 | arXiv:2501.12326 | Native GUI agent |
| UI-TARS-2 | arXiv:2509.02544 | Multi-turn RL for GUI |
| SeeClick | arXiv:2401.10935 | GUI grounding |
| CogAgent | arXiv:2312.08914 (CVPR 2024) | VLM for GUI |
| Ferret-UI | arXiv:2404.05719 | Mobile UI understanding |
| UGround | arXiv:2410.05243 (ICLR 2025) | Universal visual grounding |
| WebArena | arXiv:2307.13854 | Web navigation benchmark |
| Mind2Web | arXiv:2306.06070 | Generalist web tasks |
| WebVoyager | arXiv:2401.13919 | Multimodal web benchmark |
| VisualWebArena | arXiv:2401.13649 (ACL 2024) | Visual web tasks |
| OSWorld | arXiv:2404.07972 | Desktop OS benchmark |
| AndroidWorld | arXiv:2405.14573 (ICLR 2025) | Mobile OS benchmark |
| Steel.dev Leaderboard | leaderboard.steel.dev/results | Cross-benchmark scores |
| OpAgent | arXiv:2602.13559 | WebArena SOTA agent |
| Aria-UI | ACL 2025 Findings | GUI visual grounding |
| WebChoreArena | arXiv:2506.01952 | Memory/calculation tasks |
| MobileWorld | arXiv:2512.19432 | Next-gen mobile benchmark |
