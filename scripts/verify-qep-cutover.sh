#!/usr/bin/env bash
# ============================================================================
# verify-qep-cutover.sh
# Polls the live audit log to confirm the QEP S2 cutover has landed.
#
# Success criterion: the most recent QEP snapshot_captured audit event has
# detail.key_class == "readonly" (instead of "service_role"). That proves the
# Aggregator is now using the scoped command_center role + READ_KEY_QEP, not
# the standing SVC_KEY_QEP service-role key.
#
# Usage:
#   ./scripts/verify-qep-cutover.sh
#
# Requires: jq, curl. Expects VITE_CC_READ_TOKEN in web/.env (the operator
# read token). Override with CC_READ_TOKEN env var if needed.
# ============================================================================
set -euo pipefail

CP_HOST="https://gsvhuzpysxaegoecwjmf.supabase.co"
TOKEN="${CC_READ_TOKEN:-}"

if [[ -z "$TOKEN" && -f web/.env ]]; then
  TOKEN="$(grep '^VITE_CC_READ_TOKEN=' web/.env | head -1 | cut -d= -f2- || true)"
fi

if [[ -z "$TOKEN" ]]; then
  echo "Set CC_READ_TOKEN env or ensure web/.env contains VITE_CC_READ_TOKEN."
  exit 1
fi

echo "Polling ${CP_HOST}/functions/v1/cc-read-audit for the most recent"
echo "QEP snapshot_captured event ..."
echo

EVENT_JSON="$(curl -fsS "${CP_HOST}/functions/v1/cc-read-audit?limit=10" \
  -H "x-cc-read-token: ${TOKEN}" \
  | jq '.events
        | map(select(.event_type == "snapshot_captured" and .short_code == "QEP"))
        | .[0] // empty')"

if [[ -z "$EVENT_JSON" || "$EVENT_JSON" == "null" ]]; then
  echo "No QEP snapshot_captured event in the recent audit window."
  exit 2
fi

KEY_CLASS="$(echo "$EVENT_JSON" | jq -r '.detail.key_class // "(missing)"')"
SECRET_REF="$(echo "$EVENT_JSON" | jq -r '.detail.secret_ref // "(missing)"')"
FALLBACK_FROM="$(echo "$EVENT_JSON" | jq -r '.detail.fallback_from // empty')"
OCCURRED_AT="$(echo "$EVENT_JSON" | jq -r '.occurred_at')"

echo "Most recent QEP snapshot:"
echo "  occurred_at:   $OCCURRED_AT"
echo "  key_class:     $KEY_CLASS"
echo "  secret_ref:    $SECRET_REF"
if [[ -n "$FALLBACK_FROM" ]]; then
  echo "  fallback_from: $FALLBACK_FROM"
fi
echo

case "$KEY_CLASS" in
  readonly)
    echo "PASS — Aggregator is using the scoped command_center role via READ_KEY_QEP."
    echo "S2 god-credential retirement is COMPLETE on the live control plane."
    echo "Next step: confirm cockpit detail loads (cc_export_detail must also be deployed on QEP)."
    exit 0
    ;;
  service_role)
    echo "PENDING — Aggregator is still using SVC_KEY_QEP."
    echo "  - Has READ_KEY_QEP been set on the control plane?"
    echo "      supabase secrets list --project-ref gsvhuzpysxaegoecwjmf | grep READ_KEY_QEP"
    echo "  - Has the command_center role been applied on QEP's data plane?"
    echo "      See docs/handoffs/QEP_COMMAND_CENTER_ROLE.md"
    if [[ -n "$FALLBACK_FROM" ]]; then
      echo "  - Audit shows the Aggregator TRIED readonly and fell back. Inspect the error:"
      echo "      $FALLBACK_FROM"
    fi
    exit 3
    ;;
  *)
    echo "UNKNOWN key_class. The Aggregator deploy may be stale; redeploy and re-run."
    exit 4
    ;;
esac
