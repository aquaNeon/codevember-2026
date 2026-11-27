// SPECIMEN
// draws only on change; once still, accumulates jittered frames, then the loop stops

import {
  busy,
  finish,
  free,
  pass,
  raf,
  software,
  target,
  unraf,
  type Opts,
  type Pass,
  type Target,
} from "./gl";
import { PRESENT_FS, SCENE_FS } from "./shaders";

const MAX_DPR = 2;
const MAX_DT_S = 1 / 20;
const SAMPLES = 8; // change still-frame samples here
const PLAY_S = 18; // change playback length here
const SPIN_RAD_S = 0.14; // change turntable speed here
const SPIN_IDLE_S = 24;
const SPIN_TAU_S = 0.9;
const FLING_TAU_S = 0.45;
const DRAG_RAD = 3.4; // change drag sensitivity here
const YAW0 = 0.66;
const PITCH0 = 0.3;
const PITCH_MIN = 0.05;
const PITCH_MAX = 0.75;
const SLOW_MS = 25;
const MIN_SCALE = 0.5;
const BG = [0x16 / 255, 0x19 / 255, 0x1c / 255]; // change together with the page colour in index.html
// LOOPS
// counts as uniforms so the compiler keeps one copy of each loop body
const LOOP = new Int32Array([160, 32, 5, 4]); // change march, shadow, occlusion, fbm counts here
const TAP = new Int32Array([4, 3, 5, 1]); // change normal, relief, highlight taps and worley reach here

// FRAMING
// short side units; the still in index.html is sized and placed by the same numbers
export const FRAME = {
  wide: { focal: 1.86, centre: 0.53 },
  tall: { focal: 2.6, centre: 0.47 },
  tallBelow: 0.8, // change portrait aspect cutoff here
};

// TONES
// hematite (fresh, red) and goethite (old, ochre), linear rgb
const TONES = [
  [0.3, 0.082, 0.024, 0.105, 0.036, 0.017],
  [0.31, 0.135, 0.034, 0.105, 0.05, 0.022],
];

// JITTER
// halton 2, 3 minus a half, subpixel per sample
const JITTER = new Float32Array(SAMPLES * 2);
for (let i = 0; i < SAMPLES; i++) {
  JITTER[i * 2] = halton(i + 1, 2) - 0.5;
  JITTER[i * 2 + 1] = halton(i + 1, 3) - 0.5;
}

export type Knobs = {
  humidity: number;
  salt: number;
  scale: number;
  flake: number;
  tone: number;
};

export class Specimen {
  private gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject;
  private scene: Pass;
  private present: Pass;
  private parallel: boolean;
  private pending: Pass[];
  private linkedCount = 0;
  private linked = false;
  private hi: Target | undefined;
  private lo: Target | undefined;
  private shownTex: WebGLTexture | null = null;
  private raf = 0;
  private last = 0;
  private visible = false;
  private sized = false;
  private dirty = true;
  private samples = 0;
  private reducedMotion: boolean;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private scale = 1;
  private slowFrames = 0;
  private movingFrames = 0;
  private drawn = false;

  // STATE
  private age = 0;
  private playing = false;
  private knobs = new Float32Array([0.55, 0.35, 0.45, 0.5]);
  private tone = 0;
  private yaw = YAW0;
  private pitch = PITCH0;
  private spin = 0;
  private fling = 0;
  private idle = 0;
  private down = false;
  private px = 0;
  private py = 0;
  private dragAt = 0;

  onShown: () => void = () => {};
  onAge: (age: number, playing: boolean) => void = () => {};

  constructor(
    private canvas: HTMLCanvasElement | OffscreenCanvas,
    opts: Opts,
  ) {
    this.reducedMotion = opts.reducedMotion;
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: "high-performance",
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("webgl2 unavailable");
    // SOFTWARE GL
    // cpu renderers get the still before any shader compiles; ?gl forces the live path
    if (!opts.forceGl && software(gl)) {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      throw new Error("software gl");
    }
    this.gl = gl;
    this.parallel = !!gl.getExtension("KHR_parallel_shader_compile");
    this.scene = pass(gl, SCENE_FS);
    this.present = pass(gl, PRESENT_FS);
    this.pending = [this.scene, this.present];
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("no vao");
    this.vao = vao;
    if (opts.age != null) this.age = opts.age;
  }

