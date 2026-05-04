# Executive Summary

Multi-element extraction is an essential capability for agentic browser automation, enabling complex workflows beyond simple single-element interactions. Key real-world use cases include enumerating and processing search engine results, extracting structured data from tables, discovering all links matching a specific pattern, and scraping repeatable items like cards or tiles from feeds. Unlike human-authored scripts that often rely on unique, deterministic selectors, LLM-driven agents require the ability to retrieve multiple elements to handle ambiguity, perform parallel evaluations (e.g., compare products), resolve uncertainty, execute batch operations (e.g., download all invoices), and enable adaptive navigation. An analysis of three potential API designs for a server like 'Safari Pilot' reveals that an API returning an array of stable element references (Design 1: `safari_query_all`) is the most effective. This design minimizes LLM-to-browser round-trips for chained operations and provides a highly composable interface where references act as clean tokens for subsequent actions like clicks or further extractions. This 'query-then-act' pattern is supported by findings in academic literature on agentic DSLs, which favor stable identifiers to reduce prompt complexity and improve reliability.

# Api Design Recommendation

The recommended API design for a server like 'Safari Pilot' is **Design 1: A new tool, `safari_query_all`, that returns an array of element references.**

This design is optimal because it provides the best balance of minimizing LLM round-trips and maximizing composability for chained operations. The workflow follows a clean 'query-then-act' pattern:
1.  The agent makes a single call to `safari_query_all` with a selector, retrieving a list of opaque, stable element references (e.g., `[ref_id_1, ref_id_2, ...]`)
2.  The agent can then use these references in any number of subsequent action tools (`safari_click(ref_id)`, `safari_extract(ref_id)`, etc.) without needing to re-query the page to find the element each time.

This approach is superior to the alternatives:
*   **Design 2 (`--all` flag):** While it can reduce round-trips in specific inspect-then-act scenarios by returning data inline, it leads to large, cumbersome payloads and requires the LLM to parse a complex structure to extract the reference for the next action. This makes it less clean and scalable.
*   **Design 3 (structured extractors):** This design is highly efficient for its specific purpose (e.g., extracting a table) but lacks flexibility. It does not compose well with subsequent, arbitrary DOM actions unless it is modified into a hybrid model that also returns element references for each structural part (e.g., each table row), which essentially brings it closer to the principles of Design 1.

Therefore, a dedicated tool that returns a simple list of references is the most robust and versatile foundation for an agentic browser automation API, a conclusion supported by patterns observed in academic benchmarks like Spider and WebArena.

# Multi Element Extraction Use Cases

## Use Case Name

Listing Search Results

## Description

This use case is essential for agents needing to enumerate, rank, and analyze all items in a search engine results page (SERP) or similar listing. Relying on a single first match is often insufficient as it may be an ad or not the most relevant result. Multi-element extraction allows for comprehensive data gathering (titles, URLs, snippets) for indexing, comparison, or specific interactions.

## Example Workflow

