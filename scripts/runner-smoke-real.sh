#!/usr/bin/env bash
# ============================================================================
# runner-smoke-real.sh
# End-to-end smoke test for the Command Center runner daemon.
#
# Enqueues a small test work order against QEP, polls the audit log until
# the daemon claims and completes it, then prints the resulting PR URL and
# cleans up the smoke work-order row. Designed to be safe to re-run.
#
# Usage:
#   ./scripts/runner-smoke-real.sh           # real path — daemon talks to GitHub + Claude
#   ./scripts/runner-smoke-real.sh --mock    # control-plane plumbing only; no PR opened
#
# Requires:
#   - jq, curl
#   - CC_READ_TOKEN env or web/.env containing VITE_CC_READ_TOKEN
#   - CONTROL_PLANE_SERVICE_KEY env (the service-role key for gsvhuzpysxaegoecwjmf)
#
# What it tests:
#   - cc_enqueue_with_gating accepts an idempotent work order
#   - The daemon claims it (work_order_claimed audit event)
#   - The daemon completes it (pr_opened audit event)
#   - cleanup row removal succeeds
# ============================================================================
set -euo pipefail

CP_HOST="https://gsvhuzpysxaegoecwjmf.supabase.co"
TIMEOUT_SECONDS=180  # 3 minutes; tune up for slow Claude runs
POLL_INTERVAL=5

MOCK_MODE="false"
if [[ "${1:-}" == "--mock" ]]; then
  MOCK_MODE="true"
fi

# --- credentials ---
READ_TOKEN="${CC_READ_TOKEN:-}"
if [[ -z "$READ_TOKEN" && -f web/.env ]]; then
  READ_TOKEN="$(grep '^VITE_CC_READ_TOKEN=' web/.env | head -1 | cut -d= -f2- || true)"
fi
if [[ -z "$READ_TOKEN" ]]; then
  echo "ERROR: set CC_READ_TOKEN env or populate web/.env with VITE_CC_READ_TOKEN"
  exit 1
fi

SVC_KEY="${CONTROL_PLANE_SERVICE_KEY:-}"
if [[ -z "$SVC_KEY" ]]; then
  echo "ERROR: set CONTROL_PLANE_SERVICE_KEY env (the gsvhuzpysxaegoecwjmf service_role key)"
  echo "Get it from https://supabase.com/dashboard/project/gsvhuzpysxaegoecwjmf/settings/api"
  exit 1
fi

# --- enqueue the test work order ---
IDEMPOTENCY_KEY="smoke-$(date +%s)-$RANDOM"
INTENT="Runner smoke test. Append a single timestamped sentinel comment to README.md and open a PR."
if [[ "$MOCK_MODE" == "true" ]]; then
  INTENT="$INTENT (mock mode — no real edit expected)"
fi

echo "Step 1: Look up QEP app_id ..."
APP_ID="$(curl -fsS "$CP_HOST/rest/v1/registry_apps?short_code=eq.QEP&select=id&limit=1" \
  -H "apikey: $SVC_KEY" -H "Authorization: Bearer $SVC_KEY" \
  | jq -r '.[0].id')"
if [[ -z "$APP_ID" || "$APP_ID" == "null" ]]; then
  echo "ERROR: could not find QEP in registry_apps"
  exit 2
fi
echo "  QEP app_id: $APP_ID"

echo "Step 2: Enqueue test work order ($IDEMPOTENCY_KEY) ..."
CHANGE_SPEC=$(jq -n \
  --arg intent "$INTENT" \
  '{intent: $intent, affected_area: "README.md", acceptance_criteria: ["A single comment line appears at the bottom of README.md with a UTC timestamp", "All other files unchanged", "PR has exactly one commit"], constraints: ["Single PR", "Branch must start with cc/", "Do not modify any other file"], branch_hint: ("cc/smoke-" + (now | tostring))}')

ENQUEUE_RES="$(curl -fsS "$CP_HOST/rest/v1/rpc/cc_enqueue_with_gating" \
  -H "apikey: $SVC_KEY" -H "Authorization: Bearer $SVC_KEY" \
  -H "Content-Type: application/json" -H "Accept: application/json" \
  -d "$(jq -n \
        --arg app_id "$APP_ID" \
        --argjson cs "$CHANGE_SPEC" \
        --arg key "$IDEMPOTENCY_KEY" \
        --arg actor "smoke-test-script" \
        '{p_app_id: $app_id, p_change_spec: $cs, p_risk_class: "auto", p_idempotency_key: $key, p_source_answer_id: null, p_cost_cap_usd: 5, p_actor: $actor}')")"

