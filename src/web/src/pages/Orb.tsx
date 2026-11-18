import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { streamChat, type Panel, type TurnTiming } from '../api.js';
import { FlagButton } from '../flag.js';
import type { OrbState } from '../orb-canvas.js';
import { createOrb, type OrbLike } from '../orb-gl.js';
import { isEcho } from '../listen-logic.js';
import { SpeechQueue } from '../speech-queue.js';
import {
  chime,
  getDiagnostics,
  getLevel,
  primeAudio,
  recognitionSupported,
  speak,
  startListening,
  startServerListening,
  stopSpeaking,
  type ListenSession,
  type VoiceDiagnostics,
} from '../voice.js';

/**
 * The orb room — PAM as a presence.
 *
 * She is spoken to and she speaks back; what she looks up appears beside her
 * while she talks about it. The room has three parts: the orb (her state,
 * read through breath and light), the captions (what she is saying, lit as
 * she says it), and the panels (the schedule, the file, the figures — the
 * detail the voice only summarizes). An ambient readout keeps the shape of
 * the day in view. Voice is on by default, with a one-tap mute for an office
 * with ears.
 */

interface Turn {
  you: string;
  pam: string;
  /** Characters of `pam` already spoken — captions light up as she talks. */
  spoken: number;
  error?: boolean;
}

interface Ambient {
  name: string;
  nextEvent: { time: string; title: string; startIso: string; court: boolean } | null;
  eventsLeft: number;
  dueToday: number;
  overdue: number;
}

/** First things worth asking — shown while the room is quiet, so a
 *  first-time user is never looking at a blank prompt. */
const STARTERS = ['Brief me on today', 'What’s overdue?', 'What am I negotiating?', 'What’s in court this week?'];

const TOOL_STATUS: Record<string, string> = {
  get_calendar_events: 'Checking the calendar',
  get_tasks: 'Checking your tasks',
  search_matters: 'Finding the matter',
  get_matter_overview: 'Opening the file',
  get_settlement_board: 'Pulling the settlement board',
  get_settlement_timeline: 'Reading the settlement history',
  find_stalled_matters: 'Looking for matters with no next step',
  list_firm_staff: 'Checking the roster',
  recall_memories: 'Recalling',
  remember: 'Noting that',
};
const toolStatus = (name: string): string =>
  TOOL_STATUS[name] ?? (name.startsWith('propose_') ? 'Preparing the change' : name.startsWith('execute_') ? 'Making the change' : 'Looking that up');

/** Captions are read as well as heard: no stray markdown. */
const tidy = (text: string): string =>
  text
    .replace(/\*\*|__|`/g, '')
    .replace(/^#{1,4}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .trim();

const fmtCountdown = (iso: string, now: number): string => {
  const mins = Math.round((new Date(iso).getTime() - now) / 60_000);
  if (mins < -5) return ''; // demo data runs on its own clock
  if (mins <= 0) return 'now';
  if (mins < 60) return `in ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `in ${h} h ${m} min` : `in ${h} h`;
};

