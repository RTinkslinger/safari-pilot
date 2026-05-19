"""TDD for v0.1.37 fix #1 — bench prompt template must specify the MCP
tool name prefix `mcp__safari__` explicitly, so agents performing
ToolSearch use `select:mcp__safari__safari_new_tab` rather than the bare
`select:safari_new_tab` (which matches nothing and triggers the
"safari tools not available" abstain path).

Root-cause data (bench-runs/v0136-probes, 2026-05-19 systematic scan):
8 of 22 SP-lost-while-PW-won cases failed because the agent did exactly
this — searched for bare tool names, found nothing, abstained without
ever calling safari_new_tab. Tasks affected:
  Allrecipes--0, --1, --2, --6, --8
  Amazon--10
  Coursera--0
  ESPN--8

Tests are anchored beyond pure-substring presence (per test-reviewer
findings 2026-05-19): each assertion requires the prefix mention,
example, and warning to be co-located with the ToolSearch / safari_*
domain, AND reference real tool names — not arbitrary stand-ins.
"""
import re
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
PROMPT = REPO / "bench" / "webvoyager" / "prompt-template.md"

# Real safari_* tool names the prompt actually instructs the agent to
# use (sourced from the existing prompt template's imperative steps and
# the production tool surface).
REAL_TOOLS = {
    "safari_new_tab", "safari_snapshot", "safari_take_screenshot",
    "safari_navigate", "safari_get_text", "safari_click",
    "safari_query_all", "safari_evaluate", "safari_batch",
    "safari_wait_for", "safari_tool_search", "safari_list_tabs",
    "safari_compose_final_evidence", "safari_dismiss_overlays",
    "safari_get_page_info", "safari_extract_text_window",
}


def test_prompt_exists() -> None:
    assert PROMPT.exists(), f"prompt template not at {PROMPT}"


def test_prompt_specifies_mcp_namespace_prefix_near_toolsearch() -> None:
    """The `mcp__safari__` prefix mention must appear near the
    ToolSearch instruction — a single bare substring buried at the end
    of the file teaches the agent nothing. Anchored to context."""
    text = PROMPT.read_text()
    assert "mcp__safari__" in text, "prompt template must mention the `mcp__safari__` namespace prefix"

    # Find all positions of the prefix and at least one must be within
    # 500 characters of a ToolSearch / safari_tool_search reference.
    prefix_positions = [m.start() for m in re.finditer(r"mcp__safari__", text)]
    anchor_positions = [m.start() for m in re.finditer(r"ToolSearch|safari_tool_search", text)]
    assert anchor_positions, "prompt must mention ToolSearch/safari_tool_search somewhere"
    close = any(
        abs(p - a) <= 500
        for p in prefix_positions
        for a in anchor_positions
    )
    assert close, (
        "the `mcp__safari__` prefix mention must appear within 500 chars "
        "of a ToolSearch/safari_tool_search reference — otherwise it's a "
        "buried footnote the agent won't connect to the search behaviour."
    )


def test_prompt_example_references_real_tool() -> None:
    """The `select:mcp__safari__safari_<name>` example must reference a
    real safari_* tool — not `safari_foo` or `safari_x`. An invalid
    example trains the agent to copy garbage."""
    text = PROMPT.read_text()
    pattern = re.compile(r"select:\s*mcp__safari__(safari_[a-z_]+)", re.IGNORECASE)
    matches = pattern.findall(text)
    assert matches, (
        "prompt must include at least one concrete "
        "`select:mcp__safari__safari_<real_tool>` example."
    )
    real_matches = [m for m in matches if m.lower() in REAL_TOOLS]
    assert real_matches, (
        f"the prompt's select-example tool name(s) {matches!r} must "
        f"include at least one real safari_* tool from {sorted(REAL_TOOLS)!r}. "
        f"A stub like `safari_foo` doesn't teach the agent a usable pattern."
    )


def test_prompt_warns_about_bare_names_anchored_to_safari_domain() -> None:
    """The warning that bare `safari_*` names fail ToolSearch must be
    anchored to the safari/ToolSearch domain — not a generic 'use the
    full name' sentence that could be about anything else."""
    text = PROMPT.read_text()
    text_lower = text.lower()
    triggers = ["mcp__safari__ prefix", "without the prefix", "bare safari_", "namespace prefix"]
    # The warning phrase must appear AND co-occur with "safari" or
    # "ToolSearch" / "select:" within 200 chars — a free-floating
    # "use the full name" disconnected from the safari domain doesn't
    # gate the bug.
    found_anchored = False
    for trig in triggers:
        for m in re.finditer(re.escape(trig), text_lower):
            window_start = max(0, m.start() - 200)
            window_end = min(len(text_lower), m.end() + 200)
            window = text_lower[window_start:window_end]
            if "safari_" in window or "toolsearch" in window or "select:" in window:
                found_anchored = True
                break
        if found_anchored:
            break
    assert found_anchored, (
        f"prompt should include a warning phrase from {triggers!r} "
        f"co-located (within 200 chars) with `safari_`, `ToolSearch`, "
        f"or `select:`."
    )


def test_prompt_imperative_steps_do_not_contradict_prefix_guidance() -> None:
    """Steps 1-6 of the prompt instruct the agent to call safari tools
    by bare name ('Open a new tab using safari_new_tab'). After the
    fix, either (a) those imperatives must be rewritten to use the full
    `mcp__safari__safari_*` form, OR (b) the namespace explanation must
    appear BEFORE the first bare-name imperative so the agent reads the
    prefix rule before it reads the bare names. Otherwise the imperative
    block trains the agent to use bare names regardless of what the
    explanation says."""
    text = PROMPT.read_text()
    # Find the first occurrence of a bare safari_* imperative (a bare
    # tool name not preceded by `mcp__safari__`).
    bare_pattern = re.compile(r"(?<!mcp__safari__)\bsafari_(?:new_tab|snapshot|take_screenshot|navigate|get_text|click|query_all|evaluate|batch|wait_for|tool_search|list_tabs|compose_final_evidence)\b")
    bare_matches = list(bare_pattern.finditer(text))
    if not bare_matches:
        # Option (a): all imperatives use the full prefix.
        return
    # Option (b): the namespace explanation must precede the first bare imperative.
    first_bare = bare_matches[0].start()
    prefix_explanation_pattern = re.compile(r"mcp__safari__", re.IGNORECASE)
    explanation_positions = [m.start() for m in prefix_explanation_pattern.finditer(text)]
    if not explanation_positions:
        raise AssertionError("no namespace explanation found in prompt")
    earliest_explanation = min(explanation_positions)
    assert earliest_explanation < first_bare, (
        f"the namespace explanation (`mcp__safari__` mention at pos "
        f"{earliest_explanation}) must appear BEFORE the first bare "
        f"safari_* imperative (at pos {first_bare}). Otherwise the "
        f"imperatives teach the agent bare-name usage before it ever "
        f"reads the prefix rule, which is exactly the bug we're fixing."
    )
