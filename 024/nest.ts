// NEST
// no DOM, so it runs in a worker or inline; weaving is a pure function of the clock

import { FINE_SEG, Form, SEG, STRIDE, TOP_Y, WIN } from "./form";
import { busy, finish, pass, raf, software, unraf, type Opts, type Pass } from "./gl";
import { cross3, mul, norm3, ortho, persp, spin, v3, view } from "./math";
import {
  BLADE_FS,
  BLADE_VS,
  BLUR_FS,
  COPY_FS,
  FULL_VS,
  STEM_FS,
  STEM_VS,
  WALL_FS,
  WALL_VS,
} from "./shaders";

const MAX_DPR = 2;
const MAX_DT_S = 1 / 20;
const SHADOW_PX = 2048;
const COV_PX = 256;
const SHADOW_R = 1.75;
const STEM_SEG = 40;
const STEM_SIDES = 8;
const FOV_TAN = Math.tan((13 * Math.PI) / 180);
const TAU = Math.PI * 2;
const WALL_Z = -0.74;
const PIVOT_Y = TOP_Y;

// CLOCK
// one cycle: the ring alone, the weaving, the finished nest held, then pulled apart
const CYCLE_S = 84;
const PHASE = { start: 0.035, built: 0.6, hold: 0.79, gone: 0.975 };
const START_AT = 0.2;
const REST_AT = 0.7;
const AUTO_CYCLES = 2;
const SCRUB_PER_PX = 1 / 14000; // change scrub speed here
const CLOCK_TAU_S = 0.7;
const AGE_PER_BUILD = 1;

// TURN AND SWAY
const YAW_MAX = 1.3;
const YAW_PER_PX = 0.0055;
const YAW_TAU_S = 0.5;
const IDLE_YAW = 0.16;
const IDLE_YAW_HZ = 0.021;
const SWAY_K = (TAU / 2.6) ** 2;
const SWAY_C = 2 * 0.22 * Math.sqrt(SWAY_K);
const AIR_PER_PX = 0.0009;
const AIR_TAU_S = 1.1;
const AIR_MAX = 0.9;
const SWAY_PER_AIR = 0.06;

const SLOW_MS = 26;
const MIN_SCALE = 0.6;
const MIN_LOD = 0.5;
const HUD_MS = 125;
const CM_PER_UNIT = 7.5;

export type Hud = { blades: number; metres: number; stage: string; resting: boolean };

const STAGES = ["Ring", "Shoulder", "Chamber", "Belly", "Doorway", "Finished", "Unwoven"] as const;

export class Nest {
  onShown: () => void = () => {};
  onHud: (h: Hud) => void = () => {};

  private gl: WebGL2RenderingContext;
  private parallel: boolean;
  private progs: Pass[];
  private bladeP: Pass;
  private bladeS: Pass;
  private stemP: Pass;
  private stemS: Pass;
  private wallP: Pass;
  private blurP: Pass;
  private copyP: Pass;
  private linked = false;

  private form = new Form();
  private vaos: WebGLVertexArrayObject[] = [];
  private bufs: WebGLBuffer[] = [];
  private texs: WebGLTexture[] = [];
  private fbos: WebGLFramebuffer[] = [];
  private coarseVao: WebGLVertexArrayObject;
  private coarseIdx: number;
  private fineVao: WebGLVertexArrayObject;
  private fineIdx: number;
  private lod = 1;
  private stemVao: WebGLVertexArrayObject;
  private stemIdx: number;
  private shadowFbo: WebGLFramebuffer;
  private shadowTex: WebGLTexture;
  private covA: { tex: WebGLTexture; fbo: WebGLFramebuffer };
  private covB: { tex: WebGLTexture; fbo: WebGLFramebuffer };
  private msFbo: WebGLFramebuffer | null = null;
  private msColor: WebGLRenderbuffer | null = null;
  private msDepth: WebGLRenderbuffer | null = null;
  private samples = 4;
  private flat: { tex: WebGLTexture; fbo: WebGLFramebuffer } | null = null;

  // CLOCK
  private k: number;
  private kGoal: number;
  private cycles = 0;
  private resting = false;
  private steered = false;
  private build = 0;
  private age = 0;
  private time = 0;

