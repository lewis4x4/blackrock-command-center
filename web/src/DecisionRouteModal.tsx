import { useEffect, useMemo, useRef, useState } from 'react';
import {
  decisionRowTitle, loadDecisionRecipients, loadDecisionSend, routeDecision, rewriteDecision,
  type DecisionEmailSend, type DecisionOptionLike, type DecisionRecipient, type RiskClass,
} from './lib';

type Props = {
  open: boolean;
  demo: boolean;
  appId: string;
  issueId: string | null;
  decision: Record<string, unknown>;
  onClose: () => void;
  onSent?: () => void | Promise<void>;
};

type Status = 'idle' | 'loading' | 'ready' | 'sending' | 'sent' | 'error';

export function DecisionRouteModal({ open, demo, appId, issueId, decision, onClose, onSent }: Props) {
  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const [recipientWarning, setRecipientWarning] = useState('');
  const [send, setSend] = useState<DecisionEmailSend | null>(null);
  const [recipients, setRecipients] = useState<DecisionRecipient[]>([]);
  const [selectedRecipients, setSelectedRecipients] = useState<Set<string>>(new Set());
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [options, setOptions] = useState<DecisionOptionLike[]>([]);

  const modalRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const rawTitle = decisionRowTitle(decision);
  const rawBody = text(decision.summary) ?? text(decision.body) ?? text(decision.description) ?? '';
  const rawOptions = useMemo(() => optionsFor(decision), [decision]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus('loading');
    setError('');
    setRecipientWarning('');
    setSend(null);
    setSubject('');
    setBody('');
    setOptions([]);

    async function start() {
      if (!issueId) throw new Error('This decision row is missing a control-plane issue id.');
      // Load recipients independently so a rewrite failure does not also hide
      // them (defense in depth — the recipient list is always useful context).
      const recipientsPromise = loadDecisionRecipients(appId, demo)
        .then((recipientRows) => {
          if (cancelled) return;
          const active = recipientRows.filter((row) => row.active);
          setRecipients(active);
          setSelectedRecipients(new Set(active.map((row) => row.id)));
        })
        .catch((e) => {
          if (cancelled) return;
          // Surface load errors as a non-fatal warning via the recipient panel.
          setRecipients([]);
          setSelectedRecipients(new Set());
          setRecipientWarning(e instanceof Error ? e.message : String(e));
        });
      const rewrite = await rewriteDecision({
        issue_id: issueId,
        app_id: appId,
        decision_external_ref: rowId(decision),
        raw_title: rawTitle,
        raw_body: rawBody,
        options: rawOptions,
        risk_class: riskFor(decision),
      }, demo);
      if (cancelled) return;
      await recipientsPromise;
      if (cancelled) return;
      await pollRewrite(rewrite.id, cancelledRef(() => cancelled));
    }

    async function pollRewrite(sendId: string, isCancelled: () => boolean) {
      for (let i = 0; i < 90; i += 1) {
        const current = i === 0 && demo ? await loadDecisionSend(sendId, demo) : await loadDecisionSend(sendId, demo);
        if (isCancelled()) return;
        setSend(current);
        if (current.state === 'rewrite_ready') {
          const nextOptions = optionsFromSnapshot(current.options_snapshot);
          setSubject(current.rewritten_subject ?? rawTitle);
          setBody(current.rewritten_body ?? (rawBody || rawTitle));
          setOptions(nextOptions.length ? nextOptions : rawOptions);
          setStatus('ready');
          return;
        }
        if (current.state === 'failed') throw new Error(current.last_error ?? 'rewrite failed');
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
      }
      throw new Error('rewrite did not become ready before timeout');
    }

    start().catch((e) => {
      if (cancelled) return;
      setError(e instanceof Error ? e.message : String(e));
      setStatus('error');
    });
    return () => { cancelled = true; };
  }, [open, appId, demo, issueId, rawBody, rawOptions, rawTitle, decision]);

  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusableSelector = [
      'a[href]',
      'button:not([disabled])',
      'input:not([disabled])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      '[tabindex]:not([tabindex="-1"])',
    ].join(',');

    const focusFirstControl = () => {
      const focusable = modalRef.current?.querySelector<HTMLElement>(focusableSelector);
      focusable?.focus();
    };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        onClose();
        return;
      }
      if (ev.key !== 'Tab') return;
      const focusable = Array.from(modalRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [])
        .filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusable.length === 0) {
        ev.preventDefault();
        modalRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.setTimeout(focusFirstControl, 0);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
      restoreFocusRef.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  async function sendNow() {
    if (!send) return;
    const recipientIds = [...selectedRecipients];
    if (recipientIds.length === 0) {
      setError('Select at least one recipient.');
      return;
    }
    setStatus('sending');
    setError('');
    try {
      await routeDecision(send.id, recipientIds, subject, body, options, demo);
      setStatus('sent');
      await onSent?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus('ready');
    }
  }

  function toggleRecipient(id: string) {
    const next = new Set(selectedRecipients);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedRecipients(next);
  }

  return (
    <div className="route-modal-root">
      <button className="route-modal-backdrop" onClick={onClose} aria-label="Close" />
      <div className="route-modal-card" role="dialog" aria-modal="true" aria-label="Route to recipients" ref={modalRef} tabIndex={-1}>
        <div className="route-modal-head">
          <div>
            <div className="detail-eyebrow">Reviewing AI-rewritten decision email</div>
            <h2>Route to recipients</h2>
          </div>
          <button className="slideover-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        {error && <div className="panel-error">{error}</div>}
        {status === 'loading' ? (
          <div className="detail-placeholder">Mac Studio rewrite queued…</div>
        ) : status === 'sent' ? (
          <div className="panel-confirm queued">Decision email sent.</div>
        ) : (
          <>
            <div className="route-preview-grid">
              <div className="route-preview-pane">
                <div className="panel-label">Original</div>
                <b>{rawTitle}</b>
                {rawBody && <p>{rawBody}</p>}
                <ul>{rawOptions.map((option) => <li key={option.id}>{option.label}</li>)}</ul>
              </div>
              <div className="route-preview-pane">
                <div className="panel-label">Rewritten</div>
                <label><span>Subject</span><input value={subject} onChange={(ev) => setSubject(ev.target.value)} /></label>
                <label><span>Body</span><textarea value={body} onChange={(ev) => setBody(ev.target.value)} /></label>
                <div className="route-options-edit">
                  {options.map((option, index) => (
                    <label key={option.id}><span>{option.id}</span><input value={option.label} onChange={(ev) => setOptions(options.map((item, i) => i === index ? { ...item, label: ev.target.value } : item))} /></label>
                  ))}
                </div>
              </div>
            </div>
            <div className="route-recipient-list">
              <div className="panel-label">Going to</div>
              {recipientWarning && <div className="panel-note">Recipients could not be loaded: {recipientWarning}</div>}
              {recipients.length === 0 ? <div className="detail-placeholder">No active decision recipients for this app.</div> : recipients.map((recipient) => (
                <label key={recipient.id} className="route-recipient-row">
                  <input type="checkbox" checked={selectedRecipients.has(recipient.id)} onChange={() => toggleRecipient(recipient.id)} />
                  <span>{recipient.contact_name} &lt;{recipient.contact_email}&gt;</span>
                </label>
              ))}
            </div>
          </>
        )}
        <div className="route-modal-actions">
          <button className="ghost-btn" onClick={onClose}>{status === 'sent' ? 'Done' : 'Cancel'}</button>
          {status !== 'sent' && <button className="btn-primary panel-primary" onClick={() => void sendNow()} disabled={status !== 'ready' || !subject.trim() || !body.trim()}>{status === 'sending' ? 'Sending…' : 'Send as-is'}</button>}
        </div>
      </div>
    </div>
  );
}

