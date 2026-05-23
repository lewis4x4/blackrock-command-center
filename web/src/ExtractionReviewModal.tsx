import { useEffect, useMemo, useState } from 'react';
import { SlideOver } from './SlideOver';
import type { OperatorClarifyExtractionPayload, PendingReviewSend } from './lib';

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
  onClarify: (payload: OperatorClarifyExtractionPayload) => Promise<void>;
}) {
  const options = useMemo(() => review?.options_snapshot ?? [], [review]);
  const optionIds = useMemo(() => new Set(options.map((opt) => opt.id)), [options]);
  const suggested = review?.llm_extraction?.matched_option_id ?? null;
  const acceptEnabled = !!suggested && optionIds.has(suggested);
  const [action, setAction] = useState<'accept' | 'pick' | 'reject' | 'clarify'>(acceptEnabled ? 'accept' : 'pick');
  const [optionId, setOptionId] = useState(options[0]?.id ?? '');
  const [rationale, setRationale] = useState('');
  const [reason, setReason] = useState('');
  const [clarifySubject, setClarifySubject] = useState('');
  const [clarifyBody, setClarifyBody] = useState(review?.llm_extraction?.suggested_clarification ?? '');
  const [includeButtons, setIncludeButtons] = useState(true);
  const [regenerateTokens, setRegenerateTokens] = useState(false);
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
    setClarifySubject(`Re: ${review.raw_decision_title}`);
    setClarifyBody(review.llm_extraction?.suggested_clarification ?? '');
    setIncludeButtons(review.llm_extraction?.requires_human === true || (review.llm_extraction?.confidence ?? 0) < 0.85);
    setRegenerateTokens(false);
  }, [review?.send_id]);

  if (!review) return null;
  const current = review;

  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      if (action === 'reject') await onReject(current.send_id, reason);
      else if (action === 'clarify') {
        await onClarify({
          send_id: current.send_id,
          subject: clarifySubject,
          body: clarifyBody,
          include_buttons: includeButtons,
          regenerate_tokens: regenerateTokens,
        });
      } else await onConfirm(current.send_id, action === 'accept' ? (current.llm_extraction?.matched_option_id ?? optionId) : optionId, rationale || null);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <SlideOver open={open} title="Review extraction" subtitle={`${current.app_short_code} · reply from ${current.recipient_name ?? current.recipient_email}`} onClose={onClose} footer={(
      <>
        <button className="ghost-btn" onClick={onClose}>Close</button>
        <button className="btn-primary panel-primary" onClick={() => void submit()} disabled={busy || (action === 'reject' && !reason.trim()) || (action === 'clarify' && (!clarifySubject.trim() || !clarifyBody.trim()))}>
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
        {action === 'clarify' && (
          <div className="panel-stack">
            <input value={clarifySubject} onChange={(e) => setClarifySubject(e.target.value)} placeholder="Subject" maxLength={200} />
            <textarea value={clarifyBody} onChange={(e) => setClarifyBody(e.target.value)} rows={8} />
            <label><input type="checkbox" checked={includeButtons} onChange={(e) => setIncludeButtons(e.target.checked)} /> Include the three option buttons</label>
            <label><input type="checkbox" checked={regenerateTokens} onChange={(e) => setRegenerateTokens(e.target.checked)} /> Regenerate magic-link tokens</label>
          </div>
        )}
        {(action === 'accept' || action === 'pick') && <input value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="Rationale (optional)" maxLength={500} />}
      </div>
    </SlideOver>
  );
}
