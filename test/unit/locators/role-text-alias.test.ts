/**
 * v0.1.37 T02 — safari_click role+text alias to role+name.
 *
 * Pre-fix behavior (verified empirically in
 * /tmp/bare2-sp/Allrecipes--1-r1.stream.jsonl events #43-44): the agent
 * calls `safari_click({role: "link", text: "Debbie's Vegetable Lasagna",
 * waitForNavigation: true})` — natural Playwright-style intent meaning
 * "click the LINK whose visible name is X". generateLocatorJs's priority
 * table picks the `role` branch, passes `locator.name` (undefined) to
 * buildRoleResolutionJs, and ignores `locator.text` entirely. All 221
 * elements with role=link match, strict-mode rejects with "Locator matched
 * 221 elements, expected exactly 1". The agent then has to retry with
 * `chain:[first]` (often picks the wrong link — "Skip to content") and
 * then again with an xpath fallback. That's TWO extra turns per click,
 * and Allrecipes--1 hit it.
 *
 * Post-fix contract: when extractLocatorFromParams sees BOTH `role` and
 * `text` AND `name` is not explicitly provided, it aliases the text
 * value into `name`. The downstream role+name resolution path filters
 * candidates by accessible-name match, which is what Playwright's
 * `page.getByRole('link', { name: 'X' })` does — and what every LLM
 * agent has been trained on as the canonical "click link X" pattern.
 *
 * If the caller explicitly supplies BOTH `name` AND `text`, `name` wins
 * (no aliasing). That preserves explicit-intent for callers that know
 * the distinction.
 *
 * If the caller supplies `text` alone (no role), `text` stays as `text`
 * (the page-wide text-resolution path) — no aliasing.
 */
import { describe, it, expect } from 'vitest';
import { extractLocatorFromParams } from '../../../src/locator.js';

describe('extractLocatorFromParams — role+text alias to role+name', () => {
  it('aliases text → name when role is present and name is absent', () => {
    const desc = extractLocatorFromParams({
      role: 'link',
      text: "Debbie's Vegetable Lasagna",
    });
    expect(desc).not.toBeNull();
    expect(desc!.role).toBe('link');
    expect(desc!.name).toBe("Debbie's Vegetable Lasagna");
    // text is dropped so generateLocatorJs's priority table picks
    // role+name, not role-only with leftover text.
    expect(desc!.text).toBeUndefined();
  });

  it('preserves explicit name when both name and text are provided (no aliasing)', () => {
    // If the agent took the effort to set `name`, that's the intent.
    // Don't clobber it.
    const desc = extractLocatorFromParams({
      role: 'link',
      name: 'Explicit Name',
      text: 'Some Other Text',
    });
    expect(desc).not.toBeNull();
    expect(desc!.role).toBe('link');
    expect(desc!.name).toBe('Explicit Name');
    // text MUST be dropped — leaving it in would create ambiguity in the
    // downstream resolution priority table (role wins over text, but
    // having both set hides intent).
    expect(desc!.text).toBeUndefined();
  });

  it('leaves text alone when role is NOT present (text-only locator path stays valid)', () => {
    const desc = extractLocatorFromParams({ text: 'arbitrary phrase' });
    expect(desc).not.toBeNull();
    expect(desc!.text).toBe('arbitrary phrase');
    expect(desc!.role).toBeUndefined();
    expect(desc!.name).toBeUndefined();
  });

  it('leaves role+name unchanged when text is absent', () => {
    // Regression guard for the existing role+name agent path.
    const desc = extractLocatorFromParams({ role: 'button', name: 'Submit' });
    expect(desc).not.toBeNull();
    expect(desc!.role).toBe('button');
    expect(desc!.name).toBe('Submit');
    expect(desc!.text).toBeUndefined();
  });

  it('leaves role-only unchanged when both name and text are absent', () => {
    const desc = extractLocatorFromParams({ role: 'banner' });
    expect(desc).not.toBeNull();
    expect(desc!.role).toBe('banner');
    expect(desc!.name).toBeUndefined();
    expect(desc!.text).toBeUndefined();
  });

  it('ignores non-string text when role is present (no aliasing on bad type)', () => {
    const desc = extractLocatorFromParams({
      role: 'link',
      text: 123 as unknown as string,
    });
    expect(desc).not.toBeNull();
    expect(desc!.role).toBe('link');
    expect(desc!.name).toBeUndefined();
    expect(desc!.text).toBeUndefined();
  });

  it('does NOT alias empty-string text (would match all role elements with empty name)', () => {
    // {role:'link', text:''} would, post-naive-alias, become {role:'link',
    // name:''} which matches every link with empty accessible name —
    // never the agent's intent. Aliasing is gated on text.length > 0.
    const desc = extractLocatorFromParams({ role: 'link', text: '' });
    expect(desc).not.toBeNull();
    expect(desc!.role).toBe('link');
    expect(desc!.name).toBeUndefined();
    // The empty text falls through unchanged. generateLocatorJs's priority
    // table picks role-only (text is lower priority than role), which is
    // the documented pre-fix behavior for this shape.
    expect(desc!.text).toBe('');
  });

  it('preserves the exact flag on the aliased locator', () => {
    // Some agents pass exact:true with role+text expecting strict name match.
    const desc = extractLocatorFromParams({
      role: 'link',
      text: 'Sign In',
      exact: true,
    });
    expect(desc).not.toBeNull();
    expect(desc!.name).toBe('Sign In');
    expect(desc!.exact).toBe(true);
  });
});
