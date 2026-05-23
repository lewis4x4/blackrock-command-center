# CEO Priority Call — The 47 Blocked Items vs. Phase 5

**Compiled:** 2026-05-23
**Lane:** CEO / priority. Not UX, not data contracts, not architecture-fit.
**Audience:** Brian, sole operator.
**Scope:** Decide whether to stop / slow / parallel / finish Phase 5 in order to attack the 47 blocked items on the QEP cockpit; identify what (if anything) in the current Bible should be deprecated to make room.
**Sibling reports:** UX, Data/Contracts, Architecture-fit are running in parallel — I deliberately do not redesign the panel or the schema below.

---

## Executive verdict

**Recommend: NEITHER. Phase 5 is already finished — the question as posed is moot. Spend 30 minutes today reading the 47 by hand in QEP, route the genuine ones through the email engine that shipped 90 minutes ago, and let F3 (the runner) be the next build.** The premise that we have to choose between "ship Phase 5" and "attack the 47" rests on the assumption that Phase 5 is in flight; it isn't — Slice 4 was committed at 11:23 AM today, all eleven Phase-5 migrations are applied, and the cockpit, modals, and confirm-page surfaces exist in the bundle. The genuine question is different: *do we build a new "per-row blocker triage" surface that the Bible does not currently spec, or do we treat the 47 as a one-time data cleanup that a human eyeballs once?* My recommendation is the human pass. Building per-row blocker infrastructure today is the comfortable software answer to what is really a 90-minute data-debt problem; it is not justified until the second client app (SCC) is wired and the blocker count is genuinely structural.

---

## 1. What I found that changes the question

### 1.1 Phase 5 is done — not "in flight"

Git log on `supabase/migrations/`:

| Slice | Migrations | Shipped | Wall time |
|---|---|---|---|
| Slice 1 — outbound, magic-link, AI-rewrite | 024, 025 | 2026-05-22 17:38–19:27 | ~2 hours + hotfixes |
| Slice 2 — inbound, LLM extraction, confirm queue | 026 | 2026-05-22 20:13 | same day |
| Slice 2.5 — autonomous per-app routing | 027 | 2026-05-22 22:21 | same day |
| Cron scheduler | 028 | 2026-05-22 22:26 | same day |
| Slice 3 — pause/reminder/clarify/snooze/metrics | 029, 030 | 2026-05-22 23:11 | same day |
| Audit pass (10 P0 + 15 P1) | 031 | 2026-05-23 10:43 | this morning |
| Slice 4 — per-decision auto-route | 032, 033, 034 | 2026-05-23 11:23 | **90 minutes ago** |

Eleven migrations. Five slices. Two calendar days. The DB and edge-function backbone is 100% there; the React surfaces (`ExtractionReviewModal.tsx`, `DecisionRouteModal.tsx`, `confirmRoute.tsx`, `TriagePanels.tsx`) are in `web/src/`. What remains is **operational shake-out** — first real send, first real reply, first real auto-route, watching the cron — not feature work.

The "do we slow Phase 5 to attack the 47" framing assumes scarcity that no longer exists. The hours are not contested.

### 1.2 The 47 is not 47 things — it is one scalar with no per-row identity

From the sibling Data probe (independently confirmed by reading `cc_export_detail()` contract + the panel code):

- The home shows **`roadmap_counts.blocked = 47`** — a single aggregate number lifted from the snapshot.
- The "Review blockers" slide-over fetches a **flat array** of roadmap rows from `cc_export_detail('roadmap')` and filters client-side by status text containing "blocked"/"stuck" or by the presence of a `blocker` / `blocked_reason` / `blocked_by` field.
- Every blocked row renders as a **read-only display card** — title plus up to five key/value fields from a dump. No expand. No row-level action.
- The whole batch maps to **one `cc_issues` row** with `source_ref='aggregate'`. The two panel-level actions are *Dismiss* (kills the whole issue) and *Link to decision* (attaches one decision reference to the whole batch).

