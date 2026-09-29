#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$repo_root/.github/scripts/evaluate-codex-diff-gate.sh"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

readonly max_changed_files=25
readonly max_changed_lines=2000
readonly max_new_files=10

contract_output="$(bash "$helper" --contract)"
jq -e '
  . == {
    max_changed_files: 25,
    max_changed_lines: 2000,
    max_new_files: 10
  }
' <<< "$contract_output" > /dev/null

assert_contract_usage_error() {
  local output_file="$1"
  local error_file="$2"
  local status
  shift 2
  set +e
  bash "$helper" "$@" > "$output_file" 2> "$error_file"
  status=$?
  set -e
  if [ "$status" -eq 0 ]; then
    echo "Expected --contract misuse to fail: $*" >&2
    exit 1
  fi
  [ "$status" -eq 2 ]
  [ ! -s "$output_file" ]
  grep -Fxq 'Usage: evaluate-codex-diff-gate.sh [--contract]' "$error_file"
}

assert_contract_usage_error "$test_dir/unknown-contract.out" "$test_dir/unknown-contract.err" --unknown
assert_contract_usage_error "$test_dir/repeated-contract.out" "$test_dir/repeated-contract.err" --contract --contract

new_repo() {
  local name="${1:?repository name is required}"
  local directory
  directory="$(mktemp -d "$test_dir/$name.XXXXXX")"
  git init -q "$directory"
  git -C "$directory" config user.name 'Diff gate test'
  git -C "$directory" config user.email 'diff-gate-test@example.invalid'
  printf '%s\n' "$directory"
}

write_lines() {
  local path="${1:?path is required}"
  local line_count="${2:?line count is required}"
  local prefix="${3:?prefix is required}"
  local line
  : > "$path"
  for ((line = 1; line <= line_count; line++)); do
    printf '%s %s\n' "$prefix" "$line" >> "$path"
  done
}

commit_baseline() {
  local directory="${1:?directory is required}"
  git -C "$directory" add .
  git -C "$directory" commit -q -m baseline
}

assert_output() {
  local directory="${1:?directory is required}"
  local expected_result="${2:?expected result is required}"
  local assertion="${3:?jq assertion is required}"
  local output
  output="$(cd "$directory" && bash "$helper")"
  jq -e --arg result "$expected_result" ".result == \$result and ($assertion)" <<< "$output" > /dev/null
}

assert_error() {
  local directory="${1:?directory is required}"
  local expected_error="${2:?expected error is required}"
  local assertion="${3:-true}"
  local output
  if output="$(cd "$directory" && bash "$helper")"; then
    echo "Expected the helper to fail closed in $directory." >&2
    exit 1
  fi
  jq -e --arg error "$expected_error" \
    ".result == \"error\" and .error == \$error and ($assertion)" <<< "$output" > /dev/null
}

# A small mixed diff verifies every line-count aggregate, not just the gate.
small_repo="$(new_repo small)"
printf 'before\nkeep\n' > "$small_repo/existing.txt"
commit_baseline "$small_repo"
printf 'after\nkeep\n' > "$small_repo/existing.txt"
printf 'new one\nnew two\n' > "$small_repo/new.txt"
git -C "$small_repo" add .
assert_output "$small_repo" pass \
  '.changed_files == 2 and .additions == 3 and .deletions == 1 and .total_changed_lines == 4 and .new_files == 1'

# Python imports can create bytecode during either AI Developer path. The
# repository ignore rules must keep it out of git add -A and the staged gate.
cache_repo="$(new_repo bytecode-cache)"
git -C "$cache_repo" config core.excludesFile /dev/null
cp "$repo_root/.gitignore" "$cache_repo/.gitignore"
printf 'value = 1\n' > "$cache_repo/module.py"
printf 'before\n' > "$cache_repo/intended.txt"
commit_baseline "$cache_repo"
env -u PYTHONDONTWRITEBYTECODE python3 - "$cache_repo/module.py" <<'PY'
import importlib.util
import sys

