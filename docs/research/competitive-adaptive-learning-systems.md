# Adaptive and Learning Systems in Browser/Task Automation

**Research date:** 2026-04-13
**Purpose:** Inform Safari Pilot's planned recipe system (3-layer learning architecture: domain knowledge + recorded flows + learned heuristics)

---

## 1. Agent Memory Systems

### Letta (MemGPT): OS-Inspired Tiered Memory

Letta, the production evolution of the MemGPT research (UC Berkeley, 2023), treats agent memory like an operating system manages RAM and disk. Three tiers form the hierarchy:

- **Core memory** (always in-context, analogous to RAM): organized into self-modifiable memory blocks the agent reads and writes directly. This is the agent's active working state -- personality, current user model, task context.
- **Archival memory** (external searchable vector store, analogous to disk): the agent explicitly calls `archival_memory_search` to page information into core. Unlimited capacity.
- **Recall memory** (conversation history): searchable on demand for past interactions.

The critical insight is that Letta agents are *active memory managers*, not passive recipients of injected context. They decide what to promote to core, what to archive, and what to forget. A "sleeptime agent" runs asynchronously every N conversation steps to consolidate memory in the background -- separating real-time response from memory maintenance.

**Storage:** Structured memory blocks (JSON-like state) + vector store for archival. Memory blocks have labels and UUIDs.
**Retrieval:** Explicit tool calls by the agent (`core_memory_replace`, `archival_memory_search`). No implicit magic.
**Validation:** The agent itself decides what to keep. Sleeptime consolidation acts as a garbage collection pass.
**Feedback loop:** Direct -- the agent modifies its own memory based on conversation outcomes.

### Mem0: Drop-In Memory Layer

Mem0 (48K+ GitHub stars, $24M funding) adds memory as an external service wrapping stateless agents. Three scopes: user, session, and agent-level memory. Backed by a hybrid store combining vectors, graph relationships, and key-value lookups.

Key behavior: **self-editing** -- when facts conflict, Mem0 overwrites rather than appending duplicates, keeping memory lean. However, it lacks temporal fact modeling (no validity windows), scoring 49.0% vs Zep's 63.8% on the LongMemEval benchmark.

**Storage:** Hybrid vector + graph + KV store.
**Retrieval:** Semantic search against the memory store, injected into prompts before each LLM call.
**What it learns:** User preferences, session context, factual corrections.

### Zep / Graphiti: Temporal Knowledge Graphs

Zep stores every fact as a knowledge graph node with a **validity window**. "Kendra loves Adidas shoes (as of March 2026)" is a fact with temporal bounds. When contradicting information arrives, Graphiti invalidates the old fact without discarding historical record. This temporal modeling drives the 15-point benchmark advantage over flat vector stores.

P95 retrieval latency is ~300ms with no LLM calls at query time (hybrid semantic + BM25 + graph traversal).

**What it learns:** Facts with temporal context -- not just what is true, but when it became true and when it stopped being true.
**Validation:** Supersession model -- new facts invalidate old ones with full audit trail.

### LangMem / LangGraph: Three Memory Types

LangMem introduces the cleanest taxonomy of agent memory types, mapped directly from cognitive science:

- **Semantic memory:** Facts and knowledge (user preferences, domain knowledge). Extracted from conversations via `create_memory_manager`.
- **Episodic memory:** Past experiences preserved as full-context learning examples. Situation + reasoning + outcome.
- **Procedural memory:** The genuinely novel capability -- agents can **update their own system prompt instructions** based on accumulated user feedback. The agent learns what works and modifies its own operating rules.

LangMem's procedural memory is unique: no other framework lets agents rewrite their own behavioral instructions from experience. However, its p95 search latency of 59.82 seconds makes it unsuitable for interactive use.

**Storage:** Pluggable backends via LangGraph's `BaseStore` -- in-memory, SQLite, Postgres, any vector DB.
**Retrieval:** Namespaced by user_id (not thread_id), with semantic search over embeddings.

---

## 2. Self-Improving Agent Architectures

### Voyager: The Skill Library Model

Voyager (NVIDIA/Caltech, 2023) remains the most influential architecture for agents that build reusable skill libraries. Three components work together:

**Automatic Curriculum:** GPT-4 generates increasingly complex tasks based on exploration progress and agent state. The overarching goal is "discovering as many diverse things as possible" -- an in-context form of novelty search. A chain of four LLM calls: question generation, question answering, task generation, and subtask decomposition.

