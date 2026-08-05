/**
 * The presence, v3 — a breathing sphere, not a machine. Nothing rotates.
 * The orb is a shaded three-dimensional body of light: lit from the upper
 * left, dark at the limb, a slow warm plasma drifting inside it, motes of
 * dust hanging in its gravity. It reads state the way a person does —
 * through breath and brightness:
 *
 *   idle       long, slow breaths; interior barely stirs
 *   listening  an inhale — the orb swells and brightens; soft luminous
 *              waves ripple outward
 *   thinking   breath held — slight contraction, interior quickens, a
 *              faint candle-flicker shimmer
 *   speaking   the body and its light ride the live waveform
 *
 * Palette stays the firm's: cream light, brass mid-tones, ember shadow.
 */

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking';

const TAU = Math.PI * 2;

/** A soft interior light mass on a slow Lissajous drift. */
interface Plasma {
  ax: number; // x amplitude, fraction of R
  ay: number;
  fx: number; // Hz — deliberately slow and mutually irrational
  fy: number;
  p1: number;
  p2: number;
  radius: number; // fraction of R
  warm: number; // 0 cream … 1 ember
}

/** A dust mote suspended near the sphere, giving it depth. */
interface Mote {
  theta: number;
  phi: number;
  dist: number; // radius multiple, 0.55…1.45
  drift: number; // very slow individual drift
  size: number;
  twinkle: number; // phase for slow brightness cycle
}

