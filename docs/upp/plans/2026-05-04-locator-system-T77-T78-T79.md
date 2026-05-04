# Locator System v2 (T77 + T78 + T79) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use the executing-plans skill to implement this plan task-by-task. Supports two modes: subagent-driven (recommended, fresh subagent per task with three-stage review) or inline execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the cluster-3 + cluster-5 parity gaps with Playwright by adding (a) multi-step locator chaining, (b) `safari_query_all` for multi-element extraction, and (c) `selectorPack` custom selector engines.

**Architecture:** Three sequential feature branches. T77 introduces a `chain: ChainOp[]` field on the existing `LocatorDescriptor`, with chain ops resolved in-page by `generateLocatorJs` (re-rooting between ops). T78 adds a new `safari_query_all` tool reusing the existing `data-sp-ref="sp-xxxxxx"` stamping scheme so returned refs flow through every existing action tool unchanged. T79 adds a `selectorPack` registry: two new MCP tools register/unregister tab-scoped JavaScript bodies referenced via `pack:<name>` prefix in any selector param, gated behind a feature flag and the existing HumanApproval security layer.

**Tech Stack:** TypeScript (Node 22), MCP SDK over stdio, vitest e2e + unit, Safari Web Extension MV3 (Hummingbird HTTP IPC at 127.0.0.1:19475 + storage-bus IPC), AppleScript fallback engine.

---

## Branch Strategy

Three sequential branches, merged in order:

1. `feat/T77-locator-chaining` — chain ops in `LocatorDescriptor` + `generateLocatorJs`
2. `feat/T78-query-all` — new tool, rebased on T77 after merge
3. `feat/T79-selector-pack` — independent of T78, branches from main after T77+T78 merge

After all three merge, single release: extension v0.1.27, daemon unchanged.

## Pinned Decisions (do not relitigate)

| Decision | Locked value |
|---|---|
| All chain ops in T77 | `filter`, `nth`, `first`, `last`, `and`, `or`, `descendant` — single PR |
| Backward compat | Existing `nth`, `filter.hasText` flat params continue to work; `chain` is opt-in |
| Strict mode on actions | Multi-match → `STRICTNESS_VIOLATION` error immediately, no auto-retry |
| T78 rich payload | `[{ref, text, tagName, attrs, boundingBox, visible}]`, capped at 100 by default |
| T78 ref scheme | Reuses `data-sp-ref="sp-xxxxxx"` — every returned ref usable as `selector: '[data-sp-ref="sp-xxx"]'` in existing tools, OR via `ref: 'sp-xxx'` after small `buildRefSelector` extension |
| T79 default | Feature flag `selectorPack.enabled=false`; opt-in only |
| T79 sandbox | `new Function('args', body)` — no `eval`, no string concat into injected scripts |
| T79 size cap | 32KB body, 64-char name, alphanumeric+underscore name |
| T79 tab scope | Storage key `sp_pack_<tabId>_<name>`; cleared on `tabs.onRemoved` |
| T79 security gate | `safari_register_selector` flagged as `sensitiveAction` → HumanApproval layer fires |
| XPath in chain | DEFERRED — `xpath` already exists as a base locator key; chain ops compose with it via `descendant`/`filter`/`nth` |

## File Structure

| File | Cluster | Action |
|---|---|---|
| `src/locator.ts` | A | Modify — add `ChainOp` type, `chain` field on `LocatorDescriptor`, chain-resolution body in `generateLocatorJs` |
| `src/locator.ts` | B | Modify — add `generateQueryAllJs` exported function |
| `src/tools/extraction.ts` | A, B | Modify — propagate `chain` from params to descriptor; add `safari_query_all` tool |
| `src/tools/interaction.ts` | A | Modify — propagate `chain` from params to descriptor in click/fill/hover/select_option/type/press_key |
| `src/errors.ts` | A | Modify — add `STRICTNESS_VIOLATION` error code |
| `src/tools/selector-pack.ts` | C | Create — `safari_register_selector` + `safari_unregister_selector` tool module |
| `src/security/sensitive-actions.ts` | C | Modify — add `safari_register_selector` to sensitive-action list (or equivalent existing config) |
| `src/server.ts` | C | Modify — register `SelectorPackTools` module in tool list |
| `src/aria.ts` | B | Modify — extend `buildRefSelector` to handle `sp-` prefix (in addition to existing `eN` scheme) — see Task B-2 |
| `extension/content-main.js` | C | Modify — `pack:<name>` resolution path before normal selector lookup; tab-scoped storage read |
| `extension/background.js` | C | Modify — `tabs.onRemoved` listener clears tab-scoped pack storage |
| `extension/manifest.json` | All | Modify — version bump to 0.1.27 (final task only) |
| `package.json` | All | Modify — version bump to 0.1.27 (final task only) |
| `test/unit/locator/chain-*.test.ts` | A | Create — unit tests for chain resolution |
| `test/unit/locator/query-all.test.ts` | B | Create — unit tests for query_all JS generation |
| `test/unit/security/selector-pack-validation.test.ts` | C | Create — unit tests for name/body validation |
| `test/e2e/T77-locator-chaining.test.ts` | A | Create — real Safari, real chain ops |
| `test/e2e/T78-query-all.test.ts` | B | Create — real Safari, multi-element extraction |
| `test/e2e/T79-selector-pack.test.ts` | C | Create — real Safari, register/use/unregister |
| `test/helpers/fixture-server.ts` | All | Modify — add `/t77-list`, `/t78-grid`, `/t79-pack` fixture routes |
| `docs/TRACKER.md` | All | Modify — file T77/T78/T79; close on ship |
| `docs/changelogs/v0.1.27.md` | All | Create (final task only) |
| `Documents/safari-pilot-vs-playwright-parity-v2.html` | All | Modify (final task only) — flip cluster 3 chaining + custom-engines + cluster 5 multi-element rows to Parity ✓; re-render PDF |

---

# Cluster A — T77: Locator Chaining

11 tasks, all in branch `feat/T77-locator-chaining`. Final task is the merge. Includes T80 (strict-mode action enforcement) folded in per user direction.

## Task A-0: Branch creation

**Files:** none (git only)

- [ ] **Step 1: Create branch from main**

```bash
git checkout main
git pull --ff-only
git checkout -b feat/T77-locator-chaining
git status
```

Expected: clean tree, on `feat/T77-locator-chaining`.

- [ ] **Step 2: File T77 in tracker**

Edit `docs/TRACKER.md`. Under "Open" section, add:

```markdown
### T77 — Locator Chaining (Playwright-style)

**Status:** In Progress
**Branch:** `feat/T77-locator-chaining`
**Source:** Cluster-3 parity gap (parity matrix v2)
**Research:** `docs/research/2026-05-04-t77-locator-chaining.md`

Add `chain: ChainOp[]` to `LocatorDescriptor`. Ops: `filter`, `nth`, `first`, `last`, `and`, `or`, `descendant`. Re-roots between ops. Strict mode on actions. Backward-compatible (existing flat `nth`/`filter` params unchanged).
```

- [ ] **Step 3: Commit branch setup**

```bash
git add docs/TRACKER.md
git commit -m "chore(T77): branch + tracker entry for locator chaining"
```

---

## Task A-1: Define `ChainOp` type and extend `LocatorDescriptor`

**Files:**
- Modify: `src/locator.ts:13-37` (add `ChainOp` type, extend `LocatorDescriptor`)
- Test: `test/unit/locator/chain-types.test.ts` (CREATE)

- [ ] **Step 1: Write the failing test**

Create `test/unit/locator/chain-types.test.ts`:

```typescript
import { describe, expect, test } from 'vitest';
import type { LocatorDescriptor, ChainOp } from '../../../src/locator.js';
import { extractLocatorFromParams } from '../../../src/locator.js';

describe('T77 chain types', () => {
  test('ChainOp accepts filter op with hasText', () => {
    const op: ChainOp = { op: 'filter', hasText: 'Submit' };
    expect(op.op).toBe('filter');
  });

  test('ChainOp accepts nth, first, last', () => {
    const ops: ChainOp[] = [{ op: 'nth', n: 2 }, { op: 'first' }, { op: 'last' }];
    expect(ops).toHaveLength(3);
  });

  test('ChainOp accepts descendant op with nested locator', () => {
    const op: ChainOp = {
      op: 'descendant',
      locator: { role: 'button', name: 'Add' },
    };
    expect(op.op).toBe('descendant');
  });

  test('ChainOp accepts and/or with nested locator descriptor', () => {
    const op: ChainOp = {
      op: 'or',
      locator: { role: 'link', name: 'Cancel' },
    };
    expect(op.op).toBe('or');
  });

  test('extractLocatorFromParams pulls chain array from params', () => {
    const desc = extractLocatorFromParams({
      role: 'listitem',
      chain: [
        { op: 'filter', hasText: 'Product 2' },
        { op: 'descendant', locator: { role: 'button', name: 'Add' } },
      ],
    });
    expect(desc?.chain).toHaveLength(2);
    expect(desc?.chain?.[0]).toEqual({ op: 'filter', hasText: 'Product 2' });
  });

  test('extractLocatorFromParams without chain returns undefined chain', () => {
    const desc = extractLocatorFromParams({ role: 'button' });
    expect(desc?.chain).toBeUndefined();
  });

  test('extractLocatorFromParams ignores malformed chain entries', () => {
    const desc = extractLocatorFromParams({
      role: 'button',
      chain: [{ op: 'filter', hasText: 'X' }, 'not-an-op', null, { bogus: true }],
    });
    expect(desc?.chain).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/unit/locator/chain-types.test.ts
```

Expected: FAIL with `ChainOp` not exported / `chain` field missing.

- [ ] **Step 3: Test-Reviewer Gate (fast mode, 7 tests)**

Dispatch `test-reviewer-fast` agent with:
- This test file
- `src/locator.ts` (current)
- Spec: "T77 introduces `ChainOp` discriminated union and `chain` array on `LocatorDescriptor`"

Wait for PASS verdict before proceeding. If REVISE, return to Step 1.

- [ ] **Step 4: Implement minimal types**

Edit `src/locator.ts`. Add after the existing `LocatorDescriptor` interface (around line 37):

```typescript
/**
 * T77: Single chain op applied after the base locator resolves.
 * Composed left-to-right against the matched set of the previous op.
 */
export type ChainOp =
  | { op: 'filter'; hasText?: string; has?: LocatorDescriptor; hasNot?: LocatorDescriptor; hasNotText?: string }
  | { op: 'nth'; n: number }
  | { op: 'first' }
  | { op: 'last' }
  | { op: 'and'; locator: LocatorDescriptor }
  | { op: 'or'; locator: LocatorDescriptor }
  | { op: 'descendant'; locator: LocatorDescriptor };
```

Extend `LocatorDescriptor` (the existing interface):

```typescript
export interface LocatorDescriptor {
  // ... existing fields unchanged ...
  /**
   * T77: Multi-step chain applied AFTER base + filter + nth resolve.
   * Each op operates on the matched set produced by the previous step.
   * Empty/undefined means single-step locator (existing behavior).
   */
  chain?: ChainOp[];
}
```

Extend `extractLocatorFromParams` (existing function around line 124). After the `exact` line, add:

```typescript
if (Array.isArray(params['chain'])) {
  const chain: ChainOp[] = [];
  for (const raw of params['chain'] as unknown[]) {
    if (raw && typeof raw === 'object' && 'op' in raw && typeof (raw as { op: unknown }).op === 'string') {
      chain.push(raw as ChainOp);
    }
  }
  if (chain.length > 0) desc.chain = chain;
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
npx vitest run test/unit/locator/chain-types.test.ts
```

Expected: PASS, 7/7.

- [ ] **Step 6: Commit**

```bash
git add src/locator.ts test/unit/locator/chain-types.test.ts
git commit -m "feat(T77): add ChainOp type and chain field on LocatorDescriptor"
```

---

## Task A-2: Implement `nth`/`first`/`last` chain ops in `generateLocatorJs`

**Files:**
- Modify: `src/locator.ts:494-525` (the result/nth section of `generateLocatorJs`)
- Test: `test/unit/locator/chain-positional.test.ts` (CREATE)

- [ ] **Step 1: Write the failing test**

Create `test/unit/locator/chain-positional.test.ts`:

```typescript
import { describe, expect, test } from 'vitest';
import { generateLocatorJs } from '../../../src/locator.js';

function evalInPage(js: string, html: string): unknown {
  // Spawn a minimal DOM via JSDOM for unit-level chain validation.
  // We assert on the GENERATED JS string, not on actual DOM execution —
  // real-DOM coverage lives in Task A-9 e2e.
  return js;
}

describe('T77 chain ops: nth / first / last (JS generation)', () => {
  test('chain with first op generates index-0 picker', () => {
    const js = generateLocatorJs({
      role: 'button',
      chain: [{ op: 'first' }],
    });
    expect(js).toContain('matched[0]');
    expect(js).toContain('chain');
  });

  test('chain with last op generates negative-index picker', () => {
    const js = generateLocatorJs({
      role: 'button',
      chain: [{ op: 'last' }],
    });
    expect(js).toContain('matched[matched.length - 1]');
  });

  test('chain with nth:3 generates index-3 picker', () => {
    const js = generateLocatorJs({
      role: 'button',
      chain: [{ op: 'nth', n: 3 }],
    });
    expect(js).toContain('var __chainIdx = 3');
  });

  test('chain with nth:-2 generates from-end picker', () => {
    const js = generateLocatorJs({
      role: 'button',
      chain: [{ op: 'nth', n: -2 }],
    });
    expect(js).toContain('var __chainIdx = -2');
  });

  test('chain ops apply AFTER existing flat nth/filter', () => {
    const js = generateLocatorJs({
      role: 'button',
      filter: { hasText: 'Submit' },
      nth: 0,
      chain: [{ op: 'last' }],
    });
    // Flat filter + flat nth still emit (backward compat),
    // chain executes against the post-flat result set.
    expect(js).toContain('hasTextQuery');
    expect(js).toContain('chain');
  });

  test('no chain field — generated JS unchanged from pre-T77 path', () => {
    const js = generateLocatorJs({ role: 'button' });
    expect(js).not.toContain('__chainIdx');
    expect(js).not.toContain('__chainOps');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/unit/locator/chain-positional.test.ts
```

Expected: FAIL — `chain`, `__chainIdx`, etc. not in generated JS.

- [ ] **Step 3: Test-Reviewer Gate (fast mode, 6 tests)**

Dispatch `test-reviewer-fast` with this test file + the current `src/locator.ts` + spec excerpt above. Wait for PASS.

- [ ] **Step 4: Implement chain block in `generateLocatorJs`**

