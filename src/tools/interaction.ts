import type { ToolResponse, ToolRequirements } from '../types.js';
import type { IEngine } from '../engines/engine.js';
import type { Engine } from '../types.js';
import type { SafariPilotServer } from '../server.js';
import { buildRefSelector } from '../aria.js';
import { generateAutoWaitJs, ACTION_CHECKS } from '../auto-wait.js';
import { hasLocatorParams, extractLocatorFromParams, generateLocatorJs } from '../locator.js';
import { escapeForJsSingleQuote } from '../escape.js';
import { StrictnessViolationError } from '../errors.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}

type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;

export class InteractionTools {
  private engine: IEngine;
  private server: SafariPilotServer;
  private handlers: Map<string, Handler> = new Map();

  constructor(engine: IEngine, server: SafariPilotServer) {
    this.engine = engine;
    this.server = server;
    this.registerHandlers();
  }

  private registerHandlers(): void {
    this.handlers.set('safari_click', this.handleClick.bind(this));
    this.handlers.set('safari_double_click', this.handleDoubleClick.bind(this));
    this.handlers.set('safari_fill', this.handleFill.bind(this));
    this.handlers.set('safari_select_option', this.handleSelectOption.bind(this));
    this.handlers.set('safari_check', this.handleCheck.bind(this));
    this.handlers.set('safari_hover', this.handleHover.bind(this));
    this.handlers.set('safari_type', this.handleType.bind(this));
    this.handlers.set('safari_press_key', this.handlePressKey.bind(this));
    this.handlers.set('safari_scroll', this.handleScroll.bind(this));
    this.handlers.set('safari_drag', this.handleDrag.bind(this));
    this.handlers.set('safari_handle_dialog', this.handleHandleDialog.bind(this));
    this.handlers.set('safari_scroll_to_element', this.handleScrollToElement.bind(this));
  }

  // ── Element Resolution & Auto-Wait ─────────────────────────────────────────

  /**
   * Resolve an element target from params. Priority: ref > locator > selector.
   * Returns a CSS selector string usable in querySelector().
   */
  private async resolveElement(
    tabUrl: string,
    params: Record<string, unknown>,
    strict = false,
  ): Promise<string> {
    const ref = params['ref'] as string | undefined;
    if (ref) return buildRefSelector(ref);

    if (hasLocatorParams(params)) {
      const locator = extractLocatorFromParams(params)!;
      const locatorJs = generateLocatorJs(locator);
      const result = await this.engine.executeJsInTab(tabUrl, locatorJs);
      if (result.ok && result.value) {
        const parsed = JSON.parse(result.value);
        if (parsed.found && parsed.selector) {
          // T80: action tools enforce strict mode — multi-match without disambiguation throws.
          if (strict && parsed.matchCount > 1 && parsed.strictnessSatisfied === false) {
            throw new StrictnessViolationError(parsed.matchCount, JSON.stringify(locator));
          }
          return parsed.selector;
        }
        throw new Error(parsed.hint || 'Locator did not match any element');
      }
      throw new Error('Locator resolution failed');
    }

    const selector = params['selector'] as string | undefined;
    if (!selector) throw new Error('No element targeting provided. Use ref, selector, or a locator (role, text, label, testId, placeholder).');
    return selector;
  }

