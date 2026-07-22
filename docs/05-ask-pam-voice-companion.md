# 05 — "Ask Pam" Voice Companion (saved prompt — build later)

**Status: parked until the core platform is built and validated.** This is the build prompt for a voice-first AI companion experience layered on top of PAM, based on an architecture Adam has shipped before. Do not start this until the platform itself is working — at minimum through Sprint 4 (validated reads + confirmed writes), since Ask Pam's data snapshot and action tools sit on top of the platform's own data layer and confirmation framework.

When the time comes, follow the prompt below exactly as written — it is battle-tested and its phases (interview → map → propose → build tier by tier) are part of the design. Where it references "the platform's data model," that means this repo's built system (the Postgres cache, tool layer, and audit log from [docs/01](01-build-plan.md)); its hard rules (memory never stores client/matter specifics, two-phase confirmed actions, nothing client-facing) align with and must not weaken [docs/03](03-safety-and-permissions.md).

---

## The prompt (verbatim)

```text
I want you to build "Ask Pam" — an AI companion living inside this law-firm platform, modeled on a
proven build I've done before. Pam is a warm, sharp veteran legal-office manager: she knows the
firm's live data, remembers what we teach her, speaks when spoken to, and takes small actions only
with explicit confirmation. Internal tool for firm staff only — she never gives legal advice and
nothing she does is client-facing.

Work in phases. Do not skip ahead: (1) INTERVIEW me about the firm, the platform's data model, and
what staff would ask her daily. (2) MAP what data and actions the platform actually has. (3) PROPOSE
a tiered build plan. (4) BUILD one tier at a time, verifying each end-to-end before the next.

ARCHITECTURE (follow this — it's battle-tested):

Brain:
- Every request assembles a TWO-BLOCK system prompt. Block 1 (STABLE, marked with prompt-caching
  cache_control): her full identity file + operating rules + a capability list DERIVED from her real
  configuration + core firm knowledge. Block 2 (DYNAMIC, never cached): current time + a live JSON
  snapshot of platform data + recalled memories + (in conversations past ~14 turns) a personality
  checkpoint telling her to re-check her draft against her identity so she doesn't drift generic.
- Identity and core knowledge live as PLAIN EDITABLE TEXT FILES on the persistent data disk,
  mtime-cached so edits in a Settings page take effect on her very next reply. The identity file IS
  Pam — voice, rules of thumb, how blunt or gentle. Write it like a note to a new hire.
- Conversations persist server-side (Session + Turn tables, ~20-turn context window, full history
  kept). Reloading resumes the most recent OPEN session under 24h. "New conversation" must close ALL
  open sessions server-side (closed flag) — never just clear client state, or reloads resurrect old
  threads and the mount-time resume fetch races fast clicks. Guard the resume fetch so it never
  overwrites a thread the user already reset or started.
- Long-term memory: individual markdown files with front-matter (id, type: FACT/PREFERENCE/PROJECT/
  POINTER, one-line searchable hook, taught-by, date) on the data disk. Tools: save_memory,
  recall_memory, forget_memory (forget requires confirmed=true, set ONLY after the user explicitly
  confirms in-conversation). Keyword-overlap recall (hook weighted 3x), dedupe on save. A background
  extractor distills quiet sessions (2h+ idle, skip <4 turns as chatter) into durable memories,
  deduped against existing hooks. HARD RULE for a law firm: memory files NEVER store credentials,
  secrets, or client/matter specifics — client data lives only in the platform's own tables; memory
  is for preferences, process, corrections, and firm facts. Recalled memories are point-in-time:
  verify specifics against the live snapshot.
- Data: the snapshot carries a broad summary of everything (for a firm: matters and their stages,
  upcoming deadlines/statutes of limitation, calendar, unbilled time and AR, trust-account status,
  recent intake). A get_data tool pulls deep detail per section on demand. Refresh tools rebuild
  anything cached.
- Actions, gated: she may change the platform ONLY through explicit action tools (e.g., draft a
  client letter as a review-only draft, add a task/reminder, log an intake note), and every action is
  two-phase — confirmed=false returns a PREVIEW she must read back; confirmed=true is allowed only
  after a clear yes in this conversation. Never chain unrequested actions. Nothing destructive,
  nothing client-facing, no filings, no billing edits — for those she points to the right page. Her
  capability list must be derived from what's actually wired so she never claims more.

The room (interface):
- Her own full-viewport page, outside the app shell — no sidebar, a "[ ← back ]" command top-left.
- A large canvas-rendered particle orb (400px on desktop) as the thing you talk to: always breathing
  (never still), mood-eased states (idle breathes slowly / listening brightens + sonar ripples /
  thinking spins fast and pulls inward / speaking surges), and AUDIO-REACTIVE — route her TTS
  playback through a WebAudio AnalyserNode so the orb rides her actual waveform, and meter the mic
  while listening so she reacts to yours. Give the particle field a signature motif drawn from the
  firm's brand the way an agave rosette was drawn in light for a tequila brand.
- Text is secondary, terminal-style: a monospace console log (you ❯ / pam ❯) capped ~30vh with old
  lines fading out, typewriter animation on new replies (~3s regardless of length, blinking caret,
  history renders instantly), a bare command-line input with a ❯ prompt, lowercase bracket controls
  ([ voice replies on ] [ + new conversation ] [ system check ]), and a tiny uppercase status
  readout (● LISTENING — PAUSE WHEN YOU'RE DONE / ● PROCESSING / ● SPEAKING).
- Speech IN: browser SpeechRecognition, continuous=true with your own silence timer (~1.7s after
  speech stops commits the utterance; ~8s of nothing closes the mic quietly). Tap the orb while she's
  speaking = barge-in (cut her audio, open the mic). After she SPEAKS a reply to a SPOKEN question,
  reopen the mic automatically for a hands-free loop; typed questions never trigger it. Errors must
  be specific: no-speech is silent, permission-blocked explains exactly what to click.
- Speech OUT: ElevenLabs TTS via a server route (key server-side only, restricted to Text-to-Speech;
  voice id chosen in a Settings field, not env), browser speechSynthesis as fallback. Sanitize text
  before synthesis (strip emoji/markdown, cut at a sentence boundary). Answers must be plain
  conversational text — no markdown — because they may be read aloud.
- A "system check" button that diagnoses the whole voice/mic chain in plain words: site permissions
  policy, recognition support, mic permission state, TTS configured/working with the failure reason
  (bad key / key lacks permission / out of credits / bad voice id).

GOTCHAS we already paid for — avoid them: if the app sets a Permissions-Policy header, microphone
must be (self) not (); CSP needs media-src 'self' blob: or TTS audio silently falls back; wrap
audio.play() for mobile autoplay rejection; browser voices load async (wait once for voiceschanged
with a timeout); Chrome stalls speechSynthesis utterances >15s unless you pause/resume every 10s;
disconnect WebAudio nodes after each reply; new Audio + MediaElementSource per reply is fine, one
AudioContext reused.

Verify EVERYTHING end-to-end as you build: mock the LLM and TTS with local HTTP servers, drive the
UI with a real browser (Playwright), screenshot each state, and prove claims like "the analyser is
live" or "preview writes nothing to the DB" with assertions — not by reading the code back to me.
```

---

## Integration notes (for when this gets built)

- **Prerequisite:** core platform through Sprint 4 minimum — Ask Pam's `get_data` snapshot reads the platform's Postgres cache, and her action tools must route through the existing propose → confirm → execute → verify framework ([docs/03](03-safety-and-permissions.md)), not around it.
- **Snapshot contents:** the prompt lists unbilled time / AR / trust-account status in the example snapshot. Billing is currently out of scope for the platform ([docs/00](00-project-brief.md)); include those sections only if that scope decision changes — the interview phase (step 1) is where to settle it.
- **Particle-orb motif:** the firm-brand signature for the particle field is the corner-bracket device + ampersand from the Phillips & Millman logo, in the gold-on-burgundy palette (see the PAM mockup).
- **Voice + confidentiality:** spoken replies will say client/matter names out loud — fine inside the office, worth a note in the vendor/confidentiality review (ElevenLabs becomes a second external processor of matter-derived text; same review posture as the Anthropic API in [docs/03](03-safety-and-permissions.md)).