  // TURN, SWAY, AIR
  private yaw = 0;
  private yawGoal = 0;
  private sx = 0;
  private vx = 0;
  private sz = 0;
  private vz = 0;
  private air = 0;
  private airZ = 0;
  private wind = new Float32Array(4);
  private pressed = false;
  private dragX = 0;
  private dragY = 0;
  private hoverX = -1;
  private hoverY = -1;

  // VIEW
  private model = new Float32Array(16);
  private camVP = new Float32Array(16);
  private lightVP = new Float32Array(16);
  private tmpA = new Float32Array(16);
  private tmpB = new Float32Array(16);
  private eye = v3();
  private right = v3();
  private up = v3();
  private fwd = v3();
  private keyL = v3();
  private back = v3();
  private lEye = v3();
  private lR = v3();
  private lU = v3();
  private lF = v3();
  private worldUp = v3(0, 1, 0);
  private wallRect = new Float32Array(4);
  private stem = new Float32Array([
    -1.05,
    3.7,
    -0.12,
    -0.55,
    2.75,
    0.02,
    -0.06,
    1.8,
    0.03,
    -0.02,
    TOP_Y - 0.1,
    0,
  ]);
  private tint = new Float32Array(3);
  private pool = new Float32Array(2);

  private raf = 0;
  private last = 0;
  private visible = false;
  private sized = false;
  private drawn = false;
  private dead = false;
  private reduced: boolean;
  private hold: boolean;
  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private scale = 1;
  private frames = 0;
  private slow = 0;
  private hudAt = 0;
  private hud: Hud = { blades: 0, metres: 0, stage: "Ring", resting: false };

  constructor(
    private canvas: HTMLCanvasElement | OffscreenCanvas,
    opts: Opts,
  ) {
    this.reduced = opts.reducedMotion;
    this.hold = opts.hold;
    const at = opts.at >= 0 ? opts.at : this.reduced ? REST_AT : START_AT;
    this.k = at;
    this.kGoal = at;
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: "high-performance",
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("webgl2 unavailable");
    // SOFTWARE GL
    // cpu renderers keep the still; ?gl forces the live path
    if (!opts.forceGl && software(gl)) {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      throw new Error("software gl");
    }
    this.gl = gl;

    // PROGRAMS
    // all start compiling at once and are polled, never waited on
    this.parallel = !!gl.getExtension("KHR_parallel_shader_compile");
    const SH = "#define SHADOW\n";
    this.bladeP = pass(gl, BLADE_FS(""), BLADE_VS(""));
    this.bladeS = pass(gl, BLADE_FS(SH), BLADE_VS(SH));
    this.stemP = pass(gl, STEM_FS(""), STEM_VS(""));
    this.stemS = pass(gl, STEM_FS(SH), STEM_VS(SH));
    this.wallP = pass(gl, WALL_FS, WALL_VS);
    this.blurP = pass(gl, BLUR_FS, FULL_VS);
    this.copyP = pass(gl, COPY_FS, FULL_VS);
    this.progs = [
      this.bladeP,
      this.bladeS,
      this.stemP,
      this.stemS,
      this.wallP,
      this.blurP,
      this.copyP,
    ];

    // STRANDS
    // flat (u, side) strip instanced per strand: long for coarse, short for fine, one buffer
    const ib = this.buf(gl.ARRAY_BUFFER, this.form.data, gl.STATIC_DRAW);
    const strip = (seg: number, first: number) => {
      const sv = new Float32Array((seg + 1) * 4);
      const si: number[] = [];
      for (let i = 0; i <= seg; i++) {
        sv.set([i / seg, -1, i / seg, 1], i * 4);
        if (i < seg) {
          const a = i * 2;
          si.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      }
      const v = this.vao();
      this.mesh(sv, new Uint16Array(si));
      gl.bindBuffer(gl.ARRAY_BUFFER, ib);
      for (let k = 0; k < 4; k++) {
        gl.enableVertexAttribArray(1 + k);
        gl.vertexAttribPointer(1 + k, 4, gl.FLOAT, false, STRIDE * 4, first * STRIDE * 4 + k * 16);
        gl.vertexAttribDivisor(1 + k, 1);
      }
      return { vao: v, idx: si.length };
    };
    const c = strip(SEG, 0);
    this.coarseVao = c.vao;
    this.coarseIdx = c.idx;
    const fv = strip(FINE_SEG, this.form.coarseN);
    this.fineVao = fv.vao;
    this.fineIdx = fv.idx;

    // STEM
    const tv = new Float32Array((STEM_SEG + 1) * (STEM_SIDES + 1) * 2);
    const ti: number[] = [];
    for (let s = 0; s <= STEM_SEG; s++) {
      for (let j = 0; j <= STEM_SIDES; j++) {
        const o = (s * (STEM_SIDES + 1) + j) * 2;
        tv[o] = s / STEM_SEG;
        tv[o + 1] = (j / STEM_SIDES) * TAU;
        if (s < STEM_SEG && j < STEM_SIDES) {
          const a = s * (STEM_SIDES + 1) + j;
          const b = a + STEM_SIDES + 1;
          ti.push(a, a + 1, b, a + 1, b + 1, b);
        }
      }
    }
    this.stemVao = this.vao();
    this.mesh(tv, new Uint16Array(ti));
    this.stemIdx = ti.length;
    gl.bindVertexArray(null);

    // SHADOW MAP
    this.shadowTex = this.tex();
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, SHADOW_PX, SHADOW_PX);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.shadowFbo = this.fbo();
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, this.shadowTex, 0);
    gl.drawBuffers([gl.NONE]);
    gl.readBuffer(gl.NONE);

