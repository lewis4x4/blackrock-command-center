import { useEffect, useState } from 'react';
import {
  INITIAL_DEMO, loadApps, loadActivity,
  type AppRow, type ActivityEvent,
} from './lib';
import { Shell, HomeView, type ShellPage } from './Home';
import { FilesView } from './Files';

/* Tiny hash switch until F1's router lands. Keeps Files link-shareable without adding react-router. */
type LoadState = 'loading' | 'error' | 'ready';

function pageFromHash(): ShellPage {
  return window.location.hash === '#/files' ? 'files' : 'home';
}

function hashForPage(page: ShellPage): string {
  return page === 'files' ? '#/files' : '#/';
}

export default function App() {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [page, setPage] = useState<ShellPage>(() => pageFromHash());
  const [apps, setApps] = useState<AppRow[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [err, setErr] = useState('');

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
      const [a, ev] = await Promise.all([
        loadApps(INITIAL_DEMO),
        loadActivity(INITIAL_DEMO),
      ]);
      setApps(a);
      setActivity(ev);
      setLoadState('ready');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setLoadState('error');
    }
  }

  function navigate(next: ShellPage) {
    const hash = hashForPage(next);
    if (window.location.hash === hash) setPage(next);
    else window.location.hash = hash;
  }

  return (
    <Shell demo={INITIAL_DEMO} apps={apps} activePage={page} onNavigate={navigate} onRefresh={load}>
      {page === 'files' ? (
        <FilesView />
      ) : (
        <>
          {loadState === 'loading' && <Loading />}
          {loadState === 'error' && <ErrorState message={err} onRetry={load} />}
          {loadState === 'ready' && <HomeView apps={apps} activity={activity} />}
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
        <div className="err-p">The Home reads <b>v_command_center_home</b>. The query didn't return.</div>
        <div className="err-detail">{message}</div>
        <button className="btn-primary" style={{ width: 'auto', padding: '11px 22px' }} onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  );
}
