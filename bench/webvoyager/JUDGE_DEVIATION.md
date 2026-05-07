# Judge Deviations from Upstream WebVoyager

We re-implement upstream `auto_eval.py` (commit pinned in `DATASET_COMMIT`) in TypeScript so we can run the judge against `claude -p` outputs. We aim for byte-for-byte fidelity. The deviations below are intentional and documented for reproducibility.

## Deviation 1: Single final screenshot vs upstream's per-step trajectory

**Upstream:** sends N images to the judge — one screenshot captured at each step of the agent's run, plus a final "Your verdict:" cap. The number of screenshots is task-dependent (typically 5–15 per task).

**Ours:** sends exactly 1 image — a final-state screenshot captured by `bench/webvoyager/mcp-direct.ts` after `claude -p` exits. We pass `<num> = 1` into the user prompt.

**Why:** `claude -p` (Max-subscription headless) does not expose per-step intermediate trajectory in any structured form. We can only post-hoc capture the final Safari state. Reconstructing the trajectory from the chat transcript would require a separate parser and would not produce browser-state screenshots, so it would not satisfy the upstream contract anyway.

**Impact:** judge accuracy on tasks where intermediate state matters (e.g. "did the agent navigate through page X before answering?") will tend toward UNKNOWN since the judge can't see intermediate states. We accept this — our metric is final-state success on real-world sites, which is what users see. Tasks where the answer is fully derivable from the final state are unaffected.

## All other behavior matches upstream verbatim

- SYSTEM_PROMPT: copied byte-for-byte to `judge-system-prompt.txt`
- USER_PROMPT: copied byte-for-byte to `judge-user-prompt.txt` (placeholders `<task>`, `<answer>`, `<num>` preserved)
- Verdict parsing: `'NOT SUCCESS' in response` → FAILURE; else `'SUCCESS' in response` → SUCCESS; else UNKNOWN. (Same order as upstream lines 130-132.)
- Message structure: `[{role: system, content: SYSTEM_PROMPT}, {role: user, content: [{text: filled USER_PROMPT}, {image_url: ...}, {text: "Your verdict:\n"}]}]`
- OpenAI params: `model='gpt-4o'`, `seed=42`, `temperature=0`, `max_tokens=1000` (parity with upstream lines 99-100)
