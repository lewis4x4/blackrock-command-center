# Phase 5 — Slice 2 — Extraction Loop Design

**Compiled:** 2026-05-22 · **Status:** Design draft, awaiting operator greenlight.
**Predecessor:** `docs/designs/PHASE_5_EMAIL_DECISION_ENGINE.md` (Slice 1 shipped).
**Target migration:** `026_phase5_slice2_extraction.sql`.

---

## 0. Design-time decision required (read first)

**This design DEFAULTS to the master plan's locked posture — NO auto-commit on free-text replies.** All extraction output lands in the operator confirm queue. The runner extracts, the operator commits.

The today brief asked for high-confidence auto-commit. **That capability is built into the schema and RPCs, but disabled by default.** Enabling it is a hard build gate that requires an explicit master-plan amendment, not a config tweak.

| Source | Position |
|---|---|
| **PHASE_5_EMAIL_DECISION_ENGINE.md non-negotiable §4** (current law) | "Brian's confirm gate on every free-text reply, full stop. Magic-link button answers can commit after token/CSRF validation. Free-text replies cannot — they always go through the operator confirm queue." |
| **PHASE_5_EMAIL_DECISION_ENGINE.md §6.6** | "If confidence ≥ 0.85 → state remains `extracting` until operator confirms (does NOT auto-commit)." |
| **Brief from operator today** | High-confidence extraction *could* commit directly. |
| **This design (default)** | Auto-commit is implemented but gated behind `EXTRACTION_AUTO_COMMIT_CONFIDENCE=1.01` (effectively off). All outcomes route to operator review. |

### Default config

```
EXTRACTION_AUTO_COMMIT_CONFIDENCE = 1.01   # off; nothing auto-commits
EXTRACTION_OFF_TOPIC_FLOOR        = 0.20
```

With the default, **Outcome A (auto-commit) is unreachable** — confidence can never exceed 1.0. The runner falls through to Outcome B (clarify if budget), then C/D (operator review).

### To enable auto-commit (hard build gate)

All of the following are required, in order:

1. Update `PHASE_5_EMAIL_DECISION_ENGINE.md` non-negotiable §4 to explicitly permit high-confidence auto-commit on free-text replies. Lock the new wording with the same "never automate" discipline as the other non-negotiables.
2. Update §6.6 of the master plan to match.
3. Operator (Brian) signs off the amendment commit explicitly — same posture as a destructive-class work order.
4. Lower `EXTRACTION_AUTO_COMMIT_CONFIDENCE` to a value < 1.0 (proposed: 0.85). This is the only config change.
5. Run Slice 2 in confirm-queue-only mode for at least 2 weeks first to measure proposed-vs-confirmed agreement (the auto-commit dry run).

### Mitigations layered behind any future auto-commit

1. **Risk-class gating still applies post-commit.** Work orders go through `cc_enqueue_with_gating`, so anything beyond `auto`-class still requires Brian's one-press approval. Auto-commit writes an answer + queues a work order — it does not bypass dispatch gating.
2. **Server-side threshold re-check.** `cc_finish_extraction_with_answer` re-validates the confidence value against the live GUC; the runner cannot lie about the threshold.
3. **Option-id snapshot validation.** Identical logic to `cc_confirm_decision_token`. LLM hallucination cannot inject an unknown id.
4. **Append-only audit trail.** Every auto-commit emits `decision_extracted_and_answered` with the full LLM payload.

---

## 1. Where Slice 2 sits

Slice 1 closes the loop for **button** answers. Slice 2 closes the loop for **typed** answers.

```
Slice 1 (shipped):
  routed_to_client → sent → clicked → answered → work order queued
                                   ↑
                                   client clicks magic-link button

Slice 2 (this design):
  sent → replied (cc-gmail-inbound matches reply)
       → extracting (this slice: runner claims via cc_claim_extraction_task)
            ├─ high confidence  → answered            (auto-commit, work order queued)
            ├─ low conf + budget → awaiting_clarify   → clarify_sent → (loops back to replied on next reply)
            ├─ low conf + no budget → awaiting_operator_review
            └─ off-topic / unparseable → awaiting_operator_review
```

The runner already polls `state='rewriting'` rows on every tick (Slice 1). Slice 2 adds a third claim attempt on the same tick for `state='replied' AND llm_extraction IS NULL`.

---

## 2. Task row shape — `ExtractionTask`

`cc_claim_extraction_task(p_runner, p_lease_seconds)` returns the full `cc_decision_email_sends` row. The TypeScript surface mirrors `RewriteTask`:

```ts
// runner/src/controlPlane.ts (additions)
export type ExtractionTask = {
  id: string;                      // send_id
  app_id: string;
  issue_id: string;
  decision_external_ref: string;

  // Context for the LLM
  raw_decision_title: string;
  raw_decision_body: string | null;
  rewritten_subject: string | null;   // what the client actually received
  rewritten_body: string | null;      // what the client actually received
  options_snapshot: unknown;          // validated option set (id+label)

  // The input
  raw_reply_text: string;             // not-null when state='replied'

// Recipient context (for prompt context only — runner never sends Gmail)
  recipient_email: string;
  recipient_name: string | null;

  // Claim fence (returned by claim, required by every finish RPC)
  claim_token: string;                // uuid, generated on each successful claim

  // Budget + retry
  clarification_attempt_count: number;
  attempt_count: number;
  max_attempts: number;

  // Risk class (re-derived on commit; carried for context only)
  risk_class: "auto" | "authorize" | "destructive" | "production";
};
```

**Server-bound fields the runner NEVER sees:**
- `magic_link_token_hash`, `magic_link_tokens` (raw tokens were destroyed at Slice 1 send time; only hashes survive)
- `gmail_message_id`, `gmail_thread_id` (threading is done server-side at clarify-send time)
- `decision_answer_id`, per-recipient secrets

The runner's job is to read the reply, decide an outcome, and call one finishing RPC. All Gmail-side work — including minting fresh magic-link tokens for the clarification email — happens in edge functions where the OAuth refresh token already lives.

---

## 3. Mac Studio Claude prompt

### 3.1 Prompt template (`buildExtractionPrompt`)

```
You extract a structured decision from a free-text email reply.

Return ONLY valid JSON with these keys:
  matched_option_id        string | null
  confidence               number 0..1
  rationale                string (<= 240 chars)
  ask_clarifying_question  string | null  (<= 400 chars; required iff matched_option_id is null OR confidence < HIGH_THRESHOLD)
  signals                  { explicit_option_mention: boolean, explicit_accept_decline: boolean, multi_option_mention: boolean, off_topic: boolean, hedging_language: boolean }

Rules:
- matched_option_id MUST be exactly one of the option ids listed below, or null.
- Never invent new option ids. Never reorder. Never edit labels.
- If the reply mentions multiple options positively, return matched_option_id=null and explain in rationale.
- If the reply is off-topic ("thanks", "got it", "let me think"), return matched_option_id=null and signals.off_topic=true. Confidence should reflect that you have no answer (low).
- If the reply contains a counter-question or asks to discuss, return matched_option_id=null and propose a clarifying question that re-poses the choice in plain English with the option labels listed.
- Hedging language ("maybe", "I think", "probably", "either could work") forces confidence below the HIGH_THRESHOLD even if a single option is mentioned.

High-confidence signals (use these to justify confidence >= HIGH_THRESHOLD):
- The reply contains the option label verbatim or a close paraphrase, AND no other option is mentioned positively.
- The reply contains the option id verbatim (snake_case form).
- For binary options: an unambiguous "yes/approve/go ahead" or "no/decline/skip" that maps 1:1 to one of the options.
- A clear ordinal/numeric reference matching only one option ("option 2", "the second one", "the auto-pick one").

Never auto-commit (force confidence < HIGH_THRESHOLD) when:
- More than one option is mentioned positively, even if one is mentioned more.
- The reply re-opens the question or asks for clarification ("which do you think?", "what would you recommend?").
- The reply asks to defer ("let's discuss", "let me think on it", "circle back").
- The reply is off-topic.
- The reply contains conditional language that doesn't deterministically resolve ("if X then A, otherwise B").

HIGH_THRESHOLD is set by the platform, but assume 0.85 for your scoring.

DECISION CONTEXT:
{
  "decision_external_ref": "<ref>",
  "raw_question_title": "<title>",
  "what_the_client_received": {
    "subject": "<rewritten_subject>",
    "body": "<rewritten_body>"
  },
  "options": [
    { "id": "<id>", "label": "<label>" },
    ...
  ],
  "client_reply": "<raw_reply_text>"
}
```

