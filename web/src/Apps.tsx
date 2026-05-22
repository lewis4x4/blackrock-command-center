import { useMemo, useState } from 'react';
import { SlideOver } from './SlideOver';
import { ProjectGrid } from './Home';
import {
  ago, editAppBasics, registerApp,
  type AppRow, type EditAppPayload, type RegisterAppPayload,
} from './lib';

export function AppsView({ apps, demo, onChanged }: { apps: AppRow[]; demo: boolean; onChanged: () => void | Promise<void> }) {
  const [editing, setEditing] = useState<AppRow | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const sorted = useMemo(() => [...apps].sort((a, b) => b.criticality - a.criticality || a.short_code.localeCompare(b.short_code)), [apps]);
  const active = sorted.filter((app) => app.status === 'active').length;
  const provisioning = sorted.filter((app) => app.status === 'provisioning').length;
  const openDecisions = sorted.reduce((total, app) => total + (app.decision_counts?.open ?? 0), 0);

  async function changed(message: string) {
    await onChanged();
    setNotice(message);
    window.setTimeout(() => setNotice(''), 3200);
  }

  return (
    <div className="apps-page">
      <section className="agents-hero apps-hero">
        <div className="agents-hero-copy">
          <div className="detail-eyebrow">Apps registry</div>
          <h1>Every app Brian runs</h1>
          <p>Control-plane registry only. Secret values stay in Supabase secrets or vault; this page only writes safe metadata and pointer names.</p>
        </div>
        <div className="agents-hero-actions">
          <span className="detail-key">Updated {ago(newestSnapshot(sorted)) ?? '—'}</span>
          <button className="btn-primary apps-register-cta" onClick={() => setRegisterOpen(true)}>Register new app</button>
        </div>
        <div className="agents-metrics apps-metrics">
          <Metric label="Registered" value={String(sorted.length)} />
          <Metric label="Active / provisioning" value={`${active} / ${provisioning}`} tone={provisioning ? 'amber' : 'green'} />
          <Metric label="Open decisions" value={String(openDecisions)} tone={openDecisions ? 'amber' : 'green'} />
        </div>
      </section>

      {notice && <div className="apps-toast">{notice}</div>}

      <section className="band apps-grid-band">
        <div className="band-head">
          <span className="band-num">1</span>
          <div>
            <div className="band-title">Registered apps</div>
            <div className="band-sub">Same project grid as Home, with edit access for the three safe basics.</div>
          </div>
          <span className="count-chip">{sorted.length}</span>
        </div>
        {sorted.length === 0 ? (
          <div className="detail-placeholder agents-empty">
            <b>No apps registered</b>
            <span>Register the first app to put it on the board.</span>
          </div>
        ) : (
          <ProjectGrid apps={sorted} onEdit={setEditing} />
        )}
      </section>

      {editing && (
        <EditAppDrawer
          app={editing}
          demo={demo}
          onClose={() => setEditing(null)}
          onSaved={async (updated) => {
            setEditing(null);
            await changed(`${updated.short_code} basics saved.`);
          }}
        />
      )}

      <RegisterAppDrawer
        open={registerOpen}
        demo={demo}
        onClose={() => setRegisterOpen(false)}
        onRegistered={async () => {
          await changed('App registered. Add the app secrets before polling it.');
        }}
      />
    </div>
  );
}

