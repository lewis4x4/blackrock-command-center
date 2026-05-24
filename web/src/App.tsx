import { useEffect, useRef, useState } from 'react';
import {
  INITIAL_DEMO, loadHome, loadActivity, loadAgents,
  type AppRow, type ActivityEvent, type IssueRow, type AgentWorkOrder,
} from './lib';
import { Shell, HomeView, type ShellPage } from './Home';
import { FilesView, type FilesViewHandle } from './Files';
import { AppDetailView } from './AppDetail';
import { AgentsView, type AgentsViewHandle } from './Agents';
import { DecisionsView, type DecisionsViewHandle } from './Decisions';
import { AppsView } from './Apps';
import { SettingsView, type SettingsViewHandle } from './Settings';
import { Workspace } from '@blackrock-ai/agent-core';
import { tenantConfig } from './agent.config';

/* Tiny hash switch until F1's router lands. Keeps Files link-shareable without adding react-router. */
type LoadState = 'loading' | 'error' | 'ready';

function pageFromHash(): ShellPage {
  const hash = window.location.hash || '#/';
  if (hash === '#/decisions') return 'decisions';
  if (hash === '#/settings') return 'settings';
  if (hash === '#/agents') return 'agents';
  if (hash === '#/files') return 'files';
  if (hash === '#/workspace') return 'workspace';
  const appMatch = hash.match(/^#\/apps\/([a-z0-9_-]+)$/i);
  if (appMatch?.[1]) return `app:${appMatch[1].toLowerCase()}`;
  if (hash === '#/apps') return 'apps';
  return 'home';
}

function hashForPage(page: ShellPage): string {
  if (page === 'decisions') return '#/decisions';
  if (page === 'settings') return '#/settings';
  if (page === 'agents') return '#/agents';
  if (page === 'apps') return '#/apps';
  if (page === 'files') return '#/files';
  if (page === 'workspace') return '#/workspace';
  if (page.startsWith('app:')) return `#/apps/${page.slice(4)}`;
  return '#/';
}

function slugFromPage(page: ShellPage): string | null {
  return page.startsWith('app:') ? page.slice(4) : null;
}

export default function App() {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [page, setPage] = useState<ShellPage>(() => pageFromHash());
  const [apps, setApps] = useState<AppRow[]>([]);
  const [issues, setIssues] = useState<IssueRow[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [workOrders, setWorkOrders] = useState<AgentWorkOrder[]>([]);
  const [err, setErr] = useState('');
  const filesRef = useRef<FilesViewHandle | null>(null);
  const agentsRef = useRef<AgentsViewHandle | null>(null);
  const decisionsRef = useRef<DecisionsViewHandle | null>(null);
  const settingsRef = useRef<SettingsViewHandle | null>(null);

  useEffect(() => {
    void load();
    const onHash = () => setPage(pageFromHash());
    window.addEventListener('hashchange', onHash);
    if (!window.location.hash) window.history.replaceState(null, '', '#/');
    return () => window.removeEventListener('hashchange', onHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setLoadState('loading');
    try {
      const [home, ev, agents] = await Promise.all([
        loadHome(INITIAL_DEMO),
        loadActivity(INITIAL_DEMO),
        loadAgents(INITIAL_DEMO),
      ]);
      setApps(home.apps);
      setIssues(home.issues);
      setActivity(ev);
      setWorkOrders(agents.work_orders.open);
      setLoadState('ready');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setLoadState('error');
    }
  }

  async function onRefresh() {
    if (page === 'files') {
      await filesRef.current?.refresh();
      return;
    }
    if (page === 'agents') {
      await agentsRef.current?.refresh();
      return;
    }
    if (page === 'decisions') {
      await decisionsRef.current?.refresh();
      return;
    }
    if (page === 'settings') {
      await settingsRef.current?.refresh();
      return;
    }
    await load();
  }

  function navigate(next: ShellPage) {
    const hash = hashForPage(next);
    if (window.location.hash === hash) setPage(next);
    else window.location.hash = hash;
  }

  return (
    <Shell demo={INITIAL_DEMO} apps={apps} activePage={page} onNavigate={navigate} onRefresh={onRefresh}>
      {page === 'files' ? (
        <FilesView ref={filesRef} />
      ) : page === 'agents' ? (
        <AgentsView ref={agentsRef} demo={INITIAL_DEMO} />
      ) : page === 'decisions' ? (
        <DecisionsView ref={decisionsRef} demo={INITIAL_DEMO} />
      ) : page === 'settings' ? (
        <SettingsView ref={settingsRef} demo={INITIAL_DEMO} />
      ) : page === 'workspace' ? (
        <Workspace config={tenantConfig} />
      ) : page === 'apps' ? (
        <>
          {loadState === 'loading' && <Loading />}
          {loadState === 'error' && <ErrorState message={err} onRetry={load} />}
          {loadState === 'ready' && <AppsView apps={apps} demo={INITIAL_DEMO} onChanged={load} />}
        </>
      ) : slugFromPage(page) ? (
        <>
          {loadState === 'loading' && <Loading />}
          {loadState === 'error' && <ErrorState message={err} onRetry={load} />}
          {loadState === 'ready' && <AppDetailView slug={slugFromPage(page)!} apps={apps} activity={activity} demo={INITIAL_DEMO} />}
        </>
      ) : (
        <>
          {loadState === 'loading' && <Loading />}
          {loadState === 'error' && <ErrorState message={err} onRetry={load} />}
          {loadState === 'ready' && <HomeView apps={apps} issues={issues} activity={activity} workOrders={workOrders} demo={INITIAL_DEMO} onResolved={load} />}
        </>
      )}
    </Shell>
  );
}

/* ───────────────────── Loading ──────────────────────────────────────────── */
function Loading() {
  return (
    <>
      <div className="strip">
        {Array.from({ length: 6 }).map((_, i) => (
          <div className="cell" key={i}>
            <div className="skel" style={{ height: 14, width: '60%' }} />
            <div className="skel" style={{ height: 22, width: '40%', marginTop: 8 }} />
          </div>
        ))}
      </div>
      <div className="band">
        <div className="band-head">
          <span className="band-num">1</span>
          <div className="band-title">What needs you</div>
        </div>
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} style={{ padding: '14px 18px', borderTop: '1px solid var(--line)' }}>
            <div className="skel" style={{ height: 38 }} />
          </div>
        ))}
      </div>
      <div className="band">
        <div className="band-head">
          <span className="band-num">2</span>
          <div className="band-title">Projects</div>
        </div>
        <div className="grid">
          {Array.from({ length: 3 }).map((_, i) => (
            <div className="skel" key={i} style={{ height: 230 }} />
          ))}
        </div>
      </div>
    </>
  );
}

/* ───────────────────── Error ────────────────────────────────────────────── */
function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="band">
      <div className="err-wrap">
        <div className="err-ico">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#FF8092" strokeWidth="2" strokeLinecap="round">
            <path d="M12 8v5M12 17h.01" />
            <circle cx="12" cy="12" r="9" />
          </svg>
        </div>
        <div className="err-h">Couldn't reach the control plane</div>
        <div className="err-p">The Home reads the <b>cc-read-home</b> edge function.</div>
        <div className="err-detail">{message}</div>
        <button className="btn-primary" style={{ width: 'auto', padding: '11px 22px' }} onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  );
}