**Skill Library:** Each skill is stored as **executable JavaScript code** indexed by the embedding of its natural language description. Skills are interpretable, reusable, and compositional. When faced with a new task, the agent queries the library with the task description embedding to retrieve the top-5 most relevant skills. Complex behaviors are synthesized by composing simpler programs -- `craftIronPickaxe()` calls `mineIronOre()` which calls `craftWoodenPickaxe()`.

**Iterative Prompting:** Generated code is executed, environment feedback and execution errors are fed back into the prompt for refinement. Self-verification checks task completion before adding to the library. Only verified skills get stored.

**What it learns:** Executable procedures (code), not facts or heuristics.
**How it stores:** Skills as code files, indexed by description embeddings in a vector store.
**How it retrieves:** Semantic similarity between current task intent and skill descriptions.
**How it validates:** Self-verification via environment feedback. Failed code is iteratively refined, not stored.
**Composition:** New skills call existing skills as functions. This compounds capabilities and prevents catastrophic forgetting.

Critical analysis: Many Voyager "skills" are thin wrappers around basic API calls (e.g., `collectBamboo`, `craftChest`). A declarative reasoning agent could derive these from first principles without expensive skill generation. The real value is in composition and caching of multi-step procedures.

### ExpeL: Experiential Learning Through Insight Extraction

ExpeL (2023) introduces a three-stage learning pipeline that operates entirely through natural language, without parameter updates:

**Stage 1 -- Experience Collection:** The agent attempts training tasks using Reflexion-style retry loops. Both successful and failed trajectories are stored in an experience pool. This trial-and-error process generates success/failure pairs for the same tasks.

**Stage 2 -- Insight Extraction:** An LLM analyzes experiences in two ways: (a) comparing failed vs. successful trajectories for the same task to identify what went wrong, and (b) identifying common patterns across multiple successful trajectories. The key mechanism is four insight management operations: **ADD**, **UPVOTE**, **DOWNVOTE**, and **EDIT**. Insights accumulate confidence scores through voting -- frequently confirmed patterns get upvoted, contradicted ones get downvoted.

**Stage 3 -- Application:** At inference, the full list of extracted insights is concatenated into the task specification, and top-K most similar successful trajectories are retrieved as few-shot examples.

**What it learns:** Natural language insights (heuristics, failure patterns, best practices) + exemplar trajectories.
**Storage:** A flat list of insights with vote counts, plus a vector store of successful trajectories.
**Retrieval:** All insights are included in context (no selective retrieval); trajectories are retrieved by task similarity.
**Validation:** Voting mechanism (upvote/downvote) based on whether insights are confirmed across tasks.
**Transfer:** Insights from one task distribution can transfer to related distributions with minimal additional examples.

ExpeL's insight voting mechanism is directly relevant to Safari Pilot: domain heuristics that work across multiple sites get upvoted, site-specific quirks that fail elsewhere get downvoted or scoped.

### Reflexion: Verbal Self-Reflection as Memory

Reflexion (Shinn et al., 2023) adds a self-reflection step after task failure. The agent generates a natural language critique of its own trajectory -- what went wrong, what to try differently -- and stores this as a "reflection" in a sliding window memory. On retry, these reflections are injected into the prompt alongside the task.

Key limitation: Reflexion operates within a single task's retry loop. It does not transfer knowledge across tasks (unlike ExpeL, which does). However, the self-reflection mechanism -- generating verbal critiques of failure -- is powerful for producing actionable corrective memory.

**What it learns:** Natural language self-critiques of failed attempts.
**Storage:** Sliding window of recent reflections (newest N).
**Feedback loop:** Implicit -- failure triggers reflection, reflection guides the next attempt.

---

## 3. RPA with Learning/AI

### UiPath AI Center

UiPath AI Center is an MLOps platform for deploying and managing ML models within RPA workflows. The learning model is traditional supervised ML:

- Pre-built ML models for document understanding, text classification, language translation
- Human-in-the-loop retraining: humans validate model predictions, corrections feed back into training data
- Automatic retraining pipelines: models improve as more labeled data accumulates
- Drag-and-drop integration: ML skills are consumed as activities within UiPath Studio

The learning is model-level (retrain a classifier) rather than agent-level (learn procedures). There is no self-directed exploration or skill composition.

### Automation Anywhere IQ Bot / Document Automation

IQ Bot's learning mechanism is specifically about document processing:

- Supervised learning from human corrections: validators manually fix extraction errors through a web interface
- The correction data feeds back into the ML model, improving future extractions
- "Straight-through processing" (STP) rates improve from ~30% to 60-80% over 3-6 months
- The ML component learns document layout recognition (where fields are), while OCR handles the actual text extraction

