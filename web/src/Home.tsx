import { useState, type ReactNode } from 'react';
import {
  ago, sum, hoursOld, deriveTriage, SEV_RANK, SEV_LABEL, HEALTH, colorFor, activityLine,
  type AppRow, type ActivityEvent, type TriageItem, type BuildStatus,
} from './lib';

/* WIRE-UP: nav sections beyond Home are stubs — route to /<section> later. */
function stub(name: string) {
  alert(`${name} — section not built yet (current phase: home + shell).`);
}

/* Deep link into an app's own surface (registry_apps.app_url). */
function openApp(app: AppRow) {
  if (app.app_url) window.open(app.app_url, '_blank', 'noopener');
  else alert(`No live URL set for ${app.display_name} yet.`);
}

const chevron = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
);

/* ============================================================================
   SHELL — left rail + topbar, wraps every view
   ============================================================================ */
export function Shell({ demo, apps, onRefresh, children }: {
  demo: boolean;
  apps: AppRow[];
  onRefresh: () => void | Promise<void>;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [spinning, setSpinning] = useState(false);

  const newest = apps
    .map((a) => a.last_snapshot_at)
    .filter((s): s is string => !!s)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0];

  async function refresh() {
    setSpinning(true);
    try { await onRefresh(); }
    finally { setTimeout(() => setSpinning(false), 700); }
  }

  const navIcons: Record<string, ReactNode> = {
    Home: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#9099AD" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /></svg>,
    Decisions: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#9099AD" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></svg>,
    Agents: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#9099AD" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M12 8V4M9 14h.01M15 14h.01" /></svg>,
    Apps: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#9099AD" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>,
    Settings: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#9099AD" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.2.61.78 1 1.42 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>,
  };

  return (
    <div className="shell">
      <aside className={'rail' + (collapsed ? ' collapsed' : '')}>
        <div className="brand">
          <div className="brand-mark">
            <svg width="16" height="16" viewBox="0 0 16 16"><path d="M3 3h10v4H7v6H3V3z" fill="#fff" /></svg>
          </div>
          <div className="brand-text">
            <div className="brand-name">BlackRock AI</div>
            <div className="brand-sub">COMMAND CENTER</div>
          </div>
        </div>
        <nav>
          {(['Home', 'Decisions', 'Agents', 'Apps', 'Settings'] as const).map((name) => (
            <button
              key={name}
              className={'nav-item' + (name === 'Home' ? ' active' : '')}
              onClick={() => (name === 'Home' ? undefined : stub(name))}
            >
              {navIcons[name]}
              <span className="nav-label">{name}</span>
              {name !== 'Home' && <span className="nav-stub">soon</span>}
            </button>
          ))}
        </nav>
        <div className="rail-foot">
          <button className="collapse-btn" onClick={() => setCollapsed((c) => !c)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
            <span className="rail-foot-label">Collapse</span>
          </button>
        </div>
      </aside>

      <div className="main">
        <div className="topbar">
          <div className="topbar-inner">
          <div className="page-title">Home</div>
          <div className="topbar-right">
            <div className="mode-pill">
              <span className="dot" style={{ background: demo ? 'var(--amber)' : 'var(--green)' }} />
              <span>{demo ? 'Demo data' : 'Live · control plane'}</span>
            </div>
            <div className="fresh-pill">
              <span className="dot" style={{ background: 'var(--green)' }} />
              <span>Updated {ago(newest) ?? '—'}</span>
            </div>
            <button className={'refresh' + (spinning ? ' spin' : '')} onClick={() => void refresh()}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M23 4v6h-6M1 20v-6h6" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>
              Refresh
            </button>
          </div>
          </div>
        </div>
        <div className="content">{children}</div>
      </div>
    </div>
  );
}

/* ============================================================================
   HOME — portfolio strip + three bands
   ============================================================================ */
export function HomeView({ apps, activity }: { apps: AppRow[]; activity: ActivityEvent[] }) {
  const sorted = [...apps].sort((a, b) => b.criticality - a.criticality);

  const triage: TriageItem[] = [];
  sorted.forEach((a) => triage.push(...deriveTriage(a)));
  triage.sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev] || b.app.criticality - a.app.criticality);

  const active = sorted.filter((a) => a.status === 'active').length;
  const openDec = sorted.reduce((n, a) => n + (a.decision_counts?.open ?? 0), 0);
  const blocked = sorted.reduce((n, a) => n + (a.roadmap_counts?.blocked ?? 0), 0);
  const anyRed = sorted.some((a) => a.build_status === 'red');
  const anyYel = sorted.some((a) => a.build_status === 'yellow');
  const pf = anyRed
    ? { t: 'Attention', c: 'red' }
    : anyYel
      ? { t: 'Watch', c: 'amber' }
      : { t: 'Good', c: 'green' };

  return (
    <>
      {/* Portfolio strip — all derived from v_command_center_home */}
      <div className="strip">
        <Cell k="Apps" v={String(sorted.length)} />
        <Cell k="Active" v={String(active)} />
        <Cell k="Triage" v={String(triage.length)} cls={triage.length ? 'amber' : 'green'} />
        <Cell k="Decisions" v={String(openDec)} cls={openDec ? 'amber' : ''} />
        <Cell k="Blocked" v={String(blocked)} cls={blocked ? 'red' : ''} />
        <Cell k="Health" v={pf.t} cls={pf.c} small />
      </div>

      <TriageBand items={triage} />
      <ProjectsBand apps={sorted} />
      <ActivityBand activity={activity} />
    </>
  );
}