The workflow begins with an input, such as a search query or URL. The agent then waits for the results container to load, uses a multi-element locator (like Playwright's `locator.all()`) to capture all result items, and extracts key data points like title, text, href, snippet, and visibility status. The output is a structured list of result objects. Follow-on actions typically include deduplication, opening the top N results for further data gathering, SERP monitoring, or simulating user clicks.

## Common Edge Cases

Common challenges include handling lazy-loading and infinite scroll, which require the agent to programmatically scroll and wait for new items to appear. Other edge cases are navigating pagination controls, identifying and filtering out sponsored ads or pinned items, and accessing content encapsulated within Shadow DOM or iframes, which requires specialized API calls.

## Required Data Points

Key data points include cleaned and normalized text content, `href` and `src` values resolved to absolute URLs, ARIA roles and labels for semantic understanding, bounding boxes (x, y, width, height) for visual context and screenshotting, the index or order of the element for ranking, and stable identifiers (like `data-id`) to support deduplication and change detection.

## Use Case Name

Table Extraction

## Description

This is critical for structured data import from web pages, such as financial reports, pricing grids, or product comparison lists. Multi-element extraction is necessary to capture all rows (e.g., `<tr>` elements) and cells to accurately reconstruct the entire dataset for analysis or storage.

## Example Workflow

The process starts with a URL or a specific selector for the target table. The agent locates all row elements (e.g., using `tr` or `role="row"`) and, within each row, extracts data from every cell, including text, links, and images. The workflow must also handle complex table structures like `colspan` and `rowspan` for normalization. The output is typically a normalized array of row data, which can then be used for follow-on actions like conversion to CSV or a database format, data analytics, or change detection over time.

## Common Edge Cases

Agents frequently encounter inconsistent or malformed HTML, such as improper `colspan` or `rowspan` attributes that break simple extraction logic and require normalization. Other challenges include tables embedded within iframes, paginated tables that require navigation, and tables with dynamically rendered rows that only appear upon user interaction like scrolling.

## Required Data Points

The agent needs to extract cleaned text from each cell (`<td>`), any links (`href`) or image sources (`src`) within cells, and structural information to correctly handle merged cells. The semantic relationship between header cells (`<th>`) and data cells is also crucial for creating a properly structured dataset.

## Use Case Name

Pattern-Matched Link Discovery

## Description

This use case is fundamental for tasks like web crawling, site mapping, or gathering a specific set of resources, such as all download links for PDF reports on a page. It requires collecting all anchor (`<a>`) tags whose `href` attribute matches a predefined pattern, rather than just the first one found.

## Example Workflow

The workflow is initiated with a base URL and a pattern (e.g., a regular expression or glob) for the desired `href` attributes. The agent uses a multi-element locator to find all anchor tags on the page, filters them based on the href pattern, resolves any relative URLs to absolute ones, and may check other attributes like `rel`. The output is a filtered set of links, often with their corresponding anchor text. Follow-on actions include adding these links to a crawl queue, initiating downloads, or generating a broken link report.

## Common Edge Cases

A primary challenge is correctly resolving relative URLs to absolute ones. Other edge cases include links that are dynamically generated by JavaScript and not present in the initial HTML, honeypot links designed to trap scrapers, and websites with rate-limiting or bot detection that can block extensive link probing.

## Required Data Points

The most critical data point is the `href` attribute, which should be resolved to an absolute URL. Other important data includes the anchor text for context, `rel` attributes (e.g., 'nofollow') to guide crawling behavior, and the visibility status of the link to avoid interacting with hidden or irrelevant elements.

## Use Case Name

Scraping Cards/Tiles from a Feed

## Description

This is used to process dynamic content from social media feeds, news portals, or e-commerce product listings. Extracting all card or tile components is necessary to build a complete view of the feed's content for tasks like deduplication, trend analysis, batch actions, or content archival.

## Example Workflow

The process starts with the feed's URL and a selector for the individual card elements. The agent collects all visible card elements and extracts structured fields such as title, author, timestamp, media URLs, and engagement counts. It must also handle dynamic content loading, either by simulating scrolling or clicking 'load more' buttons. The output is typically a time-ordered list of structured feed items. This data can then be used for downstream summarization, trend detection, or alerts.

## Common Edge Cases

The most common challenge is infinite scroll, which requires the agent to programmatically scroll and wait for new content to load, with logic to detect when the feed has ended. Other difficulties include virtualized lists where DOM elements are mounted and unmounted during scroll, ads or sponsored content mixed with organic items, and content rendered within a Shadow DOM.

## Required Data Points

The agent needs to extract structured fields like title, author, timestamp, and media URLs. Stable identifiers, such as a `data-id` attribute or a canonical URL, are crucial for deduplicating items and tracking them across different sessions. Engagement metrics (likes, shares, comments) are also frequently required.


# Llm Agent Decision Framework

## Decision Drivers

LLM-driven agents require multiple matching elements for several key reasons that go beyond the capabilities of simple first-match logic. These drivers include:

*   **Parallel Evaluation and Comparison:** Agents need to gather a set of candidate elements to evaluate them in parallel, compare their attributes (e.g., price, rating, relevance), and select the best one to proceed with. This is essential for tasks like choosing the cheapest flight or the highest-rated product.
*   **Uncertainty Resolution and Verification:** When an agent's interpretation of a user's intent results in a low-confidence or ambiguous selector, fetching multiple matches allows it to gather more evidence. It can then score the candidates based on context, semantic similarity, or other attributes to make a more accurate choice or escalate to the user for clarification.
*   **Batch Operations:** Many workflows require applying the same action to a group of elements, such as clicking all checkboxes, downloading all invoices, or accepting all cookies. Retrieving all matches is a prerequisite for these bulk actions.
*   **Data Completeness and Aggregation:** For tasks involving data extraction from lists, tables, or feeds, getting all elements is necessary for completeness. This allows for accurate aggregation (e.g., calculating totals, averages) and trend analysis.
*   **Adaptive Navigation and Error Resilience:** If the first-matched element is an ad, a stale/detached node, or otherwise non-interactive, the agent can use the list of other matches as fallbacks to recover and continue the task, improving overall robustness.

## Contrast With Human Scripts

The need for multi-element retrieval highlights a fundamental difference between probabilistic LLM agents and deterministic human-authored scripts.

*   **Human-Authored Scripts:** A human developer writes scripts with a deterministic mindset. They use their cognitive understanding of the page structure to hand-craft specific, unique, and robust selectors (e.g., a unique `id`). The script follows a fixed, predictable flow with explicit assertions and hard-coded fallbacks. The goal is to create a test or automation that is fast, repeatable, and fails predictably if the UI changes.

*   **LLM-Driven Agents:** An LLM agent operates probabilistically. It generates selectors at runtime based on a natural language goal, which can be inherently ambiguous. The agent must handle this ambiguity, along with the dynamic and unpredictable nature of modern web pages. Therefore, it cannot assume the first match is correct. Instead, it must adopt an evidence-driven approach, often retrieving multiple candidates to gather context, verify its choice, and build a more robust execution plan. This approach trades the raw speed of deterministic scripts for flexibility and resilience in complex, unfamiliar environments.

## Key Signals For Decision

An LLM agent uses a wide array of signals to decide whether to fetch multiple elements and how to rank them. These signals are used to build confidence and select the most appropriate element for an action. Key signals include:

*   **Selector and LLM Confidence:** A low confidence score from the LLM's intent-to-selector generation process or a selector that is inherently non-unique (e.g., a generic class name) are strong indicators to fetch multiple elements.
*   **Visual and Layout Features:** The element's position (x, y coordinates), size (width, height), z-index, visibility, and presence within the current viewport are crucial for determining its relevance and interactability.
*   **Metadata and Attributes:** Rich metadata such as `id`, `name`, `data-*` attributes, `href`, `role`, and class names provide strong semantic clues about the element's purpose.
*   **Textual and Semantic Cues:** The element's visible text (`innerText`), ARIA labels, and semantic keywords are compared against the user's intent to rank candidates by relevance.
*   **Structural Cues:** The element's position in the DOM tree, its relationship to parent/sibling nodes, and its membership in a list or table structure help the agent understand its context.
*   **Temporal Signals:** For dynamic content like feeds, timestamps and the order of appearance are important signals for identifying the most recent or relevant items.
*   **Interaction Affordances:** The agent checks if an element is enabled, clickable, focusable, or hidden behind an overlay to determine if an action is possible.

## Common Failure Modes

When retrieving and acting on multiple elements, LLM agents are susceptible to several common failure modes:

*   **Hallucinated or Brittle Selectors:** The agent may generate a selector that doesn't exist on the page or is so fragile that it breaks with minor UI changes.
*   **List Incompleteness:** The agent might fail to retrieve all relevant items due to challenges like pagination, infinite scrolling, or lazy-loaded content, leading to incomplete data or missed actions.
*   **Stale Element References:** The DOM can change between the time an agent retrieves an element reference and when it tries to use it. This can lead to 'stale element' errors if the element has been removed or re-rendered.
*   **Dynamic Content Reshuffling:** In feeds or search results, items can be dynamically re-ordered, causing the agent to act on the wrong element if it relies solely on its initial index.
*   **Ambiguity and Duplicates:** The agent may struggle to differentiate between visually similar or identically labeled elements (e.g., multiple 'Delete' buttons), leading to incorrect actions.
*   **Hidden or Obscured Elements:** Elements that are visually hidden (`display: none`), have zero size, or are covered by overlays (like cookie banners) can be matched by a selector but cannot be interacted with, causing failures.
*   **Token and Payload Overload:** Retrieving the full HTML or attributes for a large number of elements can exceed the LLM's context window or create excessively large network payloads, leading to truncation and loss of information.

## Mitigation Guardrails

To counteract common failure modes and ensure reliable operation, several guardrails and mitigation strategies are essential:

*   **Capping and Sampling:** Limit the number of elements retrieved (e.g., top-K where K is between 5 and 20) to prevent payload overload and reduce processing time. For very large lists, sampling can be used instead of exhaustive retrieval.
*   **Timeouts and Budgets:** Implement strict timeouts for each step and a total budget for the multi-element operation to prevent the agent from getting stuck in infinite scroll loops or long-running tasks.
*   **Confidence Thresholds:** Define confidence score thresholds to guide the agent's behavior. For example, a high-confidence match might proceed autonomously, a medium-confidence match might trigger extra verification steps, and a low-confidence match would require escalating to a human for clarification.
*   **Deduplication and Normalization:** Before processing, normalize element attributes (e.g., URLs) and use content hashing or unique IDs to deduplicate the list of retrieved items.
*   **Atomic Action Verification:** After performing an action on an element, the agent should immediately verify its outcome (e.g., by checking for a resulting DOM change) before proceeding.
*   **Robust Selector Strategies:** Encourage the use of more stable, semantic selectors (e.g., based on ARIA roles or `data-*` attributes) over fragile, auto-generated CSS classes. Implement fallback chains for selectors.
*   **PII Redaction and Sandboxing:** Run the browser in an isolated environment and automatically detect and redact personally identifiable information (PII) from DOM snapshots before they are logged or sent to an LLM.


# Existing Tool Patterns Analysis

## Tool Name

browser-use

## Api Primitives

The core primitive is a `state` call that returns a numbered list of all interactive DOM elements on the page. Subsequent actions, like `click`, refer to elements using their assigned index (e.g., `click 5`).

## Return Schema

The API returns an array of element objects, where each object contains the element's text, its attributes, and a stable numeric index that is valid for the current session.

## Reference Semantics

Element references are simple numeric indices that are scoped to a single browser session and state. They are ephemeral and must be regenerated by re-running the `state` command to get a new snapshot of the page after any interaction.

## Bulk Operations Support

There is no native support for bulk operations like `click_many`. Such operations must be implemented by the client by scripting a sequence of individual commands in a loop.

## Ergonomics Summary

The index-based list is simple and intuitive for an LLM to process. However, it is less robust than selector-based locators and lacks the stable, persistent handles offered by tools like Playwright, making it vulnerable to dynamic DOM changes.

## Tool Name

AgentQ

## Api Primitives

AgentQ is described in research as a reasoning framework that relies on environment-specific adapters rather than having its own dedicated DOM extraction API. A 'batch-query' operation has been mentioned, which would yield an array of DOM nodes.

## Return Schema

The return schema is not publicly defined and depends entirely on the implementation of the specific adapter being used. It can be any arbitrary JSON structure.

## Reference Semantics

Reference management is dependent on the chosen adapter; no standard persistence model or lifecycle is publicly disclosed.

## Bulk Operations Support

Bulk operations are not documented as a standard feature. Support for actions like `click_all` would require custom logic to be built into the adapter.

## Ergonomics Summary

As a research prototype, AgentQ lacks the out-of-the-box, LLM-oriented primitives for element interaction found in commercial tools. Its ergonomics are highly dependent on the quality and design of its custom adapters.

## Tool Name

OpenAI Operator / Computer Use (CUA)

## Api Primitives

The system uses a combination of `screenshot` and `state` commands to return an ordered set of detected UI elements. The LLM then generates a structured JSON object defining the next action(s) to be executed.

## Return Schema

The API returns arrays of element descriptors, which typically include the element's text, its bounding box coordinates, and optional unique IDs.

## Reference Semantics

Element references are ephemeral and tightly coupled to the specific screenshot or state from which they were generated. They must be re-resolved after any UI change or new snapshot.

## Bulk Operations Support

The model can emit a list of actions (e.g., multiple `click` operations) within a single response. The execution environment can then process this list, effectively enabling batch operations.

## Ergonomics Summary

This approach is designed specifically for LLMs, using natural language descriptions and visual cues (bounding boxes) which are more intuitive for a model than technical selectors like CSS or XPath. However, this can be less precise and deterministic than locator-based tools.

## Tool Name

Anthropic Computer Use

## Api Primitives

This framework relies on custom, developer-provided tools via a tool-calling interface. A custom tool can be implemented to find and return an array of elements. A `search` tool can also return multiple snippets that the LLM can then loop over.

## Return Schema

The return schema is entirely dependent on the implementation of the custom tool. It typically consists of a JSON array containing metadata for each element.

## Reference Semantics

Reference semantics are not standardized and are managed by the underlying custom tool. There is no built-in model for reference lifetime or persistence.

## Bulk Operations Support

Bulk operations are possible through tool-chaining. A tool can return a list of element objects, and the LLM can then generate a sequence of actions to iterate over them.

## Ergonomics Summary

The system is highly flexible due to its custom tool-based architecture but requires significant implementation effort from the developer. It offers less out-of-the-box support for browser automation compared to more specialized tools.

## Tool Name

MultiOn

## Api Primitives

MultiOn provides high-level, agent-oriented primitives like `extract_many` and a `retrieve` function that can get structured data from any webpage, abstracting away the need for manual selector creation.

## Return Schema

The API returns structured arrays of element data, which include stable element IDs, bounding boxes, text, attributes, and even HTML snippets.

## Reference Semantics

The system uses session-scoped tokens or references that can be reused for subsequent actions within the same agent session. Re-resolution of elements is handled by the platform.

## Bulk Operations Support

The platform provides native, first-class support for bulk operations, including `click_many` and `screenshot_many`.

## Ergonomics Summary

MultiOn is highly optimized for multi-step LLM workflows. Its high-level abstractions and native bulk action support make it very ergonomic for agents, though it offers less fine-grained control than low-level tools like Playwright.

## Tool Name

Adept ACT-1

## Api Primitives

The system operates through tool adapters that expose functions like `extract_many`, which return arrays of element objects to the agent.

## Return Schema

The return schema is typically a JSON array where each object represents an element and contains its text, attributes, and optional layout data.

## Reference Semantics

Reference management is specific to each adapter. Identifiers are generally transient and require a fresh API call to re-resolve after the page state has changed.

## Bulk Operations Support

Bulk operations are achieved via tool-chaining. The model can request multiple actions in a single turn by iterating over the list of elements returned by an extraction tool.

## Ergonomics Summary

The framework emphasizes LLM-driven tool chaining using high-level abstractions. This is more natural for an LLM to work with compared to writing code but provides fewer deterministic handles for precise, programmatic control than Playwright.


# Academic Literature Insights

## Key Papers And Benchmarks

Influential academic works reviewed include ScribeAgent, WebArena, and Spider 2.0. ScribeAgent fine-tunes models on pruned HTML-DOM inputs to improve performance, achieving a 53% success rate on the WebArena benchmark. WebArena itself is a realistic web environment where agents select elements using unique IDs or coordinates, framing selection as a classification problem to avoid ambiguity. Spider 2.0, while focused on text-to-SQL, includes multimodal tasks that require agents to reason over structured table outputs, underscoring the importance of stable schemas.

## Structured Vs Reference Apis

The literature highlights a key trade-off. High-level structured extractors, which return clean, pre-processed data (e.g., a JSON object from a table), reduce prompt complexity for the LLM and can improve accuracy by abstracting away noisy HTML. ScribeAgent's DOM pruning is an example of this. In contrast, low-level, reference-based APIs that return element IDs or handles offer greater flexibility for fine-grained, chained actions but require the agent to manage state and handle potential ambiguity, as seen in WebArena's ID-based selection mechanism.

## Token And Latency Implications

Returning full inline text and attributes for multiple elements significantly increases token usage and, consequently, API costs and latency. The ScribeAgent paper noted that doubling the context window from 32K to 65K tokens provided only modest accuracy gains while increasing inference latency by approximately 4x. Conversely, returning concise references (like element IDs) keeps token usage low but may necessitate additional round-trips if the agent needs to inspect an element's data before deciding on an action.

## Recommended Best Practices

Based on findings from these papers, several best practices are recommended for designing agentic browser DSLs. These include: 1) DOM Pruning and Attribute Filtering to remove non-essential HTML and reduce the context size sent to the LLM. 2) Using Stable Element Identifiers (e.g., `data-id` attributes) instead of brittle CSS selectors or coordinates to ensure robust element selection. 3) Implementing explicit logic to handle common web patterns like Pagination and to perform Deduplication of results. 4) Applying Noise Handling techniques, such as filtering out attributes with a low character-to-token ratio, to clean the input for the model.


