---
name: dismiss-overlays-recovery
description: Recovery pattern when web extraction fails or returns suspiciously short or generic content. Likely an overlay is blocking. Dismisses known overlays, then retry the original extraction.
triggers:
  - extraction returned empty
  - sign in to continue
  - verify you're human
  - subscribe to read
  - continue reading
---

If your last extraction call (safari_get_text, safari_evaluate, etc.) returned:
- Fewer than 50 characters
- Tokens like "sign in", "verify", "subscribe", "register", "continue reading"
- Empty string or whitespace-only

The page likely has an overlay blocking content. Recover:

1. Call `safari_dismiss_overlays(tabUrl)`. Inspect the response.
2. If `dismissed[]` is non-empty: retry your original extraction with the same args. The content should now be reachable.
3. If `dismissed[]` is empty but `skipped[]` mentions a candidate the allowlist doesn't recognize: the page has a non-allowlisted overlay. Use `safari_evaluate` to inspect the DOM directly, or escalate to the user.
4. If both arrays are empty AND content is still gated: not an overlay issue — re-read the task. You may be on the wrong page or need to authenticate.

Do NOT call safari_dismiss_overlays repeatedly in a loop. One pass is the contract; if dismissal didn't help, dismiss won't help on retry.
