/**
 * The reactor: a canvas particle orb in the firm's metals — brass embers on
 * the dark study, the corner-bracket monogram at its heart. Four states with
 * distinct motion so Jeff always knows where he stands without a label:
 *   idle      slow ambient breathing drift
 *   listening brightens, sonar rings expand outward
 *   thinking  particles spin faster and pull inward
 *   speaking  the field surges, driven by the live audio level
 */

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking';

interface Particle {
  angle: number;
  radius: number; // base orbital radius, fraction of orb radius
  speed: number;
  size: number;
  drift: number;
  tint: number; // 0 brass … 1 cream
}

export class OrbRenderer {
  private particles: Particle[] = [];
  private raf = 0;
  private state: OrbState = 'idle';
  private stateAt = performance.now();
  private level = 0;
  private levelSmooth = 0;
  private rings: { born: number }[] = [];
  private reduced = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private getLevel: () => number,
  ) {
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const count = this.reduced ? 90 : 240;
    for (let i = 0; i < count; i++) {
      this.particles.push({
        angle: Math.random() * Math.PI * 2,
        radius: 0.35 + Math.random() * 0.62,
        speed: (0.0025 + Math.random() * 0.006) * (Math.random() < 0.5 ? 1 : -1),
        size: 0.8 + Math.random() * 1.9,
        drift: Math.random() * Math.PI * 2,
        tint: Math.random(),
      });
    }
  }

  setState(s: OrbState) {
    if (s === this.state) return;
    this.state = s;
    this.stateAt = performance.now();
    if (s === 'listening') this.rings.push({ born: performance.now() });
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
    const R = Math.min(w, h) * 0.36;
    const t = performance.now() / 1000;

    this.level = this.state === 'speaking' ? this.getLevel() : 0;
    this.levelSmooth += (this.level - this.levelSmooth) * 0.25;
    const lvl = this.levelSmooth;

    const breathe = this.reduced ? 0 : Math.sin(t * (this.state === 'idle' ? 0.7 : 1.4)) * 0.02;
    const surge = this.state === 'speaking' ? lvl * 0.22 : 0;
    const inward = this.state === 'thinking' ? 0.82 : 1;
    const speedMul = this.state === 'thinking' ? 3.2 : this.state === 'speaking' ? 1.6 : this.state === 'listening' ? 1.15 : 1;
    const bright = this.state === 'listening' ? 1.25 : this.state === 'speaking' ? 1.1 + lvl * 0.6 : 1;

    // ambient halo
    const halo = g.createRadialGradient(cx, cy, R * 0.1, cx, cy, R * 1.55);
    halo.addColorStop(0, `rgba(194, 160, 92, ${0.16 * bright})`);
    halo.addColorStop(0.6, `rgba(120, 84, 46, ${0.07 * bright})`);
    halo.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = halo;
    g.fillRect(0, 0, w, h);

    // sonar rings while listening
    const nowMs = performance.now();
    this.rings = this.rings.filter((r) => nowMs - r.born < 2400);
    if (this.state === 'listening' && !this.reduced && (nowMs - this.stateAt) % 1200 < 17) {
      this.rings.push({ born: nowMs });
    }
    for (const r of this.rings) {
      const age = (nowMs - r.born) / 2400;
      g.beginPath();
      g.arc(cx, cy, R * (0.55 + age * 0.9), 0, Math.PI * 2);
      g.strokeStyle = `rgba(194, 160, 92, ${0.35 * (1 - age)})`;
      g.lineWidth = 1;
      g.stroke();
    }

    // particles
    for (const p of this.particles) {
      p.angle += p.speed * speedMul;
      const wob = this.reduced ? 0 : Math.sin(t * 0.9 + p.drift) * 0.035;
      const r = R * (p.radius * inward + breathe + wob + surge * (0.4 + p.radius));
      const x = cx + Math.cos(p.angle) * r;
      const y = cy + Math.sin(p.angle) * r * 0.94;
      const cream = p.tint > 0.82;
      const alpha = (cream ? 0.85 : 0.55) * Math.min(1, bright) * (0.5 + p.radius * 0.5);
      g.beginPath();
      g.arc(x, y, p.size * (this.state === 'speaking' ? 1 + lvl * 0.8 : 1), 0, Math.PI * 2);
      g.fillStyle = cream
        ? `rgba(236, 223, 201, ${alpha})`
        : `rgba(${Math.round(163 + p.tint * 60)}, ${Math.round(128 + p.tint * 40)}, ${Math.round(63 + p.tint * 30)}, ${alpha})`;
      g.fill();
    }

    // the monogram heart — corner brackets in brass
    const bs = R * 0.34;
    g.strokeStyle = `rgba(194, 160, 92, ${0.9 * Math.min(bright, 1.2)})`;
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(cx - bs, cy - bs + bs * 0.45);
    g.lineTo(cx - bs, cy - bs);
    g.lineTo(cx - bs + bs * 0.45, cy - bs);
    g.moveTo(cx + bs, cy + bs - bs * 0.45);
    g.lineTo(cx + bs, cy + bs);
    g.lineTo(cx + bs - bs * 0.45, cy + bs);
    g.stroke();
    g.font = `400 ${Math.round(R * 0.30)}px Marcellus, Georgia, serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = `rgba(232, 215, 184, ${0.92})`;
    g.fillText('P·M', cx, cy + R * 0.01);
  }
}
