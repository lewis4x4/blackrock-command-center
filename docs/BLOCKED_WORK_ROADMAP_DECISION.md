# Blocked Work — Roadmap Decision

**Compiled:** 2026-05-23 by the CEO co-pilot, synthesizing four parallel design panels (UX, Data/Contracts, Architecture-fit, CEO-priority).
**Source reports:**
- `docs/designs/BLOCKED_WORK_RESOLUTION_UX.md`
- `docs/designs/QEP_BLOCKED_WORK_DATA_CONTRACTS.md`
- `docs/designs/BLOCKED_WORK_ARCHITECTURE_FIT.md`
- `docs/designs/CEO_PRIORITY_47_BLOCKERS_VS_PHASE5.md`
**Verdict:** **AMEND** `docs/COMMAND_CENTER_MASTER_PLAN.md` (the Bible). Do **NOT** fork a separate roadmap. Gate the build behind a 60-minute manual triage. Defer one section of the Bible (F4 earned-autonomy) to make room.

---

## 0. What the panel was asked

The QEP OS card shows **47 blocked work items** alongside **6 open decisions**. Do the 6 unblock the 47? If not, what does — and how do we surface it inside the app? Brian's directive: either update the Bible to reflect the answer, or stand it up as a separate parallel build.

## 1. The single sentence

> The 6 decisions do not unblock the 47, the 47 is one number wearing four reasons, and the Bible already half-specs the surface that resolves them — **so we amend the Bible, gate the build behind a 60-minute manual triage, and defer F4's earned-autonomy machinery to make the room.**

---

## 2. The four agents' verdicts in one line each

| Lane | Verdict |
|---|---|
| **UX** | Build the surface — five reason classes, three v0.5 actions (Link to decision · Mark resolved · Snooze), Home barometer cell + Cockpit Band F. Optimistic count, calibration copy *"Most of these don't need much,"* earned-calm 0-state. v0.5 = **1–2 days frontend.** |
| **Data / Contracts** | Per-task `cc_issues` rows + 2 RPCs (`cc_resolve_blocker`, `cc_convert_blocker_to_decision`) + Aggregator wiring. Reuses `cc_issues_app_source_ref_active_idx` from mig 032 verbatim. v0.5 = **3–5 days backend.** Five-bucket `blocker_kind` taxonomy mirrors UX classes 1:1. |
| **Architecture-fit** | **AMEND** the Bible. `blocked_item` is already a first-class peer of `open_decision` in the `cc_issue_type` enum (mig 007). `answer_kind='blocker_input'` is already specified in §4.2 (production migration 015 dropped it — that's drift to repair). §5.2.4 already designs the Review Blockers panel. Slot as **F2-Blockers** + **F3-Blockers** parallel slices — no new phase. |
| **CEO-priority** | Don't build yet. Phase 5 shipped 90 min ago — the "stop the current build" question is moot. **Read the 47 by hand for 60 minutes first** (also smoke-tests Phase 5's new routing engine with real traffic). Then **F3 (the runner) is the right next build, not blocker UI.** Defer **F4's earned-autonomy / verification-gate machinery** — the most expensive single block of work in the Bible and its own §8.10 risk. |

---

## 3. Where they agreed, where they fought, where I land

### 3.1 Agreement (unanimous, no compromise needed)

1. The 6 decisions do **not** unblock the 47 by schema (`blocked` and `pending_decision` are distinct ship_states; mig 002 line 50).
2. The 47 are not 47 distinct problems — they bucket into the four reasons the Bible §5.2.4 already names, plus an honest `unclassified` fifth bucket.
3. The right pattern is **per-task `cc_issues` rows with real `source_ref`s**, not per-row surgery on the aggregate count.
4. Linear stays the system of record. Blocker resolution writes to QEP and lets Linear catch up via existing sync. No new sync hazards.
5. No free-text reaches any agent. Resolution actions are enumerated, typed, picker-driven.
6. v0.5 is genuinely cheap (~3–5 days end to end) because every primitive needed already exists in mig 032's per-decision pattern.

### 3.2 The one real disagreement

**UX/Data/Architecture want to build now. CEO wants to triage first.**

The CEO's contrarian frame: building per-row infrastructure to manage 47 free-text strings is the comfortable software answer to what may largely be data debt. If 25 of the 47 are stale, 10 are decision-blocked (Phase 5 handles them today), 8 are dependency-blocked (legitimate, leave them), and 4 are "genuinely stuck" — then 60 minutes of reading clears 35 of 47 with zero code. The remaining 4 don't justify a new build.

The other three agents implicitly assume the 47 are real and structurally diverse. They may not be. **We do not actually know the shape of the 47 yet.** Nobody has read the rows since the cockpit went live.

