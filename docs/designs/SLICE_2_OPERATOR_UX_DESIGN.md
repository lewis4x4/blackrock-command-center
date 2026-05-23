# Slice 2 — Operator Review UX Design

**Compiled:** 2026-05-22 · **Author:** Cockpit design pass
**Status:** Draft / ready for operator greenlight
**Scope:** Cockpit UX for the Slice 2 inbound-reply review flow. Defines where pending extractions surface, what the operator sees, what actions they can take, the state machine they trigger, and the edge functions + TS types that back it.

> Out of scope: Mac Studio extraction prompt details (covered in Phase 5 §6.6), Gmail inbound mechanics (Phase 5 §6.5), schema migrations (covered separately in 025b).

---

## 1. Where pending review surfaces

**Decision: option (a) — new band at the top of `/decisions`, titled "Awaiting your review."**

| Considered | Verdict | Rationale |
|---|---|---|
| (a) New band on `/decisions` page | **Pick** | Decisions live here today; operator already opens this page to clear queue; one IA, one mental model. Phase 5 UX Recon §3 and Phase 5 master plan §9.2 both pre-commit to this. |
| (b) Inline indicator on existing rows | Used **as a complement**, not the primary surface | A `Needs review` badge on the existing decision card is a great wayfinding cue, but it buries the action inside a card whose primary CTA is "Route to recipients". Two contradictory CTAs in one card is confusing. |
| (c) Dedicated `/reviews` nav page | Reject | Fragments the IA. The cockpit nav is already at the right density (Home / Apps / Decisions / Agents / Files / Settings). A fifth nav item just for Phase 5 inbound is overkill at one expected card/day. |

**Placement order on `/decisions`:**

```
1. DecisionsHeader (unchanged)
2. ▼ Awaiting your review (NEW BAND — Phase 5 Slice 2)
3. FilterBand (unchanged)
4. Open decisions (existing band, rows tagged with the same Needs review badge for cross-reference)
5. Wiring notes (unchanged)
6. Recently answered (unchanged)
```

The new band sits *above* the filter bar because pending reviews are operator action items, not filterable inventory. They demand the operator's eye before they scroll into the filterable open-decisions list. The band auto-hides when empty so it doesn't add visual chrome on quiet days.

**Band header structure** (matches the `band` + `band-head` pattern from `Decisions.tsx:172-186`):

```
┌─ band-head ──────────────────────────────────────────────┐
│ [⚠ icon]  Awaiting your review                       (n) │
│           Claude proposed an answer — confirm or reject. │
└──────────────────────────────────────────────────────────┘
```

