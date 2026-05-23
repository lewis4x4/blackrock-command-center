# Slice 3 — Operator Cockpit Polish UX Design

**Compiled:** 2026-05-22 · **Author:** Cockpit design pass
**Status:** Draft / ready for operator greenlight
**Scope:** Cockpit UX for the four Slice 3 cockpit changes. Slice 1 (route + magic-link), Slice 2 (operator extraction review), and Slice 2.5 (auto-route per app) have shipped. Slice 3 is polish — small frontend deltas, no new nav, no new top-level surfaces, reusing the existing `SlideOver` + `band` + `panel-section` vocabulary.

> **Hard rule (carried throughout):** total frontend work in Slice 3 must stay ≤ ~2 hours. Reuse existing components/styles. No new icons that aren't already in the bundle. If a feature would require >2 hours of frontend, simplify or defer.

---

## 0. The four changes at a glance

| # | Change | Estimated frontend cost | Status |
|---|---|---|---|
| 1 | Per-decision **Pause auto-route** toggle | ~45 min | Ship |
| 2 | **Reminder email** customer-facing copy + Lately mapping | ~5 min cockpit / rest is server | Ship |
| 3 | **Richer operator clarification compose** modal | ~35 min | Ship |
| 4 | **Snooze decision** (P1) | ~30 min if fixed-duration only | Ship trimmed (no custom picker) |

Aesthetic constraints applied to all four (carried from the locked constitution):
- Dark mode `#0A0C12`
- Panel border `rgba(255,255,255,.12)`
- Primary action `#7C6FF0`
- `panel-label` uppercase tracked eyebrow on every grouped section
- `SlideOver` slide-over pattern, **not** modal dialogs (the existing `DecisionRouteModal` is the lone modal-dialog and is left untouched)
- Bands auto-hide when empty

---

## 1. Per-decision "Pause auto-route" toggle

### 1.1 Why we need this

Slice 2.5 added a per-**app** auto-route toggle (`registry_apps.auto_route_decisions`). That's correct as a default but too coarse for the operator's real intuition: *"QEP is autorouting fine, but **this one** Q I want to eyeball first."* Today the only way to stop a single auto-route is to flip the entire app off — which also pauses every other innocent QEP decision behind it.

The fix is a per-row pause flag that the auto-route cron reads alongside the app-level flag.

### 1.2 Server contract (one new column + one new edge function)

`cc_issues` gets:

```sql
ALTER TABLE public.cc_issues
  ADD COLUMN IF NOT EXISTS auto_route_paused boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_route_paused_by text NULL,
  ADD COLUMN IF NOT EXISTS auto_route_paused_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS auto_route_paused_reason text NULL;  -- optional, ≤500
```

Both auto-route claim queries in migration 027 (`cc-auto-route-decisions` Phase A *and* Phase B SELECTs at lines 71, 211, 263) gain an `AND i.auto_route_paused = false` predicate.

A small new edge function `cc-set-decision-pause` (mirrors `cc-set-auto-route`):

```
POST /functions/v1/cc-set-decision-pause
Body: { "issue_id": "uuid", "paused": true|false, "reason": "string|null" }
Response: { "issue_id": "...", "auto_route_paused": true|false }
```

Audit event: `decision_auto_route_paused { issue_id, paused, reason }`.

`cc-read-decisions` extends each `DecisionRow` with three additive fields:

```ts
auto_route_paused?: boolean;
auto_route_paused_at?: string | null;
auto_route_paused_reason?: string | null;
```

### 1.3 Where the affordance lives

**Decision:** primary control in the **slideover footer**; secondary visual indicator (badge) on the card.

| Considered | Verdict | Why |
|---|---|---|
| (a) Hover-revealed icon on the card | Reject | Hover-only fails on touch; hidden affordances are a discoverability tax — and the row already has one obvious primary action (open the slideover). |
| (b) Slideover footer toggle | **Pick** | Operator is already engaged with the row — pausing belongs on the surface where they're forming intent. Pairs naturally with the existing `Close` / `Answer` footer pattern. |
| (c) Separate per-row icon button | Reject | Adds noise to a card layout the design recon called out for its calm. |

