import type { OrbState } from './orb-canvas.js';

/**
 * The presence, v4 — rendered, not drawn.
 *
 * A fragment shader lights a real sphere per pixel: a glass body with a
 * living interior (domain-warped noise, like slow convection under the
 * surface), a key light from the upper left, a soft specular bloom, a
 * fresnel rim, and a halo that fades to nothing — the canvas is transparent,
 * so the orb sits in the room rather than on a rectangle.
 *
 * Nothing rotates. State reads the way it does on a person:
 *
 *   idle       long slow breaths; the interior barely stirs
 *   listening  an inhale — it swells and brightens; soft rings travel outward
 *   thinking   breath held — a slight draw inward, the interior quickens
 *   speaking   body, light, and a hairline voice-ring ride the live waveform
 *
 * `celebrate()` is the Go-Canes surge: orange and green wash through the
 * interior and two colored waves leave the limb.
 */

const VERT = `attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}`;

const FRAG = `
precision highp float;
uniform vec2 uRes;
uniform float uTime, uInner, uBreath, uLevel, uListen, uThink, uSpeak, uCelebrate, uCanes, uWake;

// ---- noise -----------------------------------------------------------
float hash(vec3 p){p=fract(p*0.3183099+vec3(.71,.113,.419));p*=17.0;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float noise(vec3 x){
  vec3 i=floor(x), f=fract(x); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(hash(i),hash(i+vec3(1,0,0)),f.x),mix(hash(i+vec3(0,1,0)),hash(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash(i+vec3(0,0,1)),hash(i+vec3(1,0,1)),f.x),mix(hash(i+vec3(0,1,1)),hash(i+vec3(1,1,1)),f.x),f.y),f.z);
}
float fbm(vec3 p){float a=.5,s=0.;for(int i=0;i<4;i++){s+=a*noise(p);p=p*2.03+vec3(1.7,9.2,3.1);a*=.5;}return s;}
float hash2(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}

// ---- palette: ember shadow → oxblood → brass → cream -------------------
vec3 ramp(float t){
  t=clamp(t,0.,1.);
  vec3 ember=vec3(.075,.028,.022), ox=vec3(.37,.125,.075), brass=vec3(.83,.62,.31), cream=vec3(1.,.95,.82);
  vec3 c=mix(ember,ox,smoothstep(0.,.34,t));
  c=mix(c,brass,smoothstep(.26,.66,t));
  return mix(c,cream,smoothstep(.7,1.,t));
}
vec3 canes(float t){ // Miami orange / Hurricane green
  vec3 green=vec3(.02,.33,.19), orange=vec3(.96,.45,.13), cream=vec3(1.,.96,.86);
  vec3 c=mix(green*.35,green,smoothstep(0.,.35,t));
  c=mix(c,orange,smoothstep(.3,.7,t));
  return mix(c,cream,smoothstep(.72,1.,t));
}

void main(){
  vec2 uv=(gl_FragCoord.xy-.5*uRes)/min(uRes.x,uRes.y);
  // Breath and voice move the body itself.
  float R=.292*(1.+.026*uBreath+.05*uListen-.022*uThink+.07*uSpeak*uLevel)*(.82+.18*uWake);
  vec2 p=uv/R;
  float r=length(p);
  float energy=.44+.14*uBreath+.36*uListen+.12*uThink+uSpeak*(.20+.78*uLevel);
  energy*=uWake;
  float party=clamp(uCelebrate,0.,1.);
  float tint=max(uCanes*.55,party);

  vec3 col=vec3(0.); float alpha=0.;

  if(r<1.){
    float z=sqrt(1.-r*r);
    vec3 n=vec3(p,z);
    vec3 L=normalize(vec3(-.52,.60,.61));
    vec3 V=vec3(0.,0.,1.);
    float diff=max(dot(n,L),0.);

    // Interior: look THROUGH the glass. Two layers of slow convection at
    // different depths (the near one bent harder by the lens) give the body
    // real parallax — a volume, not a painted disc. They drift; they never turn.
    float t=uInner;
    vec3 q1=vec3(p*(1.02+.42*(1.-z)),z*.8);
    vec3 q2=vec3(p*(.66+.16*(1.-z))+vec2(.09,-.06),z*.45+3.);
    vec3 w=vec3(fbm(q1*1.15+vec3(0.,t*.20,t*.12)),fbm(q1*1.15+vec3(5.2,-t*.16,1.3+t*.10)),fbm(q2*1.1+vec3(-3.1,2.7,t*.15)));
    float f1=fbm(q1*1.65+1.55*w+vec3(0.,0.,t*.15));
    float f2=fbm(q2*1.25+1.1*w.zxy+vec3(t*.06,0.,-t*.08));
    float fil=pow(1.-abs(2.*fbm(q1*2.5+1.9*w-vec3(0.,t*.11,0.))-1.),8.);
    // A warm heart, pulled toward the light.
    vec2 hc=p-vec2(-.09,.11);
    float core=exp(-6.2*dot(hc,hc));
    float bloom=exp(-1.9*dot(hc,hc));
    float glow=smoothstep(.34,.86,f1)*.46+smoothstep(.3,.8,f2)*.30+fil*(.10+.22*uThink+.30*uSpeak*uLevel)+core*(.30+.62*energy)+bloom*.16*energy;
    glow*=.42+.82*energy;
    // Depth: the limb is thicker glass — darker, cooler.
    float depth=mix(.08,1.,pow(z,1.1));
    // Soft shoulder: bright states glow hotter without burning to flat white.
    float tone=.05+(1.-exp(-1.5*glow*depth))*.98;
    vec3 body=mix(ramp(tone),canes(tone+.08*sin(t*3.+r*9.)*party),tint);
    // Lit from the upper left; the far side falls into shadow.
    body*=mix(.5,1.08,smoothstep(-.85,.55,dot(n,L)));

    // Thinking: a candle-flicker shimmer that crawls across the interior.
    body*=1.+uThink*.16*sin(t*7.+f1*18.);

    // Glass: a thin fresnel rim (brighter on the lit side), a crisp key
    // highlight with a soft bloom around it, and a faint bounce from below.
    float fres=pow(1.-z,3.2);
    vec3 rimCol=mix(vec3(.93,.74,.42),vec3(.98,.55,.2),tint);
    body+=rimCol*fres*(.34+.5*energy)*(.22+.78*smoothstep(-.6,.8,dot(n.xy,normalize(L.xy))));
    vec3 H=normalize(L+V);
    float nh=max(dot(n,H),0.);
    body+=vec3(1.,.97,.9)*(pow(nh,160.)*.9+pow(nh,22.)*.13)*(.8+.2*uBreath);
    // A second, fainter glint low on the far side — the room reflected.
    body+=vec3(1.,.9,.75)*pow(max(dot(n,normalize(vec3(.42,-.48,.77))),0.),90.)*.16;
    body+=vec3(.55,.22,.13)*pow(max(dot(n,normalize(vec3(.4,-.72,.28))),0.),4.)*.09;
    // The very edge darkens, as real glass does where it turns away.
    body*=1.-.3*smoothstep(.965,1.,r);

    col=body; alpha=1.;
    // Anti-aliased limb.
    float edge=smoothstep(1.,1.-2.2/(R*min(uRes.x,uRes.y)),r);
    alpha*=edge; col*=edge;
  }

  // ---- outside the body: halo, waves, voice ring, dust ------------------
  float d=max(r-1.,0.);
  vec3 glowCol=mix(vec3(.93,.66,.34),vec3(.97,.5,.16),tint);
  float halo=exp(-d*6.5)*.30*energy+exp(-d*2.2)*.075*energy;

  // Listening: soft rings travelling outward (an inhale made visible).
  float rings=0.;
  if(uListen>.01){
    float ph=d*9.-uTime*2.4;
    rings=uListen*pow(.5+.5*sin(ph),6.)*exp(-d*2.4)*.34;
  }
  // Speaking: one hairline ring that the voice plucks — static, not turning.
  float ang=atan(p.y,p.x);
  // (cos/sin of the angle keep the noise seamless where the circle closes.)
  vec2 dir=vec2(cos(ang),sin(ang));
  float wobble=(noise(vec3(dir*1.6,uTime*3.2))-.5)*.14*uLevel+(noise(vec3(dir*4.2,uTime*6.))-.5)*.05*uLevel;
  float ringR=1.2+.045*uLevel+wobble;
  float lit=.45+.55*noise(vec3(dir*1.1+7.,uTime*.9));
  float ring=uSpeak*smoothstep(.011,0.,abs(r-ringR))*(.12+.75*uLevel)*lit;
  ring+=uSpeak*smoothstep(.006,0.,abs(r-(1.3+.5*wobble)))*.10*uLevel*lit;
  // Celebration: two colored waves leaving the limb.
  float wave=0.; vec3 waveCol=vec3(0.);
  if(party>.01){
    float a1=(1.-party)*2.2, a2=max((1.-party)*2.2-.35,0.);
    float w1=smoothstep(.05,0.,abs(d-a1))*party, w2=smoothstep(.05,0.,abs(d-a2))*party;
    waveCol=vec3(.96,.45,.13)*w1+vec3(.05,.55,.3)*w2; wave=w1+w2;
  }
  // Dust hanging in its gravity: sparse, twinkling, barely drifting.
  float dust=0.;
  for(int k=0;k<2;k++){
    float sc=k==0?26.:41.;
    vec2 g=p*sc+vec2(0.,uTime*(k==0?.05:-.035));
    vec2 id=floor(g), fr=fract(g)-.5;
    float h=hash2(id+float(k)*17.);
    if(h>.93){
      vec2 o=vec2(hash2(id+3.1),hash2(id+7.7))-.5;
      float tw=.5+.5*sin(uTime*(.6+h*1.4)+h*40.);
      dust+=smoothstep(.09,0.,length(fr-o*.6))*tw*smoothstep(1.75,1.05,r)*smoothstep(.55,1.02,r);
    }
  }

  float outA=(halo+rings+ring)*(1.-alpha);
  col+=glowCol*(halo+rings)*(1.-alpha)+vec3(1.,.9,.72)*ring*(1.-alpha)+waveCol+vec3(1.,.9,.7)*dust*.5*uWake;
  alpha=clamp(alpha+outA+wave*.8+dust*.4*uWake,0.,1.);

  // Fade to nothing before the canvas edge — no rectangle, ever.
  // (per-axis so a wide or tall canvas still fades on all four sides)
  vec2 e=abs(gl_FragCoord.xy/uRes-.5)*2.;
  float vign=smoothstep(1.,.8,max(e.x,e.y))*smoothstep(.55,.24,length(uv)*.9);
  col*=vign; alpha*=vign;
  gl_FragColor=vec4(col,alpha); // premultiplied
}`;