- `band-num` slot is replaced by a small amber alert glyph (not a numeric step number — these aren't sequential).
- `band-title` copy: **"Awaiting your review"**.
- `band-sub` copy: **"Claude proposed an answer — confirm, pick a different option, or send a clarification."**
- `count-chip` shows the pending count; tone is `amber` if any, hidden if zero.
- The whole band fades out when `pending_reviews.length === 0`.

---

## 2. What the operator sees — the review surface

### 2.1 Band card (compact)

One card per pending review, rendered in a vertical stack inside the band body. Click anywhere on the card → opens the **Review extraction** slide-over.

```
┌─ pending-review-card ──────────────────────────────────────┐
│ [QEP] · Rebate stacking rules               Needs review ▸ │
│ Reply from Rylee · 14 min ago                              │
│ "Let's go with the biggest one — no double dipping."       │
│ Suggested → Customer picks one rebate   ·  conf 0.91       │
│                                            [ Review ▸ ]    │
└────────────────────────────────────────────────────────────┘
```

**Compact card spec**

| Slot | Content |
|---|---|
| Top row | App badge + decision title (left), `Needs review` chip (right, amber) |
| Subhead | `Reply from {recipient_name} · {ago(replied_at)}` |
| Quote slot | One-line ellipsised excerpt of `raw_reply_text` (40-char clamp), in `font-style: italic; color: var(--text-muted)` |
| Suggestion slot | `Suggested → {matched_option.label} · conf {confidence.toFixed(2)}` |
| Action | Ghost-style **Review ▸** button on the right (the whole card is also click-to-open) |

The compact card never shows the full reply text in the band — only inside the slide-over — because we don't want quarantined customer text scrolling past the operator's eye during routine cockpit browsing.

### 2.2 Slide-over: **Review extraction**

When the operator clicks a card, a `SlideOver` opens — the same `SlideOver.tsx` component used by `DecisionDrawer`. Title `Review extraction`, subtitle `{app_short_code} · reply from {recipient_name}`.

**Slide-over layout (top → bottom):**

```
┌─ SlideOver header ─────────────────────────────────────────┐
│ Review extraction                                          │
│ QEP · reply from Rylee                                  ×  │
├────────────────────────────────────────────────────────────┤
│                                                            │
│ ┌─ ORIGINAL QUESTION (panel-label) ──────────────────────┐ │
│ │ Q10: Rebate stacking rules                             │ │
│ │ When a customer's quote qualifies for BOTH a cash      │ │
│ │ rebate AND a finance rebate, which way should we go?   │ │
│ │                                                        │ │
│ │ Options:                                               │ │
│ │   1. Let customers stack both rebates                  │ │
│ │   2. Customer picks one rebate         ← Claude pick   │ │
│ │   3. System auto-picks the best                        │ │
│ │                                                        │ │
│ │ Sent to Rylee 2h ago · Magic-link expires in 6d        │ │
│ └────────────────────────────────────────────────────────┘ │
│                                                            │
│ ┌─ CUSTOMER REPLY (panel-label) ─────────────────────────┐ │
│ │ Rylee <rylee@qep.com> · 14 min ago                     │ │
│ │ ┌────────────────────────────────────────────────────┐ │ │
│ │ │ Let's just go with the biggest one. I don't want   │ │ │
│ │ │ them double-dipping.                               │ │ │
│ │ └────────────────────────────────────────────────────┘ │ │
│ │ (inset quote block, full plain-text body)              │ │
│ └────────────────────────────────────────────────────────┘ │
│                                                            │
│ ┌─ CLAUDE'S PARSE (panel-label) ─────────────────────────┐ │
│ │ Suggested option ▸  Customer picks one rebate          │ │
│ │ Confidence            ████████░░  0.91 (high)          │ │
│ │ Reasoning             "biggest one" + "no double-      │ │
│ │                       dipping" → option 2.             │ │
│ │ Requires human review false                            │ │
│ └────────────────────────────────────────────────────────┘ │
│                                                            │
│ ┌─ DECIDE (panel-label) ─────────────────────────────────┐ │
│ │ ◉ Accept Claude's suggestion                           │ │
│ │ ○ Pick a different option                              │ │
│ │     [Customer picks one rebate ▾]                      │ │
│ │ ○ Reject as off-topic                                  │ │
│ │     [Why? e.g. "Rylee replied about a different Q"  ]  │ │
│ │                                                        │ │
│ │ Rationale (optional, one line)                         │ │
│ │ [Why this answer?                                    ] │ │
│ │                                                        │ │
│ │ Risk class: authorize. Confirming will commit and      │ │
│ │ queue a work order (gated for your approval on Home).  │ │
│ └────────────────────────────────────────────────────────┘ │
│                                                            │
│ ┌─ NEED MORE INFO? (collapsed, panel-label) ─────────────┐ │
│ │ ▸ Send a clarification email instead                   │ │
│ └────────────────────────────────────────────────────────┘ │
│                                                            │
├────────────────────────────────────────────────────────────┤
│   [ Close ]                          [ Confirm answer ]    │
└────────────────────────────────────────────────────────────┘
```

**Sectioning rules** (so the slide-over feels native to the existing cockpit):

- Every section is wrapped in a `panel-section` with a `panel-label` uppercase eyebrow (existing class from TriagePanels / DecisionRouteModal).
- The customer reply block uses a new class `review-quote` styled as: `padding: 12px 14px; border-left: 2px solid rgba(255,255,255,.18); background: rgba(255,255,255,.03); border-radius: 8px;`. Inset, muted, signals "this is data not chrome."
- The Claude parse block uses a key-value grid: left column 140px panel-key style, right column flexible. The confidence bar is a 10-segment ASCII-style bar in HTML (`<div class="conf-bar"><span style="width:91%"/></div>`).
- The Decide block is a single radio group plus a free-text rationale field. The reject reason input only un-greys when the **Reject as off-topic** radio is selected.
- The clarification CTA is a disclosure (`<details>` element) — collapsed by default so it doesn't compete with the primary commit path. Expanding it reveals the clarification compose surface described in §5.

**Footer (`SlideOver` footer slot):**

| Button | Class | Behavior |
|---|---|---|
| **Close** | `ghost-btn` | Dismisses without writing. If `flow.completed` is true, switches to "Done". |
| **Confirm answer** | `btn-primary panel-primary` | Primary commit. Disabled until a decide-radio is chosen AND (if reject) a reason is typed. Disabled while `busy`. Label switches to "Recording…" while in-flight. |

When the operator expands the clarification disclosure, the footer's primary button text and intent change to **Send clarification** (and the radio group above is greyed out, since this is a different commit path). This is the same toggle pattern as `DecisionRouteModal`'s rewrite-state machine.

---

## 3. What the operator can do — actions

Four operator actions, in priority order:

### 3a. Accept Claude's suggestion (primary path)

- Radio: **Accept Claude's suggestion** (selected by default if `confidence ≥ 0.85 AND requires_human === false`).
- The `selected_option_id` is `llm_extraction.matched_option_id`.
- Commit click → `cc-operator-confirm-extraction`.

### 3b. Pick a different existing option

- Radio: **Pick a different option** with an inline `<select>` of all `options_snapshot` rows.
- Default selection in the select is the first non-suggested option.
- Commit click → same `cc-operator-confirm-extraction` with the chosen `option_id`.

### 3c. Reject as off-topic

- Radio: **Reject as off-topic** with a free-text `reason` input (required when this radio is active, `maxLength=500`).
- Commit click → `cc-operator-reject-extraction` with `{send_id, reason}`.
- Does NOT commit an answer; the recipient effectively "didn't answer." Operator can then re-route from the underlying decision row (which returns to `unrouted` state).

### 3d. Send a manual clarification email (escape hatch)

- Disclosure `<details>` element labelled **▸ Send a clarification email instead**.
- Expanding it reveals a compose surface (see §5).
- This action exists for the rare case where:
  - The reply is on-topic but ambiguous AND Claude's auto-clarify cap is exhausted (`clarification_attempt_count === 1`), OR
  - The operator wants to write something specific to the recipient rather than firing the auto-clarify template, OR
  - The Mac Studio's extraction failed (`llm_extraction === null` or `last_error` present).
- Hidden / disabled when `clarification_attempt_count >= 1` AND the operator hasn't typed an override — per the locked decision in Phase 5 §9 the system never sends more than one auto-clarify, but an *operator-initiated* clarification is a separate channel and can be sent regardless. (The DB CHECK constraint applies to *auto* clarifications; an operator clarification is logged with `clarification_origin='operator'` and not counted toward the cap. This is handled server-side in `cc-operator-clarify-extraction`.)
- Commit click → `cc-operator-clarify-extraction`.

**Action availability matrix:**

| LLM state | 3a Accept | 3b Pick different | 3c Reject | 3d Clarify |
|---|---|---|---|---|
| Confident + has matched option | ✓ (default) | ✓ | ✓ | ✓ |
| Low-confidence / ambiguous | ✓ (warned) | ✓ (default) | ✓ | ✓ |
| `requires_human: true` | ✗ (greyed) | ✓ (default) | ✓ | ✓ |
| Extraction failed (`llm_extraction = null`) | ✗ | ✓ (default) | ✓ | ✓ |
| Already auto-clarified once | ✓ | ✓ | ✓ | ✓ (operator origin) |

A subtle yellow banner appears at the top of the slide-over when `requires_human === true` OR `confidence < 0.70`, reading: **"Claude flagged this for human review."** This is informational, not blocking — the operator still chooses.

---

## 4. State machine on operator action

Every commit path reuses Slice 1 plumbing where possible (`cc_resolve_issue` + `cc_enqueue_with_gating`). No new commit pathway is introduced — Phase 5 §4 non-negotiable #1 says "no new commit pathway."

### 4a. On **Accept** / **Pick different** (action 3a or 3b)

```
cc_decision_email_sends.state: extracting → answered → done
  • operator_confirmed_by   = <actor email>
  • operator_confirmed_at   = now()
  • selected_option         = <option_id>
  • answered_at             = now()
  • decision_answer_id      = <id from cc_resolve_issue>

cc_decision_answers: NEW ROW inserted (via cc_resolve_issue)
  • issue_id, answer_value=<option_id>, answer_options_snapshot=<snapshot>,
    rationale=<operator typed>, risk_class=<unchanged from send>,
    answered_by=<actor>, decision_external_ref=<unchanged>

cc_issues.status: routed_to_client → answered (via cc_resolve_issue)

agent_work_orders: enqueued via cc_enqueue_with_gating
  • Risk class re-derived server-side (per non-negotiable #3).
  • status='queued' if auto-class under cap, else 'gated' awaiting Brian's tap on Home.

cc_audit_events:
  • decision_operator_confirmed { send_id, option_id, source: 'extraction' }
  • decision_answered          { issue_id, answer_value }
  • work_order_created / work_order_gated
```

Mirrors the Slice 1 magic-link confirm path exactly. The only difference is the audit `source: 'extraction'` (vs `source: 'magic_link'`) for downstream attribution.

### 4b. On **Reject as off-topic** (action 3c)

```
cc_decision_email_sends.state: extracting → rejected_by_operator
  • operator_confirmed_by   = <actor email>
  • operator_confirmed_at   = now()
  • last_error              = <reason, capped 500 chars>

cc_issues.status: unchanged (stays routed_to_client). The decision is NOT
  answered, just this *reply* was discarded. Operator can re-route the
  decision row from the existing card with a fresh email.

cc_audit_events:
  • decision_extraction_rejected { send_id, reason, recipient_email }
```

A **new enum value** is added to `cc_decision_email_state`: `'rejected_by_operator'`. This is distinct from `expired` (time-based) and `failed` (Gmail send error). It explicitly means "operator looked at the reply and discarded it."

### 4c. On **Send clarification** (action 3d, operator-origin)

```
cc_decision_email_sends.state: extracting → clarify_sent
  • clarification_origin       = 'operator'   (new column, default 'auto')
  • clarification_sent_at      = now()
  • clarification_attempt_count: unchanged for operator-origin
                                 (only auto-clarify increments it)

cc_decision_email_sends: NO new row. The clarification is sent in the same
  Gmail thread, using the same magic-link tokens (or fresh tokens if the
  operator pressed "regenerate options"). When the recipient replies again,
  cc-gmail-inbound re-uses thread matching and the same send_id transitions
  back to state='replied' → state='extracting' for a second pass.

cc_audit_events:
  • decision_clarification_sent { send_id, origin: 'operator',
                                  subject, recipient_email }
```

**Important constraint:** The Phase 5 `clarification_attempt_count <= 1` DB CHECK applies only to *auto*-clarifications. To support operator-origin clarifications, migration 025b must:

1. Add `clarification_origin text DEFAULT 'auto' CHECK (clarification_origin IN ('auto','operator'))`.
2. Relax the check constraint to `CHECK (clarification_origin = 'operator' OR clarification_attempt_count <= 1)`.

This preserves the locked Phase 5 §9 invariant (no auto-spam) while letting the operator drive multi-turn dialogue when needed.

---

## 5. Clarification email content (action 3d, expanded)

When the operator expands **▸ Send a clarification email instead**, the disclosure reveals this compose surface:

```
┌─ Clarification email (panel-label) ────────────────────────┐
│ To       Rylee <rylee@qep.com>            (read-only)      │
│ Subject  [ Re: Rebate stacking rules                     ] │
│ Body                                                       │
│  ┌───────────────────────────────────────────────────────┐ │
│  │ Hey Rylee,                                            │ │
│  │                                                       │ │
│  │ Thanks for the reply — just want to make sure I       │ │
│  │ picked the right one. Did you mean:                   │ │
│  │                                                       │ │
│  │   • Let customers stack both rebates                  │ │
│  │   • Customer picks one rebate                         │ │
│  │   • System auto-picks the best                        │ │
│  │                                                       │ │
│  │ Just click whichever fits — or reply to this with     │ │
│  │ the number.                                           │ │
│  │                                                       │ │
│  │ Thanks,                                               │ │
│  │ Brian                                                 │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                            │
│ ☑ Include the three option buttons (recommended)           │
│ ☐ Regenerate magic-link tokens (only if originals leaked)  │
│                                                            │
│ Sending will mark this send as clarify_sent. The recipient │
│ stays in the same Gmail thread.                            │
└────────────────────────────────────────────────────────────┘
```

**Auto-fill rules:**

1. **Subject** auto-fills to `Re: {original_subject}` so the recipient's mail client threads it naturally.
2. **Body** auto-fills with a template hydrated from the LLM's `suggested_clarification` field (if present). If `llm_extraction.suggested_clarification` is null, the body auto-fills with a generic "did you mean one of these options" template enumerating `options_snapshot`. The operator can edit freely.
3. **Recipient** is read-only — it's whoever sent the original reply (`recipient_email` on the send row).
4. **Options checkbox** is on by default. Always re-uses the same three magic-link buttons from Slice 1 (so the recipient can one-click answer this time). The HTML render reuses the Slice 1 `decision-email-template.ts` shared helper — the Slice 1 button rendering is the proven path, don't fork.
5. **Token regeneration** is opt-in. Default off because the original tokens are still valid (7-day TTL from the original send). Operator only flips this on if there's a reason to invalidate the old links (rare; e.g., they suspect the original email was forwarded outside the org).

**Validation rules** before send:
- Subject non-empty, ≤ 200 chars.
- Body non-empty, ≤ 4000 chars.
- If `Include option buttons` is on, the options-snapshot must still be valid (it is — read-only from the send row).

**Why this is NOT the auto-clarify template (Slice 3):**

Slice 3's `cc-auto-clarify` cron sends a fixed template with no operator input. This is a separate human-driven action. The operator can phrase the question however they want. They might know context the auto-clarify wouldn't — e.g., "Hey Rylee, I think you might have replied to the wrong question. Did you mean…"

---

## 6. Visibility from the existing Decisions row (cross-reference badge)

The existing `DecisionCard` (Decisions.tsx:191-214) already reads a state badge via the `decisionEmailState()` helper (Decisions.tsx:294-302). That helper already maps `replied` and `extracting` → `awaiting_operator_confirm`. **No new badge logic is needed for the existing row** — the existing badge fires correctly for any send that's in extraction limbo.

**Visual spec for the existing badge** (already implemented; documenting here for the design contract):

```
.decision-state-badge.awaiting_operator_confirm {
  color: #F2B647;                    /* amber */
  background: rgba(242, 182, 71, .12);
  border: 1px solid rgba(242, 182, 71, .3);
  border-radius: 999px;
  padding: 3px 9px;
  font-size: 11px;
  letter-spacing: .04em;
  text-transform: uppercase;
}
```

Text reads `awaiting operator confirm` (the underscore-replace in line 213 of Decisions.tsx renders it with spaces). For Slice 2 we can rename the rendered string to **`needs review`** via a small mapping table in `Decisions.tsx` for cleaner copy:

```ts
const STATE_BADGE_COPY: Partial<Record<string, string>> = {
  awaiting_operator_confirm: 'needs review',
  link_clicked: 'viewed',
  // ...
};
```

This is a one-line copy nudge — same badge, friendlier word.

**Click behavior on the row badge:** Clicking the badge (or anywhere on the card) opens the existing `DecisionDrawer`. For Slice 2 we additionally make the `Needs review` badge clickable as a shortcut that scrolls the page to the "Awaiting your review" band and visually highlights the matching pending-review card for ~1s (CSS `@keyframes flash-attention`). That way the existing decision rows act as deep-links into the new band without duplicating UI.

---

## 7. Edge functions

All three new functions require operator auth (Cloudflare Access JWT, same as `cc-route-decision` and `cc-rewrite-decision`). The dev-time alternative is `x-cc-read-token` header (already wired in `lib.ts` `readHeaders()`), used by the cockpit when Access isn't in front. Each function audits before returning.

### 7.1 `cc-operator-confirm-extraction` — accept / pick-different commit

```
POST /functions/v1/cc-operator-confirm-extraction
Auth: Cloudflare Access JWT (operator) OR x-cc-read-token
Headers: x-cc-read-token: <token>
Body:
  {
    "send_id":   "uuid",
    "option_id": "string",        // either the LLM-suggested id or operator-overridden
    "rationale": "string | null"  // optional, max 500 chars
  }
Response:
  {
    "send":       <DecisionEmailSend>,
    "answer":     { "decision_answer_id": "uuid", "issue_id": "uuid" },
    "work_order": <AgentWorkOrder>,    // queued or gated
    "dispatched": true | false
  }
```

**Server flow** (all in one transaction where possible):
1. Verify auth.
2. Load send row by `send_id`; assert `state IN ('extracting','replied','awaiting_clarify','clarify_sent')`.
3. Validate `option_id` against `options_snapshot`. Reject 400 if not in set (per Phase 5 §4 non-negotiable #1: never accept a hallucinated option).
4. Call `cc_resolve_issue(issue_id, action='answer_decision', answer_value=option_id, …)` — same path as Slice 1 magic-link confirm.
5. Call `cc_enqueue_with_gating(decision_answer_id)`; capture `dispatched` flag.
6. Update send row: `state='answered'`, `operator_confirmed_by`, `operator_confirmed_at`, `selected_option=option_id`, `answered_at=now()`, `decision_answer_id=<from #4>`.
7. Insert audit events (see §4a).
8. Return response above.

### 7.2 `cc-operator-reject-extraction` — discard off-topic reply

```
POST /functions/v1/cc-operator-reject-extraction
Auth: Cloudflare Access JWT (operator) OR x-cc-read-token
Body:
  {
    "send_id": "uuid",
    "reason":  "string"   // required, 1-500 chars
  }
Response:
  {
    "send": <DecisionEmailSend>    // with state='rejected_by_operator'
  }
```

**Server flow:**
1. Verify auth.
2. Load send row; assert `state IN ('extracting','replied','awaiting_clarify','clarify_sent')`.
3. Validate `reason.trim().length >= 1 && reason.length <= 500`.
4. Update send row: `state='rejected_by_operator'`, `operator_confirmed_by`, `operator_confirmed_at`, `last_error=reason`.
5. Audit `decision_extraction_rejected { send_id, reason, recipient_email }`.
6. Return response.

Note: the underlying `cc_issues.status` stays `routed_to_client`. The operator can re-route the decision (which clears the badge and creates a new send row) using the existing `cc-rewrite-decision` → `cc-route-decision` path.

### 7.3 `cc-operator-clarify-extraction` — operator-typed follow-up email

```
POST /functions/v1/cc-operator-clarify-extraction
Auth: Cloudflare Access JWT (operator) OR x-cc-read-token
Body:
  {
    "send_id":           "uuid",
    "subject":           "string",      // 1-200 chars
    "body":              "string",      // 1-4000 chars
    "include_buttons":   true | false,  // default true
    "regenerate_tokens": true | false   // default false
  }
Response:
  {
    "send": <DecisionEmailSend>   // with state='clarify_sent'
  }
```

**Server flow:**
1. Verify auth.
2. Load send row; assert `state IN ('extracting','replied','awaiting_clarify','clarify_sent')`.
3. Validate subject + body lengths.
4. If `regenerate_tokens` is true: generate new magic-link tokens (HMAC-hashed at rest), bump `magic_link_expires_at` to `now() + interval '7 days'`.
5. Compose Gmail RFC-822 message:
   - From: `Brian Lewis <brian.lewis@blackrockai.co>`
   - To: `<recipient_name> <recipient_email>` (from send row, read-only — operator cannot redirect).
   - Subject: as provided.
   - In-Reply-To: original `gmail_message_id` (threads naturally).
   - References: includes original message id.
   - X-CC-Send-Id: `<send_id>` (for inbound matching).
   - Body: HTML + plain-text. If `include_buttons` is true, append the three option buttons using the shared `decision-email-template.ts` helper from Slice 1.
6. POST to `gmail.users.messages.send` via the OAuth refresh token.
7. Update send row: `state='clarify_sent'`, `clarification_origin='operator'`, `clarification_sent_at=now()`. Do NOT increment `clarification_attempt_count` (per §4c).
8. Audit `decision_clarification_sent { send_id, origin: 'operator', subject, recipient_email }`.
9. Return response.

### 7.4 Read endpoint extension (NOT a new function)

`cc-read-decisions` (existing) gets a new field in its response payload:

```jsonc
{
  "apps_reached":    [...],
  "apps_unreachable":[...],
  "apps_unwired":    [...],
  "decisions":       [...],
  "answered_recent": [...],
  "pending_reviews": [               // NEW
    {
      "send_id": "uuid",
      "app_id": "uuid",
      "app_short_code": "QEP",
      "app_display_name": "QEP",
      "issue_id": "uuid",
      "decision_external_ref": "Q10",
      "raw_decision_title": "Rebate stacking rules",
      "raw_decision_body": "...",
      "options_snapshot": [{ "id": "...", "label": "..." }, ...],
      "recipient_id": "uuid",
      "recipient_name": "Rylee",
      "recipient_email": "rylee@qep.com",
      "replied_at": "2026-05-22T19:15:00Z",
      "raw_reply_text": "Let's just go with the biggest one...",
      "llm_extraction": {
        "matched_option_id": "...",
        "confidence": 0.91,
        "reasoning": "...",
        "requires_human": false,
        "suggested_clarification": null
      },
      "clarification_attempt_count": 0,
      "clarification_origin": null,
      "state": "extracting"
    },
    ...
  ],
  "generated_at": "..."
}
```

**Why extend, not add a new function:** `cc-read-decisions` is already polled on every `/decisions` open + refresh. Reusing it adds the pending list to the same RTT and avoids a fourth fetch on page load.

**Privacy/security note:** `raw_reply_text` is the only quarantined customer text the cockpit ever shows. It is read by the existing `service_role` SELECT in `cc-read-decisions` (operator-only) and never persisted in localStorage / sessionStorage. The cockpit's React state for the slide-over is the only client-side scope; closing the slide-over drops the reference and the next refresh re-fetches.

---

## 8. TypeScript type additions (`web/src/lib.ts`)

All additions are additive — no existing type changes. Stable diff for review.

```ts
// ---------------------------------------------------------------------------
// SLICE 2: Operator review of inbound reply extractions
// ---------------------------------------------------------------------------

// Extend the state enum with the new rejected state.
export type DecisionEmailState =
  | 'queued' | 'rewriting' | 'rewrite_ready'
  | 'sent' | 'delivered' | 'opened' | 'clicked'
  | 'replied' | 'extracting'
  | 'awaiting_clarify' | 'clarify_sent'
  | 'answered' | 'done'
  | 'reminded' | 'bounced' | 'expired'
  | 'failed'
  | 'rejected_by_operator';   // NEW

// Claude's parse output (shape stored in cc_decision_email_sends.llm_extraction).
export interface DecisionExtractionLLM {
  matched_option_id: string | null;
  confidence: number;                       // 0..1
  reasoning: string | null;
  requires_human: boolean;
  suggested_clarification: string | null;   // null when claude didn't suggest one
}

// One pending-review item shown in the new `/decisions` band.
export interface PendingReviewSend extends Record<string, unknown> {
  send_id: string;
  app_id: string;
  app_short_code: string;
  app_display_name: string;
  issue_id: string;
  decision_external_ref: string;
  raw_decision_title: string;
  raw_decision_body: string | null;
  options_snapshot: DecisionOptionLike[];
  recipient_id: string | null;
  recipient_name: string | null;
  recipient_email: string;
  replied_at: string;                       // ISO timestamp
  raw_reply_text: string;                   // quarantined; in-memory only
  llm_extraction: DecisionExtractionLLM | null;
  clarification_attempt_count: number;
  clarification_origin: 'auto' | 'operator' | null;
  state: DecisionEmailState;
}

// Extend the existing DecisionsPayload with the new band's data.
export interface DecisionsPayload {
  apps_reached: DecisionsAppStatus[];
  apps_unreachable: DecisionsAppStatus[];
  apps_unwired: DecisionsAppStatus[];
  decisions: DecisionRow[];
  answered_recent: AnsweredDecisionSummary[];
  pending_reviews?: PendingReviewSend[];    // NEW — optional for fwd-compat
  generated_at?: string;
}

// Extend DecisionEmailSend with the operator-confirm + clarification fields.
export interface DecisionEmailSend extends Record<string, unknown> {
  id: string;
  state: DecisionEmailState;
  app_id: string;
  issue_id: string;
  decision_external_ref: string;
  raw_decision_title: string;
  raw_decision_body: string | null;
  rewritten_subject: string | null;
  rewritten_body: string | null;
  options_snapshot: unknown;
  last_error: string | null;
  // ↓ NEW in Slice 2
  recipient_id?: string | null;
  recipient_name?: string | null;
  recipient_email?: string | null;
  replied_at?: string | null;
  raw_reply_text?: string | null;
  llm_extraction?: DecisionExtractionLLM | null;
  operator_confirmed_by?: string | null;
  operator_confirmed_at?: string | null;
  selected_option?: string | null;
  clarification_attempt_count?: number;
  clarification_origin?: 'auto' | 'operator' | null;
  clarification_sent_at?: string | null;
}

// ---------------------------------------------------------------------------
// Request bodies for the three new edge functions
// ---------------------------------------------------------------------------

export interface OperatorConfirmExtractionPayload {
  send_id: string;
  option_id: string;
  rationale?: string | null;
}

export interface OperatorRejectExtractionPayload {
  send_id: string;
  reason: string;
}

export interface OperatorClarifyExtractionPayload {
  send_id: string;
  subject: string;
  body: string;
  include_buttons?: boolean;     // default true on server
  regenerate_tokens?: boolean;   // default false on server
}

export interface OperatorConfirmExtractionResponse {
  send: DecisionEmailSend;
  answer: { decision_answer_id: string; issue_id: string };
  work_order: AgentWorkOrder;
  dispatched: boolean;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

export async function confirmExtraction(
  payload: OperatorConfirmExtractionPayload,
  demo = false,
): Promise<OperatorConfirmExtractionResponse> { /* postJson('cc-operator-confirm-extraction', payload) */ }

export async function rejectExtraction(
  payload: OperatorRejectExtractionPayload,
  demo = false,
): Promise<{ send: DecisionEmailSend }> { /* postJson('cc-operator-reject-extraction', payload) */ }

export async function clarifyExtraction(
  payload: OperatorClarifyExtractionPayload,
  demo = false,
): Promise<{ send: DecisionEmailSend }> { /* postJson('cc-operator-clarify-extraction', payload) */ }
```

**Parser additions to `lib.ts` (private):**

- `parseDecisionExtractionLLM(value: unknown): DecisionExtractionLLM | null` — guards numeric `confidence` range and boolean `requires_human`.
- `parsePendingReviewSend(value: unknown): PendingReviewSend` — validates all required fields, normalizes `options_snapshot` via existing `optionFromUnknown`.
- Extend `parseDecisionsPayload` to read the optional `pending_reviews` array (returns `[]` when absent for backward-compat during the rollout window).

**Demo data:**

Add a `DEMO_PENDING_REVIEWS: PendingReviewSend[]` constant (similar to existing `DEMO_*` constants) so the cockpit can be developed against `?demo=1` without a live Gmail thread. Include 2 demo items:
1. High-confidence Rylee reply ("biggest one") — exercises the accept path.
2. Ambiguous Ryan McKenzie reply ("not sure which") with `requires_human: true` — exercises the clarify path.

---

## 9. Implementation checklist (cockpit side)

Tracking what to build in `web/src/`:

- [ ] `web/src/lib.ts`: add the types and API functions per §8. Extend `parseDecisionsPayload`. Add demo data.
- [ ] `web/src/Decisions.tsx`: add `PendingReviewBand` component above `FilterBand`. Wire to `payload.pending_reviews`. Add `STATE_BADGE_COPY` mapping so `awaiting_operator_confirm` renders as `needs review`.
- [ ] `web/src/ExtractionReviewModal.tsx` (NEW): the slide-over modal per §2.2. Uses existing `SlideOver` component. Three sections + the disclosure-style clarification section. Three callbacks: `onConfirm`, `onReject`, `onClarify`.
- [ ] `web/src/ExtractionReviewModal.tsx`: also handle deep-link from existing decision row badge click (per §6 — scroll + flash highlight the matching pending-review card).
- [ ] Reuse the shared HTML email template helper from Slice 1 for the clarification preview (defer to server-side render, but show a "this is what the email will look like" excerpt if useful).
- [ ] Add CSS in `index.css` for `.pending-review-card`, `.review-quote`, `.conf-bar`, `.flash-attention`. Match existing palette (`#0A0C12` bg, `rgba(255,255,255,.12)` borders, `#7C6FF0` primary, amber accents for "needs review").

## 10. Open questions for the operator

1. **Should the band auto-poll?** The cockpit currently refreshes `/decisions` on user click / manual refresh. Pending reviews are time-sensitive (the customer is waiting). Recommend a 60s background poll on `/decisions` *only when the band is non-empty* — so noise stays low when there's nothing to do.
2. **Should "Reject as off-topic" trigger a polite auto-reply to the customer?** Today the design leaves the customer's reply un-acknowledged from their side (they see no email back). The operator can manually clarify via 3d if they want to. The recommendation is **no auto-acknowledgement** — over-emailing risks confusion. If the operator wants to follow up, they have action 3d.
3. **Should we add a "Defer 24h" button?** Phase 5 UX Recon §3 suggested a defer/snooze action. Trade-off: it adds friction and a 5th button. Current recommendation: skip defer for Slice 2 v1 — if the operator isn't ready to decide, they just close the slide-over and come back. Add defer in Slice 3 if it's a real pain point.

---

**End of Slice 2 operator review UX design.** Ready for operator greenlight + implementation.
