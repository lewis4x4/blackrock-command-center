
# Blocked Work — Operator Resolution Surface (UX Design)

**Compiled:** 2026-05-23 · **Author:** UX angle (sibling agents are concurrently producing Data/Contracts, Architecture-fit, and CEO-priority reports)
**Scope:** The operator-facing surface that turns "47 blocked work items" on the QEP OS card into a closable list. Mobile-first. No schema redesign, no phase reordering — those are other agents' lanes.
**References:**
- `docs/COMMAND_CENTER_MASTER_PLAN.md` §1, §3, §5.1, §5.2.4, §5.3, §5.8, §8.9 — the Bible
- `web/src/AppDetail.tsx` — current cockpit shell (`HealthHeader`, `RoadmapBoard`)
- `web/src/Home.tsx` — `TriageBand`, `ProjectsBand`, `Cell` barometer cells
- `web/src/TriagePanels.tsx` — existing `ReviewBlockersPanel` (partial)
- `web/src/lib.ts` — `IssueType='blocked_item'`, `IssueAction`, `loadAppDetailSection('roadmap')`
- `supabase/migrations/002_register_qep_app.sql:50` — `ship_state` enum confirming `blocked` ≠ `pending_decision`

---

## 0. The frame in one sentence

> 47 blocked items is not 47 problems — it is **four classes of friction** wearing the same word. The job of this surface is to (a) split them into the four classes the Bible already names, (b) give each class a one-tap action that doesn't dump Brian into Linear, and (c) make the count fall in front of his eyes.

---

## 1. Context — what the 47 actually are

### 1.1 How the data shape works today

- `registry_app_snapshots.roadmap_counts.blocked` = **47** (an aggregate count, not a list).
- `cc_issues` carries **one** aggregate `blocked_item` row per app (issue grain is `aggregate` per migration 010, not `item`). That single row drives the home triage band and the count metric in `HealthHeader`.
- The 47 individual rows live one network hop away in QEP's `cc_export_detail('roadmap')` payload — each row is a roadmap task with `status='blocked'` and a loose, free-text `blocker` / `blocked_reason` field (see `DEMO_APP_DETAIL.roadmap.items[1]` in `lib.ts:409` for the canonical shape).
- `pending_decision` (the 6) is a **separate** ship_state. The 6 do not unblock the 47 by definition — but a known fraction of the 47 are blocked *because they're waiting on a decision* (the Bible §5.2.4 names this as the first of four blocker reasons).

### 1.2 What exists today on the operator side

| Surface | What it shows | What's missing |
|---|---|---|
| `HealthHeader` (`AppDetail.tsx:73`) | `blocked` as a red tone metric | No drilldown |
| `RoadmapBoard` (`AppDetail.tsx:113`) | All roadmap items grouped by stream, generic `DetailCard` | No filter, no action, blocked items lost in the noise |
| `ReviewBlockersPanel` (`TriagePanels.tsx:194`) | Slide-over with a "Blocked items" list, `Dismiss` button, and a free-text "Decision ref" input → `link_to_decision` | No reason grouping, no Supply Input, no Mark Resolved, no per-row owner ask, no snooze, no progress signal |
| Home triage band | One row: "8 items blocked on Circle of Life" / "X items blocked on QEP" | Aggregate only; tapping it opens `ReviewBlockersPanel` against the aggregate issue |

### 1.3 What the Bible already locks down (§5.2.4)

> "Blocked items grouped by reason — *awaiting a decision*, *missing input*, *behind another task*, *blocked externally*. A banner when any are decision-blocked: *'{K} of these clear the moment you answer the open decisions.'* Missing-input cards offer a typed/enumerated `SupplyInputForm` (never a free-text instruction box); awaiting-decision cards offer **Link to a decision** and a jump straight to the Open Decisions panel."

So the four classes are spec'd. The unknowns the Bible leaves open — and what this report decides — are: where the surface lives, what the row looks like, what the minimum action set is, how grouping/filtering work, what states cover empty/loading/error, and what stops Brian feeling crushed by a 47.

---

## 2. Design principles (carried, not re-litigated)

