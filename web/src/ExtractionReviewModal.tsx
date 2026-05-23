import { useEffect, useMemo, useState } from 'react';
import { SlideOver } from './SlideOver';
import type { PendingReviewSend } from './lib';

export function ExtractionReviewModal({
  review,
  open,
  onClose,
  onConfirm,
  onReject,
  onClarify,
}: {
  review: PendingReviewSend | null;
  open: boolean;
  onClose: () => void;
  onConfirm: (sendId: string, optionId: string, rationale?: string | null) => Promise<void>;
  onReject: (sendId: string, reason: string) => Promise<void>;
  onClarify: (sendId: string, message: string) => Promise<void>;
}) {
  const options = useMemo(() => review?.options_snapshot ?? [], [review]);
  const optionIds = useMemo(() => new Set(options.map((opt) => opt.id)), [options]);
  const suggested = review?.llm_extraction?.matched_option_id ?? null;
  const acceptEnabled = !!suggested && optionIds.has(suggested);
  const [action, setAction] = useState<'accept' | 'pick' | 'reject' | 'clarify'>(acceptEnabled ? 'accept' : 'pick');
  const [optionId, setOptionId] = useState(options[0]?.id ?? '');
  const [rationale, setRationale] = useState('');
  const [reason, setReason] = useState('');
  const [clarify, setClarify] = useState(review?.llm_extraction?.suggested_clarification ?? '');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!review) return;
    const currentSuggested = review.llm_extraction?.matched_option_id ?? null;
    const ids = new Set((review.options_snapshot ?? []).map((opt) => opt.id));
    const canAccept = !!currentSuggested && ids.has(currentSuggested);
    setAction(canAccept ? 'accept' : 'pick');
    setOptionId(canAccept ? currentSuggested! : (review.options_snapshot[0]?.id ?? ''));
    setReason('');
    setRationale('');
    setClarify(review.llm_extraction?.suggested_clarification ?? '');
  }, [review?.send_id]);

  if (!review) return null;
  const current = review;

  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      if (action === 'reject') await onReject(current.send_id, reason);
      else if (action === 'clarify') await onClarify(current.send_id, clarify);
      else await onConfirm(current.send_id, action === 'accept' ? (current.llm_extraction?.matched_option_id ?? optionId) : optionId, rationale || null);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <SlideOver open={open} title="Review extraction" subtitle={`${current.app_short_code} · reply from ${current.recipient_name ?? current.recipient_email}`} onClose={onClose} footer={(
      <>
        <button className="ghost-btn" onClick={onClose}>Close</button>
        <button className="btn-primary panel-primary" onClick={() => void submit()} disabled={busy || (action === 'reject' && !reason.trim()) || (action === 'clarify' && !clarify.trim())}>
          {busy ? 'Recording…' : action === 'clarify' ? 'Send clarification' : 'Confirm answer'}
        </button>
      </>
    )}>
      <div className="panel-section"><div className="panel-label">Original question</div><b>{current.raw_decision_title}</b><p>{current.raw_decision_body ?? '—'}</p></div>
      <div className="panel-section"><div className="panel-label">Customer reply</div><div className="review-quote">{current.raw_reply_text}</div></div>
      <div className="panel-section"><div className="panel-label">Claude parse</div><div>Suggested: {current.llm_extraction?.matched_option_id ?? 'none'} · confidence {current.llm_extraction?.confidence?.toFixed(2) ?? '0.00'}</div><div>{current.llm_extraction?.rationale ?? '—'}</div></div>
      <div className="panel-section">
        <div className="panel-label">Decide</div>
        <label><input type="radio" checked={action === 'accept'} onChange={() => setAction('accept')} disabled={!acceptEnabled} /> Accept Claude's suggestion</label>
        <label><input type="radio" checked={action === 'pick'} onChange={() => setAction('pick')} /> Pick different option</label>
        {action === 'pick' && <select value={optionId} onChange={(e) => setOptionId(e.target.value)}>{options.map((opt) => <option key={opt.id} value={opt.id}>{opt.label}</option>)}</select>}
        <label><input type="radio" checked={action === 'reject'} onChange={() => setAction('reject')} /> Reject as off-topic</label>
        {action === 'reject' && <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason" maxLength={500} />}
        <label><input type="radio" checked={action === 'clarify'} onChange={() => setAction('clarify')} /> Send clarification</label>
        {action === 'clarify' && <textarea value={clarify} onChange={(e) => setClarify(e.target.value)} rows={4} />}
        {(action === 'accept' || action === 'pick') && <input value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="Rationale (optional)" maxLength={500} />}
      </div>
    </SlideOver>
  );
}