# Api Design 1 Evaluation Query All With Refs

## Description

This API design introduces a new, dedicated tool named 'safari_query_all'. Its function is to take a selector as input and return an array of opaque element references (e.g., [e1, e2, e3...]). These references serve as targets for subsequent action tools, such as 'safari_click(e1)' or 'safari_extract(e2)', allowing the agent to perform operations on specific elements from the matched set.

## Pros

The primary advantages of this design are its efficiency and flexibility. It results in a minimal payload on the initial query because it only returns lightweight references, not the full text or attributes of the elements. This defers data serialization until it's explicitly needed. Furthermore, it offers high composability, as the opaque reference tokens can be cleanly passed to any subsequent action tool, enabling flexible and powerful chained operations.

## Cons

The main drawback is the increased complexity of state management. The server must maintain the state of these element references, which introduces state coupling. This necessitates a robust system for managing the lifecycle of references, as they can become stale if the page's DOM changes. The LLM-driven agent must also be designed to handle these stale references correctly, potentially requiring re-resolution logic.

## Round Trip Analysis

This design is rated as having a 'moderate' number of round trips. A single call to 'safari_query_all' is sufficient to obtain all the necessary references. Subsequent actions can then reuse these references without needing additional query calls to the page. However, if the agent needs to inspect the content of the elements to decide which one to act upon, an additional round trip would be required to extract that data before the final action, making it a two-step process in some scenarios.

