import { EYE_X_M, fit, KEEP_MAX, POLE_X_M, skyFor, zoomFor } from "./frame";
import { SCENE } from "./scene";
import { FULLSCREEN_VS, SCENE_FS, TRAFFIC_N } from "./shaders";

// MIRAGE
// a desert road under heat. the pool of sky on the road ahead is always the same way off:
// drive at it as fast as you like and it never comes nearer. no dom in here, so it runs in
// a worker or the page alike

const MAX_DPR = 2;
const MAX_PIXELS = 2_400_000; // fill budget; the scene is soft enough to upscale past this
const MAX_DT_S = 0.05;
const PUDDLE_M = 44; // the scale the road's water is laid out on
const FIRST_WATER_K = 1.4; // the nearest band lies about this many PUDDLE_M ahead, see the shader
const V_MAX_MS = 36; // top speed, m/s
const COAST_S = 1.4; // how long the car rolls on after the last push
const WHEEL_GAIN = 0.09; // m/s per pixel of wheel
const DRAG_GAIN = 0.32; // m/s per pixel dragged upward
const KEY_ACCEL_MS2 = 22;
const SWAY_M = 0.2; // how far the eye drifts sideways with the cursor
const SWAY_S = 2.2;
const SPEED_S = 0.5; // how quickly the shimmer follows the speed
const IDLE_S = 30; // with no input for this long the heat settles and the loop stops
const SETTLE_S = 1.6;
const REVEAL_S = 1.2; // the traffic fades in over this once the full program is up
const FRAME_EASE_S = 0.45; // how gently the view settles when the text it frames moves // the shimmer slows to a stop over about this long
// the shader sees the distance wrapped here, a whole number of pole, post and dash
// repeats, so float precision holds however far anyone drives
const WRAP_M = 9996;
// LOOPS
// counts as uniforms so the compiler keeps one copy of each loop body: triples (clouds, dune
// rows, post candidates, car parts), traffic slots and wheels, post rows, passes
const LOOP = new Int32Array([3, TRAFFIC_N + 1, 3, 2]);
// ONCOMING
const SPAWN_M = 900; // they come out of the heat somewhere past this, with long empty gaps
const SPAWN_SPREAD_M = 2600;
const ONCOMING_X_M = 1.45; // the oncoming lane's middle, left of the centre line
const GONE_M = -6; // passed us, behind the eye
const CAR_MS = 26;
const TRUCK_MS = 22;
const PICKUP_SHARE = 0.3;
const TRUCK_SHARE = 0.2;
const FIRST_Z_M = [260, 1700, 3200];

type Uniforms = Record<string, WebGLUniformLocation | null>;
type Prog = { prog: WebGLProgram; shaders: WebGLShader[]; u: Uniforms; done: boolean };

// the scene without traffic links in a fraction of the time, so it goes up first while the
// full scene links alongside
const LITE_FS = SCENE_FS.replace("precision highp float;", "precision highp float;\n#define LITE");

export type Options = {
  reducedMotion: boolean;
  forceGl: boolean;
};

export class Mirage {
  private gl: WebGL2RenderingContext;
  private full: Prog | null = null;
  private lite: Prog | null = null;
  private reveal = 1; // how far the traffic has faded in since the full program came up
  private prog: Prog | null = null;
  private vao: WebGLVertexArrayObject;
  private parallel: boolean;
  private ready = false;

  private raf = 0;
  private last = 0;
  private time = 0;
  private pace = 1; // how fast the heat moves; eases to 0 when nobody is there
  private idle = 0;
  private visible = false;
  private sized = false;
  private dirty = true;
  private reducedMotion: boolean;

  // VIEW
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private aspect = 1;
  private zoom = 1;
  private hor = 0.5;
  private vp = 0.5;
  // where the framing is heading: a late font or a resize eases the horizon there, never jumps
  private horTo = 0.5;
  private vpTo = 0.5;
  // text to keep clear of: side (0 left, 1 right), inner edge x, bottom y, in shares
  private keep = new Float32Array(KEEP_MAX * 3);
  private keepN = 0;
  private framed = new Float32Array(2);

  // TRAFFIC
  private tz = new Float32Array(TRAFFIC_N);
  private tv = new Float32Array(TRAFFIC_N);
  private tk = new Float32Array(TRAFFIC_N);
  private tt = new Float32Array(TRAFFIC_N);
  private order = new Int8Array(TRAFFIC_N);
  // slot 0 is the car ahead in our lane, always the same way off; the rest come at us
  private traffic = new Float32Array((TRAFFIC_N + 1) * 4);
  private seed = 0x2f6b1d;