    // COVERAGE
    // the nest seen from the key, for the soft shadow on the wall
    this.covA = this.target(COV_PX);
    this.covB = this.target(COV_PX);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // LIGHT AND WALL
    norm3(this.keyL, 0.78, 0.42, 0.5);
    norm3(this.back, -0.7, 0.25, -0.66);
    this.tint[0] = 0.467;
    this.tint[1] = 0.367;
    this.tint[2] = 0.25;
    this.light();
    this.fillHud();
  }

  // GL SETUP
  private vao() {
    const v = this.gl.createVertexArray();
    this.gl.bindVertexArray(v);
    this.vaos.push(v);
    return v;
  }

  private buf(target: number, data: ArrayBufferView, usage: number) {
    const gl = this.gl;
    const b = gl.createBuffer();
    gl.bindBuffer(target, b);
    gl.bufferData(target, data, usage);
    this.bufs.push(b);
    return b;
  }

  private tex() {
    const t = this.gl.createTexture();
    this.gl.bindTexture(this.gl.TEXTURE_2D, t);
    this.texs.push(t);
    return t;
  }

  private fbo() {
    const f = this.gl.createFramebuffer();
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, f);
    this.fbos.push(f);
    return f;
  }

  private mesh(v: Float32Array, i: Uint16Array) {
    const gl = this.gl;
    this.buf(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.buf(gl.ELEMENT_ARRAY_BUFFER, i, gl.STATIC_DRAW);
  }

  private target(px: number) {
    const gl = this.gl;
    const tex = this.tex();
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, px, px);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = this.fbo();
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fbo };
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
    this.reduced = reduced;
    this.wake();
  }

  // INPUT
  // drag turns it and, pushed up, scrubs like a scroll; pointer motion is air
  press(x: number, y: number) {
    this.pressed = true;
    this.dragX = x;
    this.dragY = y;
    this.wake();
  }

  move(x: number, y: number) {
    if (this.pressed) {
      const dx = x - this.dragX;
      const dy = y - this.dragY;
      this.dragX = x;
      this.dragY = y;
      this.yawGoal = Math.max(-YAW_MAX, Math.min(YAW_MAX, this.yawGoal + dx * YAW_PER_PX));
      this.scrub(-dy * 1.6);
      return;
    }
    if (this.hoverX >= 0 && !this.reduced) {
      const dx = x - this.hoverX;
      const dy = y - this.hoverY;
      this.air = Math.max(-AIR_MAX, Math.min(AIR_MAX, this.air + dx * AIR_PER_PX));
      this.airZ = Math.max(-AIR_MAX, Math.min(AIR_MAX, this.airZ + dy * AIR_PER_PX * 0.5));
    }
    this.hoverX = x;
    this.hoverY = y;
    this.wake();
  }

  lift() {
    this.pressed = false;
    this.wake();
  }

  leave() {
    this.hoverX = -1;
    this.hoverY = -1;
  }

  wheel(px: number) {
    this.scrub(px);
  }

  key(k: string) {
    if (k === "ArrowLeft") this.yawGoal = Math.max(-YAW_MAX, this.yawGoal - 0.25);
    else if (k === "ArrowRight") this.yawGoal = Math.min(YAW_MAX, this.yawGoal + 0.25);
    else this.scrub(k === "ArrowUp" || k === "PageUp" ? -240 : 240);
    this.wake();
  }

  // SCRUB
  // clamped between bare ring and finished nest; mid-unravel, any scroll weaves back
  private scrub(px: number) {
    if (this.hold) return;
    const base = Math.floor(this.kGoal);
    const top = base + REST_AT;
    const k = this.kGoal >= base + PHASE.hold ? top : this.kGoal + px * SCRUB_PER_PX;
    this.kGoal = Math.max(base, Math.min(top, k));
    this.steered = true;
    this.cycles = 0;
    this.resting = this.kGoal >= top;
    this.wake();
  }

  // CLOCK
  // the cycle into the build share, eased in and out of its ends
  private phase(c: number) {
    if (c < PHASE.start) return 0;
    if (c < PHASE.built) return (c - PHASE.start) / (PHASE.built - PHASE.start);
    if (c < PHASE.hold) return 1;
    if (c < PHASE.gone) {
      const t = (c - PHASE.hold) / (PHASE.gone - PHASE.hold);
      return 1 - t * t * (3 - 2 * t);
    }
    return 0;
  }

  // LOOP
  private wake() {
    if (this.dead || this.raf || !this.visible) return;
    this.raf = raf(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.visible || this.dead) return;
    const gl = this.gl;
    if (this.hold && this.drawn) return;
    if (!this.linked) {
      for (const p of this.progs) if (this.parallel && busy(gl, p)) return this.wake();
      for (const p of this.progs) finish(gl, p);
      this.linked = true;
    }
    if (!this.sized) this.resize();
    const rawMs = this.last ? now - this.last : 0;
    const dt = this.last ? Math.min(MAX_DT_S, Math.max(0, rawMs) / 1000) : 0;
    this.last = now;

    const moving = this.step(dt);
    if (moving && dt > 0) this.adapt(rawMs);
    this.render();
    if (!this.drawn) {
      this.drawn = true;
      this.onShown();
    }
    if (now - this.hudAt > HUD_MS || !moving) {
      this.hudAt = now;
      if (this.fillHud()) this.onHud(this.hud);
    }
    if (moving) this.wake();
    else this.last = 0;
  };

  // SIMULATE
  // returns whether anything still moves
  private step(dt: number) {
    const auto = !this.reduced && !this.hold && !this.resting;
    this.time += dt;
    if (auto) {
      const before = Math.floor(this.kGoal);
      this.kGoal += dt / CYCLE_S;
      if (Math.floor(this.kGoal) > before) this.cycles++;
      const c = this.kGoal - Math.floor(this.kGoal);
      if ((this.steered || this.cycles >= AUTO_CYCLES) && c >= REST_AT && c < PHASE.hold) {
        this.kGoal = Math.floor(this.kGoal) + REST_AT;
        this.resting = true;
      }
    }
    const dk = this.kGoal - this.k;
    const ease = this.reduced ? 1 - Math.exp(-dt / 0.12) : 1 - Math.exp(-dt / CLOCK_TAU_S);
    this.k = Math.abs(dk) < 1e-6 ? this.kGoal : this.k + dk * ease;
    const c = this.k - Math.floor(this.k);
    this.build = this.phase(c);
    this.age = ((c - PHASE.start) / (PHASE.built - PHASE.start)) * AGE_PER_BUILD;

    // TURN
    const idle = auto ? IDLE_YAW * Math.sin(this.time * TAU * IDLE_YAW_HZ) : 0;
    const yg = this.yawGoal + idle;
    const dy = yg - this.yaw;
    this.yaw = Math.abs(dy) < 1e-5 ? yg : this.yaw + dy * (1 - Math.exp(-dt / YAW_TAU_S));

    // AIR AND SWAY
    // the breath decays; the nest leans into it on a soft pendulum
    const decay = Math.exp(-dt / AIR_TAU_S);
    this.air *= decay;
    this.airZ *= decay;
    if (Math.abs(this.air) < 1e-4) this.air = 0;
    if (Math.abs(this.airZ) < 1e-4) this.airZ = 0;
    const breath = auto ? 0.012 * Math.sin(this.time * 0.9) : 0;
    const steps = dt > 0 ? 3 : 0;
    for (let i = 0; i < steps; i++) {
      const h = dt / steps;
      const fx = SWAY_K * (this.air * SWAY_PER_AIR + breath) - SWAY_K * this.sx - SWAY_C * this.vx;
      this.vx += fx * h;
      this.sx += this.vx * h;
      const fz = SWAY_K * this.airZ * SWAY_PER_AIR * 0.6 - SWAY_K * this.sz - SWAY_C * this.vz;
      this.vz += fz * h;
      this.sz += this.vz * h;
    }
    this.wind[0] = this.vx * 0.04;
    this.wind[1] = 0;
    this.wind[2] = this.vz * 0.04;
    this.wind[3] = this.time;

    // PIVOT
    // lean, then yaw, about the knot
    spin(this.tmpA, 0, 0, 0, 1, -this.sx, 0, PIVOT_Y, 0);
    spin(this.tmpB, 0, 1, 0, 0, this.sz, 0, PIVOT_Y, 0);
    mul(this.model, this.tmpA, this.tmpB);
    spin(this.tmpA, 0, 0, 1, 0, this.yaw, 0, 0, 0);
    this.tmpB.set(this.model);
    mul(this.model, this.tmpB, this.tmpA);

    const settled =
      Math.abs(this.kGoal - this.k) < 1e-5 &&
      Math.abs(yg - this.yaw) < 1e-4 &&
      Math.abs(this.sx) + Math.abs(this.vx) + Math.abs(this.sz) + Math.abs(this.vz) < 1e-4 &&
      this.air === 0 &&
      this.airZ === 0;
    return auto || this.pressed || !settled;
  }

  // QUALITY
  // a run of slow frames thins the strands, then lowers the resolution
  private adapt(ms: number) {
    if (ms <= 0 || ms > 200) return;
    this.frames++;
    if (ms > SLOW_MS) this.slow++;
    if (this.frames < 40) return;
    if (this.slow > 24) {
      if (this.lod > MIN_LOD) this.lod = Math.max(MIN_LOD, this.lod * 0.85);
      else if (this.scale > MIN_SCALE) {
        this.scale = Math.max(MIN_SCALE, this.scale * 0.85);
        this.sized = false;
      }
    }
    this.frames = 0;
    this.slow = 0;
  }

  // HUD
  private fillHud() {
    const f = this.form;
    const n = f.count(this.build);
    const blades = f.fixed + n;
    const metres = Math.round(((f.fixedLen + f.lengthTo[n]) * CM_PER_UNIT) / 10) / 10;
    const c = this.k - Math.floor(this.k);
    let stage: string = STAGES[0];
    if (c >= PHASE.hold) stage = this.build > 0.02 ? "Unweaving" : STAGES[6];
    else if (this.build >= 1) stage = STAGES[5];
    else if (this.build > f.marks[2]) stage = STAGES[4];
    else if (this.build > f.marks[1]) stage = STAGES[3];
    else if (this.build > f.marks[0]) stage = STAGES[2];
    else if (this.build > 0.004) stage = STAGES[1];
    const h = this.hud;
    if (
      h.blades === blades &&
      h.metres === metres &&
      h.stage === stage &&
      h.resting === this.resting
    )
      return false;
    h.blades = blades;
    h.metres = metres;
    h.stage = stage;
    h.resting = this.resting;
    return true;
  }

  // CAMERA
  // eye a little below the middle so the mouth shows; wide: right of the title, tall: centred
  private frameCam() {
    const a = this.cssW / this.cssH;
    const wide = a >= 1;
    const halfH = 1.62;
    const halfW = 0.95;
    const need = wide ? halfH / 0.84 : Math.max(halfH / 0.74, halfW / (0.86 * a));
    const D = need / FOV_TAN;
    const tx = 0;
    const ty = -0.12;
    const tz = 0;
    this.eye[0] = tx;
    this.eye[1] = ty - D * 0.09;
    this.eye[2] = tz + D;
    norm3(this.fwd, tx - this.eye[0], ty - this.eye[1], tz - this.eye[2]);
    cross3(this.right, this.fwd, this.worldUp);
    cross3(this.up, this.right, this.fwd);
    const sx = wide ? Math.min(0.32, 0.12 + (a - 1) * 0.36) : 0;
    const sy = wide ? 0.02 : -0.08;
    view(this.tmpA, this.eye, this.right, this.up, this.fwd);
    persp(this.tmpB, FOV_TAN, a, D * 0.4, D * 2.5, sx, sy);
    mul(this.camVP, this.tmpB, this.tmpA);
    const far = D - WALL_Z;
    const hh = FOV_TAN * far * 1.6;
    const hw = hh * a * 1.2;
    this.wallRect[0] = -hw;
    this.wallRect[1] = ty - hh;
    this.wallRect[2] = hw;
    this.wallRect[3] = ty + hh;
    this.pool[0] = 0.4;
    this.pool[1] = 0.5;
  }

  private light() {
    const L = this.keyL;
    this.lEye[0] = L[0] * 5;
    this.lEye[1] = L[1] * 5 - 0.1;
    this.lEye[2] = L[2] * 5;
    norm3(this.lF, -L[0], -L[1], -L[2]);
    cross3(this.lR, this.lF, this.worldUp);
    cross3(this.lU, this.lR, this.lF);
    view(this.tmpA, this.lEye, this.lR, this.lU, this.lF);
    ortho(this.tmpB, SHADOW_R, 0.5, 12);
    mul(this.lightVP, this.tmpB, this.tmpA);
  }

  private resize() {
    const gl = this.gl;
    const dpr = Math.min(this.dpr || 1, MAX_DPR) * this.scale;
    const w = Math.max(1, Math.round(this.cssW * dpr));
    const h = Math.max(1, Math.round(this.cssH * dpr));
    this.canvas.width = w;
    this.canvas.height = h;
    const max = gl.getParameter(gl.MAX_SAMPLES) as number;
    this.samples = Math.min(max, dpr > 1.5 ? 2 : 4);
    if (this.msColor) gl.deleteRenderbuffer(this.msColor);
    if (this.msDepth) gl.deleteRenderbuffer(this.msDepth);
    if (this.msFbo) gl.deleteFramebuffer(this.msFbo);
    this.msFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.msFbo);
    this.msColor = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.msColor);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.RGBA8, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, this.msColor);
    this.msDepth = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.msDepth);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.DEPTH_COMPONENT24, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.msDepth);
    if (this.flat) {
      gl.deleteTexture(this.flat.tex);
      gl.deleteFramebuffer(this.flat.fbo);
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    this.flat = { tex, fbo };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.frameCam();
    this.sized = true;
  }

  // RENDER
  private lit(p: Pass, vp: Float32Array) {
    const gl = this.gl;
    gl.useProgram(p.prog);
    gl.uniformMatrix4fv(p.u.uViewProj, false, vp);
    if (p.u.uLight) {
      gl.uniformMatrix4fv(p.u.uLight, false, this.lightVP);
      gl.uniform3fv(p.u.uKey, this.keyL);
      gl.uniform3fv(p.u.uBack, this.back);
      gl.uniform3fv(p.u.uEye, this.eye);
      gl.uniform1i(p.u.uShadow, 0);
      gl.uniform1f(p.u.uShadowPx, 1 / SHADOW_PX);
    }
  }

  private blades(p: Pass, vp: Float32Array) {
    const gl = this.gl;
    this.lit(p, vp);
    gl.uniformMatrix4fv(p.u.uModel, false, this.model);
    gl.uniform1f(p.u.uBuild, this.build);
    gl.uniform1f(p.u.uAge, this.age);
    gl.uniform1f(p.u.uWin, WIN);
    gl.uniform4fv(p.u.uWind, this.wind);
    gl.bindVertexArray(this.coarseVao);
    gl.drawElementsInstanced(gl.TRIANGLES, this.coarseIdx, gl.UNSIGNED_SHORT, 0, this.form.coarseN);
    gl.bindVertexArray(this.fineVao);
    const fine = Math.round(this.form.fineN * this.lod);
    gl.drawElementsInstanced(gl.TRIANGLES, this.fineIdx, gl.UNSIGNED_SHORT, 0, fine);
  }

  private stemDraw(p: Pass, vp: Float32Array) {
    const gl = this.gl;
    this.lit(p, vp);
    gl.uniform3fv(p.u.uStem, this.stem);
    gl.bindVertexArray(this.stemVao);
    gl.drawElements(gl.TRIANGLES, this.stemIdx, gl.UNSIGNED_SHORT, 0);
  }

  private render() {
    const gl = this.gl;
    const F = this.flat;
    if (!this.msFbo || !F) return;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    // SHADOW
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.shadowFbo);
    gl.viewport(0, 0, SHADOW_PX, SHADOW_PX);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(1.5, 3);
    this.blades(this.bladeS, this.lightVP);
    this.stemDraw(this.stemS, this.lightVP);
    gl.disable(gl.POLYGON_OFFSET_FILL);

    // COVERAGE, SOFTENED
    gl.disable(gl.DEPTH_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.covA.fbo);
    gl.viewport(0, 0, COV_PX, COV_PX);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.blades(this.bladeS, this.lightVP);
    this.stemDraw(this.stemS, this.lightVP);
    const bl = this.blurP;
    gl.useProgram(bl.prog);
    gl.uniform1i(bl.u.uTex, 1);
    gl.uniform2f(bl.u.uRes, COV_PX, COV_PX);
    gl.activeTexture(gl.TEXTURE1);
    for (let i = 0; i < 2; i++) {
      const st = (1 + i * 1.2) / COV_PX;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.covB.fbo);
      gl.bindTexture(gl.TEXTURE_2D, this.covA.tex);
      gl.uniform2f(bl.u.uStep, st, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.covA.fbo);
      gl.bindTexture(gl.TEXTURE_2D, this.covB.tex);
      gl.uniform2f(bl.u.uStep, 0, st);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // SCENE
    const w = this.canvas.width;
    const h = this.canvas.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.msFbo);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    const wp = this.wallP;
    gl.useProgram(wp.prog);
    gl.uniformMatrix4fv(wp.u.uViewProj, false, this.camVP);
    gl.uniformMatrix4fv(wp.u.uLight, false, this.lightVP);
    gl.uniform4fv(wp.u.uWall, this.wallRect);
    gl.uniform1f(wp.u.uWallZ, WALL_Z);
    gl.uniform3fv(wp.u.uKey, this.keyL);
    gl.uniform3fv(wp.u.uTint, this.tint);
    gl.uniform2fv(wp.u.uPool, this.pool);
    gl.uniform1i(wp.u.uCov, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.covA.tex);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    this.stemDraw(this.stemP, this.camVP);
    gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    this.blades(this.bladeP, this.camVP);
    gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    gl.disable(gl.DEPTH_TEST);

    // RESOLVE
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msFbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, F.fbo);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const cp = this.copyP;
    gl.useProgram(cp.prog);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, F.tex);
    gl.uniform1i(cp.u.uTex, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }

  dispose() {
    this.dead = true;
    unraf(this.raf);
    this.raf = 0;
    const gl = this.gl;
    if (this.msColor) gl.deleteRenderbuffer(this.msColor);
    if (this.msDepth) gl.deleteRenderbuffer(this.msDepth);
    if (this.msFbo) gl.deleteFramebuffer(this.msFbo);
    if (this.flat) {
      gl.deleteTexture(this.flat.tex);
      gl.deleteFramebuffer(this.flat.fbo);
    }
    for (const p of this.progs) gl.deleteProgram(p.prog);
    for (const v of this.vaos) gl.deleteVertexArray(v);
    for (const b of this.bufs) gl.deleteBuffer(b);
    for (const t of this.texs) gl.deleteTexture(t);
    for (const f of this.fbos) gl.deleteFramebuffer(f);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
