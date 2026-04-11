import type { ToolResponse, ToolRequirements } from '../types.js';
import type { AppleScriptEngine } from '../engines/applescript.js';
import type { Engine } from '../types.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}

type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;

export class InteractionTools {
  private engine: AppleScriptEngine;
  private handlers: Map<string, Handler> = new Map();

  constructor(engine: AppleScriptEngine) {
    this.engine = engine;
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
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  getDefinitions(): ToolDefinition[] {
    return [
      {
        name: 'safari_click',
        description:
          'Click an element identified by CSS selector. Dispatches full click event sequence (mousedown, mouseup, click).',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            selector: { type: 'string', description: 'CSS selector for the element to click' },
            shadowSelector: { type: 'string', description: 'Selector within Shadow DOM (extension-only)' },
            button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' },
            modifiers: { type: 'array', items: { type: 'string', enum: ['ctrl', 'shift', 'alt', 'meta'] } },
            waitForNavigation: { type: 'boolean', default: false },
            timeout: { type: 'number', default: 5000 },
          },
          required: ['tabUrl', 'selector'],
        },
        requirements: {},
      },
      {
        name: 'safari_double_click',
        description: 'Double-click an element. Often used to select text or trigger edit modes.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            selector: { type: 'string', description: 'CSS selector for the element to double-click' },
            timeout: { type: 'number', default: 5000 },
          },
          required: ['tabUrl', 'selector'],
        },
        requirements: {},
      },
      {
        name: 'safari_fill',
        description:
          'Fill a form input with text. Uses framework-aware filling for React, Vue, and Web Components. ' +
          'Clears existing value before typing.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            selector: { type: 'string', description: 'CSS selector for the input element' },
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
          required: ['tabUrl', 'selector', 'value'],
        },
        requirements: {},
      },
      {
        name: 'safari_select_option',
        description: 'Select an option from a <select> dropdown.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            selector: { type: 'string', description: 'Selector for the <select> element' },
            value: { type: 'string', description: 'Option value attribute' },
            label: { type: 'string', description: 'Option visible text' },
            index: { type: 'number', description: 'Option index' },
          },
          required: ['tabUrl', 'selector'],
        },
        requirements: {},
      },
      {
        name: 'safari_check',
        description: 'Check or uncheck a checkbox or radio button.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            selector: { type: 'string', description: 'CSS selector for the checkbox/radio' },
            checked: { type: 'boolean', description: 'true to check, false to uncheck' },
          },
          required: ['tabUrl', 'selector', 'checked'],
        },
        requirements: {},
      },
      {
        name: 'safari_hover',
        description: 'Hover over an element. Triggers CSS :hover states and mouseover/mouseenter events.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            selector: { type: 'string', description: 'CSS selector for the element to hover' },
            duration: { type: 'number', description: 'How long to hover in ms', default: 0 },
          },
          required: ['tabUrl', 'selector'],
        },
        requirements: {},
      },
      {
        name: 'safari_type',
        description:
          'Type text character by character with key events. Unlike fill, dispatches individual ' +
          'keydown/keypress/keyup events per character.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            selector: { type: 'string', description: 'CSS selector for the target element' },
            text: { type: 'string', description: 'Text to type' },
            delay: { type: 'number', description: 'Delay between keystrokes in ms', default: 50 },
          },
          required: ['tabUrl', 'selector', 'text'],
        },
        requirements: {},
      },
      {
        name: 'safari_press_key',
        description:
          'Press a keyboard key or key combination. Works globally (not targeted to an element) ' +
          'unless selector is provided.',
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
          },
          required: ['tabUrl', 'key'],
        },
        requirements: {},
      },
      {
        name: 'safari_scroll',
        description: 'Scroll the page or a specific element.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            selector: { type: 'string', description: 'Element to scroll. If omitted, scrolls the page.' },
            direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
            amount: { type: 'number', description: 'Pixels to scroll', default: 500 },
            toTop: { type: 'boolean' },
            toBottom: { type: 'boolean' },
            toElement: { type: 'string', description: 'Scroll until this selector is visible' },
          },
          required: ['tabUrl'],
        },
        requirements: {},
      },
      {
        name: 'safari_drag',
        description: 'Drag an element from one position to another.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Current URL of the tab' },
            sourceSelector: { type: 'string', description: 'CSS selector for the drag source element' },
            targetSelector: { type: 'string', description: 'CSS selector for the drag target element' },
            steps: { type: 'number', description: 'Number of intermediate mousemove steps', default: 10 },
          },
          required: ['tabUrl', 'sourceSelector', 'targetSelector'],
        },
        requirements: {},
      },
    ];
  }

  getHandler(name: string): Handler | undefined {
    return this.handlers.get(name);
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  private async handleClick(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const selector = params['selector'] as string;
    const timeout = typeof params['timeout'] === 'number' ? params['timeout'] : 5000;

    const escapedSelector = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const js = `
      var el = document.querySelector('${escapedSelector}');
      if (!el) throw Object.assign(new Error('Element not found: ${escapedSelector}'), { name: 'ELEMENT_NOT_FOUND' });
      if (el.offsetParent === null && getComputedStyle(el).display === 'none') throw Object.assign(new Error('Element not visible'), { name: 'ELEMENT_NOT_VISIBLE' });

      var rect = el.getBoundingClientRect();
      var opts = { bubbles: true, cancelable: true, view: window, clientX: rect.x + rect.width/2, clientY: rect.y + rect.height/2 };
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));

      return {
        clicked: true,
        element: {
          tagName: el.tagName,
          id: el.id || undefined,
          textContent: (el.textContent || '').slice(0, 100),
        }
      };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js, timeout);
    if (!result.ok) throw new Error(result.error?.message ?? 'Click failed');

    const data = result.value ? JSON.parse(result.value) : { clicked: true };
    return this.makeResponse(data, Date.now() - start);
  }

  private async handleDoubleClick(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const selector = params['selector'] as string;
    const timeout = typeof params['timeout'] === 'number' ? params['timeout'] : 5000;

    const escapedSelector = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const js = `
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

    const result = await this.engine.executeJsInTab(tabUrl, js, timeout);
    if (!result.ok) throw new Error(result.error?.message ?? 'Double click failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : { clicked: true }, Date.now() - start);
  }

  private async handleFill(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const selector = params['selector'] as string;
    const value = params['value'] as string;
    const framework = (params['framework'] as string | undefined) ?? 'auto';
    const clearFirst = params['clearFirst'] !== false;
    const pressEnterAfter = params['pressEnterAfter'] === true;
    const timeout = typeof params['timeout'] === 'number' ? params['timeout'] : 10000;

    const escapedSelector = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const escapedValue = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    const js = `
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

    const result = await this.engine.executeJsInTab(tabUrl, js, timeout);
    if (!result.ok) throw new Error(result.error?.message ?? 'Fill failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : { filled: true }, Date.now() - start);
  }

  private async handleSelectOption(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const selector = params['selector'] as string;
    const value = params['value'] as string | undefined;
    const label = params['label'] as string | undefined;
    const index = params['index'] as number | undefined;

    const escapedSelector = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    const js = `
      var el = document.querySelector('${escapedSelector}');
      if (!el) throw Object.assign(new Error('Element not found'), { name: 'ELEMENT_NOT_FOUND' });
      if (el.tagName !== 'SELECT') throw new Error('Element is not a <select>');

      var option;
      ${value !== undefined ? `option = Array.from(el.options).find(function(o) { return o.value === '${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'; });` : ''}
      ${label !== undefined ? `if (!option) option = Array.from(el.options).find(function(o) { return o.textContent.trim() === '${label.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'; });` : ''}
      ${index !== undefined ? `if (!option) option = el.options[${index}];` : ''}
      if (!option) throw Object.assign(new Error('Option not found'), { name: 'ELEMENT_NOT_FOUND' });

      el.value = option.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new Event('input', { bubbles: true }));

      return {
        selected: true,
        option: { value: option.value, label: option.textContent.trim(), index: option.index },
      };
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Select failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : { selected: true }, Date.now() - start);
  }

  private async handleCheck(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const selector = params['selector'] as string;
    const checked = params['checked'] as boolean;

    const escapedSelector = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const js = `
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

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Check failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : { toggled: true }, Date.now() - start);
  }

  private async handleHover(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const selector = params['selector'] as string;

    const escapedSelector = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const js = `
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

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Hover failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : { hovered: true }, Date.now() - start);
  }

  private async handleType(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const selector = params['selector'] as string;
    const text = params['text'] as string;

    const escapedSelector = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const escapedText = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

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

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Type failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : { typed: true }, Date.now() - start);
  }

  private async handlePressKey(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const key = params['key'] as string;
    const modifiers = (params['modifiers'] as string[] | undefined) ?? [];
    const selector = params['selector'] as string | undefined;

    const escapedKey = key.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const escapedSelector = selector ? selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'") : '';

    const js = `
      ${selector ? `var el = document.querySelector('${escapedSelector}'); if (el) el.focus();` : ''}
      var target = ${selector ? `(el || document.activeElement || document.body)` : 'document.activeElement || document.body'};
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

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Press key failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : { pressed: true }, Date.now() - start);
  }

  private async handleScroll(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const selector = params['selector'] as string | undefined;
    const direction = (params['direction'] as string | undefined) ?? 'down';
    const amount = typeof params['amount'] === 'number' ? params['amount'] : 500;
    const toTop = params['toTop'] === true;
    const toBottom = params['toBottom'] === true;
    const toElement = params['toElement'] as string | undefined;

    const escapedSelector = selector ? selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'") : '';
    const escapedToElement = toElement ? toElement.replace(/\\/g, '\\\\').replace(/'/g, "\\'") : '';

    const js = `
      var target = ${selector ? `document.querySelector('${escapedSelector}')` : 'document.documentElement'};
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

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Scroll failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : { scrolled: true }, Date.now() - start);
  }

  private async handleDrag(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const sourceSelector = params['sourceSelector'] as string;
    const targetSelector = params['targetSelector'] as string;
    const steps = typeof params['steps'] === 'number' ? params['steps'] : 10;

    const escapedSource = sourceSelector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const escapedTarget = targetSelector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    const js = `
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

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'Drag failed');

    return this.makeResponse(result.value ? JSON.parse(result.value) : { dragged: true }, Date.now() - start);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private makeResponse(data: unknown, latencyMs: number = 0): ToolResponse {
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: { engine: 'applescript' as Engine, degraded: false, latencyMs },
    };
  }
}
