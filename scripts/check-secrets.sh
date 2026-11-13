#!/usr/bin/env bash
# Refuses content that looks like a credential or a personal file path.
#
#   scripts/check-secrets.sh           checks what is staged for commit
#   scripts/check-secrets.sh --all     checks every tracked file
#
# Extra patterns that are themselves private (a name, an email address) go in
# .private-patterns, one extended regular expression per line. That file is
# git-ignored and only exists on the owner's machine.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

patterns=(
  'sk-ant-[A-Za-z0-9_-]{20,}'                 # Anthropic API key
  'sk-(proj|svcacct|admin)-[A-Za-z0-9_-]{20,}' # OpenAI API key
  'sk-[A-Za-z0-9]{40,}'                       # generic sk- key
  'gh[pousr]_[A-Za-z0-9]{30,}'                # GitHub token
  'github_pat_[A-Za-z0-9_]{30,}'              # GitHub fine-grained token
  'AKIA[0-9A-Z]{16}'                          # AWS access key id
  'AIza[0-9A-Za-z_-]{35}'                     # Google API key
  'xox[baprs]-[A-Za-z0-9-]{10,}'              # Slack token
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'        # PEM private key
  '"d"[[:space:]]*:[[:space:]]*"[A-Za-z0-9_-]{40,}"' # private part of a JWK
  '/Users/[A-Za-z0-9._-]+/'                   # macOS home directory path
  '/home/[a-z][a-z0-9._-]+/(Desktop|Documents|Downloads)/' # Linux home path
)
if [ -f .private-patterns ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && patterns+=("$line")
  done < .private-patterns
fi
regex=$(IFS='|'; echo "${patterns[*]}")

forbidden_names='(^|/)(\.env(\..*)?|.*\.pem|.*\.p12|.*\.key|id_rsa|id_ed25519|\.dev-log\.md|\.failure-log\.md|\.build-plan\.md|\.private-patterns|\.architecture-target\.html)$'

if [ "${1:-}" = "--all" ]; then
  files=$(git ls-files)
  show() { cat -- "$1"; }
else
  files=$(git diff --cached --name-only --diff-filter=ACMR)
  show() { git show ":$1"; }
fi

failed=0
while IFS= read -r file; do
  [ -z "$file" ] && continue
  if [[ "$file" =~ $forbidden_names ]] && [ "$file" != ".env.example" ]; then
    echo "refused: $file is a private file and must not be committed"
    failed=1
    continue
  fi
  # This script and its test list the patterns, so they would match themselves.
  case "$file" in scripts/check-secrets.sh|pnpm-lock.yaml) continue ;; esac
  # Only line numbers are printed, so the secret itself never reaches a log.
  if lines=$(show "$file" 2>/dev/null | grep -a -n -E -e "$regex" | cut -d: -f1 | paste -sd, -); then
    echo "refused: $file looks like it contains a secret or a personal path (line $lines)"
    failed=1
  fi
done <<< "$files"

if [ "$failed" -ne 0 ]; then
  echo
  echo "Nothing was committed. Remove the content above, or if it is a false"
  echo "positive, change the text so it no longer matches."
  exit 1
fi
