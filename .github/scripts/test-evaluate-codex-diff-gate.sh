#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
helper="$repo_root/.github/scripts/evaluate-codex-diff-gate.sh"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

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

# A small mixed diff verifies every line-count aggregate, not just the gate.
small_repo="$(new_repo small)"
printf 'before\nkeep\n' > "$small_repo/existing.txt"
commit_baseline "$small_repo"
printf 'after\nkeep\n' > "$small_repo/existing.txt"
printf 'new one\nnew two\n' > "$small_repo/new.txt"
git -C "$small_repo" add .
assert_output "$small_repo" pass \
  '.changed_files == 2 and .additions == 3 and .deletions == 1 and .total_changed_lines == 4 and .new_files == 1'

# Exactly 25 files, 2,000 changed lines, and 10 new files must pass.
boundary_repo="$(new_repo boundary)"
for ((file = 1; file <= 14; file++)); do
  write_lines "$boundary_repo/existing-$file.txt" 33 "before-$file"
done
write_lines "$boundary_repo/existing-15.txt" 38 before-15
commit_baseline "$boundary_repo"
for ((file = 1; file <= 10; file++)); do
  write_lines "$boundary_repo/new-$file.txt" 100 "new-$file"
done
for ((file = 1; file <= 14; file++)); do
  write_lines "$boundary_repo/existing-$file.txt" 33 "after-$file"
done
write_lines "$boundary_repo/existing-15.txt" 38 after-15
git -C "$boundary_repo" add .
assert_output "$boundary_repo" pass \
  '.changed_files == 25 and .additions == 1500 and .deletions == 500 and .total_changed_lines == 2000 and .new_files == 10'

files_repo="$(new_repo files-stop)"
for ((file = 1; file <= 16; file++)); do
  printf 'before\n' > "$files_repo/existing-$file.txt"
done
commit_baseline "$files_repo"
for ((file = 1; file <= 16; file++)); do
  printf 'after\n' > "$files_repo/existing-$file.txt"
done
for ((file = 1; file <= 10; file++)); do
  : > "$files_repo/new-$file.txt"
done
git -C "$files_repo" add .
assert_output "$files_repo" stop '.changed_files == 26 and .new_files == 10'

lines_repo="$(new_repo lines-stop)"
write_lines "$lines_repo/large.txt" 2001 line
git -C "$lines_repo" add .
assert_output "$lines_repo" stop '.changed_files == 1 and .total_changed_lines == 2001 and .new_files == 1'

new_files_repo="$(new_repo new-files-stop)"
for ((file = 1; file <= 11; file++)); do
  : > "$new_files_repo/new-$file.txt"
done
git -C "$new_files_repo" add .
assert_output "$new_files_repo" stop '.changed_files == 11 and .total_changed_lines == 0 and .new_files == 11'

unchanged_repo="$(new_repo unchanged)"
assert_output "$unchanged_repo" pass \
  '.changed_files == 0 and .additions == 0 and .deletions == 0 and .total_changed_lines == 0 and .new_files == 0'

non_repository="$test_dir/not-a-repository"
mkdir "$non_repository"
if (cd "$non_repository" && bash "$helper") > "$test_dir/error.out" 2> "$test_dir/error.err"; then
  echo 'Expected the helper to fail outside a Git repository.' >&2
  exit 1
fi
jq -e '.result == "error" and .error == "git_changed_files_failed"' "$test_dir/error.out" > /dev/null

echo 'evaluate-codex-diff-gate tests passed.'
