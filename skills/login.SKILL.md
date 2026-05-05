---
name: login
description: Log into a site by filling username + password and submitting. Use when a task starts with "log into <site>" and credentials are known.
triggers:
  - log in
  - sign in
  - authenticate
inputs:
  - url
  - usernameSelector
  - passwordSelector
  - submitSelector
  - username
  - password
---

```json
{
  "steps": [
    { "tool": "safari_new_tab", "args": { "url": "{{url}}" }, "saveAs": "tab" },
    { "tool": "safari_fill", "args": { "tabUrl": "{{tab.tabUrl}}", "selector": "{{usernameSelector}}", "value": "{{username}}" } },
    { "tool": "safari_fill", "args": { "tabUrl": "{{tab.tabUrl}}", "selector": "{{passwordSelector}}", "value": "{{password}}" } },
    { "tool": "safari_click", "args": { "tabUrl": "{{tab.tabUrl}}", "selector": "{{submitSelector}}" } },
    { "tool": "safari_wait_for", "args": { "tabUrl": "{{tab.tabUrl}}", "condition": "networkidle", "timeout": 10000 } }
  ]
}
```
