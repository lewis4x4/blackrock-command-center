# Decisions Page — UX Review

**Status:** Design review (no code)
**Date:** 2026-05-23
**Reviewer:** JARVIS (lens: solo operator)
**Subject:** `web/src/Decisions.tsx` (and the chips/copy it composes)
**Out-of-scope:** the state-sync bug ("Unrouted" lingering after send) — sibling agent owns; the em-dash subject encoding bug — sibling agent owns.

> TL;DR — The page works. The card grid is solid bones. But the *signal-to-chrome* ratio is wrong: every card looks identical, the most visually dominant element is a meaningless fallback ("AUTHORIZE"), the state pill exposes an internal enum ("Unrouted") that the Phase 5 UX recon already told us to render as "Open," and the page diverges sharply from the Bible's stated intent — a *register*, not an *answering surface*. Five concrete v0.5 changes (Section 12) buy back ~80% of the readability with no architecture change.

---

## 0. What I read

- `web/src/Decisions.tsx` (full, 481 lines)
- `web/src/DecisionRouteModal.tsx` (full, 228 lines)
- `web/src/lib.ts` — `decisionOwnerKind`, `decisionRowTitle`, `filterDecisionRows`, parsing helpers (lines 1815–2046, 2255–2271)
- `web/src/index.css` — `.decisions-page` block + Phase-5 routing rules (lines 408–445)
- `supabase/functions/cc-rewrite-decision/index.ts` (full, 131 lines) — confirmed line 53–54: "Empty options array is allowed: the AI rewrite step will suggest options (Mac Studio Claude) and the operator approves/edits before send."
- `docs/COMMAND_CENTER_MASTER_PLAN.md` §5.2.1 (lifecycle chip vocabulary, lines 689–702), §5.2.2 (Open Decisions panel, lines 703–715), §5.6 (Decisions page purpose, lines 791–793)
- `docs/designs/PHASE_5_UX_RECON.md` §3 (operator confirm queue location), §4 (state badge table, lines 162–172)
- `docs/designs/PHASE_5_EMAIL_DECISION_ENGINE.md` §6.2 (cc-route-decision invariants), §9.4 (AI-rewrite preview)
- `docs/designs/DECISIONS_PAGE_BUILD.md` (original v1 plan)

## 1. First-glance scan (the 2-second test)

What an operator's eye actually does on the current page, in order:

1. Hero block with two big headers ("Decisions inbox" / "Clear every app's open questions").
2. Three big metric tiles. The third is captioned "CLIENT / UNKNOWN" with value `5 / 5`.
3. Filter strip — 4 chip groups + a sort toggle.
4. Five identical cards in a `repeat(auto-fit, minmax(280px, 1fr))` grid. Each card has a left border accent (3px), an app badge, a bold amber **AUTHORIZE** chip in the top-right, a long title, three little grey pill chips, an options blurb, and a "Route to recipients" link at the bottom.

The page wants the operator's eye to land on the amber **AUTHORIZE** chip — because amber + uppercase + 800 weight + top-right placement is the strongest visual contrast on the card. But that chip is the lowest-information element on the page. Per `Decisions.tsx:380-383`:

```ts
function riskClass(row: Record<string, unknown>): string {
  const risk = text(row.risk_class)?.toLowerCase();
  return ['auto', 'authorize', 'destructive', 'production'].includes(risk ?? '') ? risk! : 'authorize';
}
```

**`'authorize'` is the fallback when `risk_class` is missing.** QEP rows don't populate `risk_class`, so all 5 cards show "AUTHORIZE" by default. The operator sees five amber alarms; the system sees five "we don't know." Worst of both worlds.

**No urgency differentiation.** Every card looks like every other card. Age, criticality (registry has `criticality`), and "you've already routed this" status all collapse to identical visual weight. The Bible (§5.2.2) wants oldest-first sort + an enumerated `OptionPicker` per card — currently we have oldest-first ✓ but everything past that is undifferentiated.

**What's missing in the first 2 seconds:**

- Which app(s) are these for? (You have to read the small badge text to learn.)
- Which is the most urgent? (Nothing says.)
- Which have I already routed and which haven't I touched? ("Unrouted" pill is grey and easy to miss; the routed ones disappear from the list anyway, so the operator can't differentiate "I've sent this, waiting on client" from "still on my plate.")
- How long has each been open? (Buried in `ageLabel` inside the chip soup.)

**Recommendation A — burn the risk chip from the card.** Push it into the slide-over header where it has a job to do (controlling dispatch behavior). On the card itself, replace it with **age** (e.g., a single bold "**6d**" chip in the top-right corner with color-coded background: green ≤2d, amber 3–7d, red 8d+). Age is the only signal an operator can act on at a glance. See §13 for the ASCII sketch.

**Recommendation B — group, don't grid.** Five cards in a 280px grid wastes the first 2 seconds on parsing identical cards. Group by app (when >1 app has decisions). When all 5 are QEP, render as a tight vertical list, not a grid; the grid pretends each card is independent when they're really five questions for the same client.

## 2. Card information density

Today's card is renderring this stack:

