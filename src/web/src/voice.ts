/**
 * PAM's voice engine — TTS out (ElevenLabs relay with browser-synthesis
 * fallback), speech in (silence-commit recognition), and the iOS trap
 * handled: an AudioContext created outside a user gesture starts suspended,
 * and routing audio into a suspended graph "plays" silence. So: primeAudio()
 * inside every gesture, and the analyser path is used ONLY when the context
 * is running — otherwise straight playback (no waveform, but always a voice).
 */

export type TtsPath = 'elevenlabs' | 'browser' | 'none';

export interface VoiceDiagnostics {
  recognitionSupported: boolean;
  micPermission: string; // granted | denied | prompt | unknown
  audioContextState: string; // running | suspended | none
  audioUnlocked: boolean; // iOS: has a gesture blessed the playback element yet?
  ttsPath: TtsPath;
  lastError: string | null;
}

/** Strip everything a voice shouldn't read aloud. */
export function sanitizeForSpeech(text: string): string {
  return text
    .replace(/[*_#`>|]+/g, ' ') // markdown
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → label
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '') // emoji
    .replace(/❧|·|—/g, ', ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** The suspended-context guard, kept pure so it's testable. */
export function shouldRouteThroughAnalyser(state: string | undefined): boolean {
  return state === 'running';
}

/** Structural slice of AudioContext, so tests can fake a suspended one. */
export interface AudioContextLike {
  state: string;
  destination: unknown;
  createMediaElementSource(el: unknown): { connect(n: unknown): void };
  createAnalyser(): AnalyserNode;
}

/**
 * The iOS-trap routing decision in one place: on a RUNNING context, wire
 * audio → analyser → destination and return the analyser; on anything else
 * touch NOTHING (a suspended graph "plays" silence) and return null so the
 * element plays straight to the speaker.
 */
export function routeThroughAnalyserIfRunning(
  ctx: AudioContextLike | null,
  audio: unknown,
): AnalyserNode | null {
  if (!ctx || !shouldRouteThroughAnalyser(ctx.state)) return null;
  try {
    const src = ctx.createMediaElementSource(audio);
    const an = ctx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    an.connect(ctx.destination as AudioNode);
    return an;
  } catch {
    return null; // straight playback beats silence
  }
}

let actx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
/** Live microphone level while recording a question (server transcription path). */
let micAnalyser: AnalyserNode | null = null;
let lastError: string | null = null;
let currentAudio: HTMLAudioElement | null = null;
let keepalive: ReturnType<typeof setInterval> | null = null;

/** ONE reusable element for all TTS playback. iOS only lets play() succeed on
 *  an element that already played inside a user gesture — a fresh
 *  `new Audio()` created after an async fetch is never blessed, so replies
 *  would be silently rejected on iPhone. primeAudio() blesses this element
 *  with a beat of silence during the gesture; speak() then reuses it. */
let sharedAudio: HTMLAudioElement | null = null;
let audioUnlocked = false;
/** createMediaElementSource may be called once per element — cache the wiring. */
let wiredAnalyser: AnalyserNode | null = null;
let wireAttempted = false;

const SILENT_WAV =
  'data:audio/wav;base64,UklGRkQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YSAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';

/** Call inside EVERY user gesture — creates/resumes the context and blesses
 *  the shared audio element while the gesture window is open (the only time
 *  iOS allows either). */
export function primeAudio(): void {
  try {
    const Ctor =
      (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (Ctor) {
      actx ??= new Ctor();
      if (actx.state === 'suspended') void actx.resume();
    }
  } catch (e) {
    lastError = `audio prime: ${String(e)}`;
  }
  try {
    if (!sharedAudio) {
      sharedAudio = new Audio();
      sharedAudio.setAttribute('playsinline', '');
      sharedAudio.preload = 'auto';
    }
    // Never touch the element while a reply is playing through it.
    if (!audioUnlocked && !currentAudio) {
      const el = sharedAudio;
      el.muted = true;
      el.src = SILENT_WAV;
      const p = el.play();
      if (p && typeof p.then === 'function') {
        p.then(
          () => {
            el.pause();
            el.muted = false;
            audioUnlocked = true;
          },
          () => {
            el.muted = false; // stayed locked; we'll try again on the next tap
          },
        );
      } else {
        el.muted = false;
        audioUnlocked = true;
      }
    }
  } catch (e) {
    lastError = `audio unlock: ${String(e)}`;
  }
}

/** 0..1 output level for the orb; 0 when not speaking or analyser skipped. */
export function getLevel(): number {
  const an = analyser ?? micAnalyser;
  if (!an) return 0;
  const data = new Uint8Array(an.fftSize);
  an.getByteTimeDomainData(data);
  let sum = 0;
  for (const v of data) sum += Math.abs(v - 128);
  return Math.min(1, (sum / data.length / 40) * 1.6);
}

/** Tiny synthesized cues — the mic opening, a question received — so the
 *  room answers a tap instantly, before any speech. Silent when muted. */
export function chime(kind: 'listen' | 'heard' | 'stop'): void {
  try {
    if (!actx || actx.state !== 'running') return;
    if (localStorage.getItem('pam-muted') === '1') return;
    const now = actx.currentTime;
    const notes = kind === 'listen' ? [660, 990] : kind === 'heard' ? [880] : [520, 390];
    notes.forEach((freq, i) => {
      const osc = actx!.createOscillator();
      const gain = actx!.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const t = now + i * 0.075;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.05, t + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.connect(gain);
      gain.connect(actx!.destination);
      osc.start(t);
      osc.stop(t + 0.18);
    });
  } catch {
    /* a cue is a nicety */
  }
}

export function stopSpeaking(): void {
  if (currentAudio) {
    // Detach handlers BEFORE clearing the source: emptying src fires an error
    // event, which must not masquerade as "finished speaking."
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio.pause();
    currentAudio.removeAttribute('src');
    currentAudio = null;
  }
  if (keepalive) {
    clearInterval(keepalive);
    keepalive = null;
  }
  window.speechSynthesis?.cancel();
  analyser = null;
}

async function speakBrowser(text: string, onEnd: () => void): Promise<void> {
  const synth = window.speechSynthesis;
  if (!synth) {
    lastError = 'no speechSynthesis in this browser';
    onEnd();
    return;
  }
  // Voices load async — wait once (with timeout) if the list is empty.
  if (synth.getVoices().length === 0) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, 1200);
      synth.addEventListener('voiceschanged', () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    });
  }
  const utter = new SpeechSynthesisUtterance(text);
  const voices = synth.getVoices();
  utter.voice = voices.find((v) => v.lang.startsWith('en') && /female|Samantha|Karen|Serena/i.test(v.name)) ?? voices.find((v) => v.lang.startsWith('en')) ?? null;
  utter.rate = 1.02;
  utter.onend = () => {
    if (keepalive) clearInterval(keepalive);
    keepalive = null;
    onEnd();
  };
  utter.onerror = utter.onend;
  synth.speak(utter);
  // Chrome stalls utterances >~15s; nudge it alive.
  keepalive = setInterval(() => {
    if (synth.speaking) {
      synth.pause();
      synth.resume();
    }
  }, 10_000);
}

/** Safari wants byte-range support before it will play a stream; it gets
 *  the whole clip instead (still the fast voice model). */
const canStreamAudio = (): boolean => {
  const ua = navigator.userAgent;
  const safari = /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(ua);
  return !safari;
};

/** Ask the server for a clip. Streaming browsers get an id to play AS IT IS
 *  GENERATED; others get the finished audio. */
async function clipSource(clean: string): Promise<{ url: string; revoke?: () => void } | null> {
  if (canStreamAudio()) {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: clean, stream: true }),
    });
    if (res.ok) {
      const { id } = (await res.json()) as { id?: string };
      if (id) return { url: `/api/tts/clip/${id}` };
    } else {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      lastError = `tts: ${body.error ?? res.status}`;
      return null;
    }
  }
  const res = await fetch('/api/tts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: clean }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    lastError = `tts: ${body.error ?? res.status}`;
    return null;
  }
  const url = URL.createObjectURL(await res.blob());
  return { url, revoke: () => URL.revokeObjectURL(url) };
}

