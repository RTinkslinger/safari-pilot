# Executive Summary

As of mid-2026, Playwright's `selectors.register()` API remains a stable and supported feature, not deprecated, and serves as the standard method for installing custom selector engines. These engines are justified in real-world scenarios that require complex, reusable logic not easily handled by built-in locators, such as framework-specific component targeting (React, Vue), domain-specific element selection (SVG diagrams, canvas shapes), and business-logic-driven queries (e.g., 'visible row with status=approved'). Agentic browser tools generally do not implement their own custom selector engines, instead favoring high-level locators or ad-hoc JavaScript. However, they could significantly benefit from a server-side 'selectorPack' registry, a pattern that allows an agent to register and reference named selectors without writing JavaScript. This approach is complementary to, not redundant with, built-in locators. The final recommendation for Safari Pilot is to ship an optional, feature-flagged API for `selectorPack` registration. This should be treated as an ergonomic feature for advanced users and agentic tools, rather than a core requirement, with default tooling continuing to prioritize built-in locators and on-demand JavaScript execution.

# Playwright Api Status

## Stability Summary

As of mid-2026, Playwright's `selectors.register()` API remains stable, fully supported, and is not deprecated. It continues to be the official method for installing custom selector engines. Its role has been further solidified following the removal of some built-in framework-specific engines, positioning it as the primary mechanism for users to implement reusable, complex, or domain-specific element-finding logic that goes beyond Playwright's standard locators.

## Notable Changes

A significant change occurred in late 2025, as noted in the Playwright-Python release notes from December 8, 2025. The built-in framework-specific selectors, such as `_react` and `_vue`, were removed. This change encourages users to either rely on standard locators (like roles and test IDs) or to implement their own framework-specific logic using the `selectors.register()` API, rather than depending on built-in, framework-tied engines.

## Version Timeline Highlights

A timeline of notable events between 2024 and 2026 includes:
- **March 2024**: Active community discussion around expanding the selector API's capabilities, exemplified by the opening of GitHub issue #29969 requesting image-based selectors.
- **2024–2025**: Continued adoption is confirmed as various ecosystem projects, such as jest-playwright and Quarkus-Playwright, publish examples and documentation for using custom selector engines.
- **December 2025**: Playwright-Python releases officially remove the built-in `_react` and `_vue` selectors, reinforcing the move towards user-defined engines for framework-specific logic.
- **April 2026**: Playwright releases up to this point continue to ship with the `selectors.register()` API, with no signs of deprecation or removal in official changelogs or maintainer guidance, signaling a stable roadmap.


# Final Recommendation For Safari Pilot

## Recommendation

Ship an optional, on-demand custom-selector-engine API for Safari Pilot, structured around a 'selectorPack' registration and usage model.

## Rationale

This API should be treated as an ergonomic feature for advanced users and agentic tools that need to encapsulate complex, reusable, or domain-specific selector logic. It is not a replacement for Playwright's robust built-in locators (role, text, testId) but a powerful complement for scenarios where they are insufficient. This approach provides a standardized way to manage complex selectors, improving maintainability and readability without adding overhead for simpler use cases.

## Implementation Priority

The feature should be considered non-critical for the initial launch. It should be implemented as optional, disabled by default, and activated via a feature flag (e.g., `safariPilot.selectorPack.enabled=false`). This allows for a controlled rollout to gather feedback from advanced users without impacting the core user experience.


# Api Registration Lifecycle And Scope

## Registration Timing Constraint

A critical constraint of the API is that custom selector engines must be registered *before* any page or browser context is created. If `selectors.register()` is called after a page has already been instantiated, the custom selector will not be available for use on that page. This necessitates registering engines at the very beginning of a process's lifecycle, such as during application startup or in a global setup file.

## Registration Scope

The registration of a custom selector engine is global and scoped to the Playwright process or runtime. It is not tied to a specific browser instance (e.g., Chromium, Firefox, WebKit) or an individual browser context. Once an engine is registered within a process, it becomes available to all browser contexts and pages created by that process, regardless of the browser type.

