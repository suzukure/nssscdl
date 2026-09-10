#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$repo_root/.github/scripts/evaluate-codex-diff-gate.sh"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

readonly max_changed_files=25
readonly max_changed_lines=2000
readonly max_new_files=10

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
  local output
  if output="$(cd "$directory" && bash "$helper")"; then
    echo "Expected the helper to fail closed in $directory." >&2
    exit 1
  fi
  jq -e --arg error "$expected_error" \
    '.result == "error" and .error == $error' <<< "$output" > /dev/null
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
assert_error "$attributes_repo" git_numstat_unavailable

# True binary data likewise has no trustworthy line count and must fail closed.
binary_repo="$(new_repo binary)"
printf 'baseline\n' > "$binary_repo/baseline.txt"
commit_baseline "$binary_repo"
printf '\000\001\002\003' > "$binary_repo/binary.dat"
git -C "$binary_repo" add .
assert_error "$binary_repo" git_numstat_unavailable

non_repository="$test_dir/not-a-repository"
mkdir "$non_repository"
if (cd "$non_repository" && bash "$helper") > "$test_dir/error.out" 2> "$test_dir/error.err"; then
  echo 'Expected the helper to fail outside a Git repository.' >&2
  exit 1
fi
jq -e '.result == "error" and .error == "git_changed_files_failed"' "$test_dir/error.out" > /dev/null

echo 'evaluate-codex-diff-gate tests passed.'