/** Speak a reply. Returns the path used. */
export async function speak(text: string, onEnd: () => void): Promise<TtsPath> {
  const clean = sanitizeForSpeech(text);
  if (!clean) {
    onEnd();
    return 'none';
  }
  stopSpeaking();
  try {
    const src = await clipSource(clean);
    if (src) {
      // Reuse the gesture-blessed element — a fresh Audio() here would be
      // rejected by iOS. If no gesture has primed one yet, fall back to a
      // fresh element (desktop allows it).
      const audio = sharedAudio ?? new Audio();
      sharedAudio = audio;
      audio.muted = false;
      audio.src = src.url;
      currentAudio = audio;
      // Wire the analyser once per element; reuse the cached wiring after.
      if (!wireAttempted && actx && shouldRouteThroughAnalyser(actx.state)) {
        wiredAnalyser = routeThroughAnalyserIfRunning(actx, audio);
        wireAttempted = true;
      }
      analyser = wiredAnalyser;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        analyser = null;
        src.revoke?.();
        onEnd();
      };
      audio.onended = finish;
      audio.onerror = finish as never;
      try {
        await audio.play(); // mobile can reject; fall through to browser voice
      } catch (e) {
        lastError = `audio.play: ${String(e)}`;
        audio.onended = null;
        audio.onerror = null;
        analyser = null;
        currentAudio = null;
        src.revoke?.();
        await speakBrowser(clean, onEnd);
        return 'browser';
      }
      return 'elevenlabs';
    }
  } catch (e) {
    lastError = `tts fetch: ${String(e)}`;
  }
  await speakBrowser(clean, onEnd);
  return 'browser';
}