## Implications For Mcp

In a Multi-Client Playwright (MCP) or any distributed architecture with multiple worker processes, the process-level scope has a significant implication: each worker process must perform the registration independently. To ensure consistency, a shared start-up routine or a centralized initialization module must be executed by each worker. This guarantees that the custom selector registry is synchronized and available across all isolated processes in the server environment.


# Justifiable Use Cases For Custom Engines

## Use Case Category

Framework-Specific

## Scenario Description

In a large React application, components are rendered with runtime-generated `data-test-id` values that are unpredictable across builds, which makes static testId locators flaky and difficult to maintain.

## Custom Engine Benefit

A custom engine can resolve a component by its display name and prop filters, eliminating the need to maintain changing data attributes. This improves test readability and significantly reduces flakiness caused by dynamic attributes or DOM re-ordering.

## Example Selector

react=Button[name="Submit"]

## Use Case Category

Framework-Specific

## Scenario Description

Vue.js components utilize `<slot>` placeholders to render content from parent components. The resulting DOM structure varies based on the slot's content, which frequently breaks brittle CSS or XPath selectors.

## Custom Engine Benefit

A custom `vueSlot` selector can traverse the virtual component tree to locate elements by their slot name and component type, making tests resilient to changes in slot content and avoiding fragile DOM path dependencies.

## Example Selector

vueSlot=MyComponent/header

## Use Case Category

Framework-Specific

## Scenario Description

Virtualized or infinite-scroll lists, common in frameworks like React-Window or Angular CDK, only maintain a small subset of list items in the DOM at any given time. Standard locators fail to find items that are currently off-screen and not rendered.

## Custom Engine Benefit

A custom `virtualItem` selector encapsulates the logic to automatically scroll the container until the desired item is rendered into the DOM, guaranteeing deterministic selection without embedding complex scrolling logic in every test.

## Example Selector

virtualItem=user-list/JohnDoe

## Use Case Category

Domain-Specific

## Scenario Description

An interactive SVG diagram, such as a chemical structure or a network map, labels nodes with `<text>` elements grouped under `<g>` containers. Standard CSS selectors cannot easily express a query like "find the node whose label is 'H₂O'".

## Custom Engine Benefit

A custom `svgLabel` selector provides a clear, domain-specific method for targeting diagram elements by their semantic content. This improves ergonomics and eliminates the need for verbose and complex XPath expressions.

## Example Selector

svgLabel=H₂O

## Use Case Category

Domain-Specific

## Scenario Description

UI elements are drawn on a `<canvas>` element using libraries like Fabric.js or Konva. These elements are not part of the DOM, forcing tests to rely on inline JavaScript to calculate hit regions based on coordinates.

## Custom Engine Benefit

A custom `canvasShape` selector centralizes the hit-testing logic. It can call a predefined helper function within the page to map a semantic name to canvas coordinates, abstracting this complexity and making tests cleaner and easier to maintain.

## Example Selector

canvasShape=SubmitButton

## Use Case Category

Business-Logic

## Scenario Description

A data grid displays rows where the business state (e.g., 'pending', 'approved') is encoded in CSS classes or data attributes. Tests need to select rows based on this business state rather than their visual presentation or DOM structure.

## Custom Engine Benefit

A custom `gridRow` selector aligns test selectors with domain terminology. This reduces cognitive load for developers and makes tests more deterministic and resilient to UI styling changes that do not affect the underlying business state.

## Example Selector

gridRow[status='approved']


# Targeting Strategies Comparison

## Strategy Name

Custom Selector Engines

## Ergonomics Evaluation

Offers good developer experience after an initial setup cost. It allows teams to create expressive, domain-specific syntax (e.g., `react=Button/Submit`) that is easier to read and reuse than long CSS/XPath chains or inline JavaScript. This simplifies tasks for both human authors and LLM agents by surfacing domain semantics as first-class selectors.

## Robustness And Maintainability

