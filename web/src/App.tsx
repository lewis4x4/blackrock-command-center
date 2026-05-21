import { useEffect, useState } from 'react';
import {
  INITIAL_DEMO, loadApps, loadActivity,
  type AppRow, type ActivityEvent,
} from './lib';
import { Shell, HomeView } from './Home';

/* No login. The control plane's home tables are anon-readable (migration 005),
   so the app boots straight to live data. */
type View = 'loading' | 'error' | 'home';

export default function App() {
  const [view, setView] = useState<View>('loading');
  const [apps, setApps] = useState<AppRow[]>([]);
  const [activity, setActivity] = useState<ActivityEvent[]>([]);
  const [err, setErr] = useState('');

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function load() {
    setView('loading');
    try {
      const [a, ev] = await Promise.all([
        loadApps(INITIAL_DEMO),
        loadActivity(INITIAL_DEMO),
      ]);
      setApps(a);
      setActivity(ev);
      setView('home');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setView('error');
    }
  }

  return (
    <Shell demo={INITIAL_DEMO} apps={apps} onRefresh={load}>
      {view === 'loading' && <Loading />}
      {view === 'error' && <ErrorState message={err} onRetry={load} />}
      {view === 'home' && <HomeView apps={apps} activity={activity} />}
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
