import { useState, type ReactNode } from 'react';
import {
  ago, sum, hoursOld, SEV_RANK, SEV_LABEL, HEALTH, colorFor, latelyLine, latelyTone, approveWorkOrder,
  type AppRow, type ActivityEvent, type TriageItem, type BuildStatus, type IssueRow, type TriageSev, type AgentWorkOrder,
} from './lib';
import { CheckSyncPanel, OpenDecisionsPanel, ReviewBlockersPanel, ViewBuildPanel } from './TriagePanels';

/* WIRE-UP: remaining nav sections beyond Home/Decisions/Files/Agents are stubs. */
function stub(name: string) {
  alert(`${name} — section not built yet (current phase: home + shell).`);
}

function appSlug(app: AppRow): string {
  return app.short_code.toLowerCase();
}

/* Primary app action: stay inside the Command Center cockpit. */
function openApp(app: AppRow) {
  window.location.hash = `#/apps/${appSlug(app)}`;
}

function openExternalApp(app: AppRow) {
  if (app.app_url) window.open(app.app_url, '_blank', 'noopener');
  else alert(`No live URL set for ${app.display_name} yet.`);
}

const chevron = (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 18l6-6-6-6" /></svg>
);

/* ============================================================================
   SHELL — left rail + topbar, wraps every view
   ============================================================================ */
export type ShellPage = 'home' | 'decisions' | 'agents' | 'apps' | 'files' | `app:${string}`;