What this means: the system **cannot** "convert row #23 to a decision and snooze row #29 and reassign row #31" today — not because the UI is missing buttons, but because there is no stable per-row identity to act on. To get per-row triage requires (per the Data probe):

1. QEP exposes a stable UUID + structured `blocker_reason` per row in the safe view.
2. CC adds either a per-blocker `cc_issues` row (heavier) or a `cc_blocker_actions` ledger table.
3. New RPC: `cc-resolve-blocker(blocker_row_id, action_type)`.
4. UI overhaul of `ReviewBlockersPanel` — slide-over per row, action menu per row, prior-action state per row.

That is **a Phase 6 feature, not a today move.** Estimated 3–5 working days of build (Data probe's number; I trust it for sequencing).

### 1.3 Are the 47 even real?

We do not know. The blocker reason is free text; nobody has read them since the cockpit went live. Standard pattern from every backlog I've seen:

- 30–50% are **stale** — the underlying work was abandoned, completed without the row being updated, or is waiting on someone who left.
- 20–30% are **decision-blocked** — exactly the case Phase 5 was built for. They become routed-to-client decisions.
- 20–30% are **dependency-blocked** — a different task has to ship first; the row is correct as written, just patience.
- 10% are **genuinely stuck** — the kind that benefits from per-row triage UI.

If those numbers are even roughly right, the leverage move is to **discover the breakdown by reading the rows, not by building infrastructure to manage 47 of every kind.**

---

## 2. The seven questions, answered

### Q1 — What's the actual business value of unblocking the 47?

**Lower than the framing implies.** The 47 is a count, not a list of revenue commitments. Some are stale. Some are decision-blocked (Phase 5 just shipped the loop for those). The genuine business value sits in the subset that, if cleared, ships QEP roadmap items the client cares about — and we don't know which subset that is until someone reads the 47.

**The high-leverage value is not "drop the count from 47 to 12." It is "stop showing Brian a number that is 60% lies."** A dashboard that says "blocked: 47" when 25 of them are dead is worse than a dashboard that says "blocked: 17, real" — it desensitizes the operator to the metric.

### Q2 — What's the opportunity cost of pausing Phase 5?

**Zero. It's not in flight.** The real opportunity cost is "what do we *not* build by spending the next week on per-row blocker triage?" The answer is **F3 (the runner)** — and F3 is the thing that turns every answered decision (including the ones Phase 5 will now collect) into an actual PR. Without F3, Phase 5 fills `cc_decision_answers` with answers that never become code.

### Q3 — Can they run in parallel?

Same Brian, ~6 productive hours/day. Honest answer: **only if the "attack the 47" track is human-eyeball triage in QEP, not net-new CC features.** Manual triage is 1–2 hours total. Building per-row infrastructure (3–5 working days) is mutually exclusive with progressing F3.

### Q4 — What's the 80/20 leverage move?

**A 60-minute sit-down with the 47 rows in QEP's roadmap table, with these four buckets ready:**

1. **Mark dead** — work that was abandoned or already shipped. Update QEP status. The Aggregator's next 5-min poll drops the CC count.
2. **Route as decision** — the blocker is an unanswered question. Use the cockpit "Open decisions" → *Route to client* button that shipped today. Phase 5 takes it from there.
3. **Leave** — legitimate dependency-blocked items waiting on real upstream work. These are honest blockers; the count should reflect them.
4. **Promote** — the small residual that needs hand-attention. These get a real ticket and Brian works them, no platform support needed.

This is a **non-software answer**. It is also the right one. The CC was built to make operator throughput legible, not to replace operator judgment on 47 strings of free text.

### Q5 — 30 / 60 / 90 day picture

| Horizon | Blocked count | Operator hours saved/wk | What is shipped |
|---|---|---|---|
| **30 days** | 47 → ~15 (after manual triage + Phase 5 routing of decision-blocked ones) | 2–3 | F3 runner host live on Mac Studio; GitHub App created; first PR opened by an agent; the routing engine that shipped today has handled its first real client reply |
| **60 days** | 12–18 sustained (new ones surface, existing ones resolve) | 5–7 | F3 fully operational, 5–10 agent PRs/week; SCC onboarded as app #2 (proves federation); F4's verification gate deliberately *not* built — kill criterion below |
| **90 days** | <10 sustained across QEP + SCC | 10+ | F3 + F5 close the loop end to end with operator-press dispatch; per-row blocker triage built **only if** the breakdown after manual triage shows a sustained genuine-stuck count above ~25 across apps |

### Q6 — What signal tells us we made the wrong call?

The recommendation **flips to "build per-row blocker triage now"** if any of these fire:

1. **The 60-minute manual triage takes >3 hours** — the data is more fragmented or more current than predicted; the rows are not safely bucketable; structured handling is justified.
2. **More than 30 of the 47 land in the "promote / can't route" bucket** — meaning Phase 5 doesn't actually help and Brian is the bottleneck on each one; per-row UI starts paying for itself.
3. **A second app onboards and arrives with another 30+ blockers** — multiplier effect makes the build economics work.
4. **Phase 5's operator confirm queue grows past 10 items/day** (its own design's stop condition) — different problem, same shape: the platform is now collecting work faster than Brian processes it.
5. **F3 stalls** (Mac Studio not available, GitHub App blocked, runner architecture proves wrong) — at which point F5's collected answers have nowhere to go and per-row triage becomes "the only thing left to ship."