**Footer layout in `DecisionDrawer` (Decisions.tsx:262-282):**

```
┌─ SlideOver footer ─────────────────────────────────────────┐
│  [ ☐ Pause auto-route ]      [ Close ]   [ Answer decision ]│
└────────────────────────────────────────────────────────────┘
```

The new control is a left-aligned `<label>` containing a checkbox + label text. Same `ghost-btn` styling minus the border (it reads as a tertiary action). On change, it fires `setDecisionPause(issue_id, !current, null)` immediately (no separate "save" step — same instant-write pattern as `setAutoRoute` on Apps).

**Auto-route already in-flight (state = `rewriting` or `rewrite_ready`):**

When `decision_email_state ∈ {rewriting, rewrite_ready}` AND the operator hits Pause, we show a confirm strip directly above the footer:

```
┌─ panel-warning ────────────────────────────────────────────┐
│ ⚠ A rewrite is already queued for this decision.           │
│   Pausing now will discard the pending send.               │
│   [ Keep going ]  [ Pause and discard rewrite ]            │
└────────────────────────────────────────────────────────────┘
```

`Pause and discard rewrite` calls the server which (a) sets `auto_route_paused = true`, and (b) flips the corresponding `cc_decision_email_sends.state` from `rewriting`/`rewrite_ready` → `cancelled` (a state value that already exists semantically; if not, fall back to `expired` with `last_error='paused_by_operator'`). The server-side detail is out of scope for this UX doc — what the operator sees is a one-click commitment.

If `decision_email_state ∈ {sent, delivered, opened, clicked, replied, extracting, …}` (the genie is out of the bottle — an email is already with the recipient), the **Pause auto-route** checkbox is rendered **disabled** with a hover tooltip:

> "This decision is already with the recipient. Pausing won't recall it. Use Snooze instead if you want to hide it from your queue."

This is the natural escalation path into Section 4 (Snooze). One consistent mental model — pause is *pre-send*, snooze is *operator visibility*.

### 1.4 Badge on the decision card

A new compact badge — neutral grey, not amber (paused is operator-intentional, not action-needed):

```
.decision-state-badge.paused {
  color: rgba(255,255,255,.66);
  background: rgba(255,255,255,.06);
  border: 1px solid rgba(255,255,255,.14);
  border-radius: 999px;
  padding: 3px 9px;
  font-size: 11px;
  letter-spacing: .04em;
  text-transform: uppercase;
}
```