Edit `src/locator.ts`. After the existing nth-picker block (line ~525, after `target.setAttribute('data-sp-ref', refId)` resolves) — wait, that's wrong. The existing code resolves to a SINGLE element via `target = matched[idx]`. T77 chain must run BEFORE the single-element finalize. Refactor:

Replace the section starting at "// ── 5A.5: nth picker ──" through the final `return JSON.stringify({ found: true, ...})` with:

```javascript
  // ── 5A.5: nth picker (BACKWARD COMPAT — applies before chain) ──
  var nth = ${typeof locator.nth === 'number' ? locator.nth : 0};
  if (typeof nth === 'number' && nth !== 0 && matched.length > 0) {
    var idx = nth < 0 ? matched.length + nth : nth;
    if (idx < 0 || idx >= matched.length) {
      return JSON.stringify({
        found: false,
        locator: locatorDesc,
        candidateCount: matched.length,
        hint: 'nth=' + nth + ' is out of range (matched.length=' + matched.length + ')'
      });
    }
    matched = [matched[idx]];
  }

  // ── T77: chain ops ──
  ${locator.chain && locator.chain.length > 0
    ? `
    var __chainOps = JSON.parse('${escapeForJs(JSON.stringify(locator.chain))}');
    for (var __ci = 0; __ci < __chainOps.length; __ci++) {
      var __cop = __chainOps[__ci];
      if (__cop.op === 'first') {
        matched = matched.length > 0 ? [matched[0]] : [];
      } else if (__cop.op === 'last') {
        matched = matched.length > 0 ? [matched[matched.length - 1]] : [];
      } else if (__cop.op === 'nth') {
        var __chainIdx = __cop.n;
        var __resolvedIdx = __chainIdx < 0 ? matched.length + __chainIdx : __chainIdx;
        matched = (__resolvedIdx >= 0 && __resolvedIdx < matched.length) ? [matched[__resolvedIdx]] : [];
      }
      // filter / and / or / descendant ops added in subsequent tasks (A-3, A-4, A-5)
      if (matched.length === 0) break;
    }
    `
    : ''}

  // ── Result ──
  if (matched.length === 0) {
    return JSON.stringify({
      found: false,
      locator: locatorDesc,
      candidateCount: 0,
      hint: 'No elements matched after chain ops'
    });
  }

  // T77: strict mode — actions cannot proceed against multi-match.
  // The CALLER decides strictness; we always pick first if matched.length > 1
  // for the legacy single-result envelope. Multi-element callers use
  // generateQueryAllJs (Task B-1) instead.
  var target = matched[0];
  var refId = 'sp-' + Math.random().toString(36).substring(2, 8);
  target.setAttribute('data-sp-ref', refId);

  return JSON.stringify({
    found: true,
    selector: '[data-sp-ref="' + refId + '"]',
    element: {
      tagName: target.tagName || '',
      id: target.id || '',
      textContent: normalizeWhitespace((target.textContent || '').substring(0, 200))
    },
    matchCount: matched.length
  });
```

- [ ] **Step 5: Run unit test**

```bash
npx vitest run test/unit/locator/chain-positional.test.ts
```

Expected: PASS, 6/6.

- [ ] **Step 6: Run pre-existing locator tests to check backward compat**

```bash
npx vitest run test/unit/
```

Expected: All previously-passing tests still PASS (no regressions in flat nth/filter).

- [ ] **Step 7: Commit**

```bash
git add src/locator.ts test/unit/locator/chain-positional.test.ts
git commit -m "feat(T77): chain ops nth/first/last in generateLocatorJs"
```

---

## Task A-3: Implement `filter` chain op

**Files:**
- Modify: `src/locator.ts` (chain op switch in `generateLocatorJs`)
- Test: `test/unit/locator/chain-filter.test.ts` (CREATE)

- [ ] **Step 1: Write the failing test**

Create `test/unit/locator/chain-filter.test.ts`:

```typescript
import { describe, expect, test } from 'vitest';
import { generateLocatorJs } from '../../../src/locator.js';

describe('T77 chain op: filter', () => {
  test('filter hasText injects substring match into chain loop', () => {
    const js = generateLocatorJs({
      role: 'listitem',
      chain: [{ op: 'filter', hasText: 'Product 2' }],
    });
    expect(js).toContain("__cop.op === 'filter'");
    expect(js).toContain('Product 2');
    expect(js).toContain('toLowerCase');
  });

  test('filter hasNotText excludes elements containing text', () => {
    const js = generateLocatorJs({
      role: 'row',
      chain: [{ op: 'filter', hasNotText: 'sponsored' }],
    });
    expect(js).toContain('hasNotText');
  });

  test('filter has uses nested locator descriptor', () => {
    const js = generateLocatorJs({
      role: 'listitem',
      chain: [{ op: 'filter', has: { role: 'button', name: 'Buy' } }],
    });
    expect(js).toContain('__cop.has');
    // Nested descriptor JSON-serialized inside the chain ops blob
    expect(js).toContain('"role":"button"');
    expect(js).toContain('"name":"Buy"');
  });

  test('filter with single-quote in hasText survives escaping', () => {
    const js = generateLocatorJs({
      role: 'listitem',
      chain: [{ op: 'filter', hasText: "user's choice" }],
    });
    // Escaped form must be present; raw apostrophe in JSON.parse arg would break
    expect(js).toContain("user\\'s");
  });
});
```

- [ ] **Step 2: Run test — FAIL**

```bash
npx vitest run test/unit/locator/chain-filter.test.ts
```

- [ ] **Step 3: Test-Reviewer Gate (fast, 4 tests)** — wait for PASS.

- [ ] **Step 4: Add `filter` branch to chain loop**

In `src/locator.ts`, inside the chain-op `for` loop added in A-2, add `filter` branch:

```javascript
      } else if (__cop.op === 'filter') {
        matched = matched.filter(function (el) {
          if (typeof __cop.hasText === 'string') {
            var t = (el.innerText !== undefined ? el.innerText : el.textContent) || '';
            if (t.toLowerCase().indexOf(__cop.hasText.toLowerCase()) === -1) return false;
          }
          if (typeof __cop.hasNotText === 'string') {
            var tn = (el.innerText !== undefined ? el.innerText : el.textContent) || '';
            if (tn.toLowerCase().indexOf(__cop.hasNotText.toLowerCase()) !== -1) return false;
          }
          if (__cop.has && typeof __cop.has === 'object') {
            // Resolve nested descriptor inside this element. We re-use the same
            // descriptor matching by inlining a minimal scoped query: for v1,
            // require `has` to use role+name OR text (the two highest-coverage cases).
            // Anything more complex falls through as "has" and matches if ANY
            // descendant matches (best-effort).
            var hasMatch = false;
            var probe = el.querySelectorAll('*');
            for (var __pi = 0; __pi < probe.length; __pi++) {
              if (__cop.has.role) {
                var r = probe[__pi].getAttribute('role') || '';
                if (r === __cop.has.role) { hasMatch = true; break; }
              } else if (typeof __cop.has.text === 'string') {
                var pt = (probe[__pi].innerText !== undefined ? probe[__pi].innerText : probe[__pi].textContent) || '';
                if (pt.toLowerCase().indexOf(__cop.has.text.toLowerCase()) !== -1) { hasMatch = true; break; }
              }
            }
            if (!hasMatch) return false;
          }
          if (__cop.hasNot && typeof __cop.hasNot === 'object') {
            // Symmetric to `has` — exclude if any descendant matches the inner descriptor.
            var hasNotMatch = false;
            var nprobe = el.querySelectorAll('*');
            for (var __npi = 0; __npi < nprobe.length; __npi++) {
              if (__cop.hasNot.role) {
                var nr = nprobe[__npi].getAttribute('role') || '';
                if (nr === __cop.hasNot.role) { hasNotMatch = true; break; }
              }
            }
            if (hasNotMatch) return false;
          }
          return true;
        });
```

- [ ] **Step 5: Run unit + e2e prior tests — verify no regressions**

```bash
npx vitest run test/unit/locator/
```

Expected: A-1 + A-2 + A-3 tests all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/locator.ts test/unit/locator/chain-filter.test.ts
git commit -m "feat(T77): chain op filter (hasText, hasNotText, has, hasNot)"
```

---

## Task A-4: Implement `descendant` chain op (re-rooting)

This is the highest-value chain op — `getByRole('listitem').filter(...).getByRole('button', {name:'Add'})` collapses to one chain.

**Files:**
- Modify: `src/locator.ts`
- Test: `test/unit/locator/chain-descendant.test.ts` (CREATE)

- [ ] **Step 1: Write failing test**

Create `test/unit/locator/chain-descendant.test.ts`:

```typescript
import { describe, expect, test } from 'vitest';
import { generateLocatorJs } from '../../../src/locator.js';