The recommendation **flips to "buy off-platform help"** (an offshore analyst tagging the 47 by hand) if:

- Brian's calendar makes 60 minutes of focused triage impossible for >1 week.

### Q7 — The "stop building what we're already building" question

Brian asked this directly. The honest answer:

**Deprecate F4's earned-autonomy / verification-gate machinery from the near-term Bible.** This is the most expensive single block of work in the master plan and it is the §8.10 risk that the Bible itself flags ("the engine works mechanically but the verification gate is not trustworthy"). Ship F3 (runner + one-press dispatch + operator handoffs) without auto-dispatch. Brian one-press-authorizes every PR. Defer the verification gate, the PR-triage band, and the agreement-rate measurement until PR volume becomes the bottleneck — which won't be true until SCC + Foundry are also wired.

This is **a deliberate de-scoping**, not a re-prioritization. It admits that "fully self-driving" was an aspiration that earned its place in the doc; it does not earn its place in the next 60 days of build time given that QEP is the only live client.

**Do NOT add a Phase 5.5 "per-row blocker triage" to the Bible.** It's net-new scope solving for a problem we have not measured. Adding it locks in 3–5 days of work to fix a number that 60 minutes of human triage might cut in half on its own.

**Do NOT pause Phase 5 deployment work.** It's done. The remaining work is operational verification, which is light and fits in the same hours Brian was going to spend on the cockpit anyway.

---

## 3. The recommended next moves, in order

These are not a roadmap — they are the next ~10 days. The Bible already has the longer story.

