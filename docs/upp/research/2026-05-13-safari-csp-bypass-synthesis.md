# Safari CSP / Trusted-Types Bypass — Research Synthesis
*Written 2026-05-13. Triggered by v0.1.33 WebVoyager bench (128/175 = 73.1%) where Google Flights (3/11 = 27%), Apple Shop (Apple--41), X.com (Google Search--15) all failed with the same class of error: Safari refused to evaluate strings as JavaScript on pages that enforce Trusted Types or restrict `unsafe-eval`/`trusted-types-eval`.*

## 1. Problem statement

Safari Pilot is a Safari-native browser-automation framework distributed as a notarized Safari Web Extension + a Swift daemon. On pages that ship strict CSP (specifically `require-trusted-types-for 'script'` or `script-src` lacking `unsafe-eval`/`trusted-types-eval`), every tool that routes through `safari_evaluate` — and any tool built atop it — fails with `Refused to evaluate a string as JavaScript`. The single architectural choke point is `extension/content-main.js:714`: `const fn = new _Function(params.script);`. The structural constraint is non-negotiable: Safari is the product, not the limitation. We need a path that ships in a notarized Safari Web Extension targeting the user's real Safari tabs.

## 2. Sources analyzed

- **R1** — *CSP Trusted Types deep-dive* (research agent, 2026-05-13). 10 ranked techniques + sprint slice. Cites W3C Trusted Types spec, Apple Developer Forums 651542/728849, WebKit commit 971b9ba enabling TT stable in March 2025, MDN ExecutionWorld.
- **R2** — *Safari/WebKit DOM control surfaces beyond eval* (research agent, 2026-05-13). 8-row capability matrix + 2 sprint priorities. Cites WKContentWorld.h, WebKit Inspector Protocol Runtime.json, AXorcist, jano.dev TCC writeup.
- **R3** — *Prior art in Safari/WebKit automation* (research agent, 2026-05-13). 3 ranked options + honest gaps. Cites Playwright bootstrap.diff, WebDriverAgent, WebKit Source/WebKit/WebProcess/Automation, webkit.org/blog/6900.

## 3. Convergence map

| Claim cluster | R1 | R2 | R3 | Status |
|---|---|---|---|---|
| ISOLATED-world content scripts exempt from page Trusted Types | ✅ Supports | ✅ Supports | Silent | **STRONG CONVERGENCE** |
| Choke point is `new Function(string)` in MAIN-world dispatcher | ✅ Supports (C4) | Implicit (calls for architectural fix) | Silent | R1 explicit, others implicit |
| `scripting.executeScript({world:"MAIN", func})` viable | ✅ Supports (C5) | Silent | Silent | R1 alone, specific |
| safaridriver/WebDriver opens automation window, kills user tabs | Silent | ✅ Supports (C9) | ✅ Supports (C9) | **STRONG CONVERGENCE** |
| macOS AX API is CSP-immune by construction | Silent | ✅ Supports (C10) | Mentions (XCUITest = AX-based) | R2 primary, R3 acknowledges |
| Playwright path requires forked WebKit (off the table) | Silent | Silent | ✅ Supports (C13) | R3 alone, decisive |
| TT policy registration works on sites without name allowlist | ✅ Supports (C6) | Silent | Silent | R1 alone — **dissent unmarked** |
| AX as a v0.1.34 fourth engine | Silent | ✅ Supports (Sprint priority 2) | **Qualifies**: AX tree ≠ DOM tree, only useful for non-sink ops | **CONFLICT IN SCOPE** |
| Capability protocol covers most cases | ✅ Supports (Sprint priority 1) | Implicit (via ISOLATED) | **❌ Contradicts**: "No notarized SWE solves this" | **DISAGREEMENT** |
| Orion (Kagi) as alternative target | Silent | Silent | ✅ Supports (C17) | R3 alone — outside-the-box |
| Empirical proof of TT bypass exists today in stock Safari | ❌ Implicit no | ❌ Implicit no | ✅ Explicit no (C15, C18) | **STRONG CONVERGENCE — gap is real** |

**The central tension:** R1 is optimistic (architectural fix solves it). R3 is pessimistic (no notarized SWE has shipped this; the two known-working techniques abandon a Safari Pilot constraint). R2 sits in the middle (structural fix + AX escape hatch).

## 4. Competing hypotheses

**H1 — Capability-protocol refactor (R1 line).** Kill `new Function` capture; move every DOM op behind a structured-op dispatcher; register a Trusted Types policy as belt-and-suspenders. Architectural-only. Stays inside SWE. Bench delta hypothesis: closes ~70-80% of CSP failures.

**H2 — ISOLATED-first + AX engine fallback (R2 line).** Move DOM mutations into `content-isolated.js` (CSP-immune per W3C). Add a fourth daemon-side engine using macOS Accessibility for click/type on residual cases ISOLATED-world can't reach. Adds a TCC permission prompt at install.