export function Shell({ demo, apps, activePage, onNavigate, onRefresh, children }: {
  demo: boolean;
  apps: AppRow[];
  activePage: ShellPage;
  onNavigate: (page: ShellPage) => void;
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
    Files: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#9099AD" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2z" /><path d="M8 13h8M8 16h5" /></svg>,
    Settings: <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#9099AD" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06A2 2 0 1 1 22 7.09l-.06.06A1.65 1.65 0 0 0 19.4 9c.2.61.78 1 1.42 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>,
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
          {(['Home', 'Decisions', 'Agents', 'Apps', 'Files', 'Settings'] as const).map((name) => {
            const page = name === 'Home' ? 'home' : name === 'Decisions' ? 'decisions' : name === 'Agents' ? 'agents' : name === 'Apps' ? 'apps' : name === 'Files' ? 'files' : null;
            const active = page === activePage;
            return (
              <button
                key={name}
                className={'nav-item' + (active ? ' active' : '')}
                onClick={() => (page ? onNavigate(page) : stub(name))}
              >
                {navIcons[name]}
                <span className="nav-label">{name}</span>
                {!page && <span className="nav-stub">soon</span>}
              </button>
            );
          })}
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
          <div className="page-title">{activePage === 'files' ? 'Files' : activePage === 'agents' ? 'Agents' : activePage === 'apps' ? 'Apps' : activePage === 'decisions' ? 'Decisions' : activePage.startsWith('app:') ? 'Cockpit' : 'Home'}</div>
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
export function HomeView({ apps, issues, activity, workOrders, demo, onResolved }: { apps: AppRow[]; issues: IssueRow[]; activity: ActivityEvent[]; workOrders: AgentWorkOrder[]; demo: boolean; onResolved: () => void | Promise<void> }) {
  const [openItem, setOpenItem] = useState<TriageItem | null>(null);
  const sorted = [...apps].sort((a, b) => b.criticality - a.criticality);
  const appById = new Map(sorted.map((app) => [app.id, app]));

  const triage = issues
    .map((issue) => issueToTriage(issue, appById.get(issue.app_id)))
    .filter((item): item is TriageItem => !!item)
    .sort((a, b) => SEV_RANK[a.sev] - SEV_RANK[b.sev] || b.app.criticality - a.app.criticality || a.issue.surfaced_at.localeCompare(b.issue.surfaced_at));

  const gatedOrders = workOrders
    .filter((order) => order.status === 'gated')
    .sort((a, b) => (appById.get(b.app_id)?.criticality ?? 0) - (appById.get(a.app_id)?.criticality ?? 0) || a.created_at.localeCompare(b.created_at));
  const prOrders = workOrders
    .filter((order) => order.status === 'pr_open')
    .sort((a, b) => (appById.get(b.app_id)?.criticality ?? 0) - (appById.get(a.app_id)?.criticality ?? 0) || (a.pr_opened_at ?? a.created_at).localeCompare(b.pr_opened_at ?? b.created_at));

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

      <TriageBand items={triage} onOpen={setOpenItem} />
      <AwaitingApprovalBand orders={gatedOrders} apps={appById} demo={demo} onApproved={onResolved} />
      <ProjectsBand apps={sorted} />
      <PrReviewBand orders={prOrders} apps={appById} />
      <ActivityBand activity={activity} />
      {openItem && (
        <TriagePanelHost
          item={openItem}
          demo={demo}
          onClose={() => setOpenItem(null)}
          onResolved={() => {
            setOpenItem(null);
            void onResolved();
          }}
        />
      )}
    </>
  );
}

function issueSeverity(severity: IssueRow['severity']): TriageSev {
  if (severity === 'critical') return 'critical';
  if (severity === 'high') return 'needs';
  return 'watch';
}

function issueAction(issueType: IssueRow['issue_type']): string {
  switch (issueType) {
    case 'open_decision': return 'Open decisions';
    case 'build_health': return 'View build';
    case 'blocked_item': return 'Review blockers';
    case 'sync_error': return 'Check sync';
  }
}

function issueToTriage(issue: IssueRow, app?: AppRow): TriageItem | null {
  if (!app || app.status === 'paused' || app.status === 'archived') return null;
  if (!['surfaced', 'triaging', 'gated'].includes(issue.status)) return null;
  return {
    id: issue.id,
    sev: issueSeverity(issue.severity),
    title: issue.title,
    sub: issue.summary ?? `${issue.status.replace(/_/g, ' ')} · ${ago(issue.last_seen_at) ?? 'recently'}`,
    act: issueAction(issue.issue_type),
    app,
    issue,
  };
}

function Cell({ k, v, cls = '', small = false }: { k: string; v: string; cls?: string; small?: boolean }) {
  return (
    <div className="cell">
      <div className="ck">{k}</div>
      <div className={'cv ' + cls} style={small ? { fontSize: 18 } : undefined}>{v}</div>
    </div>
  );
}

function TriagePanelHost({ item, demo, onClose, onResolved }: { item: TriageItem; demo: boolean; onClose: () => void; onResolved: () => void }) {
  const props = { issue: item.issue, app: item.app, onClose, onResolved, demo };
  switch (item.issue.issue_type) {
    case 'open_decision': return <OpenDecisionsPanel {...props} />;
    case 'build_health': return <ViewBuildPanel {...props} />;
    case 'blocked_item': return <ReviewBlockersPanel {...props} />;
    case 'sync_error': return <CheckSyncPanel {...props} />;
  }
}

/* ───────────────────── Band 1 — triage ──────────────────────────────────── */
function TriageBand({ items, onOpen }: { items: TriageItem[]; onOpen: (item: TriageItem) => void }) {
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
          <button className="ghost-btn" onClick={() => { window.location.hash = '#/decisions'; }}>View all decisions {chevron}</button>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="triage-empty">
          <div className="big">Nothing needs you</div>
          <div className="small">Every connected app is green, fresh and unblocked.</div>
        </div>
      ) : (
        items.map((t, i) => (
          <div className={'triage-row ' + t.sev} key={t.id}>
            <div className="rank">{i + 1}</div>
            <div className="badge" style={{ background: colorFor(t.app.short_code) }}>{t.app.short_code[0]}</div>
            <div className="triage-text">
              <div className="triage-title">{t.title}</div>
              <div className="triage-sub">{t.sub}{t.app.sample ? ' · sample' : ''}</div>
            </div>
            <div className={'sev ' + t.sev}>{SEV_LABEL[t.sev]}</div>
            <button className="act-btn" onClick={() => onOpen(t)}>{t.act}</button>
          </div>
        ))
      )}
    </section>
  );
}

/* ───────────────────── Approval band — Phase 4 gated dispatch ───────────── */
function AwaitingApprovalBand({ orders, apps, demo, onApproved }: { orders: AgentWorkOrder[]; apps: Map<string, AppRow>; demo: boolean; onApproved: () => void | Promise<void> }) {
  const [approving, setApproving] = useState<string | null>(null);
  const [error, setError] = useState('');
  if (orders.length === 0) return null;

  async function approve(order: AgentWorkOrder) {
    setApproving(order.id);
    setError('');
    try {
      await approveWorkOrder(order.id, demo);
      await onApproved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApproving(null);
    }
  }

  return (
    <section className="band approval-band">
      <div className="band-head">
        <span className="band-num approval">!</span>
        <div>
          <div className="band-title">Awaiting your approval</div>
          <div className="band-sub">Risky work orders are created, but the daemon cannot claim them until you press approve.</div>
        </div>
        <span className="count-chip">{orders.length}</span>
      </div>
      {error && <div className="approval-error">Approval failed: {error}</div>}
      <div className="approval-grid">
        {orders.map((order) => {
          const app = apps.get(order.app_id);
          const code = app?.short_code ?? order.app.short_code ?? 'APP';
          return (
            <div className="approval-card" key={order.id}>
              <div className="approval-top">
                <div className="badge" style={{ background: colorFor(code) }}>{code[0]}</div>
                <div>
                  <b>{app?.display_name ?? order.app.display_name ?? code}</b>
                  <span>{ago(order.created_at) ?? 'just now'} · {order.risk_class}</span>
                </div>
              </div>
              <div className="approval-intent">{workOrderIntent(order)}</div>
              <div className="approval-reason">Gate: {label(order.gated_reason ?? 'authorize_class')}</div>
              <button className="btn-primary approval-btn" onClick={() => void approve(order)} disabled={approving !== null}>
                {approving === order.id ? 'Approving…' : 'Approve'}
              </button>
            </div>
          );
        })}
      </div>
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
          <button className="ghost-btn" onClick={() => { window.location.hash = '#/apps'; }}>View all apps {chevron}</button>
        </div>
      </div>
      <ProjectGrid apps={apps} />
    </section>
  );
}