The newer Document Automation product extends this: operators draw zones over missed data, and the system learns to auto-extract from similar locations on future documents. This is a clear example of learning from correction, but it is narrow -- document layout, not general task procedures.

### Microsoft Power Automate + Copilot

Power Automate's AI integration is primarily generative rather than adaptive:

- Copilot suggests automation flows from natural language descriptions
- Process mining analyzes existing workflows to suggest automation opportunities
- No persistent learning from execution outcomes -- each suggestion is independent

---

## 4. Browser Automation Recording and Adaptation

### Playwright Codegen

Playwright's test generator records user interactions and produces executable test scripts. Key characteristics:

- **Recording:** Listens to browser events (clicks, keyboard input, navigation, DOM changes) and generates Playwright API calls in real time.
- **Smart selectors:** Prioritizes role-based, text, and test-id locators over brittle XPath/CSS. When multiple elements match, it improves the locator to be uniquely identifying.
- **Limitations as a "recipe" system:** Codegen is a recorder, not a framework. Generated selectors are often the weakest link. Hard-coded XPaths break with layout shifts; text-based selectors fail with localization changes. The generated code needs manual refinement for production use.

For Safari Pilot's recipe system, Playwright Codegen demonstrates that recording raw interaction traces is only the starting point. The value is in the refinement layer: abstracting specific values into parameters, hardening selectors, and adding assertions.

### Self-Healing Test Automation

The most directly relevant innovation for Safari Pilot's adaptive layer. Multiple approaches exist:

**Multi-attribute element fingerprinting:** Instead of depending on a single selector, self-healing engines collect a rich fingerprint: ID, label, visible text, class, position, surrounding context. When any single attribute changes, the engine still recognizes the component.

**Learning-based locator recalibration:** When tests succeed, the platform records original locators, page state, and inferred user intent. On failure, the engine uses this stored intent to search for a matching element and recalibrate automatically. ML algorithms detect page changes and find new controls in real time.

**Visual + DOM hybrid detection:** Combining DOM attributes with visual cues (layout, text, relative positioning). Even when the underlying DOM shifts, visual context helps find the correct element.

**Intent-based locators (Momentic, etc.):** Describe what you want in natural language ("Click the Submit button"), then AI maps intent to the correct UI element. This is the most resilient approach -- it survives complete redesigns as long as the conceptual element exists.

Tools implementing these: Healenium (open source), Testim (AI-based, learns patterns over time), Momentic (intent-based), BrowserStack (AI self-heal), Functionize (multi-attribute + ML).

### Axiom.ai

Axiom is a no-code Chrome extension for browser automation. Users build bots through a visual interface with templates for common tasks. Key characteristic: all bots live on the user's computer and process data in their browser -- no server-side execution. Axiom handles site changes through template updates and user reconfiguration rather than adaptive learning.

---

## 5. Web Agent Research (2024-2025): The Skill Library Frontier

### Agent Workflow Memory (AWM) -- ICML 2025

AWM (Wang et al., CMU) introduces **workflow induction** -- extracting reusable sub-routines from past experiences and selectively providing them to guide future actions. This is the most directly relevant paper for Safari Pilot's recipe system.

**Workflow representation:** Natural language descriptions of common sub-procedures, with example-specific values abstracted into parameters. E.g., a concrete "search for dry cat food" becomes a workflow "search for {product-name} on Amazon."

**Two modes:**
- *Offline:* Workflows induced from training examples, then used for all test tasks.
- *Online:* Workflows induced on-the-fly from the agent's own test-time experiences in a streaming fashion. After each task, new workflows are extracted and added to memory.

**Key results:** 24.6% and 51.1% relative success rate improvements on Mind2Web and WebArena. Online AWM generalizes across tasks, websites, and domains -- surpassing baselines by 8.9 to 14.0 absolute points as train-test distribution gaps widen.

**Design insight:** Abstract sub-routines outperform concrete examples. When you inject full examples, agents bias toward selecting elements similar to the examples. Workflows with abstracted parameters introduce less bias and enable higher generalization.

### WALT: Web Agents that Learn Tools -- 2025

WALT (Salesforce Research) takes a fundamentally different approach from skill discovery: instead of mining agent trajectories for reusable patterns, it **reverse-engineers the website's own functionality** into callable tools.

**The insight:** Websites already have robust, designed functionality -- search bars, filter mechanisms, sorting controls, commenting systems. WALT exposes these as high-level deterministic calls: `search(query='blue kayak', category='Boats', sort_by='price')` replaces 8+ fragile UI steps with 1 robust operation.

