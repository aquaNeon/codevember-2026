import { FULL_VS, HAZE_FS, HORIZON, LOOP_S } from "./shaders";

const MAX_DPR = 2;
const MAX_DT_S = 0.05;

// HEAT
// the cursor warms the ground: quick to boil, slow to settle back to a shimmer
const HEAT = { upTauS: 0.45, downTauS: 1.8, moveTauS: 0.25, reachShare: 0.2 };
// EYE
// 0 is lying on the sand, 1 standing tall; lower eyes see more mirage
const EYE = { start: 0.62, perPx: 0.0011, tauS: 0.45, minM: 0.3, maxM: 2.4 };
const GROUND_C = 51;
const SCREEN_DEG = 30; // what the screen height is taken to span, for the readout

export type Hud = { eyeM: number; groundC: number; arcmin: number };
export type Opts = {
  reducedMotion: boolean;
  hold: boolean;
  at: number;
  eye: number;
  heat: number;
  heatAt: number;
};

type U = Record<
  "uRes" | "uT" | "uHeat" | "uHeatX" | "uEye" | "uAspect" | "uK",
  WebGLUniformLocation | null
>;

// HAZE
// one fullscreen pass; no dom in here, so it can live in a worker. the host reports size,
// visibility (offscreen or a hidden tab) and input
export class Haze {
  private gl: WebGL2RenderingContext;
  private prog: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private u: U;

  private raf = 0;
  private last = 0;
  private visible = false;
  private sized = false;
  private dirty = true;
  private reducedMotion: boolean;
  private hold: boolean;

  private w = 1;
  private h = 1;
  private pr = 1;

  private t: number;
  private heat = 0;
  private heatTo = 0;
  private heatX = 0.5;
  private heatXTo = 0.5;
  private eye: number;
  private eyeTo: number;
  private pinned: boolean;
  private hud = { eyeM: -1, groundC: -1, arcmin: -1 };

  onHud: (h: Hud) => void = () => {};
  onShown: () => void = () => {};
  private shown = false;

  constructor(
    private canvas: HTMLCanvasElement | OffscreenCanvas,
    opts: Opts,
  ) {
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("webgl2 unavailable");
    this.gl = gl;
    this.reducedMotion = opts.reducedMotion;
    this.hold = opts.hold;
    this.t = ((opts.at % LOOP_S) + LOOP_S) % LOOP_S;
    this.eye = this.eyeTo = opts.eye >= 0 ? Math.min(1, opts.eye) : EYE.start;
    // ?heat pins the cursor heat for stills
    this.pinned = opts.heat > 0;
    this.heat = this.heatTo = Math.min(1, Math.max(0, opts.heat));
    this.heatX = this.heatXTo = opts.heatAt;

    const prog = gl.createProgram();
    const shaders = [
      [gl.VERTEX_SHADER, FULL_VS],
      [gl.FRAGMENT_SHADER, HAZE_FS],
    ] as const;
    for (const [type, src] of shaders) {
      const sh = gl.createShader(type);
      if (!sh) throw new Error("no shader");
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      gl.attachShader(prog, sh);
      gl.deleteShader(sh);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(prog) ?? "link");
    this.prog = prog;
    const loc = (n: string) => gl.getUniformLocation(prog, n);
    this.u = {
      uRes: loc("uRes"),
      uT: loc("uT"),
      uHeat: loc("uHeat"),
      uHeatX: loc("uHeatX"),
      uEye: loc("uEye"),
      uAspect: loc("uAspect"),
      uK: loc("uK"),
    };
    this.vao = gl.createVertexArray();
  }

  // PUBLIC
  size(w: number, h: number, dpr: number) {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.pr = Math.min(dpr || 1, MAX_DPR);
    this.sized = false;
    this.dirty = true;
    this.wake();
  }

  show(visible: boolean) {
    this.visible = visible;
    this.last = 0;
    this.wake();
  }

  motion(reduced: boolean) {
    this.reducedMotion = reduced;
    this.dirty = true;
    this.wake();
  }

