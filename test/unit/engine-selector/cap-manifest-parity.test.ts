/**
 * T34 — `ENGINE_CAPS.extension.framesCrossOrigin` must match the manifest reality.
 *
 * The Safari Web Extension's content scripts are declared in
 * `extension/manifest.json#content_scripts[]`. By default Manifest v3
 * injects each entry only into the top frame; cross-origin iframe access
 * requires `all_frames: true` on EVERY content_scripts entry that needs
 * to run inside iframes. Without `all_frames`, the extension cannot
 * see, query, or interact with cross-origin frame DOMs — full stop.
 *
 * `ENGINE_CAPS.extension.framesCrossOrigin` is documentation describing
 * what the Extension engine CAN do. Asserting `true` while the manifest
 * lacks `all_frames` makes that documentation lie about runtime reality.
 * The audit (T34) flagged this as a P2 honesty bug.
 *
 * Discrimination: this invariant test reads the on-disk manifest and
 * compares its `all_frames` reality to the cap value.
 *   - Pre-fix:  cap=true,  no all_frames → FAIL
 *   - Post-fix: cap=false, no all_frames → PASS
 *   - When T55 lands (manifest gains all_frames:true on every entry) the
 *     test will require ENGINE_CAPS.extension.framesCrossOrigin to flip
 *     back to true — self-coordinating between the type-system claim and
 *     the manifest reality.
 *
 * Note: ENGINE_CAPS is currently decorative — `selectEngine` does not
 * consult capability flags for routing, only `tool.requires*` and runtime
 * availability. So this fix has no behavioural effect today; its value is
 * documentation honesty + future-proofing the cap claim against the
 * manifest.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_CAPS } from '../../../src/engine-selector.js';

const __filename = fileURLToPath(import.meta.url);
const manifestPath = resolve(__filename, '../../../../extension/manifest.json');

interface ManifestContentScript {
  matches?: string[];
  js?: string[];
  all_frames?: boolean;
  run_at?: string;
  world?: string;
}

interface Manifest {
  content_scripts?: ManifestContentScript[];
}

describe('T34 — ENGINE_CAPS.extension.framesCrossOrigin parity with manifest', () => {
  it('framesCrossOrigin is true iff every content_scripts entry has all_frames: true', () => {
    const manifestText = readFileSync(manifestPath, 'utf-8');
    const manifest = JSON.parse(manifestText) as Manifest;

    const scripts = manifest.content_scripts ?? [];
    expect(scripts.length).toBeGreaterThan(0); // sanity: manifest has content_scripts

    const everyEntryAllFrames = scripts.every((s) => s.all_frames === true);

    expect(ENGINE_CAPS.extension.framesCrossOrigin).toBe(everyEntryAllFrames);
  });
});