  // MOTION
  private travel = 0;
  private v = 0;
  private speed = 0; // eased |v| over V_MAX, drives the shimmer
  private cam = EYE_X_M;
  private camTarget = EYE_X_M;
  private dragging = false;
  private dragY = 0;
  private keyDir = 0;

  onState?: (travelled: number, ahead: number) => void;
  onReady?: () => void;

  constructor(
    private canvas: HTMLCanvasElement | OffscreenCanvas,
    opts: Options,
  ) {
    this.reducedMotion = opts.reducedMotion;
    this.pace = opts.reducedMotion ? 0 : 1;
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      // keep the last frame in the buffer: a frame that presents without redrawing then shows
      // the same picture, not the one before it, which made the sky flick between two places
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("webgl2 unavailable");
    // SOFTWARE GL
    // cpu renderers get the still before the shader compiles; ?gl forces the live path
    if (!opts.forceGl && software(gl)) {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      throw new Error("software gl");
    }
    this.gl = gl;
    this.parallel = !!gl.getExtension("KHR_parallel_shader_compile");
    // with parallel compile the quick one builds first off this thread, and the full one
    // after the first frame is up, so the two never queue together; without it only the full one
    if (this.parallel) this.lite = this.compile(LITE_FS);
    else this.full = this.compile(SCENE_FS);
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("no vao");
    this.vao = vao;
    this.traffic.set([SCENE.CAR_Z, SCENE.LANE_X, 0, 2]);
    for (let i = 0; i < TRAFFIC_N; i++) this.spawn(i, FIRST_Z_M[i % FIRST_Z_M.length]);
  }

  // the nearest water, as the readout shows it
  get ahead() {
    return PUDDLE_M * FIRST_WATER_K;
  }

  // PUBLIC
  // sizes in css pixels; the host owns observers, visibility and events
  size(w: number, h: number, dpr: number) {
    this.cssW = Math.max(1, w);
    this.cssH = Math.max(1, h);
    this.dpr = dpr;
    this.sized = false;
    this.dirty = true;
    this.wake();
  }

  // flat list of side, inner edge and bottom per box, in shares of the view, y up
  avoid(boxes: ArrayLike<number>) {
    const n = Math.min(KEEP_MAX, Math.floor(boxes.length / 3));
    for (let i = 0; i < n * 3; i++) this.keep[i] = boxes[i];
    this.keepN = n;
    this.sized = false;
    this.dirty = true;
    this.wake();
  }

  show(v: boolean) {
    this.visible = v;
    this.last = 0;
    if (v) this.idle = 0;
    this.wake();
  }

  motion(reduced: boolean) {
    this.reducedMotion = reduced;
    this.dirty = true;
    this.wake();
  }

  // cursor in uv, y up; the eye sways a little with it
  point(x: number) {
    this.camTarget = EYE_X_M + (x - 0.5) * 2 * SWAY_M;
    this.poke();
  }

  // drags in css pixels down the screen; dragging up drives forward
  down(yPx: number) {
    this.dragging = true;
    this.dragY = yPx;
    this.poke();
  }

  drag(yPx: number) {
    if (!this.dragging) return;
    this.push((this.dragY - yPx) * DRAG_GAIN);
    this.dragY = yPx;
    this.poke();
  }

  up() {
    this.dragging = false;
    this.poke();
  }

  leave() {
    this.dragging = false;
    this.camTarget = EYE_X_M;
    this.poke();
  }

  wheel(px: number) {
    this.push(px * WHEEL_GAIN);
    this.poke();
  }

  // -1, 0 or 1 while a key is held
  keys(dir: number) {
    this.keyDir = dir;
    this.poke();
  }

  private poke() {
    this.idle = 0;
    this.wake();
  }

  private push(dv: number) {
    this.v = Math.max(-V_MAX_MS * 0.5, Math.min(V_MAX_MS, this.v + dv));
  }