function Cell({ k, v, cls = '', small = false }: { k: string; v: string; cls?: string; small?: boolean }) {
  return (
    <div className="cell">
      <div className="ck">{k}</div>
      <div className={'cv ' + cls} style={small ? { fontSize: 18 } : undefined}>{v}</div>
    </div>
  );
}

/* ───────────────────── Band 1 — triage ──────────────────────────────────── */
function TriageBand({ items }: { items: TriageItem[] }) {
  return (
    <section className="band">
      <div className="band-head">
        <span className="band-num">1</span>
        <div>
          <div className="band-title">What needs you</div>
          <div className="band-sub">Severity-ranked triage across every app</div>
        </div>
        <span className="count-chip">{items.length}</span>
        <div className="band-action">
          <button className="ghost-btn" onClick={() => stub('Decisions')}>View all decisions {chevron}</button>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="triage-empty">
          <div className="big">Nothing needs you</div>
          <div className="small">Every connected app is green, fresh and unblocked.</div>
        </div>
      ) : (
        items.map((t, i) => (
          <div className={'triage-row ' + t.sev} key={i}>
            <div className="rank">{i + 1}</div>
            <div className="badge" style={{ background: colorFor(t.app.short_code) }}>{t.app.short_code[0]}</div>
            <div className="triage-text">
              <div className="triage-title">{t.title}</div>
              <div className="triage-sub">{t.sub}{t.app.sample ? ' · sample' : ''}</div>
            </div>
            <div className={'sev ' + t.sev}>{SEV_LABEL[t.sev]}</div>
            <button className="act-btn" onClick={() => openApp(t.app)}>{t.act}</button>
          </div>
        ))
      )}
    </section>
  );
}

/* ───────────────────── Band 2 — projects ────────────────────────────────── */
function ProjectsBand({ apps }: { apps: AppRow[] }) {
  return (
    <section className="band">
      <div className="band-head">
        <span className="band-num">2</span>
        <div>
          <div className="band-title">Projects</div>
          <div className="band-sub">Every registered app — health, progress, freshness</div>
        </div>
        <div className="band-action">
          <button className="ghost-btn" onClick={() => stub('Apps')}>View all apps {chevron}</button>
        </div>
      </div>
      <div className="grid">
        {apps.map((a) => <AppCard key={a.id} app={a} />)}
      </div>
    </section>
  );
}

