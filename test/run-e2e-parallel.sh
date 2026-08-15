#!/usr/bin/env bash
set -uo pipefail
# Run E2E tests in 4 parallel Docker stacks, each with a balanced subset.
# Each stack is fully isolated (separate DB, separate ports).

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CFG="test/playwright.config.ts"
LOG_DIR="$ROOT/test/e2e/.parallel-logs"
mkdir -p "$LOG_DIR"
rm -f "$LOG_DIR"/*.log

declare -A STACK_PORTS
STACK_PORTS[1,frontend]=3000  STACK_PORTS[1,backend]=3001  STACK_PORTS[1,mock_llm]=3002  STACK_PORTS[1,mock_mcp]=3003  STACK_PORTS[1,mock_oidc]=3004  STACK_PORTS[1,mock_cyberark]=3005  STACK_PORTS[1,postgres]=5432  STACK_PORTS[1,valkey]=6379  STACK_PORTS[1,qdrant]=6333  STACK_PORTS[1,sidecar]=4001
STACK_PORTS[2,frontend]=3010  STACK_PORTS[2,backend]=3011  STACK_PORTS[2,mock_llm]=3012  STACK_PORTS[2,mock_mcp]=3013  STACK_PORTS[2,mock_oidc]=3014  STACK_PORTS[2,mock_cyberark]=3015  STACK_PORTS[2,postgres]=5442  STACK_PORTS[2,valkey]=6389  STACK_PORTS[2,qdrant]=6343  STACK_PORTS[2,sidecar]=4011
STACK_PORTS[3,frontend]=3020  STACK_PORTS[3,backend]=3021  STACK_PORTS[3,mock_llm]=3022  STACK_PORTS[3,mock_mcp]=3023  STACK_PORTS[3,mock_oidc]=3024  STACK_PORTS[3,mock_cyberark]=3025  STACK_PORTS[3,postgres]=5452  STACK_PORTS[3,valkey]=6399  STACK_PORTS[3,qdrant]=6353  STACK_PORTS[3,sidecar]=4021
STACK_PORTS[4,frontend]=3030  STACK_PORTS[4,backend]=3031  STACK_PORTS[4,mock_llm]=3032  STACK_PORTS[4,mock_mcp]=3033  STACK_PORTS[4,mock_oidc]=3034  STACK_PORTS[4,mock_cyberark]=3035  STACK_PORTS[4,postgres]=5462  STACK_PORTS[4,valkey]=6409  STACK_PORTS[4,qdrant]=6363  STACK_PORTS[4,sidecar]=4031

# Balanced by measured duration (sequential pass: total ~628s → ~150-165s per
# stack). Stack 1 keeps the port-sensitive tests (SSO hardcodes port 3004,
# openai-chat). Keep workers=1 per stack — workers=2 causes cross-test
# interference (webhook/tool/parallel specs fail).
GROUP1="test/e2e/10-auth.spec.ts test/e2e/30-flow-editor.spec.ts test/e2e/76-sso.spec.ts test/e2e/77-subflows.spec.ts test/e2e/78-advanced-flows.spec.ts test/e2e/81-sandbox.spec.ts test/e2e/84-flow-env-vars.spec.ts test/e2e/85-sidecar-lifecycle.spec.ts test/e2e/86-sidecar-capabilities.spec.ts test/e2e/87-co-pilot-output-shape.spec.ts test/e2e/98-openai-chat.spec.ts test/e2e/99-extended-api.spec.ts test/e2e/99-knowledge-vectors-admin.spec.ts"
GROUP2="test/e2e/20-flows-overview.spec.ts test/e2e/35-node-config.spec.ts test/e2e/40-flow-save-load.spec.ts test/e2e/50-debug-run.spec.ts test/e2e/60-chat-flow.spec.ts test/e2e/75-groups.spec.ts test/e2e/80-secrets.spec.ts test/e2e/89-env-overrides.spec.ts test/e2e/90-node-types.spec.ts test/e2e/92-co-pilot-crud.spec.ts test/e2e/95-webhook.spec.ts test/e2e/98-schedule.spec.ts"
GROUP3="test/e2e/79-agent-contexts.spec.ts test/e2e/80-co-pilot.spec.ts test/e2e/82-env-vars-ui.spec.ts test/e2e/83-subflow-env.spec.ts test/e2e/101-real-llm.spec.ts"
GROUP4="test/e2e/70-settings.spec.ts test/e2e/88-co-pilot-set-schema.spec.ts test/e2e/91-co-pilot-group-context.spec.ts test/e2e/93-flow-editor-tools.spec.ts test/e2e/94-node-type-configs.spec.ts test/e2e/96-flow-tool.spec.ts test/e2e/97-webhook-api.spec.ts test/e2e/99-complex-flows.spec.ts test/e2e/100-thinking-mode.spec.ts"

run_stack() {
  local STACK_ID=$1
  local PROJECT="e2e-s${STACK_ID}"
  local FRONTEND_PORT=${STACK_PORTS[$STACK_ID,frontend]}
  local BACKEND_PORT=${STACK_PORTS[$STACK_ID,backend]}
  local MOCK_LLM_PORT=${STACK_PORTS[$STACK_ID,mock_llm]}
  local MOCK_MCP_PORT=${STACK_PORTS[$STACK_ID,mock_mcp]}
  local MOCK_OIDC_PORT=${STACK_PORTS[$STACK_ID,mock_oidc]}
  local MOCK_CYBERARK_PORT=${STACK_PORTS[$STACK_ID,mock_cyberark]}
  local POSTGRES_PORT=${STACK_PORTS[$STACK_ID,postgres]}
  local VALKEY_PORT=${STACK_PORTS[$STACK_ID,valkey]}
  local QDRANT_PORT=${STACK_PORTS[$STACK_ID,qdrant]}
  local SIDECAR_PORT=${STACK_PORTS[$STACK_ID,sidecar]}

  local GROUP_VAR="GROUP${STACK_ID}"
  local TESTS=${!GROUP_VAR}
  local LOG="$LOG_DIR/stack${STACK_ID}.log"

  echo "[Stack $STACK_ID] Starting stack (ports ${FRONTEND_PORT}/${BACKEND_PORT})..."

  FRONTEND_PORT=$FRONTEND_PORT \
  BACKEND_PORT=$BACKEND_PORT \
  MOCK_LLM_PORT=$MOCK_LLM_PORT \
  MOCK_MCP_PORT=$MOCK_MCP_PORT \
  MOCK_OIDC_PORT=$MOCK_OIDC_PORT \
  MOCK_CYBERARK_PORT=$MOCK_CYBERARK_PORT \
  POSTGRES_PORT=$POSTGRES_PORT \
  VALKEY_PORT=$VALKEY_PORT \
  QDRANT_PORT=$QDRANT_PORT \
  SIDECAR_PORT=$SIDECAR_PORT \
  docker compose -p "$PROJECT" -f docker-compose.e2e.stack.yml up -d --wait 2>&1 | tail -3

  # Frontend has no Docker health check — wait until it actually serves HTTP
  echo "[Stack $STACK_ID] Waiting for frontend..."
  FRONTEND_UP=0
  for attempt in $(seq 1 120); do
    if curl -sf "http://localhost:${FRONTEND_PORT}" > /dev/null 2>&1; then
      FRONTEND_UP=1
      break
    fi
    sleep 2
  done

  # Backend may still be booting — wait for its health endpoint too
  echo "[Stack $STACK_ID] Waiting for backend health..."
  BACKEND_UP=0
  for attempt in $(seq 1 120); do
    if curl -sf "http://localhost:${BACKEND_PORT}/api/health" > /dev/null 2>&1; then
      BACKEND_UP=1
      break
    fi
    sleep 2
  done

  if [ "$FRONTEND_UP" -ne 1 ] || [ "$BACKEND_UP" -ne 1 ]; then
    echo "[Stack $STACK_ID] Services did not become ready (frontend=$FRONTEND_UP backend=$BACKEND_UP)"
    docker compose -p "$PROJECT" -f docker-compose.e2e.stack.yml logs --tail 30 2>&1 | tail -40
    docker compose -p "$PROJECT" -f docker-compose.e2e.stack.yml down -v --timeout 10 2>&1 | tail -1
    return 1
  fi
  echo "[Stack $STACK_ID] Frontend + backend ready"

  # Warm up Next.js dev compilation (the e2e frontend runs `next dev`). With 4
  # stacks booting at once, the first test's page.goto can exceed the 30s test
  # timeout while the editor page is still being compiled on demand.
  echo "[Stack $STACK_ID] Warming up frontend compilation..."
  for path in /flows/new/edit /settings /; do
    curl -sf -o /dev/null --max-time 120 "http://localhost:${FRONTEND_PORT}${path}" || true
  done

  local AUTH_FILE="e2e/.auth/user-s${STACK_ID}.json"

  echo "[Stack $STACK_ID] Setup..."
  local SETUP_LOG="$LOG_DIR/stack${STACK_ID}-setup.log"
  E2E_API_URL="http://localhost:${BACKEND_PORT}/api" \
  PLAYWRIGHT_BASE_URL="http://localhost:${FRONTEND_PORT}" \
  PLAYWRIGHT_AUTH_FILE="$AUTH_FILE" \
  npx playwright test test/e2e/00-initial-setup.spec.ts \
    --config "$CFG" --retries=0 > "$SETUP_LOG" 2>&1
  if [ $? -ne 0 ]; then
    echo "[Stack $STACK_ID] Setup FAILED"
    tail -1 "$SETUP_LOG"
    docker compose -p "$PROJECT" -f docker-compose.e2e.stack.yml down -v --timeout 10 2>&1 | tail -1
    return 1
  fi

  echo "[Stack $STACK_ID] Tests..."
  E2E_API_URL="http://localhost:${BACKEND_PORT}/api" \
  PLAYWRIGHT_BASE_URL="http://localhost:${FRONTEND_PORT}" \
  PLAYWRIGHT_AUTH_FILE="$AUTH_FILE" \
  npx playwright test $TESTS \
    --config "$CFG" --retries=0 --project=authenticated --workers=1 > "$LOG" 2>&1

  local RESULT=$?
  tail -3 "$LOG" | grep -E "passed|failed" || true
  echo "[Stack $STACK_ID] Done (exit=$RESULT)"

  docker compose -p "$PROJECT" -f docker-compose.e2e.stack.yml down -v --timeout 10 2>&1 | tail -1
  return $RESULT
}

echo "=== Building shared E2E images (once, reused by all stacks) ==="
docker compose -f docker-compose.e2e.stack.yml build 2>&1 | tail -2

echo "=== Starting 4 parallel E2E stacks ==="

for i in $(seq 1 4); do
  run_stack $i &
  declare "PID$i=$!"
done

echo "Waiting for stacks..."
FAILED=0
for i in $(seq 1 4); do
  pid_var="PID$i"
  wait "${!pid_var}" || FAILED=$((FAILED + 1))
done

echo ""
echo "=== Parallel E2E Results ==="
for i in $(seq 1 4); do
  echo "--- Stack $i ---"
  tail -3 "$LOG_DIR/stack${i}.log" 2>/dev/null | grep -E "passed|failed|skipped" || echo "(no results)"
done

if [ "$FAILED" -eq 0 ]; then
  echo "All stacks passed!"
else
  echo "$FAILED stack(s) had failures"
  exit 1
fi