```
┌─────────────────────────────────────────────────────┐
│ [Q] QEP                              [AUTHORIZE]    │  <- app badge + risk chip
│     QEP OS                                          │
│                                                     │
│ When a rep hits source-required on equipment...     │  <- title (full raw text)
│ ...the rep needs vendor SKU for tracking before...  │
│                                                     │
│ [Client owned] [6d] [open] [Unrouted]               │  <- 3-4 chips, all small
│                                                     │
│ No enumerated options returned.                     │  <- noise (see §7)
│                                                     │
│ [Route to recipients]                               │  <- ghost button
└─────────────────────────────────────────────────────┘
```

**Load-bearing:**
- App badge (when filtered across apps)
- Title — the question itself
- Age
- "Have I routed this yet?" (currently weakly conveyed by Unrouted pill)
- The primary CTA

**Noise:**
- The AUTHORIZE risk chip (§1)
- "open" (literal `status` enum re-rendered with no value-add — it's redundant with being in the Open Decisions list)
- "No enumerated options returned." (§7 — actively misleading)
- Owner pill ("Client" / "Unknown") is *also* encoded in the colored left border (3px); rendering it twice is double-encoding without adding signal
- "Client owned" / "Unknown owned" — the word "owned" adds no information; the chip already lives in the card's owner-coded border

**Missing:**
- A one-line **gist** under the long title (§8). Long titles dominate the card.
- The **last action timestamp** — "you opened this 3d ago, never routed" vs. "client clicked link 4h ago, no answer yet." This is the difference between "I should chase" and "I should wait."
- The **recipient(s)** preview when routed — when a client decision has been sent to Rylee + Ryan, the card should say "*To: Rylee + Ryan · sent 6h ago*" not vanish into a state pill named "routed."

**Recommendation C — single info row, not chip soup.** Collapse the four meta chips into one tight info line in the format `{age} · {recipient/owner} · {state if non-default}`. Drop the literal `status` enum entirely; "Open" is implicit because the row is in the Open Decisions list. Drop the AUTHORIZE risk chip (§1).

## 3. State legibility — "Unrouted" vs. "Authorize"

The two affordances Brian's brain has to disambiguate:

| Element | What it actually is | What it looks like |
|---|---|---|
| `Unrouted` (grey pill, meta row) | Internal enum `decision_email_state = 'unrouted'` exposed verbatim | A subordinate status label |
| `AUTHORIZE` (amber pill, top-right) | Risk class default fallback | A primary action button |

The operator's mental model: *I need to do something to this card. The big amber thing says AUTHORIZE. I click it.* The big amber thing is a non-interactive label. The actual CTA is the ghost button at the bottom labeled "Route to recipients." The two have **inverse visual weight relative to their interactivity**.

**Phase 5 UX recon spec (lines 162–172) already gave us the right table** — the page just isn't following it:

| State (enum) | **Spec label** | **Spec color** | **Currently shows** |
|---|---|---|---|
| `unrouted` | **Open** | Amber | `Unrouted` (grey ❌) |
| `routed` | **Sent** | Blue | `routed` ✓ |
| `link_clicked` | **Viewed** | Blue | `link clicked` (close ✓) |
| `awaiting_operator_confirm` | **Needs Review** | Amber | `needs review` ✓ (only one we got right) |
| `answered` | **Answered** | Green | `answered` ✓ |
| `expired` | **Expired** | Red | `expired` ✓ |

The state pill is exposing the database enum name half the time. Fix is purely a label map.

**Recommendation D — state label map.** Stop rendering `state.replace(/_/g, ' ')`. Use the spec's vocabulary:

```ts
// at the call site in Decisions.tsx ~line 257
const STATE_LABEL: Record<string, string> = {
  unrouted: 'Open',
  routed: 'Sent',
  link_clicked: 'Viewed',
  awaiting_operator_confirm: 'Needs review',
  answered: 'Answered',
  expired: 'Expired',
  paused: 'Paused',
  snoozed: 'Snoozed',
};
```

Apply the same color spec to `decision-state-badge.unrouted` (currently grey #9CA3B4) → match the amber that today's `.link_clicked,.awaiting_operator_confirm` uses (#FFC061). "Open" amber says "this is on you." Grey says "this is shelf-resting." It's currently saying the wrong thing.

**When a decision IS routed, what should the operator see?** The Bible §5.6 says answering happens in the slide-over and §5.9 routing creates a "Lately" line ("A decision on SCC was emailed to Rylee to answer."). My recommendation:

- **Default Active filter** continues to show *only* `unrouted` + `awaiting_operator_confirm` (the two states that demand operator action). This is the "what needs you" view.
- Add a chip group **"Show: Open / Waiting on client / Needs review / All"** in place of the current "Active / Paused / All" — that's a more honest framing of what the filter actually does.
- Routed-but-not-answered decisions go to a collapsible **"With client"** strip *below* the open list. Visible, but quiet. ASCII in §13.
- This also gives the operator a place to **resend** or **nudge** without opening the drawer (per recon §4 actions for `routed` and `link_clicked` states).

## 4. The AUTHORIZE button — is that the right verb?

**Short answer: it's not a button, it's a chip, and yes, the verb is wrong.**

What the chip is: the literal `risk_class` of the decision, rendered as a label. Per `riskClass()` in `Decisions.tsx:380-383`, the default fallback when `risk_class` is missing on the row is `'authorize'`. So most QEP rows render as AUTHORIZE because they don't supply the field, not because they're risk-class-AUTHORIZE.

What the operator thinks it is: the primary action button.

**Why the verb collides:** The word "authorize" has a *different specific meaning* elsewhere in the system — Bible §6.4 defines `cc_authorize_work_order()` as "Brian's one press" to advance a `pending_authorization` work order to `ready`. So "AUTHORIZE" already means "press this to unblock a queued build." Putting the same word on a decision card creates a false promise.

**What the button labeled "Route to recipients" actually does** (verified against `DecisionRouteModal.tsx`):
1. Opens the drawer.
2. Drawer's `DecisionAnswerBody` shows the picker — operator clicks "Route to client" inside the body.
3. `setRoutingRow` opens `DecisionRouteModal`.
4. Modal fires `cc-rewrite-decision` → polls until `state === 'rewrite_ready'`.
5. Modal renders side-by-side: original question vs. AI-rewritten subject/body/options. Operator edits.
6. Operator picks recipients (preselected to all active recipients).
7. Operator clicks `Send as-is` → `cc-route-decision` sends the email.

So the verb chain is: **Review → Send.** Not "Authorize."

**Recommendation E — verb correction.**
- Drop "AUTHORIZE" from the card entirely. (It's the wrong word *and* the wrong information.)
- Rename the bottom-of-card CTA from "Route to recipients" → **"Send to client"** when the decision is `client`-owned and `unrouted`. State-context the verb:
  - `client` + `unrouted` → **"Send to client"** (primary button)
  - `client` + `routed` → **"Resend / nudge"** (secondary)
  - `client` + `awaiting_operator_confirm` → **"Review reply"** (primary, amber)
  - `client` + `link_clicked` → **"Nudge to confirm"** (secondary)
  - `operator` + anything → **"Answer"** (primary — opens the drawer with the OptionPicker)
- Inside the route modal, the final primary button is currently "Send as-is" — keep that; it's correct. But the modal eyebrow currently reads "Reviewing AI-rewritten decision email" which is dev-speak. **Replace with "Review before sending"** and the H2 from "Route to recipients" → **"Send to client"**.

This is also a Bible-aligned correction: §5.2.2 specifies a client-owned decision shows **"Route to {owner}"** — not "AUTHORIZE." So even the existing copy is closer to the spec than the chip is. The fix is delete the chip and rename the CTA.

## 5. Filter pills — are these right?

Current set:

```
App: [dropdown]
Owner: All | Operator | Client | Unknown
Age:   All | 0–2d | 3–7d | 8+d
State: Active | Paused | All
Sort:  Oldest first / Newest first (toggle)
```

**Defaults:** owner=`all`, age=`all`, sort=`oldest`, state=`active`. The default state is sane — operator opens the page and sees everything that needs them.

**Issues with the current filter copy / set:**

- **"Unknown" is a developer concept, not an operator concept.** It means "the row didn't include an `owner_type` field." It's not actionable — the operator can't decide to triage by "unknown" because they don't know what unknown means. (Brian's screenshot shows 5/5 cards as Client/Unknown but he probably can't tell you which is which by looking.) **Recommend: collapse "Unknown" into "Client"** (treat any non-operator owner as client-implied) at the parser level. If the row truly has zero owner signal, label it as **"Needs triage"** in the card meta row and *highlight it* — because that's the actionable thing ("you, the operator, need to assign an owner"). Then the filter chip is **All | Mine | Client | Needs triage**.

- **"Operator" is too cold.** "Mine" reads warmer and matches the way Brian thinks about his queue. The system has one operator. "Operator-owned" appears in the metric tile too — change to **"On me"** or **"Mine."**

- **"Active / Paused / All" is misleading.** "Active" includes both unrouted and waiting-on-client. An operator who sees 5 "Active" expects 5 to need them — but if 4 are waiting on a client, only 1 needs them. **Recommend the state filter become a status group:**

  ```
  Status: Needs you | With client | Needs review | Snoozed/paused | All
  ```

  Where:
  - **Needs you** = `unrouted` (open, never sent)
  - **With client** = `routed | link_clicked` (sent, awaiting reply)
  - **Needs review** = `awaiting_operator_confirm` (client replied, extraction pending operator confirm)
  - **Snoozed/paused** = `paused | snoozed` (operator-deferred)
  - **All** = everything except `answered` (which lives in the Recently Answered band)

- **Age chips are fine.** Default-shown "All" is the right pick; the 0–2/3–7/8+ buckets are an operator's actual mental model. Consider adding **"Stale"** (>14d?) as a fast triage chip when the count grows.

- **Sort toggle.** Oldest-first by default is correct. Hide the toggle behind a small `⇅` icon (icon+tooltip) to free real estate; the operator rarely wants newest-first on this page.

- **App dropdown.** Fine. When there's only one app with open decisions (today: just QEP), suppress the dropdown entirely — it's noise. Render a quiet `Showing: QEP only` line under the H1 with a click-to-broaden affordance.

**Are pills being used?** No data without analytics, but the Bible's intent (§5.6) is that the page is the *register* — filtering is the point. So adding behaviorally honest filters (status as status, not "active/paused") is high-leverage.

**Recommendation F — filter copy revisions (final).**

```
Owner:  All | Mine | Client | Needs triage
Age:    All | 0–2d | 3–7d | 8d+ | Stale (>14d)   [last chip only if any exist]
Status: Needs you | With client | Needs review | Snoozed | All
Sort:   ⇅  (icon, tooltip "Oldest / Newest")
```

## 6. Empty / loading / error states

- **Loading:** `<SkeletonCards>` renders 3 92px skeletons. Good. Matches Bible §5.8 ("never a bare spinner"). Keep.
- **Empty (no open decisions):** `<b>No open decisions</b> / Every registered app is unblocked right now.` Good — earned-calm, matches §5.8. Keep.
- **Error:** `<div className="detail-note error">Decisions read failed: {error}</div>` — a single line at the top, with no retry button (operator has to hit the refresh in the hero). The error is too quiet for a failure mode and gives the operator nowhere to go. Bible §5.8 requires "Error with retry and a mono detail."

  **Recommendation G — proper error state.** Replace inline note with a card-shaped error placeholder *inside the Open Decisions band*, with:
  - Headline: "Couldn't load decisions."
  - Sub: one-sentence plain English (e.g., "The decisions read endpoint returned a 502.")
  - A `<code>` block with the raw error (for log-grep)
  - A retry button that calls `refresh()`

- **Apps unwired / unreachable:** `<WiringNotes>` block at the bottom. Plain-text amber band. Honest. Keep — but elevate it to render *above* the cards when no cards exist (so the operator immediately understands why the queue is empty: "QEP isn't wired yet" vs. "everyone's unblocked").

- **100 cards:** untested. The grid is `repeat(auto-fit, minmax(280px, 1fr))` which means on a 1440px viewport you'd get ~5 columns × 20 rows = 100 cards. With current card density (~180px tall) that's a 3600px scroll. **Recommendation H — at the 100-decision regime, switch to a denser list view.** When `decisions.length > 20`, render a 1-column list with shorter cards (no AUTHORIZE chip, no "Route to recipients" button — entire row click-to-open). The toggle should be automatic + invisible to the operator.

- **0 decisions but unwired apps:** today shows the earned-calm empty + a quiet amber band at the bottom. Reorder: when `decisions.length === 0 && (unwired.length > 0 || unreachable.length > 0)`, the earned-calm copy lies. Replace with: *"No open decisions from wired apps. {N} apps aren't wired yet."*

## 7. "No enumerated options returned" — the misleading copy

Per `Decisions.tsx:259`:

```ts
<div className="decision-options">{options.length ? options.slice(0, 3).map(o => o.label).join(' · ') : 'No enumerated options returned.'}</div>
```

But per `cc-rewrite-decision/index.ts:53-54`:

> Empty options array is allowed: the AI rewrite step will suggest options (Mac Studio Claude) and the operator approves/edits before send.

So "No enumerated options returned" is technically true *and* operationally wrong. It implies failure ("the system tried to return options and didn't get any") when actually the design *intends* the rewrite step to fill this gap. The operator reads it as "this decision is broken." It's not — it's a freeform question the AI will turn into multiple choice on send.

**Recommendation I — replace the copy** with state-aware messaging:

| Condition | New copy | Tone |
|---|---|---|
| `options.length > 0` (current behavior) | unchanged: `option1 · option2 · option3` | neutral |
| `options.length === 0 && owner === 'client'` | *"AI will draft options on send."* | reassuring |
| `options.length === 0 && owner === 'operator'` | *"Free-form — answer in your own words."* | informational |
| `options.length === 0 && owner === 'unknown'` (= needs triage) | *"Assign an owner to continue."* | actionable |

Render in muted text (`var(--text-3)`) when synthetic so it doesn't compete with real options.

## 8. The decision title

Today the title is `decisionRowTitle(row)` which is `row.title ?? row.name ?? row.summary ?? row.source ?? 'Untitled decision'` (per `lib.ts:2261-2263`). QEP appears to be passing the full raw question text as `title`. So you get card titles like:

> "When a rep hits source-required on equipment that isn't in the SKU catalog, how should the build resolve the missing vendor SKU before continuing the order workflow?"

This dominates 60% of the card vertical real-estate.

**Recommendation J — split title vs. gist.**

- **Title** (card header, bold, 1 line, ellipsis): the short topic label. Per the AI-rewrite contract, `cc-rewrite-decision` already produces a `rewritten_subject` — when present (after a rewrite), use that as the title (it's already AI-condensed for email). When absent, fall back to a server-side condensation in the read endpoint (`cc-read-decisions`): take the first 60 chars of `title`, find the last word boundary, truncate.
- **Gist** (one-line muted sub): the original raw text, truncated to 100 chars with ellipsis. Hover/tap reveals full text. This is the question in the operator's words.
- **Full text** lives in the drawer body — same as today.

ASCII:

```
┌─ Source-required SKUs ────────────────── 6d ──┐
│  [Q] QEP                                       │
│                                                │
│  When a rep hits source-required on equipme…   │  <- gist (muted)
│                                                │
│  AI will draft options on send.                │  <- options or copy from §7
│                                                │
│  Open  ·  Client                               │  <- single info line
│                                                │
│  [Send to client]                              │  <- contextual CTA
└────────────────────────────────────────────────┘
```

**Constraint:** QEP doesn't emit a short title today, and the read endpoint doesn't condense. So the *first* shipped version of this recommendation needs a client-side condenser (or server-side, in `cc-read-decisions`) that does: take everything before the first comma or question mark; if that's >60 chars, truncate at last word boundary; append "…". Cheap, deterministic, no AI in the read path.

## 9. Mobile (380px viewport)

Tested by reading: `.decision-card-list` uses `grid-template-columns: repeat(auto-fit, minmax(280px, 1fr))` → at 380px width that's a single column. Cards render fine in width. Filterbar is `grid-template-columns: minmax(210px,1fr) auto auto auto` on desktop and **collapses to `1fr` at max-width 900px** — but each chip group within still wraps via `flex-wrap: wrap`, which gives you a 4-row filter strip on mobile (App / Owner / Age / State, each on its own row), ~32px per row, plus a 44px sort button. That's ~170px of filter chrome above the first card. On a 380×800 viewport with the hero block, the operator scrolls past ~500px before they see a single card.

**Specific 380px issues:**

| Element | Problem | Fix |
|---|---|---|
| Hero block (`.agents-hero`) | Two big headings + descriptive paragraph + metric tiles → ~280px tall | Collapse on mobile: hide the descriptive paragraph; metric tiles become one inline row |
| Filter chrome | ~170px of chip rows pushed up by full labels ("Owner", "Age", "State") | Drop label spans on mobile; use icon-prefixed compact chips ("👤 Mine", "🕒 0–2d") OR move filters into a single bottom sheet behind a "Filters (3)" button |
| Card top row | App badge + AUTHORIZE chip → fits, but the AUTHORIZE chip wraps the title to a third line on narrow widths | Remove AUTHORIZE chip entirely per §1 |
| Card meta row | 4 chips wrap to 2 rows | Per §3, collapse to single info line — fixes mobile too |
| "Route to recipients" button | Width is `max-content` → button is left-aligned at ~140px | Make button full-width on mobile (`width: 100%`) — single thumb-tap target |
| Tap target sizes | Filter chips are 34px tall — *barely* meets the WCAG 44px guidance | Bump filter chips to 40–44px on `max-width: 600px` |
| Recently Answered row | At `<= 900px` the row is `flex-direction: column` and the age aligns flex-end — wastes vertical space | Keep age inline with a right-aligned absolute position |
| Drawer / SlideOver | Drawer behavior is per `SlideOver.tsx` (not read) — needs separate mobile audit | Out of scope for this review |
| Route modal (preview pane) | Two-column on desktop, collapses to 1fr at 760px ✓ | Already fine; verify on a real phone |

**Recommendation K — explicit 600px breakpoint for the Decisions page.** Add:

```css
@media(max-width:600px){
  .decisions-hero p { display: none; }
  .decisions-chipgroup > span { display: none; }   /* drop "Owner" / "Age" / "State" labels */
  .decision-chip { height: 40px; }
  .decision-route { width: 100%; }
  .decision-card-list { padding: 12px; gap: 10px; }
}
```

(This is a CSS rec, not a code edit — flagging for whoever owns CSS later.)

**The 15-second phone test:** with the v0.5 fixes from §12, an operator on a phone can: open page → see grouped list under "QEP — 5 open decisions" → tap the top card → see "Send to client" in the slide-over → tap it → review the AI-rewrite preview → hit Send. That's 4 taps, ~10 seconds. Today: open page → scroll past hero + filters → parse five identical AUTHORIZE chips → read full question text wrapping 3 lines → guess that "Route to recipients" is the CTA → tap → drawer opens → find the right inline button → modal opens → review → send. ~7 taps, frequent scrolling, *high* uncertainty about which card is which.

## 10. The Bible's intent (master plan §5.2.1 and §5.6) — divergences

**§5.6 — Decisions page** (verbatim):

> Purpose. The cross-app decision register — browse and filter every decision blocking a build, by app, by who owes the answer, by age. **Answering still happens in the slide-over; this page is the register.** Ships now against `cc_issues` aggregate `open_decision` rows (one row per app, age-ranked, with a deep link to that app's decisions); the per-decision layer renders when item-level `cc_issues` rows exist (Phase 2) and routes to client owners by email (Phase 5). The interim state is an honest, working bridge — never "soon."

**Divergence 1: The page tries to be both register AND answering surface.** Each card has a "Route to recipients" CTA that opens the drawer that opens the route modal. Per the Bible, the *card* is a register entry; *answering* is the drawer's job. The current card-level CTA isn't wrong, but the visual emphasis (it's the most action-shaped element after the false-CTA AUTHORIZE chip) breaks the "register" framing. The fix is *not* to remove the CTA — operators want the one-tap fast path — but to **demote the visual weight** of the per-card CTA so it reads as a shortcut, not the main story.

**Divergence 2: §5.2.1 lifecycle chip vocabulary is canonical and we're not using it on the card.** The Bible's chip table (lines 691–702) is the *system-wide* vocabulary:

| `cc_issue_status` | Chip | Color |
|---|---|---|
| `surfaced` | **Needs you** | amber |
| `triaging` | **Looking into it** | amber |
| `answered` | **Answered** | blue |
| `routed_to_client` | **With {owner}** | grey |
| ... | ... | ... |

The card currently shows `decision_email_state` (a Phase-5 enum) instead of `cc_issue_status` (the Bible's lifecycle). They overlap but aren't the same: a decision can be `cc_issue_status='triaging' (Looking into it)` while `decision_email_state='routed' (Sent)`. The operator should see both, with the issue-status chip leading.

**Divergence 3: §5.2.2 specifies "an enumerated `OptionPicker` (radio — the only input that drives the build), a one-line rationale field (provenance only), and a risk badge."** The drawer body has this (per `DecisionAnswerBody`). The card doesn't preview the options as a picker — it only shows the option labels as joined text. That's fine for the card (we don't want full pickers in the grid), but it means the operator can't *answer* from the card. Per the Bible that's correct — the card is a register entry, answering is the slide-over. **Recommendation: align signage with the divide. Cards = browse + filter. Drawer = answer. Modal = send to client.** Make the card's CTA feel like an *opening verb*, not an *answering verb* — e.g., "Open" or "Review" with an arrow icon for operator-owned, "Send to client" for client-owned.

**Divergence 4: §5.6 anticipates "one row per app, age-ranked" in the interim state.** Today we render one card per *decision*, not one per *app*. With 5 QEP decisions and no other apps wired, the result is 5 cards that all say QEP. The Bible's interim spec is *more* honest: until per-decision data is rich, aggregate at the app level. We're past that interim — we have per-decision data — but the *visual* still benefits from app-grouping when most decisions are from the same app. (See Recommendation B.)

**Recommendation L — alignment over update.** The Bible is right on §5.6 (register, not answering surface) and right on §5.2.1 (chip vocabulary). Pull the page back toward the spec rather than updating the Bible. The one thing the Bible *didn't* anticipate is per-decision routing UX (since per-decision routing only landed in Phase 5) — and Phase 5 UX recon (the doc we already wrote) is the right complement. So the alignment chain is:

```
COMMAND_CENTER_MASTER_PLAN §5.6 / §5.2.1   →   PHASE_5_UX_RECON §4   →   Decisions.tsx
```

The page currently honors *part* of recon §4 (the `awaiting_operator_confirm` → "needs review" pill) but ignores the rest. The fix is: full state label map (§3 above), real CTA verbs (§4 above), drop the noise chip (§1 above). These bring the page back into Bible alignment with no Bible edits.

## 11. The pending-review band (a thing the page already does right)

Worth calling out: `<PendingReviewBand>` (lines 162–183 of `Decisions.tsx`) is *exactly* what Phase 5 UX recon §3 specified: an "Awaiting your confirmation" band at the top of `/decisions`, with the client's raw reply text in a quote block, and one card per pending extraction. The band only renders when `reviews.length > 0`, hidden gracefully otherwise. Good architecture, good copy ("Claude proposed an answer — confirm, choose differently, reject, or clarify"). **Don't touch this — it's the model for what the rest of the page should feel like.**

The only nit: the band uses `<span className="band-num">⚠</span>` (a warning glyph) for its leading icon, while the rest of the bands use numeric `1` / `2`. Inconsistent visual register. Either give *all* bands an icon (and number them 0/1/2 if you must) or keep them all numeric. Recommend dropping the ⚠ — the band already has its own treatment via `pending-review-card` class and the strong "Awaiting your review" headline.

---

# 12. Did I push this? Is this the best way?

### Steelman the opposite

> "The page is already correct and the operator just needs to learn it."

Plausible because:

- The card pattern is consistent with `/agents` and `/apps` — same hero, same bands, same chip primitives. Operators who know one page know all three. Adding bespoke layouts to `/decisions` (group-by-app, contextual CTAs, status-group filters) costs that consistency.
- The "AUTHORIZE" chip *is* meaningful in the parts of the system where it's not the fallback. Operator-owned decisions with `risk_class='destructive'` legitimately need it. Removing the chip from cards hides information that's correct for ~5% of rows.
- "Unrouted" is precise. "Open" is friendlier but slightly less precise (a decision can be "open" in `cc_issue_status` terms while `unrouted` in `decision_email_state` terms — they're orthogonal). Friendliness costs precision.
- The Bible's register/answering split is theoretical; in practice operators *do* want a one-tap CTA on the card. Forcing them through the drawer for every action is a step regression.
- 5 cards is a non-problem. Optimize when there are 50.

**Where I agree with the steelman:**

- Consistency cost is real. Recommendation B (group-by-app, denser list at scale) should be optional, not default; let the operator toggle. The grid is fine for 5 cards.
- The AUTHORIZE chip *should* survive in the slide-over header where it has work to do. It just shouldn't be the loudest element on the card.
- The Bible's register/answering split should be *grammar*, not law. A one-tap card CTA is operator-aligned even if not Bible-aligned. Keep it; just demote its visual weight relative to the title + age + state.
- The 5-vs-50 point is important. Don't redesign for a queue size we don't have. Below.

**Where the steelman fails:**

- "Operator learns it" is the rationale that ships every confusing enterprise UI. The system has one operator; the operator is the *source of truth* about what's confusing. He told us. Believe him.
- "Unrouted" is precise *and* internal jargon. The spec we wrote ourselves (Phase 5 UX recon §4) already chose the friendlier word. We're choosing internal precision over the spec. That's a self-inflicted divergence with no upside.

### The single biggest risk of my recommendations

**Adding chrome.** The biggest failure mode for this kind of review is "fix every nit, ship a page that's slower to scan than before." Specifically:

- Replacing the AUTHORIZE chip with an age pill is *one chip for one chip* (good). But adding a separate "Needs triage" highlight + a status group filter + a contextual CTA per state + an app-grouping header + a "With client" strip below the main list is *five new things*. Each one is justified individually; together they could make the page feel busier, not calmer.
- The state label map (§3 / Rec D) is pure win. Free.
- The verb rename (§4 / Rec E) is pure win. Free.
- The options-copy fix (§7 / Rec I) is pure win. Free.
- Everything else has a chrome cost. Be selective.

**Mitigation:** ship the free wins first (D, E, G, I), prove out the card-density change (C — collapse meta chip row), then re-evaluate before adding status-group filters or per-state CTAs or app-grouping. The framework is: any change that makes the page *feel quieter* ships immediately; any change that adds new UI ships after the quieter version has proven out for a week.

### What I'd cut to ship a v0.5 in days — the 5 highest-leverage

If we ship nothing else, ship these:

1. **State label map (Rec D, §3).** Pure dictionary swap. `unrouted → Open`, color → amber. ~10 LoC.
2. **Drop the AUTHORIZE chip from the card (Rec A, §1).** Replace top-right with an age pill (color-banded). ~15 LoC + a small CSS rule.
3. **Verb fix (Rec E, §4).** "Route to recipients" → "Send to client" (state-contextual). Modal eyebrow + H2 cleanup. ~5 LoC in `Decisions.tsx` + ~5 in `DecisionRouteModal.tsx`.
4. **Options-empty copy (Rec I, §7).** Replace "No enumerated options returned" with the state-aware variant. ~8 LoC.
5. **Proper error state with retry (Rec G, §6).** Card-shaped placeholder inside the Open Decisions band when load fails. ~25 LoC.

Total estimated LoC: ~70. All in `Decisions.tsx` plus a small `index.css` rule plus a 2-line edit to `DecisionRouteModal.tsx`. Zero new components. Zero backend changes. Zero new types.

**What this v0.5 buys:**

- The amber CTA-shaped thing on the card actually maps to an action verb that does what it says.
- "Open" / "Sent" / "Viewed" / "Needs review" replaces the internal enum. The operator reads English, not Postgres.
- The card title's competition with the AUTHORIZE chip is gone; the eye lands on **age + title + state**, the three things that matter.
- The "system is broken" reading of "No enumerated options returned" becomes "AI will draft options on send" — accurate, calming, true.
- Load failures degrade with dignity instead of a one-line apology.

**What v0.5 explicitly doesn't include** (deferred to v1.0):

- App-grouping / list-vs-grid (Rec B, H) — only matters at scale
- Status-group filter rename (Rec F) — depends on v0.5 changes landing first
- Title vs. gist split (Rec J) — needs a server-side condenser
- Card-level contextual CTAs per state (Rec E extended) — depends on the state-sync bug being fixed first
- Mobile-specific breakpoint (Rec K) — independent CSS work, ship behind a separate PR

### Confirm or revise

**Confirmed.** Ship the v0.5 five. They're each independently true, mutually consistent, and add zero new UI. Defer the rest until v0.5 lands and Brian uses it for a week.

The one revision I'd make to my own recommendations on re-read: **don't rename the Owner filter from "Operator" to "Mine" in v0.5.** It's a Bible/recon-divergent change with low leverage (only one operator), and Brian's mental model is already "operator-owned" because that's the language of the rest of the system. Leave it. Only collapse "Unknown" → "Needs triage" if/when the unknown-owner state is itself a real signal.

---

# 13. ASCII sketches

### Card today

```
┌────────────────────────────────────────────────────┐
│ ▌Q  QEP                              [AUTHORIZE]   │
│ ▌   QEP OS                                         │
│ ▌                                                  │
│ ▌  When a rep hits source-required on equipme...   │
│ ▌  ...what should the build do?                    │
│ ▌                                                  │
│ ▌  [Client owned] [6d] [open] [Unrouted]           │
│ ▌                                                  │
│ ▌  No enumerated options returned.                 │
│ ▌                                                  │
│ ▌  [Route to recipients]                           │
└────────────────────────────────────────────────────┘
```

### Card after v0.5 (Recs A, D, E, I)

```
┌────────────────────────────────────────────────────┐
│ ▌Q  QEP                                     [6d]   │  <- age replaces AUTHORIZE
│ ▌                                                  │
│ ▌  When a rep hits source-required on equipme...   │
│ ▌                                                  │
│ ▌  AI will draft options on send.                  │  <- §7 fix
│ ▌                                                  │
│ ▌  Open  ·  Client                                 │  <- §3 label map
│ ▌                                                  │
│ ▌  [Send to client]                                │  <- §4 verb
└────────────────────────────────────────────────────┘
```

### Card after v1.0 (full set including J, B, the contextual CTAs)

```
QEP — 5 open decisions
─────────────────────────────────────────────────────

┌────────────────────────────────────────────────────┐
│ Source-required SKUs                        [6d]   │  <- short title (§8)
│ When a rep hits source-required on equipme…        │  <- gist line
│ AI will draft options on send.                     │
│ Open · Client                                      │
│                                       [Send →]     │  <- right-aligned CTA
└────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────┐
│ Stale stock reconciliation                  [4d]   │
│ How should we handle inventory deltas …            │
│ AI will draft options on send.                     │
│ Sent · To Rylee + Ryan, 6h ago                     │  <- "with client" state
│                              [Resend]  [Nudge]     │
└────────────────────────────────────────────────────┘

...(3 more)...

─── With client (2) ────────────────────────────────  <- collapsed strip
─── Recently answered (3) ──────────────────────────
```

### Status-group filter (Rec F, v1.0 only)

```
Status:  ● Needs you (3)   ○ With client (2)   ○ Needs review   ○ Snoozed   ○ All
```

(Counts in parens so the operator sees at-a-glance the queue size of each group.)

---

# 14. Concrete copy strings (cheat sheet for the implementer)

**State pill labels (replaces `state.replace(/_/g, ' ')`):**

```
unrouted                  → Open
routed                    → Sent
link_clicked              → Viewed
awaiting_operator_confirm → Needs review
answered                  → Answered
expired                   → Expired
paused                    → Paused
snoozed                   → Snoozed
```

**Card CTA verbs (replaces "Route to recipients"):**

```
owner=client    + state=unrouted                  → "Send to client"
owner=client    + state=routed                    → "Resend"
owner=client    + state=link_clicked              → "Nudge to confirm"
owner=client    + state=awaiting_operator_confirm → "Review reply"
owner=operator                                    → "Answer"
owner=unknown   (any state)                       → "Triage"
```

**Options-empty fallback (replaces "No enumerated options returned."):**

```
owner=client    → "AI will draft options on send."
owner=operator  → "Free-form — answer in your own words."
owner=unknown   → "Assign an owner to continue."
```

**Modal copy (in `DecisionRouteModal.tsx`):**

```
eyebrow: "Reviewing AI-rewritten decision email"  →  "Review before sending"
h2:      "Route to recipients"                    →  "Send to client"
primary: "Send as-is"                             →  keep as-is (correct)
```

**Filter strip (Rec F, v1.0):**

```
Owner:  All | Operator | Client | Needs triage         (keep "Operator", §12 revision)
Status: Needs you | With client | Needs review | Snoozed | All
Age:    All | 0–2d | 3–7d | 8d+
```

**Hero metric tile (today: "CLIENT / UNKNOWN  5 / 5"):**

```
Today's value:  `${clientCount} / ${unknownCount}`   reads as a ratio (confusing)
Recommended:    Split into two metric tiles: "Client owned: 5" and "Needs triage: 0"
                — OR a single "Client owned: 5 (5 unassigned)" with the second number
                  parenthetical, only shown when > 0.
```

---

## 15. References

- `web/src/Decisions.tsx:258` — risk chip render site (drop in §1)
- `web/src/Decisions.tsx:259` — options empty copy (replace per §7)
- `web/src/Decisions.tsx:265` — "Route to recipients" string (rename per §4)
- `web/src/Decisions.tsx:380-383` — `riskClass()` fallback to `'authorize'` (root cause of §1)
- `web/src/Decisions.tsx:140-142` — hero metric tile composing `${clientCount} / ${unknownCount}` (split per §14)
- `web/src/Decisions.tsx:257` — decision-state-badge render with `state.replace(/_/g, ' ')` (replace per §3)
- `web/src/DecisionRouteModal.tsx:144-147` — modal head copy (rename per §4)
- `web/src/DecisionRouteModal.tsx:195` — "Send as-is" primary (keep)
- `web/src/lib.ts:1994-2003` — `decisionOwnerKind` (informs §5 "needs triage" collapse)
- `web/src/index.css:409-410` — decisions surface CSS (mobile breakpoint per §9)
- `supabase/functions/cc-rewrite-decision/index.ts:53-54` — empty-options intent (§7)
- `docs/COMMAND_CENTER_MASTER_PLAN.md:689-715` — Bible §5.2.1 + §5.2.2
- `docs/COMMAND_CENTER_MASTER_PLAN.md:791-793` — Bible §5.6 (register, not answering surface)
- `docs/designs/PHASE_5_UX_RECON.md:162-172` — Phase 5 state badge spec

---

*— JARVIS, 2026-05-23*