## Composition Analysis

This design composes exceptionally well with chained operations, particularly for low-level DOM manipulations. The clean, opaque references act as handles that can be passed from one tool to another, creating a highly flexible workflow. For example, an agent can query all elements, filter them based on extracted text in a second step, and then click a specific element in a third step, all while using the same initial set of references. However, this high degree of composition is dependent on careful management of the reference lifecycle.


# Api Design 2 Evaluation All Flag Inline Data

## Description

This API design proposes extending existing single-element query tools with an '--all' flag. When this flag is used, the tool's behavior changes to find all matching elements and return an array of objects. Each object in the array contains the element's reference, its human-readable text, and relevant attributes, all provided inline within a single response.

## Pros

The main advantage of this design is its efficiency in workflows that mix inspection and action. By returning both the references for future actions and the human-readable data for immediate LLM reasoning in a single call, it can significantly reduce the number of round trips. This is particularly useful when the agent needs to evaluate the content of multiple elements before deciding which one to interact with.

## Cons

The primary disadvantages are the potential for large payloads and data redundancy. Returning text and attributes for every matched element can make the response verbose, increasing bandwidth usage and token costs for the LLM. If the agent's task only requires the references for a bulk action (e.g., 'click all'), the included text and attributes are redundant and wasteful. It also still requires the same robust reference lifecycle management as the first design.

