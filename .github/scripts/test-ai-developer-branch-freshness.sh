#!/usr/bin/env bash
set -euo pipefail

repo_root="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
workflow="$repo_root/.github/workflows/ai-developer.yml"
test_dir="$(mktemp -d)"
trap 'rm -rf "$test_dir"' EXIT

# Run the actual pre-Codex branch gate against local Git remotes. Keep its
# extraction bounded by the next workflow step so a missing gate fails closed.
step="$test_dir/step"
awk '
  $0 == "      - name: Prepare branch and Issue context" { in_step = 1; next }
  in_step && /^      - name: / { exit }
  in_step { print }
' "$workflow" > "$step"
grep -Fqx '          PRE_WRITE_REMOTE_HEAD: ${{ steps.remote-head.outputs.head }}' "$step"
gate="$test_dir/gate.sh"
awk '
  /          git fetch origin refs\/heads\/main:refs\/remotes\/origin\/main/ {
    print substr($0, 11); getline; print substr($0, 11)
    print "printf \"%s\\n\" \"$base_sha\" > \"$GITHUB_OUTPUT\""
  }
  /          branch="ai\/issue-\$\{ISSUE_NUMBER\}"/ { in_gate = 1 }
  in_gate { print substr($0, 11) }
  in_gate && /          echo "AI_BRANCH=\$branch" >> "\$GITHUB_ENV"/ { exit }
' "$step" > "$gate"
grep -Fqx 'base_sha="$(git rev-parse --verify '\''refs/remotes/origin/main^{commit}'\'')"' "$gate"
grep -Fq 'if ! git merge-base --is-ancestor "$base_sha" HEAD; then' "$gate"
grep -Fq 'echo "AI_BRANCH=$branch" >> "$GITHUB_ENV"' "$gate"
if grep -Eq 'git (merge |rebase |reset |push )' "$gate"; then
  echo 'Branch freshness gate must not write the remote or synchronize history.' >&2
  exit 1
fi
printf '%s\n' 'echo paid-codex-reached >> "$GITHUB_ENV"' >> "$gate"

for scenario in absent fresh stale; do
  case_dir="$test_dir/$scenario"
  mkdir -p "$case_dir"
  git init --bare -q "$case_dir/origin.git"
  git -C "$case_dir/origin.git" symbolic-ref HEAD refs/heads/main
  git clone -q "$case_dir/origin.git" "$case_dir/seed"
  git -C "$case_dir/seed" config user.name Fixture
  git -C "$case_dir/seed" config user.email fixture@example.invalid
  printf 'old\n' > "$case_dir/seed/main.txt"
  git -C "$case_dir/seed" add main.txt
  git -C "$case_dir/seed" commit -qm old
  git -C "$case_dir/seed" push -q origin main
  old="$(git -C "$case_dir/seed" rev-parse HEAD)"
  git clone -q "$case_dir/origin.git" "$case_dir/runner"

  if [ "$scenario" = stale ]; then
    git -C "$case_dir/seed" checkout -qb ai/issue-492 "$old"
    printf 'branch\n' > "$case_dir/seed/branch.txt"
    git -C "$case_dir/seed" add branch.txt
    git -C "$case_dir/seed" commit -qm branch
    git -C "$case_dir/seed" push -q origin ai/issue-492
    git -C "$case_dir/seed" checkout -q main
  fi
  printf 'current\n' > "$case_dir/seed/main.txt"
  git -C "$case_dir/seed" commit -qam current
  git -C "$case_dir/seed" push -q origin main
  current="$(git -C "$case_dir/seed" rev-parse HEAD)"
  if [ "$scenario" = fresh ]; then
    git -C "$case_dir/seed" checkout -qb ai/issue-492
    printf 'branch\n' > "$case_dir/seed/branch.txt"
    git -C "$case_dir/seed" add branch.txt
    git -C "$case_dir/seed" commit -qm branch
    git -C "$case_dir/seed" push -q origin ai/issue-492
  fi
  pre_head=absent
  if [ "$scenario" != absent ]; then
    pre_head="$(git -C "$case_dir/origin.git" rev-parse refs/heads/ai/issue-492)"
  fi
  before="$pre_head"
  [ "$(git -C "$case_dir/runner" rev-parse refs/remotes/origin/main)" = "$old" ]
  : > "$case_dir/env"
  if (cd "$case_dir/runner" &&
      ISSUE_NUMBER=492 PRE_WRITE_REMOTE_HEAD="$pre_head" \
      GITHUB_ENV="$case_dir/env" GITHUB_OUTPUT="$case_dir/base" \
      bash "$gate" > "$case_dir/log" 2>&1); then
    [ "$scenario" != stale ] || { echo 'Stale branch reached Codex.' >&2; exit 1; }
    grep -Fqx 'paid-codex-reached' "$case_dir/env"
    [ "$(cat "$case_dir/base")" = "$current" ]
    [ "$(git -C "$case_dir/runner" rev-parse refs/remotes/origin/main)" = "$current" ]
    git -C "$case_dir/runner" merge-base --is-ancestor "$current" HEAD
    if [ "$scenario" = absent ]; then
      [ "$(git -C "$case_dir/runner" rev-parse HEAD)" = "$current" ]
    fi
  else
    [ "$scenario" = stale ] || { cat "$case_dir/log" >&2; exit 1; }
    [ "$(cat "$case_dir/base")" = "$current" ]
    ! grep -Fq 'paid-codex-reached' "$case_dir/env"
    grep -Fq 'does not contain current main' "$case_dir/log"
  fi
  if [ "$scenario" != absent ]; then
    [ "$(git -C "$case_dir/origin.git" rev-parse refs/heads/ai/issue-492)" = "$before" ]
  else
    ! git -C "$case_dir/origin.git" show-ref --verify --quiet refs/heads/ai/issue-492
  fi
done