Rendered text: **`paused`** (lowercase, matches existing badge convention from Slice 2's `needs review`). Uses the existing `decision-state-badge` family so we add one new CSS rule, no new HTML primitive.

`decisionEmailState()` (Decisions.tsx:294-302) gets a small front-loaded check:

```ts
if (row.auto_route_paused === true) return 'paused';
// ...existing logic...
```

The `paused` badge supersedes `unrouted` / `routed` / `link_clicked` / etc. in the visual hierarchy — operator intent trumps lifecycle.

### 1.5 Filter chip integration

`FilterBand` (Decisions.tsx:168-195) currently exposes three chip groups: **Owner**, **Age**, sort. We add a fourth — **State** — with three pills:

```
State:  [ Active ]  [ Paused ]  [ All ]
```

- `Active` (default): hides rows where `auto_route_paused === true`. This keeps the Open Decisions band feeling clean.
- `Paused`: only paused rows.
- `All`: shows both.

Implementation is a one-liner predicate added to `filterDecisionRows()` in `lib.ts`. The chip reuses the existing `.decisions-chipgroup` CSS pattern — no new styling.

### 1.6 Slideover-side: paused-state metadata

When viewed in `DecisionDrawer`, a paused row shows a `panel-section` strip just below the title:

```
┌─ panel-section ────────────────────────────────────────────┐
│ ◐ AUTO-ROUTE                                               │
│   Paused by brian.lewis@blackrockai.co · 2h ago            │
│   Reason: "Want to draft Rylee's reply myself this time."  │
│   [ Resume auto-route ]                                    │
└────────────────────────────────────────────────────────────┘
```

The `panel-label` eyebrow reads `AUTO-ROUTE`. Reason text is optional — if `auto_route_paused_reason` is null, the line is omitted entirely. `[ Resume auto-route ]` is a `ghost-btn` that calls the same toggle in reverse.

When **not** paused, this entire `panel-section` is absent (auto-hide empty bands).

---

## 2. Reminder cron output — what does the customer see?

### 2.1 Locked invariants (carried from Phase 5 §12 #7)

- **One** reminder, fired at 2 days post-send. Never a second.
- Magic-link tokens reused (still valid until day 7).
- Threaded in the same Gmail conversation as the original send.
- Sender unchanged: `Brian Lewis <brian.lewis@blackrockai.co>`.
- Sign-off must give the recipient a clean out without making them feel hassled.

### 2.2 Subject

**Decision: `Following up on {original_subject}`.**

| Considered | Verdict | Why |
|---|---|---|
| `Friendly reminder: [QEP] decision needed` (per UX Recon §5) | Reject | Robotic, brackets read as automation, "decision needed" creates pressure. |
| `Quick reminder — your input needed on X` | Reject | "Your input needed" overstates urgency for what might be a 30-second tap. |
| `Following up on {original_subject}` | **Pick** | Natural language a real person uses. Threads correctly because Gmail will collapse it under the original. Two days isn't long enough for "I wanted to check in," which would feel performative. |

If `{original_subject}` already starts with `Re:` (rare on outbound but possible), strip it before prefixing. Example pair:

| Original send | Reminder |
|---|---|
| `Quick question about rebate stacking on QEP quotes` | `Following up on quick question about rebate stacking on QEP quotes` |

Subject is sentence-cased after the `Following up on ` prefix — we lowercase the first letter of the carried subject so it reads as a continuation.

### 2.3 Body template

Plain-text and HTML, both threaded via `In-Reply-To: <original_message_id>` and `References: <original_message_id>`. The HTML body reuses Slice 1's `decision-email-template.ts` helper (`renderButtons(options)`) — zero new templating code.

```
Hey {recipient_first_name},

Just bubbling this back up — I'm still waiting to hear which way
you'd like to go on:

   {original_decision_title}

   [ {option_1_label} ]
   [ {option_2_label} ]
   [ {option_3_label} ]

If now's not a good time, just reply to this thread and I'll
handle it on my end.

Thanks,
Brian
```

Notes:

- **No** "this is a reminder" banner. The Gmail-threaded "Following up on…" subject is enough context.
- **No** "if you've already answered, ignore" disclaimer (UX Recon §5's version had this — it's removed because Slice 2's extraction loop and the same-token invariant mean a reply will be matched correctly even if it arrives late, and the disclaimer reads as "our system might be wrong").
- The sign-off line `"If now's not a good time, just reply to this thread and I'll handle it on my end."` is the customer's clean off-ramp. It lowers stakes — they can reply *anything*, including "skip" or "you decide," and that reply lands in `extracting` → operator review (Slice 2) instead of bouncing.
- **`{recipient_first_name}`** is taken from `cc_decision_recipients.contact_name` split on the first whitespace. Falls back to "there" if name is missing.

### 2.4 What the operator sees about the reminder

#### 2.4.1 Recently answered band — **no change**

The reminder is not an answer; it does **not** insert into `cc_decision_answers` and so does not appear in `Recently answered` (which is `cc-read-decisions`'s `answered_recent`). Correct — operator's eye should not be pulled to it.

#### 2.4.2 Lately feed (Home) — one new mapping

Per Phase 5 §9.5 and UX Recon §6, extend the activity-feed mapping in `lib.ts` (the `case ... return` chain near line 1357):

```ts
case 'decision_reminder_sent':
  return [
    `You sent a reminder on the ${appShortCode} ${decisionTitle} — still waiting on ${recipientFirstName}.`,
    false  // not high-priority / not surface-yellow
  ];
```

The Lately copy keeps the same earned-calm voice. `recipientFirstName` is parsed the same way as the email template.

#### 2.4.3 Decision card meta line — one new line

In `DecisionCard` (Decisions.tsx:191-214), when the row has a `reminded_at` timestamp (new optional field on `DecisionRow`), append a one-line meta:

```
Reminded {ago(reminded_at)}    (rendered after the existing email-state badge)
```

Same `decision-meta` class — no new CSS. Hidden when `reminded_at` is null.

#### 2.4.4 Audit-only events (hidden from Lately, per UX Recon §6)

- `decision_reminder_attempted` (cron fired but row state didn't allow send)
- `decision_reminder_skipped_already_answered`

These are useful for postmortem grepping but not for the operator's daily eye.

### 2.5 Edge cases the cron must handle (server-side, surfaced via state for cockpit consistency)

| State at T+2d | Reminder behavior | Cockpit consequence |
|---|---|---|
| `sent` / `delivered` / `opened` | Send reminder. Set `reminded_at`. State stays unchanged. | "Reminded 2 min ago" line appears. |
| `clicked` | **Skip.** Recipient touched the link — don't badger. | No reminder line. Audit `decision_reminder_skipped_link_clicked`. |
| `replied` / `extracting` / `answered` / `done` | **Skip.** Conversation has moved on. | No reminder line. Audit `decision_reminder_skipped_already_answered`. |
| `paused` (§1) | **Skip.** Operator paused intent. | No reminder line. Audit `decision_reminder_skipped_paused`. |
| `snoozed` (§4) | **Skip.** Operator deferred visibility. | No reminder line. Audit `decision_reminder_skipped_snoozed`. |
| `bounced` / `failed` / `expired` | **Skip.** | No reminder line. |

---

## 3. Richer operator clarification compose modal

### 3.1 Why expand vs. add a sub-modal

The current `ExtractionReviewModal` (web/src/ExtractionReviewModal.tsx:71-81) already has a clarification radio that pops a textarea. Slice 2's design (§5) sketched a richer compose surface but it never materialised — the shipped code just exposes a single `<textarea>` for `message`.

Slice 3 promotes that placeholder into the full Slice 2 §5 spec, **in-line within the same SlideOver**. We do **not** open a sub-modal because:

- Sub-modal on top of a slide-over is a nesting anti-pattern (two scroll contexts, double Escape semantics, accessibility headache).
- The slide-over is already tall enough — the compose form fits below the existing sections without ever covering the original-question / customer-reply context. That context is *useful* while composing.
- One affordance, one surface — consistent with the rest of the cockpit.

### 3.2 Surface

When the operator clicks the **Send a clarification** radio, the panel currently swaps the simple textarea in. After Slice 3, that radio expands a richer block:

```
┌─ CLARIFICATION EMAIL (panel-label, only when 'clarify' radio active)──┐
│                                                                      │
│  ┌─ row ────────────────────────────────────────────────────────────┐│
│  │  To       Rylee <rylee@qep.com>                  (read-only)     ││
│  │  Subject  [ Re: Rebate stacking rules                          ] ││
│  └──────────────────────────────────────────────────────────────────┘│
│                                                                      │
│  Body                                                                │
│  ┌──────────────────────────────────────────────────────────────────┐│
│  │ Hey Rylee,                                                       ││
│  │                                                                  ││
│  │ Thanks for the reply — just want to make sure I picked the       ││
│  │ right one. Did you mean:                                         ││
│  │                                                                  ││
│  │   • Let customers stack both rebates                             ││
│  │   • Customer picks one rebate                                    ││
│  │   • System auto-picks the best                                   ││
│  │                                                                  ││
│  │ Just click whichever fits — or reply with the option name.       ││
│  │                                                                  ││
│  │ Thanks,                                                          ││
│  │ Brian                                                            ││
│  └──────────────────────────────────────────────────────────────────┘│
│                                                                      │
│  ☑ Include the three option buttons                                  │
│  ☐ Regenerate magic-link tokens (only if originals leaked)           │
│                                                                      │
│  ▸ Preview rendered email                                            │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

`Send clarification` (the existing primary button in the footer; label switches when the radio is on `clarify`) wires to `cc-operator-clarify-extraction` with the richer payload.

### 3.3 Form spec

| Field | Default | Validation | Notes |
|---|---|---|---|
| **To** | `recipient_name <recipient_email>` from the send row | n/a — read-only | Renders as plain text inside an `answer-box` shell so it looks like a field but is non-editable. Operator cannot redirect a clarification to a different person; if they want to escalate, they re-route the parent decision. |
| **Subject** | `Re: {original_subject}` (lowercased after the colon if needed) | required, ≤200 chars | Pre-filled, fully editable. |
| **Body** | If `llm_extraction.suggested_clarification` is present, use it. Else use a hydrated generic template that enumerates `options_snapshot`. | required, ≤4000 chars | Multi-line `textarea` rows=10. Operator can edit freely. |
| **Include option buttons** | ☑ ON when `llm_extraction.confidence < 0.85` OR `requires_human === true`. ☐ OFF when the existing extraction was high-confidence (operator likely wants a pure text exchange). | n/a | Bound to the existing `include_buttons` field in `OperatorClarifyExtractionPayload`. |
| **Regenerate magic-link tokens** | ☐ OFF | n/a | Bound to `regenerate_tokens`. Tooltip on the label explains "Only flip this on if you have reason to invalidate the original buttons (rare; e.g., the recipient said they forwarded the email)." |

### 3.4 Preview pane

A `<details>` disclosure labelled **▸ Preview rendered email**. When opened, the body renders a static HTML preview using the shared `decision-email-template.ts` helper — **client-side render only**, server doesn't get a separate preview-render call.

To avoid extra JS, the preview is an `<iframe sandbox="">` injecting a small HTML doc composed in JS:

```ts
function renderClarifyPreviewHtml(subject: string, body: string, options: DecisionOptionLike[], includeButtons: boolean): string {
  // calls the shared template renderer used by Slice 1's email send,
  // then escapes + wraps for the sandboxed iframe.
}
```

This is ~25 lines including the helper import. The shared template helper is already linked from Slice 1 (`supabase/functions/_shared/decision-email-template.ts` or equivalent) — we expose a small client-side mirror in `web/src/emailPreview.ts` that reuses the same partials by string template (or imports them — TS path config permitting). If the path config makes sharing hard, the cockpit ships its own ~40-line mirror — the email HTML is well-bounded and easy to keep in sync, and the test path is "preview matches what server renders" which we verify visually once.

If sharing proves too fiddly inside the 2-hour budget, **defer the preview pane** to a follow-up — the rest of Section 3 is independently valuable.

### 3.5 State management glue

The existing `ExtractionReviewModal` already keeps these states in `useState`:

```ts
const [action, setAction] = useState<'accept'|'pick'|'reject'|'clarify'>(...);
const [clarify, setClarify] = useState(...);   // <- current body textarea
```

Slice 3 grows the `clarify` state from a string into an object:

```ts
const [clarify, setClarify] = useState<ClarifyComposeForm>({
  subject: '',
  body: '',
  includeButtons: true,
  regenerateTokens: false,
});
```

…and the `onClarify` callback grows from `(sendId, message)` to:

```ts
(sendId: string, payload: { subject: string; body: string; include_buttons: boolean; regenerate_tokens: boolean })
```

`lib.ts`'s `operatorClarifyExtraction(...)` shim is the one place the payload shape changes — that's a ~5-line edit. `Decisions.tsx`'s callsite (Decisions.tsx:101) updates its closure body to pass the richer object straight through.

### 3.6 Validation + footer label

- The primary footer button label remains adaptive:
  - `action === 'accept' | 'pick'` → `Confirm answer`
  - `action === 'reject'` → `Reject extraction`
  - `action === 'clarify'` → `Send clarification`
- It is disabled (`btn-primary`+`disabled` styles) until:
  - For `clarify`: subject non-empty AND body non-empty (≥1 char trimmed) AND not currently `busy`.
  - For everything else: same as today.

---

## 4. Snooze decision (P1 — trimmed scope)

### 4.1 Decision: ship as fixed-duration only

A custom-duration picker (date+time popover) would consume ~45 min of UI work alone. Slice 3's frontend budget can't absorb that. Ship the trimmed version: **three fixed durations + a manual unsnooze**.

### 4.2 Server contract

`cc_issues` gets:

```sql
ALTER TABLE public.cc_issues
  ADD COLUMN IF NOT EXISTS snoozed_until timestamptz NULL,
  ADD COLUMN IF NOT EXISTS snoozed_by    text        NULL,
  ADD COLUMN IF NOT EXISTS snoozed_at    timestamptz NULL;
```

Plus a small new edge function `cc-set-decision-snooze`:

```
POST /functions/v1/cc-set-decision-snooze
Body: { "issue_id": "uuid", "snoozed_until": "<iso timestamp> | null" }
Response: { "issue_id": "...", "snoozed_until": "..." }
```

`null` means clear / unsnooze.

`cc-read-decisions` extends each `DecisionRow` with `snoozed_until` (optional, ISO string).

Audit: `decision_snoozed { issue_id, snoozed_until }`, `decision_unsnoozed { issue_id }`.

**No cron required** for expiry: the cockpit decides what to show based on `snoozed_until <= now()`. Server-side, no state changes when a snooze "expires" — it just becomes ignorable. This keeps Slice 3 backend-light.

### 4.3 Where the affordance lives

**Decision:** in the **slideover footer**, paired with the new Pause toggle from §1, **not** as a hover-row action.

```
┌─ SlideOver footer ─────────────────────────────────────────┐
│ [☐ Pause auto-route]  [⏰ Snooze ▾]  [Close] [Answer ▸]    │
└────────────────────────────────────────────────────────────┘
```

`[⏰ Snooze ▾]` is a `ghost-btn` with a small native `<select>` popped via a click — exact same pattern as the existing **Sort** toggle in `FilterBand` (Decisions.tsx:193). Options:

```
- 24 hours
- 3 days
- 7 days
- (Unsnooze)   ← only present when snoozed_until > now()
```

On selection, immediately fires `setDecisionSnooze(issue_id, now + N)` and updates the button label to `⏰ Snoozed 24h ▾` (relative-time, recomputed by `ago()`). No save/confirm step.

If the operator opens a snoozed decision from the "show snoozed" filter (§4.4), the label reads e.g. `⏰ Snoozed · 2d left ▾` — clicking shows the same options plus `(Unsnooze)`.

### 4.4 Filter chip integration

The same `State` chip group introduced in §1.5 grows by one extra invisible-state pill — except we keep the UI to 3 visible pills and use a "second tier" semantic:

```
State:  [ Active ]  [ Paused ]  [ All ]
```

- `Active` (default): hides rows where `auto_route_paused === true` **OR** `snoozed_until > now()`.
- `Paused`: rows where `auto_route_paused === true`. (Does not show snoozed-only rows.)
- `All`: shows everything including snoozed.

We deliberately **do not** add a fourth "Snoozed" pill. Snooze is operator-internal, transient by design — the bar shouldn't accrue a permanent home for it. Operators who want to peek at the snoozed pile flip `State` → `All`.

### 4.5 Badge on the card

Snoozed rows get a new badge identical visually to the `paused` badge but with a clock glyph:

```
.decision-state-badge.snoozed {
  /* same as .paused but with a leading ⏰ inline */
}
```

The badge text reads: **`snoozed · {ago_inverted}`** — e.g., `snoozed · 22h left`.

`decisionEmailState()` precedence (top to bottom):

1. `auto_route_paused === true` → `paused`
2. `snoozed_until > now()` → `snoozed`
3. existing logic

Snoozed rows are by default *hidden* (Active filter), so the badge is only visible when the operator opts to see them.

### 4.6 Expiry behavior

**Decision: auto-resurface.** When `snoozed_until <= now()`, the row reappears in the Active view on the next `cc-read-decisions` refresh. No operator-revisit step.

Trade-off considered: making the operator manually re-acknowledge a snoozed row creates a "second touch" that feels artificial — the whole point of snooze is "I'll handle it tomorrow," and tomorrow it should just be there. We accept the small risk that a row resurfaces while the operator is mid-cockpit and didn't expect it; the badge and sort order already make new arrivals visible.

When a row auto-resurfaces, the operator sees no special chrome — it's just back in `Active`. The `snoozed_until` field stays populated (we don't clear it on read) so an audit query can answer "did this ever get snoozed?" — but the cockpit treats `snoozed_until <= now()` as "not snoozed" for filtering and badge purposes.

### 4.7 What we explicitly defer

- **Custom date/time picker.** Bring up in Slice 4 if operators ask. Until then: 24h / 3d / 7d covers the realistic spread.
- **Bulk snooze.** Out of scope.
- **Snooze notification when expiring.** No — auto-resurfacing is enough; sending the operator a notification ping for every expiring snooze defeats the whole "earned calm" voice.

---

## 5. Cross-cutting cockpit deltas

### 5.1 New / extended TypeScript types in `web/src/lib.ts`

Additive only — no breaks.

```ts
// ---------------------------------------------------------------------------
// SLICE 3: Pause + Snooze + Reminder visibility
// ---------------------------------------------------------------------------

export interface DecisionRow extends Record<string, unknown> {
  // ... existing fields ...

  // §1 — per-decision pause
  auto_route_paused?: boolean;
  auto_route_paused_at?: string | null;
  auto_route_paused_by?: string | null;
  auto_route_paused_reason?: string | null;

  // §4 — snooze
  snoozed_until?: string | null;     // ISO; null when never snoozed or already expired
  snoozed_by?: string | null;
  snoozed_at?: string | null;

  // §2 — reminder visibility
  reminded_at?: string | null;       // last reminder sent at; null if none
}

// §1 — pause API
export async function setDecisionPause(
  issueId: string, paused: boolean, reason?: string | null, demo = false,
): Promise<{ issue_id: string; auto_route_paused: boolean }> { /* postJson('cc-set-decision-pause', ...) */ }

// §4 — snooze API
export async function setDecisionSnooze(
  issueId: string, snoozedUntil: string | null, demo = false,
): Promise<{ issue_id: string; snoozed_until: string | null }> { /* postJson('cc-set-decision-snooze', ...) */ }

// §3 — richer clarify payload
export interface OperatorClarifyExtractionPayload {
  send_id: string;
  subject: string;
  body: string;
  include_buttons: boolean;
  regenerate_tokens: boolean;
}

// (signature of operatorClarifyExtraction broadens from message:string to the payload object)
```

`State` chip enum in `Decisions.tsx`:

```ts
export type DecisionStateFilter = 'active' | 'paused' | 'all';
```

`filterDecisionRows` (lib.ts ~line 1795) gains:

```ts
if (filters.state === 'active') {
  if (row.auto_route_paused) return false;
  if (row.snoozed_until && new Date(row.snoozed_until) > new Date()) return false;
}
if (filters.state === 'paused' && !row.auto_route_paused) return false;
```

### 5.2 New CSS rules in `web/src/index.css`

| Rule | Lines | Notes |
|---|---|---|
| `.decision-state-badge.paused` | 8 | Neutral grey, same family as Slice 2's `.needs_review`. |
| `.decision-state-badge.snoozed` | 8 | Same as `.paused` + leading ⏰ glyph via `::before`. |
| `.panel-warning` | 12 | Amber strip for the "Pause will discard pending rewrite" confirm; reuses existing `.panel-error` palette tweaked to amber. |
| `.slideover-footer-left` | 6 | Left-aligns the new Pause checkbox + Snooze select against the existing right-aligned button pair (justify-between). |

Total: ~34 lines of CSS.

### 5.3 No new icons

All glyphs (`⏰` clock, `◐` pause-half-circle, `⚠` warning) are existing Unicode characters already used elsewhere in the cockpit (`⚠` appears in `PendingReviewBand`, Decisions.tsx:152). No new SVG assets added.

---

## 6. Implementation checklist (cockpit side)

Tracked file-by-file, with estimated frontend lines per file. Server changes are sketched in §1.2 / §2.5 / §4.2 but excluded from these counts.

| File | Change | Est. lines |
|---|---|---|
| `web/src/lib.ts` | Extend `DecisionRow` with 4 pause fields + 3 snooze fields + 1 reminder field. Add `DecisionStateFilter` type. Extend `filterDecisionRows` predicate (~3 lines). Add `setDecisionPause`, `setDecisionSnooze` API shims. Broaden `OperatorClarifyExtractionPayload` + `operatorClarifyExtraction` signature. Extend `parseDecisionRow` to read the new optional fields. Add `'decision_reminder_sent'` Lately mapping. Add demo data for pause + snooze. | ~80 |
| `web/src/Decisions.tsx` | Add `state` filter chip group in `FilterBand`. Update `decisionEmailState` precedence for `paused` / `snoozed`. Add `reminded_at` line to `DecisionCard` meta. Wire `DecisionDrawer` footer to host `<PauseToggle>` + `<SnoozeMenu>`. Add the `panel-warning` strip for pause-while-rewriting. Add `AUTO-ROUTE` panel-section to the slideover body when paused. | ~110 |
| `web/src/ExtractionReviewModal.tsx` | Replace the existing one-textarea clarify block with the richer compose form (subject input, body textarea rows=10, two checkbox toggles, preview disclosure). Grow `clarify` state from string → object. Update the `onClarify` call to pass the richer payload. Add submit validation. | ~95 |
| `web/src/index.css` | Add `.decision-state-badge.paused`, `.decision-state-badge.snoozed`, `.panel-warning`, `.slideover-footer-left`. Tweak `.slideover-footer` to flex `justify-content: space-between` (one-line tweak). | ~38 |
| `web/src/emailPreview.ts` (NEW, optional) | Client-side mirror of the Slice 1 email template for the §3.4 preview pane. **Defer if budget tight.** | ~45 (deferrable) |

**Frontend total (without optional preview pane):** ~323 lines across 4 files.
**Frontend total (with preview pane):** ~368 lines across 5 files.

At ~3 lines/min on familiar terrain that's ~110–120 min of edit time — under the 2-hour ceiling with buffer for verification.

### 6.1 Suggested implementation order

1. `lib.ts` types + API shims + parser extensions + demo data (foundation; lets everything else compile).
2. `Decisions.tsx` — `State` chip + badge precedence + footer hosting. Validates the data path E2E.
3. `ExtractionReviewModal.tsx` — clarify compose expansion. Isolated change, no upstream coupling.
4. `index.css` — finalize palette + spacing.
5. Optional: `emailPreview.ts` — only if §3.4 didn't slip to follow-up.

### 6.2 Out of scope for Slice 3 (call out explicitly)

- **No** new top-level nav item. (Constitution rule.)
- **No** modal dialogs. (Slide-over pattern only.)
- **No** custom snooze date/time picker.
- **No** bulk-pause or bulk-snooze.
- **No** server-side snooze-expiry cron — the cockpit handles "is this still snoozed?" via wall-clock comparison.
- **No** second reminder ever — Phase 5 §12 #7 invariant.
- **No** operator-facing "snooze expiring soon" notifications.
- **No** email-preview *server* render endpoint — client-side mirror only.

---

## 7. Open questions for the operator

1. **Should the snooze options be 24h / 3d / 7d, or 1d / 3d / 7d?** Both are reasonable. Recommendation: **24h** rather than "1 day" because operators frequently snooze evening-discovered items for "tomorrow morning" — 24h aligns the resurface clock with that intent better than `+1 day midnight`.
2. **Should the pause auto-route checkbox accept an optional reason inline?** Current design leaves the reason field nullable but doesn't surface a textbox in the footer. Adding one would inflate the footer; the slideover already has space for a `panel-section` to host an optional `Why?` field. Recommendation: ship without the reason input v1, add inline if operators want it.
3. **`paused` precedence over `snoozed` in badges.** When a row is *both* paused and snoozed, the design shows `paused`. Is that the right priority signal? Recommendation: yes — pause is pre-send intent, snooze is post-send hygiene; pause is the more committal state.

---

**End of Slice 3 operator cockpit UX design.** Ready for operator greenlight + implementation.
