# BlackRock AI Command Center — Home + Shell UI Handoff

**For:** the UI builder
**From:** BlackRock AI (Claude)
**Date:** 2026-05-20
**Companion docs:** `BLACKROCK_COMMAND_CENTER_PLATFORM_ROADMAP.md` (the platform vision), `blackrock-command-center` repo (the live backend)

This is a **functional + data spec**, not a visual design. The visual identity — color, type, density, motion, chrome — is yours to design. What is fixed here is *what the screen must do*, *what data it has*, and *how it must behave*. Design against this, then bring the look back for build.

---

## 1. What you are designing

Two things, as one app:

1. **The app shell** — the navigation frame the whole Command Center lives inside.
2. **The home screen** — the first thing inside that frame: the all-projects view.

**Who uses it:** Brian Lewis, operating alone. He runs ~6 client software apps in parallel (QEP, SCC, Circle of Life, Foundry, +2). This is his cockpit. It is an internal BlackRock AI product — not a client-facing site, not a sales page.

**The platform roadmap's one rule for this screen:** *"never a vanity dashboard."* No hero numbers for decoration, no charts that don't change a decision. This is an instrument. Every pixel earns its place by helping Brian decide what to do next.

---

## 2. The one job: triage

When Brian opens this screen, it must answer one question in under two seconds:

> **What needs me right now, and where is it?**

He does not open this to admire progress. He opens it to find the thing that is blocking a build and go clear it. The screen is a **ranked do-this-now queue first**, a status board second.

If the design makes "what's on fire" obvious before anything else, it works. If he has to hunt for it, it has failed — no matter how good it looks.

---

## 3. The shell

A persistent frame around every screen. Keep it minimal.

**Navigation sections** (only the first is built now; the rest are real future destinations — give them a home in the nav, shown as present-but-inactive, not invented and not hidden):

| Section | Status | What it becomes |
|---|---|---|
| **Home** | Build now | The all-projects view spec'd below |
| **Decisions** | Stub | A cross-app view of every open decision |
| **Agents** | Stub | The build-agent dispatch queue |
| **Apps** | Stub | Per-app cockpit drill-downs (one per client app) |
| **Settings** | Stub | The app registry, integrations, account |

**Shell also carries:** the BlackRock AI mark, the signed-in operator, a sign-out control, and a global data-freshness indicator (see §7).

**Pattern:** Brian's other apps use a collapsible left rail on desktop. Matching that is sensible but your call. On mobile the shell must collapse out of the way — the home is a single scroll (see §9).

---

## 4. The home — three bands, in this order

The home is one vertical screen, three stacked bands. **The order is fixed. The styling is yours.**

```
┌─────────────────────────────────────────┐
│  BAND 1 — "What needs you"               │  ← build now
│  Ranked triage queue, across ALL apps    │
├─────────────────────────────────────────┤
│  BAND 2 — Project grid                   │  ← build now
│  One card per registered app             │
├─────────────────────────────────────────┤
│  BAND 3 — Ambient activity               │  ← stub now
│  Recent events feed (later phase)        │
└─────────────────────────────────────────┘
```

Band 1 is the point of the screen. It comes first and should command the most visual weight. Band 3 is a placeholder for now — leave a designed empty slot, do not build the feed.

---

## 5. Band 1 — the triage queue

A **flat, severity-ranked list of action items pulled from every app**. With one app live today it is all QEP; with six it interleaves. It is *not* grouped by app — it is grouped by *urgency*.

Each item is derived from an app's latest snapshot (see §6 for the data, §8 for the rules). An item is a small card carrying:

- **Which app** — a compact badge (e.g. `QEP`)
- **What's wrong** — one plain-language line: *"7 decisions are waiting on answers"*, *"Linear sync has 2 errors"*, *"No data in 5 hours — QEP may be down"*
- **Severity** — visually unmistakable; three tiers (see §8)
- **One action** — a single button that takes Brian to where he fixes it (see §8, "Actions")

Empty state for Band 1 — design it deliberately and make it feel *earned*, not blank: *"Nothing needs you. Every app is green."* This is a state Brian wants to see; it should feel good, not look broken.

---

## 6. Band 2 — the project grid

**One card per registered app.** Today that is one card (QEP). Design for six. The grid must look right at 1, 3, and 6 cards.

Each card shows that app's honest state at a glance:

- `short_code` + `display_name` + `client_name`
- `lifecycle_phase` (discovery / build / launched / maintenance) and `status` (active / paused / provisioning / archived)
- **Build health** — a green / yellow / red / unknown signal from `build_status`
- **Roadmap progress** — shipped vs total (QEP today: 57 shipped of 174). A bar or ratio, your call — but show *remaining*, not just *done*
- **Open decisions** — the count (QEP: 7)
- **Blocked work** — the count (QEP: 27)
- **Freshness** — how long ago this app last reported (`last_snapshot_at`)

A card is a quiet status object. Tapping it will eventually open that app's cockpit (the **Apps** section). For now the card tap can route to the stubbed cockpit or be inert — your call — but design the affordance.

Card variants you must handle: **live** (has a recent snapshot), **not yet reporting** (registered, `last_snapshot_at` is null), **stale** (snapshot is old), **paused/provisioning** (registered but not active). See §7.

---

## 7. The data — exact contract

The home reads **one database view**: `v_command_center_home`. One row per app. No other query is needed for Bands 1 and 2.

The view is **pre-sorted** by `criticality DESC, short_code ASC` — rely on that order for Band 2. Band 1 needs its own severity sort (§8).

### Columns

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | App id — use as the row key |
| `short_code` | text | `QEP` — stable, short, the badge text |
| `display_name` | text | `QEP OS` |
| `client_name` | text | `Quality Equipment & Parts, Inc.` |
| `status` | text enum | `provisioning` \| `active` \| `paused` \| `archived` |
| `lifecycle_phase` | text enum | `discovery` \| `build` \| `launched` \| `maintenance` |
| `criticality` | integer | Higher sorts first when urgency ties. QEP = 100 |
| `last_snapshot_at` | timestamptz \| null | When the Aggregator last wrote data. **null = never reported** |
| `build_status` | text enum \| null | `green` \| `yellow` \| `red` \| `unknown` |
| `roadmap_counts` | jsonb | `{ ship_state: count }` — see below |
| `decision_counts` | jsonb | `{ status: count }` — see below |
| `sync_health` | jsonb | Linear-sync blob — see below |

### JSON shapes

`roadmap_counts` — keys are roadmap ship-states; any subset may be present:
`not_started`, `in_progress`, `blocked`, `pending_decision`, `shipped`, `deferred`, `na`

`decision_counts` — keys: `open`, `answered`

`sync_health` — keys include: `total_tasks`, `mirrored_tasks`, `error_count`, `pending_count`, `stale_pending_count`, `last_synced_at`, `errors_last_24h`, `blocked_task_count`, `pending_decision_count`, `shipped_count`.

### A real row — QEP, right now

```json
{
  "id": "…uuid…",
  "short_code": "QEP",
  "display_name": "QEP OS",
  "client_name": "Quality Equipment & Parts, Inc.",
  "status": "active",
  "lifecycle_phase": "build",
  "criticality": 100,
  "last_snapshot_at": "2026-05-20T23:04:36Z",
  "build_status": "green",
  "roadmap_counts": {
    "shipped": 57, "in_progress": 20, "not_started": 50,
    "blocked": 27, "pending_decision": 15, "deferred": 5
  },
  "decision_counts": { "open": 7, "answered": 13 },
  "sync_health": {
    "total_tasks": 174, "mirrored_tasks": 171, "error_count": 0,
    "pending_count": 3, "stale_pending_count": 0,
    "last_synced_at": "2026-05-20T22:47:59Z"
  }
}
```

### THE HARD CONSTRAINT — read this twice

**The Command Center holds aggregate counts only. It does NOT hold individual roadmap tasks or individual decisions.** That data lives inside each client app's own separate database, by design (the platform is federated — see the roadmap).

This means:

- Band 1 items are **count-level**: *"7 decisions waiting"* — never a list of the 7 decisions.
- Do **not** design task lists, decision lists, or item tables on the home. The data cannot feed them.
- The action on a triage item is a **deep link out** to where that work actually lives.

If a design needs item-level detail, it belongs in the per-app cockpit (a later phase), not here.

---

## 8. Triage logic — deriving and ranking Band 1

For each app row, derive zero or more triage items, then sort all items across all apps by severity, then by `criticality` descending.

### Severity tiers

**CRITICAL — the app is broken or blind**
- `build_status` = `red`
- `sync_health.error_count` > 0  → *"Linear sync has N errors"*
- `last_snapshot_at` is older than ~3 hours, or null while `status` = `active` → *"No data in N hours — APP may be down"* (the Aggregator runs hourly; 3h of silence is wrong)

**NEEDS YOU — a build is blocked on a human answer**
- `decision_counts.open` > 0 → *"N decisions waiting on answers"* — this is the highest-value action on the screen; answering decisions is the thing only Brian/owners can do, and it unblocks queued work
- `build_status` = `yellow`

