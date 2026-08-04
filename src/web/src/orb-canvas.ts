/**
 * The reactor, v2 — Jarvis-grade presence in the firm's metals. No logo, no
 * label: a luminous core wrapped in rotating instrument rings, read entirely
 * through motion:
 *
 *   idle       core breathes slowly; rings drift; particles orbit lazily
 *   listening  core brightens; a radar sweep circles; sonar rings expand
 *   thinking   rings accelerate and contract inward; particles tighten
 *   speaking   everything rides the live waveform — core pulse, ring radius,
 *              particle energy
 *
 * Brass and ember on the dark study — holographic in behavior, engraved in
 * palette.
 */

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking';

interface Particle {
  theta: number; // longitude on the sphere
  phi: number; // latitude
  speed: number;
  size: number;
  tint: number;
}

interface ArcRing {
  radius: number; // fraction of R
  width: number;
  speed: number; // rad/s, sign = direction
  arcs: { start: number; span: number }[];
  dashed?: boolean;
}

const TAU = Math.PI * 2;

export class OrbRenderer {
  private particles: Particle[] = [];
  private rings: ArcRing[] = [];
  private sonar: { born: number }[] = [];
  private raf = 0;
  private state: OrbState = 'idle';
  private stateAt = performance.now();
  private levelSmooth = 0;
  private ringPhase = 0;
  private sweep = 0;
  private lastT = performance.now();
  private reduced = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private getLevel: () => number,
  ) {
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const count = this.reduced ? 70 : 210;
    for (let i = 0; i < count; i++) {
      this.particles.push({
        theta: Math.random() * TAU,
        phi: Math.acos(2 * Math.random() - 1),
        speed: (0.05 + Math.random() * 0.22) * (Math.random() < 0.5 ? 1 : -1),
        size: 0.6 + Math.random() * 1.6,
        tint: Math.random(),
      });
    }
    // Instrument rings: three counter-rotating arc sets + one dashed tick ring.
    const mkArcs = (n: number): { start: number; span: number }[] =>
      Array.from({ length: n }, (_, i) => ({
        start: (i / n) * TAU + Math.random() * 0.5,
        span: (0.25 + Math.random() * 0.55) * (TAU / n),
      }));
    this.rings = [
      { radius: 0.58, width: 1.6, speed: 0.22, arcs: mkArcs(3) },
      { radius: 0.74, width: 1.1, speed: -0.14, arcs: mkArcs(4) },
      { radius: 0.9, width: 1.6, speed: 0.08, arcs: mkArcs(2) },
      { radius: 1.0, width: 1, speed: -0.045, arcs: [], dashed: true },
    ];
  }

  setState(s: OrbState) {
    if (s === this.state) return;
    this.state = s;
    this.stateAt = performance.now();
    if (s === 'listening') this.sonar.push({ born: performance.now() });
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
    if (c.width !== w * dpr || c.height !== h * dpr) {
      c.width = w * dpr;
      c.height = h * dpr;
    }
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.38;
    const nowMs = performance.now();
    const dt = Math.min(0.05, (nowMs - this.lastT) / 1000);
    this.lastT = nowMs;
    const t = nowMs / 1000;

    const level = this.state === 'speaking' ? this.getLevel() : 0;
    this.levelSmooth += (level - this.levelSmooth) * 0.3;
    const lvl = this.levelSmooth;

    const speedMul =
      this.state === 'thinking' ? 4.2 : this.state === 'speaking' ? 1.8 + lvl * 2 : this.state === 'listening' ? 1.3 : 1;
    const contract = this.state === 'thinking' ? 0.86 : 1;
    const bright =
      this.state === 'listening' ? 1.35 : this.state === 'speaking' ? 1.15 + lvl * 0.9 : this.state === 'thinking' ? 1.1 : 1;
    const breathe = this.reduced ? 0 : Math.sin(t * (this.state === 'idle' ? 0.6 : 1.3)) * 0.03;

    if (!this.reduced) this.ringPhase += dt * speedMul;
    this.sweep += dt * (this.state === 'listening' ? 1.6 : 0.25);

    // ---- ambient halo
    const halo = g.createRadialGradient(cx, cy, 0, cx, cy, R * 1.6);
    halo.addColorStop(0, `rgba(214, 178, 106, ${0.20 * bright})`);
    halo.addColorStop(0.45, `rgba(150, 106, 52, ${0.10 * bright})`);
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = halo;
    g.fillRect(0, 0, w, h);

    // ---- the core: layered luminous heart, breathing / pulsing
    const coreR = R * (0.30 + breathe + lvl * 0.10);
    const core = g.createRadialGradient(cx, cy, 0, cx, cy, coreR);
    core.addColorStop(0, `rgba(255, 244, 214, ${0.95 * Math.min(1.15, bright)})`);
    core.addColorStop(0.35, `rgba(238, 205, 130, ${0.75 * bright})`);
    core.addColorStop(0.75, `rgba(180, 130, 62, ${0.35 * bright})`);
    core.addColorStop(1, 'rgba(120, 80, 40, 0)');
    g.fillStyle = core;
    g.beginPath();
    g.arc(cx, cy, coreR, 0, TAU);
    g.fill();
    // inner iris ring
    g.beginPath();
    g.arc(cx, cy, coreR * 0.62, 0, TAU);
    g.strokeStyle = `rgba(120, 74, 34, ${0.5 * bright})`;
    g.lineWidth = 1.2;
    g.stroke();

    // ---- instrument rings
    for (const ring of this.rings) {
      const r = R * ring.radius * contract * (1 + (this.state === 'speaking' ? lvl * 0.10 * ring.radius : 0) + breathe * 0.4);
      const rot = this.ringPhase * ring.speed * 3;
      if (ring.dashed) {
        // tick ring: 72 fine graduations, like an instrument bezel
        g.save();
        g.translate(cx, cy);
        g.rotate(rot);
        g.strokeStyle = `rgba(194, 160, 92, ${0.4 * bright})`;
        g.lineWidth = 1;
        for (let i = 0; i < 72; i++) {
          const a = (i / 72) * TAU;
          const len = i % 6 === 0 ? 7 : 3;
          g.beginPath();
          g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
          g.lineTo(Math.cos(a) * (r + len), Math.sin(a) * (r + len));
          g.stroke();
        }
        g.restore();
      } else {
        for (const arc of ring.arcs) {
          g.beginPath();
          g.arc(cx, cy, r, arc.start + rot, arc.start + rot + arc.span);
          g.strokeStyle = `rgba(214, 178, 106, ${0.62 * bright})`;
          g.lineWidth = ring.width;
          g.lineCap = 'round';
          g.stroke();
          // arc endpoint node
          const ex = cx + Math.cos(arc.start + rot + arc.span) * r;
          const ey = cy + Math.sin(arc.start + rot + arc.span) * r;
          g.beginPath();
          g.arc(ex, ey, 1.8, 0, TAU);
          g.fillStyle = `rgba(236, 223, 201, ${0.8 * bright})`;
          g.fill();
        }
      }
    }

    // ---- radar sweep while listening
    if (this.state === 'listening' && !this.reduced) {
      const a = this.sweep % TAU;
      const grad = g.createConicGradient ? g.createConicGradient(a, cx, cy) : null;
      if (grad) {
        grad.addColorStop(0, 'rgba(214, 178, 106, 0.22)');
        grad.addColorStop(0.12, 'rgba(214, 178, 106, 0)');
        grad.addColorStop(1, 'rgba(214, 178, 106, 0)');
        g.fillStyle = grad;
        g.beginPath();
        g.moveTo(cx, cy);
        g.arc(cx, cy, R * 1.02, a, a + 0.9);
        g.closePath();
        g.fill();
      }
      // sonar pulses
      this.sonar = this.sonar.filter((s) => nowMs - s.born < 2200);
      if ((nowMs - this.stateAt) % 1100 < 17) this.sonar.push({ born: nowMs });
      for (const s of this.sonar) {
        const age = (nowMs - s.born) / 2200;
        g.beginPath();
        g.arc(cx, cy, R * (0.4 + age * 0.85), 0, TAU);
        g.strokeStyle = `rgba(214, 178, 106, ${0.3 * (1 - age)})`;
        g.lineWidth = 1;
        g.stroke();
      }
    }

    // ---- particle field: pseudo-3D sphere with Y-axis rotation for parallax
    const yaw = this.reduced ? 0 : t * 0.22 * speedMul;
    for (const p of this.particles) {
      p.theta += p.speed * dt * speedMul;
      const sinPhi = Math.sin(p.phi);
      const x3 = Math.cos(p.theta + yaw) * sinPhi;
      const z3 = Math.sin(p.theta + yaw) * sinPhi;
      const y3 = Math.cos(p.phi);
      const depth = (z3 + 1) / 2; // 0 back … 1 front
      const pr = R * (0.42 + 0.5 * contract) * (1 + lvl * 0.12);
      const x = cx + x3 * pr;
      const y = cy + y3 * pr * 0.92;
      const cream = p.tint > 0.85;
      const alpha = (0.15 + depth * 0.65) * (cream ? 1 : 0.7) * Math.min(bright, 1.3);
      g.beginPath();
      g.arc(x, y, p.size * (0.5 + depth * 0.8) * (this.state === 'speaking' ? 1 + lvl * 0.7 : 1), 0, TAU);
      g.fillStyle = cream
        ? `rgba(240, 228, 205, ${alpha})`
        : `rgba(${Math.round(170 + p.tint * 55)}, ${Math.round(132 + p.tint * 40)}, ${Math.round(70 + p.tint * 26)}, ${alpha})`;
      g.fill();
    }
  }
}
