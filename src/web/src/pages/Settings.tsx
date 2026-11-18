import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { setPrefs, usePrefs } from '../prefs.js';
import { Badge, EmptyState, Icon, Panel, SkeletonRows } from '../ui.js';

/**
 * Settings — Jeff's view is deliberately small: his voice, how the screen
 * looks, and what PAM has been taught. The identity/knowledge editors (how PAM thinks and what she knows)
 * are Adam's domain: they only render behind /settings?admin=1 so the page
 * never invites Jeff to rewire his own assistant.
 */

interface SettingsData {
  'identity.md': string;
  'knowledge.md': string;
  elevenlabs_voice_id: string;
  ttsConfigured: boolean;
}
interface Memory {
  id: string;
  type: string;
  hook: string;
  body: string;
  taughtBy: string;
  createdAt: string;
}

export function SettingsPage() {
  const [params] = useSearchParams();
  const admin = params.get('admin') === '1';
  const [data, setData] = useState<SettingsData | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [voiceId, setVoiceId] = useState('');
  const prefs = usePrefs();
  const [memories, setMemories] = useState<Memory[]>([]);
  const [seedResult, setSeedResult] = useState<string | null>(null);

  const loadMemories = () =>
    fetch('/api/memories')
      .then((r) => (r.ok ? r.json() : { memories: [] }))
      .then((d: { memories: Memory[] }) => setMemories(d.memories))
      .catch(() => undefined);
  useEffect(() => {
    void loadMemories();
  }, []);

  const forget = async (m: Memory) => {
    if (!window.confirm(`Forget "${m.hook}"? PAM won't remember it again unless you teach her.`)) return;
    await fetch(`/api/memories/${m.id}`, { method: 'DELETE' });
    void loadMemories();
  };

  const seed = async () => {
    setSeedResult('Sending…');
    const res = await fetch('/api/smokeball/seed', { method: 'POST' });
    const body = (await res.json().catch(() => ({}))) as { note?: string; error?: string };
    setSeedResult(res.ok ? (body.note ?? 'Submitted.') : `Failed: ${body.error ?? res.status}`);
  };

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d: SettingsData) => {
        setData(d);
        setVoiceId(d.elevenlabs_voice_id);
      })
      .catch(() => setErr('Could not load settings.'));
  }, []);

  const save = async (key: string, value: string) => {
    setSaved(null);
    setErr(null);
    const res = await fetch(`/api/settings/${key}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value }),
    });
    if (res.ok) setSaved(key);
    else setErr(`Saving ${key} failed.`);
  };

  if (err && !data)
    return (
      <div className="page-inner narrow">
        <div className="card">
          <EmptyState icon="alert" title={err}>Reload the page to try again.</EmptyState>
        </div>
      </div>
    );
  if (!data)
    return (
      <div className="page-inner narrow">
        <div className="card">
          <SkeletonRows rows={5} />
        </div>
      </div>
    );

  return (
    <div className="page-inner narrow">
      <Panel title="Voice" actions={saved === 'elevenlabs_voice_id' ? <span className="pill ok">Saved</span> : undefined} flush>
        <div className="set-row">
          <div className="set-label">
            <b>Premium voice</b>
            <span>{data.ttsConfigured ? 'PAM speaks with her ElevenLabs voice.' : 'Not connected — PAM uses this device’s built-in voice until a voice key is added on the server.'}</span>
          </div>
          <div className="set-control">
            <Badge tone={data.ttsConfigured ? 'success' : 'neutral'}>{data.ttsConfigured ? 'Connected' : 'Not connected'}</Badge>
          </div>
        </div>
        <div className="set-row">
          <div className="set-label">
            <label htmlFor="voiceid">ElevenLabs voice ID</label>
            <span>Optional — leave blank to use the default voice.</span>
          </div>
          <div className="set-control">
            <input id="voiceid" className="input" value={voiceId} onChange={(e) => setVoiceId(e.target.value)} placeholder="e.g. 21m00Tcm4TlvDq8ikWAM" />
            <button className="btn primary" onClick={() => void save('elevenlabs_voice_id', voiceId.trim())}>
              Save
            </button>
          </div>
        </div>
      </Panel>

      <Panel title="Appearance" flush>
        <div className="set-row">
          <div className="set-label">
            <b>Theme</b>
            <span>Light, dark, or follow this device.</span>
          </div>
          <div className="set-control">
            <div className="theme-seg inline">
              {(
                [
                  ['light', 'Light', 'sun'],
                  ['dark', 'Dark', 'moon'],
                  ['system', 'System', 'monitor'],
                ] as const
              ).map(([value, label, icon]) => (
                <button key={value} type="button" aria-pressed={prefs.theme === value} onClick={() => setPrefs({ theme: value })}>
                  <Icon name={icon} size={16} />
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="set-row">
          <div className="set-label">
            <label htmlFor="pref-large">Larger text</label>
            <span>Makes everything on every page bigger.</span>
          </div>
          <div className="set-control">
            <span className="toggle">
              <input id="pref-large" type="checkbox" checked={prefs.largeText} onChange={(e) => setPrefs({ largeText: e.target.checked })} />
              <span className="switch" />
            </span>
          </div>
        </div>
        <div className="set-row">
          <div className="set-label">
            <b>Hurricane mode</b>
            <span>Dresses the accents in Miami orange and Hurricane green — buttons, links and trim. Go Canes.</span>
          </div>
          <div className="set-control">
            <span className="toggle">
              <input type="checkbox" checked={prefs.canes} onChange={(e) => setPrefs({ canes: e.target.checked })} aria-label="Hurricane mode" />
              <span className="switch" />
            </span>
          </div>
        </div>
      </Panel>

      <Panel title="What PAM remembers" count={memories.length} flush>
        <div className="statute-note">
          Working preferences and firm process she has been taught — never client details. Tell her &ldquo;remember that&hellip;&rdquo; to add one; forget anything here.
        </div>
        {memories.length === 0 ? (
          <EmptyState icon="sparkle" title="Nothing yet. She learns as you talk." />
        ) : (
          <div>
            {memories.map((m) => (
              <div className="row" key={m.id}>
                <span className="t">
                  <Badge dot={false}>{m.type}</Badge>
                </span>
                <span className="grow">
                  <b>{m.hook}</b>
                  <div className="meta">{m.body}</div>
                </span>
                <span className="act">
                  <button className="btn ghost small" onClick={() => void forget(m)}>Forget</button>
                </span>
              </div>
            ))}
          </div>
        )}
      </Panel>

      {admin && (
        <>
          <HealthCard />
          <Panel title="Staging tools">
            <div className="stack">
              <p className="meta">
                Creates one clearly-labeled test task (due today) and one test event (tomorrow 10:00) through the live Smokeball API — proving reads and writes end to end. Both are safe to delete in Smokeball.
              </p>
              <button className="btn" onClick={() => void seed()}>Seed a test task + event</button>
              {seedResult && <div className="meta">{seedResult}</div>}
            </div>
          </Panel>
          <Editor
            title="Who PAM is"
            hint="Her voice and manner — written like a note to a new hire. Changes apply on her very next reply."
            value={data['identity.md']}
            onSave={(v) => save('identity.md', v)}
            savedFlag={saved === 'identity.md'}
          />
          <Editor
            title="What PAM always knows"
            hint="Stable firm facts the live data can't tell her: people, conventions, where things live."
            value={data['knowledge.md']}
            onSave={(v) => save('knowledge.md', v)}
            savedFlag={saved === 'knowledge.md'}
          />
        </>
      )}

      {err && (
        <div className="notice warn" role="alert">
          <Icon name="alert" size={17} />
          <div>{err}</div>
        </div>
      )}
    </div>
  );
}

function Editor({
  title,
  hint,
  value,
  onSave,
  savedFlag,
}: {
  title: string;
  hint: string;
  value: string;
  onSave: (v: string) => void;
  savedFlag: boolean;
}) {
  const [text, setText] = useState(value);
  return (
    <Panel title={title} actions={savedFlag ? <span className="pill ok">Saved</span> : undefined}>
      <div className="stack">
        <p className="meta">{hint}</p>
        <textarea className="input editor" value={text} onChange={(e) => setText(e.target.value)} aria-label={title} />
        <button className="btn primary" onClick={() => onSave(text)}>Save</button>
      </div>
    </Panel>
  );
}

/** Adam's door for checking the live system without anyone reading a file:
 *  a counts-only health report, and the narrow key that lets an outside
 *  checker fetch it (and nothing else). */
function HealthCard() {
  const [key, setKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    fetch('/api/diag/key')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { key?: string } | null) => setKey(j?.key ?? null))
      .catch(() => undefined);
  }, []);
  return (
    <Panel title="Health check">
      <div className="stack">
        <p className="meta">
          A report on how well PAM is reading the firm — counts and percentages only. No client names, matter numbers, notes, or figures appear in it, so it is safe to share when something needs checking.
        </p>
        <a className="btn primary" href="/api/diag" target="_blank" rel="noreferrer">
          Open the health report
          <Icon name="arrowUpRight" size={15} />
        </a>
        {key && (
          <div>
            <div className="meta">Diagnostics key — opens only the health pages (never Today, tasks, matters, or chat):</div>
            <div className="keybox">
              <code>{key}</code>
              <button
                className="btn ghost small"
                onClick={() => {
                  void navigator.clipboard?.writeText(key).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1800);
                  });
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        )}
      </div>
    </Panel>
  );
}