## Round Trip Analysis

This design is optimized to minimize round trips, especially for scenarios where the agent needs to both inspect element data and have a reference for a subsequent action. In these cases, a single tool call can provide all the necessary information for the LLM to make a decision, often reducing the process to just one query call and one action call. This makes it the most efficient design in terms of round trips for mixed inspection-action workflows.

## Composition Analysis

This design offers good, practical composition. The agent can easily parse the response to use the inline text for decision-making while extracting the reference to pass to a subsequent action tool. The context suggests that a hybrid approach, like this design, which returns both stable references and structured data, offers the best balance for practical composition in real-world agentic workflows. It's less 'pure' than a refs-only approach but often more pragmatic.


# Api Design 3 Evaluation Integrated Structured Extractors

## Description

This API design focuses on integrating multi-element extraction capabilities into specialized, high-level tools. Rather than a generic query tool, this approach uses task-specific tools like 'safari_extract_links' or 'safari_extract_tables'. These tools are designed to find all relevant elements for their specific purpose and return a fully-structured array of high-level data (e.g., a clean JSON object of all links with their text and hrefs).

## Pros

This design is considered the best for pure information extraction tasks. It returns high-level, structured JSON that is easy for the LLM to consume, minimizing the need for the LLM to reason about low-level DOM details, selectors, or parsing. This abstraction simplifies the agent's logic and can lead to more reliable extraction for common patterns like tables and lists.