export interface OrbLike {
  start(): void;
  stop(): void;
  setState(s: OrbState): void;
  celebrate(): void;
}

export class OrbGL implements OrbLike {
  private gl: WebGLRenderingContext;
  private prog: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private raf = 0;
  private state: OrbState = 'idle';
  private last = performance.now();
  private t = 0;
  private inner = Math.random() * 40;
  private breathPhase = 0;
  private level = 0;
  private listen = 0;
  private think = 0;
  private speak = 0;
  private wake = 0;
  private celebrateAt = -1e9;
  private scale = 1;
  private slowFrames = 0;
  private reduced: boolean;
  private ro: ResizeObserver | null = null;

  /** Throws when WebGL is unavailable — the caller falls back to the 2D orb. */
  constructor(
    private canvas: HTMLCanvasElement,
    private getLevel: () => number,
  ) {
    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, powerPreference: 'high-performance' });
    if (!gl) throw new Error('no webgl');
    this.gl = gl;
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s) ?? ''}`);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(prog) ?? ''}`);
    this.prog = prog;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const name of ['uRes', 'uTime', 'uInner', 'uBreath', 'uLevel', 'uListen', 'uThink', 'uSpeak', 'uCelebrate', 'uCanes', 'uWake']) {
      this.u[name] = gl.getUniformLocation(prog, name);
    }
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  setState(s: OrbState): void {
    this.state = s;
  }

  celebrate(): void {
    this.celebrateAt = performance.now();
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.scale;
    const w = Math.max(2, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(2, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.gl.viewport(0, 0, w, h);
    }
  }

  start(): void {
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.canvas);
    this.resize();
    const frame = (now: number) => {
      this.raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - this.last) / 1000);
      // A phone that can't hold the frame rate gets a smaller buffer, once or twice.
      if (now - this.last > 34) {
        if (++this.slowFrames > 45 && this.scale > 0.5) {
          this.scale *= 0.75;
          this.slowFrames = 0;
          this.resize();
        }
      } else if (this.slowFrames > 0) this.slowFrames--;
      this.last = now;
      const s = this.state;
      const calm = this.reduced ? 0.35 : 1;
      const ease = (cur: number, target: number, rate: number) => cur + (target - cur) * Math.min(1, dt * rate);
      this.listen = ease(this.listen, s === 'listening' ? 1 : 0, 5);
      this.think = ease(this.think, s === 'thinking' ? 1 : 0, 4);
      this.speak = ease(this.speak, s === 'speaking' ? 1 : 0, 6);
      this.wake = ease(this.wake, 1, 1.6);
      const raw = s === 'speaking' ? this.getLevel() : 0;
      // Fast attack, gentle release — light follows speech without strobing.
      this.level = raw > this.level ? ease(this.level, raw, 22) : ease(this.level, raw, 7);
      // Breath: ~11 a minute at rest, held while thinking, quicker while listening.
      const rate = s === 'thinking' ? 0.05 : s === 'listening' ? 0.3 : 0.18;
      this.breathPhase += dt * rate * Math.PI * 2 * calm;
      const breath = 0.5 + 0.5 * Math.sin(this.breathPhase);
      this.t += dt * calm;
      this.inner += dt * calm * (0.55 + 1.5 * this.think + 0.9 * this.speak * (0.4 + this.level) + 0.5 * this.listen);
      const sinceParty = (now - this.celebrateAt) / 1000;
      const party = sinceParty < 3.2 ? Math.max(0, 1 - sinceParty / 3.2) : 0;

      const gl = this.gl;
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform2f(this.u['uRes']!, this.canvas.width, this.canvas.height);
      gl.uniform1f(this.u['uTime']!, this.t);
      gl.uniform1f(this.u['uInner']!, this.inner);
      gl.uniform1f(this.u['uBreath']!, breath);
      gl.uniform1f(this.u['uLevel']!, this.level);
      gl.uniform1f(this.u['uListen']!, this.listen);
      gl.uniform1f(this.u['uThink']!, this.think);
      gl.uniform1f(this.u['uSpeak']!, this.speak);
      gl.uniform1f(this.u['uCelebrate']!, party);
      gl.uniform1f(this.u['uCanes']!, document.body.dataset['canes'] === '1' ? 1 : 0);
      gl.uniform1f(this.u['uWake']!, this.wake);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

let glOk: boolean | null = null;
/** Can this device compile and link the orb shader? Probed once, on a
 *  scratch canvas — a canvas that has handed out a WebGL context can never
 *  give a 2D one, so the real canvas must not be used to find out. */
export function orbGlSupported(): boolean {
  if (glOk !== null) return glOk;
  try {
    const probe = new OrbGL(document.createElement('canvas'), () => 0);
    probe.stop();
    glOk = true;
  } catch {
    glOk = false;
  }
  return glOk;
}

/** The shader orb when the device can draw it; the 2D orb otherwise. */
export async function createOrb(canvas: HTMLCanvasElement, getLevel: () => number): Promise<OrbLike> {
  if (orbGlSupported()) {
    try {
      return new OrbGL(canvas, getLevel);
    } catch {
      /* fall through to 2D — only reachable if the context was lost between probe and use */
    }
  }
  const { OrbRenderer } = await import('./orb-canvas.js');
  return new OrbRenderer(canvas, getLevel);
}
