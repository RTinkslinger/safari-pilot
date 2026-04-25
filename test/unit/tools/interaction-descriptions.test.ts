/**
 * T16 — `safari_hover` description must NOT falsely claim CSS `:hover`
 * activation.
 *
 * Pre-T16: interaction.ts:233 declared "Triggers CSS :hover states and
 * mouseover/mouseenter events." This is a false claim — the handler
 * dispatches synthetic `MouseEvent`s via `element.dispatchEvent(...)`,
 * which fires JS handlers but does NOT activate CSS `:hover` pseudo-classes.
 * That's a web platform limitation, not a Safari quirk: the CSS engine
 * tracks real pointer position, and synthetic events bypass that tracking.
 *
 * The false claim has been there since day one (`d65c461`, 2026-04-11) and
 * was never verified. The MCP description is the LLM-visible contract for
 * the tool — agents that see "Triggers CSS :hover states" will reach for
 * safari_hover when they need to reveal hover-only menus or tooltips
 * (which is exactly when CSS :hover, not the JS event, is what matters).
 *
 * Audit finding: docs/AUDIT-TASKS.md T16 (P1, H14 — tool-modules audit).
 */
import { describe, it, expect } from 'vitest';
import { InteractionTools } from '../../../src/tools/interaction.js';
import type { IEngine } from '../../../src/engines/engine.js';
import type { SafariPilotServer } from '../../../src/server.js';

describe('safari_hover description (T16)', () => {
  // InteractionTools reads getDefinitions() at registration time; the engine
  // and server references are only used inside handlers we are not invoking here.
  const tools = new InteractionTools({} as IEngine, {} as SafariPilotServer);

  it('does not claim CSS :hover activation (synthetic events do not fire :hover)', () => {
    // Discrimination target: src/tools/interaction.ts:233. Reverting the
    // T16 fix re-introduces the "Triggers CSS :hover states" false claim
    // that misleads LLM clients into using safari_hover for CSS-driven
    // hover menus/tooltips — which only the real cursor position can
    // reveal.
    const def = tools.getDefinitions().find((d) => d.name === 'safari_hover');

    expect(def, 'safari_hover tool definition must exist').toBeDefined();
    // Negative: description must not assert :hover activation. Match
    // common phrasings that would re-introduce the false claim.
    expect(def?.description).not.toMatch(/triggers?\s+CSS\s*:hover|activates?\s+CSS\s*:hover|fires?\s+CSS\s*:hover/i);
  });

  it('mentions the synthetic-event nature of the dispatch', () => {
    // Positive: the corrected description must disclose that this
    // tool dispatches SYNTHETIC events (the underlying constraint
    // that prevents CSS :hover activation). Requiring the literal
    // word "synthetic" prevents the fix from sliding into a vague
    // description that loses the limitation entirely. The current
    // false-claim description ("Triggers CSS :hover states and
    // mouseover/mouseenter events") does NOT contain the word
    // "synthetic" — so this test fails RED-side, just like the
    // negative test, and only the corrected description satisfies
    // both tests together.
    const def = tools.getDefinitions().find((d) => d.name === 'safari_hover');

    expect(def?.description).toMatch(/synthetic\s+(mouse\s*)?(event|MouseEvent)/i);
  });
});