| Principle | Source | What it forces |
|---|---|---|
| Resolve in place; never navigate to fix | Bible §1.3 (rule 1) | Slide-over over the surface that showed the count. No `/blocked` route. |
| Honesty over polish | Bible §1.3 (rule 4), §5.8 | A blocker whose reason we can't classify is shown as "Unclassified" in plain words, not silently hidden or auto-bucketed. |
| Phone-clearable in 15 sec | Bible §1.2, §7 | The default action on every row must be reachable one-thumb on a 380px viewport. No required text input on the primary path. |
| Enumerated input only — never agent-readable free text | Bible §3.4 | Supply Input is typed/enumerated; the "rationale" field is provenance, never instructions. |
| Linear stays system of record | Bible §5.3 | This surface never claims to *change* a task's state. It records resolutions on the Command Center side and lets Linear catch up. The one exception — flipping a task state via `cc_apply_task_state()` — is one-press-confirmed and explicitly the §8.6 highest-risk write. We do not introduce a new place for it here. |
| Earned-calm empty state | Bible §5.8 | "0 blocked" is a celebration moment, not a blank rectangle. |

---

## 3. Where it lives — Home and Cockpit, with different jobs

**Both.** They share the same row component and slide-over body, but the **density** and the **default group** differ.

### 3.1 Home — Triage barometer cell + slide-over (the phone path)

The Bible §5.1 already specs a "Blocked" cell in the triage barometer:

> "Six tappable cells, each filters the triage band: Needs you · Critical · Decisions open · **Blocked** · Awaiting review · Oldest."

Today `Home.tsx` renders a static `Blocked: 47` value in the portfolio strip (line 158: `<Cell k="Blocked" v={String(blocked)} cls={blocked ? 'red' : ''} />`). Make this **tappable** — tapping it opens the **portfolio-wide Blocked Work slide-over**:

```
┌─────────────────────────────────────────┐
│ Blocked work · 47 across QEP, SCC, COL  │ ← title bar
│ "Most of these don't need much."        │ ← subtitle (calibration copy)
│                                         │
│ ┌─ REASONS ────────────────────────┐    │
│ │ Awaiting a decision        15 →  │    │ ← grouped by reason; count → toggle
│ │ Missing input              12 →  │    │
│ │ Behind another task        14 →  │    │
│ │ Blocked externally          5 →  │    │
│ │ Unclassified                1 →  │    │
│ └──────────────────────────────────┘    │
│                                         │
│ ▸ filter: All apps ▾  · Sort: Oldest ▾  │
│                                         │
│ <RBlock rows…>                          │ ← collapsible per-reason rows
│                                         │
└─────────────────────────────────────────┘
```

The portfolio-wide entry point matters because Brian's mental model of the home is *"what's wearing me down right now"*, not *"open QEP, then look."* The Bible §5.1 already grants this — we are just wiring the cell.

### 3.2 Cockpit — first-class band, not a slide-over (the desk path)

When Brian is *already* in `/apps/QEP` because he has 47 minutes and a coffee, the slide-over is the wrong shape. A new **Band F — Blocked work** sits in `AppDetail.tsx` between the existing `RoadmapBoard` and `DecisionQueue`. Same row component, same actions, but rendered inline with more density (no slide-over chrome wasting horizontal space).

This matters for two reasons:
1. The Bible §5.3 explicitly carves the cockpit as the place to *act on one app*. A drilldown that requires a slide-over inside the cockpit would re-introduce the "navigate-to-fix" anti-pattern.
2. The desk pass is where the long tail dies. The phone pass kills the top-of-list; the desk pass kills the bottom thirty.

**Note for the Architecture sibling:** the existing `RoadmapBoard` should keep its read-reflective grouping by stream (Bible §5.3 — it mirrors Linear). The new Blocked band groups by **reason**, not stream. They are different views of overlapping rows and that overlap is fine — the user is the index.

### 3.3 Why not Home only?

The home slide-over is the **fast path**; the cockpit band is the **deep path**. Either alone is wrong:

- **Home only** = every 47-clearing session begins with a portfolio sheet that's overkill when Brian only wants to look at QEP.
- **Cockpit only** = the home count is a dead stat with no entry point, violating Bible §5.1's tappable barometer.

---

## 4. The row — anatomy, copy, density

One row component, three density modes (compact / standard / cockpit-wide).

### 4.1 Standard row (home slide-over default)

