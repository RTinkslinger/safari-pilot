/**
 * Fixtures Validation — E2E Test Infrastructure Check
 *
 * Verifies that all HTML test fixtures and the canary deployment script
 * exist, are structurally sound, and are ready for use by E2E tests.
 *
 *  1. All fixture HTML files exist
 *  2. Each fixture has <!DOCTYPE html>
 *  3. form-test.html has a form with id="test-form"
 *  4. shadow-dom-test.html has the my-component custom element definition
 *  5. dialog-test.html has alert/confirm/prompt trigger buttons
 *  6. table-test.html has a table with exactly 3 data rows
 *  7. Canary install script exists and is executable
 */

import { describe, it, expect } from 'vitest';
import {
  readFileSync,
  existsSync,
  accessSync,
  constants,
} from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, '../fixtures');
const CANARY = resolve(__dirname, '../canary');

function fixture(name: string): string {
  return resolve(FIXTURES, name);
}

function readFixture(name: string): string {
  return readFileSync(fixture(name), 'utf8');
}

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// ── Fixture existence ─────────────────────────────────────────────────────────

describe('fixture files exist', () => {
  const fixtures = [
    'form-test.html',
    'shadow-dom-test.html',
    'dialog-test.html',
    'table-test.html',
  ];

  for (const name of fixtures) {
    it(`${name} is present`, () => {
      expect(existsSync(fixture(name))).toBe(true);
    });
  }
});

// ── DOCTYPE check ─────────────────────────────────────────────────────────────

describe('all fixtures are valid HTML documents', () => {
  const fixtures = [
    'form-test.html',
    'shadow-dom-test.html',
    'dialog-test.html',
    'table-test.html',
  ];

  for (const name of fixtures) {
    it(`${name} starts with <!DOCTYPE html>`, () => {
      const content = readFixture(name);
      expect(content.trimStart().toLowerCase()).toMatch(/^<!doctype html>/);
    });
  }
});

// ── form-test.html ────────────────────────────────────────────────────────────

describe('form-test.html structure', () => {
  let html: string;
  beforeAll(() => { html = readFixture('form-test.html'); });

  it('has a form with id="test-form"', () => {
    expect(html).toContain('id="test-form"');
  });

  it('has a text input with id="name"', () => {
    expect(html).toContain('id="name"');
  });

  it('has an email input with id="email"', () => {
    expect(html).toContain('id="email"');
  });

  it('has a select with id="role"', () => {
    expect(html).toContain('id="role"');
  });

  it('has a checkbox input with id="agree"', () => {
    expect(html).toContain('id="agree"');
  });

  it('has a submit button', () => {
    expect(html).toContain('type="submit"');
  });

  it('has a result div with id="result"', () => {
    expect(html).toContain('id="result"');
  });
});

// ── shadow-dom-test.html ──────────────────────────────────────────────────────

describe('shadow-dom-test.html structure', () => {
  let html: string;
  beforeAll(() => { html = readFixture('shadow-dom-test.html'); });

  it('has the <my-component> custom element tag', () => {
    expect(html).toContain('<my-component>');
  });

  it('defines the MyComponent class extending HTMLElement', () => {
    expect(html).toContain('class MyComponent extends HTMLElement');
  });

  it('registers the custom element via customElements.define', () => {
    expect(html).toContain("customElements.define('my-component'");
  });

  it('attaches a shadow root', () => {
    expect(html).toContain('attachShadow');
  });
});

// ── dialog-test.html ──────────────────────────────────────────────────────────

describe('dialog-test.html structure', () => {
  let html: string;
  beforeAll(() => { html = readFixture('dialog-test.html'); });

  it('has an alert trigger button with id="alert-btn"', () => {
    expect(html).toContain('id="alert-btn"');
    expect(html).toContain('alert(');
  });

  it('has a confirm trigger button with id="confirm-btn"', () => {
    expect(html).toContain('id="confirm-btn"');
    expect(html).toContain('confirm(');
  });

  it('has a prompt trigger button with id="prompt-btn"', () => {
    expect(html).toContain('id="prompt-btn"');
    expect(html).toContain('prompt(');
  });

  it('has result containers for confirm and prompt', () => {
    expect(html).toContain('id="confirm-result"');
    expect(html).toContain('id="prompt-result"');
  });
});

// ── table-test.html ───────────────────────────────────────────────────────────

describe('table-test.html structure', () => {
  let html: string;
  beforeAll(() => { html = readFixture('table-test.html'); });

  it('has a table with id="data-table"', () => {
    expect(html).toContain('id="data-table"');
  });

  it('has a thead with 3 column headers', () => {
    const thMatches = html.match(/<th>/g);
    expect(thMatches).not.toBeNull();
    expect(thMatches!.length).toBe(3);
  });

  it('has exactly 3 data rows in tbody', () => {
    // Count <tr> tags inside tbody (each row is one <tr>)
    const tbodyMatch = html.match(/<tbody>([\s\S]*?)<\/tbody>/i);
    expect(tbodyMatch).not.toBeNull();
    const trMatches = tbodyMatch![1].match(/<tr>/g);
    expect(trMatches).not.toBeNull();
    expect(trMatches!.length).toBe(3);
  });

  it('contains the expected row data (Alice, Bob, Carol)', () => {
    expect(html).toContain('Alice');
    expect(html).toContain('Bob');
    expect(html).toContain('Carol');
  });
});

// ── Canary install script ─────────────────────────────────────────────────────

describe('canary deployment test', () => {
  const scriptPath = resolve(CANARY, 'install-test.sh');

  it('install-test.sh exists', () => {
    expect(existsSync(scriptPath)).toBe(true);
  });

  it('install-test.sh is executable', () => {
    expect(isExecutable(scriptPath)).toBe(true);
  });

  it('install-test.sh has the shebang line', () => {
    const content = readFileSync(scriptPath, 'utf8');
    expect(content).toMatch(/^#!/);
  });

  it('install-test.sh verifies plugin.json, .mcp.json, dist/index.js, SKILL.md, README.md, LICENSE', () => {
    const content = readFileSync(scriptPath, 'utf8');
    expect(content).toContain('plugin.json');
    expect(content).toContain('.mcp.json');
    expect(content).toContain('dist/index.js');
    expect(content).toContain('SKILL.md');
    expect(content).toContain('README.md');
    expect(content).toContain('LICENSE');
  });

  it('install-test.sh checks that test/ dir is excluded from the package', () => {
    const content = readFileSync(scriptPath, 'utf8');
    expect(content).toContain('test/ excluded');
  });

  it('install-test.sh checks that daemon/Sources is excluded from the package', () => {
    const content = readFileSync(scriptPath, 'utf8');
    expect(content).toContain('daemon/Sources');
  });
});