The runner injects `HIGH_THRESHOLD` from env (`EXTRACTION_AUTO_COMMIT_CONFIDENCE`, default 0.85) into the prompt so the LLM uses the same numeric floor the RPC uses. The RPC re-validates on commit (defense in depth).

### 3.2 Output JSON schema

```ts
type LlmExtraction = {
  matched_option_id: string | null;
  confidence: number;            // 0..1, validated server-side
  rationale: string;             // <= 500 chars, stored verbatim
  ask_clarifying_question: string | null;
  signals: {
    explicit_option_mention: boolean;
    explicit_accept_decline: boolean;
    multi_option_mention: boolean;
    off_topic: boolean;
    hedging_language: boolean;
  };
  // populated server-side, not by the LLM
  model: "claude-cli";
  extracted_at: string;          // ISO8601
  runner_id: string;
  prompt_version: "slice2-v1";
};
```

### 3.3 Parser (`parseExtractionOutput`) — defensive

Mirrors `parseRewriteOutput`:
- Pull the JSON object out of stdout (fenced or unfenced).
- `JSON.parse` it.
- Validate `matched_option_id` is either `null` or a string in the set of `options_snapshot` ids.
- Clamp `confidence` to `[0, 1]`; reject NaN/missing → treat as 0.
- Trim `rationale` to 500 chars.
- Trim `ask_clarifying_question` to 400 chars (or null).
- Coerce missing `signals` fields to `false`.
- If `matched_option_id` is a non-matching string, downgrade to `null` and force `requires_human: true` in the audit detail.

---

## 4. The four extraction outcomes

The runner makes the routing decision client-side using these rules, then calls exactly one finishing RPC. All four outcomes are exhaustive.

### 4.0 Decision precedence (strict evaluation order)

Evaluate in order; **first match wins**. This eliminates the ambiguity inherent in mixed-AND/OR conditions.

```
1. Outcome D (off-topic / unparseable):
     signals.off_topic == true
     OR confidence <= EXTRACTION_OFF_TOPIC_FLOOR (default 0.20)
     OR (matched_option_id == null AND ask_clarifying_question is empty)
     → reason = 'off_topic' | 'unparseable'

2. Outcome D (hallucinated option):
     matched_option_id is non-null AND not present in options_snapshot ids
     → reason = 'option_hallucinated'

3. Outcome A (auto-commit) — unreachable with default threshold 1.01:
     matched_option_id valid in options_snapshot
     AND confidence >= EXTRACTION_AUTO_COMMIT_CONFIDENCE
     AND signals.multi_option_mention == false
     AND signals.hedging_language    == false
     AND signals.off_topic           == false

4. Outcome B (clarify) — needs budget and on-topic:
     clarification_attempt_count < 1
     AND signals.off_topic == false
     AND (ask_clarifying_question is non-empty OR a generic fallback question can be used)

5. Outcome C (needs review) — default fallback:
     everything else (low confidence with budget exhausted, ambiguous-but-on-topic with no good clarify question, etc.)
     → reason = 'budget_exhausted' | 'low_confidence'
```

