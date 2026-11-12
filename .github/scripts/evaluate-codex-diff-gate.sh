#!/usr/bin/env bash
set -euo pipefail

readonly max_changed_files=25
readonly max_changed_lines=2000
readonly max_new_files=10

emit_contract() {
  printf '{"max_changed_files":%s,"max_changed_lines":%s,"max_new_files":%s}\n' \
    "$max_changed_files" "$max_changed_lines" "$max_new_files"
}

if [ "$#" -eq 1 ] && [ "$1" = --contract ]; then
  emit_contract
  exit 0
fi
if [ "$#" -ne 0 ]; then
  echo 'Usage: evaluate-codex-diff-gate.sh [--contract]' >&2
  exit 2
fi

# stdout is one JSON object. pass and stop exit 0; callers must use .result.
# error exits non-zero. A non-numeric numstat (including binary or -diff paths)
# cannot be measured safely, so it is an error rather than an omitted change.
work_dir=''

cleanup() {
  if [ -n "$work_dir" ]; then
    rm -rf "$work_dir"
  fi
}

emit_result() {
  local result="${1:?result is required}"
  local changed_files="${2:?changed files is required}"
  local additions="${3:?additions is required}"
  local deletions="${4:?deletions is required}"
  local total_changed_lines="${5:?total changed lines is required}"
  local new_files="${6:?new files is required}"
  local error="${7:-}"

  if [ -n "$error" ]; then
    printf '{"result":"%s","changed_files":%s,"additions":%s,"deletions":%s,"total_changed_lines":%s,"new_files":%s,"error":"%s"}\n' \
      "$result" "$changed_files" "$additions" "$deletions" "$total_changed_lines" "$new_files" "$error"
  else
    printf '{"result":"%s","changed_files":%s,"additions":%s,"deletions":%s,"total_changed_lines":%s,"new_files":%s}\n' \
      "$result" "$changed_files" "$additions" "$deletions" "$total_changed_lines" "$new_files"
  fi
}

fail_closed() {
  emit_result error 0 0 0 0 0 "${1:?error code is required}"
  exit 1
}

work_dir="$(mktemp -d)" || {
  emit_result error 0 0 0 0 0 temporary_directory_unavailable
  exit 1
}
trap cleanup EXIT

names_file="$work_dir/changed-names"
new_names_file="$work_dir/new-names"
numstat_file="$work_dir/numstat"

if ! git -c core.quotepath=true diff --cached --no-ext-diff --no-textconv --name-only -z > "$names_file"; then
  fail_closed git_changed_files_failed
fi
if ! git -c core.quotepath=true diff --cached --no-ext-diff --no-textconv --diff-filter=A --name-only -z > "$new_names_file"; then
  fail_closed git_new_files_failed
fi
if ! git -c core.quotepath=true diff --cached --no-ext-diff --no-textconv --numstat -z > "$numstat_file"; then
  fail_closed git_numstat_failed
fi

mapfile -d '' -t changed_names < "$names_file"
mapfile -d '' -t new_names < "$new_names_file"
changed_files="${#changed_names[@]}"
new_files="${#new_names[@]}"
python3 - "$numstat_file" "$changed_files" "$new_files" \
  "$max_changed_files" "$max_changed_lines" "$max_new_files" <<'PY'
import json
import sys

data = open(sys.argv[1], 'rb').read()
changed_files, new_files, max_files, max_lines, max_new = map(int, sys.argv[2:])
paths = []
path_bytes = 0
truncated = False
unknown = False
error = None
additions = deletions = 0

def record_path(raw):
    global path_bytes, truncated, unknown
    if not raw:
        unknown = True
        return
    # Count the JSON representation, including escapes, before publishing it.
    encoded = json.dumps(raw.decode('utf-8', 'backslashreplace'), ensure_ascii=True)
    size = len(encoded.encode('ascii'))
    if len(raw) > 256 or size > 512 or len(paths) >= 10 or path_bytes + size > 2048:
        truncated = True
        return
    paths.append(json.loads(encoded))
    path_bytes += size

rows = data.split(b'\0')
if rows.pop() != b'':
    unknown = True
    error = 'git_numstat_malformed'
i = 0
while i < len(rows):
    fields = rows[i].split(b'\t', 2)
    i += 1
    if len(fields) != 3:
        error = error or 'git_numstat_malformed'
        unknown = True
        continue
    added, deleted, path = fields
    if not path:
        # Git uses an empty header path followed by old/new NUL fields for renames.
        if i + 1 >= len(rows):
            error = error or 'git_numstat_malformed'
            unknown = True
            break
        path = rows[i + 1]
        i += 2
    if added == deleted == b'-':
        error = error or 'git_numstat_unavailable'
        record_path(path)
    elif not added.isdigit() or not deleted.isdigit() or not added or not deleted:
        error = error or 'git_numstat_malformed'
        record_path(path)
    else:
        additions += int(added)
        deletions += int(deleted)

result = dict(result='error' if error else 'pass', changed_files=changed_files,
              additions=additions, deletions=deletions,
              total_changed_lines=additions + deletions, new_files=new_files)
if error:
    # Error metrics are deliberately unavailable, including any numeric rows.
    result.update(changed_files=0, additions=0, deletions=0,
                  total_changed_lines=0, new_files=0, error=error,
                  offending_paths=paths, offending_paths_truncated=truncated,
                  offending_paths_unknown=unknown)
elif changed_files > max_files or additions + deletions > max_lines or new_files > max_new:
    result['result'] = 'stop'
print(json.dumps(result, ensure_ascii=True, separators=(',', ':')))
sys.exit(1 if error else 0)
PY