## Cons

The main disadvantage is its lack of flexibility. Because these tools are specialized for extraction, they typically do not return element references. This makes the design ill-suited for tasks that require a subsequent DOM action (like clicking or typing) on one of the found elements. To support such actions, the tool would need to be modified to also return references, at which point it would begin to resemble Design 2.

## Round Trip Analysis

For its intended purpose of pure information extraction, this design is the most efficient in terms of round trips. A single call to a tool like 'safari_extract_tables' can yield all the desired information in one go, making it minimal for extraction-only workflows. However, if a follow-up action is needed, it would require a completely new query to find the element again, increasing the total round trips significantly.

## Composition Analysis

The composition of this design is rated as low to medium. It composes well if the entire task is about extraction, as the structured output can be passed to data processing or summarization tools. However, it composes poorly with tools that perform DOM actions, as it doesn't provide the necessary handles or references. This limits its use to the beginning or end of a workflow and makes it difficult to chain with interactive steps.


# Comparative Round Trip Analysis

A comparative analysis of the three API designs reveals different efficiencies in minimizing LLM round-trips depending on the specific task workflow.

**Design 1: `safari_query_all` returning element references**
*   **Workflow:** 1. `safari_query_all` -> `[ref1, ref2, ...]`. 2. LLM reasons over the list of refs. 3. `safari_extract(ref1)` -> `text1`. 4. `safari_click(ref2)`. 
*   **Analysis:** This design requires an initial call to get all references. Each subsequent inspection or action on an element requires another round-trip. For bulk operations (e.g., `click_many([ref1, ref2])`), it can be very efficient (2 total calls: 1 query, 1 bulk action). It excels in workflows with many chained actions on a known set of elements.
*   **Round-trips:** Moderate. The initial query is one trip, but subsequent data gathering before an action can add trips.

**Design 2: `--all` flag returning refs + text + attributes inline**
*   **Workflow:** 1. `safari_query_all --all` -> `[{ref1, text1}, {ref2, text2}, ...]`. 2. LLM reasons over the inline data and decides to `safari_click(ref2)`.
*   **Analysis:** This design is highly efficient for workflows that mix inspection and action within a single reasoning step. For example, to 'find all search results and click the one with the title "Example.com"', the LLM receives the references and titles in a single call and can immediately issue the click command. This avoids the extra `extract` call that Design 1 might need. However, this comes at the cost of a significantly larger payload (token cost) and is inefficient if the inline data is not needed.
*   **Round-trips:** Minimal, especially for inspect-then-act scenarios.

**Design 3: Integrated structured-extraction tools**
*   **Workflow:** 1. `safari_extract_tables` -> `[{row1_col1, row1_col2}, ...]`. 
*   **Analysis:** For pure information extraction tasks (e.g., 'extract the entire product table'), this design is the most efficient, requiring only a single round-trip to get the final, structured JSON. Its weakness is in mixed workflows; if the agent needs to act on an element within the extracted data (e.g., 'click the delete button on the third row'), it cannot do so unless the tool is a hybrid that also returns element references.
*   **Round-trips:** Minimal for pure extraction tasks.

**Conclusion:**
*   For **pure extraction** (scenarios b, d): **Design 3** is superior.
*   For **mixed inspection and action** (scenarios a, c): **Design 2** minimizes round-trips, provided the required information for the decision is simple text or attributes.
*   For **complex chained operations** or when payload size is a concern: **Design 1** offers a more balanced and predictable model.

# Comparative Composition Analysis

The three API designs vary significantly in how well their outputs compose with chained operations, which is critical for multi-step agentic tasks.