```
┌──────────────────────────────────────────────────────────┐
│ [QEP] Quote approval guardrails                          │
│       Stream B · Wave 2 · 6d old                         │
│       ⊝ Blocked: Needs dealer policy answer              │ ← italicized blocker reason, plain words
│                                                          │
│       [ Link to decision ▾ ]  [ ⋯ ]                      │ ← primary action + overflow
└──────────────────────────────────────────────────────────┘
```

**Component slots, top-to-bottom, left-to-right:**

| Slot | Source | Style |
|---|---|---|
| App badge | `app.short_code[0]`, `colorFor()` | 24px square, existing token |
| Title | `row.title` or `row.name` | `Body 14/600`, single line, ellipsize |
| Context line | `row.stream · row.wave · age_days` (humanized) | `Meta 12`, `--text-2`, single line |
| Blocker line | `row.blocker` / `row.blocked_reason` (free text from QEP) | `Body-sm 13`, `--text-2`, italic, **2-line clamp** with hover/tap-expand |
| Reason chip | derived (see §5) | small pill, color per reason (see §6) |
| Primary action | derived from reason class | `act-btn` style (matches existing TriageRow primary) |
| Overflow `⋯` | menu of secondary actions | borrow from existing `external-link` button style |

**Mobile collapses to two lines** (title + reason chip + action), with the context+blocker lines moving behind a tap-to-expand chevron. Acceptance: a row must fit in 96px of vertical space on a 380px viewport, including a 44px primary action target.

### 4.2 Cockpit-band row (Band F)

Same DOM, two columns wider: the blocker line never clamps, and the reason chip + age sit on the right edge so the eye scans down the left for titles and down the right for "how stuck."

### 4.3 Copy register (calibration, not policy)

- **Blocker line prefix:** "Blocked:" (not "Why:", not "Reason:") — matches the existing `Blocker` shape the QEP exporter already uses.
- **Reason chip label:** "Decision needed" / "Input needed" / "Behind task" / "External" / "Unclassified" — 1–2 words, sentence case, no jargon.
- **Subtitle on portfolio-wide sheet:** *"Most of these don't need much."* This is the calibration copy that prevents the 47 from feeling like 47 emergencies. Mitigates Bible §8.9 (operator-handoff-getting-ignored) at the count level.

---

## 5. Reason classification — how a row gets its class

Browser-side derivation (no backend change). Falls through in order; first hit wins. Lives in a new `lib.ts` helper, `blockerReasonOf(row)`.