Increases maintainability by centralizing complex location logic into a single, reusable engine. This means updates to the application's component structure only require a single code change in the engine, rather than in every test. However, it introduces a new maintenance burden for the engine itself. Robustness is high if the engine is well-implemented and relies on stable attributes, as it can abstract away flaky DOM structures (e.g., from virtualization or frameworks), reducing intermittent test failures.

## Portability Evaluation

Portability is limited compared to built-in locators. The strategy is portable across different browsers supported by Playwright, but requires the custom engine's code to be bundled and registered in any environment or runner where it's used. This can lead to a degree of lock-in with Playwright or tools that support an equivalent extension mechanism, as the selectors are not natively understood by other automation frameworks.

## Security Evaluation

Introduces security considerations, especially in multi-tenant or agentic systems. If untrusted agents can dynamically register engines, it creates a vector for arbitrary JavaScript execution in the page context, potentially leading to data exfiltration or other attacks. This risk necessitates robust access control, code vetting, sandboxing, and namespacing for any registration APIs.

## Performance Evaluation

Performance is dependent on the engine's implementation. Well-written query functions that execute as in-page JavaScript are generally fast. While there is a small initial registration overhead, engines can be optimized with internal caching to mitigate the cost of repeated, complex DOM traversals, potentially outperforming multiple ad-hoc JavaScript injections.


# Agentic Tool Dom Targeting Strategies

## Primary Strategy

Most agentic browser tools, as of mid-2026, employ a hybrid approach for DOM targeting. They primarily rely on high-level, built-in locators that focus on semantics, such as role, text, label, ARIA attributes, and test IDs. This is complemented by the injection of ad-hoc, one-off JavaScript snippets for more dynamic or complex queries that cannot be expressed with standard locators. Some tools, like Vercel's agent-browser, explicitly emphasize deterministic Playwright selectors like CSS and XPath to ensure reliable steps. The general trend is to use LLM-driven heuristics to decide which strategy to apply for a given task, favoring semantic locators for their robustness and falling back to generated JavaScript for ambiguity or one-off tasks.

## Custom Engine Adoption

The adoption of Playwright's custom selector engines by agentic tools is minimal and they are generally treated as a feature aimed at human authors creating reusable test suites. There is limited public evidence that prominent agentic tools like browser-use, AgentQ, or Multi-On ship and register their own selector engines at runtime. While some architectures, like the MCP-compatible Vercel agent-browser, make it technically possible to register custom engines, it is not a primary or explicitly documented feature. The consensus is that these tools prioritize cross-tool portability and avoid the complexity and potential lock-in associated with Playwright-specific features.

## Rationale

The preference for high-level locators and ad-hoc JavaScript over custom selector engines is driven by several factors. Portability is a key concern; built-in locators and standard JavaScript are compatible across different browser automation backends (Playwright, CDP, etc.), avoiding vendor lock-in. This strategy also enhances determinism and developer experience, as semantic locators are more stable and readable. Security is another major driver; while injected JavaScript carries risks, it is often preferred over a system that allows untrusted agents to register persistent, potentially malicious custom engines. The overall goal is to use stable, cross-compatible, and secure methods for DOM interaction, treating custom engines as an optional ergonomic feature for advanced, human-authored scenarios rather than a core component of agentic tooling.


# Mcp Server Patterns For Llm Agents

## Primary Pattern Description

The primary architectural pattern for an MCP server to expose custom selector engines to an LLM agent involves abstracting away the JavaScript. The server provides a dedicated API endpoint, such as `POST /selectorPack/register`, which allows an agent to register a named collection of selector engines (a 'selectorPack') by providing a name and the corresponding JavaScript bodies. Once registered, the agent can reference these custom selectors by name in subsequent locator calls (e.g., `page.locator("myPack=button[data-id='submit']")`). This pattern avoids forcing the LLM to generate or handle JavaScript directly, instead allowing it to operate with higher-level, named abstractions, which is both safer and more ergonomic.

## Registration Models

