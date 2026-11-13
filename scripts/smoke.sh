#!/usr/bin/env bash
# Starts the whole system from nothing and uses it the way its people would:
# every service as its own process, in containers, with real sign-in, real
# tokens and real workflows. Only the model is a scripted stand-in, so this
# costs nothing and gives the same result every time.
#
# It is the widest test in the repository, and the only one that would
# notice a service that cannot start or cannot reach another.
#
# The interface is driven in Google Chrome. Set SKIP_BROWSER=1 to leave that
# part out on a machine without it.
set -euo pipefail
cd "$(dirname "$0")/.."
export SCRIPTED_MODEL=1

failures=0
expect() {
  local name="$1" output="$2" pattern="$3"
  if grep -qE -- "$pattern" <<<"$output"; then
    echo "  ok    $name: $pattern"
  else
    echo "  FAIL  $name: expected to see: $pattern"
    failures=$((failures + 1))
  fi
}
demo() { scripts/local.sh demo "$1" 2>&1 | grep -v "Container" || true; }

echo "Starting from an empty stack..."
scripts/local.sh reset >/dev/null 2>&1 || true
scripts/local.sh up >/dev/null

echo "The interface, in a real browser: a customer, an approver and an operator"
if [ -n "${SKIP_BROWSER:-}" ]; then
  echo "  skip  SKIP_BROWSER is set"
  out="$(demo refund)"
  expect refund "$out" "Status: resolved"
else
  out="$(node apps/stack/src/ui-check.ts 2>&1 || true)"
  echo "$out"
  expect interface "$out" "a customer signs in, files a request and reads the agent's reply"
  expect interface "$out" "markup in a ticket is shown as text and does not run"
  expect interface "$out" "an approver sees approvals, hand-overs and the review queue"
  expect interface "$out" "an operator pauses and resumes the agent"
  if grep -q "FAIL" <<<"$out"; then failures=$((failures + 1)); fi
fi

echo "A customer answers the agent's question, and the conversation carries on"
out="$(demo reply)"
expect reply "$out" "Status: waiting_customer"
expect reply "$out" "The customer answers"
expect reply "$out" "Status: resolved"

echo "A plan change reaches billing and access together"
out="$(demo plan)"
expect plan "$out" "Status: resolved"
expect plan "$out" "5 seats"

echo "A paused agent hands over, and a member of staff answers"
out="$(demo handover)"
expect handover "$out" "paused the agent"
expect handover "$out" "Status: handed_to_staff"
expect handover "$out" "answered the customer"
expect handover "$out" "Status: resolved"
expect handover "$out" "resumed the agent"

echo "A refund above the limit waits for staff, and is paid once approved"
out="$(demo approval)"
expect approval "$out" "waiting for staff"
expect approval "$out" "Approved by"
expect approval "$out" "I have refunded \\\$980\.00"

echo "A customer is deleted at their own request"
out="$(demo delete)"
expect delete "$out" "Deletion request .* accepted"
expect delete "$out" "The account is gone"

echo "Every service is still running"
state="$(docker compose -f infra/compose/compose.yaml --profile app ps --all --format '{{.Service}} {{.State}} {{.ExitCode}}')"
for service in billing billing-mcp documents-mcp entitlements entitlements-mcp portal worker; do
  expect services "$state" "^$service running"
done
expect services "$state" "^provision exited 0"

scripts/local.sh down >/dev/null 2>&1
if [ "$failures" -gt 0 ]; then
  echo "$failures check(s) failed."
  exit 1
fi
echo "All checks passed."
