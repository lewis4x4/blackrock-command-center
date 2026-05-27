import { useEffect, useState } from 'react';
import { ago, loadDecisionConfirmData, submitDecisionConfirm, type DecisionConfirmData } from './lib';

export function confirmRouteFromLocation(): { token: string; sendId: string; optionId: string } | null {
  const match = window.location.pathname.match(/^\/c\/([^/]+)$/);
  if (!match?.[1]) return null;
  const qs = new URLSearchParams(window.location.search);
  const sendId = qs.get('s') ?? '';
  const optionId = qs.get('o') ?? '';
  if (!sendId || !optionId) return null;
  return { token: decodeURIComponent(match[1]), sendId, optionId };
}

export function DecisionConfirmPage({ token, sendId, optionId }: { token: string; sendId: string; optionId: string }) {
  const [state, setState] = useState<'loading' | 'ready' | 'submitting' | 'done' | 'error'>('loading');
  const [data, setData] = useState<DecisionConfirmData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    loadDecisionConfirmData(token, sendId, optionId)
      .then((payload) => { setData(payload); setState('ready'); })
      .catch((e) => { setError(e instanceof Error ? e.message : String(e)); setState('error'); });
  }, [token, sendId, optionId]);

  const alreadyAnswered = data?.state === 'already_answered';
  const answer = alreadyAnswered ? data.answer : null;
  const cockpitUrl = `${window.location.origin}/`;

  async function confirm() {
    if (!data || alreadyAnswered) return;
    setState('submitting');
    setError('');
    try {
      await submitDecisionConfirm(token, sendId, optionId, data.csrf);
      setState('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState('error');
    }
  }

  return (
    <div className="confirm-page">
      <div className="confirm-card">
        <div className="detail-eyebrow">BlackRock AI Command Center</div>
        <h1>Confirm your answer</h1>
        {state === 'loading' && <div className="detail-placeholder">Checking this secure link…</div>}
        {state === 'error' && <div className="panel-error">{error}</div>}
        {state === 'done' && <div className="panel-confirm queued">Thanks — your answer was recorded and Brian’s build queue can move.</div>}
        {data && state !== 'done' && (
          <>
            <p className="confirm-copy">This link is for {data.recipient_name ?? data.recipient_email ?? 'the intended recipient'}.</p>
            <div className="confirm-question">
              <b>{data.subject ?? 'Decision question'}</b>
              {data.body && <p>{data.body}</p>}
            </div>
            {alreadyAnswered ? (
              <AlreadyAnsweredBlock answer={answer} />
            ) : (
              <>
                <div className="confirm-choice">
                  <span>Your selected answer</span>
                  <b>{data.selected_option?.label ?? data.selected_option_id}</b>
                </div>
                <button className="btn-primary" onClick={() => void confirm()} disabled={state === 'submitting'}>{state === 'submitting' ? 'Confirming…' : 'Confirm answer'}</button>
                <p className="confirm-small">No answer is recorded until you press Confirm.</p>
              </>
            )}
            {alreadyAnswered && <a className="confirm-cockpit-link" href={cockpitUrl}>View all decisions in the cockpit →</a>}
          </>
        )}
      </div>
    </div>
  );
}

function AlreadyAnsweredBlock({ answer }: { answer: DecisionConfirmData['answer'] }) {
  if (!answer) {
    return <div className="panel-confirm queued">This decision has already been answered. No new answer is needed.</div>;
  }
  const who = answer.answered_by_name ?? 'Someone';
  const picked = answer.answer_label ?? answer.answer_value ?? 'an answer';
  const when = ago(answer.answered_at) ?? 'recently';
  return (
    <div className="confirm-answer-summary">
      <div className="confirm-answer-kicker">Already answered</div>
      <p><b>{who}</b> answered this {when} — picked <b>“{picked}”</b>.</p>
      {answer.rationale && (
        <div className="confirm-rationale">
          <span>Rationale</span>
          <p>{answer.rationale}</p>
        </div>
      )}
      <p className="confirm-small">This link is now read-only so the recorded answer stays unchanged.</p>
    </div>
  );
}
