---
name: evidence-grounded-screenshot
description: Capture a screenshot of specific answer-bearing content on a web page. Use when you need visual evidence for an answer you've extracted. The skill dismisses overlays, scrolls the target into view, then captures.
triggers:
  - take screenshot of the answer
  - capture evidence of
  - screenshot showing
  - prove visually
inputs:
  - tabUrl
  - target
  - screenshotPath
allowed-tools:
  - safari_dismiss_overlays
  - safari_scroll_to_element
  - safari_take_screenshot
---

```json
{
  "steps": [
    { "tool": "safari_dismiss_overlays", "args": { "tabUrl": "{{tabUrl}}" } },
    { "tool": "safari_scroll_to_element", "args": { "tabUrl": "{{tabUrl}}", "selector": "{{target.selector}}", "text": "{{target.text}}", "role": "{{target.role}}", "name": "{{target.name}}", "behavior": "instant" } },
    { "tool": "safari_take_screenshot", "args": { "tabUrl": "{{tabUrl}}", "path": "{{screenshotPath}}" } }
  ]
}
```