  /**
   * Run auto-wait actionability checks, then execute the action JS.
   * Skips waiting if checks are empty or force mode is on.
   */
  private async waitAndExecute(
    tabUrl: string,
    selector: string,
    actionType: string,
    actionJs: string,
    options: { timeout?: number; force?: boolean },
  ): Promise<ToolResponse> {
    const start = Date.now();
    const checks = ACTION_CHECKS[actionType] ?? [];
    const timeout = options.timeout ?? 5000;

    // Auto-wait (skip if no checks or force mode)
    if (checks.length > 0 && !options.force) {
      const waitJs = generateAutoWaitJs(selector, checks, { timeout, force: false });
      const waitResult = await this.engine.executeJsInTab(tabUrl, waitJs, timeout + 1000);
      if (waitResult.ok && waitResult.value) {
        const parsed = JSON.parse(waitResult.value);
        if (!parsed.ready) {
          const hints = parsed.hints?.join(' ') ?? '';
          throw new Error(`Element not actionable: ${parsed.failedCheck}. ${hints}`);
        }
      }
      // If wait itself fails (e.g., JS error), fall through to action — it will fail with its own error
    }

    // Execute the action
    const result = await this.engine.executeJsInTab(tabUrl, actionJs, timeout);
    if (!result.ok) throw new Error(result.error?.message ?? `${actionType} failed`);

    return this.makeResponse(
      result.value ? JSON.parse(result.value) : { [actionType]: true },
      Date.now() - start,
    );
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  getDefinitions(): ToolDefinition[] {
    // Shared element targeting params — added to every tool that targets an element
    const elementTargetingParams = {
      ref: { type: 'string', description: "Element ref from snapshot (e.g. 'e5'). Takes priority over selector." },
      role: { type: 'string', description: "ARIA role to target (e.g. 'button', 'link', 'textbox')" },
      name: { type: 'string', description: 'Accessible name to match (with role)' },
      text: { type: 'string', description: 'Visible text content to match' },
      label: { type: 'string', description: 'Associated label text to match' },
      testId: { type: 'string', description: 'data-testid attribute value (exact match)' },
      placeholder: { type: 'string', description: 'Placeholder attribute to match' },
      xpath: { type: 'string', description: "XPath expression (e.g. '//button[@id=\"submit\"]'). Takes priority over every other locator key — the most explicit target wins." },
      exact: { type: 'boolean', description: 'Use exact matching instead of substring', default: false },
      force: { type: 'boolean', description: 'Skip auto-wait actionability checks', default: false },
      chain: {
        type: 'array',
        items: { type: 'object' },
        description:
          'T77: multi-step locator chain ops (Playwright-style). Each entry is one of: ' +
          '{op:"filter", hasText|hasNotText|has|hasNot}, {op:"nth", n}, {op:"first"}, {op:"last"}, ' +
          '{op:"and"|"or"|"descendant", locator}. Applied in order against the base locator match set. ' +
          'Action tools throw STRICTNESS_VIOLATION on multi-match unless chain ends in first/last/nth.',
      },
    };

    return [
      {
        name: 'safari_click',
        description:
          'Click an element on the page. Use when activating a button, link, checkbox, or any clickable — strict mode throws StrictnessViolationError on multi-match; switch to safari_query_all to enumerate first or add chain=[{filter:{hasText:"Sign In"}},{nth:0}] to disambiguate inline.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            selector: { type: 'string', minLength: 1, description: 'CSS selector for the element to click' },
            ...elementTargetingParams,
            shadowSelector: { type: 'string', description: 'Selector within Shadow DOM (extension-only)' },
            button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
            modifiers: { type: 'array', items: { type: 'string', enum: ['ctrl', 'shift', 'alt', 'meta'] } },
            waitForNavigation: { type: 'boolean', default: false },
            timeout: { type: 'number', default: 5000 },
          },
          required: ['tabUrl'],
        },
        requirements: { idempotent: false },
      },
      {
        name: 'safari_double_click',
        description:
          'Double-click an element. Use when activating a UI affordance that requires double-click (rare on web; mostly file managers and code editors).',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            selector: { type: 'string', minLength: 1, description: 'CSS selector for the element to double-click' },
            ...elementTargetingParams,
            timeout: { type: 'number', default: 5000 },
          },
          required: ['tabUrl'],
        },
        requirements: { idempotent: false },
      },
      {
        name: 'safari_fill',
        description:
          'Set the value of an input element directly. Use when filling form fields where keystroke fidelity is not required — faster than safari_type; strict mode enforced on the locator.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            selector: { type: 'string', minLength: 1, description: 'CSS selector for the input element' },
            ...elementTargetingParams,
            value: { type: 'string', description: 'Text to fill' },
            framework: {
              type: 'string',
              enum: ['auto', 'react', 'vue', 'vanilla'],
              default: 'auto',
              description: 'Framework hint for event dispatch strategy',
            },
            clearFirst: { type: 'boolean', default: true },
            pressEnterAfter: { type: 'boolean', default: false },
            timeout: { type: 'number' },
          },
          required: ['tabUrl', 'value'],
        },
        requirements: { idempotent: false },
      },
      {
        name: 'safari_select_option',
        description:
          'Select an <option> in a native <select> by value, label, or index. Use when interacting with HTML select elements; for custom dropdowns built with divs use safari_click on the option element.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            selector: { type: 'string', minLength: 1, description: 'Selector for the <select> element' },
            ...elementTargetingParams,
            optionValue: { type: 'string', description: 'Option value attribute to select' },
            optionLabel: { type: 'string', description: 'Option visible text to select' },
            optionIndex: { type: 'number', description: 'Option index to select' },
          },
          required: ['tabUrl'],
        },
        requirements: { idempotent: false },
      },
      {
        name: 'safari_check',
        description:
          'Set the checked state of a checkbox or radio. Use when toggling form options; idempotent — passing a checked state matching current state is a no-op.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            selector: { type: 'string', minLength: 1, description: 'CSS selector for the checkbox/radio' },
            ...elementTargetingParams,
            checked: { type: 'boolean', description: 'true to check, false to uncheck' },
          },
          required: ['tabUrl', 'checked'],
        },
        requirements: { idempotent: false },
      },
      {
        name: 'safari_hover',
        description:
          'Dispatch a synthetic MouseEvent hover on an element. Use when a sub-menu or tooltip only appears on hover; note CSS :hover pseudo-classes are NOT activated — only JS mouseover/mouseenter handlers fire.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            selector: { type: 'string', minLength: 1, description: 'CSS selector for the element to hover' },
            ...elementTargetingParams,
            duration: { type: 'number', description: 'How long to hover in ms', default: 0 },
          },
          required: ['tabUrl'],
        },
        requirements: { idempotent: false },
      },
      {
        name: 'safari_type',
        description:
          'Type text into a focused element character-by-character. Use when an input expects keystroke events (autocomplete, debounced search); for plain form fills prefer safari_fill which is faster.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            selector: { type: 'string', minLength: 1, description: 'CSS selector for the target element' },
            ...elementTargetingParams,
            content: { type: 'string', description: 'Text to type' },
          },
          required: ['tabUrl', 'content'],
        },
        requirements: { idempotent: false },
      },
      {
        name: 'safari_press_key',
        description:
          'Press a keyboard key with optional modifiers. Use when submitting with Enter, dismissing with Escape, Tab/Shift-Tab keyboard navigation, or Cmd-A/Cmd-C combos.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            key: { type: 'string', description: 'Key name: Enter, Tab, Escape, ArrowDown, a, etc.' },
            modifiers: {
              type: 'array',
              items: { type: 'string', enum: ['ctrl', 'shift', 'alt', 'meta'] },
            },
            selector: { type: 'string', description: 'Focus this element before pressing' },
            ref: { type: 'string', description: "Element ref from snapshot (e.g. 'e5'). Focus before pressing." },
            role: { type: 'string', description: "ARIA role to target (e.g. 'textbox')" },
            name: { type: 'string', description: 'Accessible name to match (with role)' },
            testId: { type: 'string', description: 'data-testid attribute value' },
            chain: {
              type: 'array',
              items: { type: 'object' },
              description: 'T77: multi-step locator chain ops. Same envelope as elementTargetingParams.chain.',
            },
          },
          required: ['tabUrl', 'key'],
        },
        requirements: { idempotent: false },
      },
      {
        name: 'safari_scroll',
        description:
          'Scroll the page or a scrollable container by pixels or to an element. Use when content is below the fold or to bring an element into view before clicking.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            selector: { type: 'string', description: 'Element to scroll. If omitted, scrolls the page.' },
            ref: { type: 'string', description: "Element ref from snapshot to scroll" },
            role: { type: 'string', description: 'ARIA role to target' },
            name: { type: 'string', description: 'Accessible name to match (with role)' },
            testId: { type: 'string', description: 'data-testid attribute value' },
            direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
            amount: { type: 'number', description: 'Pixels to scroll', default: 500 },
            toTop: { type: 'boolean' },
            toBottom: { type: 'boolean' },
            toElement: { type: 'string', description: 'Scroll until this selector is visible' },
          },
          required: ['tabUrl'],
        },
        requirements: { idempotent: false },
      },
      {
        name: 'safari_drag',
        description:
          'Drag from one element to another. Use when working with sortable lists, file drop zones, or canvas-based UI; both endpoints accept locator descriptors.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            sourceSelector: { type: 'string', description: 'CSS selector for the drag source element' },
            sourceRef: { type: 'string', description: 'Element ref for drag source (from snapshot)' },
            targetSelector: { type: 'string', description: 'CSS selector for the drag target element' },
            targetRef: { type: 'string', description: 'Element ref for drag target (from snapshot)' },
            steps: { type: 'number', description: 'Number of intermediate mousemove steps', default: 10 },
            force: { type: 'boolean', description: 'Skip auto-wait actionability checks', default: false },
            timeout: { type: 'number', default: 5000 },
          },
          required: ['tabUrl'],
        },
        requirements: { idempotent: false },
      },
      {
        name: 'safari_handle_dialog',
        description:
          'Pre-arm a handler for the next JS alert/confirm/prompt. Use when the next action will trigger a dialog — Safari blocks on dialogs and other tools cannot run until handled.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            autoHandle: {
              type: 'boolean',
              description: 'Must be true to install the interceptor. Set to false to restore native dialogs.',
            },
            action: {
              type: 'string',
              enum: ['accept', 'dismiss'],
              description: 'How to handle dialogs: accept (ok/confirm) or dismiss (cancel)',
            },
            promptText: {
              type: 'string',
              description: 'Text to return from prompt() dialogs when action is accept',
            },
          },
          required: ['tabUrl', 'autoHandle', 'action'],
        },
        requirements: { idempotent: false },
      },
      {
        name: 'safari_scroll_to_element',
        description:
          'Scroll a specific element into the visible viewport. Provide one of '
          + '{selector, text, role+name} — the tool resolves to a DOM node and '
          + 'scrolls it to vertical center. Useful before safari_take_screenshot '
          + 'when the answer-bearing content is off-screen, or to bring a section '
          + 'into focus after navigation. On multi-match, scrolls to first match '
          + 'and returns the full candidate list. Resolution precedence: selector '
          + '> role+name > text. text matches DOM textContent only — NOT form values.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl:   { type: 'string', format: 'uri' },
            selector: { type: 'string', description: 'CSS selector (preferred when known)' },
            text:     { type: 'string', description: 'Visible text substring (case-insensitive, whitespace-normalized). DOM text only — does NOT match form values.' },
            role:     { type: 'string', description: 'ARIA role (e.g. "button", "heading")' },
            name:     { type: 'string', description: 'Accessible name for role-based lookup' },
            nth:      { type: 'integer', minimum: 0, description: '0-based index for multi-match disambiguation' },
            behavior: { type: 'string', enum: ['instant', 'smooth'], default: 'instant' },
          },
          required: ['tabUrl'],
          additionalProperties: false,
        },
        requirements: { requiresAsyncJs: true, idempotent: true },
      },
    ];
  }

  getHandler(name: string): Handler | undefined {
    return this.handlers.get(name);
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  private async handleClick(params: Record<string, unknown>): Promise<ToolResponse> {
    const tabUrl = params['tabUrl'] as string;
    const timeout = typeof params['timeout'] === 'number' ? params['timeout'] : 5000;
    const force = params['force'] === true;

    // 5A.3: button + modifiers honored. Schema declares both (lines ~142-143);
    // pre-fix the handler ignored them and dispatched every click as primary
    // (button=0) with no modifier flags — same "schema lies" class as T49/T50/T51.
    const buttonName = (params['button'] as string) ?? 'left';
    const buttonNum = buttonName === 'right' ? 2 : buttonName === 'middle' ? 1 : 0;
    const mods = Array.isArray(params['modifiers']) ? (params['modifiers'] as string[]) : [];
    const ctrlKey = mods.includes('ctrl');
    const shiftKey = mods.includes('shift');
    const altKey = mods.includes('alt');
    const metaKey = mods.includes('meta');
    // Per W3C UI Events:
    //   primary (button=0): mousedown → mouseup → click
    //   right   (button=2): mousedown → mouseup → contextmenu  (no 'click')
    //   middle  (button=1): mousedown → mouseup → auxclick     (no 'click')
    const terminalEvent = buttonNum === 0 ? 'click' : buttonNum === 2 ? 'contextmenu' : 'auxclick';
    // Native link-following only fires for primary click. Right opens context;
    // middle is "open in new tab" which our automation cannot replicate via JS.
    const followLinks = buttonNum === 0 ? 'true' : 'false';

    const selector = await this.resolveElement(tabUrl, params, true);
    const escapedSelector = escapeForJsSingleQuote(selector);

    const actionJs = `
      var el = document.querySelector('${escapedSelector}');
      if (!el) throw Object.assign(new Error('Element not found: ${escapedSelector}'), { name: 'ELEMENT_NOT_FOUND' });

      var rect = el.getBoundingClientRect();
      var opts = {
        bubbles: true, cancelable: true, view: window,
        clientX: rect.x + rect.width/2, clientY: rect.y + rect.height/2,
        button: ${buttonNum},
        buttons: ${1 << buttonNum},
        ctrlKey: ${ctrlKey},
        shiftKey: ${shiftKey},
        altKey: ${altKey},
        metaKey: ${metaKey},
      };
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('${terminalEvent}', opts));

      var linkEl = el.tagName === 'A' ? el : el.closest('a');
      var navigatedTo = null;

      // dispatchEvent fires JS handlers but does NOT trigger Safari's native
      // link-following behavior. For anchor elements + primary click, explicitly navigate.
      if (${followLinks} && linkEl && linkEl.href && !linkEl.hasAttribute('download')) {
        var target = linkEl.getAttribute('target');
        if (!target || target === '_self') {
          navigatedTo = linkEl.href;
        }
      }

      var result = {
        clicked: true,
        navigatedTo: navigatedTo,
        element: {
          tagName: el.tagName,
          id: el.id || undefined,
          textContent: (el.textContent || '').slice(0, 100),
        },
        downloadContext: linkEl ? {
          href: linkEl.href || undefined,
          downloadAttr: linkEl.getAttribute('download') ?? undefined,
          isDownloadLink: linkEl.hasAttribute('download'),
        } : undefined
      };

      if (navigatedTo) {
        window.location.href = navigatedTo;
      }

      return result;
    `;

    const response = await this.waitAndExecute(tabUrl, selector, 'click', actionJs, { timeout, force });

    let resultText: string | undefined;
    try {
      resultText = response.content[0]?.text;
      if (resultText) {
        const parsed = JSON.parse(resultText);
        if (parsed.downloadContext) {
          this.server.setClickContext({
            href: parsed.downloadContext.href ?? undefined,
            downloadAttr: parsed.downloadContext.downloadAttr ?? undefined,
            isDownloadLink: !!parsed.downloadContext.isDownloadLink,
            tabUrl,
            timestamp: Date.now(),
          });
        }
      }
    } catch (err) {
      if (err instanceof SyntaxError) {
        console.warn(`[safari_click] Could not parse click response for download context: ${resultText?.slice(0, 100)}`);
      } else {
        console.warn(`[safari_click] Download context extraction failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return response;
  }

  private async handleDoubleClick(params: Record<string, unknown>): Promise<ToolResponse> {
    const tabUrl = params['tabUrl'] as string;
    const timeout = typeof params['timeout'] === 'number' ? params['timeout'] : 5000;
    const force = params['force'] === true;

    const selector = await this.resolveElement(tabUrl, params, true);
    const escapedSelector = escapeForJsSingleQuote(selector);

    const actionJs = `
      var el = document.querySelector('${escapedSelector}');
      if (!el) throw Object.assign(new Error('Element not found: ${escapedSelector}'), { name: 'ELEMENT_NOT_FOUND' });

      var rect = el.getBoundingClientRect();
      var opts = { bubbles: true, cancelable: true, view: window, clientX: rect.x + rect.width/2, clientY: rect.y + rect.height/2 };
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
      el.dispatchEvent(new MouseEvent('dblclick', opts));

      var selection = window.getSelection();
      return {
        clicked: true,
        element: { tagName: el.tagName, id: el.id || undefined, textContent: (el.textContent || '').slice(0, 100) },
        selectedText: selection ? selection.toString() : undefined,
      };
    `;

    return this.waitAndExecute(tabUrl, selector, 'dblclick', actionJs, { timeout, force });
  }

  private async handleFill(params: Record<string, unknown>): Promise<ToolResponse> {
    const tabUrl = params['tabUrl'] as string;
    const value = params['value'] as string;
    const framework = (params['framework'] as string | undefined) ?? 'auto';
    const clearFirst = params['clearFirst'] !== false;
    const pressEnterAfter = params['pressEnterAfter'] === true;
    const timeout = typeof params['timeout'] === 'number' ? params['timeout'] : 10000;
    const force = params['force'] === true;

    const selector = await this.resolveElement(tabUrl, params, true);
    const escapedSelector = escapeForJsSingleQuote(selector);
    const escapedValue = escapeForJsSingleQuote(value);

    const actionJs = `
      var el = document.querySelector('${escapedSelector}');
      if (!el) throw Object.assign(new Error('Element not found: ${escapedSelector}'), { name: 'ELEMENT_NOT_FOUND' });

      var detectedFramework = 'vanilla';
      if (Object.keys(el).some(function(k) { return k.startsWith('__reactFiber$'); })) {
        detectedFramework = 'react';
      } else if (el.__vue__ || el.__vueParentComponent) {
        detectedFramework = 'vue';
      }

      var fw = '${framework}' === 'auto' ? detectedFramework : '${framework}';

      if (${clearFirst}) {
        el.focus();
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }

      if (fw === 'react') {
        var nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
          ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
          : Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')
          ? Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
          : null;
        if (nativeSetter) {
          nativeSetter.call(el, '${escapedValue}');
        } else {
          el.value = '${escapedValue}';
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      } else if (fw === 'vue') {
        el.value = '${escapedValue}';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        el.focus();
        el.value = '${escapedValue}';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new FocusEvent('blur', { bubbles: true }));
      }

      ${pressEnterAfter ? 'el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));' : ''}

      return {
        filled: true,
        element: { tagName: el.tagName, id: el.id || undefined, name: el.name || undefined, type: el.type || undefined },
        framework: fw,
        verifiedValue: el.value,
      };
    `;

    return this.waitAndExecute(tabUrl, selector, 'fill', actionJs, { timeout, force });
  }

  private async handleSelectOption(params: Record<string, unknown>): Promise<ToolResponse> {
    const tabUrl = params['tabUrl'] as string;
    const timeout = typeof params['timeout'] === 'number' ? params['timeout'] : 5000;
    const force = params['force'] === true;

    // Option selection params (renamed to avoid collision with locator 'label')
    const optionValue = params['optionValue'] as string | undefined;
    const optionLabel = params['optionLabel'] as string | undefined;
    const optionIndex = params['optionIndex'] as number | undefined;

    const selector = await this.resolveElement(tabUrl, params, true);
    const escapedSelector = escapeForJsSingleQuote(selector);

    const actionJs = `
      var el = document.querySelector('${escapedSelector}');
      if (!el) throw Object.assign(new Error('Element not found'), { name: 'ELEMENT_NOT_FOUND' });
      if (el.tagName !== 'SELECT') throw new Error('Element is not a <select>');

      var option;
      ${optionValue !== undefined ? `option = Array.from(el.options).find(function(o) { return o.value === '${escapeForJsSingleQuote(optionValue)}'; });` : ''}
      ${optionLabel !== undefined ? `if (!option) option = Array.from(el.options).find(function(o) { return o.textContent.trim() === '${escapeForJsSingleQuote(optionLabel)}'; });` : ''}
      ${optionIndex !== undefined ? `if (!option) option = el.options[${optionIndex}];` : ''}
      if (!option) throw Object.assign(new Error('Option not found'), { name: 'ELEMENT_NOT_FOUND' });

      el.value = option.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));

      return {
        selected: true,
        option: { value: option.value, label: option.textContent.trim(), index: option.index },
      };
    `;

    return this.waitAndExecute(tabUrl, selector, 'selectOption', actionJs, { timeout, force });
  }

  private async handleCheck(params: Record<string, unknown>): Promise<ToolResponse> {
    const tabUrl = params['tabUrl'] as string;
    const checked = params['checked'] as boolean;
    const timeout = typeof params['timeout'] === 'number' ? params['timeout'] : 5000;
    const force = params['force'] === true;

    const selector = await this.resolveElement(tabUrl, params, true);
    const escapedSelector = escapeForJsSingleQuote(selector);

    const actionJs = `
      var el = document.querySelector('${escapedSelector}');
      if (!el) throw Object.assign(new Error('Element not found'), { name: 'ELEMENT_NOT_FOUND' });

      if (el.checked !== ${checked}) {
        el.click();
      }

      return {
        toggled: true,
        element: { tagName: el.tagName, type: el.type, name: el.name || undefined },
        checked: el.checked,
      };
    `;

    return this.waitAndExecute(tabUrl, selector, 'check', actionJs, { timeout, force });
  }

  private async handleHover(params: Record<string, unknown>): Promise<ToolResponse> {
    const tabUrl = params['tabUrl'] as string;
    const timeout = typeof params['timeout'] === 'number' ? params['timeout'] : 5000;
    const force = params['force'] === true;

    const selector = await this.resolveElement(tabUrl, params, true);
    const escapedSelector = escapeForJsSingleQuote(selector);

    const actionJs = `
      var el = document.querySelector('${escapedSelector}');
      if (!el) throw Object.assign(new Error('Element not found'), { name: 'ELEMENT_NOT_FOUND' });

      var rect = el.getBoundingClientRect();
      var opts = { bubbles: true, cancelable: true, view: window, clientX: rect.x + rect.width/2, clientY: rect.y + rect.height/2 };
      el.dispatchEvent(new MouseEvent('mouseenter', opts));
      el.dispatchEvent(new MouseEvent('mouseover', opts));
      el.dispatchEvent(new MouseEvent('mousemove', opts));

      return {
        hovered: true,
        element: { tagName: el.tagName, id: el.id || undefined, textContent: (el.textContent || '').slice(0, 100) },
      };
    `;

    return this.waitAndExecute(tabUrl, selector, 'hover', actionJs, { timeout, force });
  }

  private async handleType(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    // 'content' avoids collision with locator 'text' param
    const content = params['content'] as string;

    const selector = await this.resolveElement(tabUrl, params, true);
    const escapedSelector = escapeForJsSingleQuote(selector);
    const escapedText = escapeForJsSingleQuote(content);

    const js = `
      var el = document.querySelector('${escapedSelector}');
      if (!el) throw Object.assign(new Error('Element not found'), { name: 'ELEMENT_NOT_FOUND' });
      el.focus();

      var text = '${escapedText}';
      for (var i = 0; i < text.length; i++) {
        var char = text[i];
        el.dispatchEvent(new KeyboardEvent('keydown', { key: char, code: 'Key' + char.toUpperCase(), bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keypress', { key: char, code: 'Key' + char.toUpperCase(), bubbles: true }));
        el.value += char;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: char, code: 'Key' + char.toUpperCase(), bubbles: true }));
      }

      return { typed: true, length: text.length };
    `;

    // type has no actionability checks (ACTION_CHECKS.type = []), execute directly
    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Type failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : { typed: true }, Date.now() - start);
  }

  private async handlePressKey(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const key = params['key'] as string;
    const modifiers = (params['modifiers'] as string[] | undefined) ?? [];

    // press_key optionally targets an element for focus
    const hasTarget = params['ref'] || params['selector'] || hasLocatorParams(params);
    let escapedSelector = '';
    if (hasTarget) {
      const selector = await this.resolveElement(tabUrl, params, true);
      escapedSelector = escapeForJsSingleQuote(selector);
    }

    const escapedKey = escapeForJsSingleQuote(key);

    const js = `
      ${escapedSelector ? `var el = document.querySelector('${escapedSelector}'); if (el) el.focus();` : ''}
      var target = ${escapedSelector ? `(el || document.activeElement || document.body)` : 'document.activeElement || document.body'};
      var opts = {
        key: '${escapedKey}',
        code: '${escapedKey}'.length === 1 ? 'Key' + '${escapedKey}'.toUpperCase() : '${escapedKey}',
        bubbles: true,
        cancelable: true,
        ctrlKey: ${modifiers.includes('ctrl')},
        shiftKey: ${modifiers.includes('shift')},
        altKey: ${modifiers.includes('alt')},
        metaKey: ${modifiers.includes('meta')},
      };
      target.dispatchEvent(new KeyboardEvent('keydown', opts));
      target.dispatchEvent(new KeyboardEvent('keypress', opts));
      target.dispatchEvent(new KeyboardEvent('keyup', opts));

      return { pressed: true, key: '${escapedKey}', modifiers: [${modifiers.map(m => `'${m}'`).join(',')}] };
    `;

    // pressKey has no actionability checks, execute directly
    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Press key failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : { pressed: true }, Date.now() - start);
  }

  private async handleScroll(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const direction = (params['direction'] as string | undefined) ?? 'down';
    const amount = typeof params['amount'] === 'number' ? params['amount'] : 500;
    const toTop = params['toTop'] === true;
    const toBottom = params['toBottom'] === true;
    const toElement = params['toElement'] as string | undefined;

    // T50 — `toTop`, `toBottom`, and `toElement` are mutually exclusive scroll
    // modes. Pre-T50 the handler emitted each branch as a separate JS
    // statement, so a multi-mode call ran them serially with last-write-wins
    // and no caller-visible warning.
    const modeCount = (toTop ? 1 : 0) + (toBottom ? 1 : 0) + (toElement ? 1 : 0);
    if (modeCount > 1) {
      throw new Error(
        '`toTop`, `toBottom`, and `toElement` are mutually exclusive — pass only one.',
      );
    }

    // scroll optionally targets an element (if omitted, scrolls page)
    const hasTarget = params['ref'] || params['selector'] || hasLocatorParams(params);
    let escapedSelector = '';
    if (hasTarget) {
      const selector = await this.resolveElement(tabUrl, params);
      escapedSelector = escapeForJsSingleQuote(selector);
    }

    const escapedToElement = toElement ? escapeForJsSingleQuote(toElement) : '';

    const js = `
      var target = ${escapedSelector ? `document.querySelector('${escapedSelector}')` : 'document.documentElement'};
      if (!target) throw Object.assign(new Error('Scroll target not found'), { name: 'ELEMENT_NOT_FOUND' });

      ${toTop ? 'target.scrollTo({ top: 0, behavior: "smooth" });' : ''}
      ${toBottom ? 'target.scrollTo({ top: target.scrollHeight, behavior: "smooth" });' : ''}
      ${toElement ? `var scrollTarget = document.querySelector('${escapedToElement}'); if (scrollTarget) scrollTarget.scrollIntoView({ behavior: 'smooth' });` : ''}
      ${!toTop && !toBottom && !toElement ? `
        var amt = ${amount};
        var dir = '${direction}';
        if (dir === 'down') target.scrollBy({ top: amt, behavior: 'smooth' });
        else if (dir === 'up') target.scrollBy({ top: -amt, behavior: 'smooth' });
        else if (dir === 'right') target.scrollBy({ left: amt, behavior: 'smooth' });
        else if (dir === 'left') target.scrollBy({ left: -amt, behavior: 'smooth' });
      ` : ''}

      return {
        scrolled: true,
        scrollPosition: { x: target.scrollLeft || window.scrollX, y: target.scrollTop || window.scrollY },
        atTop: (target.scrollTop || window.scrollY) === 0,
        atBottom: (target.scrollTop || window.scrollY) + (target.clientHeight || window.innerHeight) >= (target.scrollHeight - 1),
      };
    `;

    // scroll has no actionability checks, execute directly
    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Scroll failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : { scrolled: true }, Date.now() - start);
  }

  private async handleDrag(params: Record<string, unknown>): Promise<ToolResponse> {
    const tabUrl = params['tabUrl'] as string;
    const steps = typeof params['steps'] === 'number' ? params['steps'] : 10;
    const timeout = typeof params['timeout'] === 'number' ? params['timeout'] : 5000;
    const force = params['force'] === true;

    // Resolve source: sourceRef > sourceSelector
    const sourceRef = params['sourceRef'] as string | undefined;
    const sourceSelector = params['sourceSelector'] as string | undefined;
    let resolvedSource: string;
    if (sourceRef) {
      resolvedSource = buildRefSelector(sourceRef);
    } else if (sourceSelector) {
      resolvedSource = sourceSelector;
    } else {
      throw new Error('No source element specified. Use sourceRef or sourceSelector.');
    }

    // Resolve target: targetRef > targetSelector
    const targetRef = params['targetRef'] as string | undefined;
    const targetSelector = params['targetSelector'] as string | undefined;
    let resolvedTarget: string;
    if (targetRef) {
      resolvedTarget = buildRefSelector(targetRef);
    } else if (targetSelector) {
      resolvedTarget = targetSelector;
    } else {
      throw new Error('No target element specified. Use targetRef or targetSelector.');
    }

    const escapedSource = escapeForJsSingleQuote(resolvedSource);
    const escapedTarget = escapeForJsSingleQuote(resolvedTarget);

    const actionJs = `
      var source = document.querySelector('${escapedSource}');
      var target = document.querySelector('${escapedTarget}');
      if (!source) throw Object.assign(new Error('Source element not found'), { name: 'ELEMENT_NOT_FOUND' });
      if (!target) throw Object.assign(new Error('Target element not found'), { name: 'ELEMENT_NOT_FOUND' });

      var srcRect = source.getBoundingClientRect();
      var tgtRect = target.getBoundingClientRect();
      var startX = srcRect.x + srcRect.width/2, startY = srcRect.y + srcRect.height/2;
      var endX = tgtRect.x + tgtRect.width/2, endY = tgtRect.y + tgtRect.height/2;
      var numSteps = ${steps};

      source.dispatchEvent(new MouseEvent('mousedown', { clientX: startX, clientY: startY, bubbles: true }));

      for (var i = 1; i <= numSteps; i++) {
        var x = startX + (endX - startX) * i / numSteps;
        var y = startY + (endY - startY) * i / numSteps;
        var moveTarget = document.elementFromPoint(x, y);
        if (moveTarget) moveTarget.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y, bubbles: true }));
      }

      target.dispatchEvent(new MouseEvent('mouseup', { clientX: endX, clientY: endY, bubbles: true }));

      var dt = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
      target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true }));
      target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
      source.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));

      return {
        dragged: true,
        source: { tagName: source.tagName, id: source.id || undefined },
        target: { tagName: target.tagName, id: target.id || undefined },
      };
    `;

    // Auto-wait on source element only (the element being dragged)
    return this.waitAndExecute(tabUrl, resolvedSource, 'drag', actionJs, { timeout, force });
  }

  private async handleHandleDialog(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const autoHandle = params['autoHandle'] === true;
    const action = (params['action'] as string | undefined) ?? 'accept';
    const promptText = (params['promptText'] as string | undefined) ?? '';

    const escapedPromptText = escapeForJsSingleQuote(promptText);
    const escapedAction = escapeForJsSingleQuote(action);

    const js = `
      var autoHandle = ${autoHandle};
      var action = '${escapedAction}';
      var promptText = '${escapedPromptText}';

      if (!window.__safariPilotDialogs) {
        window.__safariPilotDialogs = {
          origAlert: window.alert,
          origConfirm: window.confirm,
          origPrompt: window.prompt,
          intercepted: [],
        };
      }

      if (!autoHandle) {
        // Restore native dialogs
        window.alert = window.__safariPilotDialogs.origAlert;
        window.confirm = window.__safariPilotDialogs.origConfirm;
        window.prompt = window.__safariPilotDialogs.origPrompt;
        return { status: 'restored', intercepted: window.__safariPilotDialogs.intercepted.length };
      }

      window.alert = function(message) {
        window.__safariPilotDialogs.intercepted.push({ type: 'alert', message: String(message), timestamp: Date.now() });
        // alert returns undefined — no-op
      };

      window.confirm = function(message) {
        window.__safariPilotDialogs.intercepted.push({ type: 'confirm', message: String(message), action: action, timestamp: Date.now() });
        return action === 'accept';
      };

      window.prompt = function(message, defaultValue) {
        window.__safariPilotDialogs.intercepted.push({ type: 'prompt', message: String(message), action: action, returnValue: action === 'accept' ? promptText : null, timestamp: Date.now() });
        return action === 'accept' ? promptText : null;
      };

      return { status: 'installed', action: action, promptText: promptText };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Handle dialog failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : { status: 'installed' }, Date.now() - start);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async handleScrollToElement(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string | undefined;
    if (!tabUrl) {
      const err = new Error('tabUrl is required');
      (err as Error & { code?: string }).code = 'INVALID_PARAMS';
      throw err;
    }
    const selector = params['selector'] as string | undefined;
    const text = params['text'] as string | undefined;
    const role = params['role'] as string | undefined;
    const name = params['name'] as string | undefined;
    if (!selector && !text && !role) {
      const err = new Error('At least one of {selector, text, role} is required');
      (err as Error & { code?: string }).code = 'INVALID_PARAMS';
      throw err;
    }
    const nth = (params['nth'] as number | undefined) ?? 0;
    const behavior = (params['behavior'] as string | undefined) ?? 'instant';

    const sentinel =
      '__SP_SCROLL_TO_ELEMENT__:' + JSON.stringify({ selector, text, role, name, nth, behavior });
    const result = await this.engine.executeJsInTab(tabUrl, sentinel, 30_000);
    if (!result.ok) {
      const err = new Error(result.error?.message ?? 'safari_scroll_to_element failed');
      if (result.error?.code) (err as Error & { code?: string }).code = result.error.code;
      throw err;
    }

    const parsed = result.value ? JSON.parse(result.value) : {};
    return {
      content: [{ type: 'text', text: JSON.stringify(parsed) }],
      metadata: { engine: 'extension' as Engine, degraded: false, latencyMs: Date.now() - start },
    };
  }

  private makeResponse(data: unknown, latencyMs: number = 0): ToolResponse {
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: { engine: 'applescript' as Engine, degraded: false, latencyMs },
    };
  }
}