  // HOST
  size(w: number, h: number, dpr: number) {
    this.cssW = Math.max(1, w);
    this.cssH = Math.max(1, h);
    this.dpr = dpr;
    this.sized = false;
    this.wake();
  }

  visibility(v: boolean) {
    this.visible = v;
    this.last = 0;
    this.wake();
  }

  motion(reduced: boolean) {
    this.reducedMotion = reduced;
    this.wake();
  }

  // PUBLIC
  setAge(t: number) {
    this.age = Math.min(1, Math.max(0, t));
    this.playing = false;
    this.touch();
  }

  play(on: boolean) {
    if (on && this.age >= 1) this.age = 0;
    this.playing = on;
    this.onAge(this.age, this.playing);
    this.touch();
  }

  tune(humidity: number, salt: number, scale: number, flake: number, tone: number) {
    this.knobs[0] = humidity;
    this.knobs[1] = salt;
    this.knobs[2] = scale;
    this.knobs[3] = flake;
    this.tone = tone ? 1 : 0;
    this.touch();
  }

  turn(dir: number) {
    if (this.reducedMotion) this.yaw += dir * 0.5;
    else this.fling += dir * 2.2;
    this.touch();
  }

  // INPUT
  press(x: number, y: number) {
    this.down = true;
    this.px = x;
    this.py = y;
    this.fling = 0;
    this.dragAt = performance.now();
    this.touch();
  }

