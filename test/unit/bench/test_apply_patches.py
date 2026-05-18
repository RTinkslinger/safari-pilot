# test/unit/bench/test_apply_patches.py
import json
import subprocess
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SCRIPT = REPO / 'bench/webvoyager/apply-patches.py'

def test_substitute_replaces_field():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        dataset = tmp / 'tasks.jsonl'
        dataset.write_text(
            json.dumps({"id":"X--1","web_name":"X","web":"https://x","ques":"flight Jan 10-24, 2024"}) + "\n" +
            json.dumps({"id":"X--2","web_name":"X","web":"https://x","ques":"keep me"}) + "\n"
        )
        patches = tmp / 'patches.json'
        patches.write_text(json.dumps({
            "schema_version":"1","dataset_sha":"test","generated_date":"2026-05-14",
            "patches":{"X--1":{"action":"substitute","field":"ques","find":"Jan 10-24, 2024","replace":"Jan 10-24, 2027","rationale":"r"}}
        }))
        out_patched = tmp / 'patched.jsonl'
        out_comp = tmp / 'comparable.jsonl'
        result = subprocess.run(
            ['python3', str(SCRIPT),
             '--dataset', str(dataset), '--patches', str(patches),
             '--out-patched', str(out_patched), '--out-comparable', str(out_comp)],
            capture_output=True, text=True
        )
        assert result.returncode == 0, result.stderr
        patched = [json.loads(l) for l in out_patched.read_text().splitlines()]
        comparable = [json.loads(l) for l in out_comp.read_text().splitlines()]
        assert len(patched) == 2
        assert patched[0]['ques'] == 'flight Jan 10-24, 2027'
        assert patched[1]['ques'] == 'keep me'
        # comparable contains only tasks NOT touched by patches
        assert len(comparable) == 1
        assert comparable[0]['id'] == 'X--2'

def test_remove_action_drops_from_patched_and_comparable():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        dataset = tmp / 'tasks.jsonl'
        dataset.write_text(json.dumps({"id":"X--3","web_name":"X","web":"https://x","ques":"q"}) + "\n")
        patches = tmp / 'patches.json'
        patches.write_text(json.dumps({
            "schema_version":"1","dataset_sha":"test","generated_date":"2026-05-14",
            "patches":{"X--3":{"action":"remove","rationale":"r"}}
        }))
        out_patched = tmp / 'patched.jsonl'
        out_comp = tmp / 'comparable.jsonl'
        subprocess.run(['python3', str(SCRIPT),
            '--dataset', str(dataset), '--patches', str(patches),
            '--out-patched', str(out_patched), '--out-comparable', str(out_comp)],
            check=True
        )
        assert out_patched.read_text().strip() == ''
        assert out_comp.read_text().strip() == ''

def test_substitute_find_not_present_errors():
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        dataset = tmp / 'tasks.jsonl'
        dataset.write_text(json.dumps({"id":"X--4","web_name":"X","web":"https://x","ques":"text without target"}) + "\n")
        patches = tmp / 'patches.json'
        patches.write_text(json.dumps({
            "schema_version":"1","dataset_sha":"test","generated_date":"2026-05-14",
            "patches":{"X--4":{"action":"substitute","field":"ques","find":"NOT_FOUND","replace":"X","rationale":"r"}}
        }))
        result = subprocess.run(['python3', str(SCRIPT),
            '--dataset', str(dataset), '--patches', str(patches),
            '--out-patched', str(tmp/'p.jsonl'), '--out-comparable', str(tmp/'c.jsonl')],
            capture_output=True, text=True
        )
        assert result.returncode != 0
        assert 'NOT_FOUND' in result.stderr or 'find' in result.stderr.lower()