**H3 — Multi-runtime distribution (R3 line).** Accept that notarized SWE alone cannot ship the answer. Ship Safari (current) + Orion (Chrome WebExt API on WebKit) + an opt-in safaridriver "strict mode" tab. Engineering cost is high but failure mode is honest: users pick their runtime.

## 5. Pre-mortem — specific failure modes

### H1 fails specifically because:
1. **No empirical proof exists.** R3-C15 + C18: no public demonstration that an architectural refactor alone fixes any TT-strict Safari case. Ship a fix → bench delta could be 0.
2. **Capability enumeration never closes.** Bench transcripts (Apple--41, Google Search--15) show ad-hoc DOM probes the capability set can't predict. Every new site exposes a new property combination.
3. **The W3C exemption only applies if mutation happens IN ISOLATED world.** Today's bridge hops mutation to MAIN. R1 doesn't address this — "capability protocol" leaves the hop intact unless we also rewrite the bridge.
4. **`executeScript({world:"MAIN", func})` per-call adds 30-50ms vs current ~10ms postMessage.** Multi-step task latency could regress 5-10×.
5. **TT policy creation depends on absence of `trusted-types <name>` directive.** Google deploys policy allowlists; R1's fallback throws on those sites.

### H2 fails specifically because:
1. **AX tree ≠ DOM tree** (R2 admitted). React/Vue custom inputs: `AXSetValue` writes the visible text but framework state stays empty. Submit handler sees nothing.
2. **TCC distribution wall.** Adding macOS Accessibility prompt breaks the `git clone + npm install` persona (postinstall is non-interactive). CI / headless macOS runners often can't grant TCC.
3. **AX walk latency 100-500ms per page.** 20-100ms per node × ~5-50 nodes for typical query. Cache invalidation on dynamic pages — the kind we're failing on now — is unsolved.
4. **Selector → AX node mapping has no public spec.** Heuristics like "role + nearby text" are brittle; failure mode is silent wrong-button-clicked, worse than loud failure.
5. **`SafariPilotd` visible in Privacy & Security panel.** For an AI-automation product, this is a high trust ask that could measurably hurt adoption.

### H3 fails specifically because:
1. **Orion ~1% browser share.** "Install Orion to automate Safari" defeats the value prop of "Safari, the user's actual Safari."
2. **safaridriver `--enable` is sudo-gated.** Today's install: zero password prompts. Adding sudo is a step-function in friction.
3. **safaridriver's automation window is structurally separate.** Agent's work invisible to user — defeats observability.
4. **Single-vendor Orion dependency (Kagi).** API drift on either Safari or Orion breaks the extension on one or both. Doubles test matrix per PR.
5. **3 engines × 3 browsers = 9 paths.** Current bench is 4-6h wall-clock; tripling it across browsers is unworkable for ship gates.

## 6. Integrated recommendation — Layered Defense

No single hypothesis survives intact. The hybrid combines elements where their failure modes don't overlap:

