# Iteration T01 — Task 1 (Allrecipes--0): close turn/cost gap

## Goal
Make SP+CC beat PW+CC on Allrecipes--0 across wall time AND turns AND cost,
all under bare prompts (3-line symmetric scaffold), without regressing
any prior architectural change.

## Bare-prompt baseline (just measured)

| | PW | SP | Ratio |
|---|---|---|---|
| Wall ms | 169000 | 162000 | 0.96× ✓ |
| Turns | 9 | 14 | 1.56× ✗ |
| Cost USD | 1.2594 | 1.9183 | 1.52× ✗ |
| Final answer | Vegetarian Four Cheese Lasagna 4.6★/243 | Vegetarian Four Cheese Lasagna 4.6★/243 | match |
| Window leak | reports delta=1 but PW doesn't touch Safari → false positive from parallel measurement | reports delta=1 but parallel-measurement artifact | detection only valid serially |

Stream artifacts:
- `/tmp/bare1-pw/Allrecipes--0-r1.stream.jsonl` — 9 turns, 7 tool calls
- `/tmp/bare1-sp/Allrecipes--0-r1.stream.jsonl` — 14 turns, 12 tool calls

## RCA: where do SP's extra 5 turns come from?

| Step | PW path | SP path | Delta |
|------|---------|---------|-------|
| Navigate search | `browser_navigate` (1) | `safari_new_tab` (1) | — |
| Read search results | `browser_evaluate` arrow function: query 3 selector candidates, dedup, return list (1) | `safari_get_text` selector="main" → text body (1) | — |
| Click chosen recipe | `browser_navigate` direct URL (1) | `safari_click` text="Vegetarian..." (matched 223 elements — ERR) + retry with `chain:[first]` (2) → then needed query_all to find URL (3 more attempts) → then `safari_navigate` (1) | **+5** |
| Read recipe page | `browser_evaluate` arrow function: extract rating/details (1) | `safari_get_text` (1) | — |
| Screenshot | `browser_take_screenshot` fail (file-access-roots) + retry + Bash cp (3) | `safari_take_screenshot` (1) | **-2** |
| Cleanup | none | `safari_close_tab` (1) | **+1** |
| **Total tool calls** | **7** | **12** | **+5** |

**The delta is concentrated in the click → URL discovery sequence.** PW used `browser_evaluate` with an IIFE to do multi-selector exploration in one call. SP couldn't because **safari_evaluate's wrapper interpolates the script as a function body, so IIFEs / arrow functions / bare expressions silently return `{type:"undefined"}` (Bug-MCP-1 from CHECKPOINT).**

Evidence in SP stream:
- Agent never called `safari_evaluate` (avoided it entirely, even though the bare scaffold doesn't steer away from it)
- Instead chose `safari_query_all` + multi-attempt selector exploration
- Hit Bug-MCP-3 (`count:false` for 0-matches) at #46 — cosmetic, didn't change behavior

## Fix decision: Bug-MCP-1 (safari_evaluate contract)

### Analysis

`src/tools/extraction.ts:755-760` interpolates the user's script inside an
async function body:

```js
return (async () => {
  var __userResult = await (async function() { ${script} })();
  return { value: __userResult, type: typeof __userResult };
})();
```

- `script = "document.title"` → body becomes `document.title` — expression
  evaluated and discarded; no return → `__userResult = undefined`.
- `script = "(() => document.title)()"` → body becomes
  `(() => document.title)()` — IIFE evaluates and discards; no return →
  `__userResult = undefined`.
- `script = "return document.title;"` → has top-level return → works.

The tool description (extraction.ts:232) says "Must return a value." which is
the standard JS expression-returns-value mental model — the agent does NOT
know that `return` must be a literal keyword. So agents that write
`() => x`-style code (which is what Claude consistently produces) fail
silently.

### Proposed fix (TypeScript-only, no daemon/extension rebuild)

1. **Update description** in `src/tools/extraction.ts:230-249`:
   - State the contract explicitly. Three modes are accepted: (a) bare
     expression like `document.title`; (b) IIFE like `(() => 'x')()`; (c)
     multi-statement with literal top-level `return X;`. Uninvoked function
     literals like `() => x` are NOT auto-invoked; use `(() => x)()`.

2. **Wrapping logic update**, same file lines 755-760:
   - If `script` contains a top-level `return` keyword → use as function body
     (current behavior).
   - Else → wrap as `return (${script});` so bare expressions and IIFEs
     return their evaluated value.
   - Sentinel bypass list stays untouched.

3. **Top-level return detection** — pragmatic regex:
   `/(^|[;}\n])\s*return\b/.test(script)`. Matches `return` at line start,
   after a semicolon, or after a close-brace. Misses some edge cases (return
   inside template-literal substitution, return inside a regex literal) but
   those are vanishingly rare for evaluate inputs.

### TDD test plan

Failing tests (RED) — `test/unit/tools/safari-evaluate-contract.test.ts`:

1. **bare expression returns value**: script=`'document.title'` → expect
   result.value to be a string, not undefined.
2. **IIFE returns inner value**: script=`'(() => "hello")()'` → expect
   "hello" not undefined.
3. **async IIFE returns awaited value**: script=`'(async () => "x")()'` →
   expect "x".
4. **multi-statement with top-level return preserves current behavior**:
   script=`'const x = 1; return x;'` → expect 1.
5. **bare statement (no return) returns undefined** (regression guard):
   script=`'let x = 1;'` → still undefined (no expression to wrap).
6. **JSON.stringify expression**: script=`'JSON.stringify({a:1})'` → expect
   the JSON string.

All tests target the wrapping function. The handler-level tests cover the
description change implicitly (the rendered MCP tool definition is asserted).

### Risk assessment

- **Behavioral compatibility**: existing callers using top-level `return X;`
  are unaffected (the first branch). New cases (bare expr, IIFE) currently
  return undefined; after the fix they return values. No caller depends on
  the undefined return — that was a silent bug.
- **Sentinel bypass**: untouched. Test-harness sentinels still skip wrapping.
- **CSP / Trusted Types**: the executeJsInTab path doesn't change. CSP_BLOCKED
  / CSP_HARD_BLOCK detection paths still fire.
- **Sync vs async**: the new `return (${script});` is inside an `async`
  function, so awaited Promises still resolve.

### Ship process

- TypeScript-only change. `npm run build` recompiles `dist/`. No daemon binary
  change. No extension `.app` change.
- After RED→PASS for tests, re-run Task 1 (Allrecipes--0) bare on SP only
  (PW unchanged baseline already captured). Compare against 14 turns / $1.92.
- If gap closes (target: ≤9 turns, ≤$1.30) → ship as v0.1.37 with version
  bump in package.json + extension/manifest.json (lockstep per
  `feedback-extension-version-both-fields`) + full release tag pipeline
  (pre-tag-check, git tag, push, gh release watch). Per global rule,
  `npm view safari-pilot version` after publish.
- If gap doesn't close → iterate (next likely candidate: Bug-MCP-3 daemon
  fix, requires daemon rebuild).

## Open notes

- Window-leak detection is a false-positive in parallel mode. For real leak
  detection, runs must be serial OR we need session-window-id tracking
  instead of global Safari window count. Punt to a follow-up.
- Task 1's correct answer is reachable by ALL three engines (extension /
  daemon / applescript surfaces). The 5-turn gap is purely about agent's
  tool-selection efficiency, which is driven by what tool descriptions and
  return shapes encourage.