  drag(x: number, y: number) {
    if (!this.down) return;
    const k = DRAG_RAD / Math.min(this.cssW, this.cssH);
    const dyaw = (x - this.px) * k;
    this.yaw += dyaw;
    this.pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, this.pitch + (y - this.py) * k * 0.5));
    const now = performance.now();
    const dt = Math.max(8, now - this.dragAt) / 1000;
    this.fling += (dyaw / dt - this.fling) * 0.5;
    this.dragAt = now;
    this.px = x;
    this.py = y;
    this.dirty = true;
    this.touch();
  }

  lift() {
    if (!this.down) return;
    this.down = false;
    if (performance.now() - this.dragAt > 80) this.fling = 0;
    this.wake();
  }

  // LOOP
  private touch() {
    this.idle = 0;
    this.dirty = true;
    this.wake();
  }

  private wake() {
    if (!this.raf && this.visible) this.raf = raf(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.visible) return;
    const gl = this.gl;
    if (!this.linked) {
      const p = this.pending[this.linkedCount];
      if (!(this.parallel && busy(gl, p))) {
        finish(gl, p);
        this.linkedCount++;
      }
      this.linked = this.linkedCount === this.pending.length;
      this.wake();
      return;
    }
    const dt = this.last ? Math.min(MAX_DT_S, Math.max(0, now - this.last) / 1000) : 1 / 60;
    const rawMs = this.last ? now - this.last : 0;
    this.last = now;
    if (!this.sized) this.resize();

    // AGE
    if (this.playing) {
      this.age = Math.min(1, this.age + dt / PLAY_S);
      if (this.age >= 1) this.playing = false;
      this.onAge(this.age, this.playing);
      this.dirty = true;
      this.idle = 0;
    }

    // TURNTABLE
    this.idle += dt;
    const goal = !this.reducedMotion && !this.down && this.idle < SPIN_IDLE_S ? SPIN_RAD_S : 0;
    this.spin += (goal - this.spin) * (1 - Math.exp(-dt / SPIN_TAU_S));
    if (goal === 0 && this.spin < 1e-3) this.spin = 0;
    if (!this.down) {
      this.fling *= this.reducedMotion ? 0 : Math.exp(-dt / FLING_TAU_S);
      if (Math.abs(this.fling) < 1e-3) this.fling = 0;
      const step = (this.spin + this.fling) * dt;
      if (step !== 0) {
        this.yaw += step;
        this.dirty = true;
      }
    }

    if (this.dirty) {
      this.adapt(rawMs);
      this.render(this.scale < 1 ? this.lo : this.hi, 0, false);
      this.samples = this.scale < 1 ? 0 : 1;
      this.dirty = false;
    } else if (this.samples < SAMPLES) {
      this.render(this.hi, this.samples, true);
      this.samples++;
      this.movingFrames = 0;
    }
    this.show();
    if (!this.drawn) {
      this.drawn = true;
      this.onShown();
    }
    if (this.playing || this.spin > 0 || this.fling !== 0 || this.samples < SAMPLES) this.wake();
    else this.last = 0;
  };

  // QUALITY
  // slow moving frames drop the moving resolution; still frames stay full
  private adapt(ms: number) {
    if (ms <= 0 || ms > 200) return;
    this.movingFrames++;
    if (ms > SLOW_MS) this.slowFrames++;
    if (this.movingFrames < 30) return;
    if (this.slowFrames > 18 && this.scale > MIN_SCALE) {
      this.scale = Math.max(MIN_SCALE, this.scale * 0.82);
      this.sized = false;
    }
    this.movingFrames = 0;
    this.slowFrames = 0;
  }

  private render(t: Target | undefined, sample: number, jitter: boolean) {
    if (!t) return;
    const gl = this.gl;
    const p = this.scene;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, t.w, t.h);
    gl.useProgram(p.prog);
    if (sample > 0) {
      gl.enable(gl.BLEND);
      gl.blendColor(0, 0, 0, 1 / (sample + 1));
      gl.blendFunc(gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA);
    } else gl.disable(gl.BLEND);
    const tall = this.cssW / this.cssH < FRAME.tallBelow;
    const f = tall ? FRAME.tall : FRAME.wide;
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    gl.uniform2f(p.u.uRes, t.w, t.h);
    gl.uniform2f(p.u.uJitter, jitter ? JITTER[sample * 2] : 0, jitter ? JITTER[sample * 2 + 1] : 0);
    gl.uniform1f(p.u.uSmear, jitter ? JITTER[sample * 2] * 1.6 : 0);
    gl.uniform2f(p.u.uFrame, f.centre, f.focal);
    gl.uniform1f(p.u.uPitch, this.pitch);
    gl.uniform2f(p.u.uYaw, c, s);
    gl.uniform4iv(p.u.uLoop, LOOP);
    gl.uniform4iv(p.u.uTap, TAP);
    gl.uniform1f(p.u.uAge, this.age);
    gl.uniform4fv(p.u.uKnobs, this.knobs);
    const tone = TONES[this.tone];
    gl.uniform3f(p.u.uRustA, tone[0], tone[1], tone[2]);
    gl.uniform3f(p.u.uRustB, tone[3], tone[4], tone[5]);
    gl.uniform3f(p.u.uBg, BG[0], BG[1], BG[2]);
    this.draw3();
    gl.disable(gl.BLEND);
    this.shownTex = t.tex;
  }

  private show() {
    const gl = this.gl;
    const p = this.present;
    if (!this.shownTex) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(p.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.shownTex);
    gl.uniform1i(p.u.uTex, 0);
    gl.uniform2f(p.u.uRes, this.canvas.width, this.canvas.height);
    this.draw3();
  }

  private draw3() {
    this.gl.bindVertexArray(this.vao);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  // RESIZE
  private resize() {
    const gl = this.gl;
    const dpr = Math.min(this.dpr || 1, MAX_DPR);
    if (!this.hi) this.scale = dpr > 1.4 ? 0.72 : 1;
    const w = Math.max(1, Math.round(this.cssW * dpr));
    const h = Math.max(1, Math.round(this.cssH * dpr));
    this.canvas.width = w;
    this.canvas.height = h;
    if (!this.hi || this.hi.w !== w || this.hi.h !== h) {
      free(gl, this.hi);
      this.hi = target(gl, w, h, false);
    }
    const lw = Math.max(1, Math.round(w * this.scale));
    const lh = Math.max(1, Math.round(h * this.scale));
    if (this.scale < 1 && (!this.lo || this.lo.w !== lw || this.lo.h !== lh)) {
      free(gl, this.lo);
      this.lo = target(gl, lw, lh, false);
    }
    this.sized = true;
    this.dirty = true;
  }

  dispose() {
    unraf(this.raf);
    this.raf = 0;
    const gl = this.gl;
    free(gl, this.hi);
    free(gl, this.lo);
    this.hi = this.lo = undefined;
    gl.deleteProgram(this.scene.prog);
    gl.deleteProgram(this.present.prog);
    gl.deleteVertexArray(this.vao);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

function halton(i: number, b: number) {
  let f = 1;
  let r = 0;
  while (i > 0) {
    f /= b;
    r += f * (i % b);
    i = Math.floor(i / b);
  }
  return r;
}