Several registration models can be implemented depending on the desired scope and isolation. A 'one-time per-process' model involves the server controller registering a common set of engines at startup, making them available to all subsequent sessions. A 'per-context' or 'per-client' model creates a fresh Playwright browser context for a new agent and registers engines specific to that agent before any pages are created. Finally, 'per-tab isolation' can be achieved by using the `{contentScript: true}` option during registration, which ensures each engine runs in an isolated script sandbox within its frame, preventing interference between engines from different agents or tabs.

## Lifecycle Handling

To manage Playwright's strict constraint that selectors must be registered before a page is created, several server-side strategies can be employed. The server can queue incoming registration requests and process them in order before any page creation occurs. For scenarios where an agent needs to add an engine after a page already exists, the server can perform 'rehydration' by restarting the browser context, which is a lightweight operation that allows for the re-application of all necessary registrations. For long-running agent sessions, periodic context restarts can also be used to ensure that newly added selector packs are applied safely and consistently.


# Selector Pack Concept And Implementation

## Concept Description

A 'selectorPack' is a named, reusable, and versioned collection of custom selector engines. It serves as a module or bundle that groups related custom selectors, often for a specific domain (e.g., a business-logic pack) or framework (e.g., a React component pack). In an MCP server architecture, this concept allows an agent to register a whole suite of powerful, domain-specific selectors in a single operation and then reference them by name. This centralizes complex selector logic, improves reusability across different agents and tasks, and abstracts the underlying JavaScript implementation away from the LLM agent.

## Api Contract Example

The API contract for registering a selector pack typically involves a server-side tool or endpoint that an agent can call. An example from the research is a tool call like `safari_register_selector(name, jsBody)`. A more detailed example is a RESTful endpoint `POST /selectorPack/register` that accepts a JSON payload. This payload would contain the pack's name and an array of engine objects, each with its own name and JavaScript body. For instance: `{ "packName": "myPack", "engines": [{"name": "myEngine", "script": "...JS code..."}] }`. The Safari Pilot recommendation proposes a more advanced API surface like `registerSelectorPack(name: string, pack: SelectorPack | URL | SerializedPack, options?: {scope: 'global'|'session'})`.

## Usage Example

Once a selector pack is registered with the server, the agent can use the custom selectors within it by referencing the pack and engine name in its subsequent tool calls. The syntax typically involves a prefix indicating the custom engine. For example, if a pack named 'myPack' with an engine 'myEngine' was registered, an agent could use it in a locator call like `await page.locator("myPack=button[data-id='submit']")`. Another example provided is `click selectorPack:mySelector>mySelectorArgs`. This allows the agent to leverage complex, pre-defined logic without needing to understand or generate the underlying JavaScript for each action.


# Analysis Of Redundancy With Built In Locators

## Conclusion

The proposed 'selectorPack' concept, which facilitates the use of custom selector engines, is not redundant with Playwright's high-level built-in locators (role, text, label, testId).

## Justification

It is a complementary feature designed for a different set of problems. Built-in locators are ideal for targeting elements based on common, semantic web attributes and are the best practice for the majority of cases. Custom selector engines and the 'selectorPack' pattern address the need for encapsulating complex, reusable, and domain-specific logic that is either impossible or unwieldy to express with standard locators. They allow teams to create a domain-specific language for their application (e.g., `gridRow[status=approved]`), abstracting away complex DOM traversal or business rules, thereby improving test maintainability and readability for advanced use cases.


# Mcp Security And Multi Tenancy Considerations

## Sandboxing Measures

To mitigate the risks of executing arbitrary JavaScript from selector engines, a robust sandboxing model is essential. The primary measure is to mandate the use of Playwright's `{contentScript: true}` option during registration. This forces the engine's script to run in an isolated content script sandbox within the page's frame. This sandbox is isolated from the page's global objects, has no access to privileged Node.js APIs, and can be further restricted from accessing network or cookies. This prevents a malicious or poorly written engine from tampering with the page, interfering with other engines, or exfiltrating sensitive data.

