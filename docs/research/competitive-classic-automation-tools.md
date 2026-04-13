# Competitive Analysis: Safari Pilot vs. Classic Automation Tools

**Date:** 2026-04-13
**Scope:** Exhaustive feature-by-feature comparison of Safari Pilot against Playwright, Puppeteer, Selenium, and Cypress. Directly informs roadmap prioritization and benchmark design.

---

## 1. Executive Summary

Safari Pilot ships 74 MCP tools across 14 modules, backed by a three-tier engine model (AppleScript/Daemon/Extension) and a nine-layer security pipeline. It is the only automation framework purpose-built for Safari on macOS, and the only one designed from the ground up as an AI-agent tool provider via MCP.

Against the field, Safari Pilot already matches or exceeds competitors in several areas: accessibility snapshots with persistent element refs, Playwright-compatible auto-wait, locator targeting (role/text/label/testId/placeholder), structured data extraction, WebSocket monitoring, and agent-safety features (IDPI scanning, tab ownership, domain policies). Its security posture has no equivalent in any competitor.

The critical gaps cluster around four themes: (1) visual capture beyond screenshots (PDF generation, video recording, visual comparison), (2) test infrastructure (no built-in runner, parallel execution, codegen, or trace viewer), (3) advanced emulation completeness (device presets, color scheme), and (4) file transfer (download handling, file upload). These gaps are well-understood and most appear on the existing roadmap.

---

## 2. Competitor Profiles

### Playwright (Microsoft)

The primary competitor. 78K+ GitHub stars, 33M+ weekly npm downloads, 91% developer satisfaction (State of JS 2025). Supports Chromium, Firefox, and WebKit via a single API. Multi-language (JS/TS, Python, Java, .NET). Ships an official MCP server (`@playwright/mcp`) with ~20 tools using accessibility snapshots and element refs -- architecturally similar to Safari Pilot's approach. Recently released `@playwright/cli` achieving 4x token reduction over MCP. Job postings grew 180% YoY in 2025.

### Puppeteer (Google)

Chrome/Chromium only. Direct CDP (Chrome DevTools Protocol) access provides the fastest Chrome-specific automation (15-20% faster than Playwright on Chromium). Reference implementation for CDP, gets new Chrome features first. Now supports WebDriver BiDi. Declining market share as Playwright absorbs its niche, but remains dominant for Chrome-specific performance work and scraping.

### Selenium WebDriver