// ---------------------------------------------------------------- speech in

// Web Speech types aren't in lib.dom — minimal structural declarations.
interface RecogAlternativeLike {
  transcript: string;
}
interface RecogResultLike {
  isFinal: boolean;
  0: RecogAlternativeLike;
}
interface RecogEventLike {
  results: ArrayLike<RecogResultLike>;
}
interface RecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: RecogEventLike) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => RecognitionLike;
const getRecognition = (): RecognitionCtor | undefined =>
  (window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor })
    .SpeechRecognition ??
  (window as unknown as { webkitSpeechRecognition?: RecognitionCtor }).webkitSpeechRecognition;

export interface ListenSession {
  stop: () => void;
}

export const recognitionSupported = (): boolean => Boolean(getRecognition());

/** Rebuild the utterance from a recognition event. The event carries EVERY
 *  result so far, so text must be rebuilt each time — appending re-added
 *  earlier phrases ("what's on what's on my calendar"). Pure, for tests. */
export function readResults(results: ArrayLike<RecogResultLike>): { final: string; interim: string } {
  let final = '';
  let interim = '';
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (r.isFinal) final += r[0]!.transcript;
    else interim += r[0]!.transcript;
  }
  return { final: final.trim(), interim: interim.trim() };
}

/** How long a pause means "I'm done". Shorter once the recognizer itself has
 *  marked the phrase final; longer while it is still mid-word. */
export const END_AFTER_FINAL_MS = 850;
export const END_AFTER_INTERIM_MS = 1500;
/** How long to wait for a first word before closing the mic. */
const GIVE_UP_MS = 8000;

/**
 * Continuous recognition with pause-based commit: a short quiet after a
 * finished phrase sends it; a long silence with no speech closes the mic.
 */
export function startListening(handlers: {
  onPartial: (text: string) => void;
  onCommit: (text: string) => void;
  onGiveUp: () => void;
  onError: (reason: string) => void;
}): ListenSession | null {
  const Ctor = getRecognition();
  if (!Ctor) {
    handlers.onError('Speech recognition is not supported in this browser — try Chrome, Edge, or Safari.');
    return null;
  }
  const rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = 'en-US';

  let heard = '';
  let commitTimer: ReturnType<typeof setTimeout> | null = null;
  let giveUpTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    cleanup();
    handlers.onGiveUp();
  }, GIVE_UP_MS);
  let done = false;

  const cleanup = () => {
    if (done) return;
    done = true;
    if (commitTimer) clearTimeout(commitTimer);
    if (giveUpTimer) clearTimeout(giveUpTimer);
    try {
      rec.stop();
    } catch {
      /* already stopped */
    }
  };

  rec.onresult = (ev: RecogEventLike) => {
    if (giveUpTimer) {
      clearTimeout(giveUpTimer);
      giveUpTimer = null;
    }
    const { final, interim } = readResults(ev.results);
    heard = `${final} ${interim}`.trim();
    handlers.onPartial(heard);
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = setTimeout(
      () => {
        const text = heard;
        cleanup();
        if (text) handlers.onCommit(text);
        else handlers.onGiveUp();
      },
      interim ? END_AFTER_INTERIM_MS : END_AFTER_FINAL_MS,
    );
  };
  rec.onerror = (ev: { error?: string }) => {
    const had = heard;
    cleanup();
    if (had) handlers.onCommit(had); // keep what was said; don't lose a question to a late error
    else if (ev.error === 'no-speech' || ev.error === 'aborted') handlers.onGiveUp(); // silent, by design
    else if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed')
      handlers.onError('Microphone permission is blocked — allow the mic for this site in your browser settings.');
    else handlers.onError(`Speech recognition error: ${ev.error ?? 'unknown'}`);
  };
  rec.onend = () => {
    if (done) return;
    const text = heard;
    cleanup();
    if (text) handlers.onCommit(text);
    else handlers.onGiveUp();
  };
  try {
    rec.start();
  } catch (e) {
    handlers.onError(`Could not start the microphone: ${String(e)}`);
    return null;
  }
  return { stop: cleanup };
}