| Order | Class | Detection | Primary action |
|---|---|---|---|
| 1 | **Decision needed** | `row.blocked_by_decision` truthy, or `row.blocker` matches `/decis|approv|sign[- ]?off|policy|owner/i`, or `cross-link to a `cc_issues.open_decision` exists for the same `app_id` | **Link to decision** (existing `link_to_decision` action, picker UI instead of free-text input) |
| 2 | **Input needed** | `row.blocker` matches `/input|missing|need|provide|supply|credential|secret/i`, or `row.required_input` is non-empty | **Supply input** (Phase 2 — typed/enumerated form; v0.5 fallback: **Convert to decision**) |
| 3 | **Behind task** | `row.blocked_by` references another task id, or matches `/wait|after|depends|behind|block(ed)? by/i` | **Open blocking task** (deep link to the cockpit RoadmapBoard with that task highlighted) |
| 4 | **External** | `row.blocker` matches `/oem|vendor|3rd|third[- ]?party|customer|client|portal/i`, or `row.owner_kind === 'external'` | **Ask owner** (composes a decision-style email via the existing `DecisionRouteModal` pattern, scoped to "Why is this still blocked?") |
| 5 | **Unclassified** | Default | **Convert to decision** (creates a new `open_decision` issue from this blocker, then opens the decision panel pre-populated) |

**The order is deliberate.** Decision-blocked is first because it has the highest payoff per click (one decision answer cascades into N task unblocks per Bible §5.2.4's banner). Unclassified is last, not first, because we want the operator to land on classified rows by default; the surface should never confess "I don't know" before it has tried.

**Honesty rule:** Bible §1.3 rule 4 means we must not silently default-bucket. The Unclassified count is *visible* in the reason group bar (§3.1), and clicking it shows those rows with the raw `blocker` text uncensored.

---

## 6. Quick actions — minimum viable set and full set

The user's question listed: **Convert to decision, Mark resolved, Ask owner, Snooze, Reassign**. My recommendation:

### 6.1 Minimum viable set (v0.5, ship in days)

Three actions cover ~90% of the 47:

1. **Link to decision** — exists on the backend today (`link_to_decision` action). Replace the free-text input in `ReviewBlockersPanel` with a **picker** populated from `cc_export_detail('decisions')` open rows for the same app. This single change unlocks the "Decision needed" class without a migration.
2. **Mark resolved** — alias for the existing `dismiss` action with a new event_type label (`blocker_resolved` instead of `issue_dismissed`) so Lately reads "You cleared a blocker on QEP" instead of "Dismissed". Backend cost: ~10 LOC in `cc-answer-issue/index.ts` to switch the audit label when payload carries `resolution_kind:'resolved'`. **No new RPC.**
3. **Snooze (24h / 7d / next snapshot)** — adds two columns to `cc_issues` (`snoozed_until timestamptz`, `snoozed_reason text`) — already precedented in `lib.ts:1850` for decisions (`row.snoozed_until`). Hide snoozed rows from the default count; show them under a "Snoozed (N)" subgroup. Critical for the 47→0 psychology: the operator must be able to say "not now" without lying.

That's the v0.5 contract. The other actions in the list either already exist in different clothes or can wait for v1.

### 6.2 Full v1 set (after F2 ships the `cc_apply_*` proxy)

In order of operator value, with rationale:

| # | Action | When it shows | Backend cost |
|---|---|---|---|
| 1 | **Link to decision** | Decision-needed rows; any row | already there (v0.5) |
| 2 | **Convert to decision** | Unclassified, Input-needed | New RPC `cc_create_decision_from_blocker` that writes a `cc_issues` row with `issue_type='open_decision'`, copies the title/blocker as the decision title, and back-references via `context.from_blocker_issue_id`. Opens the Open Decisions panel pre-focused. |
| 3 | **Mark resolved** | Any row | already there (v0.5) |
| 4 | **Snooze 24h / 7d / next snapshot** | Any row | v0.5 |
| 5 | **Supply input** (typed/enumerated) | Input-needed rows | F2 — depends on the `cockpit-writeback` proxy and `cc_apply_blocker_resolution()` (Bible §4.10). Composes a work order. |
| 6 | **Ask owner** | External, Decision-needed with `owner_kind='client'` | Reuses the existing `DecisionRouteModal` (`web/src/DecisionRouteModal.tsx`). Backend: `cc_decision_email_sends` exists / arrives in F5. |
| 7 | **Open blocking task** | Behind-task rows | Pure frontend deep-link to `/apps/:code?task=:id` (depends on `react-router` from F1). |
| 8 | **Reassign** | Any row with an owner | **Deliberately deferred.** Brian is the only operator. Reassignment is a multi-operator concern that adds a column (`assigned_to`) for zero present value. Add when a second operator joins. |

**Order on the row UI:**
- Primary action: the reason's recommended action from §5 (single button)
- Overflow `⋯` menu (in this order): Mark resolved · Snooze ▸ · Convert to decision · (Reassign — when shipped)

The primary button rotation prevents the "everything is a hammer" failure mode where the operator clicks the same word ("Resolve") on 47 rows and stops reading the rows.

### 6.3 What I'm choosing not to ship

- **Reassign** — see §6.2 #8.
- **Edit blocker text** — the blocker text comes from QEP's roadmap doc. Editing it on the Command Center side would create a divergent record from Linear (Bible §5.3 — Linear wins). If the blocker text is wrong, fix it in Linear; the next snapshot reconciles.
- **Bulk select** — tempting for 47 rows. Skipping it for v0.5 because the 47 is mostly heterogeneous; bulk-resolving rarely matches the operator's actual intent. Revisit if real usage shows the same primary action on 5+ rows in a sitting. (See §10 — the metric to watch.)
- **Auto-classify with LLM** — the Bible's §3.4 rule against agent-readable free-text-as-instruction implicitly extends here: an LLM classifier becomes load-bearing, and a wrong class routes to the wrong action. Heuristic regex (§5) is honest about its uncertainty (Unclassified bucket); an LLM would project false confidence.

---

## 7. Grouping & filtering

### 7.1 Group spine: by reason (default), then by app

The reason groups (§5) are the spine because they map 1:1 to the action a row affords. Grouping by stream or by app first puts the operator into the wrong frame ("what part of the build is broken?" instead of "what action moves the most tasks?").

```
┌─ Awaiting a decision (15) ───────────────────────────┐
│ ▸ "5 of these clear the moment you answer the open  │
│    QEP decisions →" — banner, tap to open Decisions  │
│ [ row ]  [ row ]  [ row ]                            │
│ [ Show 12 more ▾ ]                                   │
└──────────────────────────────────────────────────────┘
```

### 7.2 Filter controls (above the groups, single row, mobile-friendly)

1. **App** — pill dropdown, default "All apps" on home, locked to the current app in cockpit band.
2. **Sort** — pill dropdown: **Oldest** (default), **Newest**, **By stream**. Default Oldest because age is the single best proxy for "is this rotting?" — and the Bible §5.1 already uses age as the honesty signal in the barometer.
3. **Show snoozed** — toggle, default OFF.

**No filter for "reason"** — that's the group spine itself; collapse the group instead of filter it out.

### 7.3 Age presentation

`age_days` becomes a short token: `2d`, `8d`, `3w`, `2mo`. Rows ≥30d get a red `Meta 12` color; ≥60d get a small "Aging" chip. This is the only escalation mechanism in the default view, and it's how stale blockers earn attention without nagging.

---

## 8. Integration with the existing slide-over pattern

### 8.1 Refactor target: `TriagePanels.tsx`

The existing `ReviewBlockersPanel` becomes two things:

1. **`AppBlockersPanel`** — the per-app slide-over opened from the home triage band on a `blocked_item` issue, or from a tap on the Blocked metric in the `HealthHeader`. Same body as today + reason grouping + the new row component.
2. **`PortfolioBlockersPanel`** — the portfolio-wide slide-over opened from the home barometer cell. Adds an App filter, otherwise identical body.

Both reuse:
- `SlideOver` frame (`web/src/SlideOver.tsx`) — title/subtitle/footer/onClose
- `usePanelSection(appId, demo, 'roadmap')` (for `AppBlockersPanel`) — already in `TriagePanels.tsx:285`
- A new `usePortfolioBlockers(apps, demo)` (for `PortfolioBlockersPanel`) — fan-out parallel `loadAppDetailSection(appId, demo, 'roadmap')` per active app, merge with `app_id` injected per row, filter to `isBlockedRow`

### 8.2 Footer actions

The existing footer for `ReviewBlockersPanel` is "Close · Dismiss · Link to decision." Replace with **Close · Mark all snoozed (7d)** — the bulk-snooze escape hatch is the only honest "I can't deal with this now" path. Per-row actions stay on the row.

### 8.3 Cockpit band

Insert **Band F — Blocked work** in `AppDetail.tsx`, right after `<RoadmapBoard>` and before `<DecisionQueue>`. Same `DetailSection` shell as the existing bands. Loads from the same `loadAppCockpitDetail()` payload that `AppDetail.tsx:25` already fetches (no extra request).

```tsx
<RoadmapBoard items={detail.roadmap.items} … />
<BlockedWorkBand items={detail.roadmap.items.filter(isBlockedRow)} loading={…} available={…} />
<DecisionQueue items={detail.decisions.items} … />
```

No new route. No new top nav. No new edge function for v0.5.

### 8.4 URL addressability (after F1 ships `react-router`)

- Home barometer cell → `/?blocked=all`
- Home triage row for `blocked_item` → `/?issue=:id` (already spec'd in Bible §5.2)
- Cockpit Blocked band → `/apps/QEP#blocked` (scroll anchor, no new route)