## Access Control

In a multi-tenant environment, strong access control is critical. This includes namespacing, capability scoping, and authentication. Each agent or tenant should be assigned a unique namespace identifier, which the server automatically prefixes to their registered engine names (e.g., `tenantA_myEngine`). This prevents name collisions and unauthorized use of other tenants' selectors. Capability scoping, defined in a server-side policy, dictates which agents are allowed to register new selector packs. Registration attempts should require authentication, and the server should reject any attempt to register or use an engine outside of the agent's permitted scope. Auditing logs and source signature verification for selector packs can add another layer of security.

## Code Validation

Before a custom selector engine is registered and executed, its code should be validated. The server can perform static analysis on the submitted JavaScript to scan for and prohibit the use of dangerous APIs like `eval` or `new Function`. A stricter approach, proposed for Safari Pilot, is a `strictIsolation` mode that requires the engine to be provided as a serialized Abstract Syntax Tree (AST) or WebAssembly (WASM) module, completely preventing dynamic code evaluation. This ensures that the engine's logic is analyzable and free from certain classes of vulnerabilities.

## Csp Policy

To further harden the execution environment, the MCP server should inject a strict Content Security Policy (CSP) for each page it manages. A policy such as `script-src 'self'` can be used to prevent a registered selector engine from loading and executing external scripts from arbitrary domains. This measure effectively blocks a potential attack vector where a compromised engine attempts to fetch and run a malicious payload from an external server.


# Proposed Api Design For Safari Pilot

## Api Functions

The proposed API surface includes functions for managing the lifecycle of selector packs: `registerSelectorPack(name, pack, options)` to add a new pack, `listSelectorPacks()` to enumerate registered packs, `useSelectorPack(name)` to bind a pack to the current context, and `unregisterSelectorPack(name)` to remove one. An additional `registerInlineSelector(name, factory, options)` could be provided for more ephemeral, single-selector registrations.

## Error Handling

The API should enforce robust error handling. Registration should be idempotent; attempting to register an existing pack should return a specific conflict error (e.g., HTTP 409). Submitting a malformed pack should result in a validation error (e.g., HTTP 400) with detailed feedback. When a custom selector is used but not found, the system should fall back through a defined hierarchy and emit a clear warning, unless a strict mode is enabled.

## Lifecycle Management

The API must respect Playwright's registration lifecycle. It should handle the 'prePage' constraint by throwing a specific lifecycle error if a pack designated with `{prePage: true}` is loaded after a page has already been created. The API should also manage scope, with the default being session-scoped registration, and provide an explicit option for global registration, ensuring isolation between different agent sessions.


# Safari Pilot Implementation Details

## Rollout Strategy

The feature should be rolled out cautiously. It will be controlled by a feature flag, such as `safariPilot.selectorPack.enabled`, which will be set to `false` by default. This allows the team to enable the feature for specific advanced users or internal testing, gather feedback, and ensure stability before considering a wider release.

## Fallback Hierarchy

A clearly defined fallback hierarchy is crucial for robust behavior. When a selector is used, the system should attempt to resolve it in the following order: 1. Playwright's built-in locators (e.g., `role=`, `text=`, `css=`). 2. Registered `selectorPack` engines by name. 3. Other semantic locators (e.g., ARIA, accessible name). 4. Safe, sandboxed inline JavaScript selectors with limited capabilities. 5. Full inline JavaScript, which must be explicitly enabled and requires special permissions.

## Success Metrics

The success of the feature will be evaluated against several key metrics: 1. **Adoption Rate**: Targeting adoption by at least 5% of advanced deployments within the first three months. 2. **Security Incidents**: A goal of zero critical security incidents related to the feature within the first six months. 3. **Performance Overhead**: Ensuring the median selector resolution latency increase is less than 30%. 4. **Query Distribution**: Monitoring the percentage of queries resolved by built-ins versus custom packs to understand usage patterns.

## Deprecation Strategy

