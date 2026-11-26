import {
  CAUSTIC_FS,
  CAUSTIC_VS,
  FLOOR_RECT,
  QUAD_VS,
  RAYS_N,
  ROOM_FS,
  SCENE,
  TRACE_FS,
  WALL_RECT,
} from "./shaders";
import { aim, camera, project } from "./camera";

const MAX_DPR = 2;
const MAX_DT_S = 1 / 20;
const TINT_S = 0.22; // change tint fade here, time constant
const MORPH_S = 0.6; // change shape melt here
const MAP_PX = [1280, 2048] as const; // receiver map width, small and large canvases
const MAP_BIG_PX = 1800; // canvas width from which the large map is used
const GAIN = 0.25; // light is stored scaled down so hot cores stay within half floats
const DISPERSION = 0.012; // how much further blue bends than red, change for wider fringes

// LOOK
export const SHAPES = ["sphere", "drop", "cube"] as const;
const BOUND_M = [0.36, 0.51, 0.46] as const; // a sphere round each shape, before waves
// what each tint drinks per metre of liquid, red green blue
export const TINTS = {
  clear: [0.5, 0.14, 0.09],
  emerald: [2.6, 0.32, 1.5],
  amber: [0.12, 0.85, 3.2],
  pink: [0.12, 2.1, 0.8],
  ink: [3.4, 2.4, 0.75],
} as const;
export type Tint = keyof typeof TINTS;
const WAVE_MAX_M = 0.04; // surface wobble at full Wave
const FLOW_MAX = 2.2; // time scale at full Flow

// SUN
// the knob sweeps from low across the side to higher from the front
const SUN_AZ_DEG = [20, 56] as const;
const SUN_EL_DEG = [22, 17] as const;
const WIN_OFFSET_M = [0.05, 0.25] as const; // window centre from where the sculpture's light passes: z, y

// WOBBLE
// a drag squashes and sloshes the liquid; three damped springs
const WOBBLE_HZ = 1.5;
const WOBBLE_DAMP = 0.11;
const WOBBLE_MAX_M = 0.06;
const PUSH_M_PER_PX = 0.0009; // change for a livelier drag

type Uniforms = Record<string, WebGLUniformLocation | null>;
export type Opts = { reducedMotion: boolean; forceGl: boolean; perf: boolean };

export class Gallery {
  private gl: WebGL2RenderingContext;
  private trace: WebGLProgram;
  private caustic: WebGLProgram;
  private room: WebGLProgram;
  private tu: Uniforms;
  private cu: Uniforms;
  private ru: Uniforms;
  private vao: WebGLVertexArrayObject;
  private ibo: WebGLBuffer;
  private indices = 0;
  private rayTex: WebGLTexture[] = [];
  private rayFbo: WebGLFramebuffer;
  private mapTex: WebGLTexture[] = [];
  private mapFbo: WebGLFramebuffer[] = [];
  private mapW = 0;

  private raf = 0;
  private last = 0;
  private visible = false;
  private sized = false;
  private dead = false;
  private shown = false;
  private reducedMotion: boolean;
  private rect = { width: 1, height: 1, dpr: 1 };
  private px = { w: 1, h: 1 };

  // material
  private shape = 0;
  private from = 0;
  private morph = 1;
  private iors = new Float32Array(3);
  private absorb = new Float32Array(3);
  private absorbTo = new Float32Array(3);
  private tinted = false;
  private wave = 0.45;
  private flow = 0.5;
  private sunK = 0.4;
  private sun = new Float32Array(3);
  private win = new Float32Array(2);

  // motion
  private t = 0;
  private sq = new Float32Array(4);
  private sqV = new Float32Array(3);
  private pointer = -1;
  private lastX = 0;
  private lastY = 0;
  private cursor = "";

  // camera, and the sculpture on screen for grabbing
  private cam = camera();
  private aspect = 0;
  private hit = new Float32Array(3); // css px: x, y, radius

  onCursor: (c: string) => void = () => {};
  onPerf: (ms: number) => void = () => {};
  onShown: () => void = () => {};
  private timer: { begin(): void; end(): void } | null = null;