### Layer 1 — Bulk fix: ISOLATED-first DOM ops (~70-80% expected closure)
Move every DOM mutation handler into `content-isolated.js`. Exploit the W3C-confirmed exemption (claim C1, supported by R1 + R2 independently). Capability handlers — `click`, `fill`, `extract`, `getAttribute`, `getText`, `scroll`, `dispatch`, `queryShadow`, `interceptDialogs` — implemented natively in ISOLATED, no string-to-script conversion at any point. This pays the hidden architectural cost H1 ignored (failure mode #3): rewriting the bridge so MUTATION happens in ISOLATED, not just dispatch.

### Layer 2 — The eval escape: bundled-function dispatcher
Drop `new Function(params.script)` at content-main.js:714. Replace `safari_evaluate(arbitrary_string)` with `safari_call(method, args)` where the method set is bundled in `scripting.executeScript({world:"MAIN", func: ...})` — `func` is a code reference (immune to script-src per R1-C5), method set is finite and curated. The bench-failure modes shift from "string-eval blocked" to "method not registered" — loud and traceable, not silent and recoverable-by-Bash.

### Layer 3 — Safety net: Trusted Types policy registration
Register `trustedTypes.createPolicy('safari-pilot', {createScript: s => s, createHTML: s => s, createScriptURL: s => s})` at MAIN content-script load. On sites without a `trusted-types <allowlist>` directive (most), it succeeds; any residual string→sink path goes through it. On sites with allowlist (Google), it throws — we report `CSP_HARD_BLOCK` and the agent skips gracefully instead of 8 retries on the same blocked op (seen in current bench traces).

### Layer 4 — Deferred dark horse: AX engine (v0.1.35, opt-in)
Add a daemon-side `AXEngine` (Swift, uses `AXUIElement`/`AXPress`/`AXSetValue`/AXWebArea tree walk) **only** for residual cases where Layers 1-3 fail empirically. Gated behind `--enable-ax-engine` config flag, with TCC prompt only on enable. Not the default path. Use case: React-custom-widget click/type where ISOLATED DOM can't trigger framework state. Scoping to last-resort addresses H2 failure modes #2 (distribution wall — only opt-in users pay it) and #1 (AX ≠ DOM — agent has explicit fallback semantic, not silent substitution).

### Explicitly defer / reject
**H3 (multi-runtime) is rejected for v0.1.34.** No Orion build, no safaridriver strict-mode tab. The product principle — Safari, user's real tabs — is the value prop; abandoning it costs more than the residual CSP gap is worth.

## 7. Why this hybrid survives the pre-mortem better than any single H

- **vs H1 alone:** Layer 3 (TT policy with fail-fast `CSP_HARD_BLOCK`) + Layer 4 (deferred AX) are the empirical safety nets H1 lacks. We don't ship and hope; we ship with a fallback path documented.
- **vs H2 alone:** AX is the escape hatch, not the primary surface. TCC prompt is opt-in. Selector → AX-node brittleness only affects opt-in users who already accepted the tradeoff.
- **vs H3 alone:** We don't abandon the product principle. Single notarized SWE distribution. No Orion side-channel, no sudo.

## 8. What this synthesis CANNOT solve — open questions

1. **Empirical question:** Will Layer 1 + 2 + 3 actually move bench numbers on Google Flights / Apple Shop / X.com? No prior art demonstrates this (R3-C18). v0.1.34 ship-gate MUST include a bench re-run on the 3 failing sites. If Google Flights stays at 27% post-Layer-3, Layer 4 becomes urgent rather than v0.1.35 backlog.
2. **Distribution measurement:** What percentage of v0.1.33 tool calls went through `safari_evaluate` vs sentinel handlers? Data exists in `/tmp/wv-inline-runs/*.stream.jsonl` but isn't summed. This determines whether Layer 2's "loud failure on unregistered method" cost is acceptable or breaks too many real workflows.
3. **Bridge rewrite cost:** Reverse the ISOLATED ↔ MAIN bridge so mutation stays in ISOLATED. How invasive? Estimate: ~half the content-main.js sentinel handlers may need to move. The `__SP_LOCATOR__` MAIN-world helper may become deletable.
4. **Latency budget:** `scripting.executeScript({world:"MAIN", func})` per-call latency — does it actually compound 5-10× as feared? Needs a microbenchmark before committing the architecture.

## 9. Recommended next steps (sprint shape)

1. **Trace analysis** (1 day): Count `safari_evaluate` vs sentinel calls across v0.1.33 bench. If <10% of calls truly need arbitrary eval, Layer 2's enum-the-methods approach is fully sufficient.
2. **Probe spike** (2 days): Implement Layers 1-3 as a single feature branch. Test against Google Flights and Apple Shop manually before bench-gating.
3. **Bench gate** (1 day): Re-run the 47 failing tasks from v0.1.33. Acceptance: Apple Shop 5/12 → ≥9/12; Google Flights 3/11 → ≥7/11; X.com login (Google Search--15) → PASS.
4. **If bench gate fails on Google specifically** (allowlisted policies): prioritize Layer 4 (AX engine) into v0.1.34. Otherwise defer to v0.1.35.

## 10. Sources cited

- W3C wiki: [Effects of Trusted Types on browser extension developers](https://github.com/w3c/trusted-types/wiki/Effects-of-deploying-Trusted-Types-on-browser-extension-developers)
- Apple Developer Forums [thread 651542](https://developer.apple.com/forums/thread/651542) — page CSP and Safari Web Extension content scripts
- Apple Developer Forums [thread 728849](https://developer.apple.com/forums/thread/728849) — Safari `world: "MAIN"` support
- WebKit commit [971b9ba — Enable Trusted Types stable](https://github.com/WebKit/WebKit/commit/971b9ba19d62aad183c5e3e47e2c1eff7c92f7c6)
- WebKit source: [Runtime.json (Inspector Protocol)](https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/inspector/protocol/Runtime.json)
- WebKit source: [WebAutomationSessionProxy.cpp (evaluateJavaScriptFunction)](https://github.com/WebKit/WebKit/blob/main/Source/WebKit/WebProcess/Automation/WebAutomationSessionProxy.cpp)
- Playwright source: [wkPage.ts (setBypassCSP usage)](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/webkit/wkPage.ts)
- Playwright source: [bootstrap.diff (20k-line WebKit patch)](https://github.com/microsoft/playwright/blob/main/browser_patches/webkit/patches/bootstrap.diff)
- WebKit blog: [WebDriver Support in Safari 10](https://webkit.org/blog/6900/webdriver-support-in-safari-10/)
- W3C TR: [Trusted Types](https://www.w3.org/TR/trusted-types/)
- MDN: [scripting.ExecutionWorld](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/ExecutionWorld)
- AXorcist (Swift AXUIElement wrapper): https://github.com/openclaw/AXorcist
- jano.dev: [Accessibility Permission for macOS](https://jano.dev/apple/macos/swift/2025/01/08/Accessibility-Permission.html)
- Kagi: [Orion Web Extensions API support](https://help.kagi.com/orion/misc/technical.html)
- Project sources: `extension/manifest.json`, `extension/content-main.js`, `extension/content-isolated.js`