Each is share-able / Telegram-deeplink-friendly per Bible §5.2.

---

## 9. States — empty / loading / error / partial / done

| State | Trigger | Copy & behavior |
|---|---|---|
| **Skeleton** | Initial load | 3 ghost rows; never a bare spinner (Bible §5.8) |
| **Empty (earned)** | `blocked === 0` portfolio-wide | Big green tick. *"Nothing's blocked. Everything's moving."* No CTA — celebration, not a next step. |
| **Empty (per-class)** | A reason group has 0 rows | Collapse the group header instead of rendering it empty. Honesty: count is "0", group is hidden. |
| **Loading-inline** | Slide-over body loads after header | Header instant (`HealthHeader`-style); body skeleton (matches Bible §5.2.7) |
| **Error** | `cc_export_detail` fails / app unreachable | Body: *"Couldn't read {APP}'s blockers — the snapshot key isn't responding. Try again or check Settings → Secrets."* + Retry button. Header still shows the aggregate count from the snapshot — Bible §5.2.7 says the slide-over header is the **aggregate truth** and only the body errors. |
| **Stale** | `last_seen_at` > 12 min old | Amber "data may be stale — recheck" tag at the top of the panel (Bible §5.2.7). |
| **Mid-workflow** | A row has been resolved/snoozed in the current session | The row collapses with an undo: *"Cleared. Undo"* — 6-second window. Mirrors how Lately treats `issue_resolved`. |
| **Partial app failure** | Portfolio panel, one app unreachable | Show its rows as a greyed-out group with a small *"SCC unreachable — its blockers will load when its snapshot recovers"* footer. Never silently drop. |

