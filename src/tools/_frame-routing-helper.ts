// Single source of truth for frameId routing across 10 frame-aware tool handlers.
// Tools call this instead of dispatching engine.executeJsInTab / executeJsInFrame
// themselves.
//
// Contract:
//   params.frameId == null OR === 0 → engine.executeJsInTab (top frame, any engine)
//   params.frameId > 0 + engine.name === 'extension' → engine.executeJsInFrame
//   params.frameId > 0 + engine.name !== 'extension' → throws FrameNotSupportedError
//
// Why this exists: spec D7 maximal v1 = 10 tools accept frameId. Without a shared
// helper the routing rule drifts across tool handlers as new tools land. The
// parameterized test in frame-aware-tools-routing.test.ts (Task 18) verifies all
// 10 tools' adoption of this helper.

import { FrameNotSupportedError } from '../errors.js';
import type { IEngine } from '../engines/engine.js';
import type { EngineResult } from '../types.js';

export async function routeFrameAware(
  engine: IEngine,
  params: { tabUrl: string; frameId?: number },
  jsCode: string,
  timeout?: number,
): Promise<EngineResult> {
  const frameId = params.frameId;
  if (frameId == null || frameId === 0) {
    // T07 (extended) — wedge-aware retry for ALL frame-aware extraction tools
    // on the top frame (get_text, query_all, get_html, get_attribute,
    // smart_scrape, extract_*, etc.). Ad-heavy pages transiently wedge the
    // WebContent main thread; without retry, a timeout burns a whole agent
    // turn and compounds into a turn explosion (Allrecipes--0 regression
    // trace #39/#51: extract_links + query_all both DAEMON_TIMEOUT). Absorb
    // a TRANSIENT wedge here: on timeout, poll responsiveness then retry once.
    // Persistent wedges (page never recovers in budget) still surface the
    // timeout — those need DNR ad-blocking, out of scope for this helper.
    const first = await engine.executeJsInTab(params.tabUrl, jsCode, timeout);
    if (first.ok) return first;
    const isTimeout = first.error?.code === 'DAEMON_TIMEOUT' || /timed out/i.test(first.error?.message ?? '');
    if (!isTimeout) return first;
    // BOUNDED retry: a single short responsiveness probe, then at most one
    // retry. Earlier a 12s polling loop AMPLIFIED persistent-wedge cost
    // (Allrecipes--4: 979s/46t — each of dozens of calls added 12s of
    // polling). Capping to one 3s probe bounds the added latency to ~3s/call:
    // transient wedges that clear fast still recover; persistent wedges fail
    // fast (only the original timeout + 3s), so the catastrophe isn't
    // multiplied. Persistent-wedge elimination still needs DNR ad-blocking.
    const probe = await engine.executeJsInTab(params.tabUrl, 'return 1+1;', 3_000);
    if (probe.ok && typeof probe.value === 'string' && probe.value.includes('2')) {
      return engine.executeJsInTab(params.tabUrl, jsCode, timeout);
    }
    return first;
  }
  if (engine.name !== 'extension') {
    throw new FrameNotSupportedError();
  }
  return engine.executeJsInFrame(params.tabUrl, frameId, jsCode, timeout);
}