The incumbent. Broadest language support (Java, Python, C#, JS, Ruby, Kotlin). W3C WebDriver standard. Selenium Grid enables massive parallel execution across browsers and OS versions. Selenium 4 added BiDi protocol support for real-time event-driven communication. Selenium Manager handles driver installation. Mature ecosystem with decades of community knowledge. Slower execution, more flaky tests, but unmatched breadth.

### Cypress

In-browser architecture -- runs in the same event loop as the application. Enables "time travel" debugging, automatic waiting, and direct DOM access. Component testing for React/Vue/Angular. Cypress Cloud provides orchestration, parallelization, and flaky test detection. Limited to Chromium-family and Firefox. JS/TS only. 6.5M weekly npm downloads, declining relative to Playwright. Cypress 15 (2025) added AI self-healing selectors.

---

## 3. Feature Comparison Matrix

Rating key:
- **SP** = Safari Pilot has it (shipped)
- **RD** = Roadmap or workaround exists
- **NO** = No path or structural limitation
- **ADV** = Safari Pilot has a structural advantage

### 3.1 Navigation & Page Management

| Feature | Playwright | Puppeteer | Selenium | Cypress | Safari Pilot | Rating |
|---------|-----------|-----------|----------|---------|-------------|--------|
| Navigate to URL | Yes | Yes | Yes | Yes | `safari_navigate` | SP |
| Back / Forward | Yes | Yes | Yes | Yes | `safari_navigate_back/forward` | SP |
| Reload (+ bypass cache) | Yes | Yes | Yes | Yes | `safari_reload` (bypassCache) | SP |
| Wait for load state | load/domcontentloaded/networkidle | load/domcontentloaded/networkidle | pageLoadStrategy | -- | waitUntil param (informational; `safari_wait_for` networkidle) | SP |
| New tab/page | Yes | Yes | Via JS | Via cy.visit | `safari_new_tab` | SP |
| Close tab | Yes | Yes | Via driver.close() | -- | `safari_close_tab` | SP |
| List open tabs | browser.contexts/pages | browser.pages() | getWindowHandles() | -- | `safari_list_tabs` | SP |
| Private/incognito context | browser.newContext() (isolated) | browser.createBrowserContext() | ChromeOptions | -- | `safari_new_tab` (privateWindow) | SP |
| Multiple browser contexts | Yes (isolated) | Yes | Limited | No | Single Safari instance, private windows | RD |
| Download handling | Built-in download API | Page.download | driver.get() + polling | cy.readFile | Not yet | RD |
| File upload | setInputFiles() | uploadFile() | sendKeys() | cy.selectFile | Not yet | RD |
| Popup/window management | page.waitForEvent('popup') | page.waitForTarget | switchTo().window() | -- | Via `safari_list_tabs` + navigate | SP |

### 3.2 Element Interaction

| Feature | Playwright | Puppeteer | Selenium | Cypress | Safari Pilot | Rating |
|---------|-----------|-----------|----------|---------|-------------|--------|
| Click | locator.click() | el.click() | el.click() | cy.click() | `safari_click` (ref/locator/selector + auto-wait) | SP |
| Double-click | locator.dblclick() | el.click({clickCount:2}) | Actions.doubleClick() | cy.dblclick() | `safari_double_click` | SP |
| Right-click | locator.click({button:'right'}) | el.click({button:'right'}) | Actions.contextClick() | cy.rightclick() | Not yet (click dispatches left only) | RD |
| Fill (clear + type) | locator.fill() | el.type() | el.sendKeys() | cy.clear().type() | `safari_fill` (clear + set value + input/change events) | SP |
| Type (keystroke) | locator.pressSequentially() | page.keyboard.type() | Actions.sendKeys() | cy.type() | `safari_type` (character-by-character) | SP |
| Clear | locator.clear() | el.evaluate() | el.clear() | cy.clear() | `safari_fill` with empty string | SP |
| Select option | locator.selectOption() | select.select() | Select class | cy.select() | `safari_select_option` (by value/label/index) | SP |
| Check/uncheck | locator.check()/uncheck() | el.click() | el.click() | cy.check()/uncheck() | `safari_check` (checked param) | SP |
| Hover | locator.hover() | el.hover() | Actions.moveToElement() | cy.trigger('mouseover') | `safari_hover` (mouseenter/mouseover dispatch) | SP |
| Drag and drop | locator.dragTo() | -- (manual) | Actions.dragAndDrop() | cy.drag() (plugin) | `safari_drag` (source → target) | SP |
| Focus / blur | locator.focus()/blur() | el.focus() | JS execution | cy.focus()/blur() | Via `safari_evaluate` | SP |
| Press key | locator.press() | page.keyboard.press() | Actions.keyDown/Up() | cy.type('{enter}') | `safari_press_key` (key + modifiers) | SP |
| Scroll | mouse.wheel() / locator.scrollIntoViewIfNeeded() | mouse.wheel() | Actions.scrollToElement() | cy.scrollTo() | `safari_scroll` (direction/amount/element) | SP |
| Touch gestures | touchscreen.tap() | touchscreen.tap() | W3C Touch Actions | -- | Not yet | NO |
| Dialog handling | page.on('dialog') | page.on('dialog') | Alert/Confirm handling | cy.on('window:alert') | `safari_handle_dialog` | SP |

### 3.3 Element Targeting / Locators

| Feature | Playwright | Puppeteer | Selenium | Cypress | Safari Pilot | Rating |
|---------|-----------|-----------|----------|---------|-------------|--------|
| CSS selector | Yes | Yes | Yes | Yes | All tools accept `selector` | SP |
| XPath | Yes | Yes | Yes | -- | Via `safari_evaluate` | RD |
| getByRole | Yes | -- | -- | -- | `role` + `name` params on all tools | SP |
| getByText | Yes | -- | -- | cy.contains() | `text` param on all tools | SP |
| getByLabel | Yes | -- | -- | -- | `label` param on all tools | SP |
| getByTestId | Yes | -- | -- | -- | `testId` param on all tools | SP |
| getByPlaceholder | Yes | -- | -- | -- | `placeholder` param on all tools | SP |
| Element refs (snapshot-based) | Yes (MCP: `ref` param) | -- | -- | -- | `ref` param (e.g. 'e5') from `safari_snapshot` | ADV |
| Chaining / filtering | locator.filter().nth().first() | -- | findElements() chains | cy.find().eq() | Single-match only (no chaining) | RD |
| Shadow DOM piercing | Built-in (open shadows) | `>>>` selector | Via JS | cy.shadow() | `safari_query_shadow` / `safari_click_shadow` | SP |
| iframe-aware locators | frameLocator() | frame.contentFrame() | switchTo().frame() | cy.iframe() (plugin) | `safari_list_frames` / `safari_eval_in_frame` | SP |
| Custom selector engines | selectors.register() | -- | -- | -- | Not yet (locator system is fixed) | NO |

### 3.4 Waiting & Auto-Wait

| Feature | Playwright | Puppeteer | Selenium | Cypress | Safari Pilot | Rating |
|---------|-----------|-----------|----------|---------|-------------|--------|
| Actionability checks (visible, enabled, stable, attached, receives-events) | Built-in on every action | Manual | Manual | Auto-retry | Built-in via `auto-wait.ts` (visible, stable, enabled, editable, receivesEvents) | ADV |
| Per-action check profiles | Yes (click needs stable+visible+enabled+receivesEvents) | -- | -- | -- | Yes (ACTION_CHECKS matrix matches Playwright's) | SP |
| Wait for selector | page.waitForSelector() | page.waitForSelector() | WebDriverWait | cy.get() (retry) | `safari_wait_for` condition:'selector' | SP |
| Wait for selector hidden | locator.waitFor({state:'hidden'}) | waitForSelector({hidden:true}) | ExpectedConditions.invisibilityOf | -- | `safari_wait_for` condition:'selectorHidden' | SP |
| Wait for text | expect(locator).toContainText() | -- (manual) | ExpectedConditions.textToBe | cy.contains() | `safari_wait_for` condition:'text' / 'textGone' | SP |
| Wait for URL | page.waitForURL() | page.waitForNavigation() | ExpectedConditions.urlContains | cy.url() | `safari_wait_for` condition:'urlMatch' | SP |
| Wait for network idle | page.waitForLoadState('networkidle') | page.waitForNetworkIdle() | -- | -- | `safari_wait_for` condition:'networkidle' | SP |
| Wait for custom function | page.waitForFunction() | page.waitForFunction() | -- | -- | `safari_wait_for` condition:'function' | SP |
| Configurable timeout | Per-action + global | Per-action | Implicit/explicit waits | Global + per-command | Per-tool `timeout` param + auto-wait timeout | SP |
| Force bypass (skip wait) | {force: true} | -- | -- | {force: true} | `force: true` param on interaction tools | SP |

### 3.5 Data Extraction

| Feature | Playwright | Puppeteer | Selenium | Cypress | Safari Pilot | Rating |
|---------|-----------|-----------|----------|---------|-------------|--------|
| Text content | locator.textContent() / innerText() | el.evaluate() | el.getText() | cy.invoke('text') | `safari_get_text` (ref/locator/selector) | SP |
| Inner/outer HTML | locator.innerHTML() / outerHTML() | el.evaluate() | el.getAttribute('innerHTML') | cy.invoke('html') | `safari_get_html` (inner/outer toggle) | SP |
| Attribute values | locator.getAttribute() | el.evaluate() | el.getAttribute() | cy.invoke('attr') | `safari_get_attribute` | SP |
| Accessibility snapshot | aria snapshot (YAML) | -- | -- | -- | `safari_snapshot` (YAML/JSON, with refs, scoped, depth control) | ADV |
| Table extraction | -- (manual) | -- | -- | -- | `safari_extract_tables` (headers + rows, structured JSON) | ADV |
| Link extraction | -- (manual) | -- | -- | -- | `safari_extract_links` (href, text, context, internal/external filter) | ADV |
| Image extraction | -- (manual) | -- | -- | -- | `safari_extract_images` | ADV |
| Metadata extraction | -- (manual) | -- | -- | -- | `safari_extract_metadata` | ADV |
| Schema-based scraping | -- | -- | -- | -- | `safari_smart_scrape` (JSON schema → structured data) | ADV |
| Arbitrary JS evaluation | page.evaluate() | page.evaluate() | executeScript() | cy.window().then() | `safari_evaluate` | SP |
| Console messages | page.on('console') | page.on('console') | Via DevTools | cy.on('window:console') | `safari_get_console_messages` (filter by level, buffered) | SP |
| Multiple element extraction | locator.all() / evaluateAll() | page.$$eval() | findElements() | cy.get().each() | Via `safari_evaluate` or structured extraction tools | SP |

### 3.6 Network

| Feature | Playwright | Puppeteer | Selenium | Cypress | Safari Pilot | Rating |
|---------|-----------|-----------|----------|---------|-------------|--------|
| List network requests | Via event listeners | Via CDP | BiDi network events | cy.intercept() log | `safari_list_network_requests` (Performance API + interceptor) | SP |
| Request detail (timing, size) | Via HAR | Via CDP | BiDi | -- | `safari_get_network_request` (DNS/connect/TTFB/download breakdown) | SP |
| Request interception / route | page.route() | page.setRequestInterception() | BiDi network.addIntercept | cy.intercept() | `safari_intercept_requests` (fetch/XHR monkey-patch) | SP |
| Mock responses | route.fulfill() | request.respond() | BiDi network.provideResponse | cy.intercept().reply() | `safari_mock_request` (per-URL pattern) | SP |
| Network throttle | -- (CDP emulateNetworkConditions) | page.emulateNetworkConditions() | -- | -- | `safari_network_throttle` (latency + bandwidth) | SP |
| Offline mode | context.setOffline() | page.setOffline() | -- | Cypress.automation('setOffline') | `safari_network_offline` | SP |
| HAR recording / replay | recordHar / routeFromHAR | Via CDP | -- | -- | Not yet | RD |
| WebSocket monitoring | Via event listeners | Via CDP | -- | -- | `safari_websocket_listen` + `safari_websocket_filter` | SP |
| Service worker interception | Chromium only (route SW requests) | Full CDP access | -- | -- | `safari_sw_list` / `safari_sw_unregister` | SP |

### 3.7 Authentication & State

| Feature | Playwright | Puppeteer | Selenium | Cypress | Safari Pilot | Rating |
|---------|-----------|-----------|----------|---------|-------------|--------|
| Get cookies | context.cookies() (all, incl. httpOnly) | page.cookies() (all) | manage().getCookies() | cy.getCookies() | `safari_get_cookies` (document.cookie only, no httpOnly) | SP |
| Set cookie | context.addCookies() (full control) | page.setCookie() | manage().addCookie() | cy.setCookie() | `safari_set_cookie` (full params, no httpOnly via JS) | SP |
| Delete cookie | context.clearCookies() | page.deleteCookie() | manage().deleteCookie() | cy.clearCookies() | `safari_delete_cookie` | SP |
| localStorage get/set | Via evaluate | Via evaluate | Via executeScript | cy.window().then() | `safari_local_storage_get/set` (dedicated tools) | ADV |
| sessionStorage get/set | Via evaluate | Via evaluate | Via executeScript | cy.window().then() | `safari_session_storage_get/set` (dedicated tools) | ADV |
| IndexedDB access | Via evaluate | Via evaluate | -- | -- | `safari_idb_list` / `safari_idb_get` (dedicated tools with key ranges) | ADV |
| Storage state export/import | storageState() (cookies + localStorage + httpOnly) | Manual | Manual | -- | `safari_storage_state_export/import` (cookies + localStorage + sessionStorage) | SP |
| HTTP auth handling | httpCredentials in context | page.authenticate() | -- | -- | Not yet | RD |
| Auth state persistence | storageState() to file | Manual | Manual | cy.session() | Via export/import (not file-based yet) | SP |

### 3.8 Visual & Media

| Feature | Playwright | Puppeteer | Selenium | Cypress | Safari Pilot | Rating |
|---------|-----------|-----------|----------|---------|-------------|--------|
| Screenshot (viewport) | page.screenshot() | page.screenshot() | getScreenshotAs() | cy.screenshot() | `safari_take_screenshot` (via screencapture) | SP |
| Screenshot (full page) | fullPage: true | fullPage: true | -- (viewport only) | -- | fullPage param (planned) | RD |
| Screenshot (element) | locator.screenshot() | el.screenshot() | el.getScreenshotAs() | cy.screenshot() | Not yet (whole window via screencapture) | RD |
| PDF generation | page.pdf() (Chromium only) | page.pdf() | -- | -- | Not yet | RD |
| Video recording | recordVideo in context | -- | -- | cy.screenshot on fail | Not yet | RD |
| Visual comparison | toHaveScreenshot() (pixel diff) | -- (third-party) | -- (third-party) | percy/applitools integration | Not yet | RD |
| Media control | Via evaluate | Via evaluate | Via executeScript | -- | `safari_media_control` (play/pause/seek/volume/mute/rate) | ADV |
| Screenshot redaction | -- | -- | -- | -- | Security layer blurs cross-origin iframes, redacts passwords | ADV |

### 3.9 Testing Infrastructure

| Feature | Playwright | Puppeteer | Selenium | Cypress | Safari Pilot | Rating |
|---------|-----------|-----------|----------|---------|-------------|--------|
| Built-in test runner | @playwright/test | -- | TestNG/JUnit/etc. | Cypress runner | -- (MCP server, not a test runner) | NO |
| Parallel execution | Built-in (workers) | -- | Selenium Grid | Cypress Cloud | -- (agent decides concurrency) | NO |
| Retry on failure | retries config | -- | TestNG retry | retries config | -- (agent-level retry) | NO |
| Test isolation | Browser contexts | Browser contexts | New session | Test isolation | Tab ownership + domain policy | SP |
| Fixtures and hooks | test.use(), beforeAll/afterAll | -- | @Before/@After | beforeEach/afterEach | -- (MCP lifecycle) | NO |
| Reporting (JUnit/HTML/JSON) | Built-in reporters | -- | Via frameworks | Cypress Dashboard | Audit log (JSON) | RD |
| CI integration patterns | GitHub Actions, Docker | Docker | Selenium Grid + Docker | cypress run | npm package, postinstall | SP |
| Trace viewer / debugging | playwright.dev/trace | -- | -- | Time-travel debugger | Audit log (no UI) | RD |
| Codegen / recording | npx playwright codegen | -- | Selenium IDE | Cypress Studio | -- | NO |
| Test flow orchestration | -- | -- | -- | -- | `safari_test_flow` (multi-step assert/navigate/click/fill/wait) | ADV |
| Page monitoring | -- | -- | -- | -- | `safari_monitor_page` (poll for DOM changes) | ADV |
| Pagination scraping | -- | -- | -- | -- | `safari_paginate_scrape` (multi-page extraction) | ADV |

### 3.10 Advanced Capabilities

| Feature | Playwright | Puppeteer | Selenium | Cypress | Safari Pilot | Rating |
|---------|-----------|-----------|----------|---------|-------------|--------|
| Geolocation emulation | context.setGeolocation() | page.setGeolocation() | Via CDP | -- | `safari_override_geolocation` | SP |
| Timezone emulation | timezoneId in context | Via CDP | -- | -- | `safari_override_timezone` | SP |
| Locale emulation | locale in context | -- | -- | -- | `safari_override_locale` | SP |
| User agent override | userAgent in context | page.setUserAgent() | Via options | -- | `safari_override_useragent` | SP |
| Color scheme (dark/light) | colorScheme in context | page.emulateMediaFeatures() | -- | -- | Not yet | RD |
| Device emulation presets | devices registry (viewport+UA+touch) | devices registry | -- | cy.viewport() | Per-param only (no preset registry) | RD |
| Permissions management | context.grantPermissions() | page.setPermission() (CDP) | -- | -- | `safari_permission_get/set` | SP |
| Accessibility auditing | Via axe-core integration | Via axe-core | Via axe-core | Via cypress-axe | Via `safari_snapshot` ARIA tree (no axe) | RD |
| Performance tracing | tracing.start/stop() | Via CDP | -- | -- | `safari_begin_trace` / `safari_end_trace` / `safari_get_page_metrics` | SP |
| Coverage collection | page.coverage (JS/CSS) | page.coverage (JS/CSS) | -- | @cypress/code-coverage | Not yet | RD |
| Viewport resize | page.setViewportSize() | page.setViewport() | manage().window().setSize() | cy.viewport() | Not yet (via AppleScript window resize possible) | RD |

### 3.11 Security & Agent Safety (Safari Pilot Exclusive)

| Feature | Playwright | Puppeteer | Selenium | Cypress | Safari Pilot |
|---------|-----------|-----------|----------|---------|-------------|
| Kill switch (global emergency stop) | -- | -- | -- | -- | KillSwitch layer |
| Tab ownership (agent-only tabs) | -- | -- | -- | -- | TabOwnership layer |
| Domain trust policies | -- | -- | -- | -- | DomainPolicy layer (per-domain rules) |
| Rate limiting (per-domain) | -- | -- | -- | -- | RateLimiter (120 actions/min) |
| Circuit breaker | -- | -- | -- | -- | CircuitBreaker (5 errors → 120s cooldown) |
| Prompt injection detection | -- | -- | -- | -- | IdpiScanner (pattern-based IDPI defence) |
| Human approval gates | -- | -- | -- | -- | HumanApproval (sensitive actions on untrusted domains) |
| Full audit logging | -- | -- | -- | -- | AuditLog (every call, params redacted) |
| Screenshot redaction | -- | -- | -- | -- | ScreenshotRedaction (password fields, cross-origin iframes) |

No competitor has any equivalent to Safari Pilot's security pipeline. This is the framework's most significant structural advantage for AI agent deployments.

---

## 4. Playwright MCP Server: Direct Comparison

The official Playwright MCP server (`@playwright/mcp`) is Safari Pilot's closest architectural analog. Both expose browser automation as MCP tools targeting AI agent consumption.

### Tool Count and Coverage

| | Playwright MCP | Safari Pilot MCP |
|---|---|---|
| Total tools | ~20 | 74 |
| Snapshot with refs | `browser_snapshot` (ARIA YAML) | `safari_snapshot` (ARIA YAML/JSON, scoped, depth control) |
| Click | `browser_click` (ref or selector) | `safari_click` (ref, 6 locator types, or selector + auto-wait) |
| Fill | `browser_fill_form` | `safari_fill` (per-field with auto-wait) |
| Type | `browser_type` | `safari_type` (character-by-character) |
| Navigate | `browser_navigate`, `browser_navigate_back` | `safari_navigate`, `safari_navigate_back/forward` |
| Screenshot | `browser_take_screenshot` (ref optional) | `safari_take_screenshot` |
| Network requests | `browser_network_requests` | 8 network tools (list, detail, intercept, mock, throttle, offline, WS listen/filter) |
| Console | `browser_console_messages` | `safari_get_console_messages` |
| File upload | `browser_file_upload` | Not yet |
| Dialog | `browser_handle_dialog` | `safari_handle_dialog` |
| Tabs | `browser_tabs` | `safari_list_tabs`, `safari_new_tab`, `safari_close_tab` |
| Evaluate | `browser_evaluate`, `browser_run_code` | `safari_evaluate`, `safari_eval_in_frame` |
| Storage tools | -- | 11 storage tools (cookies, localStorage, sessionStorage, IndexedDB, state export/import) |
| Structured extraction | -- | 5 tools (smart_scrape, tables, links, images, metadata) |
| Security pipeline | -- | 9 layers |

Safari Pilot exposes ~3.7x more tools than Playwright MCP and provides significantly deeper coverage in network, storage, extraction, and security. Playwright MCP's advantage is cross-browser support (Chromium, Firefox, WebKit) and the mature Playwright engine underneath.

### Ref System Comparison

Both use element refs from accessibility snapshots. Playwright MCP uses `ref` (string) as the primary element targeting mechanism, with `selector` as fallback. Safari Pilot uses the same pattern (`ref` priority > locator > selector) but adds six semantic locator types (role+name, text, label, testId, placeholder, exact matching) directly on every tool, reducing the need to take a snapshot before acting.

### Session Model

Playwright MCP sessions are binary (running or gone), with ephemeral browser profiles by default. Safari Pilot sessions work with the user's persistent Safari instance -- tabs created by the agent are owned and tracked, but the user's existing tabs are visible and protected. This is a deliberate design choice for AI-agent safety, not a limitation.

---

## 5. Community Adoption Trends

| Metric | Playwright | Puppeteer | Selenium | Cypress |
|--------|-----------|-----------|----------|---------|
| npm weekly downloads | ~33M | ~10M | ~6M (selenium-webdriver) | ~6.5M |
| GitHub stars | 78K+ | 88K+ | 32K+ | 47K+ |
| Satisfaction (State of JS 2025) | 91% | -- | 68% | 72% |
| Job posting growth (2025 YoY) | +180% | Declining | Stable | Declining |
| Companies using (verified) | 4,400+ | -- | -- | -- |

Playwright is the clear momentum leader. Puppeteer and Cypress are declining. Selenium remains entrenched in enterprises but satisfaction is low. Safari Pilot occupies a unique niche (Safari-native, agent-first) that none of these tools serve.

---

## 6. Top 10 Gaps to Close

Ranked by competitive impact and feasibility. Items marked with existing roadmap items are noted.

### 1. File Download Handling (High Impact, Roadmap Exists)

Every competitor handles downloads. Safari Pilot has no equivalent. Research at `p1-file-downloads-research.md` covers the approach. This is the most user-visible missing feature for web automation workflows.

### 2. File Upload (High Impact)

`setInputFiles()` / `<input type="file">` handling is standard across all competitors. Playwright MCP exposes `browser_file_upload`. Without this, form-heavy workflows hit a wall.

### 3. PDF Generation (Medium-High Impact, Roadmap Exists)

Playwright and Puppeteer offer `page.pdf()`. Research at `p1-pdf-generation-research.md` covers Safari-specific approaches. Important for document extraction workflows.

### 4. Video Recording (Medium Impact, Roadmap Exists)

Playwright records video per-context. Research at `p2-video-recording-research.md` covers macOS approaches (ScreenCaptureKit, screencapture CLI). Useful for debugging and audit trails.

### 5. Visual Comparison / Regression Testing (Medium Impact, Roadmap Exists)

Playwright's `toHaveScreenshot()` with pixel diffing is widely used. Research at `p2-visual-regression-research.md` exists. Requires element-level screenshots first (Gap 8).

### 6. Right-Click / Context Menu (Low-Medium Impact)

Currently, `safari_click` only dispatches left clicks. Playwright and all competitors support right-click. Quick implementation -- add button param to click handler, dispatch contextmenu event.

### 7. Color Scheme Emulation (Low-Medium Impact)

Playwright's `colorScheme` context option is commonly used for dark-mode testing. Safari Pilot has timezone/locale/geolocation/user-agent overrides but not color scheme. Achievable via `prefers-color-scheme` media query override in JS.

### 8. Element-Level Screenshots (Medium Impact)

`safari_take_screenshot` captures the full Safari window via `screencapture`. Playwright/Puppeteer/Selenium can screenshot individual elements. Needed for visual regression (Gap 5). Extension engine could provide this via `captureVisibleTab` + crop.

### 9. HAR Recording and Replay (Low-Medium Impact)

Playwright records HAR natively and can replay from HAR files (`routeFromHAR`). Safari Pilot has deep network tools (intercept, mock, list, detail, WebSocket) but no HAR format support. Could be built on top of existing interceptor.

### 10. Device Emulation Presets (Low Impact)

Playwright ships a device registry (iPhone 15, Pixel 7, etc.) that sets viewport + user agent + touch + deviceScaleFactor in one call. Safari Pilot has all the individual override tools but no preset bundles. Easy to implement as a compound tool or config extension.

---

## 7. Structural Advantages to Preserve

These are areas where Safari Pilot is demonstrably better than all competitors and should be maintained and marketed:

1. **Agent Security Pipeline** -- Nine layers with no competitor equivalent. The IDPI scanner, tab ownership, domain policies, and human approval gates make Safari Pilot the only automation framework safe for autonomous AI agent deployment.

2. **Structured Data Extraction** -- `safari_smart_scrape`, `safari_extract_tables`, `safari_extract_links`, `safari_extract_images`, `safari_extract_metadata` are purpose-built for AI data pipelines. No competitor offers these as first-class tools.

3. **Compound Automation Tools** -- `safari_test_flow`, `safari_monitor_page`, `safari_paginate_scrape`, `safari_media_control` combine multiple actions into single tool calls, reducing token overhead for AI agents.

4. **Storage Depth** -- Dedicated tools for localStorage, sessionStorage, IndexedDB (with key range queries), plus full state export/import. Competitors require raw JS evaluation for most of this.

5. **Safari-Native Operation** -- The only framework that automates Safari without WebDriver or browser patching. Uses the real Safari with the user's extensions, profiles, and state. For macOS-native workflows, this is irreplaceable.

6. **Network Tool Richness** -- Eight dedicated network tools including WebSocket monitoring, throttling, and offline simulation as first-class tools. Playwright MCP exposes `browser_network_requests` as a single tool.

---

## 8. Benchmark Design Implications

Based on this analysis, competitive benchmarks should measure:

1. **Token efficiency**: Safari Pilot's 74 granular tools vs. Playwright MCP's 20 tools -- measure total tokens consumed for equivalent workflows (login → navigate → extract → assert).
2. **Latency**: Safari Pilot's three-tier engine (5ms daemon, 10ms extension, 80ms AppleScript) vs. Playwright's CDP-based approach.
3. **Extraction quality**: Schema-based scraping, table extraction, and ARIA snapshot accuracy compared to manual Playwright evaluate() approaches.
4. **Security overhead**: Measure the latency cost of the nine security layers and demonstrate the protection they provide (IDPI injection tests, cross-tab isolation tests).
5. **Real-world workflows**: Authentication, multi-page form submission, data scraping, media interaction -- areas where Safari Pilot's tool depth should shine.
