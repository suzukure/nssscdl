#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PYTHONDONTWRITEBYTECODE=1
python3 - "$repo_root" <<'PY'
import importlib.util
import io
import json
import math
import os
import pathlib
import sys
import tempfile
import urllib.error
from unittest.mock import patch

root = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('usage_fixture', root / '.github/scripts/deepinfra-investigator.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
model = 'deepseek-ai/DeepSeek-V4-Flash-0731'
usage = {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120, 'estimated_cost': 0.001}
private = 'fixture-secret-prompt-response-tool-error'
payload = {'model': model, 'messages': [{'role': 'user', 'content': private}]}

class Response:
    def __init__(self, value):
        self.value = value
    def __enter__(self):
        return self
    def __exit__(self, *args):
        return False
    def read(self):
        return self.value if isinstance(self.value, bytes) else json.dumps(self.value).encode()

with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {
    'DEEPINFRA_API_KEY': private,
    'DEEPINFRA_USAGE_PATH': str(pathlib.Path(tmp) / 'usage.json'),
    'DEEPINFRA_USAGE_KIND': 'investigator',
}):
    path = pathlib.Path(os.environ['DEEPINFRA_USAGE_PATH'])
    def reset():
        m._usage_sidecar = None
        path.unlink(missing_ok=True)
    def read():
        text = path.read_text()
        assert private not in text and 'Authorization' not in text and 'messages' not in text
        result = json.loads(text)
        assert set(result) == {
            'schema_version', 'usage_kind', 'model', 'request_count', 'response_count',
            'prompt_tokens', 'completion_tokens', 'total_tokens', 'provider_estimated_cost_usd',
            'usage_availability', 'missing_usage_response_count', 'request_error_count', 'requests',
        }
        assert result['schema_version'] == 1 and result['model'] == model
        for index, entry in enumerate(result['requests'], 1):
            assert set(entry) == {'request_index', 'response_received', 'error_reason_code', *m.USAGE_FIELDS}
            assert entry['request_index'] == index
        return result
    def request(value):
        def mock_open(req, timeout):
            pending = read()
            assert pending['requests'][-1]['response_received'] is False
            assert pending['requests'][-1]['provider_estimated_cost_usd'] is None
            assert timeout == 90 and json.loads(req.data) == payload
            return Response(value)
        with patch.object(m.urllib.request, 'urlopen', mock_open):
            return m.deepinfra_request(payload)
    def fail(exc, code, responses):
        before = read() if path.exists() else None
        with patch.object(m.urllib.request, 'urlopen', side_effect=exc) as opened:
            try:
                m.deepinfra_request(payload)
            except m.InvestigatorError:
                pass
            else:
                raise AssertionError('request must fail closed')
            assert opened.call_count == 1  # Telemetry adds no retries.
        result = read()
        assert result['request_error_count'] == 1
        assert result['response_count'] == responses
        assert result['requests'][-1]['error_reason_code'] == code
        if before:
            for field in m.USAGE_FIELDS:
                assert result[field] == before[field]
        return result

    # Single and multiple responses: only accounting fields survive.
    response = {'usage': {**usage, 'secret': private}, 'choices': [], 'model': private, 'text': private}
    assert request(response) == response
    result = read()
    assert result['usage_availability'] == 'complete'
    assert result['request_count'] == result['response_count'] == 1
    assert result['missing_usage_response_count'] == result['request_error_count'] == 0
    assert [result[field] for field in m.USAGE_FIELDS] == [100, 20, 120, 0.001]
    request(response)
    result = read()
    assert [result[field] for field in m.USAGE_FIELDS] == [200, 40, 240, 0.002]
    assert len(result['requests']) == 2

    # Real Investigator post-response protocol failure retains telemetry.
    reset()
    with patch.object(m.urllib.request, 'urlopen', return_value=Response(response)) as opened:
        try:
            m.investigate('owner/repo', 666, model, 'a' * 40)
        except m.InvestigatorError as exc:
            assert 'choice' in str(exc)
        else:
            raise AssertionError('invalid protocol was accepted')
        assert opened.call_count == 1
    assert read()['prompt_tokens'] == 100

    # Existing single protocol retry is recorded as two paid requests.
    reset()
    no_tools = {'usage': usage, 'choices': [{'message': {'content': private}}]}
    with patch.object(m.urllib.request, 'urlopen', return_value=Response(no_tools)) as opened:
        try:
            m.investigate('owner/repo', 666, model, 'a' * 40)
        except m.InvestigatorError as exc:
            assert 'after retry' in str(exc)
        else:
            raise AssertionError('invalid retry protocol was accepted')
        assert opened.call_count == 2
    assert read()['request_count'] == 2 and read()['total_tokens'] == 240

    # Budget termination switches to structured output; invalid final analysis
    # still preserves both responses, including the tool-result round.
    reset()
    tool_response = {'usage': usage, 'choices': [{'message': {'tool_calls': [{
        'id': 'read-1', 'function': {'name': 'read_file', 'arguments': '{}'},
    }]}}]}
    final_response = {'usage': usage, 'choices': [{'message': {'content': '{}'}}]}
    with patch.object(m, 'MAX_TOOL_CALLS', 1), patch.object(m, 'execute', return_value={'content': private}), \
         patch.object(m.urllib.request, 'urlopen', side_effect=[Response(tool_response), Response(final_response)]) as opened:
        try:
            m.investigate('owner/repo', 666, model, 'a' * 40)
        except m.InvestigatorError as exc:
            assert 'analysis' in str(exc)
        else:
            raise AssertionError('invalid final analysis accepted')
        assert opened.call_count == 2
        assert 'response_format' in json.loads(opened.call_args.args[0].data)
    assert read()['total_tokens'] == 240 and read()['usage_availability'] == 'complete'

    # Missing/invalid fields stay null; explicit zero remains available.
    for missing in ({}, {'usage': None}, {'usage': []}, {'usage': private}):
        reset()
        request(missing)
        result = read()
        assert result['usage_availability'] == 'unavailable'
        assert result['missing_usage_response_count'] == 1
        assert all(result[field] is None for field in m.USAGE_FIELDS)
        request(response)
        result = read()
        assert result['usage_availability'] == 'partial' and result['prompt_tokens'] == 100
        assert result['missing_usage_response_count'] == 1
    reset()
    request({'usage': {'prompt_tokens': 5, 'completion_tokens': False, 'total_tokens': '5', 'estimated_cost': -1}})
    result = read()
    assert result['usage_availability'] == 'partial' and result['prompt_tokens'] == 5
    assert all(result[field] is None for field in m.USAGE_FIELDS[1:])
    for invalid in (True, private, -1, math.nan, math.inf):
        reset()
        request({'usage': {key: invalid for key in usage}})
        assert all(read()[field] is None for field in m.USAGE_FIELDS)
    reset()
    request({'usage': {key: 0 for key in usage}})
    assert read()['usage_availability'] == 'complete'
    assert all(read()[field] == 0 for field in m.USAGE_FIELDS)

    # API failures preserve known accounting and store only bounded codes.
    reset()
    request(response)
    result = fail(urllib.error.HTTPError(m.API_URL, 429, private, {}, io.BytesIO(private.encode())), 'http_error', 1)
    assert result['usage_availability'] == 'partial' and result['prompt_tokens'] == 100
    reset()
    result = fail(urllib.error.URLError(private), 'network_error', 0)
    assert result['usage_availability'] == 'unavailable'
    for raw, reason in ((b'not JSON', 'invalid_json'), (b'\xff', 'response_read_error'), ([], 'invalid_response')):
        reset()
        with patch.object(m.urllib.request, 'urlopen', return_value=Response(raw)):
            try:
                m.deepinfra_request(payload)
            except m.InvestigatorError:
                pass
            else:
                raise AssertionError('invalid response accepted')
        result = read()
        assert result['response_count'] == result['missing_usage_response_count'] == 1
        assert result['request_error_count'] == 1 and result['requests'][0]['error_reason_code'] == reason

    # Caller/result-writing failures cannot roll back the saved sidecar.
    reset()
    request(response)
    before = path.read_bytes()
    try:
        (pathlib.Path(tmp) / 'absent' / 'result.json').write_text(private)
    except OSError:
        pass
    assert path.read_bytes() == before
    # Atomic replacement failure leaves the last durable telemetry intact.
    with patch.object(m.os, 'replace', side_effect=OSError(private)):
        try:
            request(response)
        except m.InvestigatorError as exc:
            assert str(exc) == 'DeepInfra usage sidecar write failed'
        else:
            raise AssertionError('sidecar failure was ignored')
    assert path.read_bytes() == before
    assert not list(path.parent.glob('.deepinfra-usage-*'))

    # Configuration/write failures stop before payment; no data-derived identity.
    reset()
    for config in ({'DEEPINFRA_USAGE_KIND': private}, {'DEEPINFRA_USAGE_PATH': ''},
                   {'DEEPINFRA_USAGE_PATH': str(path.parent / 'absent' / 'usage.json')}):
        with patch.dict(os.environ, config), patch.object(m.urllib.request, 'urlopen') as opened:
            m._usage_sidecar = None
            try:
                m.deepinfra_request(payload)
            except m.InvestigatorError:
                pass
            else:
                raise AssertionError('invalid sidecar configuration accepted')
            opened.assert_not_called()
    reset()
    with patch.object(m.urllib.request, 'urlopen') as opened:
        try:
            m.deepinfra_request({**payload, 'model': private})
        except m.InvestigatorError:
            pass
        else:
            raise AssertionError('untrusted model copied')
        opened.assert_not_called()