**Error copy register** (carry forward to `lib.ts` and the panel):
- *"Couldn't reach {APP}."* (not "Error 500", not "Network failure")
- *"This blocker has no classifiable reason yet — that's why it's in Unclassified."* (for tooltip on the chip)
- *"Already resolved on QEP's side."* (for a row that reconciled away mid-session)

---

## 10. "47 → 0" psychology — the count must move under his hand

This is the section the user explicitly asked for. The Bible §1.2 frames the product as a loop, not a dashboard; this surface is where that framing earns or loses its rent.

### 10.1 Make every tap visibly subtract

Each completed action triggers a **count animation** on the count chip (47 → 46), a **row collapse** with a 6-second undo window, and a **soft success tick** in the lower-right (a single `✓ Cleared` toast that fades — never a modal confirmation). The aggregate `blocked` metric in `HealthHeader` and the Home strip update **optimistically** on the same tick, before the backend roundtrip completes. If the backend rejects, revert with an inline note: *"That blocker didn't clear — it's still active."*

### 10.2 The progress watermark

At the top of the panel, a thin progress bar shows session progress against starting count:

```
This session: 6 cleared · 41 remaining ──────────●─────────
```

Disappears at 0. Resets per panel open. **Does not** track cross-session progress because a) the snapshot reconciler will move the number around independently and b) cross-session counters become unhealthy targets ("I cleared 12 today" → "I should clear 12 today").

### 10.3 Anti-fatigue: the calibration subtitle and the "Show 12 more"

- The subtitle on the portfolio sheet (*"Most of these don't need much."*) is calibration copy — it tells the operator the 47 is not 47 emergencies, before they look at the rows. It is the single most important string on this surface.
- Each reason group shows the first 3 rows and a **"Show 12 more ▾"** affordance. This caps the visible-row density at any one time, prevents the surface from feeling like an inbox, and gives the operator a natural stopping point ("I did the top of each pile").
- The 60d+ "Aging" chip is the **only** color escalation. No badge stacking, no exclamation marks, no flame emojis. Honesty is the antidote to fatigue.

### 10.4 The 0-state is a moment

When the count hits 0 — for an app or for the portfolio — the panel doesn't close itself. It transitions to a one-line earned-calm state:

> *"Nothing's blocked on QEP. Everything that was here is either resolved, snoozed, or routed."*

…and the home strip's `Blocked` cell turns green. This is the only place in the entire Command Center where a count cell goes from red to green; that scarcity is the celebration mechanic. (The Bible §7's severity language reserves green for "actually good" — earning it here matters.)

### 10.5 Notifications: never push a blocker count

A push notification for "you have 47 blocked items" would re-introduce the exact dashboard-feel the Bible §1.2 rejects. Blocked counts are **pull-only**. Push notifications are reserved for `cc_issues.severity='critical'` events that already qualify under Bible §8.8 — and a blocked item is rarely critical without an associated decision/build event that already pushes.

---

## 11. Acceptance criteria

A v0.5 ship clears all of these:

