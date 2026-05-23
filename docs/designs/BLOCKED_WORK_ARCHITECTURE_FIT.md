# Blocked Work Resolution — Architecture-Fit Analysis

**Compiled:** 2026-05-23
**Author:** Architecture-fit lane (sibling agents own UX, Data/Contracts, CEO-priority)
**Scope:** Decide whether the Blocked Work resolution surface (the 47 free-text-`blocker` items on QEP) is an **amendment** to `docs/COMMAND_CENTER_MASTER_PLAN.md` ("the Bible") or a **separate parallel build**. Then map it concretely against the Bible's TOC, phase order, and lexicon.
**Status:** Recommendation. No code or Bible edits performed; the Bible is intentionally not modified.

---

## Verdict — AMENDMENT

**Blocked Work resolution is already part of the Bible's architecture.** The missing work is concrete specification of three slots the Bible already defined plus repair of one production-drift gap. It should be formalized by amending §2.2, §4.2, §4.8, §4.10, §5.2.4, §8.6, and §9 (F2 + F3 exits) — **not** forked into a parallel design doc.

**The one-sentence reason:** the Bible's spine is the `cc_issues` ledger, and `blocked_item` is already a first-class peer of `open_decision` in the `cc_issue_type` enum (`007_cc_issues_ledger.sql`, line 39). Forking a separate "Blocker" architecture would create a second resolution surface for a row type that already exists in the primary one, violating §1.3's first principle ("resolution happens where the problem was seen, never by navigating").

**Headline numbers:** the user-facing "47 blocked work items" is, in the current schema, **one row** in `cc_issues` of type `blocked_item` with `source_ref='aggregate'` and a count of 47 in `detail->>blocked`. The 47 items themselves live in QEP's data plane behind `cc_export_snapshot()` → `roadmap_counts.blocked`. The Bible's F2 exit already calls for item-level `cc_issues` rows once `cc_export_detail()` exists; this is the moment those item rows get specified, classified, and resolved — not a moment to fork.

---

## 1. The exact gap

Three concrete things are missing, and all three are *amendments to existing Bible sections*, not new architecture:

| # | What's missing | Where the Bible *already* anticipates it | What needs to change |
|---|---|---|---|
| 1 | Item-level `cc_issues` rows of type `blocked_item` with a real `source_ref` | §4.1 migration 010 adds `cc_issues.grain` (`'aggregate' \| 'item'`); §5.2.4 panel body assumes per-item rows | Specify the reconciliation rule from `cc_export_detail('blockers')` to item-level upserts; explicit `aggregate→item` rollup contract |
| 2 | `cc_export_detail('blockers')` section shape | §4.8 names the sections `'all' \| 'decisions' \| 'build' \| 'blockers' \| 'sync' \| 'roadmap'` but only `'decisions'` is shape-specified | Pin the `'blockers'` payload shape, including the **reason taxonomy** (see §3 of this report) |
| 3 | `cc_apply_blocker_resolution()` write-back on the client side | §4.8 names it inline as a sibling of `cc_apply_decision_answer()` but doesn't enumerate its args | Spec the four enumerated resolution actions and their argument signatures |

And one production-drift repair, which the amendment must also resolve:

| 4 | Shipped `cc_decision_answers` (migration 015) has no `answer_kind` column | Bible §4.2 migration 011 explicitly defines `answer_kind text NOT NULL CHECK (answer_kind IN ('operator_decision','client_decision','blocker_input','sync_escalation'))` | Add `answer_kind` via new migration (additive, defaulted to `'operator_decision'` for backfill); this is the seam through which blocker resolutions write to the same ledger as decision answers |

---

## 2. Why amendment, not separate build — four structural arguments

### 2.1 The schema spine already commits to it

`cc_issues.issue_type` is a Postgres enum with four equal values: `open_decision`, `build_health`, `blocked_item`, `sync_error`. The Bible's resolution loop in §2.2 ("the lifecycle of one problem, end to end") is written generically against "an issue" — it does not privilege decisions. A separate "Blocked Work" architecture would have to either (a) shadow the existing enum value with a new ledger, which is technical debt by construction, or (b) wrap the existing rows in a parallel surface, which restates §1.3's forbidden pattern: navigating away from where the issue was seen to resolve it.