**Design 1: `safari_query_all` returning element references**
*   **Composability:** **High**. This design excels at composition. The output is a simple array of opaque references (`[e1, e2, e3]`). This clean, predictable structure is ideal for an LLM to work with. The agent can iterate through the list, passing individual references to any action tool (`click`, `screenshot`, `extract`), or pass the entire list to a bulk action tool (`click_many`, `extract_many`). The references act as stable handles, creating a robust foundation for chaining low-level DOM operations. This aligns with patterns seen in academic DSLs like Spider.

**Design 2: `--all` flag returning refs + text + attributes inline**
*   **Composability:** **Medium**. This design is less composable than Design 1. The output is an array of complex objects (`[{ref, text, attributes}, ...]`). While this allows the LLM to filter or select based on the inline data, it requires the LLM to perform parsing to extract the `ref` before passing it to a subsequent action tool. This adds a layer of reasoning complexity and makes the tool-chaining less direct. The primary benefit is for immediate filtering, but it's less elegant for pure action chaining.

**Design 3: Integrated structured-extraction tools**
*   **Composability:** **Low to Medium**. This design has the most limited composability for general-purpose tasks. The output is high-level structured data (e.g., a JSON object representing a table). This is excellent if the goal is to export data, but it's often a terminal step. If the agent needs to perform a subsequent DOM action (e.g., click a button within a table row), it cannot do so unless the structured output is explicitly designed to include element references for each component. Without this hybrid approach, the agent would have to start a new query from scratch, breaking the operational chain.

**Conclusion:**
Design 1 offers the most powerful and flexible composition for building complex, multi-step agentic workflows. Its 'query-then-act' model using stable references is the most robust pattern for chaining arbitrary operations. A hybrid approach, where specialized tools like Design 3 also return references alongside their structured data, can provide the best of both worlds for specific, common tasks.

# Proposed Input Output Schemas

## Item Schema Description

A proposed unified schema for a single extracted web element is designed to be comprehensive, providing the LLM agent with all necessary information for reasoning and subsequent actions. Each item object would contain the following fields:

*   `id`: An opaque, unique identifier for the element, stable within a session, used for bulk actions.
*   `ref`: An optional opaque reference string for more complex state management.
*   `index`: The zero-based order of the element in the initial query result set, useful for re-resolution.
*   `text`: The `innerText` of the element, providing its human-readable content.
*   `attributes`: An object containing key-value pairs of important attributes, such as `href`, `src`, `alt`, and `role`.
*   `boundingBox`: An object with `x`, `y`, `width`, and `height` properties, defining the element's position and size on the page.
*   `html`: The `outerHTML` of the element, for cases where the agent needs to inspect the raw markup.
*   `visibility`: A state indicating if the element is `visible`, `hidden`, or `detached` from the DOM.
*   `state`: An object with boolean flags for interaction states like `enabled`, `checked`, or `selected`.

## Metadata Schema Description

To provide essential context for every multi-element extraction response, a metadata object should be included alongside the array of items. This object helps with debugging, pagination, and maintaining state. The proposed schema for the metadata object includes:

*   `selector`: The CSS, XPath, or Playwright selector that was used to perform the query, allowing for re-execution.
*   `count`: The total number of elements that matched the selector.
*   `timestamp`: An ISO 8601 timestamp indicating when the request was processed.
*   `pagination`: An object containing pagination details, such as an opaque `cursor` for fetching the next page of results and the `pageSize` used.
*   `version`: An API version identifier to help manage backward compatibility and schema changes.

## Example Input Payload

{
  "css_selector": "div.product-card a.title",
  "attributes": ["href", "innerText"],
  "limit": 20
}

## Example Output Payload

{
  "items": [
    {
      "id": "elem-123",
      "ref": "opaque-ref-string-123",
      "index": 0,
      "text": "Product A",
      "attributes": {
        "href": "/product/a",
        "role": "link"
      },
      "boundingBox": {
        "x": 100,
        "y": 250,
        "width": 200,
        "height": 30
      },
      "html": "<a class=\"title\" href=\"/product/a\">Product A</a>",
      "visibility": "visible",
      "state": {
        "enabled": true,
        "checked": false,
        "selected": false
      }
    },
    {
      "id": "elem-456",
      "ref": "opaque-ref-string-456",
      "index": 1,
      "text": "Product B",
      "attributes": {
        "href": "/product/b",
        "role": "link"
      },
      "boundingBox": {
        "x": 310,
        "y": 250,
        "width": 200,
        "height": 30
      },
      "html": "<a class=\"title\" href=\"/product/b\">Product B</a>",
      "visibility": "visible",
      "state": {
        "enabled": true,
        "checked": false,
        "selected": false
      }
    }
  ],
  "meta": {
    "selector": "div.product-card a.title",
    "count": 2,
    "timestamp": "2026-05-04T12:00:00Z",
    "pagination": {
      "cursor": null,
      "pageSize": 20
    },
    "version": "1.0"
  }
}


# Proposed Bulk Action Endpoints

## Endpoint Name

click_many

## Description

