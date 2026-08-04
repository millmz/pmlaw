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
let lastError: string | null = null;
let currentAudio: HTMLAudioElement | null = null;
let keepalive: ReturnType<typeof setInterval> | null = null;

/** Call inside EVERY user gesture — creates/resumes the context while the
 *  gesture window is open (the only time iOS allows it). */
export function primeAudio(): void {
  try {
    const Ctor =
      (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext })
        .AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    actx ??= new Ctor();
    if (actx.state === 'suspended') void actx.resume();
  } catch (e) {
    lastError = `audio prime: ${String(e)}`;
  }
}

/** 0..1 output level for the orb; 0 when not speaking or analyser skipped. */
export function getLevel(): number {
  if (!analyser) return 0;
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (const v of data) sum += Math.abs(v - 128);
  return Math.min(1, (sum / data.length / 40) * 1.6);
}

export function stopSpeaking(): void {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = '';
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

/** Speak a reply. Returns the path used. */
export async function speak(text: string, onEnd: () => void): Promise<TtsPath> {
  const clean = sanitizeForSpeech(text);
  if (!clean) {
    onEnd();
    return 'none';
  }
  stopSpeaking();
  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: clean }),
    });
    if (res.ok) {
      const blob = await res.blob();
      const audio = new Audio(URL.createObjectURL(blob));
      currentAudio = audio;
      analyser = routeThroughAnalyserIfRunning(actx, audio);
      audio.onended = () => {
        analyser = null;
        onEnd();
      };
      audio.onerror = audio.onended as never;
      try {
        await audio.play(); // mobile can reject; fall through to browser voice
      } catch (e) {
        lastError = `audio.play: ${String(e)}`;
        analyser = null;
        await speakBrowser(clean, onEnd);
        return 'browser';
      }
      return 'elevenlabs';
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    lastError = `tts: ${body.error ?? res.status}`;
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

/**
 * Continuous recognition with silence-based commit: ~1.7s of quiet after
 * speech commits the utterance; ~2.6s of nothing at all gives up quietly.
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

  let transcript = '';
  let commitTimer: ReturnType<typeof setTimeout> | null = null;
  let giveUpTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    cleanup();
    handlers.onGiveUp();
  }, 2600);
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
    let interim = '';
    for (let i = 0; i < ev.results.length; i++) {
      const r = ev.results[i]!;
      if (r.isFinal) transcript += r[0]!.transcript;
      else interim += r[0]!.transcript;
    }
    handlers.onPartial((transcript + interim).trim());
    if (commitTimer) clearTimeout(commitTimer);
    commitTimer = setTimeout(() => {
      const text = transcript.trim() || interim.trim();
      cleanup();
      if (text) handlers.onCommit(text);
      else handlers.onGiveUp();
    }, 1700);
  };
  rec.onerror = (ev: { error?: string }) => {
    cleanup();
    if (ev.error === 'no-speech') handlers.onGiveUp(); // silent, by design
    else if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed')
      handlers.onError('Microphone permission is blocked — allow the mic for this site in your browser settings.');
    else handlers.onError(`Speech recognition error: ${ev.error ?? 'unknown'}`);
  };
  rec.onend = () => {
    if (!done && transcript.trim()) {
      cleanup();
      handlers.onCommit(transcript.trim());
    }
  };
  try {
    rec.start();
  } catch (e) {
    handlers.onError(`Could not start the microphone: ${String(e)}`);
    return null;
  }
  return { stop: cleanup };
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
    ttsPath: ttsConfigured ? 'elevenlabs' : window.speechSynthesis ? 'browser' : 'none',
    lastError,
  };
}
