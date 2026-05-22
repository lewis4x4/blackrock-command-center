# Phase 5 UX Recon: Frictionless Decision Capture

**Status:** Draft / Recon
**Context:** This report defines the visual specs, copy, and layout for Phase 5 of the BlackRock AI Command Center OS roadmap. Phase 5 introduces outbound client emails, magic-link confirmations, and the operator's queue for free-text reply extractions.

This document serves as the design specification for four primary surfaces: the outbound decision email, the magic-link confirm page, the operator confirm queue, and the decision states in the Command Center UI.

---

## 1. The Outbound Decision Email (The 5-Slot Card)

The email must be treated as a high-value, single-purpose instrument. It is not marketing; it is a request for a single unblocking action. It must render perfectly on mobile and degrade gracefully to plain text.

### Structure & Layout

- **From:** `BlackRock AI Command Center <decisions@blackrockai.co>` (or similar sending domain).
- **Reply-To:** The operator’s email (e.g., Brian's email). This ensures accidental "Reply All" or direct outreach bypasses the extraction engine and lands safely in a human inbox.
- **Subject Line:** Must be clear and indicate ownership.
  - *Option A:* `[QEP] You have a decision to answer: Rebate stacking rules`
  - *Option B:* `Action Required: QEP build blocked on rebate stacking decision`
  - *Option C (Recommended):* `[QEP] Quick question to unblock your build: Rebate stacking`

### Visual Hierarchy

1. **Header Band:** 
   - A dark, minimal band matching the Command Center OS (`#0A0C12`).
   - Contains the BlackRock AI logo and the client app badge (e.g., the `QEP` square badge with its associated brand color).
2. **Decision Title:** 
   - Large, high-contrast text (`#E7E9F0` on dark or `#111827` on light).
   - Framed as a single, direct question.
3. **Context Paragraph:** 
   - 1-2 sentences of background context, pulled directly from the QEP decision row.
   - Text color slightly muted (e.g., `#5C6478` or `#4B5563` on light).
4. **Option Buttons (The Magic Links):** 
   - A vertically stacked list of large, distinct buttons.
   - Button color: primary brand accent (e.g., `#7C6FF0`).
   - One button per option. Pressing the button is the *intent* to answer, leading to the confirm page.
5. **Reply Instructions Footer:** 
   - "Prefer to explain? Just reply directly to this email."
6. **Legal / Unsubscribe Footer:** 
   - Standard, muted boilerplate.

### Mobile & Plain-Text Fallback

- **Mobile:** The layout is strictly single-column. Buttons span the full width of the viewport so they are easily tappable with one thumb. No horizontal scrolling.
- **Plain-Text:** Every email includes a `text/plain` multipart fallback. Options are enumerated. 
  - *Footer note:* "Reply with 1, 2, or 3, or type your answer."

### Worked Example: QEP Rebate Stacking

**Subject:** `[QEP] Quick question to unblock your build: Rebate stacking rules`

**Body (HTML/Visual Layout):**

```
[ BlackRock AI ]  [ QEP ]

Can a customer apply a volume rebate and a seasonal discount on the same order?

The checkout engine is ready to deploy, but we need to know how to handle overlapping discount codes. Currently, the system allows both to apply, which could lead to margins dropping below 10%.

[ Yes, allow both discounts to stack ]

[ No, apply only the largest single discount ]

[ No, apply the volume rebate first, then seasonal ]


---------------------------------------------------
Prefer to explain in your own words? Just reply directly to this email.
Sent by the BlackRock AI Command Center.
```

---

## 2. The Magic-Link Confirm Page

When a recipient clicks an option button in the email, they do not instantly commit the answer. The click renders a confirm page; **the explicit button press on the page writes the answer.**

### URL Pattern
`https://blackrockai-command-center.netlify.app/c/<token>`

### Visual Identity
- **Background:** Match the OS (`var(--bg)` / `#0A0C12`).
- **Logo:** Centered BlackRock AI logo at the top.
- **Card:** A single, elevated panel (`var(--panel)`) in the center of the screen, bordered by a subtle line (`var(--line)`). 
- **Tone:** Quiet, functional, respectful of time.

### Security States

#### State A: Unconfirmed (Default)
This is the view immediately after clicking the email link.

- **Header:** `QEP` · `Rebate stacking rules`
- **Highlight:** "You're about to answer:"
- **Selected Option:** **No, apply only the largest single discount** *(Rendered in a highlighted callout box)*
- **Prompt:** "If this is correct, press Confirm. If not, close this tab and click a different option in the original email."
- **Action:** A single, large, primary button: `[ Confirm Answer ]`
- **Footer:** "Need to explain? Reply to the original email instead."

#### State B: Already-Confirmed (Idempotent)
If the link is clicked after the decision was already finalized.

- **Header:** `QEP` · `Rebate stacking rules`
- **Message:** "This decision was already answered (Option 2) on May 21, 2026."
- **Prompt:** "Nothing further is needed. You can close this tab."
- **Action:** None.

#### State C: Expired
If the link is clicked more than 7 days after sending.

- **Header:** `QEP` · `Rebate stacking rules`
- **Message:** "This decision link has expired."
- **Prompt:** "This decision was sent more than 7 days ago. Please reply to the original email and we'll route it to Brian to confirm manually."
- **Action:** None.

#### State D: Invalid Token
Standard 404-style polite page.
- **Message:** "We couldn't find this decision link. It may be malformed or invalid."

---

## 3. The Operator Confirm Queue

When a client replies to the email with free text, an LLM extracts the intent, but it requires operator confirmation. 

### Location
**Recommendation:** **(A) New band on the Decisions nav page at the top.** 
*Rationale:* The Decisions nav page (`/decisions`) is the cross-app register. A `/confirm-queue` page fragments the IA, and a slide-over hides pending extractions until the user clicks into an inbox. A dedicated band at the top of `/decisions` ("Awaiting your confirmation") keeps all decision-related actions centralized while giving extractions the highest visibility.

### Design of the Band
The band sits above the standard decision filters. It lists pending extractions as rich, actionable cards.

**Card Layout:**
- **Context Row:** `[QEP Badge]` · `Rebate stacking rules` · `Reply from Rylee`
- **Original Reply (Full Text):** Rendered in a distinct, inset quote block. 
  - *Example:* "Let's just go with the biggest one. I don't want them double-dipping."
- **LLM Suggestion:** Highlighted below the text.
  - *Example:* **Suggested:** `Option 2: No, apply only the largest single discount`
- **Confidence & Reasoning:** Smaller text next to the suggestion.
  - *Example:* `Confidence: High. Reasoning: Recipient explicitly stated "biggest one" and "no double-dipping".`

**Controls (No Bulk Operations):**
Security-by-friction dictates one-by-one review.
1. **Confirm as suggested:** Primary button. One click locks in the LLM option, commits the answer, and dispatches the work order.
2. **Pick a different option:** A secondary dropdown exposing all enumerated options, with a "Confirm" click to commit.
3. **Reject — ask client to clarify:** A danger/ghost button. Triggers a polite email reply asking the client to choose one of the enumerated options, and logs the action.
4. **Defer:** A ghost button. Snoozes the extraction for 24h.

---

## 4. Decision States (Cockpit & Inbox)

The decision lifecycle must reflect routing and email states across the UI. Every decision row in the cockpit and inbox gains a state badge.

### State Badges & Slide-Over Actions

| State | Badge | Slide-Over Actions / UI |
|---|---|---|
| `unrouted` | `Open` (Amber) | **Route to [Owner]** (Live CTA to trigger the email engine) |
| `routed` | `Sent` (Blue) | **Resend now**, **Cancel routing**. Includes a mini-audit excerpt: *"Sent to Rylee 2 hours ago."* |
| `link_clicked`| `Viewed` (Blue) | **Resend now**, **Cancel routing**, **Nudge to confirm**. Audit excerpt shows link open time. (Soft signal, no hard action required). |
| `awaiting_operator_confirm` | `Needs Review` (Amber) | **Review Extraction** (Deep links to the Decisions nav page confirm band). |
| `answered` | `Answered` (Green)| Read-only confirmation. Shows who answered it (recipient or Brian-via-extraction), the chosen option, and timestamp. |
| `expired` | `Expired` (Red) | **Reroute** (CTA to restart the 7-day timer and send a fresh email). |

---

## 5. Reminder Copy

A cron job sends automated reminders if there is no response.
- **Rules:** Max 2 reminders (at ~3 days and ~6 days). Expires at 7 days.
- **Subject:** `Friendly reminder: [QEP] decision needed`

**Body:**
```
[ BlackRock AI ]  [ QEP ]

Just bubbling this up — we're still waiting on your call regarding:
Rebate stacking rules

[ Yes, allow both discounts to stack ]
[ No, apply only the largest single discount ]
[ No, apply the volume rebate first, then seasonal ]

If you've already answered this, please ignore this email — sometimes our confirmation system runs a few minutes behind.
```

---

## 6. "Lately" Feed Mapping

The ambient activity feed on the Home screen ("Lately") must map Phase 5 milestones into plain, earned-calm English.

**Visible Milestones:**
- `decision_email_sent` → *"You routed a QEP decision to Rylee — waiting for an answer."*
- `decision_answered_by_recipient` → *"Rylee answered the rebate decision — a build can move now."*
- `decision_operator_confirmed` → *"You confirmed Rylee's extracted answer on the rebate decision — a build can move now."*
- `decision_email_bounced` → *"A QEP decision email bounced — check the recipient address."*

**Hidden from Lately (Audit-Log Only):**
The following events are recorded in `cc_audit_events` but never spam the home feed:
- `decision_email_delivered`
- `decision_email_opened`
- `decision_link_visited`
- `decision_extraction_proposed`