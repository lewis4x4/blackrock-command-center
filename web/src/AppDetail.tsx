import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ago, appToneClass, HEALTH, loadAppCockpitDetail, sum,
  type ActivityEvent, type AppDetailPayload, type AppRow, type BuildStatus,
} from './lib';

const emptyDetail: AppDetailPayload = {
  available: false,
  roadmap: { items: [], next_cursor: null },
  decisions: { items: [], next_cursor: null },
  sync: { items: [], next_cursor: null },
};

type DetailState = 'idle' | 'loading' | 'ready' | 'error';

export function AppDetailView({ slug, apps, activity, demo }: { slug: string; apps: AppRow[]; activity: ActivityEvent[]; demo: boolean }) {
  const app = apps.find((row) => row.short_code.toLowerCase() === slug.toLowerCase());
  const [state, setState] = useState<DetailState>('idle');
  const [detail, setDetail] = useState<AppDetailPayload>(emptyDetail);
  const [error, setError] = useState('');

  const appActivity = useMemo(() => {
    if (!app) return [];
    return activity.filter((ev) => ev.app_id === app.id || ev.short_code?.toLowerCase() === app.short_code.toLowerCase()).slice(0, 6);
  }, [activity, app]);

  async function loadDetail() {
    if (!app) return;
    setState('loading');
    setError('');
    try {
      const payload = await loadAppCockpitDetail(app.id, demo, 'all');
      setDetail(payload);
      setState('ready');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDetail(emptyDetail);
      setState('error');
    }
  }

  useEffect(() => {
    void loadDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [app?.id]);

  if (!app) {
    return (
      <section className="band detail-empty">
        <div className="detail-empty-title">No registered app matches “{slug}”.</div>
        <div className="detail-empty-copy">Use the project cards on Home to open a cockpit for a registered app.</div>
        <button className="ghost-btn detail-home" onClick={() => { window.location.hash = '#/'; }}>Back home</button>
      </section>
    );
  }

  return (
    <div className="detail-page">
      <HealthHeader app={app} detail={detail} state={state} onRefresh={loadDetail} />
      {state === 'error' && <InlineError message={error} />}
      {!detail.available && state === 'ready' && (
        <div className="detail-note">{detail.message ?? 'Cockpit detail is not wired for this app yet. Registry health still works.'}</div>
      )}
      <RoadmapBoard items={detail.roadmap.items} loading={state === 'loading'} available={detail.available} />
      <DecisionQueue items={detail.decisions.items} loading={state === 'loading'} available={detail.available} />
      <SyncDetail items={detail.sync.items} loading={state === 'loading'} available={detail.available} />
      <Integrations app={app} />
      <PerAppActivity app={app} activity={appActivity} />
    </div>
  );
}

function HealthHeader({ app, detail, state, onRefresh }: { app: AppRow; detail: AppDetailPayload; state: DetailState; onRefresh: () => void | Promise<void> }) {
  const h = HEALTH[(app.build_status ?? 'unknown') as BuildStatus];
  const total = sum(app.roadmap_counts);
  const shipped = app.roadmap_counts?.shipped ?? 0;
  const open = app.decision_counts?.open ?? 0;
  const blocked = app.roadmap_counts?.blocked ?? 0;
  return (
    <section className="detail-hero">
      <div className="detail-hero-main">
        <div className={'badge detail-badge app-badge ' + appToneClass(app.short_code)}>{app.short_code[0]}</div>
        <div>
          <div className="detail-eyebrow">{app.short_code} cockpit</div>
          <h1>{app.display_name}</h1>
          <p>{app.client_name || 'Client app'} · {app.lifecycle_phase} · updated {ago(detail.last_snapshot_at ?? app.last_snapshot_at) ?? '—'}</p>
        </div>
      </div>
      <div className="detail-hero-actions">
        <span className="detail-key">{detail.key_class ? `data-plane ${detail.key_class}` : detail.available ? 'demo detail' : 'registry only'}</span>
        <button className="refresh" onClick={() => void onRefresh()} disabled={state === 'loading'}>
          {state === 'loading' ? 'Refreshing…' : 'Refresh detail'}
        </button>
      </div>
      <div className="detail-health-grid">
        <Metric label="Build" value={h.t} tone={app.build_status === 'red' ? 'red' : app.build_status === 'yellow' ? 'amber' : 'green'} />
        <Metric label="Roadmap" value={`${shipped}/${total || '—'} shipped`} />
        <Metric label="Decisions" value={String(open)} tone={open ? 'amber' : 'green'} />
        <Metric label="Blocked" value={String(blocked)} tone={blocked ? 'red' : 'green'} />
      </div>
    </section>
  );
}

function Metric({ label, value, tone = '' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="detail-metric">
      <span>{label}</span>
      <b className={tone}>{value}</b>
    </div>
  );
}

function RoadmapBoard({ items, loading, available }: SectionProps) {
  const byStream = groupBy(items, 'stream', 'Unassigned stream');
  return (
    <DetailSection title="Roadmap board" subtitle="Streams, waves, and tasks — read-reflective, not a drag board.">
      {sectionPlaceholder(items, loading, available, 'Roadmap detail is not wired yet. QEP owns which task columns appear here.') ?? (
        <div className="roadmap-board">
          {Object.entries(byStream).map(([stream, rows]) => (
            <div className="roadmap-column" key={stream}>
              <div className="roadmap-column-title">{stream}</div>
              {rows.map((row, i) => <DetailCard key={String(row.id ?? row.title ?? i)} row={row} primary="title" />)}
            </div>
          ))}
        </div>
      )}
    </DetailSection>
  );
}

function DecisionQueue({ items, loading, available }: SectionProps) {
  return (
    <DetailSection title="Decision queue" subtitle="Open app-scoped decisions that unblock work.">
      {sectionPlaceholder(items, loading, available, 'Decision detail is not wired yet. The client app owns the exposed decision fields.') ?? (
        <div className="detail-list">{items.map((row, i) => <DetailCard key={String(row.id ?? i)} row={row} primary="title" />)}</div>
      )}
    </DetailSection>
  );
}

function SyncDetail({ items, loading, available }: SectionProps) {
  return (
    <DetailSection title="Sync detail" subtitle="Linear mirroring and snapshot contract health.">
      {sectionPlaceholder(items, loading, available, 'Sync detail is not wired yet. The client app owns the exposed sync fields.') ?? (
        <div className="detail-list">{items.map((row, i) => <DetailCard key={String(row.id ?? row.source ?? i)} row={row} primary="source" />)}</div>
      )}
    </DetailSection>
  );
}

function Integrations({ app }: { app: AppRow }) {
  const ig = app.integrations ?? {};
  const rows = [
    ['Live', ig.live ?? 0, 'green'],
    ['Demo', ig.demo ?? 0, 'blue'],
    ['Manual-safe', ig.manual_safe ?? 0, 'amber'],
    ['Planned', ig.planned ?? 0, ''],
  ] as const;
  return (
    <DetailSection title="Integrations" subtitle="Registry integration posture for this app.">
      <div className="integration-grid">
        {rows.map(([label, value, tone]) => <Metric key={label} label={label} value={String(value)} tone={tone} />)}
      </div>
    </DetailSection>
  );
}

function PerAppActivity({ app, activity }: { app: AppRow; activity: ActivityEvent[] }) {
  return (
    <DetailSection title="Per-app activity" subtitle="Recent visible audit milestones and exceptions.">
      {activity.length === 0 ? (
        <Placeholder text={`No visible activity for ${app.short_code} yet.`} />
      ) : (
        <div className="detail-list">
          {activity.map((ev, i) => (
            <div className="detail-card activity-card" key={`${ev.occurred_at}-${i}`}>
              <b>{ev.event_type.replace(/_/g, ' ')}</b>
              <span>{ev.actor} · {ago(ev.occurred_at) ?? ''}</span>
            </div>
          ))}
        </div>
      )}
    </DetailSection>
  );
}

type SectionProps = { items: Record<string, unknown>[]; loading: boolean; available: boolean };

function DetailSection({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <section className="band detail-section">
      <div className="band-head">
        <div>
          <div className="band-title">{title}</div>
          <div className="band-sub">{subtitle}</div>
        </div>
      </div>
      <div className="detail-section-body">{children}</div>
    </section>
  );
}

function DetailCard({ row, primary }: { row: Record<string, unknown>; primary: string }) {
  const title = text(row[primary]) ?? text(row.title) ?? text(row.name) ?? 'Untitled item';
  const meta = Object.entries(row)
    .filter(([key, value]) => key !== primary && key !== 'id' && value != null && typeof value !== 'object')
    .slice(0, 5);
  return (
    <div className="detail-card">
      <b>{title}</b>
      {meta.length > 0 && <span>{meta.map(([key, value]) => `${key.replace(/_/g, ' ')}: ${String(value)}`).join(' · ')}</span>}
    </div>
  );
}

function Placeholder({ text: copy }: { text: string }) {
  return <div className="detail-placeholder">{copy}</div>;
}

function InlineError({ message }: { message: string }) {
  return <div className="detail-note error">Detail read failed: {message}</div>;
}

function sectionPlaceholder(items: unknown[], loading: boolean, available: boolean, copy: string): ReactNode | null {
  if (loading) return <Placeholder text="Loading detail…" />;
  if (!available) return <Placeholder text={copy} />;
  if (items.length === 0) return <Placeholder text="No items returned for this section yet." />;
  return null;
}

function groupBy(rows: Record<string, unknown>[], key: string, fallback: string): Record<string, Record<string, unknown>[]> {
  return rows.reduce<Record<string, Record<string, unknown>[]>>((acc, row) => {
    const group = text(row[key]) ?? fallback;
    (acc[group] ??= []).push(row);
    return acc;
  }, {});
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