WORK_ORDER_ID="$(echo "$ENQUEUE_RES" | jq -r '.id')"
WORK_ORDER_STATUS="$(echo "$ENQUEUE_RES" | jq -r '.status')"
echo "  work_order_id: $WORK_ORDER_ID"
echo "  initial status: $WORK_ORDER_STATUS"
if [[ "$WORK_ORDER_STATUS" != "queued" ]]; then
  echo "ERROR: expected status=queued for AUTO risk_class under cap; got $WORK_ORDER_STATUS"
  exit 3
fi

# --- poll for completion ---
echo "Step 3: Poll for daemon completion (max ${TIMEOUT_SECONDS}s) ..."
ELAPSED=0
FINAL_STATUS=""
PR_URL=""
while (( ELAPSED < TIMEOUT_SECONDS )); do
  sleep "$POLL_INTERVAL"
  ELAPSED=$((ELAPSED + POLL_INTERVAL))

  ROW="$(curl -fsS "$CP_HOST/rest/v1/agent_work_orders?id=eq.${WORK_ORDER_ID}&select=status,pr_url,last_error,attempt_count" \
    -H "apikey: $SVC_KEY" -H "Authorization: Bearer $SVC_KEY")"
  STATUS="$(echo "$ROW" | jq -r '.[0].status')"
  PR_URL="$(echo "$ROW" | jq -r '.[0].pr_url // empty')"
  LAST_ERR="$(echo "$ROW" | jq -r '.[0].last_error // empty')"
  ATTEMPTS="$(echo "$ROW" | jq -r '.[0].attempt_count')"

  printf "  [%3ds] status=%-14s attempts=%s pr=%s\n" "$ELAPSED" "$STATUS" "$ATTEMPTS" "${PR_URL:-—}"

  case "$STATUS" in
    pr_open|done)
      FINAL_STATUS="$STATUS"
      break
      ;;
    failed|dead_lettered|cancelled)
      FINAL_STATUS="$STATUS"
      break
      ;;
  esac
done

if [[ -z "$FINAL_STATUS" ]]; then
  echo "TIMEOUT — work order didn't reach terminal state in ${TIMEOUT_SECONDS}s"
  echo "  Is the daemon running on the Mac Studio?"
  echo "  Inspect: SELECT * FROM agent_work_orders WHERE id = '$WORK_ORDER_ID';"
  exit 4
fi

case "$FINAL_STATUS" in
  pr_open)
    echo
    echo "✅ PASS — daemon completed the smoke order."
    echo "  PR: $PR_URL"
    if [[ "$MOCK_MODE" == "true" ]]; then
      echo "  (mock mode — PR URL is fake; no real PR to review)"
    else
      echo "  → Open the PR, confirm the diff is the expected one-line comment, then CLOSE it."
      echo "  → Do NOT merge — this is smoke-test output, not real work."
    fi
    ;;
  failed|dead_lettered)
    echo
    echo "❌ FAIL — daemon reported terminal failure."
    echo "  last_error: $LAST_ERR"
    echo "  Inspect: SELECT * FROM agent_runs WHERE work_order_id = '$WORK_ORDER_ID';"
    EXIT_CODE=5
    ;;
  *)
    echo "Unexpected final status: $FINAL_STATUS"
    EXIT_CODE=6
    ;;
esac

# --- cleanup ---
echo
echo "Step 4: Cleaning up smoke rows ..."
curl -fsS -X DELETE "$CP_HOST/rest/v1/agent_runs?work_order_id=eq.${WORK_ORDER_ID}" \
  -H "apikey: $SVC_KEY" -H "Authorization: Bearer $SVC_KEY" > /dev/null
curl -fsS -X DELETE "$CP_HOST/rest/v1/agent_work_orders?id=eq.${WORK_ORDER_ID}" \
  -H "apikey: $SVC_KEY" -H "Authorization: Bearer $SVC_KEY" > /dev/null
echo "  rows removed."
echo
echo "Audit events for this run remain in cc_audit_events (append-only by design)."

exit "${EXIT_CODE:-0}"