  // pointer as shares of the canvas, 0..1 from the top left; on is false once it leaves
  warm(x: number, y: number, on: boolean) {
    if (this.pinned) return;
    const near = Math.exp(-(((y - (1 - HORIZON)) / HEAT.reachShare) ** 2));
    this.heatTo = on ? near : 0;
    if (on) this.heatXTo = x;
    this.wake();
  }

  // scroll or swipe, in css px; down sinks the eye toward the sand
  lean(px: number) {
    this.eyeTo = Math.min(1, Math.max(0, this.eyeTo - px * EYE.perPx));
    this.wake();
  }

  // LOOP
  private wake() {
    if (!this.raf && this.visible) this.raf = raf(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.visible) return;
    const dt = this.last ? Math.min(MAX_DT_S, (now - this.last) / 1000) : 0;
    this.last = now;
    if (!this.sized) this.resize();
    const easing = this.step(dt);
    const alive = !this.reducedMotion && !this.hold;
    if (alive || easing || this.dirty) this.draw();
    this.dirty = false;
    if (alive || easing) this.wake();
  };

  // eases toward the targets; true while anything is still moving
  private step(dt: number) {
    if (!this.reducedMotion && !this.hold) this.t = (this.t + dt) % LOOP_S;
    const k = (tau: number) => 1 - Math.exp(-dt / tau);
    const up = this.heatTo > this.heat;
    if (this.reducedMotion) {
      this.heat = this.heatTo;
      this.heatX = this.heatXTo;
      this.eye = this.eyeTo;
      return false;
    }
    this.heat += (this.heatTo - this.heat) * k(up ? HEAT.upTauS : HEAT.downTauS);
    this.heatX += (this.heatXTo - this.heatX) * k(HEAT.moveTauS);
    this.eye += (this.eyeTo - this.eye) * k(EYE.tauS);
    return (
      Math.abs(this.heatTo - this.heat) > 1e-3 ||
      Math.abs(this.heatXTo - this.heatX) > 1e-3 ||
      Math.abs(this.eyeTo - this.eye) > 1e-3
    );
  }

  private draw() {
    const gl = this.gl;
    const aspect = this.w / this.h;
    const kScale = Math.min(1, Math.max(0.78, aspect / 1.4));
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(this.u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(this.u.uT, this.t);
    gl.uniform1f(this.u.uHeat, this.heat);
    gl.uniform1f(this.u.uHeatX, (this.heatX - 0.5) * aspect);
    gl.uniform1f(this.u.uEye, this.eye);
    gl.uniform1f(this.u.uAspect, aspect);
    gl.uniform1f(this.u.uK, kScale);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!this.shown) {
      this.shown = true;
      this.onShown();
    }

    // HUD
    // the mirage depth mirrors the shader's at the heat's centre
    const s = 0.16 + 0.84 * this.heat;
    const low = 1.75 + (0.55 - 1.75) * this.eye;
    const depth = 0.026 * low * (0.6 + 2.1 * s) * kScale;
    const eyeM = Math.round((EYE.minM + (EYE.maxM - EYE.minM) * this.eye) * 10) / 10;
    const groundC = Math.round(GROUND_C + this.heat * 14);
    const arcmin = Math.round(depth * SCREEN_DEG * 60);
    if (eyeM !== this.hud.eyeM || groundC !== this.hud.groundC || arcmin !== this.hud.arcmin) {
      this.hud.eyeM = eyeM;
      this.hud.groundC = groundC;
      this.hud.arcmin = arcmin;
      this.onHud(this.hud);
    }
  }

  private resize() {
    const w = Math.round(this.w * this.pr);
    const h = Math.round(this.h * this.pr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
    this.sized = true;
  }

  dispose() {
    cancel(this.raf);
    this.raf = 0;
    const gl = this.gl;
    gl.deleteProgram(this.prog);
    gl.deleteVertexArray(this.vao);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

// workers without rAF fall back to a timer
const raf = (fn: (now: number) => void) =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(fn)
    : (setTimeout(() => fn(performance.now()), 16) as unknown as number);
const cancel = (id: number) =>
  typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : clearTimeout(id);