export function OrbPage({ chatEnabled }: { chatEnabled: boolean }) {
  const navigate = useNavigate();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const orbRef = useRef<OrbLike | null>(null);
  const listenRef = useRef<ListenSession | null>(null);
  const lastInputVoice = useRef(false);
  const queueRef = useRef<SpeechQueue | null>(null);
  const lastTtfw = useRef<number | null>(null); // time to first word, ms
  // Which ear: the browser's recognizer (instant, live words) or recording +
  // server transcription (no live words, better with names and noise).
  const serverStt = useRef(!recognitionSupported() || localStorage.getItem('pam-ear') === 'server');
  const [ear, setEar] = useState<'browser' | 'server'>(serverStt.current ? 'server' : 'browser');
  const lastHeard = useRef<{ text: string; alternatives: string[] } | null>(null);
  const captionsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lastSaid = useRef(''); // her last answer — so the mic never mistakes her own voice for a question
  const echoRetries = useRef(0);
  const [micReady, setMicReady] = useState(false);
  const [state, setState] = useState<OrbState>('idle');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [note, setNote] = useState(''); // what she is doing right now
  const [panels, setPanels] = useState<Panel[]>([]);
  const [ambient, setAmbient] = useState<Ambient | null>(null);
  const [sync, setSync] = useState<{ label: string; tone: 'ok' | 'busy' | 'bad'; demo: boolean; trial: boolean } | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [partial, setPartial] = useState('');
  const [input, setInput] = useState('');
  const [muted, setMuted] = useState(() => localStorage.getItem('pam-muted') === '1');
  const [diag, setDiag] = useState<VoiceDiagnostics | null>(null);
  const [brain, setBrain] = useState<{ source: string; prefix: string; length: number; looksAnthropic: boolean; skipped: string[] } | null>(null);
  const [health, setHealth] = useState<{ brain: { ok: boolean; detail: string }; voice: { ok: boolean; detail: string } } | null>(null);
  const [timing, setTiming] = useState<TurnTiming | null>(null);
  const [showDiag, setShowDiag] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  const setOrb = useCallback((s: OrbState) => {
    setState(s);
    orbRef.current?.setState(s);
  }, []);

  const patchLast = (patch: (t: Turn) => Turn) => setTurns((ts) => (ts.length ? [...ts.slice(0, -1), patch(ts[ts.length - 1]!)] : ts));

  // ------------------------------------------------------------- lifecycle
  useEffect(() => {
    let dead = false;
    void createOrb(canvasRef.current!, getLevel).then((orb) => {
      if (dead) return orb.stop();
      orbRef.current = orb;
      orb.setState(stateRef.current);
      orb.start();
      // Demo hook: lets a console (or a test) throw the Go-Canes burst.
      (window as unknown as { pamCelebrate?: () => void }).pamCelebrate = () => orb.celebrate();
    });
    // Warm the model so the first question is as quick as the tenth.
    void fetch('/api/chat/prewarm', { method: 'POST' }).catch(() => undefined);
    const arrivedAsking = new URLSearchParams(window.location.search).has('ask');

    const load = async () => {
      const [g, h, st] = await Promise.all([
        fetch('/api/greeting').then((r) => (r.ok ? r.json() : null)).catch(() => null) as Promise<{ text: string; ambient: Ambient } | null>,
        arrivedAsking
          ? Promise.resolve({ messages: [] as { role: string; text: string }[] })
          : (fetch('/api/chat/history').then((r) => (r.ok ? r.json() : { messages: [] })).catch(() => ({ messages: [] })) as Promise<{ messages: { role: string; text: string }[] }>),
        fetch('/api/status').then((r) => (r.ok ? r.json() : null)).catch(() => null) as Promise<{ mode: string; writesEnabled: boolean; sync: { state: string } } | null>,
      ]);
      if (dead) return;
      if (g) setAmbient(g.ambient);
      if (st) {
        const s = st.sync.state;
        setSync({
          label: s === 'ok' ? 'Synced' : s === 'first-sync' ? 'First sync' : s === 'syncing' ? 'Syncing' : s === 'error' ? 'Sync problem' : 'Starting',
          tone: s === 'ok' ? 'ok' : s === 'error' ? 'bad' : 'busy',
          demo: st.mode === 'demo',
          trial: !st.writesEnabled,
        });
      }
      // Resume today's conversation, if there is one.
      const pairs: Turn[] = [];
      for (const m of h.messages.slice(-4)) {
        if (m.role === 'user') pairs.push({ you: m.text, pam: '', spoken: 0 });
        else if (pairs.length) {
          const last = pairs[pairs.length - 1]!;
          last.pam = tidy(m.text);
          last.spoken = last.pam.length;
        }
      }
      if (pairs.length) return setTurns(pairs.slice(-2));
      if (arrivedAsking || !g?.text) return;
      // A fresh room: she greets him with the shape of the day — aloud once a
      // day (when the browser lets her), on the screen every time.
      const today = new Date().toDateString();
      const greeted = localStorage.getItem('pam-greeted') === today;
      setTurns([{ you: '', pam: g.text, spoken: greeted || mutedRef.current ? g.text.length : 0 }]);
      if (greeted || mutedRef.current || !chatEnabled) return;
      localStorage.setItem('pam-greeted', today);
      setOrb('speaking');
      const settle = () => {
        setTurns((ts) => (ts.length === 1 && !ts[0]!.you ? [{ ...ts[0]!, spoken: ts[0]!.pam.length }] : ts));
        if (stateRef.current === 'speaking') setOrb('idle');
      };
      const guard = setTimeout(settle, 14_000);
      void speak(g.text, () => {
        clearTimeout(guard);
        settle();
      });
    };
    void load();
    const tick = setInterval(() => setClock(Date.now()), 20_000);
    return () => {
      dead = true;
      clearInterval(tick);
      orbRef.current?.stop();
      orbRef.current = null;
      queueRef.current?.cancel();
      stopSpeaking();
      listenRef.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem('pam-muted', muted ? '1' : '0');
    if (muted) {
      queueRef.current?.cancel();
      stopSpeaking();
      if (stateRef.current === 'speaking') setOrb('idle');
      patchLast((t) => ({ ...t, spoken: t.pam.length }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [muted]);

  // Keep the newest words in view.
  useEffect(() => {
    const el = captionsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, partial, note]);

  // ------------------------------------------------------------------ ask
  const ask = useCallback(
    async (text: string, viaVoice: boolean, heardAlso: string[] = []) => {
      const question = text.trim();
      if (!question || stateRef.current === 'thinking') return;
      lastInputVoice.current = viaVoice;
      queueRef.current?.cancel();
      stopSpeaking();
      setPartial('');
      setNote('');
      setTurns((ts) => [...ts.slice(-3), { you: question, pam: '', spoken: 0 }]);
      setOrb('thinking');
      let answer = ''; // the current step's text (a new lookup resets it)
      let finalText = '';
      let failed = false;
      let firstPanel = true;
      const speaking = !mutedRef.current;
      // Streamed speech: she starts talking on her first complete sentence.
      const queue = speaking
        ? new SpeechQueue({
            onFirstWord: (ms) => {
              lastTtfw.current = Math.round(ms);
            },
            onSentence: (sentence) => {
              if (stateRef.current === 'thinking') setOrb('speaking');
              // Light the caption up to the end of the sentence now being said.
              patchLast((t) => {
                const key = tidy(sentence).slice(0, 18);
                const at = key ? t.pam.indexOf(key, Math.max(0, t.spoken - 4)) : -1;
                return at < 0 ? t : { ...t, spoken: Math.min(t.pam.length, at + tidy(sentence).length) };
              });
            },
            onIdle: () => {
              patchLast((t) => ({ ...t, spoken: t.pam.length }));
              if (stateRef.current !== 'speaking' && stateRef.current !== 'thinking') return; // barge-in already moved on
              // Hands-free loop: voice in → mic reopens (after a beat, so she
              // never hears her own last word); typed → it doesn't.
              if (lastInputVoice.current) setTimeout(() => stateRef.current !== 'listening' && beginListening(), 350);
              else setOrb('idle');
            },
          })
        : null;
      queueRef.current = queue;
      await streamChat(
        question,
        null,
        (e) => {
          if (e.type === 'text_delta') {
            answer += e.text;
            const shown = tidy(answer);
            patchLast((t) => ({ ...t, pam: shown, spoken: speaking ? Math.min(t.spoken, shown.length) : shown.length }));
            queue?.push(e.text);
          } else if (e.type === 'note_delta') {
            setNote((n) => (n + e.text).slice(-140));
            queue?.push(e.text);
          } else if (e.type === 'tool') {
            // Anything she said before reaching for a tool was a remark, not the answer.
            if (answer.trim()) {
              setNote(tidy(answer));
              answer = '';
              patchLast((t) => ({ ...t, pam: '', spoken: 0 }));
            } else setNote((n) => n || `${toolStatus(e.name)}…`);
            queue?.push('\n');
          } else if (e.type === 'panel') {
            // A new answer brings its own panels; the last answer's leave.
            setPanels((ps) => {
              const base = firstPanel ? [] : ps.filter((p) => !(p.kind === e.panel.kind && p.title === e.panel.title));
              firstPanel = false;
              return [...base, e.panel].slice(-3);
            });
          } else if (e.type === 'done') {
            finalText = e.text;
            if (e.timing) setTiming(e.timing);
          } else if (e.type === 'error') {
            failed = true;
            queue?.cancel();
            patchLast((t) => ({ ...t, pam: e.message, spoken: e.message.length, error: true }));
          }
        },
        { voice: true, ...(viaVoice ? { spoken: true, heard: heardAlso } : {}) },
      );
      setNote('');
      if (failed || !finalText) {
        queue?.cancel();
        if (!failed) patchLast((t) => ({ ...t, pam: 'I didn’t get an answer back — try that once more.', spoken: 99, error: true }));
        chime('stop');
        setOrb('idle');
        return;
      }
      const shown = tidy(finalText);
      lastSaid.current = finalText;
      patchLast((t) => ({ ...t, pam: shown, spoken: speaking ? Math.min(t.spoken, shown.length) : shown.length }));
      // She only says it on real wins (per her knowledge file) — so when she
      // does, the orb throws orange and green.
      if (/go\s*['’]?canes/i.test(finalText)) orbRef.current?.celebrate();
      if (queue) queue.close(); // flushes the last fragment; onIdle finishes the turn
      else setOrb('idle');
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const beginListening = useCallback(() => {
    primeAudio();
    listenRef.current?.stop();
    setMicReady(false);
    const handlers = {
      // The cue to speak comes when the mic is really open — words spoken
      // into a recognizer that is still starting are simply lost.
      onReady: () => {
        setMicReady(true);
        chime('listen');
      },
      onPartial: (t: string) => setPartial(t),
      onCommit: (t: string, alternatives: string[]) => {
        setPartial('');
        // Her own voice, caught by the mic as she finished? Not a question:
        // listen again (a couple of times at most).
        if (isEcho(t, lastSaid.current) && echoRetries.current < 2) {
          echoRetries.current++;
          setTimeout(() => stateRef.current === 'listening' && beginListening(), 250);
          return;
        }
        echoRetries.current = 0;
        lastHeard.current = { text: t, alternatives };
        chime('heard');
        void ask(t, true, alternatives);
      },
      onGiveUp: () => {
        setPartial('');
        if (stateRef.current === 'listening') setOrb('idle');
      },
      onError: (reason: string) => {
        setPartial('');
        // The browser's recognizer failed for a reason the server path can
        // survive (no service, network) — switch to it for this visit.
        if (!serverStt.current && /error: (network|service-not-allowed|language-not-supported|audio-capture)/.test(reason)) {
          serverStt.current = true;
          setEar('server');
          const again = startServerListening(handlers);
          if (again) {
            listenRef.current = again;
            return;
          }
        } else if (serverStt.current && recognitionSupported() && /transcribe/.test(reason)) {
          // Server transcription is not working (key, permission, network):
          // go back to the browser's ear rather than leave him without one.
          serverStt.current = false;
          setEar('browser');
          localStorage.removeItem('pam-ear');
        }
        setTurns((ts) => [...ts.slice(-3), { you: '', pam: reason, spoken: reason.length, error: true }]);
        setOrb('idle');
      },
    };
    const session = serverStt.current ? startServerListening(handlers) : startListening(handlers);
    if (session) {
      listenRef.current = session;
      setOrb('listening');
    }
  }, [ask, setOrb]);

  // Arrived from "Brief me" (or any link carrying ?ask=): ask it once.
  const askedFromUrl = useRef(false);
  useEffect(() => {
    if (askedFromUrl.current) return;
    const q = new URLSearchParams(window.location.search).get('ask');
    if (!q) return;
    askedFromUrl.current = true;
    // Consume the question — a refresh must not ask it again.
    window.history.replaceState(null, '', window.location.pathname);
    if (chatEnabled) void ask(q, false);
    else setTurns([{ you: q, pam: 'PAM cannot answer yet — her brain is not connected on the server.', spoken: 99, error: true }]);
  }, [ask, chatEnabled]);

  const interrupt = useCallback(() => {
    queueRef.current?.cancel();
    stopSpeaking();
    patchLast((t) => ({ ...t, spoken: t.pam.length }));
  }, []);

  const orbTap = useCallback(() => {
    primeAudio();
    if (!chatEnabled) return;
    if (stateRef.current === 'speaking') {
      // Barge-in: cut her off (queue + audio), open the mic immediately.
      interrupt();
      beginListening();
    } else if (stateRef.current === 'listening') {
      // A second tap means "I'm done": send what was said. With nothing
      // said yet, it closes the mic.
      if (listenRef.current?.finish()) return;
      listenRef.current?.stop();
      setPartial('');
      setOrb('idle');
    } else if (stateRef.current === 'idle') {
      echoRetries.current = 0;
      beginListening();
    }
  }, [beginListening, chatEnabled, interrupt, setOrb]);

  // Space talks, Escape quiets — the room works without a mouse.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.code === 'Space' && !typing && !e.repeat) {
        e.preventDefault();
        orbTap();
      } else if (e.key === 'Escape') {
        if (stateRef.current === 'speaking') {
          interrupt();
          setOrb('idle');
        } else if (stateRef.current === 'listening') {
          listenRef.current?.stop();
          setPartial('');
          setOrb('idle');
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [interrupt, orbTap, setOrb]);

  const toggleDiag = async () => {
    if (!showDiag) {
      const me = (await fetch('/api/settings')
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}))) as { ttsConfigured?: boolean; brain?: typeof brain };
      setDiag(await getDiagnostics(Boolean(me.ttsConfigured)));
      setBrain(me.brain ?? null);
      const h = (await fetch('/api/health/services?force=1')
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)) as typeof health;
      setHealth(h);
    }
    setShowDiag((v) => !v);
  };

  // A dead brain or voice key is announced in the status line up front, not
  // discovered as a raw 401 mid-conversation.
  useEffect(() => {
    fetch('/api/health/services')
      .then((r) => (r.ok ? r.json() : null))
      .then((h: typeof health) => setHealth(h))
      .catch(() => undefined);
  }, []);

  const statusText = !chatEnabled
    ? 'Chat needs an API key on the server'
    : health && !health.brain.ok && state === 'idle'
      ? 'Brain offline — open system check'
      : state === 'thinking'
        ? note || 'One moment'
        : state === 'listening'
          ? !micReady
            ? 'Opening the microphone…'
            : partial
              ? 'Listening — tap to send'
              : 'Listening — go ahead'
          : state === 'speaking'
            ? 'Tap the orb to interrupt'
            : 'Tap the orb and speak';

  const last = turns[turns.length - 1];
  const quiet = turns.length === 0 && !partial && state === 'idle';
  const now = new Date(clock);

  return (
    <div className={`orb-room s-${state}${panels.length ? ' has-panels' : ''}`}>
      <header className="orb-top">
        <Link to="/" className="orb-back" aria-label="Back to Today">← Today</Link>
        <div className="orb-clock" aria-hidden="true">
          <b>{now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</b>
          <span>{now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</span>
        </div>
        <button className="orb-mute" onClick={() => setMuted((m) => !m)} aria-pressed={muted}>
          {muted ? 'Voice off' : 'Voice on'}
        </button>
      </header>

      <div className="orb-main">
        {/* The shape of the day, always in view. */}
        <aside className="orb-ambient" aria-label="Today at a glance">
          {ambient && (
            <>
              <div className="amb">
                <span className="amb-k">Next</span>
                {ambient.nextEvent ? (
                  <>
                    <span className="amb-v">{ambient.nextEvent.time}</span>
                    <span className="amb-s">{ambient.nextEvent.title}</span>
                    <span className={`amb-t${ambient.nextEvent.court ? ' court' : ''}`}>
                      {[ambient.nextEvent.court ? 'Court' : '', fmtCountdown(ambient.nextEvent.startIso, clock)].filter(Boolean).join(' · ')}
                    </span>
                  </>
                ) : (
                  <span className="amb-s">Calendar clear</span>
                )}
              </div>
              <div className="amb amb-row">
                <div>
                  <span className="amb-k">Due today</span>
                  <span className="amb-n">{ambient.dueToday}</span>
                </div>
                <div>
                  <span className="amb-k">Overdue</span>
                  <span className={`amb-n${ambient.overdue ? ' hot' : ''}`}>{ambient.overdue}</span>
                </div>
                <div>
                  <span className="amb-k">Left today</span>
                  <span className="amb-n">{ambient.eventsLeft}</span>
                </div>
              </div>
            </>
          )}
          {sync && (
            <div className="amb amb-sync">
              <span className={`amb-dot ${sync.tone}`} />
              {sync.label}
              {sync.demo && <span className="amb-tag">Demo</span>}
              {sync.trial && <span className="amb-tag">Read only</span>}
            </div>
          )}
        </aside>

        <div className="orb-center">
          <div className="orb-stage">
            <canvas ref={canvasRef} className="orb-canvas" onClick={orbTap} role="button" aria-label="PAM orb — tap to talk" />
          </div>
          <div className="orb-status" aria-live="polite">
            <span className={`orb-dot s-${state}`} />
            {statusText}
          </div>

          <div className="orb-captions" ref={captionsRef}>
            {turns.map((t, i) => {
              const current = i === turns.length - 1;
              return (
                <div key={i} className={`orb-turn${current ? ' current' : ''}${t.error ? ' error' : ''}`}>
                  {t.you &&
                    (current && chatEnabled ? (
                      // Misheard? One tap puts the question in the box to fix and resend.
                      <button
                        type="button"
                        className="orb-you orb-you-edit"
                        title="Not what you said? Tap to correct it"
                        onClick={() => {
                          if (stateRef.current === 'speaking') interrupt();
                          if (stateRef.current === 'listening') listenRef.current?.stop();
                          setOrb('idle');
                          setInput(t.you);
                          inputRef.current?.focus();
                        }}
                      >
                        {t.you}
                      </button>
                    ) : (
                      <p className="orb-you">{t.you}</p>
                    ))}
                  {t.pam && (
                    <p className={`orb-say${t.pam.length > 300 ? ' long' : ''}`}>
                      <span className="said">{t.pam.slice(0, t.spoken)}</span>
                      <span className="unsaid">{t.pam.slice(t.spoken)}</span>
                    </p>
                  )}
                </div>
              );
            })}
            {partial && <p className="orb-you hearing">{partial}</p>}
          </div>

          {(quiet || (turns.length === 1 && !turns[0]!.you && state !== 'thinking' && !partial)) && chatEnabled && (
            <div className="orb-starters" aria-label="Things to ask">
              {STARTERS.map((q) => (
                <button
                  key={q}
                  type="button"
                  className="orb-starter"
                  onClick={() => {
                    primeAudio();
                    interrupt();
                    void ask(q, false);
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* What she found — the detail the voice only summarizes. */}
        <aside className="orb-panels" aria-label="Details">
          {panels.map((p, i) => (
            <PanelCard
              key={`${p.kind}:${p.title}:${i}`}
              panel={p}
              onOpenMatter={(id) => navigate(`/matters/${id}`)}
              onClose={() => setPanels((ps) => ps.filter((x) => x !== p))}
            />
          ))}
        </aside>
      </div>

      <form
        className="orb-input"
        onSubmit={(e) => {
          e.preventDefault();
          primeAudio();
          const t = input;
          setInput('');
          if (stateRef.current === 'speaking') interrupt();
          if (stateRef.current === 'listening') listenRef.current?.stop();
          void ask(t, false);
        }}
      >
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={chatEnabled ? 'Or type a question…' : 'Chat unavailable'}
          disabled={!chatEnabled || state === 'thinking'}
          aria-label="Ask PAM"
        />
        <div className="orb-cmds">
          {last?.pam && last.you && (
            <FlagButton className="orb-cmd" label="Flag that answer" context={() => `Q: ${last.you} — A: ${last.pam}`} />
          )}
          <button type="button" className="orb-cmd" onClick={toggleDiag}>System check</button>
          <button
            type="button"
            className="orb-cmd"
            onClick={() => {
              interrupt();
              setOrb('idle');
              void fetch('/api/chat/new', { method: 'POST' }).then(() => {
                setTurns([]);
                setPanels([]);
              });
            }}
          >
            New chat
          </button>
        </div>
      </form>

      {showDiag && diag && (
        <div className="orb-diag">
          <div>
            listening: {ear === 'browser' ? 'browser recognizer (live words)' : 'recorded, then transcribed on the server'}
            {diag.recognitionSupported && (
              <>
                {' · '}
                <button
                  type="button"
                  className="orb-diag-link"
                  onClick={() => {
                    const next = ear === 'browser' ? 'server' : 'browser';
                    serverStt.current = next === 'server';
                    setEar(next);
                    if (next === 'server') localStorage.setItem('pam-ear', 'server');
                    else localStorage.removeItem('pam-ear');
                  }}
                >
                  {ear === 'browser' ? 'try high-accuracy listening' : 'back to the browser recognizer'}
                </button>
              </>
            )}
          </div>
          <div>recognition: {diag.recognitionSupported ? 'supported' : 'not in this browser — PAM transcribes on the server instead'}</div>
          <div>
            last heard: {lastHeard.current ? `“${lastHeard.current.text}”${lastHeard.current.alternatives.length ? ` (also: ${lastHeard.current.alternatives.map((a) => `“${a}”`).join(', ')})` : ''}` : 'nothing yet'}
          </div>
          <div>microphone: {diag.micPermission}</div>
          <div>audio context: {diag.audioContextState}</div>
          <div>playback unlocked: {diag.audioUnlocked ? 'yes' : 'not yet — tap the orb once'}</div>
          <div>time to first word: {lastTtfw.current === null ? 'no reply yet' : `${(lastTtfw.current / 1000).toFixed(1)}s`}</div>
          {timing && (
            <div>
              last answer: {(timing.totalMs / 1000).toFixed(1)}s total · first response {((timing.prepMs + (timing.steps[0]?.ttftMs ?? 0)) / 1000).toFixed(1)}s ·{' '}
              {timing.steps.flatMap((s) => s.tools).length} lookup{timing.steps.flatMap((s) => s.tools).length === 1 ? '' : 's'}
              {timing.steps.some((s) => s.cacheRead > 0) ? ' · warm' : ' · cold'}
            </div>
          )}
          {health && (
            <>
              <div style={{ color: health.brain.ok ? undefined : 'var(--alert)' }}>brain: {health.brain.detail}</div>
              <div style={{ color: health.voice.ok ? undefined : 'var(--alert)' }}>voice: {health.voice.detail}</div>
            </>
          )}
          <div>voice path: {diag.ttsPath}</div>
          <div>last error: {diag.lastError ?? 'none'}</div>
          {brain && (
            <>
              <div style={{ marginTop: 6 }}>
                brain key: {brain.source === 'none' ? 'MISSING' : `${brain.source} (${brain.prefix}…, ${brain.length} chars)`}
                {brain.source !== 'none' && !brain.looksAnthropic ? ' — DOES NOT LOOK LIKE AN ANTHROPIC KEY' : ''}
              </div>
              {brain.skipped.map((s, i) => (
                <div key={i} style={{ color: 'var(--alert)' }}>skipped: {s}</div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** One card of the heads-up display. */
function PanelCard({ panel, onOpenMatter, onClose }: { panel: Panel; onOpenMatter: (id: string) => void; onClose: () => void }) {
  return (
    <section className={`hud hud-${panel.kind}`}>
      <header className="hud-h">
        <div>
          <h3>{panel.title}</h3>
          {panel.caption && <span className="hud-cap">{panel.caption}</span>}
        </div>
        <button type="button" className="hud-x" onClick={onClose} aria-label={`Dismiss ${panel.title}`}>
          ×
        </button>
      </header>
      {panel.facts && panel.facts.length > 0 && (
        <dl className="hud-facts">
          {panel.facts.map((f) => (
            <div key={f.k}>
              <dt>{f.k}</dt>
              <dd>{f.tel ? <a href={`tel:${f.tel}`}>{f.v}</a> : f.v}</dd>
            </div>
          ))}
        </dl>
      )}
      {panel.items && panel.items.length > 0 && (
        <ul className="hud-items">
          {panel.items.map((it, i) => (
            <li key={i} className={it.tone ? `t-${it.tone}` : undefined}>
              {it.lead !== undefined && <span className="hud-lead">{it.lead}</span>}
              <span className="hud-body">
                {it.matterId ? (
                  <button type="button" className="hud-link" onClick={() => onOpenMatter(it.matterId!)}>
                    {it.title}
                  </button>
                ) : (
                  <b>{it.title}</b>
                )}
                {it.sub && <span className="hud-sub">{it.sub}</span>}
              </span>
              {it.tel && (
                <a className="hud-call" href={`tel:${it.tel}`} aria-label={`Call about ${it.title}`}>
                  Call
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
      {panel.more ? <div className="hud-more">+ {panel.more} more</div> : null}
      {panel.note && <div className="hud-note">{panel.note}</div>}
    </section>
  );
}