function AppCard({ app }: { app: AppRow }) {
  const head = (
    <div className="card-head">
      <div className="badge" style={{ background: colorFor(app.short_code) }}>{app.short_code[0]}</div>
      <div className="card-headtext">
        <div className="card-name">
          {app.display_name}
          {app.sample && <span className="sample-tag">SAMPLE</span>}
        </div>
      </div>
      <span className={'pill ' + app.status}>{app.status.toUpperCase()}</span>
    </div>
  );

  if (app.status === 'provisioning') {
    return (
      <div className="card">
        {head}
        <div className="card-prov">
          Registered — awaiting first snapshot.<br />
          It joins the board automatically once the Aggregator reaches it.
        </div>
      </div>
    );
  }

  const total = sum(app.roadmap_counts);
  const shipped = app.roadmap_counts?.shipped ?? 0;
  const pct = total ? Math.round((shipped / total) * 100) : 0;
  const h = HEALTH[(app.build_status ?? 'unknown') as BuildStatus];
  const fresh = ago(app.last_snapshot_at);
  const old = hoursOld(app.last_snapshot_at);
  const freshClass = !fresh ? 'muted' : old! > 3 ? 'red' : old! > 1.5 ? 'amber' : 'green';
  const open = app.decision_counts?.open ?? 0;
  const blk = app.roadmap_counts?.blocked ?? 0;
  const ig = app.integrations ?? {};
  const igLive = ig.live ?? 0;
  const igTot = sum(ig);
  const d = app.momentum?.shipped_delta;

  return (
    <div className="card">
      {head}
      <div className="card-sep" />
      <div className="row2">
        <span className="k">Client</span>
        <span title={app.client_name || undefined} style={{ fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{app.client_name || '—'}</span>
      </div>
      <div className="row2">
        <span className="k">Lifecycle</span>
        <span style={{ textTransform: 'capitalize', fontWeight: 600 }}>{app.lifecycle_phase}</span>
      </div>
      <div className="row2">
        <span className="k">Build health</span>
        <span className="health"><span className="dot" style={{ background: h.c }} />{h.t}</span>
      </div>
      <div className="row2">
        <span className="k">Integrations</span>
        <span className="health">
          <span className="dot" style={{ background: igLive ? 'var(--green)' : 'var(--grey)' }} />
          {igLive} live · {igTot} total
        </span>
      </div>
      <div className="prog-top">
        <span className="prog-label">Roadmap progress</span>
        <span className="prog-val"><b>{shipped}</b> / {total} shipped</span>
      </div>
      <div className="bar"><i style={{ width: pct + '%' }} /></div>
      <div className="prog-foot">
        <span>{pct}% · {total - shipped} remaining</span>
        {d != null && (
          d > 0
            ? <span className="delta up">+{d} since last</span>
            : d < 0
              ? <span className="delta">{d} since last</span>
              : <span className="delta flat">no change</span>
        )}
      </div>
      <div className="card-sep" />
      <div className="row2">
        <span className="k">Open decisions</span>
        <span style={{ fontWeight: 700, whiteSpace: 'nowrap', color: open ? 'var(--amber)' : 'var(--text)' }}>{open}</span>
      </div>
      <div className="row2">
        <span className="k">Blocked work</span>
        <span style={{ fontWeight: 700, whiteSpace: 'nowrap', color: blk ? 'var(--red)' : 'var(--text)' }}>{blk}</span>
      </div>
      <div className="row2">
        <span className="k">Last snapshot</span>
        <span style={{ fontWeight: 700, whiteSpace: 'nowrap', color: freshClass === 'muted' ? 'var(--text-3)' : `var(--${freshClass})` }}>{fresh ?? '—'}</span>
      </div>
      <div className="card-foot">
        <button className="open-link" onClick={() => openApp(app)}>Open {app.short_code} {chevron}</button>
      </div>
    </div>
  );
}

/* ───────────────────── Band 3 — activity feed ───────────────────────────── */
function ActivityBand({ activity }: { activity: ActivityEvent[] }) {
  return (
    <section className="band">
      <div className="band-head">
        <span className="band-num">3</span>
        <div>
          <div className="band-title">Activity</div>
          <div className="band-sub">Recent control-plane events — aggregator runs, snapshots, registrations</div>
        </div>
        <div className="band-action">
          <button className="ghost-btn" onClick={() => stub('Settings')}>Audit log {chevron}</button>
        </div>
      </div>
      <div className="feed">
        {activity.length === 0 ? (
          <div className="feed-empty">No activity recorded yet.</div>
        ) : (
          activity.map((ev, i) => {
            const [title, meta] = activityLine(ev);
            const sc = ev.short_code ?? '—';
            return (
              <div className="feed-row" key={i}>
                <div className="feed-ico">
                  <div className="badge" style={{ width: 24, height: 24, fontSize: 10, background: colorFor(sc) }}>{sc[0]}</div>
                </div>
                <div className="feed-text">
                  <div className="feed-title">{sc} — {title}</div>
                  <div className="feed-meta">{meta}</div>
                </div>
                <div className="feed-time">{ago(ev.occurred_at) ?? ''}</div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