### 2.2 The Bible's first principle forbids a parallel resolution surface

§1.3, principle one (lines 27–28 of the Bible):

> "resolution happens where the problem was seen, never by navigating … He does not 'go to the Decisions page to handle decisions.' The nav pages are for browsing and configuration; the **home and the cockpit are where work gets resolved.**"

A separate "Blocked Work" doc that builds its own slide-over, its own resolution panel, and its own dispatch path is a navigate-away surface by construction. Two designs for one panel quietly erode the principle within one phase.

### 2.3 The decision-answer ledger is already designed to hold blocker inputs

Bible §4.2 migration 011 (line ~258):

```sql
answer_kind text NOT NULL CHECK (answer_kind IN
  ('operator_decision','client_decision','blocker_input','sync_escalation'))
```

`blocker_input` is already a first-class peer of `operator_decision`. The Bible deliberately did *not* spec a `cc_blocker_resolutions` table — it chose to multiplex resolution kinds through one ledger. A separate build that introduces a second resolution ledger reverses that decision unilaterally.

Critical clarification (per oracle review): **`blocker_input` is an answer/source kind, not a risk class.** Risk is still re-derived server-side per §3.1 of the Bible. A blocker-input resolution may compose an AUTO work order, an AUTHORIZE work order, a `manual_step` handoff, or no work order at all — depending on what the operator picked. Do **not** introduce a `blocker` risk class.

### 2.4 The Review Blockers panel is already designed

§5.2.4 (lines 580–583 of the Bible) specifies the panel body in detail:

- Grouped by reason: *awaiting a decision*, *missing input*, *behind another task*, *blocked externally*
- Banner copy: *"{K} of these clear the moment you answer the open decisions."*
- Action surfaces: **Link to a decision** (jumping straight to Open Decisions panel); **SupplyInputForm** (typed/enumerated, "never a free-text instruction box"); supplying a credential/asset is "recorded as a manual resolution with no work order"; supplying a value "composes a work order"

This is the resolution mechanic, already designed. The amendment's job is to make it concrete (taxonomy enums, contract shapes, RPCs) — not to redesign it.

---

## 3. Concept additions to the §2 lexicon

The amendment introduces three small concepts. None of them are new architecture; they are formalizations of language §5.2.4 already uses loosely.

### 3.1 "Blocker" (proper noun in the architecture)

**A `cc_issues` row of `issue_type='blocked_item'` whose `source_ref` is a real client-side task id (i.e., `grain='item'`, not `'aggregate'`).** The aggregate row counts; the item rows resolve.

This term should land in §2 ("The architecture"), §4.1 (migration 010 grain), and §5.2.4 (where it currently uses the bare word "blocker"). It is the noun the architecture has been missing.

### 3.2 `reason_kind` — *why* the work is blocked

