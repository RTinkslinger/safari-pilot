---
name: paginate-and-scrape
description: Scrape a list of items across multiple paginated pages and return them concatenated. Use when items span pages joined by a "next" link.
triggers:
  - paginate
  - all pages
  - across pages
inputs:
  - tabUrl
  - itemSelector
  - nextSelector
  - maxPages
---

```json
{
  "steps": [
    { "tool": "safari_paginate_scrape", "args": { "tabUrl": "{{tabUrl}}", "itemSelector": "{{itemSelector}}", "nextSelector": "{{nextSelector}}", "maxPages": "{{maxPages}}" } }
  ]
}
```