function EditAppDrawer({ app, demo, onClose, onSaved }: { app: AppRow; demo: boolean; onClose: () => void; onSaved: (app: AppRow) => void | Promise<void> }) {
  const [displayName, setDisplayName] = useState(app.display_name);
  const [appUrl, setAppUrl] = useState(app.app_url ?? '');
  const [criticality, setCriticality] = useState(String(app.criticality));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setSaving(true);
    setError('');
    try {
      const nextCriticality = Number(criticality);
      if (!Number.isInteger(nextCriticality) || nextCriticality < 0 || nextCriticality > 1000) {
        throw new Error('criticality must be an integer between 0 and 1000');
      }
      const changes: EditAppPayload = {
        display_name: displayName.trim(),
        app_url: appUrl.trim() || null,
        criticality: nextCriticality,
      };
      const updated = await editAppBasics(app.id, changes, demo);
      await onSaved(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <SlideOver open title="Edit app basics" subtitle={`${app.short_code} · safe registry fields only`} onClose={onClose} footer={(
      <>
        <button className="ghost-btn" onClick={onClose} disabled={saving}>Cancel</button>
        <button className="btn-primary panel-primary" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save basics'}</button>
      </>
    )}>
      {error && <div className="panel-error">{error}</div>}
      <div className="panel-note">Server-side whitelist: display_name, app_url, criticality. Everything else is rejected.</div>
      <label className="answer-box apps-field">
        <span>Display name</span>
        <input value={displayName} onChange={(ev) => setDisplayName(ev.target.value)} />
      </label>
      <label className="answer-box apps-field">
        <span>App URL</span>
        <input value={appUrl} onChange={(ev) => setAppUrl(ev.target.value)} placeholder="https://app.example.com" />
      </label>
      <label className="answer-box apps-field">
        <span>Criticality</span>
        <input type="number" min="0" max="1000" step="1" value={criticality} onChange={(ev) => setCriticality(ev.target.value)} />
      </label>
    </SlideOver>
  );
}

const emptyRegisterForm: RegisterAppPayload = {
  short_code: '',
  display_name: '',
  project_ref: '',
  project_url: '',
  service_secret_ref: '',
  readonly_secret_ref: '',
  github_repo: '',
};

function RegisterAppDrawer({ open, demo, onClose, onRegistered }: { open: boolean; demo: boolean; onClose: () => void; onRegistered: () => void | Promise<void> }) {
  const [form, setForm] = useState<RegisterAppPayload>(emptyRegisterForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<AppRow | null>(null);

  function update<K extends keyof RegisterAppPayload>(key: K, value: RegisterAppPayload[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submit() {
    setSaving(true);
    setError('');
    setCreated(null);
    try {
      const payload: RegisterAppPayload = {
        short_code: form.short_code.trim().toUpperCase(),
        display_name: form.display_name.trim(),
        project_ref: form.project_ref.trim(),
        project_url: form.project_url.trim(),
        service_secret_ref: form.service_secret_ref.trim(),
        readonly_secret_ref: form.readonly_secret_ref?.trim() || null,
        github_repo: form.github_repo.trim(),
      };
      const app = await registerApp(payload, demo);
      setCreated(app);
      setForm(emptyRegisterForm);
      await onRegistered();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function close() {
    setError('');
    setCreated(null);
    onClose();
  }

  const shortCode = created?.short_code ?? (form.short_code.trim().toUpperCase() || 'APP');

  return (
    <SlideOver open={open} title="Register new app" subtitle="Minimum registry payload only" onClose={close} footer={(
      <>
        <button className="ghost-btn" onClick={close} disabled={saving}>{created ? 'Done' : 'Cancel'}</button>
        {!created && <button className="btn-primary panel-primary" onClick={() => void submit()} disabled={saving}>{saving ? 'Registering…' : 'Register app'}</button>}
      </>
    )}>
      {error && <div className="panel-error">{error}</div>}
      {created ? (
        <div className="panel-stack apps-checklist">
          <div className="panel-confirm queued">{created.short_code} is registered.</div>
          <div className="panel-section">
            <div className="panel-label">Post-registration checklist</div>
            <div className="panel-card">
              <b>Set the service-role pointer value</b>
              <code>supabase secrets set SVC_KEY_{created.short_code}=...</code>
            </div>
            <div className="panel-card">
              <b>Set the read-only pointer value</b>
              <code>supabase secrets set READ_KEY_{created.short_code}=...</code>
            </div>
            <div className="panel-note">The registry stores pointer names only. It never stores the secret values behind these commands.</div>
          </div>
        </div>
      ) : (
        <>
          <div className="panel-note">Minimum registration only. Linear, owners, integrations, and per-app settings are deferred to later edits.</div>
          <RegisterField label="Short code" value={form.short_code} onChange={(value) => update('short_code', value.toUpperCase())} placeholder="SCC" />
          <RegisterField label="Display name" value={form.display_name} onChange={(value) => update('display_name', value)} placeholder="SCC" />
          <RegisterField label="Supabase project ref" value={form.project_ref} onChange={(value) => update('project_ref', value)} placeholder="abcdefghijklmnopq" />
          <RegisterField label="Supabase project URL" value={form.project_url} onChange={(value) => update('project_url', value)} placeholder="https://abcdefghijklmnopq.supabase.co" />
          <RegisterField label="Service secret ref" value={form.service_secret_ref} onChange={(value) => update('service_secret_ref', value)} placeholder={`SVC_KEY_${shortCode}`} />
          <RegisterField label="Read-only secret ref (optional)" value={form.readonly_secret_ref ?? ''} onChange={(value) => update('readonly_secret_ref', value)} placeholder={`READ_KEY_${shortCode}`} />
          <RegisterField label="GitHub repo" value={form.github_repo} onChange={(value) => update('github_repo', value)} placeholder="lewis4x4/scc" />
          <div className="apps-secret-rule">Raw keys are rejected. Use pointer names like <code>SVC_KEY_{shortCode}</code>, <code>READ_KEY_{shortCode}</code>, or <code>vault://...</code>.</div>
        </>
      )}
    </SlideOver>
  );
}

function RegisterField({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string }) {
  return (
    <label className="answer-box apps-field">
      <span>{label}</span>
      <input value={value} onChange={(ev) => onChange(ev.target.value)} placeholder={placeholder} />
    </label>
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

function newestSnapshot(apps: AppRow[]): string | null {
  return apps
    .map((app) => app.last_snapshot_at)
    .filter((value): value is string => !!value)
    .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] ?? null;
}

