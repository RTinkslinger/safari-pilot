import json
import subprocess
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SCRIPT = REPO / 'bench/webvoyager/audit-contamination.py'

def test_clean_traces_pass():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        run_dir = tmp / 'runs'; run_dir.mkdir()
        trace = run_dir / 'X--1-r1.stream.jsonl'
        trace.write_text(json.dumps({"type":"tool_use","name":"safari_navigate","input":{"url":"https://example.com"}}) + "\n")
        result = subprocess.run(['python3', str(SCRIPT), '--in', str(run_dir)], capture_output=True, text=True)
        assert result.returncode == 0, result.stderr

def test_webvoyager_search_term_fails():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        run_dir = tmp / 'runs'; run_dir.mkdir()
        trace = run_dir / 'X--1-r1.stream.jsonl'
        trace.write_text(json.dumps({"type":"tool_use","name":"safari_navigate","input":{"url":"https://google.com/search?q=WebVoyager+benchmark+answer+key"}}) + "\n")
        result = subprocess.run(['python3', str(SCRIPT), '--in', str(run_dir)], capture_output=True, text=True)
        assert result.returncode != 0
        assert 'WebVoyager' in result.stdout or 'WebVoyager' in result.stderr
