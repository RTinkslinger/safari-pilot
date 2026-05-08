---
name: visible-evidence-grounding
description: Rules for grounding answers in current visible page content, not prior knowledge. Use when answering factual questions about a specific web page where the answer must be verifiable from what's currently rendered.
triggers:
  - what does the page say
  - find on the page
  - according to the website
  - extract the answer
  - what's the price
  - what's the latest
---

When answering questions about a web page's contents:

**Ground in what's visible NOW, not prior knowledge.**
- The answer must come from the current DOM or visible viewport.
- If you "know" the answer from training data but the page doesn't show it, the page is the truth — your prior is suspect (sites change).
- Discontinued features, removed pages, updated facts: trust the page.

**Before stating a fact, verify with extraction.**
- Use `safari_get_text` or `safari_evaluate` to read the relevant DOM section.
- Quote or paraphrase the extracted content. Don't synthesize from memory.
- If the extraction was empty or generic, invoke dismiss-overlays-recovery.

**Be honest about gaps.**
- If the page doesn't contain the answer, say so. Don't infer from related content. Don't make up a plausible answer.
- If the page contradicts your prior, the page wins.
- If extraction failed and recovery didn't help, return UNKNOWN with reason.

**Never paraphrase a fact you didn't extract.**
- Don't claim "Morningstar provides BBC market data" if the page says the feed was discontinued. The page is authoritative.
- Don't answer "the latest iPhone has 4 colors" without a safari_get_text confirming all four color names are visible on the page.