**WATCH — slipping, not yet urgent**
- `roadmap_counts.blocked` > 0 → *"N items blocked"* (context: some are blocked by the open decisions above — do not make this shout louder than the decisions)
- `sync_health.stale_pending_count` > 0 → *"N roadmap items haven't synced"*
- `build_status` = `unknown`

An app that is `green`, reporting fresh, with `open` = 0 and `error_count` = 0 produces **no triage items**. That is the goal state.

### Actions — where each item links

The control plane has no item detail, so every action deep-links to the app's own surface. Targets:

- **Decisions** → the app's Decision Inbox (QEP: `https://qep.blackrockai.co` — decisions area)
- **Sync errors / stale sync** → the app's Linear workspace, or its sync-health view
- **Stale snapshot / build red** → the app itself, to check it's up

> **Note for build:** a per-app `app_url` is not yet a registry column. For now QEP's URL is `https://qep.blackrockai.co`. Treat the deep-link base as a per-app config value; the registry will gain an `app_url` field so this becomes data-driven. Stub it cleanly.

---

## 9. States you must design

| State | When | Treatment |
|---|---|---|
| **Loading** | First query in flight | Skeleton of both bands — never a blank screen or a bare spinner |
| **Error** | The `v_command_center_home` query failed | Clear, honest message + a Retry. This is the home; it must degrade with dignity |
| **All clear** | No triage items | Band 1 shows the earned-calm empty state (§5) |
| **App: not yet reporting** | `last_snapshot_at` is null | Band 2 card: *"Connected — awaiting first snapshot."* Not an error |
| **App: stale** | `last_snapshot_at` is old | Band 2 card visibly de-emphasized + a staleness label; also a CRITICAL Band 1 item |
| **App: paused / provisioning** | `status` ≠ `active` | Band 2 card shown, clearly set apart; produces no triage items |
| **Multi-app** | 1 today, up to 6 | Bands must hold up at 1, 3, and 6 apps without redesign |

**Freshness is a first-class element.** The aggregator writes hourly. Show, somewhere persistent, when the data was last refreshed, and provide a manual refresh (re-run the query). Realtime updates are a nice-to-have, not required.

---

## 10. Mobile-first

Brian is often on the road. The home is a **single vertical scroll on mobile** — Band 1, then Band 2, then Band 3 — no horizontal scrolling, no hidden tabs for the core content. Triage items and project cards must be fully usable and tappable on a phone. Design mobile first, then expand to desktop.

---

## 11. Tech + access

- **Stack:** React + TypeScript + Tailwind CSS + Vite. Hosting: Netlify or Cloudflare Pages.
- **Backend:** Supabase. The Command Center control-plane project:
  - Project ref: `gsvhuzpysxaegoecwjmf`
  - URL: `https://gsvhuzpysxaegoecwjmf.supabase.co`
  - Publishable (anon) key — safe to ship in the frontend: `sb_publishable_NUCBIao37hJ_ynvlez9BWQ_noaCVkyz`
- **Read the home data** with `supabase-js`:
  ```ts
  const { data, error } = await supabase
    .from('v_command_center_home')
    .select('*');
  ```
  Returns one row per app, already ordered. That single call powers Bands 1 and 2.
- **Auth:** the view requires an authenticated session — build a **login screen** (Supabase Auth, email + password, MFA). The Command Center is Brian-only for now; account creation is handled outside the app. No public/anonymous access to the home.
- **No secrets in the frontend** beyond the publishable key. The control plane never exposes a service-role key to the browser.

---

## 12. What's fixed vs. what's yours

**Fixed — design around these, don't change them:**
- The three-band order: triage queue → project grid → ambient.
- Triage-first: Band 1 leads and dominates.
- The data contract in §7 and the aggregate-only constraint.
- Deep-link-out actions; no item-level lists on the home.
- Mobile-first single scroll.
- Auth-gated.

**Yours — own these completely:**
- The entire visual identity: color, typography, density, spacing, motion.
- How severity reads visually (color, icon, weight — your system).
- Card design, grid behavior, the nav chrome, the empty states.
- Dark vs light (an always-on ops console leans dark, but your call).
- Anything not constrained above.

---

## 13. Done looks like

Brian opens the URL, signs in, and within ~2 seconds:

1. He sees a **ranked list of what needs him** across every app — most urgent first.
2. He sees a **card per app** with honest health and real progress.
3. He can tell **how fresh** the data is.
4. Every triage item has **one obvious action** that gets him to the fix.
5. Nothing on the screen is decorative, and nothing reads green that isn't.

Bring back the visual design against this spec and we'll build it.