/**
 * Listening without the browser's recognizer (Firefox, Chrome on iPhone, or
 * when the built-in one fails): record the question, detect the end of
 * speech from the microphone level, and have the server transcribe it.
 */
export function startServerListening(handlers: {
  onPartial: (text: string) => void;
  onCommit: (text: string) => void;
  onGiveUp: () => void;
  onError: (reason: string) => void;
}): ListenSession | null {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    handlers.onError('This browser cannot record audio — type your question instead.');
    return null;
  }
  let done = false;
  let stream: MediaStream | null = null;
  let recorder: MediaRecorder | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  const chunks: Blob[] = [];
  let spoke = false;

  const release = () => {
    if (poll) clearInterval(poll);
    poll = null;
    try {
      source?.disconnect();
    } catch {
      /* fine */
    }
    micAnalyser = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  };
  const finish = (send: boolean) => {
    if (done) return;
    done = true;
    const rec = recorder;
    if (!rec || rec.state === 'inactive') {
      release();
      if (!send) handlers.onGiveUp();
      return;
    }
    rec.onstop = () => {
      release();
      if (!send || !spoke) return handlers.onGiveUp();
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      handlers.onPartial('…');
      fetch('/api/stt', { method: 'POST', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob })
        .then(async (res) => {
          const j = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
          if (!res.ok) return handlers.onError(`Could not transcribe that (${j.error ?? res.status}) — type it instead.`);
          if (j.text?.trim()) handlers.onCommit(j.text.trim());
          else handlers.onGiveUp();
        })
        .catch(() => handlers.onError('Could not reach the server to transcribe that — type it instead.'));
    };
    rec.stop();
  };

  navigator.mediaDevices
    .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    .then((s) => {
      if (done) return s.getTracks().forEach((t) => t.stop());
      stream = s;
      recorder = new MediaRecorder(s);
      recorder.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      recorder.start(250);
      const started = performance.now();
      let lastLoud = 0;
      if (actx) {
        try {
          source = actx.createMediaStreamSource(s);
          const an = actx.createAnalyser();
          an.fftSize = 1024;
          source.connect(an);
          micAnalyser = an;
        } catch {
          micAnalyser = null;
        }
      }
      poll = setInterval(() => {
        const now = performance.now();
        const level = micAnalyser ? getLevel() : 0;
        if (level > 0.09) {
          spoke = true;
          lastLoud = now;
        }
        if (!micAnalyser) {
          // No level meter: fixed window, the user taps to send sooner.
          spoke = true;
          if (now - started > 9000) finish(true);
          return;
        }
        if (spoke && now - lastLoud > 1100) finish(true);
        else if (!spoke && now - started > GIVE_UP_MS) finish(false);
        else if (now - started > 45_000) finish(true);
      }, 80);
    })
    .catch((e: unknown) => {
      done = true;
      const name = (e as { name?: string })?.name;
      handlers.onError(
        name === 'NotAllowedError'
          ? 'Microphone permission is blocked — allow the mic for this site in your browser settings.'
          : `Could not open the microphone: ${String((e as Error)?.message ?? e)}`,
      );
    });

  // Tapping the orb while recording sends what was said so far.
  return { stop: () => finish(spoke) };
}

export async function getDiagnostics(ttsConfigured: boolean): Promise<VoiceDiagnostics> {
  let micPermission = 'unknown';
  try {
    const status = await navigator.permissions?.query({ name: 'microphone' as PermissionName });
    micPermission = status?.state ?? 'unknown';
  } catch {
    /* not queryable */
  }
  return {
    recognitionSupported: Boolean(getRecognition()),
    micPermission,
    audioContextState: actx?.state ?? 'none',
    audioUnlocked,
    ttsPath: ttsConfigured ? 'elevenlabs' : window.speechSynthesis ? 'browser' : 'none',
    lastError,
  };
}