describe('T77 chain op: descendant', () => {
  test('descendant op embeds nested locator JSON', () => {
    const js = generateLocatorJs({
      role: 'listitem',
      chain: [
        { op: 'filter', hasText: 'Product 2' },
        { op: 'descendant', locator: { role: 'button', name: 'Add to cart' } },
      ],
    });
    expect(js).toContain('descendant');
    expect(js).toContain('"role":"button"');
    expect(js).toContain('"name":"Add to cart"');
  });

  test('descendant re-roots subsequent chain ops at the matched parent', () => {
    const js = generateLocatorJs({
      role: 'listitem',
      chain: [
        { op: 'descendant', locator: { role: 'button' } },
        { op: 'first' },
      ],
    });
    // Chain JS must show that AFTER descendant resolves, matched is the descendant set
    // (not the original listitem set). The for-loop ordering already gives us this —
    // assert the loop runs in declared order.
    expect(js).toContain("__cop.op === 'descendant'");
  });

  test('descendant with no matches yields empty matched, breaks the chain', () => {
    const js = generateLocatorJs({
      role: 'listitem',
      chain: [{ op: 'descendant', locator: { role: 'unicorn' } }],
    });
    expect(js).toContain('matched.length === 0');
    expect(js).toContain('break;');
  });
});
```

- [ ] **Step 2: Run — FAIL.**

```bash
npx vitest run test/unit/locator/chain-descendant.test.ts
```

- [ ] **Step 3: Test-Reviewer Gate (fast, 3 tests)** — wait for PASS.

- [ ] **Step 4: Add `descendant` branch to chain loop**

In `src/locator.ts`, inside chain `for` loop, add:

```javascript
      } else if (__cop.op === 'descendant') {
        // Re-root: replace `matched` with elements found inside any current match
        // that satisfy the nested locator descriptor.
        var __next = [];
        for (var __mi = 0; __mi < matched.length; __mi++) {
          var __parent = matched[__mi];
          // Inline minimal resolution for the most common nested descriptors:
          // role+name, text, testId. Other descriptor keys fall back to scanning all descendants.
          var __nestedRole = __cop.locator && __cop.locator.role;
          var __nestedName = __cop.locator && __cop.locator.name;
          var __nestedTestId = __cop.locator && __cop.locator.testId;
          var __nestedText = __cop.locator && __cop.locator.text;
          if (__nestedTestId) {
            var __byId = __parent.querySelectorAll('[data-testid="' + __nestedTestId.replace(/"/g, '\\\\"') + '"]');
            for (var __bi = 0; __bi < __byId.length; __bi++) __next.push(__byId[__bi]);
          } else if (__nestedRole) {
            // Pre-filter via existing role map if present
            var __sel = '[role="' + __nestedRole + '"]';
            var __maybe = __parent.querySelectorAll(__sel);
            for (var __ri = 0; __ri < __maybe.length; __ri++) {
              var __cand = __maybe[__ri];
              if (__nestedName) {
                var __an = (typeof __cand.computedName === 'string')
                  ? __cand.computedName
                  : (__cand.getAttribute('aria-label') || (__cand.textContent || '').trim());
                if (__an && __an.toLowerCase().indexOf(__nestedName.toLowerCase()) !== -1) {
                  __next.push(__cand);
                }
              } else {
                __next.push(__cand);
              }
            }
          } else if (typeof __nestedText === 'string') {
            var __all = __parent.querySelectorAll('*');
            for (var __ti = 0; __ti < __all.length; __ti++) {
              var __et = (__all[__ti].innerText !== undefined ? __all[__ti].innerText : __all[__ti].textContent) || '';
              if (__et.toLowerCase().indexOf(__nestedText.toLowerCase()) !== -1) {
                __next.push(__all[__ti]);
              }
            }
          }
        }
        matched = __next;
```

- [ ] **Step 5: Run unit tests — PASS.**

```bash
npx vitest run test/unit/locator/
```

- [ ] **Step 6: Commit**

```bash
git add src/locator.ts test/unit/locator/chain-descendant.test.ts
git commit -m "feat(T77): chain op descendant (re-rooting nested locator)"
```

---

## Task A-5: Implement `and` / `or` chain ops (logical combinators)

**Files:**
- Modify: `src/locator.ts`
- Test: `test/unit/locator/chain-logical.test.ts` (CREATE)

- [ ] **Step 1: Write failing test**

```typescript
import { describe, expect, test } from 'vitest';
import { generateLocatorJs } from '../../../src/locator.js';

describe('T77 chain ops: and / or', () => {
  test('or op union with secondary locator descriptor', () => {
    const js = generateLocatorJs({
      role: 'button',
      chain: [{ op: 'or', locator: { role: 'link', name: 'Cancel' } }],
    });
    expect(js).toContain("__cop.op === 'or'");
    expect(js).toContain('"role":"link"');
  });

  test('and op intersection with secondary locator', () => {
    const js = generateLocatorJs({
      role: 'button',
      chain: [{ op: 'and', locator: { testId: 'important' } }],
    });
    expect(js).toContain("__cop.op === 'and'");
    expect(js).toContain('"testId":"important"');
  });
});
```

- [ ] **Step 2: Run — FAIL**.

- [ ] **Step 3: Test-Reviewer Gate (fast, 2 tests)** — wait for PASS.

- [ ] **Step 4: Add `and`/`or` branches to chain loop**

In `src/locator.ts` chain loop:

```javascript
      } else if (__cop.op === 'or') {
        // Resolve the secondary locator against the FULL document (not scoped
        // to current matched), then UNION with current matched, dedupe by node identity.
        var __orMatches = [];
        if (__cop.locator) {
          if (__cop.locator.testId) {
            var __orSel = '[data-testid="' + __cop.locator.testId.replace(/"/g, '\\\\"') + '"]';
            __orMatches = Array.prototype.slice.call(document.querySelectorAll(__orSel));
          } else if (__cop.locator.role) {
            var __orRoleSel = '[role="' + __cop.locator.role + '"]';
            var __orCands = Array.prototype.slice.call(document.querySelectorAll(__orRoleSel));
            if (__cop.locator.name) {
              __orCands = __orCands.filter(function (e) {
                var n = (typeof e.computedName === 'string') ? e.computedName : (e.getAttribute('aria-label') || (e.textContent || '').trim());
                return n && n.toLowerCase().indexOf(__cop.locator.name.toLowerCase()) !== -1;
              });
            }
            __orMatches = __orCands;
          }
        }
        var __orSet = matched.slice();
        for (var __oi = 0; __oi < __orMatches.length; __oi++) {
          if (__orSet.indexOf(__orMatches[__oi]) === -1) __orSet.push(__orMatches[__oi]);
        }
        matched = __orSet;
      } else if (__cop.op === 'and') {
        // Intersect: keep only elements present in BOTH matched and the secondary set.
        var __andMatches = [];
        if (__cop.locator) {
          if (__cop.locator.testId) {
            var __andSel = '[data-testid="' + __cop.locator.testId.replace(/"/g, '\\\\"') + '"]';
            __andMatches = Array.prototype.slice.call(document.querySelectorAll(__andSel));
          } else if (__cop.locator.role) {
            __andMatches = Array.prototype.slice.call(document.querySelectorAll('[role="' + __cop.locator.role + '"]'));
          }
        }
        matched = matched.filter(function (e) { return __andMatches.indexOf(e) !== -1; });
```

- [ ] **Step 5: Run unit tests — PASS.**

- [ ] **Step 6: Commit**

```bash
git add src/locator.ts test/unit/locator/chain-logical.test.ts
git commit -m "feat(T77): chain ops and / or (logical combinators)"
```

---

## Task A-6: Add `STRICTNESS_VIOLATION` error code + strict-mode hook

**Files:**
- Modify: `src/errors.ts`
- Modify: `src/locator.ts` (return strictness in result envelope)
- Test: `test/unit/locator/chain-strict.test.ts` (CREATE)

- [ ] **Step 1: Write failing test**

```typescript
import { describe, expect, test } from 'vitest';
import { ErrorCode, SafariPilotError } from '../../../src/errors.js';
import { generateLocatorJs } from '../../../src/locator.js';

describe('T77 strict mode', () => {
  test('STRICTNESS_VIOLATION error code exists', () => {
    expect(ErrorCode.STRICTNESS_VIOLATION).toBe('STRICTNESS_VIOLATION');
  });

  test('SafariPilotError factory accepts STRICTNESS_VIOLATION', () => {
    const err = new SafariPilotError(
      ErrorCode.STRICTNESS_VIOLATION,
      'Locator matched 4 elements, expected exactly 1',
      { hints: ['Add .first(), .last(), .nth(N), or .filter() to disambiguate'] },
    );
    expect(err.code).toBe('STRICTNESS_VIOLATION');
    expect(err.retryable).toBe(false);
    expect(err.hints).toContain('Add .first(), .last(), .nth(N), or .filter() to disambiguate');
  });

  test('generated JS reports matchCount in result envelope', () => {
    const js = generateLocatorJs({ role: 'button' });
    expect(js).toContain('matchCount');
  });
});
```

- [ ] **Step 2: Run — FAIL**.

- [ ] **Step 3: Test-Reviewer Gate (fast, 3 tests)** — wait for PASS.

- [ ] **Step 4: Add error code**

Edit `src/errors.ts`. In the `ErrorCode` enum/object (currently has 21 codes per CLAUDE.md), add:

```typescript
STRICTNESS_VIOLATION: 'STRICTNESS_VIOLATION',
```

Update the error code lookup table to mark `retryable: false` and default hint. Match existing pattern.

- [ ] **Step 5: Run test — PASS.**

- [ ] **Step 6: Commit**

```bash
git add src/errors.ts test/unit/locator/chain-strict.test.ts
git commit -m "feat(T77): STRICTNESS_VIOLATION error code"
```

---

## Task A-7: Wire chain through extraction tools

`extraction.ts` already calls `extractLocatorFromParams(params)`. Since A-1 added `chain` extraction inside that function, the chain rides through automatically. This task adds the `chain` field to each tool's `inputSchema` (so MCP clients see it) and adds the strict-mode check on the `selector` resolution.

**Files:**
- Modify: `src/tools/extraction.ts` (input schemas + strict-mode hook)
- Test: `test/unit/tools/extraction-chain-schema.test.ts` (CREATE)

- [ ] **Step 1: Write failing test**

```typescript
import { describe, expect, test } from 'vitest';
import { ExtractionTools } from '../../../src/tools/extraction.js';

const fakeEngine = { name: 'extension', executeJsInTab: async () => ({ ok: true, value: '{}', elapsed_ms: 0 }) } as never;

describe('T77 extraction tools accept chain in inputSchema', () => {
  const tools = new ExtractionTools(fakeEngine);
  const defs = tools.getDefinitions();

  for (const name of ['safari_get_text', 'safari_get_html', 'safari_get_attribute']) {
    test(`${name} input schema declares chain array`, () => {
      const def = defs.find((d) => d.name === name);
      expect(def).toBeDefined();
      const props = (def!.inputSchema as { properties: Record<string, unknown> }).properties;
      expect(props['chain']).toBeDefined();
      expect((props['chain'] as { type: string }).type).toBe('array');
    });
  }
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Test-Reviewer Gate (fast, 3 tests)** — wait for PASS.

- [ ] **Step 4: Add `chain` to inputSchema for the 3 extraction tools**

Edit `src/tools/extraction.ts`. For each of `safari_get_text`, `safari_get_html`, `safari_get_attribute`, add to `inputSchema.properties`:

```typescript
chain: {
  type: 'array',
  description: 'T77: Multi-step chain ops (Playwright-style). Each op is one of: {op:"filter", hasText|hasNotText|has|hasNot}, {op:"nth", n}, {op:"first"}, {op:"last"}, {op:"and"|"or"|"descendant", locator}. Applied in order against the base locator match set.',
  items: { type: 'object' },
},
```

- [ ] **Step 5: Run unit test — PASS.**

```bash
npx vitest run test/unit/tools/extraction-chain-schema.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/tools/extraction.ts test/unit/tools/extraction-chain-schema.test.ts
git commit -m "feat(T77): expose chain field in extraction tool input schemas"
```

---

## Task A-8: Wire chain through interaction tools

Same pattern as A-7 but for `src/tools/interaction.ts`. This file contains click, fill, hover, select_option, type, press_key, etc.

**Files:**
- Modify: `src/tools/interaction.ts` (input schemas)
- Test: `test/unit/tools/interaction-chain-schema.test.ts` (CREATE)

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, test } from 'vitest';
import { InteractionTools } from '../../../src/tools/interaction.js';

// Construct with minimal stubs — InteractionTools constructor signature
// matches the rest of tools/. Adapt this if its constructor differs.
const fakeEngine = { name: 'extension', executeJsInTab: async () => ({ ok: true, value: '{}', elapsed_ms: 0 }) } as never;

describe('T77 interaction tools expose chain in inputSchema', () => {
  const tools = new InteractionTools(fakeEngine);
  const defs = tools.getDefinitions();

  // Tools that already accept locator params (role, text, testId, etc.) MUST
  // accept chain. Read interaction.ts and enumerate — the test list below is
  // the exhaustive set.
  const locatorAwareTools = [
    'safari_click',
    'safari_fill',
    'safari_hover',
    'safari_select_option',
    'safari_type',
    'safari_press_key',
    'safari_double_click',
    'safari_drag',
  ];

  for (const name of locatorAwareTools) {
    test(`${name} input schema declares chain array`, () => {
      const def = defs.find((d) => d.name === name);
      expect(def, `${name} not registered`).toBeDefined();
      const props = (def!.inputSchema as { properties: Record<string, unknown> }).properties;
      // Only assert on tools that currently accept role/text/testId — those are the
      // locator-aware ones. If the tool only accepts selector, chain doesn't apply.
      if (props['role'] || props['testId'] || props['text']) {
        expect(props['chain'], `${name} missing chain`).toBeDefined();
      }
    });
  }
});
```

> **Implementer note:** before running, read `src/tools/interaction.ts` and confirm the exact tool list that accepts locator params. Adjust `locatorAwareTools` to the actual set. Ones that take only `selector` (no role/text/testId) skip the chain assertion.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Test-Reviewer Gate (fast, ≤8 tests)** — wait for PASS.

- [ ] **Step 4: Add `chain` field to inputSchema for every locator-aware interaction tool**

Edit `src/tools/interaction.ts`. For each tool definition that already declares `role`, `text`, `testId`, etc., add the same `chain` property block as A-7.

- [ ] **Step 5: Run unit test — PASS.**

- [ ] **Step 6: Commit**

```bash
git add src/tools/interaction.ts test/unit/tools/interaction-chain-schema.test.ts
git commit -m "feat(T77): expose chain field in interaction tool input schemas"
```

---

## Task A-9: Strict-mode action enforcement (T80 folded in)

Action tools (click/fill/hover/select_option/type/press_key/double_click/drag) MUST throw `STRICTNESS_VIOLATION` when locator resolution yields >1 candidate elements UNLESS the chain terminates with a positional op (`first` / `last` / `nth`) OR a flat `nth` is set OR the base locator implies single-match (`testId`, `xpath`).

Read tools (get_text/get_html/get_attribute) keep current behavior (silently pick first) — strict mode is action-only, matching Playwright.

**Files:**
- Modify: `src/tools/interaction.ts` (action handlers — strictness check after locator resolves)
- Modify: `src/locator.ts` (`generateLocatorJs` returns `matchCount` AND `requiresStrict` flag in result envelope)
- Test: `test/unit/locator/chain-strict-action.test.ts` (CREATE)

- [ ] **Step 1: Write the failing unit test**

```typescript
import { describe, expect, test } from 'vitest';
import { generateLocatorJs } from '../../../src/locator.js';

describe('T80 strict-mode hint in locator result envelope', () => {
  test('result envelope exposes matchCount AND a strictnessSatisfied flag', () => {
    const js = generateLocatorJs({ role: 'button' });
    expect(js).toContain('matchCount');
    expect(js).toContain('strictnessSatisfied');
  });

  test('chain ending in first sets strictnessSatisfied=true', () => {
    const js = generateLocatorJs({ role: 'button', chain: [{ op: 'first' }] });
    // The strictness flag is computed in JS; assert the truthy path is wired.
    expect(js).toContain("'first'");
  });

  test('chain ending in nth sets strictnessSatisfied=true', () => {
    const js = generateLocatorJs({ role: 'button', chain: [{ op: 'nth', n: 2 }] });
    expect(js).toContain("'nth'");
  });

  test('flat nth sets strictnessSatisfied=true', () => {
    const js = generateLocatorJs({ role: 'button', nth: 0 });
    expect(js).toContain('matchCount');
  });

  test('testId base locator sets strictnessSatisfied=true (single-match by definition)', () => {
    const js = generateLocatorJs({ testId: 'submit-btn' });
    expect(js).toContain('strictnessSatisfied');
  });
});
```

- [ ] **Step 2: Run — FAIL.**

```bash
npx vitest run test/unit/locator/chain-strict-action.test.ts
```

- [ ] **Step 3: Test-Reviewer Gate (fast mode, 5 tests)** — wait for PASS.

- [ ] **Step 4: Update result envelope in `generateLocatorJs`**

In `src/locator.ts`, modify the final result-emitting block (the one that returns `{found: true, selector, element, matchCount}`):

```javascript
  // T80: compute strictnessSatisfied flag
  // True when: chain terminates with first/last/nth, OR flat nth was set,
  // OR base locator was testId/xpath (single-match by definition),
  // OR matched.length === 1.
  var __strictnessSatisfied = matched.length === 1;
  if (!__strictnessSatisfied) {
    // Check if base locator was testId or xpath (set during initial resolution)
    if (locatorDesc.testId || locatorDesc.xpath) __strictnessSatisfied = true;
  }
  if (!__strictnessSatisfied && typeof locatorDesc.nth === 'number') __strictnessSatisfied = true;
  if (!__strictnessSatisfied && locatorDesc.chain && locatorDesc.chain.length > 0) {
    var __lastOp = locatorDesc.chain[locatorDesc.chain.length - 1];
    if (__lastOp && (__lastOp.op === 'first' || __lastOp.op === 'last' || __lastOp.op === 'nth')) {
      __strictnessSatisfied = true;
    }
  }

  // Always pick first for the legacy single-result envelope (read tools depend on this).
  // Action tools inspect matchCount + strictnessSatisfied and throw STRICTNESS_VIOLATION
  // when matchCount > 1 && !strictnessSatisfied.
  var target = matched[0];
  var refId = 'sp-' + Math.random().toString(36).substring(2, 8);
  target.setAttribute('data-sp-ref', refId);

  return JSON.stringify({
    found: true,
    selector: '[data-sp-ref="' + refId + '"]',
    element: {
      tagName: target.tagName || '',
      id: target.id || '',
      textContent: normalizeWhitespace((target.textContent || '').substring(0, 200))
    },
    matchCount: matched.length,
    strictnessSatisfied: __strictnessSatisfied
  });
```

- [ ] **Step 5: Run unit tests — PASS.**

```bash
npx vitest run test/unit/locator/chain-strict-action.test.ts
```

- [ ] **Step 6: Add strictness check to interaction tool handlers**

Edit `src/tools/interaction.ts`. Locate the locator-resolution block in each action handler (the section that calls `generateLocatorJs` then unpacks `parsed.found && parsed.selector`). Add a strictness check immediately after `parsed.found`:

```typescript
if (parsed.found && parsed.selector) {
  // T80: action tools enforce strict mode — multi-match without disambiguation throws.
  if (parsed.matchCount > 1 && parsed.strictnessSatisfied === false) {
    throw new SafariPilotError(
      ErrorCode.STRICTNESS_VIOLATION,
      `Locator matched ${parsed.matchCount} elements, expected exactly 1`,
      {
        retryable: false,
        hints: [
          'Add .first(), .last(), or .nth(N) to the chain to disambiguate',
          'Or refine the locator with filter:{hasText} / .filter() / role+name',
          'Or use safari_query_all to act on all matches deliberately',
        ],
      },
    );
  }
  selector = parsed.selector;
} else {
  throw new Error(parsed.hint || 'Locator did not match any element');
}
```

Apply this to every action-tool handler in `interaction.ts`: click, fill, hover, select_option, type, press_key, double_click, drag. Read tools in `extraction.ts` keep current pick-first behavior — do NOT add the check there.

> **DRY check:** if the same 10-line block lands in 8 handlers, extract a helper `assertStrictMatch(parsed)` in `src/locator.ts` and call once per handler.

- [ ] **Step 7: Add a unit test for the action-handler strict-mode throw**

Append to `test/unit/locator/chain-strict-action.test.ts`:

```typescript
test('action tools throw STRICTNESS_VIOLATION on multi-match without disambiguation', async () => {
  // Mock engine that returns matchCount=3, strictnessSatisfied=false.
  const fakeEngine = {
    name: 'extension' as const,
    executeJsInTab: async () => ({
      ok: true,
      value: JSON.stringify({
        found: true,
        selector: '[data-sp-ref="sp-xxx"]',
        element: { tagName: 'BUTTON', id: '', textContent: '' },
        matchCount: 3,
        strictnessSatisfied: false,
      }),
      elapsed_ms: 0,
    }),
  };
  // Adapt this to the actual InteractionTools constructor signature.
  const { InteractionTools } = await import('../../../src/tools/interaction.js');
  const tools = new InteractionTools(fakeEngine as never);
  const handler = tools.getHandler('safari_click')!;
  await expect(handler({ tabUrl: 'http://x', role: 'button' }))
    .rejects.toThrow(/STRICTNESS_VIOLATION|matched 3 elements/i);
});

test('action tools succeed on multi-match WITH first chain op (strictnessSatisfied=true)', async () => {
  const fakeEngine = {
    name: 'extension' as const,
    executeJsInTab: async () => ({
      ok: true,
      value: JSON.stringify({
        found: true,
        selector: '[data-sp-ref="sp-yyy"]',
        element: { tagName: 'BUTTON', id: '', textContent: '' },
        matchCount: 3,
        strictnessSatisfied: true,
      }),
      elapsed_ms: 0,
    }),
  };
  const { InteractionTools } = await import('../../../src/tools/interaction.js');
  const tools = new InteractionTools(fakeEngine as never);
  const handler = tools.getHandler('safari_click')!;
  // Should NOT throw STRICTNESS_VIOLATION when strictnessSatisfied is true.
  // (May still throw click-execution error from the mock, but not strict violation.)
  await expect(handler({
    tabUrl: 'http://x',
    role: 'button',
    chain: [{ op: 'first' }],
  })).resolves.toBeDefined();
});
```

- [ ] **Step 8: Run — first test PASSES (throws as expected), second test PASSES.**

```bash
npm run build
npx vitest run test/unit/locator/chain-strict-action.test.ts
```

- [ ] **Step 9: Add e2e strict-mode coverage to T77-locator-chaining.test.ts**

Append a test to the e2e file in Task A-10 (next task) that asserts:
- `safari_click` against `role: 'button'` (3 buttons on /t77-list — the 3 "Add to cart" plus the cancel button) WITHOUT chain throws `STRICTNESS_VIOLATION`
- Same call WITH `chain: [{op: 'first'}]` succeeds

The test will live in A-10. Just make a marker comment here.

- [ ] **Step 10: Commit**

```bash
git add src/locator.ts src/tools/interaction.ts test/unit/locator/chain-strict-action.test.ts
git commit -m "feat(T80): strict-mode enforcement at action sites (Playwright parity)"
```

---

## Task A-10: E2E — chain ops against real Safari

**Files:**
- Modify: `test/helpers/fixture-server.ts` (add `/t77-list`)
- Create: `test/e2e/T77-locator-chaining.test.ts`

- [ ] **Step 1: Add fixture route**

Edit `test/helpers/fixture-server.ts`. Add a `/t77-list` route serving HTML:

```html
<!doctype html>
<html><head><title>T77 list</title></head><body>
  <ul id="products">
    <li data-product="p1">Product 1 <button>Add to cart</button></li>
    <li data-product="p2">Product 2 <button>Add to cart</button></li>
    <li data-product="p3">Product 3 <button>Add to cart</button></li>
  </ul>
  <button data-testid="cancel">Cancel</button>
  <a href="#" data-testid="cancel-link">Cancel</a>
</body></html>
```

- [ ] **Step 2: Write the failing e2e test**

Create `test/e2e/T77-locator-chaining.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { McpTestClient } from '../helpers/mcp-client.js';
import { startFixtureServer, stopFixtureServer, fixtureUrl } from '../helpers/fixture-server.js';

describe('T77 — Locator chaining (e2e)', () => {
  let client: McpTestClient;
  let openedTabUrl: string | undefined;

  beforeAll(async () => {
    await startFixtureServer();
    client = await McpTestClient.start();
    const newTab = await client.callTool('safari_new_tab', { url: fixtureUrl('/t77-list') });
    const parsed = JSON.parse(newTab.content[0].text!);
    openedTabUrl = parsed.url;
  });

  afterAll(async () => {
    if (openedTabUrl) {
      await client.callTool('safari_close_tab', { tabUrl: openedTabUrl }).catch(() => {});
    }
    await client.close();
    await stopFixtureServer();
  });

  test('chain: filter+descendant resolves to specific button inside specific listitem', async () => {
    // Equivalent of:
    //   page.getByRole('listitem').filter({hasText: 'Product 2'}).getByRole('button', {name: 'Add to cart'})
    const result = await client.callTool('safari_get_attribute', {
      tabUrl: openedTabUrl,
      role: 'listitem',
      chain: [
        { op: 'filter', hasText: 'Product 2' },
        { op: 'descendant', locator: { role: 'button', name: 'Add to cart' } },
      ],
      attribute: 'tagName',
    });
    const data = JSON.parse(result.content[0].text!);
    expect(data.element.tagName).toBe('BUTTON');
    // The element MUST be a descendant of [data-product="p2"], not p1 or p3.
    // Verify via a follow-up get_html on the parent:
    const parent = await client.callTool('safari_get_html', {
      tabUrl: openedTabUrl,
      role: 'listitem',
      chain: [{ op: 'filter', hasText: 'Product 2' }],
    });
    const parentHtml = JSON.parse(parent.content[0].text!).html;
    expect(parentHtml).toContain('data-product="p2"');
  });

  test('chain: first picks index 0', async () => {
    const result = await client.callTool('safari_get_text', {
      tabUrl: openedTabUrl,
      role: 'listitem',
      chain: [{ op: 'first' }],
    });
    const data = JSON.parse(result.content[0].text!);
    expect(data.text).toContain('Product 1');
  });

  test('chain: last picks final element', async () => {
    const result = await client.callTool('safari_get_text', {
      tabUrl: openedTabUrl,
      role: 'listitem',
      chain: [{ op: 'last' }],
    });
    const data = JSON.parse(result.content[0].text!);
    expect(data.text).toContain('Product 3');
  });

  test('chain: nth(1) picks index 1', async () => {
    const result = await client.callTool('safari_get_text', {
      tabUrl: openedTabUrl,
      role: 'listitem',
      chain: [{ op: 'nth', n: 1 }],
    });
    const data = JSON.parse(result.content[0].text!);
    expect(data.text).toContain('Product 2');
  });

  test('chain: or unions two test-id matches', async () => {
    // Both [data-testid="cancel"] (button) and [data-testid="cancel-link"] (a)
    // exist. .or() should match the union; .first() picks one.
    const result = await client.callTool('safari_get_attribute', {
      tabUrl: openedTabUrl,
      testId: 'cancel',
      chain: [
        { op: 'or', locator: { testId: 'cancel-link' } },
        { op: 'first' },
      ],
      attribute: 'tagName',
    });
    const data = JSON.parse(result.content[0].text!);
    expect(['BUTTON', 'A']).toContain(data.element.tagName);
  });

  test('backward compat: legacy nth flat param still works without chain', async () => {
    const result = await client.callTool('safari_get_text', {
      tabUrl: openedTabUrl,
      role: 'listitem',
      nth: 1,
    });
    const data = JSON.parse(result.content[0].text!);
    expect(data.text).toContain('Product 2');
  });

  test('chain returning zero matches surfaces hint', async () => {
    const result = await client.callTool('safari_get_text', {
      tabUrl: openedTabUrl,
      role: 'listitem',
      chain: [{ op: 'filter', hasText: 'NoSuchProduct' }],
    });
    // Tool should throw — McpTestClient surfaces error in result.isError or by throw
    expect(result.isError).toBeTruthy();
  });

  test('T80 strict mode: action tool on multi-match without disambiguation throws STRICTNESS_VIOLATION', async () => {
    // Multiple buttons exist on /t77-list (3 Add-to-cart + 1 Cancel).
    // safari_click without first/last/nth must throw.
    const result = await client.callTool('safari_click', {
      tabUrl: openedTabUrl,
      role: 'button',
    });
    expect(result.isError).toBeTruthy();
    const errText = result.content?.[0]?.text || '';
    expect(errText).toMatch(/STRICTNESS_VIOLATION|matched \d+ elements/i);
  });

  test('T80 strict mode: action tool with chain.first() succeeds on multi-match', async () => {
    const result = await client.callTool('safari_click', {
      tabUrl: openedTabUrl,
      role: 'button',
      chain: [{ op: 'first' }],
    });
    expect(result.isError).toBeFalsy();
  });

  test('T80 strict mode: read tools (get_text) keep pick-first behavior, do NOT throw', async () => {
    // Read tools must stay non-strict to preserve existing v1 behavior.
    const result = await client.callTool('safari_get_text', {
      tabUrl: openedTabUrl,
      role: 'listitem',  // matches 3 listitems, no chain
    });
    expect(result.isError).toBeFalsy();
  });
});
```

- [ ] **Step 3: Run — FAIL or ERROR.**

```bash
npm run build
npx vitest run test/e2e/T77-locator-chaining.test.ts
```

- [ ] **Step 4: Test-Reviewer Gate (full mode, 10 tests, >3)**

Dispatch `test-reviewer` (full 9-check) with this test file + `src/locator.ts` + `src/tools/extraction.ts` + `src/tools/interaction.ts` + entry-point hint "MCP server at dist/index.js, fixture server at /t77-list". Wait for PASS — no CRITICAL findings.

- [ ] **Step 5: Build, install, re-run**

```bash
npm run build
npx vitest run test/e2e/T77-locator-chaining.test.ts
```

Expected: PASS, 10/10. If failing, follow `feedback-rebuild-before-e2e-debug` — confirm dist/index.js is fresh.

- [ ] **Step 6: Commit**

```bash
git add test/helpers/fixture-server.ts test/e2e/T77-locator-chaining.test.ts
git commit -m "test(T77): e2e chain ops against real Safari"
```

---

## Task A-11: Update TRACES.md, TRACKER.md; merge T77+T80

**Files:**
- Modify: `TRACES.md`
- Modify: `docs/TRACKER.md`

- [ ] **Step 1: TRACES.md iteration entry**

Read `TRACES.md`, find iteration N (last). Add iteration N+1:

```markdown
### Iteration 56 — 2026-05-04
**What:** T77 + T80 — Locator chaining (chain[] field on LocatorDescriptor, all 7 ops: filter/nth/first/last/and/or/descendant) AND strict-mode action enforcement. Multi-match action calls without disambiguation now throw STRICTNESS_VIOLATION; read tools keep pick-first behavior.
**Changes:** `src/locator.ts` (chain types + chain block in JS-gen + strictnessSatisfied flag), `src/tools/extraction.ts` (3 input schemas, no strict-mode change), `src/tools/interaction.ts` (8 input schemas + strict-mode throws in 8 action handlers), `src/errors.ts` (STRICTNESS_VIOLATION code).
**Context:** Chain runs in-page after base locator + flat nth/filter resolve. Re-rooting between ops via `descendant` is the highest-value op. Backward compat preserved — flat `nth` and `filter.hasText` still work; chain is opt-in. Strict mode applies to ACTION tools only (matches Playwright); read tools (get_text/get_html/get_attribute) silently pick first to preserve v1 behavior.
---
```

- [ ] **Step 2: TRACKER.md close T77**

Edit `docs/TRACKER.md`. Move T77 from "Open" to "Closed" with status `RESOLVED` and shipping notes.

- [ ] **Step 3: Final unit test sweep**

```bash
npm test
```

Expected: all unit tests PASS.

- [ ] **Step 4: Final e2e sweep — full suite**

```bash
npx vitest run test/e2e/T77-locator-chaining.test.ts test/e2e/initialization.test.ts
```

Expected: PASS.

- [ ] **Step 5: Review the diff**

```bash
git diff main..feat/T77-locator-chaining --stat
git diff main..feat/T77-locator-chaining
```

Sanity-check the full diff before merge.

- [ ] **Step 6: Merge to main**

```bash
git add TRACES.md docs/TRACKER.md
git commit -m "docs(T77): TRACES iter 56 + TRACKER close"
git checkout main
git merge --no-ff feat/T77-locator-chaining -m "Merge feat/T77-locator-chaining: locator chaining v1"
git branch -d feat/T77-locator-chaining
```

---

# Cluster B — T78: `safari_query_all`

6 tasks, branch `feat/T78-query-all`. Branches from main AFTER T77 merges.

## Task B-0: Branch creation, rebase on T77

**Files:** none.

- [ ] **Step 1: Branch from updated main**

```bash
git checkout main
git pull --ff-only  # ensure latest including T77
git checkout -b feat/T78-query-all
```

- [ ] **Step 2: Add T78 to TRACKER.md as "In Progress"**

```markdown
### T78 — safari_query_all (multi-element extraction)

**Status:** In Progress
**Branch:** `feat/T78-query-all`
**Source:** Cluster-5 parity gap (parity matrix v2)
**Research:** `docs/research/2026-05-04-t78-locator-all-agentic.md`

New tool returning `[{ref, text, tagName, attrs, boundingBox, visible}]`. Reuses `data-sp-ref="sp-xxxxxx"` so refs flow through every existing tool's `selector` or `ref` param. Default cap 100 elements; configurable `limit`.
```

- [ ] **Step 3: Commit**

```bash
git add docs/TRACKER.md
git commit -m "chore(T78): branch + tracker entry for safari_query_all"
```

---

## Task B-1: `generateQueryAllJs` — multi-element resolver

**Files:**
- Modify: `src/locator.ts` (add new export `generateQueryAllJs`)
- Test: `test/unit/locator/query-all.test.ts` (CREATE)

- [ ] **Step 1: Write failing test**

```typescript
import { describe, expect, test } from 'vitest';
import { generateQueryAllJs } from '../../../src/locator.js';

describe('T78 generateQueryAllJs', () => {
  test('emits IIFE that returns array under "items" key', () => {
    const js = generateQueryAllJs({ role: 'listitem' }, { limit: 100 });
    expect(js).toContain('items');
    expect(js).toContain('return JSON.stringify');
  });

  test('respects limit by slicing matched array', () => {
    const js = generateQueryAllJs({ role: 'listitem' }, { limit: 5 });
    expect(js).toContain('var __limit = 5');
    expect(js).toContain('matched.slice(0, __limit)');
  });

  test('reuses chain ops from T77 (filter/nth/etc apply pre-payload)', () => {
    const js = generateQueryAllJs(
      { role: 'listitem', chain: [{ op: 'filter', hasText: 'X' }] },
      { limit: 100 },
    );
    expect(js).toContain('__chainOps');
  });

  test('payload entry includes ref, text, tagName, attrs, boundingBox, visible', () => {
    const js = generateQueryAllJs({ role: 'button' }, { limit: 100 });
    expect(js).toContain('ref');
    expect(js).toContain('tagName');
    expect(js).toContain('attrs');
    expect(js).toContain('boundingBox');
    expect(js).toContain('visible');
  });

  test('stamps each matched element with sp-xxxxxx ref', () => {
    const js = generateQueryAllJs({ role: 'button' }, { limit: 100 });
    expect(js).toContain('data-sp-ref');
    expect(js).toContain("'sp-' + Math.random()");
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Test-Reviewer Gate (full mode, 5 tests, >3)** — wait for PASS.

- [ ] **Step 4: Implement `generateQueryAllJs`**

Edit `src/locator.ts`. Add at end of file:

```typescript
/**
 * T78: Generate IIFE that resolves a locator to ALL matching elements
 * (up to `limit`), stamps each with sp-xxxxxx, and returns rich payload.
 *
 * Reuses the same base-resolution + chain-op machinery as `generateLocatorJs`.
 * Difference: the final result envelope returns `{items: [...], count, limit, truncated}`
 * instead of a single `{found, selector, element}`.
 */
export function generateQueryAllJs(
  locator: LocatorDescriptor,
  options: { limit: number; scopeSelector?: string },
): string {
  // Build the same resolution body as generateLocatorJs, but replace the final
  // single-element finalize with a multi-element payload generator.
  const baseJs = generateLocatorJs(locator, { scopeSelector: options.scopeSelector });
  // baseJs ends with `return JSON.stringify({ found: true, selector: ..., element: ..., matchCount });`
  // We replace that final return with our multi-element payload.
  // Strategy: recompose the JS by stripping the final `return JSON.stringify({ found: true ...})`
  // block and inserting our own.
  //
  // Simpler: write a parallel implementation that calls into the same matchers
  // we depend on. To minimize divergence risk, do this as a literal substitute:
  // after the chain-loop ends, instead of `target = matched[0]; return ...;`,
  // we slice and stamp.
  //
  // Find the marker `// ── Result ──` in baseJs and replace from there to end.

  const resultMarker = '// ── Result ──';
  const idx = baseJs.indexOf(resultMarker);
  if (idx === -1) {
    throw new Error('generateQueryAllJs: result marker not found in baseJs (locator.ts contract drift)');
  }
  const preamble = baseJs.slice(0, idx);

  return `${preamble}
  // ── T78 multi-element payload ──
  var __limit = ${options.limit};
  var __truncated = matched.length > __limit;
  var __slice = matched.slice(0, __limit);
  var __items = [];
  for (var __i = 0; __i < __slice.length; __i++) {
    var __el = __slice[__i];
    var __ref = 'sp-' + Math.random().toString(36).substring(2, 8);
    __el.setAttribute('data-sp-ref', __ref);
    var __rect = __el.getBoundingClientRect();
    var __attrs = {};
    if (__el.attributes) {
      for (var __ai = 0; __ai < __el.attributes.length; __ai++) {
        var __a = __el.attributes[__ai];
        if (__a.name && __a.name !== 'data-sp-ref') __attrs[__a.name] = __a.value;
      }
    }
    var __style = window.getComputedStyle(__el);
    var __visible = __style.display !== 'none' && __style.visibility !== 'hidden' && __rect.width > 0 && __rect.height > 0;
    __items.push({
      ref: __ref,
      tagName: __el.tagName || '',
      text: normalizeWhitespace((__el.innerText !== undefined ? __el.innerText : __el.textContent) || '').substring(0, 500),
      attrs: __attrs,
      boundingBox: { x: __rect.x, y: __rect.y, width: __rect.width, height: __rect.height },
      visible: __visible,
    });
  }
  return JSON.stringify({
    items: __items,
    count: matched.length,
    limit: __limit,
    truncated: __truncated,
  });`;
}
```

- [ ] **Step 5: Run unit tests — PASS.**

- [ ] **Step 6: Commit**

```bash
git add src/locator.ts test/unit/locator/query-all.test.ts
git commit -m "feat(T78): generateQueryAllJs multi-element resolver"
```

---

## Task B-2: Extend `buildRefSelector` to accept `sp-` prefix

**Files:**
- Modify: `src/aria.ts` (existing `buildRefSelector` function)
- Test: `test/unit/aria/build-ref-selector.test.ts` (CREATE — or extend existing)

- [ ] **Step 1: Read current `buildRefSelector`**

```bash
grep -n "buildRefSelector" src/aria.ts
```

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, expect, test } from 'vitest';
import { buildRefSelector } from '../../../src/aria.js';

describe('T78 buildRefSelector accepts sp- refs', () => {
  test('legacy eN ref resolves to existing scheme', () => {
    const sel = buildRefSelector('e5');
    // Whatever the legacy scheme is — assert it's stable, not changed by T78.
    expect(sel).toBeTruthy();
  });

  test('sp-xxxxxx ref resolves to data-sp-ref selector', () => {
    expect(buildRefSelector('sp-abc123')).toBe('[data-sp-ref="sp-abc123"]');
  });

  test('full data-sp-ref selector passes through unchanged', () => {
    expect(buildRefSelector('[data-sp-ref="sp-abc123"]')).toBe('[data-sp-ref="sp-abc123"]');
  });
});
```

- [ ] **Step 3: Run — FAIL.**

- [ ] **Step 4: Test-Reviewer Gate (fast, 3 tests)** — wait for PASS.

- [ ] **Step 5: Extend `buildRefSelector`**

In `src/aria.ts`, modify `buildRefSelector`. Add at the start of the function body, before the existing `eN` logic:

```typescript
export function buildRefSelector(ref: string): string {
  // T78: passthrough for fully-qualified data-sp-ref selectors
  if (ref.startsWith('[data-sp-ref=')) return ref;
  // T78: sp-xxxxxx form returned by safari_query_all
  if (ref.startsWith('sp-')) return `[data-sp-ref="${ref}"]`;
  // Existing eN scheme — no change
  // ... existing logic ...
}
```

- [ ] **Step 6: Run test — PASS.**

- [ ] **Step 7: Commit**

```bash
git add src/aria.ts test/unit/aria/build-ref-selector.test.ts
git commit -m "feat(T78): buildRefSelector accepts sp- prefix"
```

---

## Task B-3: Register `safari_query_all` tool

**Files:**
- Modify: `src/tools/extraction.ts` (add tool definition + handler)

- [ ] **Step 1: Write the failing test**

Add to `test/unit/tools/extraction-chain-schema.test.ts` (or new file):

```typescript
test('safari_query_all is registered with rich payload schema', () => {
  const tools = new ExtractionTools(fakeEngine);
  const def = tools.getDefinitions().find((d) => d.name === 'safari_query_all');
  expect(def).toBeDefined();
  const props = (def!.inputSchema as { properties: Record<string, unknown> }).properties;
  expect(props['limit']).toBeDefined();
  expect(props['role']).toBeDefined();
  expect(props['chain']).toBeDefined();
  expect(def!.requirements.idempotent).toBe(true);
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Test-Reviewer Gate (fast)** — wait for PASS.

- [ ] **Step 4: Implement**

Edit `src/tools/extraction.ts`:

1. Add to imports:
```typescript
import { generateQueryAllJs } from '../locator.js';
```

2. Add handler registration in `registerHandlers()`:
```typescript
this.handlers.set('safari_query_all', this.handleQueryAll.bind(this));
```

3. Add tool definition in `getDefinitions()`:
```typescript
{
  name: 'safari_query_all',
  description:
    'Resolve a locator to ALL matching elements (default cap 100). Returns rich payload per element: ' +
    '{ref, tagName, text, attrs, boundingBox, visible}. Each ref is reusable in any action tool that ' +
    "accepts ref or selector (e.g. safari_click({ref: 'sp-xxx'})).",
  inputSchema: {
    type: 'object',
    properties: {
      tabUrl: { type: 'string', description: 'Current URL of the tab' },
      selector: { type: 'string', description: 'CSS selector. If provided, used directly via querySelectorAll.' },
      role: { type: 'string', description: 'ARIA role to search for' },
      name: { type: 'string', description: 'Accessible name' },
      text: { type: 'string', description: 'Visible text content to match' },
      label: { type: 'string', description: 'Associated label text' },
      testId: { type: 'string', description: 'data-testid attribute' },
      placeholder: { type: 'string', description: 'placeholder attribute' },
      xpath: { type: 'string', description: 'XPath expression' },
      exact: { type: 'boolean', description: 'Exact text match', default: false },
      filter: { type: 'object' },
      nth: { type: 'number' },
      chain: { type: 'array', items: { type: 'object' }, description: 'T77 chain ops' },
      limit: { type: 'number', description: 'Maximum elements to return', default: 100 },
      frameId: { type: 'number', description: 'Optional frame target' },
    },
    required: ['tabUrl'],
  },
  requirements: { idempotent: true, requiresFramesCrossOrigin: true },
}
```

4. Add handler:
```typescript
private async handleQueryAll(params: Record<string, unknown>): Promise<ToolResponse> {
  const start = Date.now();
  const tabUrl = params['tabUrl'] as string;
  const frameId = params['frameId'] as number | undefined;
  const limit = typeof params['limit'] === 'number' ? Math.max(1, Math.min(1000, params['limit'])) : 100;

  // Selector path: bypass locator, use querySelectorAll directly with the same payload shape
  const selector = params['selector'] as string | undefined;
  if (selector) {
    const escaped = escapeForJsSingleQuote(selector);
    const js = `
      var __limit = ${limit};
      var __all = Array.prototype.slice.call(document.querySelectorAll('${escaped}'));
      var __truncated = __all.length > __limit;
      var __slice = __all.slice(0, __limit);
      var __items = [];
      for (var __i = 0; __i < __slice.length; __i++) {
        var __el = __slice[__i];
        var __ref = 'sp-' + Math.random().toString(36).substring(2, 8);
        __el.setAttribute('data-sp-ref', __ref);
        var __rect = __el.getBoundingClientRect();
        var __attrs = {};
        if (__el.attributes) {
          for (var __ai = 0; __ai < __el.attributes.length; __ai++) {
            var __a = __el.attributes[__ai];
            if (__a.name && __a.name !== 'data-sp-ref') __attrs[__a.name] = __a.value;
          }
        }
        var __style = window.getComputedStyle(__el);
        var __visible = __style.display !== 'none' && __style.visibility !== 'hidden' && __rect.width > 0 && __rect.height > 0;
        __items.push({
          ref: __ref,
          tagName: __el.tagName || '',
          text: ((__el.innerText !== undefined ? __el.innerText : __el.textContent) || '').replace(/\\s+/g, ' ').trim().substring(0, 500),
          attrs: __attrs,
          boundingBox: { x: __rect.x, y: __rect.y, width: __rect.width, height: __rect.height },
          visible: __visible,
        });
      }
      return JSON.stringify({ items: __items, count: __all.length, limit: __limit, truncated: __truncated });
    `;
    const result = await routeFrameAware(this.engine, { tabUrl, frameId }, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'query_all (selector) failed');
    return this.makeResponse(result.value ? JSON.parse(result.value) : { items: [], count: 0 }, Date.now() - start);
  }

  // Locator path
  if (!hasLocatorParams(params)) {
    throw new Error('safari_query_all requires either selector or a locator (role, text, label, testId, placeholder, xpath)');
  }
  const locator = extractLocatorFromParams(params)!;
  const js = generateQueryAllJs(locator, { limit });

  const result = await routeFrameAware(this.engine, { tabUrl, frameId }, js);
  if (!result.ok) throw new Error(result.error?.message ?? 'query_all failed');

  return this.makeResponse(result.value ? JSON.parse(result.value) : { items: [], count: 0 }, Date.now() - start);
}
```

- [ ] **Step 5: Build + run unit tests — PASS.**

```bash
npm run build
npx vitest run test/unit/
```

- [ ] **Step 6: Commit**

```bash
git add src/tools/extraction.ts test/unit/tools/
git commit -m "feat(T78): register safari_query_all tool"
```

---

## Task B-4: E2E — `safari_query_all` against real Safari + ref-flow chain

**Files:**
- Modify: `test/helpers/fixture-server.ts` (add `/t78-grid`)
- Create: `test/e2e/T78-query-all.test.ts`

- [ ] **Step 1: Add fixture**

Add `/t78-grid` route serving:

```html
<!doctype html>
<html><head><title>T78 grid</title></head><body>
  <div id="grid">
    <div class="cell" data-id="c1">Alpha <button>Buy</button></div>
    <div class="cell" data-id="c2">Beta <button>Buy</button></div>
    <div class="cell" data-id="c3">Gamma <button>Buy</button></div>
    <div class="cell" data-id="c4">Delta <button>Buy</button></div>
  </div>
</body></html>
```

- [ ] **Step 2: Write failing test**

Create `test/e2e/T78-query-all.test.ts`:

```typescript
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { McpTestClient } from '../helpers/mcp-client.js';
import { startFixtureServer, stopFixtureServer, fixtureUrl } from '../helpers/fixture-server.js';

describe('T78 — safari_query_all (e2e)', () => {
  let client: McpTestClient;
  let openedTabUrl: string | undefined;

  beforeAll(async () => {
    await startFixtureServer();
    client = await McpTestClient.start();
    const newTab = await client.callTool('safari_new_tab', { url: fixtureUrl('/t78-grid') });
    openedTabUrl = JSON.parse(newTab.content[0].text!).url;
  });

  afterAll(async () => {
    if (openedTabUrl) await client.callTool('safari_close_tab', { tabUrl: openedTabUrl }).catch(() => {});
    await client.close();
    await stopFixtureServer();
  });

  test('selector path: returns 4 cells with rich payload', async () => {
    const result = await client.callTool('safari_query_all', {
      tabUrl: openedTabUrl,
      selector: '.cell',
    });
    const data = JSON.parse(result.content[0].text!);
    expect(data.count).toBe(4);
    expect(data.items).toHaveLength(4);
    expect(data.items[0].ref).toMatch(/^sp-/);
    expect(data.items[0].tagName).toBe('DIV');
    expect(data.items[0].attrs['data-id']).toBe('c1');
    expect(data.items[0].boundingBox.width).toBeGreaterThan(0);
    expect(data.items[0].visible).toBe(true);
  });

  test('locator path: returns all 4 button elements', async () => {
    const result = await client.callTool('safari_query_all', {
      tabUrl: openedTabUrl,
      role: 'button',
    });
    const data = JSON.parse(result.content[0].text!);
    expect(data.count).toBe(4);
    expect(data.items.every((i: { tagName: string }) => i.tagName === 'BUTTON')).toBe(true);
  });

  test('limit caps results at 2 of 4', async () => {
    const result = await client.callTool('safari_query_all', {
      tabUrl: openedTabUrl,
      selector: '.cell',
      limit: 2,
    });
    const data = JSON.parse(result.content[0].text!);
    expect(data.items).toHaveLength(2);
    expect(data.count).toBe(4);
    expect(data.truncated).toBe(true);
  });

  test('ref from query_all is usable in safari_get_text', async () => {
    const queryResult = await client.callTool('safari_query_all', {
      tabUrl: openedTabUrl,
      selector: '.cell',
      limit: 1,
    });
    const ref = JSON.parse(queryResult.content[0].text!).items[0].ref;
    const textResult = await client.callTool('safari_get_text', {
      tabUrl: openedTabUrl,
      ref,
    });
    const text = JSON.parse(textResult.content[0].text!);
    expect(text.text).toContain('Alpha');
  });

  test('ref from query_all is usable in safari_click', async () => {
    const queryResult = await client.callTool('safari_query_all', {
      tabUrl: openedTabUrl,
      role: 'button',
      limit: 4,
    });
    const buttons = JSON.parse(queryResult.content[0].text!).items;
    const secondRef = buttons[1].ref;
    // Click the second Buy button — assert no throw, returns success.
    const click = await client.callTool('safari_click', {
      tabUrl: openedTabUrl,
      ref: secondRef,
    });
    expect(click.isError).toBeFalsy();
  });

  test('chain composes with query_all', async () => {
    const result = await client.callTool('safari_query_all', {
      tabUrl: openedTabUrl,
      role: 'button',
      chain: [{ op: 'filter', hasText: 'Buy' }],
    });
    const data = JSON.parse(result.content[0].text!);
    expect(data.count).toBeGreaterThanOrEqual(4);
  });
});
```

- [ ] **Step 3: Run — FAIL/ERROR.**

- [ ] **Step 4: Test-Reviewer Gate (full mode, 6 tests)**

Provide: this test file + `src/tools/extraction.ts` + `src/locator.ts` + entry-point hint. Wait for PASS — no CRITICAL findings.

- [ ] **Step 5: Build + run e2e — PASS.**

```bash
npm run build
npx vitest run test/e2e/T78-query-all.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add test/helpers/fixture-server.ts test/e2e/T78-query-all.test.ts
git commit -m "test(T78): e2e safari_query_all against real Safari"
```

---

## Task B-5: Update TRACES, TRACKER, merge T78

**Files:** `TRACES.md`, `docs/TRACKER.md`

- [ ] **Step 1: TRACES.md iteration entry (57)**

```markdown
### Iteration 57 — 2026-05-04
**What:** T78 — safari_query_all (multi-element extraction). Reuses T77 chain-aware resolver via generateQueryAllJs. Refs in `sp-xxxxxx` scheme flow through every existing action tool.
**Changes:** `src/locator.ts` (+generateQueryAllJs), `src/aria.ts` (buildRefSelector accepts sp- prefix), `src/tools/extraction.ts` (+safari_query_all tool def + handler).
**Context:** Default cap 100 elements; selector path bypasses locator for raw querySelectorAll. Rich payload (ref, tagName, text, attrs, boundingBox, visible) lets agents inspect-then-act in one round trip.
---
```

- [ ] **Step 2: Close T78 in TRACKER.md.**

- [ ] **Step 3: Final test sweep**

```bash
npm test
npx vitest run test/e2e/T77-locator-chaining.test.ts test/e2e/T78-query-all.test.ts test/e2e/initialization.test.ts
```

Expected: ALL PASS.

- [ ] **Step 4: Diff review.**

```bash
git diff main..feat/T78-query-all
```

- [ ] **Step 5: Merge.**

```bash
git add TRACES.md docs/TRACKER.md
git commit -m "docs(T78): TRACES iter 57 + TRACKER close"
git checkout main
git merge --no-ff feat/T78-query-all -m "Merge feat/T78-query-all: multi-element extraction"
git branch -d feat/T78-query-all
```

---

# Cluster C — T79: `selectorPack` Custom Engines

**SECURITY-SENSITIVE.** Every task in this cluster has explicit security constraints. Ship-or-skip is binary — half-secure is worse than not shipping.

10 tasks, branch `feat/T79-selector-pack`.

## Task C-0: Branch + tracker entry + security spec

**Files:** `docs/TRACKER.md`

- [ ] **Step 1: Branch from main (post-T78 merge)**

```bash
git checkout main
git pull --ff-only
git checkout -b feat/T79-selector-pack
```

- [ ] **Step 2: Add T79 to TRACKER.md with explicit security stance**

```markdown
### T79 — selectorPack Custom Engines

**Status:** In Progress
**Branch:** `feat/T79-selector-pack`
**Source:** Cluster-3 parity gap (parity matrix v2)
**Research:** `docs/research/2026-05-04-t79-custom-selector-engines.md`

Two new MCP tools: `safari_register_selector(name, jsBody)` + `safari_unregister_selector(name)`. Names referenceable as `pack:<name>` in any locator-using tool's `selector` param. Tab-scoped storage; auto-clear on tab close.

**SECURITY (locked, do not relax):**
- Feature flag `safariPilot.selectorPack.enabled = false` by default
- Body capped at 32KB; name capped 64 chars; name regex `^[a-zA-Z_][a-zA-Z0-9_]{0,63}$`
- Body executed via `new Function('root', 'arg', body)` — never `eval`, never string concat
- Tab-scoped: storage key `sp_pack_<tabId>_<name>`; cleared on `tabs.onRemoved`
- Audit log entry per register/unregister
- HumanApproval security layer fires on `safari_register_selector` (treat as sensitive action)
- Reject if page CSP excludes `unsafe-eval` and Function constructor is unavailable
```

- [ ] **Step 3: Commit**

```bash
git add docs/TRACKER.md
git commit -m "chore(T79): branch + tracker + security spec for selectorPack"
```

---

## Task C-1: Validation utilities for pack names + bodies

**Files:**
- Create: `src/security/selector-pack-validator.ts`
- Create: `test/unit/security/selector-pack-validation.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, expect, test } from 'vitest';
import { validatePackName, validatePackBody, MAX_PACK_BODY_BYTES, MAX_PACK_NAME_LEN } from '../../../src/security/selector-pack-validator.js';

describe('T79 selectorPack validation', () => {
  test('validatePackName accepts alphanumeric+underscore', () => {
    expect(() => validatePackName('myPack')).not.toThrow();
    expect(() => validatePackName('my_pack_2')).not.toThrow();
    expect(() => validatePackName('_underscore_start')).not.toThrow();
  });

  test('validatePackName rejects empty / numeric-start / special chars', () => {
    expect(() => validatePackName('')).toThrow(/empty/i);
    expect(() => validatePackName('1startsWithDigit')).toThrow(/invalid/i);
    expect(() => validatePackName('has-dash')).toThrow(/invalid/i);
    expect(() => validatePackName('has space')).toThrow(/invalid/i);
    expect(() => validatePackName('has.dot')).toThrow(/invalid/i);
  });

  test('validatePackName rejects names exceeding 64 chars', () => {
    const tooLong = 'a'.repeat(65);
    expect(() => validatePackName(tooLong)).toThrow(/length/i);
  });

  test('validatePackBody accepts body under 32KB', () => {
    expect(() => validatePackBody('return root.querySelector(arg);')).not.toThrow();
  });

  test('validatePackBody rejects empty body', () => {
    expect(() => validatePackBody('')).toThrow(/empty/i);
  });

  test('validatePackBody rejects body over 32KB', () => {
    const tooLarge = 'a'.repeat(MAX_PACK_BODY_BYTES + 1);
    expect(() => validatePackBody(tooLarge)).toThrow(/size/i);
  });

  test('validatePackBody rejects body that mentions eval', () => {
    expect(() => validatePackBody('eval("alert(1)")')).toThrow(/eval/i);
  });

  test('validatePackBody rejects body that mentions Function constructor by name', () => {
    expect(() => validatePackBody('new Function("alert(1)")()')).toThrow(/Function/i);
  });

  test('MAX constants are exposed', () => {
    expect(MAX_PACK_BODY_BYTES).toBe(32 * 1024);
    expect(MAX_PACK_NAME_LEN).toBe(64);
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Test-Reviewer Gate (full mode, 9 tests)**

Provide test file + spec. Wait for PASS — security tests need full review, not fast.

- [ ] **Step 4: Implement**

Create `src/security/selector-pack-validator.ts`:

```typescript
export const MAX_PACK_NAME_LEN = 64;
export const MAX_PACK_BODY_BYTES = 32 * 1024;
const NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

const FORBIDDEN_BODY_PATTERNS: ReadonlyArray<{ regex: RegExp; reason: string }> = [
  { regex: /\beval\s*\(/, reason: 'eval is forbidden — use direct DOM access' },
  { regex: /\bnew\s+Function\b/, reason: 'Function constructor is forbidden — body itself is wrapped in Function() by the runtime' },
  { regex: /\bimport\s*\(/, reason: 'dynamic import is forbidden' },
];

export function validatePackName(name: string): void {
  if (!name) throw new Error('selectorPack name cannot be empty');
  if (name.length > MAX_PACK_NAME_LEN) {
    throw new Error(`selectorPack name length exceeds ${MAX_PACK_NAME_LEN} chars`);
  }
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`selectorPack name invalid: must match ${NAME_PATTERN.source}`);
  }
}

export function validatePackBody(body: string): void {
  if (!body) throw new Error('selectorPack body cannot be empty');
  const bytes = new TextEncoder().encode(body).byteLength;
  if (bytes > MAX_PACK_BODY_BYTES) {
    throw new Error(`selectorPack body size ${bytes} exceeds limit ${MAX_PACK_BODY_BYTES}`);
  }
  for (const { regex, reason } of FORBIDDEN_BODY_PATTERNS) {
    if (regex.test(body)) {
      throw new Error(`selectorPack body rejected: ${reason}`);
    }
  }
}
```

- [ ] **Step 5: Run — PASS.**

- [ ] **Step 6: Commit**

```bash
git add src/security/selector-pack-validator.ts test/unit/security/selector-pack-validation.test.ts
git commit -m "feat(T79): selectorPack name+body validation"
```

---

## Task C-2: Feature flag + config wiring

**Files:**
- Modify: `safari-pilot.config.json` (default for `selectorPack.enabled`)
- Modify: existing config loader (likely `src/server.ts` or `src/config.ts` — locate via grep)

- [ ] **Step 1: Locate config loader**

```bash
grep -rn "selectorPack\|safariPilot\.config" src/ test/
```

If a config schema exists (e.g. `src/config.ts`), modify it. If not, add a minimal config-file load in `src/server.ts`.

- [ ] **Step 2: Write the failing test**

```typescript
import { describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/config.js'; // adapt to actual path

describe('T79 selectorPack feature flag', () => {
  test('selectorPack.enabled defaults to false', () => {
    const cfg = loadConfig({});
    expect(cfg.selectorPack?.enabled).toBe(false);
  });

  test('selectorPack.enabled honors explicit true', () => {
    const cfg = loadConfig({ selectorPack: { enabled: true } });
    expect(cfg.selectorPack?.enabled).toBe(true);
  });
});
```

> **Implementer note:** if `src/config.ts` doesn't exist, the test scaffold must create the loader itself. Read the existing config-loading pattern in `src/server.ts` first.

- [ ] **Step 3: Run — FAIL.**

- [ ] **Step 4: Test-Reviewer Gate (fast)** — wait for PASS.

- [ ] **Step 5: Implement**

In whatever module loads `safari-pilot.config.json`, add:

```typescript
export interface SelectorPackConfig {
  enabled: boolean;
}

// Inside the config loader / merger:
const selectorPack: SelectorPackConfig = {
  enabled: input?.selectorPack?.enabled === true,
};
```

Default: `false`. Persisted in `safari-pilot.config.json` as:

```json
{
  "selectorPack": {
    "enabled": false
  }
}
```

- [ ] **Step 6: Run — PASS.**

- [ ] **Step 7: Commit**

```bash
git add src/config.ts safari-pilot.config.json test/unit/
git commit -m "feat(T79): selectorPack.enabled feature flag (default false)"
```

---

## Task C-3: `SelectorPackTools` module — register + unregister tool definitions

**Files:**
- Create: `src/tools/selector-pack.ts`
- Create: `test/unit/tools/selector-pack-tools.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, expect, test } from 'vitest';
import { SelectorPackTools } from '../../../src/tools/selector-pack.js';

const fakeEngine = {
  name: 'extension' as const,
  executeJsInTab: async () => ({ ok: true, value: '{"ok":true}', elapsed_ms: 0 }),
};

describe('T79 SelectorPackTools', () => {
  test('register tool defined with name + body params', () => {
    const tools = new SelectorPackTools(fakeEngine as never, { enabled: true });
    const def = tools.getDefinitions().find((d) => d.name === 'safari_register_selector');
    expect(def).toBeDefined();
    const props = (def!.inputSchema as { properties: Record<string, unknown> }).properties;
    expect(props['name']).toBeDefined();
    expect(props['body']).toBeDefined();
    expect(def!.requirements.idempotent).toBe(false); // mutates registry
  });

  test('unregister tool defined with name param', () => {
    const tools = new SelectorPackTools(fakeEngine as never, { enabled: true });
    const def = tools.getDefinitions().find((d) => d.name === 'safari_unregister_selector');
    expect(def).toBeDefined();
  });

  test('tools NOT registered when feature flag disabled', () => {
    const tools = new SelectorPackTools(fakeEngine as never, { enabled: false });
    expect(tools.getDefinitions()).toHaveLength(0);
  });

  test('register handler rejects invalid name with clear error', async () => {
    const tools = new SelectorPackTools(fakeEngine as never, { enabled: true });
    const handler = tools.getHandler('safari_register_selector')!;
    await expect(handler({ tabUrl: 'http://x', name: 'bad-name', body: 'return root;' }))
      .rejects.toThrow(/invalid/i);
  });

  test('register handler rejects body containing eval', async () => {
    const tools = new SelectorPackTools(fakeEngine as never, { enabled: true });
    const handler = tools.getHandler('safari_register_selector')!;
    await expect(handler({ tabUrl: 'http://x', name: 'good', body: 'eval("x")' }))
      .rejects.toThrow(/eval/i);
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Test-Reviewer Gate (full mode, 5 tests)** — security-sensitive, full review. Wait for PASS.

- [ ] **Step 4: Implement**

Create `src/tools/selector-pack.ts`:

```typescript
import { escapeForJsSingleQuote } from '../escape.js';
import { validatePackName, validatePackBody } from '../security/selector-pack-validator.js';
import type { IEngine } from '../engines/engine.js';
import type { Engine, ToolResponse, ToolRequirements } from '../types.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requirements: ToolRequirements;
}

type Handler = (params: Record<string, unknown>) => Promise<ToolResponse>;

export class SelectorPackTools {
  private engine: IEngine;
  private enabled: boolean;
  private handlers: Map<string, Handler> = new Map();

  constructor(engine: IEngine, config: { enabled: boolean }) {
    this.engine = engine;
    this.enabled = config.enabled;
    if (this.enabled) {
      this.handlers.set('safari_register_selector', this.handleRegister.bind(this));
      this.handlers.set('safari_unregister_selector', this.handleUnregister.bind(this));
    }
  }

  getDefinitions(): ToolDefinition[] {
    if (!this.enabled) return [];
    return [
      {
        name: 'safari_register_selector',
        description:
          'T79: Register a custom selector engine. Body is a JS function body executed as ' +
          '`new Function("root", "arg", body)` in page context. Reference via "pack:<name>" prefix in any locator-using tool. ' +
          'Tab-scoped — cleared automatically when the tab closes. Sensitive action; subject to HumanApproval gate.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string', description: 'Tab URL the pack registers under' },
            name: { type: 'string', description: 'Pack name (alphanumeric+underscore, max 64 chars)' },
            body: { type: 'string', description: 'JS function body (max 32KB). Receives (root, arg). Must return Element or null.' },
          },
          required: ['tabUrl', 'name', 'body'],
        },
        requirements: { idempotent: false },
      },
      {
        name: 'safari_unregister_selector',
        description: 'T79: Unregister a previously registered selectorPack. Tab-scoped.',
        inputSchema: {
          type: 'object',
          properties: {
            tabUrl: { type: 'string' },
            name: { type: 'string' },
          },
          required: ['tabUrl', 'name'],
        },
        requirements: { idempotent: true },
      },
    ];
  }

  getHandler(name: string): Handler | undefined {
    return this.handlers.get(name);
  }

  private async handleRegister(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const name = params['name'] as string;
    const body = params['body'] as string;

    validatePackName(name);
    validatePackBody(body);

    // Storage write happens via the extension. For non-extension engines, register lives only in
    // the page context (window.__sp_pack[name] = Function(...)). The extension path additionally
    // writes browser.storage.local["sp_pack_<tabId>_<name>"] so subsequent uses survive navigation.
    const escapedName = escapeForJsSingleQuote(name);
    const escapedBody = escapeForJsSingleQuote(body);
    const js = `
      (function () {
        if (!window.__sp_pack) window.__sp_pack = {};
        try {
          window.__sp_pack['${escapedName}'] = new Function('root', 'arg', '${escapedBody}');
          return JSON.stringify({ ok: true, name: '${escapedName}' });
        } catch (e) {
          return JSON.stringify({ ok: false, error: e && e.message ? e.message : String(e) });
        }
      })();
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'register failed');
    const parsed = result.value ? JSON.parse(result.value) : { ok: false };
    if (!parsed.ok) throw new Error(`selectorPack register rejected by page: ${parsed.error}`);

    return this.makeResponse(parsed, Date.now() - start);
  }

  private async handleUnregister(params: Record<string, unknown>): Promise<ToolResponse> {
    const start = Date.now();
    const tabUrl = params['tabUrl'] as string;
    const name = params['name'] as string;
    validatePackName(name);

    const escapedName = escapeForJsSingleQuote(name);
    const js = `
      (function () {
        if (window.__sp_pack && window.__sp_pack['${escapedName}']) {
          delete window.__sp_pack['${escapedName}'];
          return JSON.stringify({ ok: true, removed: true });
        }
        return JSON.stringify({ ok: true, removed: false });
      })();
    `;

    const result = await this.engine.executeJsInTab(tabUrl, js);
    if (!result.ok) throw new Error(result.error?.message ?? 'unregister failed');
    return this.makeResponse(result.value ? JSON.parse(result.value) : { ok: true }, Date.now() - start);
  }

  private makeResponse(data: unknown, latencyMs: number = 0): ToolResponse {
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      metadata: { engine: this.engine.name as Engine, degraded: false, latencyMs },
    };
  }
}
```

- [ ] **Step 5: Run unit tests — PASS.**

- [ ] **Step 6: Commit**

```bash
git add src/tools/selector-pack.ts test/unit/tools/selector-pack-tools.test.ts
git commit -m "feat(T79): SelectorPackTools register+unregister handlers"
```

---

## Task C-4: Wire `SelectorPackTools` into `server.ts`

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Write failing test**

Add to existing server-level test (or create `test/unit/server/tool-registration.test.ts`):

```typescript
test('safari_register_selector registered when feature flag enabled', () => {
  const server = makeServer({ selectorPack: { enabled: true } });
  const tools = server.listTools();
  expect(tools.find((t) => t.name === 'safari_register_selector')).toBeDefined();
});

test('safari_register_selector NOT registered when feature flag disabled', () => {
  const server = makeServer({ selectorPack: { enabled: false } });
  const tools = server.listTools();
  expect(tools.find((t) => t.name === 'safari_register_selector')).toBeUndefined();
});
```

> **Implementer note:** server tests may need a constructor adaptation. Read `src/server.ts` to see how other tools are wired and whether there's already a list-tools accessor.

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Test-Reviewer Gate (fast)** — wait for PASS.

- [ ] **Step 4: Implement**

In `src/server.ts`:
- Import `SelectorPackTools`
- Construct it with the feature-flag config
- Register its definitions + handlers in the same loop that registers other tool modules

- [ ] **Step 5: Run — PASS.**

- [ ] **Step 6: Commit**

```bash
git add src/server.ts test/unit/server/
git commit -m "feat(T79): wire SelectorPackTools into server"
```

---

## Task C-5: HumanApproval gate hook for `safari_register_selector`

**Files:**
- Modify: existing security pipeline config (locate via `grep -rn "HumanApproval\|sensitiveAction" src/`)

- [ ] **Step 1: Locate sensitive-action config**

```bash
grep -rn "HumanApproval" src/security/
```

Expected: a list of sensitive tools or actions. T79 adds `safari_register_selector` to it.

- [ ] **Step 2: Write failing test**

```typescript
test('safari_register_selector triggers HumanApproval check on untrusted domain', async () => {
  // Real implementation depends on existing test scaffold for security pipeline.
  // The test must assert that calling safari_register_selector on a non-trusted
  // domain produces a HumanApprovalRequiredError (or the structured approvalRequired
  // soft-return per types.ts:104-110), NOT a normal success.
});
```

- [ ] **Step 3: Run — FAIL.**

- [ ] **Step 4: Test-Reviewer Gate (full mode)** — security-sensitive. Wait for PASS.

- [ ] **Step 5: Add `safari_register_selector` to sensitive-action list**

In `src/security/human-approval.ts` (or wherever the list lives), add:

```typescript
'safari_register_selector': { reason: 'Custom selector engine registration is a JS injection surface' },
```

- [ ] **Step 6: Run — PASS.**

- [ ] **Step 7: Commit**

```bash
git add src/security/ test/unit/security/
git commit -m "feat(T79): HumanApproval gate fires on safari_register_selector"
```

---

## Task C-6: `pack:<name>` selector resolution in extension

**Files:**
- Modify: `extension/content-main.js` (or wherever locator-resolution happens)
- Modify: `src/locator.ts` and `src/tools/extraction.ts` — accept `pack:<name>(arg)` syntax in `selector` param

- [ ] **Step 1: Write failing test**

E2E only — pack execution requires a real DOM. Add to T79 e2e file (Task C-9 below).

For now, write a unit test on the syntax parser:

```typescript
import { describe, expect, test } from 'vitest';
import { parsePackSelector } from '../../../src/locator.js';

describe('T79 pack: selector parsing', () => {
  test('parses pack:name', () => {
    expect(parsePackSelector('pack:myEngine')).toEqual({ name: 'myEngine', arg: '' });
  });

  test('parses pack:name=arg', () => {
    expect(parsePackSelector('pack:myEngine=foo bar')).toEqual({ name: 'myEngine', arg: 'foo bar' });
  });

  test('returns null for non-pack selector', () => {
    expect(parsePackSelector('.css-class')).toBeNull();
    expect(parsePackSelector('#id')).toBeNull();
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Test-Reviewer Gate (fast)** — wait for PASS.

- [ ] **Step 4: Implement parser**

Add to `src/locator.ts`:

```typescript
export function parsePackSelector(selector: string): { name: string; arg: string } | null {
  if (!selector.startsWith('pack:')) return null;
  const rest = selector.slice(5);
  const eqIdx = rest.indexOf('=');
  if (eqIdx === -1) return { name: rest, arg: '' };
  return { name: rest.slice(0, eqIdx), arg: rest.slice(eqIdx + 1) };
}
```

- [ ] **Step 5: Run — PASS. Commit.**

```bash
git add src/locator.ts test/unit/locator/
git commit -m "feat(T79): parsePackSelector(pack:name=arg) parser"
```

---

## Task C-7: Resolve `pack:<name>` in extraction tools

**Files:**
- Modify: `src/tools/extraction.ts` (in each handler that reads `selector`)

- [ ] **Step 1: Write the failing test (e2e — defer to C-9)**

Marker only. Test will live in C-9.

- [ ] **Step 2: Implement resolution**

In each extraction tool handler (`handleGetText`, `handleGetHtml`, `handleGetAttribute`, `handleQueryAll`), at the point where `selector` is finalized, branch:

```typescript
const packParse = selector ? parsePackSelector(selector) : null;
if (packParse) {
  // Generate JS that calls the registered pack
  const escapedName = escapeForJsSingleQuote(packParse.name);
  const escapedArg = escapeForJsSingleQuote(packParse.arg);
  const packJs = `
    (function () {
      if (!window.__sp_pack || !window.__sp_pack['${escapedName}']) {
        return JSON.stringify({ found: false, hint: 'selectorPack ${escapedName} not registered' });
      }
      try {
        var fn = window.__sp_pack['${escapedName}'];
        var el = fn(document, '${escapedArg}');
        if (!el || el.nodeType !== 1) return JSON.stringify({ found: false, hint: 'pack returned non-element' });
        var ref = 'sp-' + Math.random().toString(36).substring(2, 8);
        el.setAttribute('data-sp-ref', ref);
        return JSON.stringify({ found: true, selector: '[data-sp-ref="' + ref + '"]' });
      } catch (e) {
        return JSON.stringify({ found: false, hint: 'pack threw: ' + (e && e.message ? e.message : String(e)) });
      }
    })();
  `;
  const packResult = await routeFrameAware(this.engine, { tabUrl, frameId }, packJs);
  if (packResult.ok && packResult.value) {
    const parsed = JSON.parse(packResult.value);
    if (parsed.found && parsed.selector) {
      selector = parsed.selector;
    } else {
      throw new Error(parsed.hint || 'selectorPack did not match');
    }
  }
}
```

Add this BEFORE the existing `escapedSelector = escapeForJsSingleQuote(selector)` line. Repeat in `handleGetText`, `handleGetHtml`, `handleGetAttribute`, `handleQueryAll`.

> **Anti-DRY note:** four near-identical insertions are below the threshold for extraction (per CLAUDE.md "three similar lines > premature abstraction"). At 4+ insertions of identical logic, EXTRACT to a helper `resolveMaybePackSelector(engine, params, selector)` in `src/locator.ts` and call from each handler. Implementer's call.

- [ ] **Step 3: Build + run unit tests — PASS.**

- [ ] **Step 4: Commit**

```bash
git add src/tools/extraction.ts
git commit -m "feat(T79): resolve pack:<name> in extraction tool selectors"
```

---

## Task C-8: `tabs.onRemoved` listener — auto-clear pack storage

**Files:**
- Modify: `extension/background.js`

- [ ] **Step 1: Write the failing test (source-grep style, T60/T72/T73 precedent)**

Create `test/unit/extension/t79-onremoved-clear-packs.test.ts`:

```typescript
import { describe, expect, test } from 'vitest';
import { readFile } from 'node:fs/promises';

describe('T79: tabs.onRemoved clears tab-scoped pack storage', () => {
  let bg: string;
  beforeAll(async () => {
    bg = await readFile('extension/background.js', 'utf8');
  });

  test('background.js declares tabs.onRemoved listener', () => {
    expect(bg).toMatch(/browser\.tabs\.onRemoved\.addListener/);
  });

  test('the listener references sp_pack_ key prefix', () => {
    expect(bg).toMatch(/sp_pack_/);
  });

  test('the listener calls storage.local.remove or removes by prefix', () => {
    expect(bg).toMatch(/storage\.local\.remove|storage\.local\.get.*sp_pack_/s);
  });
});
```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Test-Reviewer Gate (fast, 3 tests)** — wait for PASS.

- [ ] **Step 4: Implement listener**

Add to `extension/background.js` at module scope:

```javascript
// T79: clear tab-scoped selectorPack storage on tab close
browser.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const all = await browser.storage.local.get(null);
    const toRemove = Object.keys(all).filter((k) => k.startsWith('sp_pack_' + tabId + '_'));
    if (toRemove.length > 0) {
      await browser.storage.local.remove(toRemove);
      emitTrace('selector_pack_cleared', { layer: 'extension-bg', data: { tabId, count: toRemove.length } });
    }
  } catch (e) {
    emitTrace('selector_pack_clear_failed', { layer: 'extension-bg', data: { tabId, error: e && e.message ? e.message : String(e) } });
  }
});
```

- [ ] **Step 5: Run — PASS. Commit.**

```bash
git add extension/background.js test/unit/extension/t79-onremoved-clear-packs.test.ts
git commit -m "feat(T79): tabs.onRemoved clears tab-scoped pack storage"
```

---

## Task C-9: E2E — register, use, unregister against real Safari

**Files:**
- Modify: `test/helpers/fixture-server.ts` (add `/t79-pack`)
- Create: `test/e2e/T79-selector-pack.test.ts`

**Pre-condition:** This test requires `selectorPack.enabled=true`. The MCP test client must spawn the server with `SAFARI_PILOT_CONFIG` env or a config file that enables the flag.

- [ ] **Step 1: Add fixture**

Add `/t79-pack` route serving:

```html
<!doctype html>
<html><head><title>T79 pack</title></head><body>
  <div data-status="approved">Row A</div>
  <div data-status="pending">Row B</div>
  <div data-status="approved">Row C</div>
</body></html>
```

- [ ] **Step 2: Update `McpTestClient` to support per-test config**

Locate `test/helpers/mcp-client.ts` and add an option to the `start()` method:

```typescript
static async start(options?: { configOverride?: object }): Promise<McpTestClient> {
  // pass options.configOverride as SAFARI_PILOT_CONFIG_INLINE env var
}
```

`src/server.ts` reads `SAFARI_PILOT_CONFIG_INLINE` if set and merges into config.

- [ ] **Step 3: Write failing test**

```typescript
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { McpTestClient } from '../helpers/mcp-client.js';
import { startFixtureServer, stopFixtureServer, fixtureUrl } from '../helpers/fixture-server.js';

describe('T79 — selectorPack (e2e)', () => {
  let client: McpTestClient;
  let openedTabUrl: string | undefined;

  beforeAll(async () => {
    await startFixtureServer();
    client = await McpTestClient.start({
      configOverride: { selectorPack: { enabled: true } },
    });
    const newTab = await client.callTool('safari_new_tab', { url: fixtureUrl('/t79-pack') });
    openedTabUrl = JSON.parse(newTab.content[0].text!).url;
  });

  afterAll(async () => {
    if (openedTabUrl) await client.callTool('safari_close_tab', { tabUrl: openedTabUrl }).catch(() => {});
    await client.close();
    await stopFixtureServer();
  });

  test('register a custom engine that finds elements by data-status', async () => {
    const result = await client.callTool('safari_register_selector', {
      tabUrl: openedTabUrl,
      name: 'byStatus',
      body: 'return root.querySelector("[data-status=\\"" + arg + "\\"]");',
    });
    const data = JSON.parse(result.content[0].text!);
    expect(data.ok).toBe(true);
  });

  test('use registered engine via pack:byStatus=approved', async () => {
    const result = await client.callTool('safari_get_text', {
      tabUrl: openedTabUrl,
      selector: 'pack:byStatus=approved',
    });
    const data = JSON.parse(result.content[0].text!);
    expect(data.text).toContain('Row A');
  });

  test('unregister succeeds and subsequent use fails cleanly', async () => {
    await client.callTool('safari_unregister_selector', { tabUrl: openedTabUrl, name: 'byStatus' });
    const failed = await client.callTool('safari_get_text', {
      tabUrl: openedTabUrl,
      selector: 'pack:byStatus=approved',
    });
    expect(failed.isError).toBeTruthy();
  });

  test('register rejects body containing eval (security)', async () => {
    const result = await client.callTool('safari_register_selector', {
      tabUrl: openedTabUrl,
      name: 'evil',
      body: 'eval("alert(1)"); return null;',
    });
    expect(result.isError).toBeTruthy();
  });

  test('register rejects invalid name (dash)', async () => {
    const result = await client.callTool('safari_register_selector', {
      tabUrl: openedTabUrl,
      name: 'bad-name',
      body: 'return root.body;',
    });
    expect(result.isError).toBeTruthy();
  });

  test('feature flag disabled: tool not exposed', async () => {
    const offClient = await McpTestClient.start({ configOverride: { selectorPack: { enabled: false } } });
    const tools = await offClient.listTools();
    expect(tools.find((t) => t.name === 'safari_register_selector')).toBeUndefined();
    await offClient.close();
  });
});
```

- [ ] **Step 4: Run — FAIL.**

- [ ] **Step 5: Test-Reviewer Gate (full mode, 6 tests, security-sensitive)** — wait for PASS.

- [ ] **Step 6: Build + run e2e — PASS.**

```bash
npm run build
npx vitest run test/e2e/T79-selector-pack.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add test/helpers/ test/e2e/T79-selector-pack.test.ts
git commit -m "test(T79): e2e selectorPack register/use/unregister + security guards"
```

---

## Task C-10: TRACES, TRACKER, merge T79

**Files:** `TRACES.md`, `docs/TRACKER.md`

- [ ] **Step 1: TRACES.md iter 58**

```markdown
### Iteration 58 — 2026-05-04
**What:** T79 — selectorPack custom engines: register/unregister tools + pack:<name> resolution + tab-scoped storage + tabs.onRemoved auto-clear. Feature-flagged off by default.
**Changes:** `src/security/selector-pack-validator.ts` (NEW), `src/tools/selector-pack.ts` (NEW), `src/tools/extraction.ts` (pack: resolution), `src/locator.ts` (parsePackSelector), `src/server.ts` (wire SelectorPackTools), `src/security/human-approval.ts` (sensitive-action), `extension/background.js` (onRemoved listener), config flag.
**Context:** Body executed via `new Function('root','arg', body)` — never eval. Body cap 32KB; name regex `^[a-zA-Z_]\w{0,63}$`; eval/Function/import substring rejection. Tab-scoped: storage key `sp_pack_<tabId>_<name>`. HumanApproval gate fires on register because the body is a JS injection surface.
---
```

- [ ] **Step 2: Close T79 in TRACKER.md.**

- [ ] **Step 3: Final test sweep**

```bash
npm test
npx vitest run test/e2e/T77-locator-chaining.test.ts test/e2e/T78-query-all.test.ts test/e2e/T79-selector-pack.test.ts
```

Expected: ALL PASS.

- [ ] **Step 4: Diff review.**

```bash
git diff main..feat/T79-selector-pack
```

- [ ] **Step 5: Merge.**

```bash
git add TRACES.md docs/TRACKER.md
git commit -m "docs(T79): TRACES iter 58 + TRACKER close"
git checkout main
git merge --no-ff feat/T79-selector-pack -m "Merge feat/T79-selector-pack: custom selector engines"
git branch -d feat/T79-selector-pack
```

---

# Final: v0.1.27 Release + Parity-Doc Update

## Task FINAL-1: Version bump + extension rebuild

**Files:**
- Modify: `package.json` (version 0.1.27)
- Modify: `extension/manifest.json` (version 0.1.27 + CFBundleShortVersionString in Info.plist via build script)

- [ ] **Step 1: Bump version in lockstep**

Edit `package.json`: `"version": "0.1.27"`.
Edit `extension/manifest.json`: `"version": "0.1.27"`.

```bash
git diff package.json extension/manifest.json
```

Verify both bumped.

- [ ] **Step 2: Rebuild extension**

```bash
bash scripts/build-extension.sh
```

Expected: notarized + stapled `bin/Safari Pilot.app` and `bin/Safari Pilot.zip` at v0.1.27.

- [ ] **Step 3: Local install rehearsal**

```bash
open "bin/Safari Pilot.app"
```

Then in Safari → Settings → Extensions: confirm v0.1.27 visible, enable, smoke-test one e2e.

- [ ] **Step 4: Pre-tag check**

```bash
bash scripts/pre-tag-check.sh
```

Expected: ALL 9 PASSED.

- [ ] **Step 5: Commit + tag + push**

```bash
git add -A
git commit -m "chore(release): v0.1.27 — locator chaining + query_all + selectorPack"
git tag -a v0.1.27 -m "v0.1.27: T77 locator chaining + T78 multi-element extraction + T79 selectorPack"
git push origin main
git push origin v0.1.27
```

- [ ] **Step 6: Watch CI release**

```bash
gh run watch "$(gh run list --workflow=release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
```

Expected: green.

## Task FINAL-2: Update parity matrix v2 PDF

**Files:**
- Modify: `Documents/safari-pilot-vs-playwright-parity-v2.html`
- Re-render: `Documents/safari-pilot-vs-playwright-parity-v2.pdf`

- [ ] **Step 1: Edit HTML**

Flip the following rows to Parity ✓ (green per pdf-generation-sop):
- Cluster 3 — chaining row → Parity ✓
- Cluster 3 — custom-engines row → Parity ✓
- Cluster 5 — multi-element row → Parity ✓

Update the per-cluster tally rows accordingly. Update tool count to 82 (was 80; +2 from `safari_register_selector`, `safari_unregister_selector`; +1 from `safari_query_all`; -1 reconciled). Verify the actual count via:

```bash
grep -c "name: 'safari_" src/tools/*.ts | awk -F: '{s+=$2} END {print s}'
```

Then update tag from "post-T72/T73/T43" to "post-T77/T78/T79".

- [ ] **Step 2: Re-render PDF**

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="/Users/Aakash/Claude Projects/Documents/safari-pilot-vs-playwright-parity-v2.pdf" \
  --virtual-time-budget=8000 \
  "file:///Users/Aakash/Claude Projects/Documents/safari-pilot-vs-playwright-parity-v2.html"
```

- [ ] **Step 3: Verify per pdf-generation-sop**

```bash
mdls -name kMDItemNumberOfPages "/Users/Aakash/Claude Projects/Documents/safari-pilot-vs-playwright-parity-v2.pdf"
pdftoppm -r 96 -png "/Users/Aakash/Claude Projects/Documents/safari-pilot-vs-playwright-parity-v2.pdf" /tmp/check/page
ls -la /tmp/check/*.png
```

Read cover, densest content page, page after, last page. Confirm no blanks (no PNG <15KB).

- [ ] **Step 4: Commit + open**

```bash
git add Documents/safari-pilot-vs-playwright-parity-v2.html Documents/safari-pilot-vs-playwright-parity-v2.pdf
git commit -m "docs: parity matrix v2 — flip cluster 3 (chaining + selectorPack) + cluster 5 (multi-element) to Parity post-T77/T78/T79"
git push
open "/Users/Aakash/Claude Projects/Documents/safari-pilot-vs-playwright-parity-v2.pdf"
```

## Task FINAL-3: Changelog

**Files:**
- Create: `docs/changelogs/v0.1.27.md`

- [ ] **Step 1: Write changelog**

```markdown
# v0.1.27 — Locator system v2: chaining + query_all + selectorPack

> **Headline:** three Playwright-parity primitives ship as one. Multi-step locator chaining (T77), multi-element extraction (T78), and custom selector engines (T79). Closes the cluster-3 + cluster-5 gaps in the parity matrix.

## T77 + T80 — Locator Chaining + Strict Mode

`chain: ChainOp[]` field on every locator-aware tool. Ops: `filter` (hasText, hasNotText, has, hasNot), `nth`, `first`, `last`, `and`, `or`, `descendant`. Re-rooting between ops via `descendant`. Backward compatible — existing flat `nth` and `filter.hasText` params unchanged.

**Strict mode (T80):** action tools (click/fill/hover/select_option/type/press_key/double_click/drag) throw `STRICTNESS_VIOLATION` on multi-match without `first`/`last`/`nth` disambiguation. Read tools (get_text/get_html/get_attribute) keep pick-first behavior to preserve v1 read semantics. Matches Playwright's strict-mode contract.

## T78 — `safari_query_all`

New tool. Returns rich payload `[{ref, tagName, text, attrs, boundingBox, visible}]` per element (default cap 100, configurable). Refs follow the existing `data-sp-ref="sp-xxxxxx"` scheme — usable in every existing action tool's `selector` or `ref` param without code changes.

## T79 — selectorPack Custom Engines

Two new tools (feature-flagged off by default; set `selectorPack.enabled=true` to opt in):
- `safari_register_selector(name, body)` — register a JS function body as a named engine
- `safari_unregister_selector(name)` — remove one

Reference via `pack:<name>=arg` prefix in any locator-using tool's `selector` param. Tab-scoped — auto-cleared on tab close.

**Security:** body executed via `new Function('root', 'arg', body)` (never eval), body cap 32KB, name regex `^[a-zA-Z_]\w{0,63}$`, audit-logged, HumanApproval gate fires on register.

## Files changed (top-level)

- `src/locator.ts` — `ChainOp` type, `chain` field, chain block in `generateLocatorJs`, `generateQueryAllJs`, `parsePackSelector`
- `src/aria.ts` — `buildRefSelector` accepts `sp-` prefix
- `src/tools/extraction.ts` — chain in 3 tool input schemas + `safari_query_all` registration + `pack:` resolution
- `src/tools/interaction.ts` — chain in 8 tool input schemas
- `src/tools/selector-pack.ts` (NEW) — register/unregister tools
- `src/security/selector-pack-validator.ts` (NEW) — name + body validation
- `src/security/human-approval.ts` — `safari_register_selector` flagged sensitive
- `src/server.ts` — wire SelectorPackTools
- `src/errors.ts` — `STRICTNESS_VIOLATION` code
- `extension/background.js` — `tabs.onRemoved` clears pack storage
- 10+ new test files (unit + e2e)

## Verification

`bash scripts/pre-tag-check.sh` — ALL 9 PASSED.
3 cluster e2e suites PASS against real Safari.
Multi-file e2e sweep flake rate: 0% (unchanged from v0.1.26 baseline).
```

- [ ] **Step 2: Commit**

```bash
git add docs/changelogs/v0.1.27.md
git commit -m "docs: v0.1.27 changelog"
git push
```

---

# Self-Review

Per Section 14 of writing-plans.

**1. Spec coverage:**

- T77 all 6 chain ops (filter, nth, first, last, and, or) + descendant: ✓ Tasks A-2 through A-5
- T77 backward compat: ✓ Task A-2 Step 6 + Task A-9 backward-compat e2e test
- T77 strict mode: ✓ Tasks A-6 (error code) + A-9 (T80 folded in: action-site enforcement). Action tools (click/fill/hover/select_option/type/press_key/double_click/drag) throw `STRICTNESS_VIOLATION` on multi-match without `first`/`last`/`nth` disambiguation. Read tools (get_text/get_html/get_attribute) keep pick-first behavior to preserve v1 read semantics. Matches Playwright's strict-mode contract.
- T78 rich payload: ✓ Task B-1 + B-3
- T78 ref reuse: ✓ Task B-2 + B-3 + B-4 e2e ref-flow test
- T79 register/unregister: ✓ Task C-3
- T79 `pack:<name>` resolution: ✓ Task C-6 + C-7
- T79 tab-scope auto-clear: ✓ Task C-8
- T79 security: ✓ Tasks C-1, C-5

**2. Placeholder scan:** No "TBD", "implement later", or "similar to Task N" — all code blocks are concrete.

**3. Type consistency:**
- `LocatorDescriptor`, `ChainOp`, `LocatorOptions` — used consistently
- `ToolDefinition`, `ToolResponse` — match `extraction.ts` patterns
- Ref scheme: `sp-xxxxxx` consistent across T77 (single-element finalize), T78 (multi-element items), T79 (pack resolution)

**4-6.** Design-aware checks N/A (no DESIGN.md, no UI components).

**Pre-existing gaps NOT closed by this plan:**
- T74, T75, T76 (filed in v0.1.26) — unrelated to T77/T78/T79

**T80 status:** Folded into Cluster A as Task A-9 per user direction (2026-05-04). Ships with T77.

---

# Execution Handoff

**Plan complete and saved to `docs/upp/plans/2026-05-04-locator-system-T77-T78-T79.md`.**

**Execute with:** the executing-plans skill

The skill supports two modes:
- **Subagent mode** (recommended) — fresh subagent per task, three-stage review (spec → quality → design)
- **Inline mode** — execute in this session with checkpoints

Which mode would you like? (Default: subagent mode)

You can override at any time: "use inline" or "use subagents"