Performs a click action on multiple elements simultaneously or in a batch. This is useful for workflows that require interacting with several elements at once, such as selecting multiple checkboxes, adding multiple items to a cart, or dismissing multiple notifications.

## Http Method And Path

POST /click_many

## Request Schema Description

The request body is a JSON object that contains an array of element identifiers and an optional configuration object. The primary field is `ids`, which is an array of the opaque `id` strings obtained from a previous multi-element extraction query. An optional `options` object can be included to specify click parameters, such as the mouse `button` (e.g., 'left', 'right') or an array of keyboard `modifiers` to hold during the click (e.g., 'Shift', 'Control'). An example payload would be: `{"ids": ["id1", "id2"], "options": {"button": "left"}}`.

## Response Schema Description

The response should clearly indicate the success or failure of the action for each element. In the case of complete success, it might return a simple success message with a `200 OK` status. For partial failures, where some clicks succeed and others fail (e.g., due to a stale element), the endpoint should return a `PARTIAL_SUCCESS` status. The response body would include a `failedIds` array, where each object contains the `id` of the failed element and a corresponding error message or code. This allows the agent to reason about the partial failure and attempt recovery actions. The response should also include the standard metadata object.


# Element Reference Lifecycle Strategy

## Time To Live Ttl

Each generated element identifier (`id`) is proposed to be valid for a configurable Time-To-Live (TTL), with a suggested default of 5 minutes. This approach helps manage server-side state and ensures that references do not persist indefinitely, which could lead to memory leaks or interactions with stale, detached DOM elements.

## Session Management

It is proposed that API calls must include a short-lived session token. This token serves to tie bulk requests to the original navigation context, ensuring that actions are performed on the correct page state and preventing context-related errors that can occur in multi-step agentic workflows.

## Re Resolution Mechanism

A fallback strategy is proposed for handling stale or missing element references. If an `id` is not found (e.g., due to TTL expiration or a DOM update), the server will attempt to re-locate the element by using the original selector and the element's stored index from the initial query. If the element has been moved or detached, a 'NOT_FOUND' error is returned.

## Versioning Approach

To ensure backward compatibility and manage schema evolution, a versioning strategy is recommended. This includes using semantic versioning indicated in a `version` field within the API's meta object. This allows clients to negotiate schema changes without breaking existing integrations. New fields are to be additive so older clients can ignore them, and deprecation notices can be communicated via a `deprecation` object in the response.


# Common Edge Cases And Mitigations

## Edge Case

Lazy-loading & Infinite Scroll

## Description

This challenge occurs on modern web pages where content is loaded dynamically as the user scrolls down the page. For an automation agent, this is problematic because a simple query for all elements will only capture the initially visible items. The full set of content is not present in the DOM at once, leading to incomplete data extraction if not handled properly. The agent may incorrectly assume it has retrieved all items when many more are available after scrolling.

## Mitigation Strategy

The recommended mitigation is to implement a controlled scrolling loop. The agent must programmatically scroll the page, trigger the content fetch (e.g., by scrolling to the bottom), and then wait for the network to become idle or for a specified new item count to appear. This process is repeated until no new items are loaded or a predefined limit (e.g., number of scrolls, total items) is reached to guard against endless loading scenarios. This requires a combination of scroll actions, explicit waits, and termination criteria.


# Empirical Evaluation Plan

## Key Performance Indicators

The primary metrics to be measured include: the number of LLM-tool round-trips per task; end-to-end wall-clock latency; token usage and associated API costs; precision, recall, and F1-score for item capture against a ground truth; and the success rate of downstream tasks that consume the extracted data. Robustness metrics like retries and timeouts will also be tracked.

## Testbed And Datasets

The evaluation will use a combination of real and synthetic web pages. Real pages will be curated from diverse sites for each scenario (SERPs, tables, patterned links, feeds). Synthetic pages will be deterministic HTML fixtures with controlled noise (e.g., injected ads, missing attributes, shadow DOM) to test robustness against specific challenges. A split of train, dev, and hidden test sets will be used.

## Experimental Protocol

The evaluation will be conducted with fixed parameters to ensure comparability. This includes using fixed system and task prompts, a fixed temperature setting (e.g., 0.0 for deterministic runs), a defined retry policy (e.g., up to 2 retries), and specific timeouts for actions and LLM responses. Pagination strategies will be explicitly defined and tested, with limits to bound costs.

## Ablation Studies

Several ablation studies are planned to isolate the impact of specific design choices. These include comparing designs with and without element references, with and without inline attributes, using batch versus single actions, and different pagination methods (cursor-based vs. click-based). Studies will also test the effect of reference lifetimes and varying LLM temperatures.

## Decision Thresholds

Quantitative success criteria will be established to decide on adopting a design. For example, a minimum of 0.90 for both precision and recall might be required for high-integrity tasks. Other thresholds include a median end-to-end latency target (e.g., < 5 seconds for interactive use), a maximum cost per item (e.g., < $0.01), and reliability targets such as a crash rate below 1%.

