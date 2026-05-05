---
name: robust-form-fill
description: Fill a form field-by-field using fills with strict-mode safety, then submit. Use when filling forms is part of a task and brittle CSS selectors should be avoided.
triggers:
  - fill out the form
  - submit the form
inputs:
  - tabUrl
  - fields
  - submitSelector
---

```json
{
  "steps": [
    { "tool": "_loop", "over": "{{fields}}", "as": "f", "do": [
      { "tool": "safari_fill", "args": { "tabUrl": "{{tabUrl}}", "selector": "{{f.selector}}", "value": "{{f.value}}" } }
    ]},
    { "tool": "safari_click", "args": { "tabUrl": "{{tabUrl}}", "selector": "{{submitSelector}}" } }
  ]
}
```