**Tool construction pipeline:**
1. *Discovery:* Browser agent explores key site sections, proposes tool candidates, records stabilized interaction traces with robust selectors and fallbacks.
2. *Construction:* A tool constructor agent turns traces into action scripts (navigation, extraction, interaction steps). URL parameters replace multi-step UI interactions where possible. Input schemas with validation are generated.
3. *Validation:* Tools are tested end-to-end against test inputs before being registered.

**Results:** State-of-the-art: 52.9% on VisualWebArena, 50.1% on WebArena. Tools improved success rates by up to 30.7% relative and reduced steps by 1.4x.

WALT's distinction from AWM/SkillWeaver: tools correspond to *website-provided functionality* that site designers already engineered as robust automations, not agent-imagined skills implemented as brittle UI action sequences.

### SkillWeaver -- 2025

SkillWeaver (Ohio State / CMU) enables web agents to self-improve through a three-phase cycle:

1. **Exploration:** Given a new website, the agent autonomously discovers potential skills.
2. **Practice:** The agent executes discovered skills to gather practice experience.
3. **Distillation:** Practice experiences are distilled into robust, unit-tested Python API functions.

Iterative exploration continually expands the skill library. Skills are lightweight, plug-and-play APIs that can transfer between agents: APIs synthesized by strong agents improve weaker agents by up to 54.3%.

### ScribeAgent and WebRL: Learning from Scale

Two complementary approaches to learning from browser interaction at scale:

- **ScribeAgent** (2024): Fine-tunes a smaller open LLM on billions of real user-browser interaction traces across 250+ domains. The massive workflow corpus gives the agent "instincts" for common web tasks.
- **WebRL** (2024): Reinforcement learning with a self-evolving curriculum. An 8B model went from <5% to 42% success, outperforming GPT-4's 17% on the same tasks.

---

## 6. Comparative Synthesis: What Works, What Doesn't

| Dimension | Best Approach | Why It Wins | Failure Mode |
|---|---|---|---|
| **Skill storage** | Code (Voyager, SkillWeaver, WALT) | Executable, composable, testable | Brittle to DOM changes without self-healing |
| **Knowledge storage** | Natural language insights with voting (ExpeL) | Transferable, interpretable, self-correcting | Can bloat context; no selective retrieval |
| **Domain adaptation** | Reverse-engineering site functionality (WALT) | Uses what the site already built | Requires per-site discovery phase |
| **Cross-site transfer** | Abstract workflows with parameters (AWM) | Site-agnostic sub-routines generalize | Loses site-specific optimizations |
| **Memory architecture** | OS-inspired tiered (Letta) | Agent controls its own memory lifecycle | Complex to implement; agent can corrupt its own memory |
| **Temporal reasoning** | Knowledge graphs with validity windows (Zep) | Handles fact evolution correctly | More complex storage and query infrastructure |
| **Self-correction** | Insight voting (ExpeL) + self-reflection (Reflexion) | Combines cross-task learning with per-task critique | Voting requires sufficient task volume to be meaningful |
| **Resilience to UI changes** | Multi-attribute fingerprinting + intent-based locators | Survives redesigns if conceptual elements persist | Completely new UIs still require re-recording |

---

## 7. Lessons for Safari Pilot's Recipe System

### Layer 1: Domain Knowledge

**Adopt from:** Zep's temporal fact modeling + ExpeL's insight voting

Safari Pilot should store domain knowledge as timestamped facts with validity windows, not flat key-value pairs. "Amazon uses a `#add-to-cart` button (as of 2026-04-13, confirmed 47 times)" is far more useful than just "Amazon: #add-to-cart". When a site redesigns, old knowledge is invalidated but preserved for rollback.

Insight voting maps naturally: a selector strategy that works on 15 shopping sites gets upvoted; one that only works on Amazon gets scoped. Cross-domain patterns emerge organically.

**Concrete design:**
- Store as `{domain, fact, confidence_score, first_seen, last_confirmed, last_failed, scope}`
- Confirm on every successful use; flag on failure; invalidate after N consecutive failures
- Graduated retrieval: high-confidence facts always in context; low-confidence facts only when semantically relevant

### Layer 2: Recorded Flows (Recipes)

**Adopt from:** AWM's abstract workflows + WALT's tool construction + Playwright's selector intelligence

Recipes should be stored at two levels:
1. **Abstract workflows** (AWM-style): parameterized sub-routines like "add {product} to cart on {e-commerce-site}" with abstracted selectors and values. These transfer across sites within a domain.
2. **Site-specific tools** (WALT-style): reverse-engineered from the site's own functionality. Instead of scripting 8 clicks to search, use the site's URL query parameters directly.