### 3.3 How I'm resolving it

**Both are right, and the order matters.**

- The CEO is right that the manual triage is **failure-cheap, learning-rich.** It must come first.
- The Architecture agent is right that the *concept* of a Blocker belongs in the Bible's lexicon regardless of build timing — it's a first-class peer of a Decision in the existing schema, and leaving it unnamed in the architecture is technical debt of a different kind.

So: **codify the architecture in the Bible now (cheap), gate the build behind the triage kill-criterion (CEO's discipline), and the build itself becomes a decision Brian makes after the triage data is in hand.**

---

## 4. The decision — what we do, in order

### Step 1 — Today, 60 minutes: read the 47 (CEO's recommendation, accepted verbatim)

Open QEP's roadmap table directly. Read each of the 47 blocker reasons. Bucket each into one of:

| Bucket | What to do |
|---|---|
| **DEAD** — abandoned, already shipped, owner left | Update QEP `ship_state` directly. Aggregator's next 5-min poll drops the count. |
| **ROUTE-AS-DECISION** — needs a client answer | Use today's `cc-route-decision` flow. Phase 5 sends the email. (Also smoke-tests Phase 5 with real traffic — Slice 1's plan calls for this.) |
| **LEAVE** — legitimate dependency-blocked | The count should reflect them. They're honest. |
| **PROMOTE** — needs hand-attention from Brian | Real ticket; work it; no platform support needed. |

This is also a diagnostic. The bucket distribution is the kill-criterion for Step 3.

### Step 2 — This week to next: codify the Blocker concept in the Bible (small amendment, no build)

Apply the Architecture-fit agent's amendment proposal to `docs/COMMAND_CENTER_MASTER_PLAN.md`. Specifically:

1. **§2 (new §2.4 Blockers paragraph)** — name "Blocker," `reason_kind`, `resolution_action` as architectural concepts. Five sentences. (Source: Architecture report §3.4.)
2. **§4.1** — comment confirming `grain='item'` symmetric rule for `blocked_item`.
3. **§4.2** — flag shipped migration 015 as production drift; specify a **migration 011a** to add `answer_kind` column (default `'operator_decision'`, backfill, drop default). This is the seam through which blocker resolutions write to the same ledger as decision answers.
4. **§4.8** — pin `cc_export_detail('blockers')` payload shape and `cc_apply_blocker_resolution()` signature.
5. **§4.10** — add 6 audit event types (`blocker_classified`, `blocker_resolution_applied`, `blocker_linked_to_decision`, `blocker_marked_external`, `blocker_marked_predecessor`, `blocker_left_blocked`).
6. **§5.2.4** — rewrite from prose to a `reason_kind × resolution_action` matrix with copy.
7. **§8.6** — strengthen the two-writer guard: blocker resolution is typed/enumerated only; free-text `blocker` is classification evidence, never agent-readable input.
8. **§9** — name **F2-Blockers** and **F3-Blockers** as **parallel slices** (not nested phases) inside F2 and F3, with exit criteria. Critical wording: "F2-Blockers is a parallel slice inside F2, not a sequential prerequisite."

**No code, no migration, no build.** This is purely lexicon and contract specification. ~2 hours of editing the Bible. Saves the next implementer from re-deriving the architecture.

### Step 3 — After Step 1 triage data is in: decide build path

