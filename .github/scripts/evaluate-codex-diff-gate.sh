#!/usr/bin/env bash
set -euo pipefail

readonly max_changed_files=25
readonly max_changed_lines=2000
readonly max_new_files=10

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
if ! git -c core.quotepath=true diff --cached --no-ext-diff --no-textconv --numstat > "$numstat_file"; then
  fail_closed git_numstat_failed
fi

mapfile -d '' -t changed_names < "$names_file"
mapfile -d '' -t new_names < "$new_names_file"
changed_files="${#changed_names[@]}"
new_files="${#new_names[@]}"
additions=0
deletions=0

while IFS=$'\t' read -r added deleted _path; do
  # Attributes supplied by the staged diff can also produce "-\t-". Do not
  # omit such paths: fail closed because total_changed_lines is unknowable.
  if [ "$added" = '-' ] && [ "$deleted" = '-' ]; then
    fail_closed git_numstat_unavailable
  fi
  if [[ ! "$added" =~ ^[0-9]+$ ]] || [[ ! "$deleted" =~ ^[0-9]+$ ]]; then
    fail_closed git_numstat_malformed
  fi
  additions=$((additions + added))
  deletions=$((deletions + deleted))
done < "$numstat_file"

total_changed_lines=$((additions + deletions))
if [ "$changed_files" -gt "$max_changed_files" ] \
    || [ "$total_changed_lines" -gt "$max_changed_lines" ] \
    || [ "$new_files" -gt "$max_new_files" ]; then
  emit_result stop "$changed_files" "$additions" "$deletions" "$total_changed_lines" "$new_files"
else
  emit_result pass "$changed_files" "$additions" "$deletions" "$total_changed_lines" "$new_files"
fi