export function ProjectGrid({ apps, onEdit }: { apps: AppRow[]; onEdit?: (app: AppRow) => void }) {
  return (
    <div className="grid">
      {apps.map((a) => <AppCard key={a.id} app={a} onEdit={onEdit} />)}
    </div>
  );
}

function AppCard({ app, onEdit }: { app: AppRow; onEdit?: (app: AppRow) => void }) {
  const head = (
    <div className="card-head">
      <div className="badge" style={{ background: colorFor(app.short_code) }}>{app.short_code[0]}</div>
      <div className="card-headtext">
        <div className="card-name">
          {app.display_name}
          {app.sample && <span className="sample-tag">SAMPLE</span>}
        </div>
      </div>
      {onEdit && (
        <button className="external-link app-edit-link" title={`Edit ${app.short_code} basics`} onClick={() => onEdit(app)} aria-label={`Edit ${app.short_code} basics`}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>
        </button>
      )}
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
        <button className="external-link" title={`Open ${app.short_code} production app`} onClick={() => openExternalApp(app)} aria-label={`Open ${app.short_code} production app`}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><path d="M15 3h6v6" /><path d="M10 14L21 3" /></svg>
        </button>
      </div>
    </div>
  );
}

/* ───────────────────── PR review band — Phase 4 firehose mitigation ─────── */
function PrReviewBand({ orders, apps }: { orders: AgentWorkOrder[]; apps: Map<string, AppRow> }) {
  if (orders.length === 0) return null;
  return (
    <section className="band pr-band">
      <div className="band-head">
        <span className="band-num pr">PR</span>
        <div>
          <div className="band-title">PRs ready for review</div>
          <div className="band-sub">Review queue ranked by app criticality, oldest PR first.</div>
        </div>
        <span className="count-chip">{orders.length}</span>
      </div>
      <div className="pr-list">
        {orders.map((order) => {
          const app = apps.get(order.app_id);
          const code = app?.short_code ?? order.app.short_code ?? 'APP';
          return (
            <div className="pr-row" key={order.id}>
              <div className="agents-app">
                <span className="badge" style={{ background: colorFor(code) }}>{code[0]}</span>
                <div>
                  <b>{app?.display_name ?? order.app.display_name ?? code}</b>
                  <span>{code}</span>
                </div>
              </div>
              <div className="pr-text">
                <div className="pr-title">{workOrderIntent(order)}</div>
                <div className="pr-sub">Opened {ago(order.pr_opened_at ?? order.created_at) ?? 'recently'}</div>
              </div>
              {order.pr_url ? <a className="act-btn pr-link" href={order.pr_url} target="_blank" rel="noreferrer">Open PR</a> : <span className="pr-missing">No PR URL</span>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function workOrderIntent(order: AgentWorkOrder): string {
  return textValue(order.change_spec.intent) ?? textValue(order.change_spec.title) ?? 'Untitled work order';
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function label(value: string): string {
  return value.replace(/_/g, ' ');
}

/* ───────────────────── Band 3 — activity feed ───────────────────────────── */
function ActivityBand({ activity }: { activity: ActivityEvent[] }) {
  return (
    <section className="band">
      <div className="band-head">
        <span className="band-num">3</span>
        <div>
          <div className="band-title">Lately</div>
          <div className="band-sub">Milestones and exceptions — the routine green is in Settings.</div>
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
            const [sentence, show] = latelyLine(ev);
            if (!show) return null;
            const sc = ev.short_code ?? '—';
            const tone = latelyTone(ev);
            return (
              <div className={'feed-row ' + tone} key={i}>
                <div className="feed-ico">
                  <div className="badge" style={{ width: 24, height: 24, fontSize: 10, background: colorFor(sc) }}>{sc[0]}</div>
                </div>
                <div className="feed-text">
                  <div className="feed-title">{sentence}</div>
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