1. The home `Blocked` strip cell is tappable and opens the `PortfolioBlockersPanel` over the home.
2. The home triage row for `blocked_item` opens the `AppBlockersPanel` (refactor of `ReviewBlockersPanel`) — same as today, body restructured by reason group.
3. The cockpit (`/apps/QEP`) renders a new **Blocked work** band between `RoadmapBoard` and `DecisionQueue` with the same row component.
4. Every blocker row classifies into one of five reasons (incl. Unclassified). The classification is visible as a chip and the reason group is the spine of the list.
5. The "Awaiting a decision" group shows the banner *"K of these clear the moment you answer the open decisions →"* with K = count of decision-needed rows. Tapping the banner opens the Open Decisions panel for that app.
6. Three actions work end-to-end against the existing backend:
   - **Link to decision** with a picker (no free-text input) — calls `answerIssue(issueId, 'link_to_decision', { linked_decision_ref })` and visibly removes the row.
   - **Mark resolved** — calls `answerIssue(issueId, 'dismiss', { rationale, resolution_kind: 'resolved' })` and emits `blocker_resolved` for Lately (one-line backend tweak).
   - **Snooze (24h/7d/next snapshot)** — calls a new `cc-snooze-issue` edge function (mirrors existing `cc-snooze-decision`).
7. On Mark resolved / Link / Snooze, the row collapses with a 6-second Undo, the `HealthHeader` blocked metric and the Home `Blocked` cell update optimistically.
8. Every row meets the 96px mobile target with a 44px primary tap target.
9. Empty state: `blocked === 0` for an app shows the earned-calm one-liner; the portfolio panel shows it portfolio-wide.
10. Error state: `loadAppDetailSection` failure renders an inline error inside the panel body without blanking the header count.
11. No new free-text input drives any agent or work-order field. The "Convert to decision" v1 action assembles a `cc_issues` row with enumerated metadata only; the original `blocker` text is provenance, not instruction.
12. Linear is never written to from this surface in v0.5. Task-state changes are explicitly out of scope.

---

## 12. Did I push this? Is this the best way?

**Required self-critique gate. I steelmanned the opposite, named the biggest risk, and confirmed (with one revision) the design above.**

### 12.1 Steelman: don't build this — force blockers to be filed as decisions upstream

The opposite take: *"A blocker that has no enumerated resolution path is a decision that hasn't been filed yet. Don't build a Blocked Work surface — make the QEP planner file decisions for everything that needs an answer, and let the existing Decisions panel do the work."*

This is genuinely the cleaner architecture. It collapses two concepts (decisions and blockers) into one (decisions). The Bible §5.2.4's four-reason taxonomy is partly an admission that "blocker" was always a category mistake: three of the four classes (decision-needed, input-needed, external) are *just decisions wearing different hats*; only "behind-another-task" is a true dependency.

**Why I didn't take this.** Three reasons:

1. **It cedes the field for months.** Re-filing the 47 as 47 decisions is itself a 47-task workflow, and the person who would do it is Brian. The current shape exists *because* it's lower-friction to write `Blocked: needs dealer policy answer` into a Linear ticket than to compose an enumerated decision card. Asking the planner to upgrade discipline before the tool exists is the same pattern as asking the operator to clear blockers without a surface — it solves the abstraction at the cost of the work.
2. **Linear is the system of record (§5.3).** The Command Center cannot *require* a particular ticket discipline from Linear without breaking the federated boundary. Even if Brian adopted "no blocker, only decision" personally, QEP's exporter can't enforce it on inbound tickets from clients or contractors.
3. **The four-reason grouping is a free path to converging on the steelman.** With the "Convert to decision" action in §6.2, the act of resolving a blocker from the Command Center side naturally upgrades it to a decision in the data model. Over time, the Unclassified bucket should shrink and the "Decision needed" bucket should absorb most of the rest — this is the steelman, but reached gradually instead of by mandate. The surface is the on-ramp.

The steelman would be right if Brian had a planning team upstream of him. He doesn't.

### 12.2 The single biggest risk of my design — and the mitigation

**Risk: the reason classifier is a regex.** Section 5's heuristic will get classes wrong. A row miscategorized as "External" when it's really "Decision needed" will get a "Route to owner" button when it should have a "Link to decision" button, and the operator will tap the wrong action on autopilot.

Worst case: a blocker that needed Brian's own decision gets emailed to a QEP contact, who sees a confusing message about a thing they don't own. Trust in the surface erodes from one bad tap.

**Mitigation:**

