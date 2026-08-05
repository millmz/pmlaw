import { useEffect, useState } from 'react';

/** Settings — Jeff edits who PAM is and what she always knows, in plain
 *  English. Saved server-side; takes effect on her very next reply. */

interface SettingsData {
  'identity.md': string;
  'knowledge.md': string;
  elevenlabs_voice_id: string;
  ttsConfigured: boolean;
}

export function SettingsPage() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [canes, setCanes] = useState(() => localStorage.getItem('pam-canes') === '1');

  useEffect(() => {
    document.body.dataset['canes'] = canes ? '1' : '';
    localStorage.setItem('pam-canes', canes ? '1' : '0');
  }, [canes]);

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(setData)
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

  if (err && !data) return <div className="page-inner"><div className="empty">{err}</div></div>;
  if (!data) return <div className="page-inner"><div className="skeleton" style={{ height: 120 }} /></div>;

  return (
    <div className="page-inner">
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
      <div className="card">
        <div className="card-h"><h2>Voice</h2><span className="rule" /></div>
        <div className="card-body">
          <p className="meta" style={{ marginTop: 0 }}>
            Premium voice: {data.ttsConfigured ? 'connected (ElevenLabs)' : 'not connected — add ELEVENLABS_API_KEY on the server; the browser voice covers until then.'}
          </p>
          <label className="meta" htmlFor="voiceid">ElevenLabs voice ID (optional — blank uses the default voice)</label>
          <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
            <input
              id="voiceid"
              className="input"
              defaultValue={data.elevenlabs_voice_id}
              placeholder="e.g. 21m00Tcm4TlvDq8ikWAM"
              onBlur={(e) => void save('elevenlabs_voice_id', e.target.value.trim())}
            />
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card-h"><h2>Game day</h2><span className="rule" /></div>
        <div className="card-body">
          <label className="canes-toggle">
            <input
              type="checkbox"
              checked={canes}
              onChange={(e) => setCanes(e.target.checked)}
              aria-label="Hurricane mode"
            />
            <span>
              <b>Hurricane mode</b>
              <span className="meta" style={{ display: 'block' }}>
                Dresses the accents in Miami orange and Hurricane green — links, tabs, and trim.
                The letterhead stays the firm&rsquo;s. Go Canes.
              </span>
            </span>
          </label>
        </div>
      </div>
      {err && <div className="empty" style={{ color: 'var(--alert)' }}>{err}</div>}
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
    <div className="card">
      <div className="card-h">
        <h2>{title}</h2>
        <span className="rule" />
        {savedFlag && <span className="pill ok">saved</span>}
      </div>
      <div className="card-body">
        <p className="meta" style={{ marginTop: 0 }}>{hint}</p>
        <textarea
          className="input"
          style={{ minHeight: 260, fontFamily: 'var(--serif)', fontSize: 16, lineHeight: 1.6, resize: 'vertical' }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label={title}
        />
        <div style={{ marginTop: 10 }}>
          <button className="btn primary" onClick={() => onSave(text)}>Save</button>
        </div>
      </div>
    </div>
  );
}
