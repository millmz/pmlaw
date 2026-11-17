import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

/**
 * "Something looks wrong" — one tap, a sentence, done. During the trial
 * weeks this is how wrong answers and rough edges get reported in the
 * moment, in the user's own words. Entries land in the Activity log.
 */
export function FlagButton({ context, label = 'Flag', className = 'flag-btn' }: { context?: () => string | undefined; label?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [err, setErr] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) box.current?.focus();
  }, [open]);

  const send = async () => {
    if (!note.trim()) return;
    setState('sending');
    try {
      await api.flag(note, context?.());
      setState('sent');
      setNote('');
      setTimeout(() => {
        setOpen(false);
        setState('idle');
      }, 1600);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not send.');
      setState('error');
    }
  };

  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)} title="Tell Adam something looks wrong or could be better">
        {label}
      </button>
      {open && (
        <div className="flag-scrim" onClick={() => setOpen(false)}>
          <div className="flag-card" role="dialog" aria-label="Flag a problem" onClick={(e) => e.stopPropagation()}>
            {state === 'sent' ? (
              <div className="flag-sent">Logged. Thank you — Adam will see it.</div>
            ) : (
              <>
                <h3>What looks wrong?</h3>
                <p>A wrong date, a missing case, an answer that was off — a sentence is plenty. It goes to Adam.</p>
                <textarea
                  ref={box}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={4}
                  placeholder="e.g. The Grasso offer is 125, not 110."
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
                    if (e.key === 'Escape') setOpen(false);
                  }}
                />
                {state === 'error' && <div className="flag-err">{err}</div>}
                <div className="flag-actions">
                  <button type="button" className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
                  <button type="button" className="btn" disabled={!note.trim() || state === 'sending'} onClick={() => void send()}>
                    {state === 'sending' ? 'Sending…' : 'Send'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
