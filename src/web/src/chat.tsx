import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { streamChat, type Citation } from './api.js';

/** Shared chat panel — desktop dock, drawer, and the mobile /chat tab.
 *  History is server-side: reloads resume the open conversation. */

interface ChatMsg {
  kind: 'user' | 'pam' | 'err';
  text: string;
  citations?: Citation[];
  streaming?: boolean;
}

/** Jeff's own phrasings (docs/08 §2, docs/10 §15). */
const SUGGESTIONS = [
  'What does my day look like?',
  'What are the top five cases I’ve been negotiating on?',
  'What tasks are overdue?',
  'Where do we stand on settlement in the Grasso matter?',
];

const TOOL_LABELS: Record<string, string> = {
  get_calendar_events: 'checking the calendar…',
  get_tasks: 'reviewing tasks…',
  search_matters: 'searching matters…',
  get_matter_overview: 'opening the matter…',
  find_stalled_matters: 'scanning for stalled matters…',
  list_firm_staff: 'checking the roster…',
};

export function ChatPanel({ chatEnabled, prefill }: { chatEnabled: boolean; prefill?: string }) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [toolNote, setToolNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState(prefill ?? '');
  const threadRef = useRef<HTMLDivElement>(null);

  // Resume the open server-side conversation on mount.
  useEffect(() => {
    fetch('/api/chat/history')
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((h: { messages: { role: string; text: string; citations: Citation[] }[] }) => {
        setMessages(
          h.messages.map((m) => ({
            kind: m.role === 'user' ? 'user' : 'pam',
            text: m.text,
            citations: m.citations,
          })),
        );
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [messages, toolNote]);

  const newConversation = async () => {
    await fetch('/api/chat/new', { method: 'POST' }).catch(() => undefined);
    setMessages([]);
  };

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setInput('');
    setBusy(true);
    setMessages((m) => [...m, { kind: 'user', text: message }, { kind: 'pam', text: '', streaming: true }]);

    await streamChat(message, null, (e) => {
      if (e.type === 'text_delta') {
        setToolNote(null);
        setMessages((m) => {
          const last = m[m.length - 1]!;
          return [...m.slice(0, -1), { ...last, text: last.text + e.text }];
        });
      } else if (e.type === 'tool') {
        setToolNote(TOOL_LABELS[e.name] ?? 'working…');
      } else if (e.type === 'done') {
        setToolNote(null);
        setMessages((m) => [...m.slice(0, -1), { kind: 'pam', text: e.text, citations: e.citations }]);
      } else if (e.type === 'error') {
        setToolNote(null);
        setMessages((m) => [...m.slice(0, -1), { kind: 'err', text: e.message }]);
      }
    });
    setBusy(false);
  };

  return (
    <div className="chat-panel">
      <div className="chat-head">
        <span className="chat-title">Ask PAM</span>
        {messages.length > 0 && (
          <button className="btn ghost small" onClick={() => void newConversation()} disabled={busy}>
            + New conversation
          </button>
        )}
      </div>
      <div className="chat-thread" ref={threadRef}>
        {loaded && messages.length === 0 && (
          <div className="empty" style={{ padding: 20 }}>
            Ask about your day, a matter, or a settlement. Every answer cites the Smokeball records
            it came from.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.kind === 'err' ? 'err' : m.kind}`}>
            {m.kind === 'pam' ? <Linkified text={m.text || (m.streaming ? '…' : '')} /> : m.text}
            {m.citations && m.citations.length > 0 && (
              <div className="chips">
                {m.citations.slice(0, 10).map((c, j) => (
                  <CitationChip key={j} citation={c} />
                ))}
              </div>
            )}
          </div>
        ))}
        {toolNote && <div className="tool-note">{toolNote}</div>}
      </div>
      {messages.length === 0 && (
        <div className="suggest">
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => void send(s)} disabled={!chatEnabled || busy}>
              {s}
            </button>
          ))}
        </div>
      )}
      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <input
          className="input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={chatEnabled ? 'Message PAM…' : 'Chat needs an API key on the server'}
          disabled={!chatEnabled || busy}
          aria-label="Message PAM"
        />
        <button className="btn primary" disabled={!chatEnabled || busy || !input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

/** Render PAM's text with phone numbers as tap-to-call links. */
const PHONE_SPLIT = /(\(\d{3}\)\s?\d{3}[-.]\d{4}|\b\d{3}[-.]\d{3}[-.]\d{4}\b)/g;
const isPhone = (s: string) => /^(\(\d{3}\)\s?\d{3}[-.]\d{4}|\d{3}[-.]\d{3}[-.]\d{4})$/.test(s);

function Linkified({ text }: { text: string }) {
  const parts = text.split(PHONE_SPLIT);
  return (
    <>
      {parts.map((part, i) =>
        isPhone(part) ? (
          <a key={i} href={`tel:${part.replace(/[^\d]/g, '')}`}>
            {part}
          </a>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function CitationChip({ citation }: { citation: Citation }) {
  const label = citation.label.length > 46 ? `${citation.label.slice(0, 44)}…` : citation.label;
  if (citation.kind === 'matter') {
    return (
      <Link className="chip" to={`/matters/${citation.id}`}>
        <span className="txt">{label}</span>
      </Link>
    );
  }
  return (
    <span className="chip" title={citation.label}>
      <span className="txt">{label}</span>
    </span>
  );
}