spec = importlib.util.spec_from_file_location('fixture_module', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.value == 1
PY
cache_file="$(find "$cache_repo/__pycache__" -name '*.pyc' -print -quit)"
[ -n "$cache_file" ]
cp "$cache_file" "$cache_repo/standalone.pyc"
cp "$cache_file" "$cache_repo/legacy.pyo"
printf 'after\n' > "$cache_repo/intended.txt"
git -C "$cache_repo" add -A
[ "$(git -C "$cache_repo" diff --cached --name-only)" = intended.txt ]
assert_output "$cache_repo" pass \
  '.changed_files == 1 and .additions == 1 and .deletions == 1 and .total_changed_lines == 2 and .new_files == 0'
printf '\000\001\002\003' > "$cache_repo/unrelated.bin"
git -C "$cache_repo" add -A
assert_error "$cache_repo" git_numstat_unavailable \
  '.offending_paths == ["unrelated.bin"] and .offending_paths_truncated == false'

# NUL numstat uses separate old/new path fields for a detected rename.
rename_repo="$(new_repo rename)"
printf 'renamed text\n' > "$rename_repo/old.txt"
commit_baseline "$rename_repo"
git -C "$rename_repo" mv old.txt new.txt
assert_output "$rename_repo" pass '.changed_files == 1 and .total_changed_lines == 0'

# Exactly each threshold must pass. The boundary is max_new_files new files
# plus the remaining changed files as modifications. Each new file adds 100
# lines; modified files contribute equal additions and deletions to fill the
# remaining total.
boundary_repo="$(new_repo boundary)"
readonly boundary_new_file_lines=100
readonly boundary_modified_files=$((max_changed_files - max_new_files))
readonly boundary_modified_total_lines=$((max_changed_lines - max_new_files * boundary_new_file_lines))
readonly boundary_modified_additions=$((boundary_modified_total_lines / 2))
readonly boundary_modified_full_file_lines=$((boundary_modified_additions / boundary_modified_files))
readonly boundary_modified_remainder=$((boundary_modified_additions % boundary_modified_files))
for ((file = 1; file < boundary_modified_files; file++)); do
  write_lines "$boundary_repo/existing-$file.txt" "$boundary_modified_full_file_lines" "before-$file"
done
write_lines "$boundary_repo/existing-$boundary_modified_files.txt" \
  "$((boundary_modified_full_file_lines + boundary_modified_remainder))" "before-$boundary_modified_files"
commit_baseline "$boundary_repo"
for ((file = 1; file <= max_new_files; file++)); do
  write_lines "$boundary_repo/new-$file.txt" "$boundary_new_file_lines" "new-$file"
done
for ((file = 1; file < boundary_modified_files; file++)); do
  write_lines "$boundary_repo/existing-$file.txt" "$boundary_modified_full_file_lines" "after-$file"
done
write_lines "$boundary_repo/existing-$boundary_modified_files.txt" \
  "$((boundary_modified_full_file_lines + boundary_modified_remainder))" "after-$boundary_modified_files"
git -C "$boundary_repo" add .
assert_output "$boundary_repo" pass \
  ".changed_files == $max_changed_files and .additions == $((max_new_files * boundary_new_file_lines + boundary_modified_additions)) and .deletions == $boundary_modified_additions and .total_changed_lines == $max_changed_lines and .new_files == $max_new_files"

# Exceed only changed files; line and new-file totals remain within bounds.
files_repo="$(new_repo files-stop)"
readonly files_stop_modified_files=$((max_changed_files - max_new_files + 1))
for ((file = 1; file <= files_stop_modified_files; file++)); do
  printf 'before\n' > "$files_repo/existing-$file.txt"
done
commit_baseline "$files_repo"
for ((file = 1; file <= files_stop_modified_files; file++)); do
  printf 'after\n' > "$files_repo/existing-$file.txt"
done
for ((file = 1; file <= max_new_files; file++)); do
  : > "$files_repo/new-$file.txt"
done
git -C "$files_repo" add .
assert_output "$files_repo" stop ".changed_files == $((max_changed_files + 1)) and .new_files == $max_new_files"

# Exceed only total changed lines in a repository with a baseline commit.
lines_repo="$(new_repo lines-stop)"
printf 'before\n' > "$lines_repo/large.txt"
commit_baseline "$lines_repo"
write_lines "$lines_repo/large.txt" "$max_changed_lines" line
git -C "$lines_repo" add .
assert_output "$lines_repo" stop ".changed_files == 1 and .total_changed_lines == $((max_changed_lines + 1)) and .new_files == 0"

# Exceed only new files in a repository with a baseline commit.
new_files_repo="$(new_repo new-files-stop)"
printf 'baseline\n' > "$new_files_repo/baseline.txt"
commit_baseline "$new_files_repo"
for ((file = 1; file <= max_new_files + 1; file++)); do
  : > "$new_files_repo/new-$file.txt"
done
git -C "$new_files_repo" add .
assert_output "$new_files_repo" stop ".changed_files == $((max_new_files + 1)) and .total_changed_lines == 0 and .new_files == $((max_new_files + 1))"

# A normal repository with a baseline and an empty staged diff must pass.
unchanged_repo="$(new_repo unchanged)"
printf 'baseline\n' > "$unchanged_repo/baseline.txt"
commit_baseline "$unchanged_repo"
assert_output "$unchanged_repo" pass \
  '.changed_files == 0 and .additions == 0 and .deletions == 0 and .total_changed_lines == 0 and .new_files == 0'

# A staged attribute must not hide an over-limit text change; unavailable
# numstat is a fail-closed error, which stops processing before a pass.
attributes_repo="$(new_repo attributes)"
printf 'before\n' > "$attributes_repo/large.txt"
commit_baseline "$attributes_repo"
printf '* -diff\n' > "$attributes_repo/.gitattributes"
write_lines "$attributes_repo/large.txt" "$((max_changed_lines + 1))" line
git -C "$attributes_repo" add .
assert_error "$attributes_repo" git_numstat_unavailable \
  '.offending_paths == [".gitattributes", "large.txt"] and .offending_paths_truncated == false and .offending_paths_unknown == false'

# True binary data likewise has no trustworthy line count and must fail closed.
binary_repo="$(new_repo binary)"
printf 'baseline\n' > "$binary_repo/baseline.txt"
commit_baseline "$binary_repo"
printf '\000\001\002\003' > "$binary_repo/binary.dat"
git -C "$binary_repo" add .
assert_error "$binary_repo" git_numstat_unavailable \
  '.offending_paths == ["binary.dat"] and .offending_paths_truncated == false and .offending_paths_unknown == false'

# Control bytes, a newline and non-ASCII must remain one escaped JSON record.
special_repo="$(new_repo special-path)"
printf 'baseline\n' > "$special_repo/baseline.txt"
commit_baseline "$special_repo"
special_name=$'bad\n\t\001-\303\251.bin'
printf '\000\001\002\003' > "$special_repo/$special_name"
git -C "$special_repo" add -A
assert_error "$special_repo" git_numstat_unavailable \
  '.offending_paths == ["bad\n\t\u0001-\u00e9.bin"] and .offending_paths_truncated == false'

# More offending paths than the diagnostic cap must still return error.
many_repo="$(new_repo many-binary)"
printf 'baseline\n' > "$many_repo/baseline.txt"
commit_baseline "$many_repo"
for ((file = 1; file <= 12; file++)); do
  printf '\000\001\002\003' > "$many_repo/binary-$file.dat"
done
git -C "$many_repo" add -A
assert_error "$many_repo" git_numstat_unavailable \
  '(.offending_paths | length) == 10 and .offending_paths_truncated == true and .offending_paths_unknown == false'

long_repo="$(new_repo long-path)"
printf 'baseline\n' > "$long_repo/baseline.txt"
commit_baseline "$long_repo"
mkdir "$long_repo/$(printf 'd%.0s' {1..250})"
printf '\000\001\002\003' > "$long_repo/$(printf 'd%.0s' {1..250})/binary.dat"
git -C "$long_repo" add -A
assert_error "$long_repo" git_numstat_unavailable \
  '.offending_paths == [] and .offending_paths_truncated == true'

# An invalid numeric field still identifies its staged path when present.
malformed_repo="$(new_repo malformed)"
printf 'baseline\n' > "$malformed_repo/baseline.txt"
commit_baseline "$malformed_repo"
printf 'change\n' > "$malformed_repo/baseline.txt"
git -C "$malformed_repo" add -A
mkdir "$test_dir/fake-bin"
cat > "$test_dir/fake-bin/git" <<'EOF'
#!/usr/bin/env bash
if [[ " $* " == *' --numstat -z '* ]]; then
  printf 'bad\t1\tbaseline.txt\0'
else
  exec "$REAL_GIT" "$@"
fi
EOF
chmod +x "$test_dir/fake-bin/git"
if malformed_output="$(cd "$malformed_repo" && PATH="$test_dir/fake-bin:$PATH" REAL_GIT="$(command -v git)" bash "$helper")"; then
  echo 'Expected malformed numstat to fail closed.' >&2
  exit 1
fi
jq -e '.result == "error" and .error == "git_numstat_malformed" and .offending_paths == ["baseline.txt"]' \
  <<< "$malformed_output" > /dev/null

non_repository="$test_dir/not-a-repository"
mkdir "$non_repository"
if (cd "$non_repository" && bash "$helper") > "$test_dir/error.out" 2> "$test_dir/error.err"; then
  echo 'Expected the helper to fail outside a Git repository.' >&2
  exit 1
fi
jq -e '.result == "error" and .error == "git_changed_files_failed"' "$test_dir/error.out" > /dev/null

echo 'evaluate-codex-diff-gate tests passed.'
