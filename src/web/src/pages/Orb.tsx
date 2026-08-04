import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { streamChat } from '../api.js';
import { OrbRenderer, type OrbState } from '../orb-canvas.js';
import {
  getDiagnostics,
  getLevel,
  primeAudio,
  speak,
  startListening,
  stopSpeaking,
  type ListenSession,
  type VoiceDiagnostics,
} from '../voice.js';

/**
 * The orb room — PAM as a presence, not a chat column. Full-page takeover on
 * the dark frame; the reactor dominates; text is secondary and terminal-like.
 * Voice on by default (Adam's call), with a persistent one-tap mute for an
 * office with ears.
 */

interface Line {
  who: 'you' | 'pam' | 'sys';
  text: string;
  typed?: boolean; // pam lines type themselves in once
}

const STATUS: Record<string, string> = {
  idle: 'TAP THE ORB OR TYPE BELOW',
  listening: 'LISTENING — PAUSE WHEN YOU’RE DONE',
  thinking: 'PROCESSING',
  speaking: 'SPEAKING — TAP TO INTERRUPT',
};

export function OrbPage({ chatEnabled }: { chatEnabled: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<OrbRenderer | null>(null);
  const listenRef = useRef<ListenSession | null>(null);
  const lastInputVoice = useRef(false);
  const [state, setState] = useState<OrbState>('idle');
  const [lines, setLines] = useState<Line[]>([]);
  const [partial, setPartial] = useState('');
  const [input, setInput] = useState('');
  const [muted, setMuted] = useState(() => localStorage.getItem('pam-muted') === '1');
  const [diag, setDiag] = useState<VoiceDiagnostics | null>(null);
  const [brain, setBrain] = useState<{ source: string; prefix: string; length: number; looksAnthropic: boolean; skipped: string[] } | null>(null);
  const [showDiag, setShowDiag] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  const setOrb = useCallback((s: OrbState) => {
    setState(s);
    rendererRef.current?.setState(s);
  }, []);

  useEffect(() => {
    const r = new OrbRenderer(canvasRef.current!, getLevel);
    rendererRef.current = r;
    r.start();
    // Resume open conversation transcript
    fetch('/api/chat/history')
      .then((res) => (res.ok ? res.json() : { messages: [] }))
      .then((h: { messages: { role: string; text: string }[] }) => {
        setLines(
          h.messages.slice(-6).map((m) => ({ who: m.role === 'user' ? 'you' : 'pam', text: m.text, typed: true })),
        );
      })
      .catch(() => undefined);
    return () => {
      r.stop();
      stopSpeaking();
      listenRef.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    localStorage.setItem('pam-muted', muted ? '1' : '0');
    if (muted) stopSpeaking();
  }, [muted]);

  const addLine = (l: Line) => setLines((ls) => [...ls.slice(-9), l]);

  const ask = useCallback(
    async (text: string, viaVoice: boolean) => {
      if (!text.trim() || stateRef.current === 'thinking') return;
      lastInputVoice.current = viaVoice;
      setPartial('');
      addLine({ who: 'you', text });
      setOrb('thinking');
      let finalText = '';
      await streamChat(text, null, (e) => {
        if (e.type === 'done') {
          finalText = e.text;
        } else if (e.type === 'error') {
          finalText = '';
          addLine({ who: 'sys', text: e.message });
        }
      });
      if (!finalText) {
        setOrb('idle');
        return;
      }
      addLine({ who: 'pam', text: finalText });
      if (!muted) {
        setOrb('speaking');
        await speak(finalText, () => {
          if (stateRef.current !== 'speaking') return; // barge-in already moved on
          // Hands-free loop: voice in → mic reopens; typed → it doesn't.
          if (lastInputVoice.current) beginListening();
          else setOrb('idle');
        });
      } else {
        setOrb('idle');
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [muted],
  );

  const beginListening = useCallback(() => {
    primeAudio();
    listenRef.current?.stop();
    const session = startListening({
      onPartial: (t) => setPartial(t),
      onCommit: (t) => {
        setOrb('thinking');
        void ask(t, true);
      },
      onGiveUp: () => {
        setPartial('');
        setOrb('idle');
      },
      onError: (reason) => {
        setPartial('');
        addLine({ who: 'sys', text: reason });
        setOrb('idle');
      },
    });
    if (session) {
      listenRef.current = session;
      setOrb('listening');
    }
  }, [ask, setOrb]);

  const orbTap = () => {
    primeAudio();
    if (stateRef.current === 'speaking') {
      // Barge-in: cut her off, open the mic immediately.
      stopSpeaking();
      beginListening();
    } else if (stateRef.current === 'listening') {
      listenRef.current?.stop();
      setPartial('');
      setOrb('idle');
    } else if (stateRef.current === 'idle') {
      beginListening();
    }
  };

  const toggleDiag = async () => {
    if (!showDiag) {
      const me = (await fetch('/api/settings')
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({}))) as { ttsConfigured?: boolean; brain?: typeof brain };
      setDiag(await getDiagnostics(Boolean(me.ttsConfigured)));
      setBrain(me.brain ?? null);
    }
    setShowDiag((v) => !v);
  };

  return (
    <div className="orb-room">
      <Link to="/" className="orb-back">[ ← back ]</Link>
      <button className="orb-mute" onClick={() => setMuted((m) => !m)} aria-pressed={muted}>
        {muted ? '[ voice off — tap to unmute ]' : '[ voice on ]'}
      </button>

      <div className="orb-stage">
        <canvas
          ref={canvasRef}
          className="orb-canvas"
          onClick={orbTap}
          role="button"
          aria-label="PAM orb — tap to talk"
        />
        <div className="orb-status" aria-live="polite">
          <span className={`orb-dot s-${state}`} />
          {chatEnabled ? STATUS[state] : 'CHAT NEEDS AN API KEY ON THE SERVER'}
        </div>
      </div>

      <div className="orb-console">
        {lines.map((l, i) => (
          <ConsoleLine key={i} line={l} isLast={i === lines.length - 1} />
        ))}
        {partial && (
          <div className="orb-line you">
            <span className="who">you ❯</span> {partial}
            <span className="caret">▋</span>
          </div>
        )}
      </div>

      <form
        className="orb-input"
        onSubmit={(e) => {
          e.preventDefault();
          primeAudio();
          const t = input;
          setInput('');
          void ask(t, false);
        }}
      >
        <span className="who">❯</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={chatEnabled ? 'ask pam…' : 'chat unavailable'}
          disabled={!chatEnabled || state === 'thinking'}
          aria-label="Ask PAM"
        />
        <button type="button" className="orb-cmd" onClick={toggleDiag}>[ system check ]</button>
        <button
          type="button"
          className="orb-cmd"
          onClick={() => {
            void fetch('/api/chat/new', { method: 'POST' }).then(() => setLines([]));
          }}
        >
          [ + new conversation ]
        </button>
      </form>

      {showDiag && diag && (
        <div className="orb-diag">
          <div>recognition: {diag.recognitionSupported ? 'supported' : 'NOT SUPPORTED in this browser'}</div>
          <div>microphone: {diag.micPermission}</div>
          <div>audio context: {diag.audioContextState}</div>
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

/** Typewriter for the newest PAM line: ~3s total regardless of length;
 *  history renders instantly. */
function ConsoleLine({ line, isLast }: { line: Line; isLast: boolean }) {
  const [shown, setShown] = useState(line.typed || line.who !== 'pam' || !isLast ? line.text : '');
  useEffect(() => {
    if (line.typed || line.who !== 'pam' || !isLast) {
      setShown(line.text);
      return;
    }
    const total = line.text.length;
    const step = Math.max(1, Math.ceil(total / (3000 / 30)));
    let i = 0;
    const t = setInterval(() => {
      i = Math.min(total, i + step);
      setShown(line.text.slice(0, i));
      if (i >= total) clearInterval(t);
    }, 30);
    return () => clearInterval(t);
  }, [line, isLast]);
  return (
    <div className={`orb-line ${line.who}`}>
      <span className="who">{line.who === 'you' ? 'you ❯' : line.who === 'pam' ? 'pam ❯' : '! ❯'}</span> {shown}
      {isLast && line.who === 'pam' && shown.length < line.text.length && <span className="caret">▋</span>}
    </div>
  );
}
