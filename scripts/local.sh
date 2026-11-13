#!/usr/bin/env bash
# Runs the whole system on this machine with Docker Compose.
#
#   scripts/local.sh up            build, provision and start everything
#   scripts/local.sh demo [name]   file a ticket and print what happens
#                                  (refund, the default, or approval)
#   scripts/local.sh logs [name]   follow a service's logs
#   scripts/local.sh down          stop, keeping the data
#   scripts/local.sh reset         stop and delete the data
#
# With ANTHROPIC_API_KEY set, in the environment or in .env, the agent is
# Claude. Without it, or with SCRIPTED_MODEL=1, a scripted stand-in handles
# the demo tickets and nothing is spent.
set -euo pipefail
cd "$(dirname "$0")/.."

compose=(docker compose -f infra/compose/compose.yaml --profile app)
# Only the key is taken from .env. Nothing else in that file is needed here.
# SCRIPTED_MODEL=1 forces the stand-in even when a key is present.
if [ -n "${SCRIPTED_MODEL:-}" ]; then
  export ANTHROPIC_API_KEY=
elif [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -f .env ]; then
  ANTHROPIC_API_KEY="$(sed -n 's/^ANTHROPIC_API_KEY=//p' .env | head -n 1)"
  export ANTHROPIC_API_KEY
fi
if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  export MODEL=rule-model
  export MODEL_PROVIDER_MODULE=/app/apps/worker/src/testing/duplicate-refund-model.ts
fi

case "${1:-}" in
  up)
    "${compose[@]}" build provision
    "${compose[@]}" up --detach --wait
    if [ -n "${ANTHROPIC_API_KEY:-}" ]; then model="${MODEL:-claude-sonnet-5-5}"; else model="a scripted stand-in (no ANTHROPIC_API_KEY)"; fi
    echo
    echo "Proofdesk is running. The agent's model: ${model}"
    echo "  Portal:    http://localhost:${PORTAL_PORT:-3000}"
    echo "  Temporal:  http://localhost:${TEMPORAL_UI_PORT:-8233}"
    echo "  Keycloak:  http://localhost:${KEYCLOAK_PORT:-8080}"
    echo "  Grafana:   http://localhost:${GRAFANA_PORT:-3001}/d/proofdesk"
    echo "Next: pnpm local:demo"
    ;;
  demo)
    "${compose[@]}" --profile demo run --rm demo "${2:-refund}"
    ;;
  logs)
    "${compose[@]}" logs --follow "${@:2}"
    ;;
  down)
    "${compose[@]}" --profile demo down
    ;;
  reset)
    "${compose[@]}" --profile demo down --volumes
    ;;
  *)
    sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
