# Phase 5 Security Threat Model — Email Decision Engine

## §1. Input vectors — every untrusted boundary in Phase 5

Phase 5 adds outbound decision emails, magic-link confirmation, inbound reply parsing, Brian's operator-confirm queue, and work-order dispatch after confirmed answers. It must preserve the existing non-negotiables: federated app boundaries, server-bound repo targets, enumerated answers, append-only audit, and human gates. Relevant baseline controls already exist in the plan: control plane never live-joins client DBs and only uses explicit contracts/proxies (`docs/COMMAND_CENTER_MASTER_PLAN.md:83-84`); repo/branch are server-bound and never accepted from answer/email/agent/UI input (`docs/COMMAND_CENTER_MASTER_PLAN.md:86-87`); free-text replies are reduced to an enumerated option and confirmed by Brian before work-order use (`docs/COMMAND_CENTER_MASTER_PLAN.md:158-160`).

| Vector | Source | Trust level | Can affect | Limiting controls |
|---|---|---:|---|---|
| Outbound email send | Cockpit "Route to client" operator action | Trusted operator action, untrusted delivery metadata | Creates `cc_decision_email_sends`; sends tokenized option links | Cloudflare Access/operator identity, server-side app binding, append-only `decision_email_sent`, one send row per recipient/option, no repo in payload |
| Magic-link click | Recipient email client/scanner/browser `GET` | Untrusted internet request | Confirm page render only | GET must not write; token HMAC validation; log `decision_link_visited`, not answer |
| Confirm button press | Confirm page `POST` | Untrusted internet request with bearer token | Writes selected enumerated answer | CSRF + token validation; token bound to `(decision_id, recipient_id, option_id)`; replay/expiry checks; DB transaction |
| Email reply webhook | Resend inbound webhook | Semi-trusted transport, untrusted payload | Stores inbound reply, creates extraction proposal | Resend signature verification, timestamp/nonce replay defense, app/decision binding, quarantine raw body |
| Free-text body | Customer prose | Fully untrusted | May influence suggested option | Never instruction; length/content limits; stored in restricted/quarantined field; LLM output confirm-gated |
| LLM extraction | Model output | Untrusted suggestion | Proposed `option_id` only | Validate against enumerated option set; reject hallucinated IDs; no direct commit; operator confirm required |
| Operator confirm action | Brian in confirm queue | Trusted human action through Access | Commits parsed reply into answer/work order | Cloudflare Access actor derivation; enumerated option validation; audit actor; atomic RPC pattern |
| Bot/scanner pre-click | Email security scanners | Untrusted automated GET | Could accidentally visit links | GET render-only; answer requires POST button + CSRF; "visited" distinct from "answered" |
| Multi-recipient | 2+ recipients for same decision | Multiple partially trusted humans | Conflicting answers, duplicate commits | Per-recipient send rows; first valid confirmed answer wins unless policy requires Brian arbitration; conflicts go operator queue |
| Replay answered link | Old token clicked again | Untrusted replay | Duplicate answer/dispatch | Unique answer/idempotency key; issue closed returns 410-style already-closed behavior pattern (`supabase/functions/cc-answer-issue/index.ts:277-285`) |
| Expired link click | Token after TTL | Untrusted stale bearer token | Attempted answer after validity | Short TTL, `token_expires_at`, expired status, log `decision_expired`; render safe expired state |
| Forwarded email | Recipient forwards link | Untrusted bearer-token holder | Unauthorized answer by recipient's delegate | Token bound to intended recipient; confirm page displays recipient/app/decision; high-risk answers still Brian-confirmed/free-text gated; audit IP/UA |
| Reply-all / typo'd reply-to | Email misrouting | Untrusted/misdirected email | Wrong inbox receives data or webhook can't bind | Per-send reply-to alias; reject unbound inbound; avoid sensitive raw data in outbound; log bounce/unbound reply |

## §3. The non-negotiables, restated for Phase 5

- **"Customer input can never reach an agent as instructions."** In Phase 5, email bodies and rationales are data/provenance only. They may produce a candidate `option_id`, but never appear in `change_spec` as imperative text.
- **"Customer input cannot choose the build target."** Phase 5 tokens, replies, and LLM outputs must not contain or accept repo/branch.
- **"AUTHORIZE/destructive/production work never auto-dispatches."** A confirmed client answer may create/advance a work order, but risk is re-derived server-side.
- **"Brian's confirm gate on every free-text reply, full stop."** Magic-link button answers can commit after token/CSRF validation. Free-text replies cannot.
- **"The PR merge always human-gated."**

## §4. Magic-link confirm — security-critical design

1. **Outbound email**: distinct raw token per recipient/option, store only `magic_token_hash`, HMAC-signed token payload (decision_id, issue_id, app_id, recipient_id, send_id, option_id, exp, nonce), 7d TTL.
2. **GET confirm page**: validates token, writes only `decision_link_visited` audit, renders page with Confirm button. Does NOT write answers.
3. **POST confirm**: requires CSRF nonce minted on GET, revalidates all token claims, validates option against snapshot, inserts answer in one transaction.
4. **Scanner containment**: opens/clicks are telemetry only. Only POST with CSRF + valid token is an answer.

## §5. Inbound free-text — LLM-as-translator security model

LLM output is an untrusted suggestion. Flow:
1. Resend inbound webhook → verify signature.
2. Raw body stored quarantined.
3. LLM receives bounded reply text + enumerated options.
4. LLM returns suggested `option_id`, confidence, ambiguity flags.
5. Validate suggestion against option set.
6. UI shows Brian: original text + parsed suggestion + confidence + all options.
7. Brian must click confirm to commit.

Containment failures:
| Failure | Containment |
|---|---|
| Prompt injection | Body is data; model only proposes option ID; operator confirms |
| Hallucinated option | Exact validation against enumerated IDs; reject to manual queue |
| Ambiguous answer | Mark ambiguous; no preselected commit; Brian chooses |
| Multi-intent reply | Extract only answer; unrelated content quarantined |
| Hostile content | Store/display escaped text; sanitize HTML |
| Model overconfidence | Brian confirm gate remains mandatory |

## §6. Audit & observability

Required append-only events:
- `decision_email_sent`
- `decision_email_delivered` / `bounced` / `opened` / `clicked`
- `decision_link_visited` (NOT an answer)
- `decision_answered_by_recipient`
- `decision_email_reply_received`
- `decision_extraction_proposed`
- `decision_operator_confirmed`
- `decision_expired`

Invariants: "Visited" and "answered" are separate. Raw tokens never logged. Raw bodies quarantined. Every dispatchable answer traceable.

## §7. What we MUST NOT build

- No auto-applying free-text answers
- No customer email body in less-trusted readable columns
- No recipient-chosen repo or branch
- No direct "click here to apply" links (must go through confirm page)
- No cross-app routing
- No raw token storage (hashes only)
- No answer from open/click telemetry
- No LLM output as authority
- No anon DB exposure for Phase 5 tables