export class OrbRenderer {
  private plasma: Plasma[] = [];
  private motes: Mote[] = [];
  private ripples: { born: number }[] = [];
  private lastRipple = 0;
  private raf = 0;
  private state: OrbState = 'idle';
  private levelSmooth = 0;
  private breathPhase = 0; // integrated so breath rate can change smoothly
  private innerTime = 0; // integrated interior clock (speeds up thinking)
  private lastT = performance.now();
  private reduced = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private getLevel: () => number,
  ) {
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Interior plasma: few, large, slow. Frequencies chosen irrational-ish so
    // the pattern never visibly repeats.
    const defs: [number, number, number, number][] = [
      [0.30, 0.22, 0.043, 0.061],
      [0.24, 0.30, 0.057, 0.037],
      [0.34, 0.18, 0.031, 0.049],
      [0.16, 0.26, 0.067, 0.053],
    ];
    this.plasma = defs.map(([ax, ay, fx, fy], i) => ({
      ax, ay, fx, fy,
      p1: Math.random() * TAU,
      p2: Math.random() * TAU,
      radius: 0.34 + 0.1 * ((i * 37) % 3),
      warm: i / (defs.length - 1),
    }));
    const count = this.reduced ? 40 : 130;
    for (let i = 0; i < count; i++) {
      this.motes.push({
        theta: Math.random() * TAU,
        phi: Math.acos(2 * Math.random() - 1),
        dist: 0.55 + Math.random() * 0.9,
        drift: (Math.random() - 0.5) * 0.05,
        size: 0.5 + Math.random() * 1.3,
        twinkle: Math.random() * TAU,
      });
    }
  }

  setState(s: OrbState) {
    this.state = s;
  }

  start() {
    const loop = () => {
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() {
    cancelAnimationFrame(this.raf);
  }

  private draw() {
    const c = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== w * dpr || c.height !== h * dpr) {
      c.width = w * dpr;
      c.height = h * dpr;
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const nowMs = performance.now();
    const dt = Math.min(0.05, (nowMs - this.lastT) / 1000);
    this.lastT = nowMs;

    const level = this.state === 'speaking' ? this.getLevel() : 0;
    this.levelSmooth += (level - this.levelSmooth) * 0.25;
    const lvl = this.levelSmooth;

    // Breath: rate and depth are the state language. Idle is a long resting
    // breath (~7s); listening is a quicker, fuller inhale cycle; thinking is
    // nearly held; speaking barely breathes — the voice does the moving.
    const rate =
      this.state === 'idle' ? 0.9 : this.state === 'listening' ? 1.7 : this.state === 'thinking' ? 0.55 : 0.4;
    const depth =
      this.state === 'idle' ? 0.035 : this.state === 'listening' ? 0.05 : this.state === 'thinking' ? 0.012 : 0.015;
    this.breathPhase += dt * rate;
    const breath = this.reduced ? 0 : Math.sin(this.breathPhase) * depth;

    // Interior clock quickens while she works.
    const innerRate = this.state === 'thinking' ? 3.4 : this.state === 'speaking' ? 1.8 + lvl * 2 : 1;
    this.innerTime += dt * innerRate;
    const it = this.innerTime;

    // Body size: listening swells, thinking draws in, speaking rides the level.
    const posture =
      this.state === 'listening' ? 1.045 : this.state === 'thinking' ? 0.96 : 1;
    const R = Math.min(w, h) * 0.34 * posture * (1 + breath + lvl * 0.07);

    // Brightness, with a candle-flicker shimmer while thinking.
    let bright =
      this.state === 'listening' ? 1.3 : this.state === 'thinking' ? 1.08 : this.state === 'speaking' ? 1.1 + lvl * 0.8 : 1;
    if (this.state === 'thinking' && !this.reduced) {
      bright *= 1 + 0.05 * Math.sin(it * 7.1) + 0.035 * Math.sin(it * 11.7);
    }

    // ---- ambient aura, breathing with the body. It must reach fully
    // transparent BEFORE the canvas edge — otherwise the clip line shows as a
    // rectangle against the page background.
    const glowR = Math.min(cx, cy) * 0.98;
    const aura = g.createRadialGradient(cx, cy, R * 0.5, cx, cy, glowR);
    aura.addColorStop(0, `rgba(206, 164, 96, ${0.16 * bright})`);
    aura.addColorStop(0.5, `rgba(140, 92, 46, ${0.07 * bright})`);
    aura.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = aura;
    g.fillRect(0, 0, w, h);

    // ---- listening ripples: soft luminous waves, not lines
    if (this.state === 'listening' && !this.reduced) {
      if (nowMs - this.lastRipple > 1500) {
        this.ripples.push({ born: nowMs });
        this.lastRipple = nowMs;
      }
    }
    this.ripples = this.ripples.filter((r) => nowMs - r.born < 2600);
    for (const r of this.ripples) {
      const age = (nowMs - r.born) / 2600; // 0…1
      const band = R * 0.1 * (1 - age * 0.5);
      // Expand from the limb toward the canvas edge, but die before reaching it.
      const rr = R * 1.02 + age * Math.max(R * 0.3, glowR * 0.96 - band - R * 1.02);
      const wave = g.createRadialGradient(cx, cy, Math.max(0, rr - band), cx, cy, rr + band);
      const a = 0.16 * (1 - age) * (1 - age);
      wave.addColorStop(0, 'rgba(214, 178, 106, 0)');
      wave.addColorStop(0.5, `rgba(222, 190, 124, ${a})`);
      wave.addColorStop(1, 'rgba(214, 178, 106, 0)');
      g.fillStyle = wave;
      g.beginPath();
      g.arc(cx, cy, rr + band, 0, TAU);
      g.fill();
    }

    // ---- motes behind the sphere (depth < 0.5 draws first)
    this.drawMotes(g, cx, cy, R, it, bright, lvl, 'back');

    // ---- the body: a lit sphere
    // Base shading — light source upper-left, limb falling to deep ember.
    const lx = cx - R * 0.3;
    const ly = cy - R * 0.34;
    const body = g.createRadialGradient(lx, ly, R * 0.05, cx + R * 0.08, cy + R * 0.1, R * 1.02);
    body.addColorStop(0, `rgba(255, 246, 220, ${Math.min(1, 0.95 * bright)})`);
    body.addColorStop(0.16, `rgba(238, 202, 128, ${Math.min(1, 0.8 * bright)})`);
    body.addColorStop(0.42, 'rgba(150, 94, 48, 0.9)');
    body.addColorStop(0.72, 'rgba(78, 40, 25, 0.94)');
    body.addColorStop(1, 'rgba(38, 18, 12, 0.96)');
    g.fillStyle = body;
    g.beginPath();
    g.arc(cx, cy, R, 0, TAU);
    g.fill();

    // Interior plasma — clipped to the body, additive, drifting slowly.
    g.save();
    g.beginPath();
    g.arc(cx, cy, R * 0.985, 0, TAU);
    g.clip();
    g.globalCompositeOperation = 'lighter';
    const energy = this.state === 'thinking' ? 1.35 : this.state === 'speaking' ? 1.1 + lvl * 1.2 : this.state === 'listening' ? 1.15 : 1;
    // The heart: a steady warm glow at the center of mass, breathing with the
    // body — what makes the dark glass read as alive rather than hollow.
    const heart = g.createRadialGradient(cx, cy + R * 0.06, 0, cx, cy + R * 0.06, R * 0.6);
    heart.addColorStop(0, `rgba(255, 216, 152, ${(0.2 + lvl * 0.25) * energy * bright})`);
    heart.addColorStop(0.6, `rgba(224, 156, 88, ${0.08 * energy * bright})`);
    heart.addColorStop(1, 'rgba(224, 156, 88, 0)');
    g.fillStyle = heart;
    g.beginPath();
    g.arc(cx, cy + R * 0.06, R * 0.6, 0, TAU);
    g.fill();
    for (const p of this.plasma) {
      const px = cx + Math.sin(it * p.fx * TAU + p.p1) * p.ax * R;
      const py = cy + Math.sin(it * p.fy * TAU + p.p2) * p.ay * R;
      const pr = p.radius * R * (this.state === 'thinking' ? 0.82 : 1);
      const blob = g.createRadialGradient(px, py, 0, px, py, pr);
      const a = 0.14 * energy * bright;
      if (p.warm < 0.5) {
        blob.addColorStop(0, `rgba(255, 240, 200, ${a})`);
        blob.addColorStop(1, 'rgba(255, 240, 200, 0)');
      } else {
        blob.addColorStop(0, `rgba(224, 148, 84, ${a * 0.9})`);
        blob.addColorStop(1, 'rgba(224, 148, 84, 0)');
      }
      g.fillStyle = blob;
      g.beginPath();
      g.arc(px, py, pr, 0, TAU);
      g.fill();
    }
    // Specular highlight — the window-light on the glass, small and crisp.
    const spec = g.createRadialGradient(lx, ly, 0, lx, ly, R * 0.22);
    spec.addColorStop(0, `rgba(255, 252, 240, ${0.38 * Math.min(bright, 1.2)})`);
    spec.addColorStop(1, 'rgba(255, 252, 240, 0)');
    g.fillStyle = spec;
    g.beginPath();
    g.arc(lx, ly, R * 0.22, 0, TAU);
    g.fill();
    g.restore();

    // Fresnel rim — directional and soft. A whisper of edge all the way
    // around, a glowing crescent where the light wraps the upper-left limb,
    // and a faint bounce at the floor of the sphere.
    const lightAngle = Math.atan2(ly - cy, lx - cx);
    const edge = g.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * 1.03);
    edge.addColorStop(0, 'rgba(230, 196, 128, 0)');
    edge.addColorStop(0.8, `rgba(230, 196, 128, ${0.09 * bright})`);
    edge.addColorStop(1, 'rgba(230, 196, 128, 0)');
    g.fillStyle = edge;
    g.beginPath();
    g.arc(cx, cy, R * 1.03, 0, TAU);
    g.fill();
    g.save();
    g.lineCap = 'round';
    g.shadowColor = 'rgba(250, 231, 184, 0.9)';
    // Stacked arcs of widening span and falling alpha feather the crescent
    // into the limb instead of stopping on a hard cap.
    for (const [span, alpha, width] of [
      [1.9, 0.08, 0.014],
      [1.55, 0.16, 0.018],
      [1.15, 0.34, 0.022],
    ] as const) {
      g.strokeStyle = `rgba(250, 231, 184, ${alpha * bright})`;
      g.lineWidth = R * width;
      g.shadowBlur = R * 0.09;
      g.beginPath();
      g.arc(cx, cy, R * 0.975, lightAngle - span, lightAngle + span);
      g.stroke();
    }
    // floor bounce
    g.strokeStyle = `rgba(224, 170, 110, ${0.14 * bright})`;
    g.lineWidth = R * 0.016;
    g.shadowBlur = R * 0.06;
    g.beginPath();
    g.arc(cx, cy, R * 0.975, Math.PI / 2 - 0.7, Math.PI / 2 + 0.7);
    g.stroke();
    g.restore();

    // ---- motes in front of the sphere
    this.drawMotes(g, cx, cy, R, it, bright, lvl, 'front');
  }

  /** Dust hanging in the orb's gravity. No orbiting — each mote drifts on its
   *  own, very slowly, and twinkles; front/back split sells the depth. */
  private drawMotes(
    g: CanvasRenderingContext2D,
    cx: number,
    cy: number,
    R: number,
    it: number,
    bright: number,
    lvl: number,
    layer: 'back' | 'front',
  ) {
    for (const m of this.motes) {
      if (!this.reduced) m.theta += m.drift * 0.016;
      const sinPhi = Math.sin(m.phi);
      const z = Math.sin(m.theta) * sinPhi; // -1 back … +1 front
      if (layer === 'back' ? z >= 0 : z < 0) continue;
      const x = cx + Math.cos(m.theta) * sinPhi * R * m.dist;
      const y = cy + Math.cos(m.phi) * R * m.dist * 0.94;
      const depth = (z + 1) / 2;
      const tw = 0.55 + 0.45 * Math.sin(it * 0.6 + m.twinkle);
      const a = (0.06 + depth * 0.3) * tw * Math.min(bright, 1.25) * (1 + lvl * 0.5);
      g.beginPath();
      g.arc(x, y, m.size * (0.6 + depth * 0.5), 0, TAU);
      g.fillStyle = `rgba(238, 220, 186, ${a})`;
      g.fill();
    }
  }
}