WALT's key insight is directly applicable: Safari Pilot's extension has visibility into the page's actual DOM structure, URL patterns, and form mechanics. Tool construction should prefer URL manipulation and API-like interactions over UI simulation wherever possible.

**Concrete design:**
- Record raw interaction traces (Playwright Codegen-style) during initial use
- Abstract into parameterized workflows (AWM-style) after successful execution
- Attempt to promote UI sequences to URL/API operations (WALT-style optimization)
- Index by intent embedding for retrieval (Voyager-style)
- Validate before storing (Voyager's self-verification)

### Layer 3: Learned Heuristics

**Adopt from:** ExpeL's insight extraction + LangMem's procedural memory + Self-healing's multi-attribute fingerprinting

Heuristics are the system's accumulated wisdom about *how* to interact with the web effectively. Three categories:

1. **Selector heuristics:** Multi-attribute fingerprints for key elements. Not just the CSS selector, but the element's role, visible text, position relative to siblings, ARIA labels, and inferred intent. When any attribute changes, the others provide redundancy. This is self-healing test automation applied to browser automation recipes.

2. **Timing heuristics:** Learned wait strategies per domain. SPAs that use client-side routing need different waiting than server-rendered pages. The system should learn these from observation, not require manual configuration.

3. **Failure pattern heuristics:** ExpeL-style insights extracted from failed automation attempts. "On sites using React, always wait for the loading spinner to disappear before clicking navigation links" -- derived from comparing failed vs. successful attempts across React-based sites.

**Concrete design:**
- After each tool execution, compare expected vs. actual outcome
- On failure: generate a Reflexion-style verbal self-critique and store it
- Periodically run ExpeL-style insight extraction across accumulated failure/success pairs
- Insights with high vote counts graduate to always-included context (LangMem procedural memory pattern)
- Low-confidence insights are retrieved only when semantically relevant to the current task

### Architecture Recommendation: Two-Tier Memory with Background Consolidation

Drawing from Letta's tiered model:

**Hot memory (always in context):** Current domain's high-confidence facts, active recipe for the current task, graduated heuristics. Equivalent to Letta's core memory.

**Cold storage (retrieved on demand):** Full recipe library, domain knowledge archive, historical heuristics. Equivalent to Letta's archival memory. Indexed for semantic retrieval.

**Background consolidation (async):** After each session or task completion, a background process:
1. Extracts new insights from the session's success/failure patterns (ExpeL)
2. Updates confidence scores on domain knowledge (Zep temporal model)
3. Attempts to abstract site-specific recipes into cross-site workflows (AWM)
4. Runs self-healing analysis on any selector failures (multi-attribute recalibration)

This mirrors Letta's sleeptime agent pattern -- learning happens between interactions, not during them.

### What NOT to Build

1. **Do not build a full knowledge graph.** Zep/Cognee-style graph construction is overkill for browser automation. Simple timestamped facts with confidence scores cover 90% of the use case.

2. **Do not fine-tune models.** Every system reviewed that relies on parameter-free learning (ExpeL, Voyager, AWM, WALT) outperforms fine-tuning approaches in flexibility and transferability. Safari Pilot's learning should be entirely prompt-based and file-based.

3. **Do not store raw interaction traces long-term.** Only store the abstracted, parameterized recipe. Raw traces are useful during the abstraction phase, then discarded. Voyager stores code, not training data.

4. **Do not implement "always learning" during task execution.** Learning on the hot path adds latency and risk. Adopt Letta's pattern: execute tasks with existing knowledge, consolidate and learn in the background.

---

## Key References

| System | Year | Type | Key Paper/URL |
|---|---|---|---|
| Voyager | 2023 | Skill library agent | arXiv:2305.16291 |
| Reflexion | 2023 | Self-reflection agent | arXiv:2303.11366 |
| ExpeL | 2023 | Experiential learning | arXiv:2308.10144 |
| MemGPT/Letta | 2023-2026 | Tiered memory platform | letta.com |
| Mem0 | 2024-2026 | Drop-in memory API | mem0.ai |
| Zep/Graphiti | 2024-2026 | Temporal knowledge graph | getzep.com |
| LangMem | 2025 | Three-type memory SDK | langchain-ai/langmem |
| AWM | 2024 (ICML 2025) | Workflow induction | arXiv:2409.07429 |
| SkillWeaver | 2025 | Skill synthesis framework | arXiv:2504.07079 |
| WALT | 2025 | Tool reverse-engineering | arXiv:2510.01524 |
| WebRL | 2024 | RL for web agents | arXiv:2411.02337 |
| ScribeAgent | 2024 | Large-scale trace training | arXiv:2411.15004 |