With the default `EXTRACTION_AUTO_COMMIT_CONFIDENCE = 1.01`, branch 3 is unreachable (`confidence > 1.0` is impossible per the parser's clamp), so the runner only ever takes branches B/C/D.

### 4.1 Outcome routing summary

| # | Trigger | Finishing RPC | New state | Side effect |
|---|---|---|---|---|
| **A. High-confidence match** | `matched_option_id` non-null AND in `options_snapshot` AND `confidence >= EXTRACTION_AUTO_COMMIT_CONFIDENCE` AND `signals.multi_option_mention=false` AND `signals.hedging_language=false` AND `signals.off_topic=false` | `cc_finish_extraction_with_answer` | `answered` (then `done` after work order queued) | Writes `cc_decision_answers`, calls `cc_enqueue_with_gating`, audits `decision_extracted_and_answered` |
| **B. Low confidence + budget remaining** | `confidence < EXTRACTION_AUTO_COMMIT_CONFIDENCE` AND `clarification_attempt_count < 1` AND LLM produced an `ask_clarifying_question` OR signals indicate ambiguous-but-on-topic | `cc_finish_extraction_with_clarify` | `awaiting_clarify` | Stores `ask_clarifying_question` in `llm_extraction.proposed_clarifying_question`; the `cc-auto-clarify` cron edge function (existing Gmail send infra) picks it up and sends, then transitions to `clarify_sent` and sets `clarification_attempt_count=1` |
| **C. Low confidence + budget exhausted** | `confidence < EXTRACTION_AUTO_COMMIT_CONFIDENCE` AND `clarification_attempt_count >= 1` | `cc_finish_extraction_needs_review` | `awaiting_operator_review` | Surfaces in operator confirm queue with `llm_extraction.requires_human=true, reason='budget_exhausted'` |
| **D. Off-topic / unparseable** | `signals.off_topic=true` OR `matched_option_id=null` AND no usable clarifying question can be posed (e.g., reply is "thanks" or unrelated) OR `confidence <= 0.20` | `cc_finish_extraction_needs_review` | `awaiting_operator_review` | Surfaces in operator confirm queue with `llm_extraction.requires_human=true, reason='off_topic'` or `'unparseable'` |

**Note on outcome A:** The work order enqueue uses the same `cc_enqueue_with_gating` call as Slice 1's `cc_confirm_decision_token`. Risk-class gating still applies — anything past `auto` still pauses for Brian's one-press approval.

**Note on outcome B:** The runner does NOT itself send Gmail. Gmail OAuth secrets and send logic stay in the edge functions (where they live today). The runner's job is to mark the row `awaiting_clarify`; the cron-driven `cc-auto-clarify` edge function does the actual send.

**Decision tree (Mermaid form):**

```
                  extraction completes
                            │
                            ▼
              matched_option_id valid? ──no──┐
                            │                │
                           yes               │
                            │                │
              confidence >= threshold?       │
                            │                │
            ┌───── yes ─────┴───── no ───────┤
            ▼                                 ▼
       multi_mention?                  signals.off_topic?
            │                                 │
       ┌────┴────┐                       ┌────┴────┐
       no       yes                      no       yes
       │        │                        │        │
       ▼        ▼                        ▼        ▼
   AUTO-COMMIT downgrade                clarify  needs_review
   (Outcome A)  to needs_review         budget?  (Outcome D)
                (Outcome D)              │
                                    ┌────┴────┐
                                    yes      no
                                    │        │
                                    ▼        ▼
                              awaiting_  needs_review
                              clarify    (Outcome C)
                              (Outcome B)
```

---

## 5. Control plane RPCs (signatures + key invariants)

All five follow the Slice 1 pattern: `SECURITY DEFINER`, `SET search_path = public, pg_temp`, REVOKE from PUBLIC/anon/authenticated, GRANT to service_role only. All accept `p_runner` as actor and write to `cc_audit_events`. Full bodies omitted; signatures + body sketches below.

### 5.1 `cc_claim_extraction_task(p_runner text, p_lease_seconds int default 300) RETURNS cc_decision_email_sends`

```sql
-- Sketch (modeled on cc_claim_rewrite_task from migration 025):
DECLARE
  v_row    cc_decision_email_sends;
  v_runner text     := NULLIF(left(btrim(COALESCE(p_runner,'')), 200), '');
  v_lease  interval := make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 300), 30));
  v_claim  uuid     := gen_random_uuid();
BEGIN
  IF v_runner IS NULL THEN RAISE EXCEPTION 'p_runner is required' USING ERRCODE = 'P0001'; END IF;

  -- Step 1: sweep stuck extractions whose attempts are exhausted.
  UPDATE cc_decision_email_sends
  SET state = 'awaiting_operator_review',
      extraction_started_at = NULL,
      claim_token = NULL,
      last_error = COALESCE(last_error, 'extraction exhausted attempts and lease expired'),
      llm_extraction = jsonb_set(COALESCE(llm_extraction, '{}'::jsonb), '{requires_human}', 'true')
  WHERE deleted_at IS NULL
    AND state IN ('replied','extracting')
    AND attempt_count >= max_attempts
    AND extraction_started_at IS NOT NULL
    AND extraction_started_at < now() - v_lease;

  -- Step 2: atomic claim of one row. Generates a fresh claim_token each time;
  -- this is the fence every finish/fail RPC checks against (prevents stale
  -- workers — even from the SAME runner identity — from completing a
  -- newer claim after a lease was lost).
  UPDATE cc_decision_email_sends s
  SET state = 'extracting',
      extraction_started_at = now(),
      extraction_runner_id = v_runner,
      claim_token = v_claim,
      attempt_count = s.attempt_count + 1,
      last_error = NULL
  WHERE s.id = (
    SELECT id FROM cc_decision_email_sends
    WHERE deleted_at IS NULL
      AND (
        (state = 'replied' AND llm_extraction IS NULL) OR
        (state = 'extracting' AND extraction_started_at < now() - v_lease)
      )
      AND attempt_count < max_attempts
      AND raw_reply_text IS NOT NULL
    ORDER BY replied_at ASC NULLS LAST, created_at ASC
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING * INTO v_row;

  IF v_row.id IS NOT NULL THEN
    INSERT INTO cc_audit_events (app_id, actor, event_type, detail)
    VALUES (v_row.app_id, 'claude-extraction:' || v_runner, 'decision_extraction_started',
      jsonb_build_object('send_id', v_row.id, 'issue_id', v_row.issue_id,
                         'attempt_count', v_row.attempt_count,
                         'claim_token', v_claim));
  END IF;
  RETURN v_row;
END;
```

**Invariants:**
- Only rows with `raw_reply_text IS NOT NULL` are claimable (defends against half-written inbound rows).
- Both `state='replied'` (first claim) and `state='extracting'` (re-claim after lease expiry) are eligible.
- `attempt_count` increments on every claim; once it hits `max_attempts` the sweeper retires the row to `awaiting_operator_review`.
- `claim_token` (uuid) is fresh on every claim. Every finishing RPC requires the runner to present it. A re-claim by the same runner identity invalidates the prior token — stale completions raise.
- Lease seconds are clamped to `>= 30` (matches migration 025's `cc_claim_rewrite_task`).

### 5.2 `cc_finish_extraction_with_answer(p_send_id uuid, p_runner text, p_claim_token uuid, p_option_id text, p_confidence numeric, p_rationale text, p_llm_extraction jsonb) RETURNS jsonb`

```sql
-- Sketch (commit path; mirrors cc_confirm_decision_token from migration 024):
DECLARE
  v_threshold numeric := COALESCE(
    NULLIF(current_setting('cc.extraction_auto_commit_confidence', true), '')::numeric,
    1.01);  -- default: auto-commit OFF (see §0)
BEGIN
  IF p_runner IS NULL OR btrim(p_runner) = '' THEN RAISE EXCEPTION 'p_runner is required' USING ERRCODE='P0001'; END IF;
  IF p_claim_token IS NULL THEN RAISE EXCEPTION 'p_claim_token is required' USING ERRCODE='P0001'; END IF;
  IF p_option_id IS NULL OR btrim(p_option_id) = '' THEN RAISE EXCEPTION 'p_option_id is required' USING ERRCODE='P0001'; END IF;
  IF p_confidence IS NULL OR p_confidence < 0 OR p_confidence > 1 THEN RAISE EXCEPTION 'p_confidence must be in [0,1]' USING ERRCODE='P0001'; END IF;
  IF p_llm_extraction IS NULL OR jsonb_typeof(p_llm_extraction) <> 'object' THEN RAISE EXCEPTION 'p_llm_extraction must be a JSON object' USING ERRCODE='P0001'; END IF;

  -- 1. Lock the send row; assert ownership + state + claim_token.
  SELECT * INTO v_row FROM cc_decision_email_sends
  WHERE id = p_send_id
    AND deleted_at IS NULL
    AND state = 'extracting'
    AND extraction_runner_id = p_runner
    AND claim_token = p_claim_token
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'extraction task not claimable by runner (stale claim_token, wrong runner, or wrong state)' USING ERRCODE='P0001'; END IF;

  -- 2. Validate option_id against the snapshot. SAME logic as cc_confirm_decision_token.
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_row.options_snapshot) opt
    WHERE COALESCE(opt ->> 'id', opt ->> 'value', opt ->> 'key') = p_option_id
  ) THEN RAISE EXCEPTION 'option_id is not valid for this decision' USING ERRCODE='P0001'; END IF;

  -- 3. Server-side threshold re-check (defense in depth). Default GUC = 1.01
  --    means auto-commit is OFF unless explicitly enabled per §0.
  IF p_confidence < v_threshold THEN
    RAISE EXCEPTION 'confidence % below auto-commit threshold %; use cc_finish_extraction_with_clarify or cc_finish_extraction_needs_review',
      p_confidence, v_threshold USING ERRCODE='P0001';
  END IF;

  -- 4. Write cc_decision_answers + transition the issue (calls existing cc_resolve_issue).
  v_answer := cc_resolve_issue(
    v_row.issue_id, 'answer_decision', p_option_id,
    (SELECT jsonb_agg(opt - 'token_hash' - 'confirm_url') FROM jsonb_array_elements(v_row.options_snapshot) opt),
    format('LLM extraction (confidence=%s): %s', p_confidence, COALESCE(p_rationale, '')),
    v_row.risk_class, NULL,
    'claude-extraction:' || p_runner,
    v_row.decision_external_ref
  );
  v_answer_id := (v_answer ->> 'decision_answer_id')::uuid;

  -- 5. Transition the send row.
  UPDATE cc_decision_email_sends
  SET state = 'answered',
      answered_at = now(),
      selected_option = p_option_id,
      decision_answer_id = v_answer_id,
      llm_extraction = p_llm_extraction,
      extraction_started_at = NULL,
      operator_confirmed_by = 'claude-extraction:' || p_runner,
      operator_confirmed_at = now()
  WHERE id = p_send_id
  RETURNING * INTO v_row;

  -- 6. Enqueue the work order (same as cc_confirm_decision_token).
  v_change_spec := jsonb_build_object(
    'intent', format('Apply extracted answer %s to decision %s.', p_option_id, v_row.raw_decision_title),
    'affected_area', v_row.decision_external_ref,
    'acceptance_criteria', jsonb_build_array('Implement the extracted choice', 'All existing tests pass', 'No schema-destructive operations'),
    'constraints', jsonb_build_array('Single PR', 'Branch must start with cc/', 'Do not modify CI configuration')
  );
  v_work_order := cc_enqueue_with_gating(
    v_row.app_id, v_change_spec, v_row.risk_class,
    'decision_email_extracted:' || v_row.id::text || ':' || p_option_id,  -- new idempotency key prefix
    v_answer_id, NULL, 'claude-extraction:' || p_runner
  );

  -- 7. Audit.
  INSERT INTO cc_audit_events (app_id, actor, event_type, detail)
  VALUES (v_row.app_id, 'claude-extraction:' || p_runner, 'decision_extracted_and_answered',
    jsonb_build_object('send_id', v_row.id, 'issue_id', v_row.issue_id,
                       'decision_answer_id', v_answer_id, 'work_order_id', v_work_order.id,
                       'option_id', p_option_id, 'confidence', p_confidence));

  RETURN jsonb_build_object('send', to_jsonb(v_row), 'answer', v_answer, 'work_order', to_jsonb(v_work_order));
END;
```

**Critical invariant:** the idempotency_key prefix is `decision_email_extracted:` (distinct from Slice 1's `decision_email:`). This prevents a button click and an extracted answer from accidentally sharing an idempotency key on the same send.

### 5.3 `cc_finish_extraction_with_clarify(p_send_id uuid, p_runner text, p_claim_token uuid, p_clarifying_question text, p_confidence numeric, p_llm_extraction jsonb) RETURNS cc_decision_email_sends`

```sql
DECLARE
  v_question text := NULLIF(left(btrim(COALESCE(p_clarifying_question,'')), 400), '');
BEGIN
  IF p_runner IS NULL OR btrim(p_runner) = '' THEN RAISE EXCEPTION 'p_runner is required' USING ERRCODE='P0001'; END IF;
  IF p_claim_token IS NULL THEN RAISE EXCEPTION 'p_claim_token is required' USING ERRCODE='P0001'; END IF;
  IF v_question IS NULL THEN RAISE EXCEPTION 'p_clarifying_question is required' USING ERRCODE='P0001'; END IF;
  IF p_confidence IS NULL OR p_confidence < 0 OR p_confidence > 1 THEN RAISE EXCEPTION 'p_confidence must be in [0,1]' USING ERRCODE='P0001'; END IF;
  IF p_llm_extraction IS NULL OR jsonb_typeof(p_llm_extraction) <> 'object' THEN RAISE EXCEPTION 'p_llm_extraction must be a JSON object' USING ERRCODE='P0001'; END IF;

  UPDATE cc_decision_email_sends
  SET state = 'awaiting_clarify',
      llm_extraction = p_llm_extraction ||
        jsonb_build_object('proposed_clarifying_question', v_question),
      extraction_started_at = NULL,
      claim_token = NULL,
      last_error = NULL
  WHERE id = p_send_id
    AND deleted_at IS NULL
    AND state = 'extracting'
    AND extraction_runner_id = p_runner
    AND claim_token = p_claim_token
    AND clarification_attempt_count < 1
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'extraction task not claimable by runner OR clarification budget exhausted' USING ERRCODE='P0001'; END IF;

  INSERT INTO cc_audit_events (app_id, actor, event_type, detail)
  VALUES (v_row.app_id, 'claude-extraction:' || p_runner, 'decision_extraction_proposed_clarify',
    jsonb_build_object('send_id', v_row.id, 'issue_id', v_row.issue_id, 'confidence', p_confidence));
  RETURN v_row;
END;
```

**Invariant:** the RPC refuses to flip to `awaiting_clarify` if `clarification_attempt_count >= 1` — defense against a runner bug or a stale row racing the budget check. The runner gets the row already incremented to "out of budget" only via the sweeper (see 5.1), but this RPC defends in depth.

The actual send is performed by `cc-auto-clarify` (new edge function in §7 of master plan, but Slice 2 ships it).

### 5.4 `cc_finish_extraction_needs_review(p_send_id uuid, p_runner text, p_claim_token uuid, p_llm_extraction jsonb, p_reason text) RETURNS cc_decision_email_sends`

```sql
DECLARE
  v_reason text := NULLIF(btrim(COALESCE(p_reason,'')), '');
BEGIN
  IF p_runner IS NULL OR btrim(p_runner) = '' THEN RAISE EXCEPTION 'p_runner is required' USING ERRCODE='P0001'; END IF;
  IF p_claim_token IS NULL THEN RAISE EXCEPTION 'p_claim_token is required' USING ERRCODE='P0001'; END IF;
  IF v_reason IS NULL OR v_reason NOT IN ('off_topic','unparseable','budget_exhausted','option_hallucinated','low_confidence') THEN
    RAISE EXCEPTION 'p_reason must be one of off_topic, unparseable, budget_exhausted, option_hallucinated, low_confidence' USING ERRCODE='P0001';
  END IF;
  IF p_llm_extraction IS NULL OR jsonb_typeof(p_llm_extraction) <> 'object' THEN RAISE EXCEPTION 'p_llm_extraction must be a JSON object' USING ERRCODE='P0001'; END IF;

  UPDATE cc_decision_email_sends
  SET state = 'awaiting_operator_review',
      llm_extraction = p_llm_extraction ||
        jsonb_build_object('requires_human', true, 'reason', v_reason),
      extraction_started_at = NULL,
      claim_token = NULL,
      last_error = NULL
  WHERE id = p_send_id
    AND deleted_at IS NULL
    AND state = 'extracting'
    AND extraction_runner_id = p_runner
    AND claim_token = p_claim_token
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'extraction task not claimable by runner (stale claim_token or wrong state)' USING ERRCODE='P0001'; END IF;

  INSERT INTO cc_audit_events (app_id, actor, event_type, detail)
  VALUES (v_row.app_id, 'claude-extraction:' || p_runner, 'decision_extraction_needs_review',
    jsonb_build_object('send_id', v_row.id, 'issue_id', v_row.issue_id, 'reason', v_reason,
                       'matched_option_id', p_llm_extraction ->> 'matched_option_id',
                       'confidence', p_llm_extraction -> 'confidence'));
  RETURN v_row;
END;
```

### 5.5 `cc_fail_extraction_task(p_send_id uuid, p_runner text, p_claim_token uuid, p_error text) RETURNS cc_decision_email_sends`

Identical structure to `cc_fail_rewrite_task` from migration 024. Reverts state from `extracting` back to `replied` when there's budget remaining; flips to `awaiting_operator_review` once `attempt_count >= max_attempts`.

```sql
BEGIN
  IF p_runner IS NULL OR btrim(p_runner) = '' THEN RAISE EXCEPTION 'p_runner is required' USING ERRCODE='P0001'; END IF;
  IF p_claim_token IS NULL THEN RAISE EXCEPTION 'p_claim_token is required' USING ERRCODE='P0001'; END IF;

  UPDATE cc_decision_email_sends
  SET state = CASE
        WHEN attempt_count >= max_attempts THEN 'awaiting_operator_review'::cc_decision_email_state
        ELSE 'replied'::cc_decision_email_state
      END,
      extraction_started_at = NULL,
      claim_token = NULL,
      last_error = left(COALESCE(p_error, 'extraction failed'), 2000)
  WHERE id = p_send_id
    AND deleted_at IS NULL
    AND state = 'extracting'
    AND extraction_runner_id = p_runner
    AND claim_token = p_claim_token
  RETURNING * INTO v_row;
  IF NOT FOUND THEN RAISE EXCEPTION 'extraction task not claimable by runner (stale claim_token or wrong state)' USING ERRCODE='P0001'; END IF;

  IF v_row.state = 'awaiting_operator_review' THEN
    INSERT INTO cc_audit_events (app_id, actor, event_type, detail)
    VALUES (v_row.app_id, 'claude-extraction:' || p_runner, 'decision_extraction_exhausted',
      jsonb_build_object('send_id', v_row.id, 'issue_id', v_row.issue_id,
                         'attempt_count', v_row.attempt_count, 'last_error', v_row.last_error));
  END IF;
  RETURN v_row;
END;
```

### 5.6 Grants

```sql
REVOKE EXECUTE ON FUNCTION public.cc_claim_extraction_task(text, integer)              FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_finish_extraction_with_answer(uuid,text,text,numeric,text,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_finish_extraction_with_clarify(uuid,text,text,numeric,jsonb)    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_finish_extraction_needs_review(uuid,text,jsonb,text)            FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cc_fail_extraction_task(uuid,text,text)                            FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON ... (each) TO service_role;
```

---

## 6. Confidence threshold

**Proposed: `EXTRACTION_AUTO_COMMIT_CONFIDENCE = 0.85`**

### Rationale

- **Aligns with the existing master plan.** `PHASE_5_EMAIL_DECISION_ENGINE.md §6.6` already locked 0.85 as the threshold above which "no human review needed" semantically. The brief inherits this.
- **0.85 is the Claude-extraction sweet spot.** Empirically, when Claude is given an enumerated-option extraction task with clear instructions, it produces confidence ≥ 0.9 on unambiguous replies and ≤ 0.6 on hedged ones; the gap around 0.85 captures the "single option mentioned with no hedging" cases.
- **The mitigations in §0 absorb the residual risk.** Risk-class gating still applies. The operator can revert via the cockpit. The cap is a single env var.

### Tuning plan

Track these in audit-event aggregations:

| Metric | Target after 2 weeks of Slice 2 live |
|---|---|
| `decision_extracted_and_answered` events per week | Whatever volume; track for trend |
| Of those: % subsequently reverted/edited by operator | < 5% |
| `decision_extraction_needs_review` events per week | < 30% of `decision_reply_received` events |
| Median time `replied` → `answered` for auto-commit path | < 60s |

**Auto-tighten rule:** if the revert rate exceeds 5% over a rolling 14-day window, automatically nudge `EXTRACTION_AUTO_COMMIT_CONFIDENCE` up by 0.05 (next minor: 0.90, 0.95, then off at 1.01). This auto-tighten can be ratcheted via cron in a future slice; v1.0 just surfaces the metric in the Settings page.

### Lower bound

The runner also enforces a **`EXTRACTION_OFF_TOPIC_FLOOR = 0.20`** below which it never sends a clarification — sub-0.20 replies are presumed off-topic and go straight to operator review (outcome D). This prevents the clarification cron from harassing a customer who just sent "thanks!"

---

## 7. Clarification email template

### 7.0 Token handling (security-critical)

The original raw magic-link tokens are **destroyed forever at Slice 1 send time** — only HMAC hashes are stored in `magic_link_tokens` and `magic_link_token_hash`. The clarification email therefore CANNOT reuse the original buttons; it must **mint fresh per-option tokens server-side** in the `cc-auto-clarify` edge function:

```
For each option in options_snapshot:
  raw_token = randomToken(32)
  token_hash = HMAC-SHA256(CC_MAGIC_LINK_SECRET, `${send_id}:${option_id}:${raw_token}`)
  confirm_url = `${CC_PUBLIC_DECISION_BASE_URL}/decisions/confirm?t=${raw_token}&o=${option_id}&s=${send_id}`

Append each {token_hash, option_id, minted_at:'clarify'} to magic_link_tokens (jsonb).
The raw_token is included only in the outbound email body; it never persists anywhere.
```

Both the original tokens (still valid) and the new clarification tokens coexist in `magic_link_tokens`. `cc_get_decision_confirm_data` / `cc_confirm_decision_token` already iterate the whole array, so either set of buttons can be clicked.

### 7.1 Threading and identity

| Field | Value |
|---|---|
| From | `Brian Lewis <brian.lewis@blackrockai.co>` (same as original send) |
| Reply-To | `brian.lewis@blackrockai.co` |
| To | Same `recipient_email` as original |
| Subject | `Re: <rewritten_subject>` (Gmail-standard reply prefix; threads automatically in the recipient's inbox) |
| `In-Reply-To` header | `<gmail_message_id>` of the original send (the most recent message we sent in the thread) |
| `References` header | `<gmail_message_id>` of the original send (preserves thread chain) |
| Custom header `X-CC-Clarification: 1` | Internal audit tag only; we do NOT rely on it for inbound matching (see §7.2) |

The In-Reply-To + thread-id pinning means the recipient sees the clarification **as a continuation of the same Gmail thread**, not as a new email. This is how the recipient knows it isn't a duplicate — it shows up in the same conversation, indented under Brian's previous send.

### 7.2 Inbound matching after the clarification (important)

**Custom outbound headers like `X-CC-Send-Id` do NOT survive replies.** When the recipient hits reply, their client constructs a fresh message; only `In-Reply-To` and `References` echo prior message IDs. So once Slice 2 sends a clarification, the next reply's `In-Reply-To` will reference the CLARIFICATION message ID, not the original send's `gmail_message_id`.

To keep `cc-gmail-inbound` matching the right send row, migration 026 adds:

- `clarification_gmail_message_id text` — captured when `cc-auto-clarify` calls `gmail.users.messages.send`.
- Index on `(clarification_gmail_message_id) WHERE clarification_gmail_message_id IS NOT NULL AND deleted_at IS NULL`.

And updates `cc-gmail-inbound`'s `findSend()` logic to additionally try:

```ts
if (inReplyTo) {
  // existing: match against gmail_message_id
  // NEW: also match against clarification_gmail_message_id
  const rows = await cpGet(`cc_decision_email_sends?or=(gmail_message_id.eq.${encoded},clarification_gmail_message_id.eq.${encoded})&...`);
}
```

`gmail_thread_id` matching continues to work — Gmail uses the same `threadId` for the entire conversation, so clarification replies land in the same thread.

**`X-CC-Clarification: 1` is for audit/debug only.** It tags outbound clarifications so the inbound function can emit `decision_clarification_reply_received` (vs. plain `decision_reply_received`) when the matched row already had `clarification_sent_at` populated.

### 7.2 Body template (plaintext + HTML)

The clarifying question text comes from the LLM (`llm_extraction.proposed_clarifying_question`). If the LLM didn't supply one (e.g. multi-option mention), use the fallback `"Just to make sure I picked this up right — would you like option <A>, option <B>, or option <C>?"`.

```
Hey <recipient_name>,

Thanks for the reply! I want to make sure I'm reading it right before
I move this forward.

<LLM_clarifying_question | fallback>

To keep it simple, here are the same options again:

  • <Option A label>     → <magic-link URL A>
  • <Option B label>     → <magic-link URL B>
  • <Option C label>     → <magic-link URL C>

Or just reply with the one you want and I'll handle the rest.

Thanks,
Brian

(P.S. — sorry to ask twice; I'm just double-checking my read of your last
reply. This is the only follow-up I'll send; if it's still not the right
read, I'll handle it on my end.)
```

The HTML version uses the same three styled CTAs as the original (re-using the per-option magic-link URLs from `magic_link_tokens` — **the tokens and TTL are unchanged**, no new tokens minted). This means a click on a clarification button hits the same `cc-decision-confirm-submit` endpoint and commits identically to a click on the original.

### 7.3 Send infrastructure

A new edge function `cc-auto-clarify` (or extending Slice 1's send infra in a new file):

```
POST /functions/v1/cc-auto-clarify
Auth: internal cron token (CC_INTERNAL_TOKEN)
```

Flow:
1. `SELECT * FROM cc_decision_email_sends WHERE state='awaiting_clarify' AND clarification_attempt_count < 1 AND deleted_at IS NULL ORDER BY updated_at LIMIT 25`.
2. For each row:
   a. Compose the RFC-822 message (plaintext + HTML multipart, threading headers per §7.1).
   b. `gmailSend(raw)` from `_shared/phase5.ts`.
   c. UPDATE the row: `state='clarify_sent'`, `clarification_sent_at=now()`, `clarification_attempt_count=clarification_attempt_count+1`.
   d. Audit `decision_clarification_sent`.
3. Schedule via Supabase cron every 5 minutes (alongside aggregator).

The runner does NOT call this — the runner only flips the row to `awaiting_clarify` and trusts the cron to send.

### 7.4 What the recipient sees

Subject in their inbox: same thread as the original ("Quick question about rebate stacking on QEP quotes"). When they expand the thread, they see Brian's original send, then his clarification reply underneath. Three buttons in the clarification, same as before. No duplicates, no spam.

---

## 8. Idempotency

Seven layers of protection against double-extraction:

### 8.1 Atomic claim (DB-level)

`cc_claim_extraction_task` uses `FOR UPDATE SKIP LOCKED` inside a sub-select, then `UPDATE … SET state='extracting'`. Only one runner can flip a given row from `replied → extracting`. The other runner gets `NULL` back from the RPC and moves on.

### 8.2 State + ownership check on every finishing RPC

Every `cc_finish_extraction_*` RPC has:

```sql
WHERE id = p_send_id
  AND state = 'extracting'
  AND extraction_runner_id = p_runner
```

If the runner crashes mid-task and the same Pub/Sub push triggers a new extraction on the same row, the new runner gets a fresh claim (after the lease expires) with a new `extraction_runner_id`. If the old runner somehow comes back to life, its finish RPC fails the state+ownership check and raises.

### 8.3 Work order idempotency_key (Slice 1 inheritance)

The auto-commit path uses idempotency key `decision_email_extracted:<send_id>:<option_id>`. `cc_enqueue_with_gating` already enforces uniqueness on this key. A duplicate extraction that somehow gets past the state check would still fail to enqueue a second work order.

### 8.4 Outbound Gmail message uniqueness (Slice 1 inheritance)

`cc_decision_email_sends_gmail_msg_idx` is unique on the **outbound** `gmail_message_id WHERE deleted_at IS NULL`. The same Gmail message ID we sent cannot map to two send rows.

**Caveat (and Slice 2 fix):** that index protects outbound only. Two distinct *inbound* Pub/Sub deliveries with different `gmail_message_id`s but matching the same send (e.g., recipient sends two replies, or the inbound function is called twice for the same conversation) would both try to UPDATE `raw_reply_text` on the same row. The Slice 1 inbound function partially defends with `state=in.(sent,delivered,opened,clicked,clarify_sent)` — only the first reply transitions the row out of those states.

Slice 2 hardens this further:

- Migration 026 adds `inbound_gmail_message_id text` and `inbound_received_at timestamptz` columns on `cc_decision_email_sends`.
- Unique index: `(inbound_gmail_message_id) WHERE inbound_gmail_message_id IS NOT NULL AND deleted_at IS NULL`.
- `cc-gmail-inbound` writes both `raw_reply_text` AND `inbound_gmail_message_id` in the same PATCH. If a second reply arrives with a different message ID, the unique index rejects it; the function audits `decision_inbound_already_processed` and the second reply is surfaced to the operator via a new `cc_decision_inbound_extra_replies` ledger (also added in 026) so nothing is silently dropped.
- The runner sees only the first reply (the one that transitioned the state to `replied`). If the operator needs the second reply, they pull it from the ledger via the cockpit.

This is the cleanest dedup: one extraction per send, with extras visibly logged.

### 8.5 History cursor advance (Slice 1 inheritance)

`cc-gmail-inbound` advances `cc_gmail_history_cursor.history_id` after processing. If Pub/Sub delivers the same historyId again, the next `history.list` call returns an empty result set.

### 8.6 Lease-expiry sweeper (built into 5.1)

If a runner crashes mid-task and never calls a finishing RPC, the lease (300s) expires and the next claim picks up the row, increments `attempt_count`, and resets `extraction_runner_id`. The crashed runner's claim is reaped via the same `FOR UPDATE SKIP LOCKED` mechanism.

### 8.7 What CAN'T happen

- ❌ Two work orders enqueued for the same extracted answer (idempotency_key).
- ❌ A `cc_decision_answers` row written twice for the same send (state check + cc_resolve_issue's own status guard).
- ❌ A clarification email sent twice for the same send (`clarification_attempt_count < 1` filter + DB check constraint `<= 1`).
- ❌ The runner committing on a stale option set (`options_snapshot` is locked at rewrite-ready and only the matched ID against THAT snapshot is accepted).

### 8.8 What CAN happen (acceptable)

- ⚠️ A row's `attempt_count` increments without commit if Claude times out mid-extraction. Bounded by `max_attempts=3`; after that the row moves to `awaiting_operator_review`.
- ⚠️ A duplicate inbound Pub/Sub push could trigger one extra claim attempt that finds nothing because the previous claim already finished. Harmless; one wasted RPC roundtrip.

---

## 9. Failure modes + retries

### 9.1 Retryable (state reverts to `replied`, attempt_count increments)

| Failure | Why retryable |
|---|---|
| Claude CLI exits non-zero with stderr matching `/rate.?limit/i` | Transient; backing off and re-running on the next poll usually succeeds. |
| Claude CLI exits non-zero with stderr matching `/network|timeout|ECONN/i` | Transient. |
| Claude CLI returns non-JSON stdout | Often a one-shot prompt-following failure; usually fixed on retry with the same prompt. Logged with `last_error='LLM output not parseable as JSON'`. |
| Control-plane HTTP 5xx on `cc_finish_extraction_*` | DB transient; runner re-tries on next claim. |
| `AbortError` from `signal.aborted` (lease lost) | Same pattern as work-order lease loss: throw `LeaseLostError`, do not call any finishing RPC, let the next runner re-claim after lease expiry. |

### 9.2 Permanent (after `attempt_count >= max_attempts`, state flips to `awaiting_operator_review`)

| Failure | Why permanent |
|---|---|
| Three consecutive non-JSON outputs from Claude | Prompt is broken or model is misbehaving; surfacing to operator is the right move. |
| Reply text empty after stripping quoted content | Nothing to extract; operator should look. |
| `options_snapshot` is empty or malformed (data corruption upstream) | Cannot validate any option_id; operator should look. |
| Claude returns `matched_option_id` that's never in the snapshot, three times in a row | LLM hallucination loop; operator review. |

When a row moves to `awaiting_operator_review` via the sweeper or via outcomes C/D, the operator confirm queue UI (Decisions page band) MUST surface:

- The original raw reply (truncated to ~600 chars in the card, full in the slideout).
- The LLM's last `llm_extraction` payload (with `requires_human=true` and `reason`).
- The three option buttons so the operator can commit in one click.

### 9.3 Hard-failure (state='failed')

Reserved for cases that can never resolve: e.g. the `cc_issues` row has been deleted (DB integrity error) or the `app_id` has been removed. The runner never directly sets `state='failed'`; that's reserved for upstream maintenance scripts.

### 9.4 Retry budget summary

| Counter | Cap | Behavior at cap |
|---|---|---|
| `attempt_count` (extraction) | `max_attempts=3` | Row → `awaiting_operator_review`, audit `decision_extraction_exhausted` |
| `clarification_attempt_count` | DB check `<= 1` | RPC refuses to flip to `awaiting_clarify` (per §5.3); runner must call `cc_finish_extraction_needs_review` instead |
| LLM-internal retries | None (single call per attempt) | n/a — retries happen at the runner-claim level, not inside `claudeCode.runPrompt` |

---

## 10. New schema additions (migration `026_phase5_slice2_extraction.sql`)

The migration is split into two transactions because `ALTER TYPE … ADD VALUE` cannot share a transaction with statements that reference the new value (Postgres limitation).

```sql
-- ============================================================================
-- Transaction 1: enum extension only (must commit before the new value is
-- referenced anywhere else).
-- ============================================================================
BEGIN;
ALTER TYPE public.cc_decision_email_state
  ADD VALUE IF NOT EXISTS 'awaiting_operator_review' BEFORE 'reminded';
COMMIT;

-- ============================================================================
-- Transaction 2: columns, indexes, RPCs, ledger.
-- ============================================================================
BEGIN;

-- 1. Add new columns.
ALTER TABLE public.cc_decision_email_sends
  ADD COLUMN IF NOT EXISTS claim_token uuid,
  ADD COLUMN IF NOT EXISTS clarification_gmail_message_id text,
  ADD COLUMN IF NOT EXISTS inbound_gmail_message_id text,
  ADD COLUMN IF NOT EXISTS inbound_received_at timestamptz;

-- 2. Inbound dedup index (see §8.4).
CREATE UNIQUE INDEX IF NOT EXISTS cc_decision_email_sends_inbound_msg_idx
  ON public.cc_decision_email_sends (inbound_gmail_message_id)
  WHERE inbound_gmail_message_id IS NOT NULL AND deleted_at IS NULL;

-- 3. Clarification reply matching index (see §7.2).
CREATE UNIQUE INDEX IF NOT EXISTS cc_decision_email_sends_clarify_msg_idx
  ON public.cc_decision_email_sends (clarification_gmail_message_id)
  WHERE clarification_gmail_message_id IS NOT NULL AND deleted_at IS NULL;

-- 4. Operator confirm queue index.
CREATE INDEX IF NOT EXISTS cc_decision_email_sends_operator_review_idx
  ON public.cc_decision_email_sends (state, updated_at DESC)
  WHERE deleted_at IS NULL AND state IN ('awaiting_operator_review','extracting');

-- 5. Auto-clarify cron index.
CREATE INDEX IF NOT EXISTS cc_decision_email_sends_awaiting_clarify_idx
  ON public.cc_decision_email_sends (state, updated_at ASC)
  WHERE deleted_at IS NULL AND state = 'awaiting_clarify';

-- 6. Threshold GUC with a safe SQL default in every RPC reader.
--    (Setting the GUC at the database level is best-effort; the RPC bodies
--    use COALESCE(NULLIF(current_setting(..., true), '')::numeric, 1.01)
--    so the default behavior is auto-commit OFF even if the GUC is missing.)
ALTER DATABASE postgres SET cc.extraction_auto_commit_confidence = '1.01';

-- 7. Extra-reply ledger (see §8.4). Captures inbound replies that arrive
--    after the row has already moved past 'replied' — these are visible to
--    the operator but do not race the extraction.
CREATE TABLE IF NOT EXISTS public.cc_decision_inbound_extra_replies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  send_id uuid NOT NULL REFERENCES public.cc_decision_email_sends(id) ON DELETE CASCADE,
  inbound_gmail_message_id text NOT NULL,
  raw_reply_text text,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (send_id, inbound_gmail_message_id)
);
ALTER TABLE public.cc_decision_inbound_extra_replies ENABLE ROW LEVEL SECURITY;
CREATE POLICY extra_replies_service_all ON public.cc_decision_inbound_extra_replies
  FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.cc_decision_inbound_extra_replies FROM anon, authenticated;
GRANT ALL ON public.cc_decision_inbound_extra_replies TO service_role;

-- 8. Update Slice 1 confirm RPCs to allow button clicks from new states.
--    Without this, a clarification-button click after the row moved to
--    'clarify_sent' would 404 in cc_get_decision_confirm_data.
CREATE OR REPLACE FUNCTION public.cc_get_decision_confirm_data(p_token_hash text, p_option_id text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
BEGIN
  -- body identical to migration 024 EXCEPT:
  --   AND s.state IN ('sent','delivered','opened','clicked',
  --                   'replied','extracting','awaiting_clarify','clarify_sent','awaiting_operator_review')
  -- The new states permit a button click even after a reply has landed.
  -- Terminal states ('answered','done','expired','bounced','failed') still excluded.
  ...
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cc_confirm_decision_token(p_token_hash text, p_option_id text, p_actor text DEFAULT 'client-magic-link')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $fn$
BEGIN
  -- body identical to migration 024 EXCEPT the same state-list widening.
  -- A button click from any non-terminal state still calls cc_resolve_issue
  -- + cc_enqueue_with_gating, transitioning the row to 'answered'.
  -- This is the canonical 'recipient chose explicitly' override that supersedes
  -- any in-flight extraction.
  ...
END;
$fn$;

-- 9. Five new extraction RPCs (see §5.1–5.5 for full sketches).
CREATE OR REPLACE FUNCTION public.cc_claim_extraction_task(text, integer) ...;
CREATE OR REPLACE FUNCTION public.cc_finish_extraction_with_answer(uuid, text, uuid, text, numeric, text, jsonb) ...;
CREATE OR REPLACE FUNCTION public.cc_finish_extraction_with_clarify(uuid, text, uuid, text, numeric, jsonb) ...;
CREATE OR REPLACE FUNCTION public.cc_finish_extraction_needs_review(uuid, text, uuid, jsonb, text) ...;
CREATE OR REPLACE FUNCTION public.cc_fail_extraction_task(uuid, text, uuid, text) ...;

-- 10. Grants (REVOKE + GRANT pattern from §5.6).
... 

COMMIT;
```

### Schema additions summary

| Column / Object | Purpose |
|---|---|
| `claim_token uuid` | Fence for finish/fail RPCs (see §5) |
| `clarification_gmail_message_id text` | Inbound matching for replies to the clarification (see §7.2) |
| `inbound_gmail_message_id text` (+ unique index) | Per-row inbound dedup (see §8.4) |
| `inbound_received_at timestamptz` | Audit/timeline |
| `cc_decision_inbound_extra_replies` table | Captures extra replies after the first one |
| Enum value `awaiting_operator_review` | Terminal-ish state for outcomes C/D and exhausted extractions |
| GUC `cc.extraction_auto_commit_confidence` | Threshold knob; default 1.01 (off) |
| `cc_get_decision_confirm_data` / `cc_confirm_decision_token` | State filter widened so clarification-button clicks work post-`replied` |

---

## 11. Runner changes

### 11.1 New code — `runner/src/runner.ts`

Add alongside `executeRewriteTask`:

```ts
export async function executeExtractionTask(
  task: ExtractionTask,
  deps: Pick<RunnerDeps, "controlPlane" | "claudeCode" | "logger">,
  options: Pick<RunnerOptions, "runnerId">,
): Promise<ExecuteResult> {
  const { controlPlane, claudeCode, logger } = deps;
  logger.info("extraction task claimed", {
    send_id: task.id, app_id: task.app_id,
    attempt_count: task.attempt_count, claim_token: task.claim_token,
  });
  try {
    const prompt = buildExtractionPrompt(task);
    const result = await claudeCode.runPrompt({ prompt });
    const parsed = parseExtractionOutput(result.stdout, task);
    const outcome = decideOutcome(parsed, task);  // strict precedence per §4.0
    const llmJson = { ...parsed, model: "claude-cli", extracted_at: new Date().toISOString(),
                      runner_id: options.runnerId, prompt_version: "slice2-v1" };

    switch (outcome.kind) {
      case "answer":
        await controlPlane.finishExtractionWithAnswer(task.id, options.runnerId, task.claim_token,
          outcome.option_id, parsed.confidence, parsed.rationale, llmJson);
        return { status: "succeeded" };
      case "clarify":
        await controlPlane.finishExtractionWithClarify(task.id, options.runnerId, task.claim_token,
          outcome.clarifying_question, parsed.confidence, llmJson);
        return { status: "succeeded" };
      case "needs_review":
        await controlPlane.finishExtractionNeedsReview(task.id, options.runnerId, task.claim_token,
          llmJson, outcome.reason);
        return { status: "succeeded" };
    }
  } catch (error) {
    const message = compactError(error);
    logger.error("extraction task failed", { send_id: task.id, error: message });
    try { await controlPlane.failExtractionTask(task.id, options.runnerId, task.claim_token, message); }
    catch (e) { logger.error("failed to mark extraction failed", { send_id: task.id, error: compactError(e) }); }
    return { status: "failed", error: message };
  }
}
```

### 11.2 Poll loop change — `RunnerDaemon.runForever`

```ts
const workOrder = await controlPlane.claimWorkOrder(...);
if (workOrder) { this.current = executeWorkOrder(...); }
else {
  const rewriteTask = await controlPlane.claimRewriteTask(...);
  if (rewriteTask) { this.current = executeRewriteTask(...); }
  else {
    const extractionTask = await controlPlane.claimExtractionTask(...);    // NEW
    if (extractionTask) { this.current = executeExtractionTask(...); }
  }
}
```

Order matters: work orders first (highest latency cost if delayed), then rewrites (operator is actively waiting on the preview), then extractions (no human waiting). Same poll interval; same lease seconds.

### 11.3 Control plane interface additions — `runner/src/controlPlane.ts`

Every finish/fail RPC requires the `claim_token` returned by claim. The TS interface threads it through.

```ts
export interface ControlPlane {
  // ... existing methods
  claimExtractionTask(runnerId: string, leaseSeconds: number): Promise<ExtractionTask | null>;
  finishExtractionWithAnswer(sendId: string, runnerId: string, claimToken: string, optionId: string, confidence: number, rationale: string, llmExtraction: unknown): Promise<unknown>;
  finishExtractionWithClarify(sendId: string, runnerId: string, claimToken: string, clarifyingQuestion: string, confidence: number, llmExtraction: unknown): Promise<ExtractionTask>;
  finishExtractionNeedsReview(sendId: string, runnerId: string, claimToken: string, llmExtraction: unknown, reason: string): Promise<ExtractionTask>;
  failExtractionTask(sendId: string, runnerId: string, claimToken: string, error: string): Promise<ExtractionTask>;
}
```

### 11.4 Env / config additions — `runner/src/config.ts`

```ts
EXTRACTION_AUTO_COMMIT_CONFIDENCE: number;  // default 1.01 (auto-commit OFF; see §0)
EXTRACTION_OFF_TOPIC_FLOOR: number;          // default 0.20
EXTRACTION_PROMPT_VERSION: string;           // 'slice2-v1'
```

The runner-side default mirrors the DB GUC default (1.01). To enable auto-commit, BOTH must be lowered: the GUC controls the server-side re-check (defense in depth), the env var controls the runner's outcome routing. A mismatch (e.g., runner thinks 0.85 but DB thinks 1.01) causes `cc_finish_extraction_with_answer` to raise; this is intentional, not a bug.

### 11.5 Test additions — `runner/test/runner.test.ts`

Required cases (mirroring existing rewrite tests):

- ✅ High-confidence claude output → calls `finishExtractionWithAnswer` with parsed option id.
- ✅ Low-confidence claude output with clarifying question + budget remaining → calls `finishExtractionWithClarify`.
- ✅ Low-confidence + budget exhausted (`clarification_attempt_count=1` on task) → calls `finishExtractionNeedsReview` with reason `budget_exhausted`.
- ✅ Off-topic claude output (`signals.off_topic=true`) → calls `finishExtractionNeedsReview` with reason `off_topic`.
- ✅ Non-JSON claude output → calls `failExtractionTask` with parseable error.
- ✅ `matched_option_id` not in `options_snapshot` → downgrade to needs_review with reason `option_hallucinated`.
- ✅ AbortError mid-call (lease lost) → throws, does NOT call any finish RPC.
- ✅ Idempotency: calling the runner twice with the same task and the second time after state moved → second call gets HTTP error from RPC (state mismatch); runner logs and exits cleanly.

---

## 12. Audit events (new event types)

| Event type | When emitted | Detail keys |
|---|---|---|
| `decision_extraction_started` | First successful `cc_claim_extraction_task` for a send | `send_id, issue_id, runner_id, attempt_count` |
| `decision_extracted_and_answered` | Outcome A commit | `send_id, issue_id, decision_answer_id, work_order_id, option_id, confidence` |
| `decision_extraction_proposed_clarify` | Outcome B | `send_id, issue_id, confidence` (clarifying_question stored in `llm_extraction`, not duplicated in audit) |
| `decision_extraction_needs_review` | Outcomes C, D | `send_id, issue_id, reason, matched_option_id, confidence` |
| `decision_extraction_exhausted` | Sweeper retires a row after `attempt_count >= max_attempts` | `send_id, issue_id, attempt_count, last_error` |
| `decision_clarification_sent` | `cc-auto-clarify` cron sends a clarify email | `send_id, issue_id, gmail_message_id, recipient_email` |

All audit writes use the existing `cc_audit_events` table; no schema change needed.

---

## 13. Pre-build checklist

- [ ] Operator confirms the §0 posture (auto-commit OFF by default; enabling it is a separate master-plan amendment).
- [ ] Confirm `EXTRACTION_AUTO_COMMIT_CONFIDENCE=1.01` (default) at runner AND DB; revisit only after 2 weeks of confirm-queue-only data.
- [ ] Confirm migration 026 enum split is acceptable (two transactions instead of one).
- [ ] Confirm `cc_get_decision_confirm_data` + `cc_confirm_decision_token` state-list widening doesn't break any cockpit logic relying on the old narrow list.
- [ ] Confirm clarification email template tone (operator may want different wording).
- [ ] Confirm the `cc-auto-clarify` cron cadence (default: every 5 min; could be tighter for v1.0 smoke).
- [ ] Decide where the operator confirm queue UI lands: `/decisions` band (existing plan) vs. new sub-page. The brief assumes the existing band.
- [ ] Confirm migration 026 strategy for `ALTER TYPE … ADD VALUE` (single transaction vs. split).
- [ ] Verify Mac Studio Claude CLI version still meets prompt expectations (no regression since Slice 1 shipped).
- [ ] Build cockpit UI cards for `awaiting_operator_review` state (Slice 1 doesn't surface this state yet).

---

## 14. Out of scope (Slice 3+)

- Second clarification attempt (DB constraint enforces hard cap of 1).
- Auto-tightening of the confidence threshold based on revert rate (described in §6 as future work).
- ML-trained extraction model swap (Phase 6+).
- Confirm-queue keyboard shortcuts / bulk-confirm.
- Reminder emails (locked separately in Slice 3).
- Operator-edit of the rewrite from inside the confirm queue (Slice 3+).
- Multi-recipient extraction merge logic (one reply per send_id today; cross-recipient consensus is Phase 6).
- Surfacing extra-reply ledger rows in the cockpit UI (the data is captured by migration 026; presenting it is a future slice).
- Auto-commit on free-text replies (see §0 — requires master-plan amendment before this is even a config toggle).

---

**End of Slice 2 extraction design.**