A small enum, classifying the free-text `blocker` reason from the client snapshot into a typed bucket. Six values (the §5.2.4 four plus oracle's `credential_or_access` plus an honest `unclassified`):

```
awaiting_decision          -- already covered by §5.2.4 "awaiting a decision"
missing_input              -- already covered by §5.2.4 "missing input"
behind_predecessor         -- already covered by §5.2.4 "behind another task"
blocked_externally         -- already covered by §5.2.4 "blocked externally"
credential_or_access       -- NEW — would otherwise hide under "external" / "manual"
unclassified               -- honest interim — the classifier could not bucket the free text
```

The classifier itself is a small server-side function (a regex/keyword pass; LLM only as a fallback, never on the hot path). The free-text `blocker` string is **evidence for classification, never an instruction to an agent** — this is the §3.4 invariant restated for blockers.

### 3.3 `resolution_action` — *how* the blocker exits the queue

Orthogonal to `reason_kind`. A blocker can exit through one of seven enumerated paths (oracle's recommended taxonomy, lightly trimmed):

```
link_decision             -- pointer write: blocker is awaiting an existing decision
supply_input              -- typed/enumerated value flows to cc_apply_blocker_resolution()
create_work_order         -- supply_input that ALSO composes an agent_work_orders row
create_manual_handoff     -- credential rotation, dashboard step → cc_operator_handoffs.kind='manual_step'
mark_external             -- not actionable from inside; tracked but does not block dispatch
mark_predecessor          -- waiting on a specific task id; resolves when predecessor ships
leave_blocked             -- honest interim — operator deliberately punted
```

`resolution_action` is what `cc_apply_blocker_resolution()` accepts as a discriminated argument. Every action writes one `cc_decision_answers` row with `answer_kind='blocker_input'` plus an action-specific typed payload. None of them ever accept a free-text instruction.

### 3.4 Lexicon proposal — drop-in language for §2

A single paragraph the amendment can splice into §2 ("The architecture") between §2.1 and §2.2:

> A **Blocker** is a `cc_issues` row of type `blocked_item` and grain `'item'` — one per blocked task in a client app's roadmap. Each Blocker carries a `reason_kind` classifying *why* the work is stuck (awaiting a decision, missing input, behind a predecessor, blocked externally, awaiting a credential, or unclassified) and exits the queue through one of seven enumerated `resolution_action`s — link to a decision, supply input, compose a work order, raise an operator handoff, mark external, mark predecessor, or leave blocked. The free-text `blocker` string from the client snapshot is classification evidence, never an agent instruction. Blockers resolve through `cc_apply_blocker_resolution()` and write to the `cc_decision_answers` ledger with `answer_kind='blocker_input'` — the same ledger that records decision answers — keeping the resolution spine singular.

---

## 4. Diff outline against the Bible's TOC

Below is the precise list of Bible sections that need amendment, what to add, what gets superseded, and the new dependency graph. **No Bible lines are modified in this report;** the diff is a specification for the future amendment.

### 4.1 Sections that get a new subsection

| Bible section | New subsection | Why |
|---|---|---|
| **§2 The architecture** (lines ~52–110) | New §2.4 — **"Blockers"** (the lexicon paragraph from §3.4 of this report) | Introduce the term to the architecture's spine, alongside the lifecycle in §2.2 |
| **§4.1 Migration 010** (lines ~210–245) | Add comment block on how `grain='item'` rows are reconciled for `blocked_item` issues — i.e., the same partial-unique-index pattern as `open_decision` item rows | F2 plans item-level decisions; this just states the symmetric rule for blockers |
| **§4.2 Migration 011 — `cc_decision_answers`** (lines ~247–290) | Mark §4.2 as the canonical schema; flag shipped migration 015 as a production-drift gap that **migration 011a (new)** repairs (add `answer_kind` column, default `'operator_decision'`, backfill, then drop the default) | Repairs drift; restores `blocker_input` as the writable kind |
| **§4.8 The federated contracts** (lines ~430–460) | Pin the `cc_export_detail('blockers')` payload shape: `{blocked_task_id, title, stream, wave, blocker_text, blocker_text_classified_as: reason_kind, age_days, candidate_decision_ids[]}`. Pin `cc_apply_blocker_resolution(p_blocker_id, p_resolution_action, p_payload jsonb)`. | The contract is named but not shaped |
| **§4.10 Audit event types** (lines ~471–477) | Add: `blocker_classified`, `blocker_resolution_applied`, `blocker_linked_to_decision`, `blocker_marked_external`, `blocker_marked_predecessor`, `blocker_left_blocked` | Audit symmetry with decision-answered |
| **§5.2.4 Panel — Review Blockers** (lines ~580–590) | Replace the current prose with a tight spec mapping each of the six `reason_kind` values to its enabled `resolution_action`s, with copy for each. Add the `cc_export_detail('blockers')` shape reference. Add the "blockers awaiting decision X clear automatically when X is answered" rule (this is structural, not just UI). | The panel is half-specified today |
| **§8.6 The interactive cockpit as a sync hazard** (lines ~810–815) | Strengthen for blockers explicitly: (a) blocker resolution is *typed/enumerated only*; (b) free-text `blocker` text is never agent-readable; (c) optimistic UI reconciles on next snapshot; (d) `unclassified` reason can never auto-compose a work order — operator must classify first | Per oracle: blockers are riskier than decisions; risk amendment, not architecture change |
| **§9 F2 exit criteria** (lines ~875–880) | Add: *"item-level `blocked_item` issues surface in the Review Blockers panel, each classified by `reason_kind`; the four resolution actions that do **not** require a work order (link/external/predecessor/leave) work end to end"* | F2 = read+resolve loop closure for blockers that don't need the runner |
| **§9 F3 exit criteria** (lines ~882–887) | Add: *"`supply_input` and `create_work_order` resolution actions compose `agent_work_orders` rows via the same path as decision answers, with `blocker_input` provenance"* | F3 = runner integration; blocker-input → work order rides the same rails |

### 4.2 What gets superseded (zero conflicts)

Nothing in the Bible is superseded. The current §5.2.4 is *under-specified*, not wrong; the amendment fills it in. The current §4.2 migration 011 is *correct in spec* but *unshipped*; the amendment ships it as migration 011a. The current §4.8 names the contracts; the amendment shapes them.

### 4.3 The new dependency graph

```
                                       (existing)
                                          │
                                          ▼
S1 / S2 (security track) ───────────►  F1 (router + Apps/Settings pages)
                                          │
                                          ▼
                                       F2 base — cc_export_detail('decisions'), item-level open_decision rows
                                          │
                                          ▼
   ┌──────────────────────────────────────┴──────────────────────────────────┐
   │                                                                          │
   ▼                                                                          ▼
F2-Blockers (NEW dependency)                                       F2-rest (slide-overs for
   - migration 010 grain extension for blocked_item                            decisions, sync,
   - cc_export_detail('blockers') shape pinned                                 cockpit reads)
   - reason_kind classifier (server-side)
   - migration 011a (add answer_kind, drift repair)
   - cc_apply_blocker_resolution() — link/external/predecessor/leave actions
   - Review Blockers panel rebuilds against item rows
   │
   ▼
F3-Blockers (rides on F3 write-spine, not a separate phase)
   - supply_input + create_work_order paths compose agent_work_orders
   - blocker_input provenance plumbed through change_spec assembly
   - manual_step handoffs raised for credential_or_access blockers
```

**Critical:** there is no new phase. F2-Blockers is a slice inside F2; F3-Blockers is a slice inside F3. The amendment names them as labeled slices for tracking, the same way Phase 5 has Slices 1–4 today.

---

## 5. Phase ordering — does this block Phase 5 finish?

**No. It runs parallel. F5 finish has zero dependency on Blocked Work resolution.**

The Bible's F5 (the email decision engine) is scoped to *client-owned decision routing* — `cc_decision_email_sends`, magic-link confirm, Gmail OAuth, free-text reply extraction, the operator confirm queue. The active build is Slices 1–4 in migrations 024–034. None of that work touches `blocked_item` issues, `cc_issues.grain`, or `cc_export_detail('blockers')`. The two streams share `cc_decision_answers` only on the **column** `answer_kind`, and the F5 path writes `'operator_decision'` or `'client_decision'` exclusively — adding `'blocker_input'` is additive.

**Unlock criteria for Blocked Work slices:**

- **F2-Blockers unlocks when:** (a) F2's base item-level `cc_export_detail()` pattern is implemented for `'decisions'` (because blockers reuse the contract pattern), and (b) S1's Cloudflare Access gate is in (because the panel writes through the proxy that depends on Access).
- **F3-Blockers unlocks when:** (a) F2-Blockers ships (item rows must exist), and (b) F3's base runner daemon + `agent_work_orders` table is in place (because `create_work_order` and `supply_input` compose into the same queue).

**Sequencing recommendation:** F2-Blockers can start *the moment F1 ships and the F2 item-level pattern is set on decisions*. F3-Blockers waits for F3 base. Both can run while F5 finishes Slices 5+ (reminders, auto-clarify polish).

---

## 6. Risk register

### 6.1 Scope creep on F5 — **LOW**

F5 is a client-decision lane (email + confirm queue). Blocker resolution writes through the same `cc_decision_answers` table but never the same email path. The only seam is the `answer_kind` column (additive). The amendment must explicitly forbid blocker resolutions from being routed through `cc_decision_email_sends` (which is keyed on `decision_external_ref` semantics, not blocker semantics). Mitigation: the amendment text in §4.2 should state: *"Blockers are operator-resolved or operator-classified-then-dispatched. They never enter the client email engine."*

### 6.2 Conflict with §3.3 operator handoffs — **MEDIUM** (resolved by design, must be made explicit)

A credential-rotation blocker IS a `manual_step` operator handoff. Without an explicit amendment statement, an implementer could (a) raise the handoff *from* the blocker panel, or (b) build a separate "credential resolution" surface. Both happen; the architecture decays.

**Correct model** (per oracle, must be stated in the amendment):

> The Review Blockers panel is the **intake/classification surface**. The operator handoff is the **execution artifact** for blockers whose `resolution_action='create_manual_handoff'`. The handoff is downstream; it is never a competing resolution surface. A credential blocker is resolved *through* the blocker panel, which **creates** a `manual_step` handoff (kind=`manual_step`, `cc_operator_handoffs.work_order_id IS NULL`, linked back to `cc_issues.id`).

Amendment must add `cc_operator_handoffs.issue_id` to the handoff index list (currently exists per migration 014 in §4.5) and add a foreign-key-style validation that a handoff created from a blocker has `kind IN ('manual_step', 'compose_by_hand')`.

### 6.3 Two-writer / Linear sync hazard — **HIGH** (per §8.6)

§8.6 already flags task-state change as the highest-risk interactive feature; blockers are a sibling concern. Mitigations (must be stated in the §8.6 amendment):

- Blocker resolution NEVER directly mutates Linear task state. The only write is to the client app's data plane via `cc_apply_blocker_resolution()`; Linear mirrors that via its existing sync path.
- `mark_external` and `mark_predecessor` write *annotations* on the blocker row, not on the predecessor task. The predecessor's state is owned by its own task lifecycle.
- `link_decision` writes a pointer (`cc_issues.context.linked_decision_ref`) on the blocker row, **not** on the decision. The decision is the truth; the blocker is the dependent.
- Optimistic UI is allowed but must reconcile on the next snapshot; a snapshot that shows the blocker still present overrides the optimistic resolution.

### 6.4 Competition with the autonomy class-gate work — **NONE**

`blocker_input` is an answer kind, not a risk class. The class gate in §3.1 (`AUTO` / `AUTHORIZE`) is re-derived server-side at work-order compose time. A blocker-input-sourced work order goes through the **exact same** gate as a decision-answered work order. Earned autonomy (§3.2) evaluates *work-classes*, which are surfaces of change in client repos — not answer kinds. So adding blocker resolution does not introduce a new gated class.

### 6.5 The amendment-window risk (touching the Bible while Phase 5 is mid-flight) — **LOW**

The amendment touches §2 lexicon, §4.1, §4.2, §4.8, §4.10, §5.2.4, §8.6, §9 (F2 + F3 exit criteria). Phase 5 lives in §4.7 (migration 016 `cc_decision_email_sends`), §5.6 (Decisions page), §6.5 (webhook inbound for email), and §9 F5. **Zero section overlap.** Merge conflicts are not a structural risk; coordination cost is one commit message.

### 6.6 The "decisions, but with a bigger textarea" failure mode — **HIGH conceptual** (per oracle)

The single largest implementation risk is treating blockers as "decisions where the answer field accepts free text." That would (a) admit free-text into the change_spec assembly path (§3.4 violation), (b) collapse the seven `resolution_action` paths into one, and (c) require the operator to type their way through resolution instead of clicking.

Mitigation (must be stated in the amendment): **every blocker resolution is either an enumerated pick (`link_decision`, `mark_external`, `mark_predecessor`, `leave_blocked`) or a typed-value form whose schema is server-defined per `reason_kind`. There is no free-text resolution path. Ever.** The free-text `blocker` from the client snapshot is *evidence on the blocker row*, never a *resolution input*.

---

## 7. Cross-checks against the Bible's invariants

| Invariant (Bible reference) | Does the amendment preserve it? | How |
|---|---|---|
| Federated boundary (§2.1) | ✅ Yes | Blockers live in `cc_issues` (control plane); detail comes via `cc_export_detail()`; write-back via `cockpit-writeback` → `cc_apply_blocker_resolution()` on the client plane. No live join. |
| Build target bound server-side (§2.1) | ✅ Yes | Blocker-input work orders inherit the same compose path; `target_repo` is read from `registry_app_repo`. No blocker payload accepts a repo field. |
| Customer/agent input never instructional (§3.4) | ✅ Yes | Free-text `blocker` text is classification evidence only; classifier is server-side; resolution is enumerated. |
| Resolution where seen (§1.3, principle 1) | ✅ Yes | Resolution happens in the Review Blockers slide-over on the home (or the embedded cockpit equivalent). No "/blockers" nav page. |
| Earned autonomy per class (§3.2) | ✅ Yes | `blocker_input` is an answer kind. Risk class is re-derived. The same gate applies. |
| No anon grants on write-path tables (§4) | ✅ Yes | The amendment changes no table grants; `cc_decision_answers` is already service_role-only. |
| One press for AUTHORIZE (§3.1) | ✅ Yes | A blocker that composes an AUTHORIZE work order pauses for one press at the standard `pending_authorization` gate. |

---

## 8. Did I push this? Is this the best way? — Mandatory self-critique gate

### 8.1 Steelman the opposite — argue for SEPARATE BUILD

If I had to defend the separate-build position, the strongest case looks like this:

> "Blocked Work" is not one product feature; it is a family of workflows — decision-dependency, missing-input, predecessor-dependency, external-dependency, credential rotation, predecessor sync, and (worst) the *unclassified* free-text reason that defies categorization. Building this into the Bible commits the architecture to a taxonomy that may not survive contact with QEP's 47 real reasons. A separate doc lets the team prototype the classifier against the real corpus first, learn what taxonomy actually emerges from the data, and *then* fold the proven taxonomy into the Bible as a clean amendment. Building it directly as an amendment risks the Bible carrying a half-right enum that later requires a migration to fix.
>
> Furthermore: F5 is mid-flight. Three sibling agents are doing UX, Data/Contracts, and CEO-priority work *right now*. The Bible's TOC is contested ground. A separate `BLOCKED_WORK_BUILD.md` (parallel to `PHASE_5_EMAIL_DECISION_ENGINE.md`) is exactly the pattern this project already uses for active slices — Phase 5 itself lives in a sibling doc, not inline in the Bible's body. Why should this be different?

That second argument is the strongest one and it almost moved me.

### 8.2 Why I held the amendment verdict

**On the "let the taxonomy emerge from the data" argument:** sound for any *new* taxonomy. But §5.2.4 already commits the Bible to four reason groups (awaiting decision, missing input, behind predecessor, blocked externally). Those four are tested by §5.2.4's UI copy ("{K} of these clear the moment you answer the open decisions" — that copy *only* works if `awaiting_decision` is a recognized class). The taxonomy is not novel; it's already half-published. Adding `credential_or_access` and `unclassified` (the honest interim bucket) covers the empirical edge cases without abandoning the published commitments.

**On the "Phase 5 lives in a sibling doc" argument:** Phase 5 lives in a sibling doc *for the implementation* (Slices 1–4 spec, migration drafts, OAuth setup). The **Bible's §4.7, §5.6, §6.5, §9 F5 still hold the architecture-level statements about Phase 5.** The sibling doc is execution; the Bible is architecture. Blocked Work needs an architecture-level statement (the Bible) AND an execution-level statement (a future implementation doc). This report is the architecture-level statement; an implementation doc later is fine.

So the right pattern is:

1. **This report** → architecture-fit verdict (amendment)
2. **A future amendment** → splice the architecture-level statements into the Bible (the §2, §4, §5.2.4, §8.6, §9 edits diff'd in §4 of this report)
3. **A future implementation doc** (sibling to `PHASE_5_EMAIL_DECISION_ENGINE.md`, name TBD: maybe `F2_F3_BLOCKED_WORK_BUILD.md`) → owns the migration drafts, classifier prompts, UI builds, and slice rollout

The separate-build verdict would collapse 1 and 3 into one doc and *skip* 2 — which is exactly the failure mode of letting §1.3 erode quietly.

### 8.3 The biggest concrete risk of integrating into the Bible

The biggest risk is **phase-order surprise**: if F2-Blockers is announced as a slice inside F2 and an implementer reads the Bible's F2 exit criteria and finds blocker work nestled in there, they may treat it as a hard dependency. F2 base (item-level decisions) is *not* blocked by blocker work; the order is base-first, blockers-second. The amendment text must explicitly say:

> "F2-Blockers is a *parallel slice* inside F2, not a sequential prerequisite. F2 exit is reached when the F2 base (item-level decisions) AND F2-Blockers (item-level blockers, four non-runner resolution actions) are both green. They can be built concurrently."

Without this explicit framing, an implementer could (a) start blockers before the F2 contract pattern is set on decisions, getting two slightly different `cc_export_detail()` shapes — or (b) wait for blocker work before declaring F2 done. Both are wrong; the amendment must state the parallel-slice framing.

### 8.4 The biggest concrete risk of forking off

The biggest risk of forking is **slow architectural drift**. A separate `BLOCKED_WORK_BUILD.md` will (a) reference the Bible for §1.3 once, then move on; (b) make its own UI calls that gradually diverge from the home/cockpit grammar; (c) build its own resolution surface that competes with §5.2.4; (d) and within two phases the Bible's TOC has a §5.2.4 stub that says "see BLOCKED_WORK_BUILD.md for details" — at which point the Bible is no longer the architecture of record.

This failure mode is concrete because we have direct precedent: `COMMAND_CENTER_OS_ROADMAP.md` (Phase 0–6) is *already* superseded by the Bible. Letting a second supersede-able doc appear is the way this project decays from one architecture into many.

### 8.5 Confirmation

**Verdict held: AMENDMENT.** With one refinement compared to my initial draft: the amendment text in §9 must explicitly call F2-Blockers and F3-Blockers *parallel slices*, not nested phases, to prevent phase-order misreading.

---

## 9. What this report does **not** do

- It does not modify `docs/COMMAND_CENTER_MASTER_PLAN.md`. The amendments above are specified for a future PR.
- It does not specify UX, copy, or component breakdowns of the Review Blockers panel — sibling agent owns UX.
- It does not pin contract column types or migration DDL — sibling agent owns Data/Contracts.
- It does not propose a ship order vs. other CEO priorities — sibling agent owns that.
- It does not write code or runner integration.

---

## 10. Summary — what the amendment looks like in one paragraph

The Bible gains a five-sentence §2.4 lexicon paragraph naming Blockers, `reason_kind`, and `resolution_action`. §4.1 gets a comment confirming the symmetric grain rule for `blocked_item`. §4.2 grows a 011a migration repairing the production drift on `answer_kind`. §4.8 pins the `cc_export_detail('blockers')` shape and the `cc_apply_blocker_resolution()` signature. §4.10 adds six audit event types. §5.2.4 is rewritten from prose to a tight `reason_kind` × `resolution_action` matrix with copy. §8.6 grows a paragraph specifically hardening blocker resolution against the two-writer hazard. §9 names F2-Blockers and F3-Blockers as **parallel slices** inside the existing F2 and F3, with explicit exit criteria. Nothing in the Bible is superseded, no new phase is introduced, and the Phase 5 work in flight is untouched.

**End of report.**
