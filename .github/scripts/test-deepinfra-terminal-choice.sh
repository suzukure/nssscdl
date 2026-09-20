#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repo_root/.github/scripts/deepinfra-investigator.py"

SCRIPT="$script" python3 - <<'PY'
import importlib.util
import json
import os
from pathlib import Path

path = Path(os.environ["SCRIPT"])
spec = importlib.util.spec_from_file_location("investigator_terminal_choice", path)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class FakeResponse:
    def __enter__(self):
        return self
    def __exit__(self, exc_type, exc, tb):
        return False
    def read(self):
        return b'{"choices":[{"message":{"tool_calls":[{"id":"x","function":{"name":"submit_analysis","arguments":"{}"}}]}}]}'

seen = []
def fake_urlopen(request, timeout=90):
    seen.append(json.loads(request.data.decode()))
    return FakeResponse()

original = m.urllib.request.urlopen
m.urllib.request.urlopen = fake_urlopen
os.environ["DEEPINFRA_API_KEY"] = "fixture-key-value"

submit = [t for t in m.tool_defs() if t["function"]["name"] == "submit_analysis"]
normal = m.tool_defs()

m.call_chat("deepseek-ai/DeepSeek-V4-Flash-0731", [{"role":"user","content":"x"}], normal)
m.call_chat("deepseek-ai/DeepSeek-V4-Flash-0731", [{"role":"user","content":"x"}], submit)

assert seen[0]["tool_choice"] == "required"
assert seen[1]["tool_choice"] == {
    "type": "function",
    "function": {"name": "submit_analysis"},
}
assert [t["function"]["name"] for t in seen[1]["tools"]] == ["submit_analysis"]

m.urllib.request.urlopen = original
print("DeepInfra terminal tool-choice fixture tests passed.")
PY