function cancelledRef(fn: () => boolean): () => boolean { return fn; }

function optionsFor(row: Record<string, unknown>): DecisionOptionLike[] {
  const raw = row.options ?? row.answer_options ?? row.choices ?? row.allowed_answers;
  if (!Array.isArray(raw)) return [];
  return raw.map(optionFromUnknown).filter((item): item is DecisionOptionLike => !!item);
}

function optionsFromSnapshot(value: unknown): DecisionOptionLike[] {
  return Array.isArray(value) ? value.map(optionFromUnknown).filter((item): item is DecisionOptionLike => !!item) : [];
}

function optionFromUnknown(item: unknown): DecisionOptionLike | null {
  if (typeof item === 'string' && item.trim()) return { id: item.trim(), label: item.trim() };
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const rec = item as Record<string, unknown>;
  const id = text(rec.id) ?? text(rec.value) ?? text(rec.key);
  if (!id) return null;
  return { id, label: text(rec.label) ?? text(rec.name) ?? text(rec.title) ?? id };
}

function riskFor(row: Record<string, unknown>): RiskClass {
  const raw = text(row.risk_class)?.toLowerCase();
  return raw === 'auto' || raw === 'authorize' || raw === 'destructive' || raw === 'production' ? raw : 'authorize';
}

function rowId(row: Record<string, unknown>): string {
  return text(row.id) ?? text(row.external_ref) ?? text(row.decision_id) ?? decisionRowTitle(row);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