1. **Today, 60 minutes:** Open QEP's roadmap table directly. Read all 47 blocker reasons. Bucket each into one of {dead, route-as-decision, leave, promote}. Update QEP status for everything in {dead}.
2. **Today, 30 minutes:** For each item in {route-as-decision}, open `/apps/qep`, find the matching decision, click "Route to client." Phase 5 sends the email. (This also smoke-tests Phase 5 with real traffic from your own inbox first — Slice 1's plan calls for exactly this.)
3. **This week:** Stand up the Mac Studio runner host (F3, the one piece blocking everything downstream). Create the BlackRock AI GitHub App. Get the daemon + first work-order + first agent-opened PR working — manual dispatch only, no verification gate, no auto-dispatch.
4. **Next week:** Wire the operator-handoff feature end to end (the `cc_operator_handoffs` table is in the Bible, the runbook UX is specced — ship it with F3). This is the feature that pays for itself the moment Brian needs RepoPrompt or a credential rotation.
5. **The "47" becomes a number the dashboard reports honestly** — and stops being a strategic agenda item.

---

# Did I push this? Is this the best way?

## Steelman the opposite

**Counter-position: pause everything, build per-row blocker triage as a Phase 5.5.**

The strongest version: today there is **one** live client. Onboard two more and you have ~140 blockers across three apps. The same dynamic that makes the cockpit valuable (one screen, all apps, real work in place) demands per-row handling — because *flat arrays of 50 dumb cards across 6 apps* is exactly the operator-overload failure mode §8.9 of the Bible warns about. Better to build it now while the schema is fresh and there is one app's data shape to learn from, than to retrofit it under load with three clients screaming. The 60-minute manual triage doesn't scale; the third time you do it you will wish you had built the tool.

A second steelman: **Phase 5's email engine doesn't actually attack the 47.** Most of the 47 will be dependency-blocked or stale, not decision-blocked. So routing the 6 open decisions doesn't move the 47 — that's exactly what Brian observed. If Phase 5's leverage on the 47 is low, then the cleanest CEO move is to admit it and pivot — because right now, the cockpit's largest number is one the platform has no answer for.

## The assumption that flips my answer

**The load-bearing assumption is: the 47 are mostly stale / decision-blocked / dependency-blocked, with a small residual of "genuinely stuck."** If instead the 47 are mostly "genuinely stuck and need per-row reasoning by the operator" — which would be true if QEP's blocker reasons are 47 distinct one-off problems that don't bucket — then the manual triage is a one-shot fix and the underlying flow is broken: structured per-row handling becomes the right build.

**The cheapest way to falsify my assumption is the 60-minute triage itself.** That's not a coincidence; it's why I keep putting it first. The triage is *also a diagnostic.* If the buckets distribute the way I predict, the recommendation holds. If they don't, the recommendation changes and the data to change it is now in hand.

I am also assuming that **F3 is the right next build.** The opposite would be: "F5 collected answers can sit in a table for a few weeks without an agent; that's fine; ship F2's full cockpit interactivity and per-row blocker work instead." This is plausible. The argument against: F5's value collapses to zero if Brian still has to manually push every confirmed answer into a PR. F3 is what makes F5's investment pay off. So F3 first.

## Comfortable answer vs. right answer

The **comfortable answer for me** is the elegant one: design a beautiful per-row blocker triage system with a state machine and an action ledger and a slide-over per row. That's a great design doc. It is also 3–5 days of work to solve a problem I can demonstrate is largely data debt before the design is even drafted.

The **right answer** is the un-glamorous one: this is a data problem, not a UI problem. Spend an hour reading the rows. Use the engine that already exists for the ones it can help. Build F3 next because that's what makes everything else compound.

I'm aware the un-glamorous answer is less satisfying to write and less satisfying for an operator to receive — "go read 47 things by hand" is not what people pay strategic advisors for. But the operator threshold for whether per-row infrastructure is justified is **after** the manual triage, not before, because we don't know the shape of the data yet. Building before measuring is the failure mode I see most often in software-rich operators.

## Confirm or revise

**Confirmed.** The verdict stands.

- Phase 5 is done; that question is closed.
- The 47 gets attacked by 60 minutes of human reading + Phase 5 routing for the decision-blocked subset, not by net-new platform scope.
- F3 is the right next build.
- F4's earned-autonomy / verification-gate machinery should be deferred until QEP + at least one other live client are producing enough PR volume to make it worth the §8.10 risk.
- **Kill criterion if I'm wrong:** if >30 of the 47 land in the "can't route / can't bucket / genuinely-stuck-needs-per-row-thinking" pile after the manual triage, build per-row blocker triage as the *next* slice after F3, ahead of F4.

The single most important sentence in this report:

> **Read the 47. Then decide.**

Everything else in this document follows from that.

---

**End of CEO priority report.**