# All four workflow producers use the same artifact contract and paid-step scope.
for name, kind in [('investigator', 'investigator'), ('review-benchmark', 'review_benchmark'),
                   ('diagnostic-a', 'diagnostic_a'), ('diagnostic-b', 'diagnostic_b')]:
    source = (root / f'.github/workflows/deepinfra-{name}.yml').read_text()
    paid, upload = source.split('      - name: Upload DeepInfra usage\n')
    assert paid.count('          DEEPINFRA_USAGE_PATH: ${{ runner.temp }}/deepinfra-usage.json') == 1
    assert paid.count(f'          DEEPINFRA_USAGE_KIND: {kind}') == 1
    assert paid.count('          DEEPINFRA_API_KEY: ${{ secrets.DEEPINFRA_API_KEY }}') == 1
    block = upload.split('      - name: Upload ', 1)[0]
    assert '        if: always()\n' in block
    assert 'actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02' in block
    assert f'          name: deepinfra-usage-{kind}-${{{{ github.run_id }}}}-${{{{ github.run_attempt }}}}\n' in block
    assert '          path: ${{ runner.temp }}/deepinfra-usage.json\n' in block
    assert '          retention-days: 7\n' in block
    assert '          if-no-files-found: warn\n' in block
    assert 'secrets.' not in block and 'RESULT_' not in block

# Check telemetry model IDs remain aligned with the existing execution allowlists.
spec = importlib.util.spec_from_file_location('benchmark_fixture', root / '.github/scripts/deepinfra-review-benchmark.py')
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)
assert m.USAGE_MODELS == m.ALLOWED_MODELS | set(benchmark.MODEL_PRICES_PER_MILLION)
print('DeepInfra usage telemetry fixture tests passed.')
PY
