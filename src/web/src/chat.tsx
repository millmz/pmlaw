import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { streamChat, type Citation } from './api.js';

/** Shared chat panel — desktop slide-over and the mobile /chat tab. */

interface ChatMsg {
  kind: 'user' | 'pam' | 'err';
  text: string;
  citations?: Citation[];
  streaming?: boolean;
}

const SUGGESTIONS = [
  'What does my day look like?',
  'What tasks are overdue?',
  'Where do we stand on settlement in the Grasso matter?',
  'Which matters have no next step?',
];

const TOOL_LABELS: Record<string, string> = {
  get_calendar_events: 'checking the calendar…',
  get_tasks: 'reviewing tasks…',
  search_matters: 'searching matters…',
  get_matter_overview: 'opening the matter…',
  find_stalled_matters: 'scanning for stalled matters…',
  list_firm_staff: 'checking the roster…',
};

export function ChatPanel({ chatEnabled }: { chatEnabled: boolean }) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [toolNote, setToolNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState('');
  const sessionRef = useRef<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight });
  }, [messages, toolNote]);

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    setInput('');
    setBusy(true);
    setMessages((m) => [...m, { kind: 'user', text: message }, { kind: 'pam', text: '', streaming: true }]);

    await streamChat(message, sessionRef.current, (e) => {
      if (e.type === 'text_delta') {
        setToolNote(null);
        setMessages((m) => {
          const last = m[m.length - 1]!;
          return [...m.slice(0, -1), { ...last, text: last.text + e.text }];
        });
      } else if (e.type === 'tool') {
        setToolNote(TOOL_LABELS[e.name] ?? 'working…');
      } else if (e.type === 'done') {
        sessionRef.current = e.sessionId;
        setToolNote(null);
        setMessages((m) => [
          ...m.slice(0, -1),
          { kind: 'pam', text: e.text, citations: e.citations },
        ]);
      } else if (e.type === 'error') {
        setToolNote(null);
        setMessages((m) => [...m.slice(0, -1), { kind: 'err', text: e.message }]);
      }
    });
    setBusy(false);
  };

  return (
    <div className="chat-panel">
      <div className="chat-thread" ref={threadRef}>
        {messages.length === 0 && (
          <div className="empty" style={{ padding: 20 }}>
            Ask PAM about your day, a matter, or a settlement. Every answer cites the Smokeball
            records it came from.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.kind === 'err' ? 'err' : m.kind}`}>
            {m.text || (m.streaming ? '…' : '')}
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

function CitationChip({ citation }: { citation: Citation }) {
  // Matter citations link straight to the matter page; others show identity.
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