1. **The chip is always tap-to-reclassify.** Every reason chip on every row is a button that opens a 5-item picker. The classification is a default, not a verdict. The picker action writes nothing structural — it just changes the primary action on this row in this session.
2. **The Unclassified bucket is honest.** Rows the regex isn't confident about land in Unclassified rather than the wrong class. A row whose `blocker` matches *two* regex patterns also lands in Unclassified (we deliberately do not "tiebreak" — that's where false confidence comes from). Acceptance check: the v0.5 ship rate of "Unclassified" should be **measurable** — if it's <5% on real QEP data, the regex is over-confident and we need to widen Unclassified. If it's >25%, the regex is under-tuned and we ship anyway, because Unclassified is genuinely the most honest answer.
3. **"Ask owner" specifically gates on owner data.** The "External" → "Ask owner" pairing only renders the button when `row.owner_email` is non-empty *and* the owner is not Brian. Otherwise the row falls back to "Mark resolved / Convert to decision." This kills the worst-case scenario above by construction.
4. **No outbound email without confirm.** The "Ask owner" action opens the `DecisionRouteModal` (existing component) — it does not send. Brian still reviews and presses send. Same model as the existing decision routing.

### 12.3 What I'd cut to ship v0.5 in days, not weeks

The v0.5 checklist:

| Keep | Cut to v1 |
|---|---|
| Reason grouping (regex classifier) | Tap-to-reclassify chip — show class but don't allow override yet |
| Three actions: Link to decision (picker), Mark resolved, Snooze | Convert to decision, Supply input, Ask owner, Open blocking task |
| Home barometer cell tap → portfolio panel | URL addressability (`?blocked=all`) — relies on F1 router |
| Cockpit Band F | Optimistic count updates — fall back to refetch on action |
| Row collapse + count animation | Undo window — 6s undo can wait for v1 |
| Empty earned-calm state | Session progress watermark |
| Inline error in body, header keeps aggregate | Partial app failure handling in portfolio panel — v0.5 fails the whole panel, fine for one-app reality today |

What this gets you: a real Blocked Work surface built almost entirely from existing components and existing backend, plus one tiny new edge function (`cc-snooze-issue` cloned from `cc-snooze-decision`) and one column add (`cc_issues.snoozed_until`). Frontend: refactor `ReviewBlockersPanel` into `AppBlockersPanel`, add `PortfolioBlockersPanel`, add the `BlockedWorkBand` to `AppDetail.tsx`, add `blockerReasonOf()` to `lib.ts`. Estimate: **1–2 days of focused work**, with backend bits parallelizable.

### 12.4 Confirm or revise

**Confirmed, with one revision:**

The original draft had the home barometer cell opening the portfolio panel as the only home entry point. On critique I added the explicit refactor of the existing home triage row's `ReviewBlockersPanel` into `AppBlockersPanel` (§8.1) — because today's triage band already shows "X items blocked on App Y" and that row is a separate, valid entry point. Both entry points share the row component but differ in scope (portfolio vs. one app). This keeps the existing triage flow intact while adding the portfolio-wide aggregation the strip cell needs.

Everything else in §1–§11 stands.

---

## 13. Hand-offs to sibling agents

- **Data/Contracts sibling:** the only schema asks from this report are (a) optional `cc_issues.snoozed_until + snoozed_reason` columns mirroring the decision precedent, and (b) confirmation that `cc-answer-issue` can take an additional `resolution_kind: 'resolved'` payload field that just relabels the audit event. No new RPCs required for v0.5. The "Convert to decision" v1 action does want a new RPC — please scope `cc_create_decision_from_blocker(p_issue_id, p_app_id, p_title)`.
- **Architecture-fit sibling:** the placement question — Home slide-over **and** Cockpit band — is the UX answer; please pressure-test against the Phase F1 / F2 sequencing in Bible §9. My read: v0.5 is a pure F1 surface (no `cc_apply_*` writes), so it ships in F1 alongside the router and the lifecycle chip. The "Supply input" v1 action is the only piece that hard-depends on F2's `cockpit-writeback`.
- **CEO-priority sibling:** the only strategic question this report leaves for you is whether the visible "47" today is actively load-bearing (i.e., is Brian's mental model anchored to that exact number?) — if yes, the optimistic count update in §10.1 needs a watchdog so reconciler-driven changes don't feel like the system is "hiding" work. If the answer is "no — 47 is just where today landed," the watchdog is unnecessary.

---

## 14. The single sentence

> **The 47 is one number wearing four reasons. Surface the reasons, give each one a single tap, and let the count fall in front of him.**