  // no dom in here: it runs in a worker on an offscreen canvas, or in the page as a
  // fallback. the host feeds it size, visibility, input and the material
  constructor(canvas: HTMLCanvasElement | OffscreenCanvas, opts: Opts) {
    this.reducedMotion = opts.reducedMotion;
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: "high-performance",
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("webgl2 unavailable");
    if (!opts.forceGl && software(gl)) {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      throw new Error("software gl");
    }
    // the rays and the light both live in float targets
    if (!gl.getExtension("EXT_color_buffer_float")) throw new Error("no float targets");
    this.gl = gl;
    if (opts.perf) this.timer = gpuTimer(gl, (ms) => this.onPerf(ms));

    this.trace = program(gl, QUAD_VS, TRACE_FS);
    this.caustic = program(gl, CAUSTIC_VS, CAUSTIC_FS);
    this.room = program(gl, QUAD_VS, ROOM_FS);
    const shared = [
      "uTime",
      "uWave",
      "uSq",
      "uShape",
      "uFrom",
      "uMorph",
      "uBound",
      "uSun",
      "uWin",
      "uIor",
      "uAbsorb",
    ];
    this.tu = locate(gl, this.trace, shared);
    this.cu = locate(gl, this.caustic, [
      "uPos",
      "uPack",
      "uChan",
      "uRecv",
      "uRect",
      "uCell",
      "uGain",
    ]);
    this.ru = locate(gl, this.room, [
      ...shared,
      "uEye",
      "uRight",
      "uUp",
      "uFwd",
      "uFocal",
      "uRes",
      "uWall",
      "uFloor",
      "uWallRect",
      "uFloorRect",
      "uGain",
    ]);

    // RAYS
    // four float targets the size of the ray grid
    this.rayFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.rayFbo);
    for (let i = 0; i < 4; i++) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, RAYS_N, RAYS_N);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, 0);
      this.rayTex.push(tex);
    }
    gl.drawBuffers([
      gl.COLOR_ATTACHMENT0,
      gl.COLOR_ATTACHMENT1,
      gl.COLOR_ATTACHMENT2,
      gl.COLOR_ATTACHMENT3,
    ]);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error("ray target");
    for (let i = 0; i < 2; i++) {
      this.mapTex.push(gl.createTexture());
      this.mapFbo.push(gl.createFramebuffer());
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // GRID
    // two triangles per cell of rays, built once
    const n = RAYS_N;
    const idx = new Uint32Array((n - 1) * (n - 1) * 6);
    let k = 0;
    for (let j = 0; j < n - 1; j++)
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i;
        idx[k++] = a;
        idx[k++] = a + 1;
        idx[k++] = a + n;
        idx[k++] = a + 1;
        idx[k++] = a + n + 1;
        idx[k++] = a + n;
      }
    this.vao = gl.createVertexArray();
    this.ibo = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.indices = idx.length;

    this.set(0, 1.33, "clear", 0.45, 0.5, 0.4);
    this.tinted = false;
  }

  // HOST
  // css px of the canvas and the page's pixel ratio
  size(w: number, h: number, dpr: number) {
    this.rect.width = w || 1;
    this.rect.height = h || 1;
    this.rect.dpr = dpr || 1;
    this.sized = false;
    this.wake();
  }

  // on screen and the tab visible
  show(v: boolean) {
    this.visible = v;
    this.last = 0;
    this.wake();
  }

  motion(reduced: boolean) {
    this.reducedMotion = reduced;
    this.wake();
  }

  // MATERIAL
  // shape index, index of refraction, tint, and wave, flow and sun from 0 to 1
  set(shape: number, ior: number, tint: Tint, wave: number, flow: number, sun: number) {
    const next = Math.max(0, Math.min(SHAPES.length - 1, shape | 0));
    if (next !== this.shape && this.tinted && !this.reducedMotion) {
      this.from = this.shape;
      this.morph = 0;
      this.poke(0, -18);
    }
    this.shape = next;
    this.iors[0] = 1 + (ior - 1) * (1 - DISPERSION);
    this.iors[1] = ior;
    this.iors[2] = 1 + (ior - 1) * (1 + DISPERSION * 1.4);
    const a = TINTS[tint] ?? TINTS.clear;
    this.absorbTo[0] = a[0];
    this.absorbTo[1] = a[1];
    this.absorbTo[2] = a[2];
    // the first tint and reduced motion land at once
    if (!this.tinted || this.reducedMotion) this.absorb.set(this.absorbTo);
    this.tinted = true;
    this.wave = wave;
    this.flow = flow;
    this.sunK = sun;
    this.aim();
    this.wake();
  }

  // the sun's direction, and the window placed so its light falls on the sculpture
  private aim() {
    const k = this.sunK;
    const az = ((SUN_AZ_DEG[0] + (SUN_AZ_DEG[1] - SUN_AZ_DEG[0]) * k) * Math.PI) / 180;
    const el = ((SUN_EL_DEG[0] + (SUN_EL_DEG[1] - SUN_EL_DEG[0]) * k) * Math.PI) / 180;
    const s = this.sun;
    s[0] = -Math.cos(el) * Math.cos(az);
    s[1] = Math.sin(el);
    s[2] = Math.cos(el) * Math.sin(az);
    const cy = SCENE.PLINTH_H_M + SCENE.R_M;
    const t = (SCENE.WALL_X_M - SCENE.PLINTH_X_M) / s[0];
    this.win[0] = SCENE.PLINTH_Z_M + s[2] * t + WIN_OFFSET_M[0];
    this.win[1] = cy + s[1] * t + WIN_OFFSET_M[1];
  }

  // INPUT
  // pointer positions in css px from the canvas corner. a drag on the sculpture sets it
  // wobbling
  down(x: number, y: number, id: number) {
    if (this.pointer !== -1 || !this.over(x, y)) return;
    this.pointer = id;
    this.lastX = x;
    this.lastY = y;
    this.poke(0, -24);
    this.point("grabbing");
  }

  move(x: number, y: number, id: number) {
    if (id !== this.pointer) {
      this.point(this.over(x, y) ? "grab" : "");
      return;
    }
    this.poke(x - this.lastX, y - this.lastY);
    this.lastX = x;
    this.lastY = y;
  }

  up(id: number) {
    if (id !== this.pointer) return;
    this.pointer = -1;
    this.point("grab");
  }

  // Enter or space: a nudge
  key() {
    this.poke(30, -20);
  }

  private over(x: number, y: number) {
    return Math.hypot(x - this.hit[0], y - this.hit[1]) < this.hit[2] * 1.15;
  }

  private point(c: string) {
    if (c !== this.cursor) this.onCursor((this.cursor = c));
  }

  private poke(dx: number, dy: number) {
    const v = this.sqV;
    const k = PUSH_M_PER_PX * 2 * Math.PI * WOBBLE_HZ;
    v[0] += Math.abs(dx) * k * (this.sq[0] > 0 ? -1 : 1);
    v[1] += Math.abs(dy) * k * (this.sq[1] > 0 ? -1 : 1);
    v[2] += (dx - dy) * k * 0.5;
    this.wake();
  }

  // LOOP
  // runs only while shown: host.ts turns visible off when the canvas leaves the screen or
  // the tab is hidden. it keeps running while the liquid flows, and otherwise stops once
  // the wobble settles; under reduced motion the waves hold still
  private wake() {
    if (!this.raf && this.visible && !this.dead) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.visible || this.dead) return;
    const dt = this.last ? Math.min(MAX_DT_S, Math.max(0, now - this.last) / 1000) : 1 / 60;
    this.last = now;
    if (!this.sized) this.resize();
    const flowing = !this.reducedMotion && this.flow > 0.001 && this.wave > 0.001;
    if (flowing) this.t += dt * this.flow * FLOW_MAX;
    const wobbling = this.settle(dt);
    const fading = this.fade(dt);
    this.draw();
    if (!this.shown) {
      this.shown = true;
      this.onShown();
    }
    if (flowing || wobbling || fading || this.pointer !== -1) this.wake();
    else this.last = 0;
  };

  // TINT AND SHAPE
  // eases the absorption toward the new tint and melts the shape; true while still changing
  private fade(dt: number) {
    if (this.morph < 1) this.morph = Math.min(1, this.morph + dt / MORPH_S);
    const k = 1 - Math.exp(-dt / TINT_S);
    let e = 0;
    for (let i = 0; i < 3; i++) {
      const d = this.absorbTo[i] - this.absorb[i];
      this.absorb[i] += d * k;
      e += Math.abs(d);
    }
    if (e < 1e-3) {
      this.absorb.set(this.absorbTo);
      return this.morph < 1;
    }
    return true;
  }

  // damped springs; true while still moving
  private settle(dt: number) {
    const w = 2 * Math.PI * WOBBLE_HZ;
    let e = 0;
    for (let i = 0; i < 3; i++) {
      let v = this.sqV[i];
      let x = this.sq[i];
      v += (-w * w * x - 2 * WOBBLE_DAMP * w * v) * dt;
      x += v * dt;
      if (x > WOBBLE_MAX_M) x = WOBBLE_MAX_M;
      if (x < -WOBBLE_MAX_M) x = -WOBBLE_MAX_M;
      this.sqV[i] = v;
      this.sq[i] = x;
      e += Math.abs(x) + Math.abs(v) * 0.1;
    }
    if (e < 2e-4) {
      this.sq.fill(0);
      this.sqV.fill(0);
      return false;
    }
    return true;
  }

  private draw() {
    this.timer?.begin();
    const gl = this.gl;
    gl.disable(gl.BLEND);

    // TRACE
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.rayFbo);
    gl.viewport(0, 0, RAYS_N, RAYS_N);
    gl.useProgram(this.trace);
    this.common(this.tu);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // CAUSTIC
    // per receiver, one pass per colour channel, added up
    gl.useProgram(this.caustic);
    const c = this.cu;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.rayTex[3]);
    gl.uniform1i(c.uPack, 1);
    gl.uniform1i(c.uPos, 0);
    gl.uniform1f(c.uCell, (2 * this.bound()) / (RAYS_N - 1));
    gl.uniform1f(c.uGain, GAIN);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let r = 0; r < 2; r++) {
      const rect = r === 0 ? WALL_RECT : FLOOR_RECT;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.mapFbo[r]);
      gl.viewport(0, 0, this.mapW, this.mapW >> 1);
      gl.colorMask(true, true, true, true);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1i(c.uRecv, r);
      gl.uniform4f(c.uRect, rect[0], rect[1], rect[2], rect[3]);
      for (let ch = 0; ch < 3; ch++) {
        gl.colorMask(ch === 0, ch === 1, ch === 2, false);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.rayTex[ch]);
        gl.uniform1i(c.uChan, ch);
        gl.drawElements(gl.TRIANGLES, this.indices, gl.UNSIGNED_INT, 0);
      }
    }
    gl.colorMask(true, true, true, true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
    for (let r = 0; r < 2; r++) {
      gl.bindTexture(gl.TEXTURE_2D, this.mapTex[r]);
      gl.generateMipmap(gl.TEXTURE_2D);
    }

    // ROOM
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.px.w, this.px.h);
    gl.useProgram(this.room);
    const u = this.ru;
    this.common(u);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.mapTex[0]);
    gl.uniform1i(u.uWall, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.mapTex[1]);
    gl.uniform1i(u.uFloor, 1);
    gl.uniform4f(u.uWallRect, WALL_RECT[0], WALL_RECT[1], WALL_RECT[2], WALL_RECT[3]);
    gl.uniform4f(u.uFloorRect, FLOOR_RECT[0], FLOOR_RECT[1], FLOOR_RECT[2], FLOOR_RECT[3]);
    gl.uniform1f(u.uGain, GAIN);
    gl.uniform3fv(u.uEye, this.cam.eye);
    gl.uniform3fv(u.uRight, this.cam.right);
    gl.uniform3fv(u.uUp, this.cam.up);
    gl.uniform3fv(u.uFwd, this.cam.fwd);
    gl.uniform1f(u.uFocal, this.cam.focal);
    gl.uniform2f(u.uRes, this.px.w, this.px.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.timer?.end();
  }

  private bound() {
    const b =
      this.morph < 1 ? Math.max(BOUND_M[this.shape], BOUND_M[this.from]) : BOUND_M[this.shape];
    return b + this.wave * WAVE_MAX_M * 1.2 + WOBBLE_MAX_M * 1.1;
  }

  private common(u: Uniforms) {
    const gl = this.gl;
    gl.uniform1f(u.uTime, this.t);
    gl.uniform1f(u.uWave, this.wave * WAVE_MAX_M);
    gl.uniform4fv(u.uSq, this.sq);
    gl.uniform1i(u.uShape, this.shape);
    gl.uniform1i(u.uFrom, this.from);
    const m = this.morph;
    gl.uniform1f(u.uMorph, m * m * (3 - 2 * m));
    gl.uniform1f(u.uBound, this.bound());
    gl.uniform3fv(u.uSun, this.sun);
    gl.uniform2fv(u.uWin, this.win);
    gl.uniform3fv(u.uIor, this.iors);
    gl.uniform3fv(u.uAbsorb, this.absorb);
  }

  // RESIZE
  // only right before a draw, resizing clears the canvas
  private resize() {
    const gl = this.gl;
    const canvas = gl.canvas;
    const dpr = Math.min(this.rect.dpr, MAX_DPR);
    const w = Math.max(1, Math.round(this.rect.width * dpr));
    const h = Math.max(1, Math.round(this.rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    this.px.w = w;
    this.px.h = h;
    const mw = Math.max(w, h) >= MAP_BIG_PX ? MAP_PX[1] : MAP_PX[0];
    if (mw !== this.mapW) {
      for (let r = 0; r < 2; r++) {
        gl.deleteTexture(this.mapTex[r]);
        const tex = gl.createTexture();
        this.mapTex[r] = tex;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        const levels = Math.floor(Math.log2(mw)) + 1;
        gl.texStorage2D(gl.TEXTURE_2D, levels, gl.RGBA16F, mw, mw >> 1);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.mapFbo[r]);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.mapW = mw;
    }
    const aspect = this.rect.width / this.rect.height;
    if (Math.abs(aspect - this.aspect) > 0.001) this.frame3(aspect);
    this.sized = true;
  }

  // CAMERA
  private frame3(aspect: number) {
    aim(this.cam, aspect);
    this.aspect = aspect;
    // the sculpture on screen
    const [x, y, d] = project(
      this.cam,
      SCENE.PLINTH_X_M,
      SCENE.PLINTH_H_M + SCENE.R_M,
      SCENE.PLINTH_Z_M,
      this.rect.width,
      this.rect.height,
    );
    this.hit[0] = x;
    this.hit[1] = y;
    this.hit[2] = (SCENE.R_M / d) * this.cam.focal * (this.rect.height / 2);
  }

  dispose() {
    this.dead = true;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    const gl = this.gl;
    gl.deleteProgram(this.trace);
    gl.deleteProgram(this.caustic);
    gl.deleteProgram(this.room);
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.ibo);
    for (const t of this.rayTex) gl.deleteTexture(t);
    for (const t of this.mapTex) gl.deleteTexture(t);
    for (const fb of this.mapFbo) gl.deleteFramebuffer(fb);
    gl.deleteFramebuffer(this.rayFbo);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const p = gl.createProgram();
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const s = gl.createShader(type);
    if (!s) throw new Error("shader");
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (import.meta.env.DEV && !gl.getShaderParameter(s, gl.COMPILE_STATUS))
      console.error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
    gl.deleteShader(s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    if (import.meta.env.DEV) console.error(gl.getProgramInfoLog(p));
    throw new Error("link");
  }
  return p;
}

function locate(gl: WebGL2RenderingContext, p: WebGLProgram, names: string[]) {
  const u: Uniforms = {};
  for (const n of names) u[n] = gl.getUniformLocation(p, n);
  return u;
}

function software(gl: WebGL2RenderingContext) {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
  return /swiftshader|llvmpipe|software|basic render/i.test(name);
}

// PERF
// one query in flight; reports the mean of the last PERF_FRAMES timed frames
const PERF_FRAMES = 120;
function gpuTimer(gl: WebGL2RenderingContext, report: (ms: number) => void) {
  const ext = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  const q = ext ? gl.createQuery() : null;
  if (!ext || !q) {
    report(-1);
    return null;
  }
  let busy = false;
  let sum = 0;
  let n = 0;
  return {
    begin() {
      if (busy && gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) {
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
          sum += gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
          if (++n === PERF_FRAMES) {
            report(sum / n);
            sum = 0;
            n = 0;
          }
        }
        busy = false;
      }
      if (!busy) gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    },
    end() {
      if (!busy) {
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        busy = true;
      }
    },
  };
}
