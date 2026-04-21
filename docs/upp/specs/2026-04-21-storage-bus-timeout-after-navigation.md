# Storage Bus Timeout After Navigation — Bug Report

**Date:** 2026-04-21
**Status:** Open
**Severity:** High — blocks interaction-tools e2e test 2 and 3

## Symptom

After `safari_navigate` changes the page URL, the next `safari_evaluate` or `safari_fill` call times out with: "Storage bus timeout (30s) — content script may not be loaded on target tab"

## Reproduction

1. `safari_new_tab("https://example.com")` → works
2. `safari_click` on a link → navigates to iana.org → works
3. `safari_navigate(tabUrl: "iana.org", url: "https://example.com/?new")` → works (ownership fixed)
4. `safari_evaluate(tabUrl: "example.com/?new", script: "...")` → **30s timeout**

## Root Cause (suspected)

After navigation, Safari loads a fresh page. The content scripts (`content-isolated.js`, `content-main.js`) need to be injected into the new page. There's a delay between navigation completing and content script injection. If `safari_evaluate` fires before the content script is ready, the storage bus command (`sp_cmd`) is written but no content script is listening for `storage.onChanged` → 30s timeout.

## Context

- The extension's `content_scripts` in manifest.json are set to `run_at: "document_idle"` — this means they inject AFTER the page has loaded, which could be several seconds after navigation.
- The `safari_navigate` handler has a `WAIT_NAVIGATE_MS` sleep but this may not be long enough for content script injection.
- This is NOT an ownership issue (ownership is now fixed). It's a timing/readiness issue.

## Potential fixes to investigate

1. Add a content-script-ready probe before executing commands (wait for content script to signal readiness)
2. Increase `WAIT_NAVIGATE_MS` after navigation
3. Use `browser.scripting.executeScript` directly in background.js instead of the storage bus for fresh pages
4. Add retry logic in the storage bus with shorter timeout + retry