If the feature fails to meet success metrics (e.g., low adoption, security concerns), a clear deprecation path will be followed. The feature will first be marked as 'experimental'. If issues persist, it will be officially deprecated, with a 12-month migration window provided to all users. During this period, tooling and documentation will be supplied to help users convert their selector packs into alternative solutions, such as safe inline JavaScript or standard built-in locators.


# Community Adoption And Usage Trends

## Adoption Level

The adoption of custom selector engines within the Playwright community is best described as niche but growing. While standard locators like `getByTestId` and `getByRole` remain the most widely used and recommended strategies for their simplicity and stability, custom engines are gaining traction among teams working on applications with complex, non-standard, or framework-heavy user interfaces.

## Typical Usage Patterns

Common usage patterns for custom selector engines include:
- **Framework Adapters**: Creating engines that understand the component hierarchy of frameworks like React, Vue, or Svelte. This allows for more robust selectors based on component names and props (e.g., `react=Button[name="Submit"]`) that are resilient to DOM structure changes.
- **Domain-Specific Selectors**: Building selectors for specialized applications, such as targeting nodes in SVG-based diagrams (`svgLabel=H₂O`), interactive shapes on a `<canvas>` element, or elements within scientific visualization tools (e.g., chemistry diagrams).
- **Business-Logic Packs**: Encapsulating complex business rules into a reusable selector. For example, a selector like `gridRow[status="approved"]` can abstract away the underlying DOM query for finding a row in a data grid that represents an approved item, making tests more readable and aligned with domain terminology.
- **Complex UI Abstractions**: Handling modern UI patterns like virtualized or infinite-scroll lists, where a custom engine can manage the scrolling logic required to bring an element into view before selecting it.

## Trend Signals

Indicators of growing usage trends between 2024 and 2026 include:
- **Increased GitHub Activity**: A noticeable rise in GitHub issues related to `selectors.register()`, particularly reports of duplicate registration errors, suggests that more projects are implementing and managing multiple custom engines.
- **Cross-Tool Integration Discussions**: Community forums, such as for the Artillery load-testing tool, show growing interest in sharing and reusing Playwright selector packs across different automation and testing tools.
- **Code Search Trends**: An increase in the number of public repositories on GitHub containing the phrase `selectors.register()` from 2024 to 2026 indicates broader adoption.


# Common Pitfalls And Maintenance Overhead

## Pitfall Examples

Common pitfalls encountered by users when implementing custom selector engines include:
- **Duplicate Registration Errors**: Because registration is global to the process, attempting to register an engine with the same name more than once (e.g., in multiple test files) will throw an error. This is a frequent issue in projects without a centralized registration strategy.
- **Incorrect Registration Timing**: A classic mistake is calling `selectors.register()` after a browser context or page has already been created. This results in the selector not being available for that page, leading to test failures that can be difficult to debug.
- **Inconsistency in Distributed Systems**: In a multi-worker or MCP environment, if one worker process fails to register an engine that others have, it can lead to non-deterministic test failures where a selector works in some runs but not others.

## Maintenance Overhead

The primary maintenance overhead comes from the need to keep the custom selector's logic synchronized with the application's evolving UI. When developers refactor components, change data attributes, or alter the DOM structure, the custom engine's query logic may break. This requires the team to maintain and update this centralized piece of code, introducing a form of technical debt and a dependency that must be managed throughout the application's lifecycle.

## Mitigation Strategies

To address these pitfalls, the community has adopted several effective strategies:
- **Centralized Registration**: The most common solution is to handle all registrations in a single, shared location that runs once per process. This is typically done in a global setup file (like `playwright.config.js` or a dedicated setup script specified in the test runner's configuration).
- **Strict Startup Sequence**: Enforcing a strict initialization order where selector registration is guaranteed to complete before any browser interactions begin.
- **Global Setup Hooks**: Utilizing test runner hooks (e.g., `globalSetup` in Playwright Test) to register engines once for the entire test suite, ensuring consistency and avoiding duplication.

