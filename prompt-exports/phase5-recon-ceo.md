# Phase 5 CEO Strategic Frame — Email Decision Engine

## §1. The strategic frame — why Phase 5 matters

Phase 5 turns the Command Center from an internal operator cockpit into a client-facing decision loop. Today the platform can show Brian where a build is blocked; Phase 5 lets him send that blocker to the right business owner, get an answer back, confirm it safely, and move the build without chasing email threads or carrying status in his head. Phase 5 closes the missing client side of the loop: "operator sees a decision needs answering" → "client answers it themselves" → "build moves."

## §2. The MVP — ship outbound + button-confirm only

**Must ship in v1.0:**
- Outbound email send via Resend (Brian clicks "Route to client," client receives credible email).
- Magic-link confirm page (security-critical: click renders page, button press commits).
- One operator confirm queue (visibility + reply path foundation).
- Work-order dispatch on confirmed answer.

**Maybe ship if cheap:**
- Branded MJML template (clean simple template OK for friendly-client v1).
- Reminder cron (manual nudges acceptable for week-one).

**Cut to v1.1+:**
- Bulk routing, deliverability dashboards, per-client template customization, A/B subject lines, weekly digest emails.
- **Full free-text reply extraction if Slice 1 proves button-confirm is enough.**

Rationale: v1.0 should prove the business behavior — a real QEP decision can leave Brian's cockpit, reach the right person, come back confirmed, and unblock work. Don't pay complexity tax for reply parsing until real recipients prove they won't click the button.

## §3. Operator vs agent task breakdown

**Brian's tasks (operator clicks):**
- Sign up for Resend, verify sending domain `decisions.blackrockai.co`, DKIM/SPF/DMARC.
- Generate Resend API key + inbound webhook secret.
- One or two `supabase secrets set` commands.
- Send first real route from cockpit, confirm it lands in inbox.
- Click through confirm flow as himself/one friendly client.
- Live with it one week before greenlighting v1.1.

**Agent slice work:**
- Schema migration (`cc_decision_email_sends` + state machine).
- 6 edge functions (route, confirm-page, confirm-submit, resend-webhook, extract-reply, confirm-extraction).
- Reminder cron (defer if Slice 1 enough).
- Frontend: confirm queue band on Decisions page, decision-state badges, "Route to client" wired, "Lately" mapping.

**Effort: 2-3 agent slices. Half-day per slice for focused agents. Ballpark 1–1.5 agent-days plus DNS waiting time.**

## §4. Sub-phase sequence

1. **Slice 1 — Outbound only** (button confirm only, no inbound). Route button works → email lands → recipient clicks confirm → answer commits → work order dispatches. **Enough for friendly-client rollout.**

2. **Slice 2 — Inbound + extraction + confirm queue.** Replies captured, LLM maps free text to options, Brian confirms before commit.

3. **Slice 3 — Reminders + expiry + polish.** Reminder cron, expired tokens, better email design, metrics dashboard.

Business sequencing logic: prove clients click buttons FIRST → support messy human replies SECOND → automate follow-up LAST. If Slice 1 works for 90%+ of recipients, Slice 2 can wait.

## §5. Business risks

**Deliverability damage**: misconfigured domain → spam. Use dedicated subdomain `decisions.blackrockai.co`, warm up with low volume, start with Brian + one friendly QEP recipient.

**Client confusion**: first email must explain itself in one line. Recommended copy: "This is from Brian Lewis; your answer routes directly back to me and unblocks the QEP build."

**Trust erosion**: highest risk is extraction APPEARS to work and commits the wrong answer → "you built the wrong thing because your AI misunderstood me." The confirm queue is the trust-preservation mechanism, not polish.

**Operator overload**: Phase 5 can turn Brian into bottleneck. v1.0 rule: button confirmations commit; free-text replies require Brian confirm. Future rule (out of v1.0): high-confidence extraction may auto-commit during business hours, never for AUTHORIZE/destructive/production.

**Wrong owner routing**: live QEP decisions show this — rebate-stacking is operator-classified (Brian/Rylee); others (Q7 prospect-quote, Q12 Mail consent) may be business-owner. Cockpit needs "route" to be deliberate, not automatic.

## §6. Success metrics

- **Decisions routed per week** — adoption.
- **Median time `routed` → `answered`** — core business metric. Days of chasing → hours = working.
- **Button answers vs reply answers** — button = low friction; reply = needs extraction.
- **LLM extraction acceptance rate** — % Brian accepts as-is.
- **Bounces / spam reports** — any spam = stop sign.
- **Brian confirm-queue clear time** — target <2 min/item.

## §7. Stop conditions

- After Slice 1: if magic-link works for 90%+ recipients, defer Slice 2 for months.
- After Slice 2: if confirm queue >10 items/day, build auto-confirm rules before Slice 3.
- Stop all feature work if deliverability weak / spam reports / client confusion.
- Don't scale to all clients until owner mapping is reliable.

## §8. Honest blockers

- Resend account + verified domain (operator-clickable, DNS verification hours).
- Sending domain: `decisions.blackrockai.co` recommended.
- LLM API choice + soft monthly cap (Slice 2 only).
- One real-world test recipient (Brian or single friendly QEP owner).
- Clear owner classification per decision.

## Executive recommendation

**Build Phase 5, but ship Slice 1 outbound/button-confirm as the CEO-safe MVP.** Real value this week, low trust risk, no extraction ambiguity, clear stop condition. Let actual recipient behavior decide whether free-text reply parsing is worth the next investment.