**Kill-criterion check** (CEO's, accepted verbatim):

| Triage result | Build decision |
|---|---|
| **<30 land in "can't route / can't bucket / genuinely-stuck"** | **Defer the per-row build.** F3 (the runner) is the next ship. Blocker work waits behind F3. The 47 was data debt; the manual triage cleared it. |
| **≥30 land in "can't bucket"** | **Build v0.5 immediately** (5–7 days total, see §5 below). The 47 is structural and recurring; the surface earns its rent. |

Either way, the **architecture is already in the Bible** so there's no lock-in cost to deferral.

### Step 4 — Deprecate F4 earned-autonomy / verification gate from near-term Bible (CEO's, accepted)

Independently of the blocker question. The Bible's §8.10 *itself* flags F4 as the project's single largest risk: "the engine works mechanically but the verification gate is not trustworthy, so Brian still reviews every PR." It is the most expensive section to build and the least defensible until QEP + a second live client produce enough PR volume to make it pay.

**Action:** in the same Bible amendment, mark F4 as **deferred until PR volume justifies it.** Ship F3 with one-press dispatch only. Brian one-press-authorizes every PR. The verification gate, the PR-triage band, and the agreement-rate measurement all wait.

This is the **"stop building what we're already building"** answer Brian explicitly asked for. It is the single most expensive de-scope on the table.

---

## 5. If Step 3 trips the kill-criterion — the v0.5 ship plan

This is the build, ready to execute. Numbers from the Data and UX agents, reconciled.

### Backend (~3–5 days)

| # | Artifact | Notes |
|---|---|---|
| 1 | **QEP migration**: add `blocker_kind`, `linked_decision_id`, `blocked_since` to `qep_roadmap_tasks`; one-time heuristic backfill | Additive; CHECK constraint; one transaction. Handed off as `docs/handoffs/QEP_TIER3_BLOCKER_SCHEMA.md`. |
| 2 | **QEP view + RPCs**: extend `cc_safe_roadmap_items` and `cc_export_detail`'s roadmap CTE; add `cc_resolve_blocker` + `cc_convert_blocker_to_decision` (SECURITY DEFINER, owned by `cc_contract_owner`, EXECUTE granted to `command_center`) | ~150 LOC SQL. Handed off as `docs/handoffs/QEP_TIER3_BLOCKER_RPCS.md`. |
| 3 | **Control-plane mig 035**: `cc_reconcile_app_blockers(uuid, jsonb)` — sibling of mig 009; reuses `cc_issues_app_source_ref_active_idx` from mig 032 | Aggregate row stays for backwards compat. |
| 4 | **Aggregator wiring**: one extra `cc_export_detail('roadmap')` call per app per 5-min cycle, then call `cc_reconcile_app_blockers` | 12 extra RPCs/hour against QEP. Negligible. |
| 5 | **Migration 011a** (control plane): add `answer_kind` to `cc_decision_answers` (CHECK including `'blocker_input'`) | Repairs production drift from mig 015. |
| 6 | **2 edge functions**: `cc-resolve-blocker`, `cc-convert-blocker-to-decision` | ~250 LOC TS total. Mirror existing `cc-snooze-decision` / `cc-dispatch-from-answer` posture. |

### Frontend (~1–2 days, parallelizable)

| # | Artifact | Notes |
|---|---|---|
| 1 | **`blockerReasonOf(row)`** helper in `web/src/lib.ts` | Browser-side regex classifier, falls through in order; first hit wins; default `unclassified`. |
| 2 | **Refactor `ReviewBlockersPanel`** → `AppBlockersPanel` + new `PortfolioBlockersPanel` | Both reuse `SlideOver` + `usePanelSection`; no new route. |
| 3 | **New `BlockedWorkBand` in `AppDetail.tsx`** | Between `RoadmapBoard` and `DecisionQueue`. Same row component as panels, different density. |
| 4 | **Home `Blocked` cell becomes tappable** | Opens `PortfolioBlockersPanel`. |
| 5 | **Row actions**: Link to decision (picker, not free-text), Mark resolved, Snooze (24h / 7d / next snapshot) | First two work against existing `cc-answer-issue` with one tweak. Snooze needs the v0.5 backend. |
| 6 | **Reason grouping + banner**: *"K of these clear the moment you answer the open decisions →"* | Decision-needed group first because it has highest payoff per click. |
| 7 | **"47 → 0" psychology**: optimistic count animation, 6s Undo, calibration subtitle, earned-calm 0-state, no push notifications for blocker counts | Mobile target: 96px row, 44px tap target. |

### Deferred to v1 (not blocked on; ship when v0.5 usage justifies)

- `cc_categorize_blocker` RPC + tap-to-reclassify chip
- `cc_snooze_blocker` QEP-side (v0.5 uses control-plane `cc_issues.snoozed_until` only)
- `cc_reassign_blocker_owner` — single-operator today; cut until second operator
- `Supply input` typed forms — requires F2's `cockpit-writeback`
- `Ask owner` — reuses `DecisionRouteModal`; cut from v0.5 to keep frontend < 2 days
- Auto-conversion of `decision_shaped` blockers — explicitly rejected; mirrors per-decision auto-route risk without earning its rent

### v0.5 acceptance criteria (from UX report §11, accepted verbatim)

Twelve concrete checks. The key ones:

- Home `Blocked` cell tappable → opens portfolio panel
- Cockpit Band F renders between RoadmapBoard and DecisionQueue
- Every row classifies into one of five reasons (incl. Unclassified)
- "Awaiting a decision" group shows the cross-link banner
- Three actions (Link/Resolve/Snooze) work end-to-end; row collapses with optimistic count update
- Linear is never written to from this surface
- No free-text input drives any agent or work-order field
- Mobile: 96px row height, 44px tap target
- Empty 0-state shows earned-calm one-liner; cell turns green

---

## 6. What this answers from Brian's original question

| Question | Answer |
|---|---|
| Does the 47 get unblocked from the 6? | **No.** They're separate ship_states. Some of the 47 may *become* decisions, but most won't. |
| If not, what's required to unlock the 47? | **Each row's `blocker` reason classifies into one of five buckets (decision needed, missing input, behind another task, blocked externally, unclassified). Each bucket has a one-tap action.** |
| How can we see all 47 and clearly understand what's required, with quick buttons to lower the number? | **The v0.5 ship plan in §5 above** — but gated behind a 60-minute manual triage that may make the build unnecessary. |
| Update the current roadmap/Bible, or separate build? | **AMEND the Bible.** Architecture-fit verdict held against the steelman. The schema spine already commits to it (`cc_issues.issue_type='blocked_item'` is a first-class enum value; §5.2.4 is half-specced); forking would violate §1.3 ("resolution where seen, not by navigating") within one phase. |
| What in the current Bible should we stop building? | **F4 earned-autonomy / verification gate.** Defer until QEP + second client produce enough PR volume to justify the §8.10 risk. Brian one-press-authorizes every PR until then. |

---

## 7. The kill-criteria and falsification checks

If any of these fire, this decision is wrong and we revise:

1. **Manual triage takes >3 hours** → the data is more current/fragmented than predicted; build v0.5 backend immediately (Step 3 trips).
2. **>30 of the 47 land in "promote / can't route / genuinely stuck"** → per-row UI earns its rent; build v0.5 (Step 3 trips).
3. **A second app onboards with 30+ blockers of its own** → portfolio panel justifies itself by multiplier; build v0.5.
4. **Phase 5's operator confirm queue grows past 10 items/day** → different problem, same shape; revisit operator throughput overall.
5. **F3 stalls** (Mac Studio unavailable, GitHub App blocked) → F5's collected answers have nowhere to go; per-row blocker UI becomes "the only thing left to ship" and gets reprioritized regardless.

Inversely:

- **If the triage shows ≥35 of 47 fall into DEAD/ROUTE/LEAVE buckets cleanly,** the build is not justified. The 47 was data debt; the Bible amendment alone is the deliverable. F3 is next.

---

## 8. Sequencing summary — the next ~30 days

| Horizon | Action | Cost |
|---|---|---|
| **Today** | 60-min manual triage of the 47 in QEP roadmap. Bucket each. Update DEAD rows directly. Route ROUTE-AS-DECISION rows through today's Phase 5 (also smoke-tests it). | 1.5 hrs |
| **This week** | Apply the Architecture-fit amendment to `docs/COMMAND_CENTER_MASTER_PLAN.md` (§2.4, §4.1, §4.2, §4.8, §4.10, §5.2.4, §8.6, §9 edits) — codifies Blocker concept and F2-Blockers / F3-Blockers parallel slices. **In the same edit**, mark F4 earned-autonomy as deferred until PR volume justifies. | 2 hrs |
| **Next 1–2 weeks** | Stand up the **Mac Studio runner host (F3)**. Create the BlackRock AI GitHub App. Get the daemon + first work-order + first agent-opened PR working — manual dispatch only, no verification gate. **This is the next high-leverage build, not blocker UI.** | Bible's existing F3 estimate |
| **2–4 weeks** | Wire the **operator-handoff feature** end to end (Bible §3.3). This pays for itself the moment Brian needs RepoPrompt or a credential rotation. | Bible's existing estimate |
| **Conditional** (only if kill-criterion in §7 trips) | Ship the v0.5 blocker build in §5. ~3–5 days backend + 1–2 days frontend. | 5–7 days |

---

## 9. What I'd ask Brian to confirm before moving

These are the three calls only Brian can make:

1. **Approve the Bible amendment.** Six sections, ~2 hours of edits. Lexicon + slice naming + drift repair + F4 deferral. No build commitment yet.
2. **Approve deferring F4 earned-autonomy.** The expensive de-scope. Brian one-press-authorizes every PR until QEP + a second client are producing enough volume to justify the verification-gate build.
3. **Block 60 minutes this week** to read the 47. The triage *is* the diagnostic that decides the build. Skipping it is the only thing that breaks the plan.

If all three are yes, the next action is the Bible amendment. I can author that as the next deliverable. If Brian wants to skip the triage and just build, the v0.5 plan in §5 is ready to execute.

---

## 10. The single sentence, restated

> The 47 is one number wearing four reasons; the Bible already half-specs the surface; the schema enum already names the concept — so we amend, we triage, and we build only if the triage data demands it, while killing F4 earned-autonomy to make room for what actually matters next: F3, the runner.

**End of decision report.**
