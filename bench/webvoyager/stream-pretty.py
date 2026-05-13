#!/usr/bin/env python3
"""Pretty-print claude --output-format stream-json for live tool-call visibility."""
import json, sys, time

start = time.time()

def t():
    return f"[{time.time()-start:6.1f}s]"

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        d = json.loads(line)
    except Exception as e:
        print(f"{t()} <non-json> {line[:200]}", flush=True)
        continue

    ev = d.get("type", "?")

    if ev == "system":
        sub = d.get("subtype", "?")
        if sub == "init":
            tools = d.get("tools", [])
            print(f"{t()} system/init  tools_available={len(tools)}  model={d.get('model')}", flush=True)
        else:
            print(f"{t()} system/{sub}  {json.dumps(d)[:200]}", flush=True)

    elif ev == "assistant":
        msg = d.get("message", {})
        for c in msg.get("content", []):
            ctype = c.get("type")
            if ctype == "text":
                txt = c.get("text", "").strip()
                if txt:
                    print(f"{t()} agent.text:  {txt[:400]}", flush=True)
            elif ctype == "tool_use":
                name = c.get("name", "?")
                inp = c.get("input", {})
                inp_str = json.dumps(inp)[:300]
                print(f"{t()} TOOL→ {name}({inp_str})", flush=True)
            elif ctype == "thinking":
                think = c.get("thinking", "").strip()
                if think:
                    print(f"{t()} agent.think: {think[:300]}", flush=True)

    elif ev == "user":
        msg = d.get("message", {})
        for c in msg.get("content", []):
            if c.get("type") == "tool_result":
                content = c.get("content", "")
                if isinstance(content, list):
                    content = " ".join([cc.get("text", "") for cc in content if cc.get("type") == "text"])
                is_err = c.get("is_error", False)
                tag = "TOOL✗" if is_err else "TOOL✓"
                excerpt = str(content)[:300].replace('\n', ' ')
                print(f"{t()} {tag}: {excerpt}", flush=True)

    elif ev == "result":
        st = d.get("subtype", "?")
        print(f"{t()} ─── result/{st}  duration={d.get('duration_ms','?')}ms  cost=${d.get('total_cost_usd','?')}  turns={d.get('num_turns','?')}", flush=True)
        if "result" in d:
            print(f"{t()} FINAL: {d['result'][:600]}", flush=True)

    else:
        print(f"{t()} <{ev}>  {json.dumps(d)[:200]}", flush=True)