  // LOOP
  // runs while the heat moves or anything eases; stops when offscreen, hidden,
  // idle for IDLE_S, or under reduced motion once nothing changes
  private wake() {
    if (!this.raf && this.visible) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.visible) return;
    if (!this.full?.done) {
      if (this.lite && !this.lite.done && this.linked(this.lite)) this.prog = this.lite;
      if (!this.full && this.ready) this.full = this.compile(SCENE_FS);
      if (this.full && this.linked(this.full)) {
        this.prog = this.full;
        // traffic only lives in the full program, so it fades in rather than pops
        if (this.lite) this.reveal = 0;
        if (this.lite) this.drop(this.lite);
        this.lite = null;
        this.dirty = true;
      }
      if (!this.full?.done) this.raf = requestAnimationFrame(this.frame);
      if (!this.prog) return;
    }
    if (!this.sized) this.resize();
    const dt = this.last ? Math.min(MAX_DT_S, Math.max(0, now - this.last) / 1000) : 1 / 60;
    this.last = now;
    const moving = this.step(dt);
    if (!moving && !this.dirty) {
      this.last = 0;
      return;
    }
    this.draw();
    this.dirty = false;
    if (!this.ready) {
      this.ready = true;
      this.onReady?.();
    }
    if (moving) this.wake();
    else this.last = 0;
  };

  // returns true while anything is still moving
  private step(dt: number) {
    this.idle += dt;
    const target = this.reducedMotion || this.idle > IDLE_S ? 0 : 1;
    this.pace += (target - this.pace) * (1 - Math.exp(-dt / (SETTLE_S * 0.4)));
    if (target === 0 && this.pace < 0.003) this.pace = 0;
    this.time += dt * this.pace;

    if (this.keyDir) this.push(this.keyDir * KEY_ACCEL_MS2 * dt);
    else this.v *= Math.exp(-dt / COAST_S);
    if (Math.abs(this.v) < 0.05) this.v = 0;
    this.travel += this.v * dt;

    this.speed += (Math.abs(this.v) / V_MAX_MS - this.speed) * (1 - Math.exp(-dt / SPEED_S));
    this.cam += (this.camTarget - this.cam) * (1 - Math.exp(-dt / SWAY_S));
    this.drive(dt);
    const ease = 1 - Math.exp(-dt / FRAME_EASE_S);
    this.hor += (this.horTo - this.hor) * ease;
    this.vp += (this.vpTo - this.vp) * ease;
    const framing = Math.abs(this.horTo - this.hor) + Math.abs(this.vpTo - this.vp) > 1e-4;
    if (this.reveal < 1) this.reveal = Math.min(1, this.reveal + dt / REVEAL_S);
    if (!framing) {
      this.hor = this.horTo;
      this.vp = this.vpTo;
    }

    if (this.onState) this.onState(this.travel, this.ahead);
    return (
      this.pace > 0 ||
      this.v !== 0 ||
      this.keyDir !== 0 ||
      Math.abs(this.cam - this.camTarget) > 1e-3 ||
      this.speed > 1e-3 ||
      framing ||
      this.reveal < 1
    );
  }

  // ONCOMING
  // a few cars and trucks in the other lane, closing at their speed plus ours
  private rnd() {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  private spawn(i: number, z: number) {
    const r = this.rnd();
    const truck = r < TRUCK_SHARE;
    this.tz[i] = z;
    // 1 a sedan, 2 a pickup, 3 a small box truck, all coming at us
    this.tk[i] = truck ? 3 : r < TRUCK_SHARE + PICKUP_SHARE ? 2 : 1;
    this.tv[i] = (truck ? TRUCK_MS : CAR_MS) * (0.9 + 0.2 * this.rnd());
    this.tt[i] = Math.floor(this.rnd() * 4);
  }

  private drive(dt: number) {
    const tz = this.tz;
    for (let i = 0; i < TRAFFIC_N; i++) {
      tz[i] -= (this.tv[i] * this.pace + this.v) * dt;
      if (tz[i] < GONE_M) this.spawn(i, SPAWN_M + this.rnd() * SPAWN_SPREAD_M);
    }
    // far to near, so nearer ones paint over
    const o = this.order;
    for (let i = 0; i < TRAFFIC_N; i++) o[i] = i;
    for (let i = 1; i < TRAFFIC_N; i++) {
      const k = o[i];
      let j = i - 1;
      while (j >= 0 && tz[o[j]] < tz[k]) {
        o[j + 1] = o[j];
        j--;
      }
      o[j + 1] = k;
    }
    const t = this.traffic;
    for (let i = 0; i < TRAFFIC_N; i++) {
      const k = o[i];
      const j = (i + 1) * 4;
      t[j] = tz[k];
      t[j + 1] = -ONCOMING_X_M;
      t[j + 2] = this.tk[k];
      t[j + 3] = this.tt[k];
    }
  }

  private draw() {
    const gl = this.gl;
    const prog = this.prog;
    if (!prog) return;
    const u = prog.u;
    const w = this.canvas.width;
    const h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog.prog);
    gl.uniform2f(u.uRes, w, h);
    gl.uniform1f(u.uAspect, this.aspect);
    gl.uniform1f(u.uZoom, this.zoom);
    gl.uniform1f(u.uHor, this.hor);
    gl.uniform1f(u.uVp, this.vp);
    gl.uniform4fv(u["uTraffic[0]"], this.traffic);
    gl.uniform4iv(u.uLoop, LOOP);
    gl.uniform1f(u.uReveal, this.reveal);
    gl.uniform4f(u.uView, 0, 0, 1, 1);
    gl.uniform1f(u.uTime, this.time);
    gl.uniform1f(u.uTravel, this.travel % WRAP_M);
    gl.uniform1f(u.uPuddle, PUDDLE_M);
    gl.uniform1f(u.uCam, this.cam);
    gl.uniform1f(u.uShimmer, (this.reducedMotion ? 0.6 : 1) + this.speed * 0.6);
    // the side of the view the poles stand on
    const halfW = (1 - this.vp) * this.aspect * this.zoom;
    const sky = skyFor(this.aspect);
    gl.uniform1f(u.uTop, sky.top);
    gl.uniform2f(u.uFrame, this.zoom, 0.5 * this.aspect * this.zoom);
    // the telegraph line stands far enough out that a pole leaves the screen sideways
    // before it grows tall enough to reach the label or the sun
    gl.uniform1f(u.uPoleX, EYE_X_M + POLE_X_M * Math.max(1, halfW / 0.8));
    // up and left of the wires' fan, so no wire ever crosses it
    gl.uniform2f(u.uSun, sky.sunX, sky.sunY);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // RESIZE
  // resizing clears the canvas, so only do it right before a draw
  private resize() {
    const dpr = Math.min(this.dpr || 1, MAX_DPR);
    let w = this.cssW * dpr;
    let h = this.cssH * dpr;
    const fit = Math.min(1, Math.sqrt(MAX_PIXELS / (w * h)));
    w = Math.max(1, Math.round(w * fit));
    h = Math.max(1, Math.round(h * fit));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.aspect = this.cssW / this.cssH;
    // a long lens, like the roadside shots of a mirage: the far road and its water come close.
    // narrow screens see a wider field so the road still fits
    this.zoom = zoomFor(this.aspect);
    this.frameView();
    this.sized = true;
  }

  private frameView() {
    fit(this.aspect, this.keep, this.keepN, this.framed);
    this.horTo = this.framed[0];
    this.vpTo = this.framed[1];
    if (!this.ready) {
      this.hor = this.horTo;
      this.vp = this.vpTo;
    }
  }

  // GL
  private compile(fs: string): Prog {
    const gl = this.gl;
    const prog = gl.createProgram();
    if (!prog) throw new Error("no program");
    const shaders: WebGLShader[] = [];
    for (const [type, src] of [
      [gl.VERTEX_SHADER, FULLSCREEN_VS],
      [gl.FRAGMENT_SHADER, fs],
    ] as const) {
      const sh = gl.createShader(type);
      if (!sh) throw new Error("no shader");
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      gl.attachShader(prog, sh);
      shaders.push(sh);
    }
    gl.linkProgram(prog);
    return { prog, shaders, u: {}, done: false };
  }

  // COMPLETION_STATUS_KHR, polled so linking never blocks the thread; once linked, check it,
  // free its shaders and look up its uniforms
  private linked(p: Prog) {
    const gl = this.gl;
    if (this.parallel && !gl.getProgramParameter(p.prog, 0x91b1)) return false;
    if (!gl.getProgramParameter(p.prog, gl.LINK_STATUS)) {
      const log = p.shaders.map((sh) => gl.getShaderInfoLog(sh)).join("\n");
      throw new Error((gl.getProgramInfoLog(p.prog) ?? "link") + log);
    }
    for (const sh of p.shaders) gl.deleteShader(sh);
    p.shaders.length = 0;
    const n = gl.getProgramParameter(p.prog, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p.prog, i);
      if (info) p.u[info.name] = gl.getUniformLocation(p.prog, info.name);
    }
    p.done = true;
    return true;
  }

  private drop(p: Prog) {
    const gl = this.gl;
    for (const sh of p.shaders) gl.deleteShader(sh);
    gl.deleteProgram(p.prog);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.visible = false;
    const gl = this.gl;
    if (this.full) this.drop(this.full);
    if (this.lite) this.drop(this.lite);
    gl.deleteVertexArray(this.vao);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

function software(gl: WebGL2RenderingContext) {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
  return /swiftshader|llvmpipe|software|basic render/i.test(name);
}
