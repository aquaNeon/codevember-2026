import {
  BG_FS,
  BLADE_FS,
  BLADE_VS,
  DIM_FS,
  COPY_FS,
  FIELD_S,
  FIELD_U,
  FULL_VS,
  MOTE_FS,
  MOTE_VS,
  NB,
  POST_FS,
  SOFT_FS,
  SPINE_W,
  TUBE_FS,
  TUBE_VS,
} from "./shaders";

const MAX_DPR = 2;
const MAX_DT_S = 1 / 20;
const BG_SCALE = 0.5;
const FOV_TAN = Math.tan((38 * Math.PI) / 360);
const CAM_Z = 3.55;
const BLADE_N = 128;
const MAIN_F = 64;
const SEG_S = 200;
const SEG_U = 22;
const RING_S = 192;
const RING_A = 20;
const MOTES = 1000; // change for denser marine snow
const STEP_S = 1 / 120;
const STILL_T_S = 14;
const STIPE_R = 0.02;
const DEPTH_STEP = 0.002;
const KERNEL = [0.1, 0.35, 0.75, 1, 0.75, 0.35, 0.1];
const RIPPLE_PX = 1.1;
const FRINGE_PX = 1.3;
const GRAIN_PX = 1.5;
const BLUR_PX = 2.2; // change for a wider soft focus
const ZIG_RAD = 0.07;
const ZIG_ROUND = 0.4;
const GAP_R = 0.84;
const SIZE_R = 0.82;
const FIRST_AT = 0.26;

// FIELD
// damped springs: blade billow, sideways swing, stipe bend, bulb bob
const WAVE_C = 0.7;
const FLOW_U = 0.55;
const H_K = 8;
const H_D = 2.4;
const LAT_K = 4.5;
const LAT_D = 2.1;
const BOB_K = 6;
const BOB_D = 3.5;
const PUSH_H = 5;
const PUSH_TILT = 3.5;
const PUSH_LAT = 2.6;
const PUSH_MAIN = 1;
const PUSH_BOB = 4;
const MAIN_K = 16;
const MAIN_D = 8;
const SPEED_CAP = 2.4;
const REACH = 0.13;
const VEL_TAU_S = 0.07;
const GUST_S = 0.45;
const STATE_MS = 160;

type Layout = {
  x: number;
  y: number;
  z: number;
  a0: number;
  ak: number;
  len: number;
  flow: number;
  fork: number;
  ls: number;
  ws: number;
  spread: number;
};

const H_N = NB * FIELD_U * FIELD_S;
const L_N = NB * FIELD_S;

export class Kelp {
  private gl: WebGL2RenderingContext;
  private bgProg: WebGLProgram;
  private copyProg: WebGLProgram;
  private bladeProg: WebGLProgram;
  private dimProg: WebGLProgram;
  private udm: Record<string, WebGLUniformLocation | null>;
  private tubeProg: WebGLProgram;
  private moteProg: WebGLProgram;
  private postProg: WebGLProgram;
  private softProg: WebGLProgram;
  private uso: Record<string, WebGLUniformLocation | null>;
  private upo: Record<string, WebGLUniformLocation | null>;
  private ubg: Record<string, WebGLUniformLocation | null>;
  private ucp: Record<string, WebGLUniformLocation | null>;
  private ubl: Record<string, WebGLUniformLocation | null>;
  private utu: Record<string, WebGLUniformLocation | null>;
  private umo: Record<string, WebGLUniformLocation | null>;
  private bladeVao: WebGLVertexArrayObject;
  private tubeVao: WebGLVertexArrayObject;
  private moteVao: WebGLVertexArrayObject;
  private empty: WebGLVertexArrayObject;
  private buffers: WebGLBuffer[] = [];
  private bladeCount: number;
  private tubeCount: number;
  private spineTex: WebGLTexture;
  private fieldTex: WebGLTexture;
  private bgTex: WebGLTexture | null = null;
  private bgFbo: WebGLFramebuffer;
  // SCENE TARGET
  // drawn offscreen for the post pass; multisampled and resolved when the dpr is low
  private sceneFbo: WebGLFramebuffer;
  private resolveFbo: WebGLFramebuffer;
  private sceneTex: WebGLTexture | null = null;
  private colorRb: WebGLRenderbuffer | null = null;
  private depthRb: WebGLRenderbuffer | null = null;
  private samples: number;
  private softFbo: WebGLFramebuffer;
  private softTex: WebGLTexture | null = null;
  private softW = 1;
  private softH = 1;
  private sceneW = 0;
  private sceneH = 0;
  private dropAll: number[];
  private dropDepth: number[];
  private bgW = 1;
  private bgH = 1;

  private raf = 0;
  private last = 0;
  private visible = false;
  private sized = true;
  private shown = false;
  private reducedMotion: boolean;
  private t = STILL_T_S;
  private acc = 0;

  private depth0 = 0.95;
  private dpr = 1;
  private cssW = 1;
  private cssH = 1;
  private aspect = 1;
  private lay: Layout = layout(1);
  private dsMain = 1;
  private zig = new Float32Array(SPINE_W);
  private mvp = new Float32Array(16);
  private proj = new Float32Array(16);

  // FROND
  private att = new Float32Array(NB);
  private len = new Float32Array(NB);
  private wid = new Float32Array(NB);
  private stalk = new Float32Array(NB);
  private bulb = new Float32Array(NB);
  private ds = new Float32Array(NB);
  private b0 = new Float32Array(NB * 4);
  private b1 = new Float32Array(NB * 4);
  private b2 = new Float32Array(NB * 4);
  private grow = new Float32Array(NB);
  private splay = new Float32Array(NB);

  // SPINES
  // three rows each (position, lateral, normal): the stipe first, then every blade
  private spine = new Float32Array(SPINE_W * 4 * 3 * (NB + 1));

  // FIELD
  private h = new Float32Array(H_N);
  private hv = new Float32Array(H_N);
  private ha = new Float32Array(H_N);
  private hva = new Float32Array(H_N);
  private force = new Float32Array(H_N);
  private lat = new Float32Array(L_N);
  private latv = new Float32Array(L_N);
  private la = new Float32Array(L_N);
  private lva = new Float32Array(L_N);
  private forceLat = new Float32Array(L_N);
  private ml = new Float32Array(MAIN_F);
  private mlv = new Float32Array(MAIN_F);
  private forceMain = new Float32Array(MAIN_F);
  private yaw = new Float32Array(NB);
  private yawv = new Float32Array(NB);
  private pitch = new Float32Array(NB);
  private pitchv = new Float32Array(NB);
  private torqueY = new Float32Array(NB);
  private torqueP = new Float32Array(NB);
  private stirred = false;
  private uploaded = true;

  // CURSOR
  private px = 0;
  private py = 0;
  private has = false;
  private dx = 0;
  private dy = 0;
  private vx = 0;
  private vy = 0;
  private gust = 0;
  private gx = 0;
  private gy = 0;
  private surge = 0;
  private stateT = 0;
  private reported = -1;

  onShown: () => void = () => {};
  onState: (current: number) => void = () => {};

  constructor(
    private canvas: HTMLCanvasElement | OffscreenCanvas,
    opts: { reducedMotion: boolean; forceGl: boolean; dpr: number },
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

    // PROGRAMS
    this.bgProg = program(gl, FULL_VS, BG_FS);
    this.copyProg = program(gl, FULL_VS, COPY_FS);
    this.bladeProg = program(gl, BLADE_VS, BLADE_FS);
    this.dimProg = program(gl, BLADE_VS, DIM_FS);
    this.tubeProg = program(gl, TUBE_VS, TUBE_FS);
    this.moteProg = program(gl, MOTE_VS, MOTE_FS);
    this.postProg = program(gl, FULL_VS, POST_FS);
    this.softProg = program(gl, FULL_VS, SOFT_FS);
    const lit = [
      "uBg",
      "uRes",
      "uAspect",
      "uTime",
      "uSun",
      "uCam",
      "uMvp",
      "uSpine",
      "uB0",
      "uB1",
      "uDepth",
    ];
    this.ubg = uniforms(gl, this.bgProg, ["uRes", "uTime", "uAspect", "uSun"]);
    this.ucp = uniforms(gl, this.copyProg, ["uBg", "uRes"]);
    this.ubl = uniforms(gl, this.bladeProg, [...lit, "uField"]);
    this.udm = uniforms(gl, this.dimProg, [
      "uMvp",
      "uSpine",
      "uB0",
      "uB1",
      "uField",
      "uTime",
      "uDepth",
    ]);
    this.utu = uniforms(gl, this.tubeProg, [...lit, "uB2", "uMain", "uStipe"]);
    this.upo = uniforms(gl, this.postProg, [
      "uScene",
      "uBg",
      "uRes",
      "uTime",
      "uRipple",
      "uFringe",
      "uGrain",
      "uSoft",
      "uBlur",
    ]);
    this.uso = uniforms(gl, this.softProg, ["uScene", "uRes"]);
    this.umo = uniforms(gl, this.moteProg, [
      "uProj",
      "uTime",
      "uTan",
      "uAspect",
      "uCamZ",
      "uDpr",
      "uFlow",
      "uSun",
    ]);

    // GEOMETRY
    const blade = grid(SEG_S, SEG_U, false);
    this.bladeCount = blade.idx.length;
    this.bladeVao = this.mesh(blade.v, blade.idx, 2);
    const ring = grid(RING_S, RING_A, true);
    this.tubeCount = ring.idx.length;
    this.tubeVao = this.mesh(ring.v, ring.idx, 2);
    const seeds = new Float32Array(MOTES * 4);
    let r = 7;
    for (let i = 0; i < seeds.length; i++) seeds[i] = (r = (r * 16807) % 2147483647) / 2147483647;
    this.moteVao = this.mesh(seeds, null, 4);
    this.empty = gl.createVertexArray();

    // DATA TEXTURES
    this.spineTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.spineTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, SPINE_W, 3 * (NB + 1));
    params(gl, gl.NEAREST);
    this.fieldTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R16F, FIELD_S, FIELD_U * NB);
    params(gl, gl.LINEAR);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, FIELD_S, FIELD_U * NB, gl.RED, gl.FLOAT, this.h);
    this.bgFbo = gl.createFramebuffer();
    this.sceneFbo = gl.createFramebuffer();
    this.resolveFbo = gl.createFramebuffer();
    this.softFbo = gl.createFramebuffer();
    this.samples = opts.dpr < 1.5 ? Math.min(4, gl.getParameter(gl.MAX_SAMPLES) as number) : 0;
    this.dropAll = [gl.COLOR_ATTACHMENT0, gl.DEPTH_STENCIL_ATTACHMENT];
    this.dropDepth = [gl.DEPTH_STENCIL_ATTACHMENT];
  }

  private mesh(v: Float32Array, idx: Uint32Array | null, size: number) {
    const gl = this.gl;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, size, gl.FLOAT, false, 0, 0);
    this.buffers.push(vb);
    if (idx) {
      const ib = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      this.buffers.push(ib);
    }
    gl.bindVertexArray(null);
    return vao;
  }

  // PUBLIC
  size(w: number, h: number, dpr: number) {
    this.cssW = Math.max(1, w);
    this.cssH = Math.max(1, h);
    this.dpr = Math.min(dpr || 1, MAX_DPR);
    this.sized = false;
    this.wake();
  }

  show(visible: boolean) {
    this.visible = visible;
    this.last = 0;
    this.wake();
  }

  motion(reduced: boolean) {
    this.reducedMotion = reduced;
    this.wake();
  }

  move(x: number, y: number, fresh: boolean) {
    if (this.has && !fresh) {
      this.dx += x - this.px;
      this.dy += y - this.py;
    }
    this.px = x;
    this.py = y;
    this.has = true;
    this.wake();
  }

  leave() {
    this.has = false;
  }

  push(dirX: number, dirY: number) {
    this.gust = GUST_S;
    this.gx = dirX;
    this.gy = dirY;
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
    const still = this.reducedMotion;
    if (!still) this.t += dt;
    this.cursor(dt);
    this.build();
    if (!still) this.stir(dt);
    this.draw();
    this.report(dt);
    if (!still || this.stirred) this.wake();
    else this.last = 0;
  };

  // CURSOR
  // pointer travel per frame, exponentially smoothed into a velocity
  private cursor(dt: number) {
    if (dt <= 0) return;
    const k = 1 - Math.exp(-dt / VEL_TAU_S);
    let rx = this.dx / dt;
    let ry = this.dy / dt;
    this.dx = this.dy = 0;
    if (this.gust > 0) {
      // KEYBOARD
      // virtual cursor dragged across the frond's middle
      const p = 1 - this.gust / GUST_S;
      const o = (Math.round(SPINE_W * 0.6) * 4) | 0;
      project(this.spine[o], this.spine[o + 1], this.spine[o + 2], this.aspect);
      const span = this.cssH * 0.5;
      this.px = (SCR[0] * 0.5 + 0.5) * this.cssW + this.gx * span * (p - 0.5);
      this.py = (0.5 - SCR[1] * 0.5) * this.cssH + this.gy * span * (p - 0.5);
      this.has = true;
      rx = (this.gx * span) / GUST_S;
      ry = (this.gy * span) / GUST_S;
      this.gust -= dt;
    }
    this.vx += (rx - this.vx) * k;
    this.vy += (ry - this.vy) * k;
    const speed = Math.hypot(this.vx, this.vy) / this.cssH;
    this.surge += (speed - this.surge) * (1 - Math.exp(-dt / 0.4));
  }

  // SPINES
  // layered travelling waves in heading, pitch and twist, integrated from each root
  private build() {
    const L = this.lay;
    const t = this.t;
    const sp = this.spine;
    const surgeA = 0.025 * Math.sin(t * 0.21) + 0.01 * Math.sin(t * 0.37 + 1.3);
    const surgeB = 0.04 * Math.sin(t * 0.17 + 0.6) + 0.012 * Math.sin(t * 0.43 + 2.1);

    // STIPE
    let x = L.x;
    let y = L.y;
    let z = L.z;
    let ptx = 0;
    let pty = 0;
    let ptz = 0;
    const dsm = this.dsMain;
    for (let i = 0; i < SPINE_W; i++) {
      const sg = i * dsm;
      const f = Math.pow(sg / L.len, 1.3);
      const a =
        L.a0 + L.ak * sg + this.zig[i] + f * (surgeA + 0.018 * Math.sin(1.6 * sg - 0.5 * t));
      const b = 0.08 + f * (surgeB + 0.035 * Math.sin(1.2 * sg - 0.6 * t + 0.4));
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const cb = Math.cos(b);
      const sb = Math.sin(b);
      const tx = cb * ca;
      const ty = cb * sa;
      const tz = sb;
      if (i > 0) {
        x += 0.5 * (ptx + tx) * dsm;
        y += 0.5 * (pty + ty) * dsm;
        z += 0.5 * (ptz + tz) * dsm;
      }
      ptx = tx;
      pty = ty;
      ptz = tz;
      const fi = (i / (SPINE_W - 1)) * (MAIN_F - 1);
      const off = spline(this.ml, 0, MAIN_F, fi) * Math.min(1, sg * 2);
      store(sp, 0, i, x - sa * off, y + ca * off, z, -sa, ca, 0, -sb * ca, -sb * sa, cb);
    }

    // BLADES
    for (let n = 0; n < NB; n++) {
      const fi = this.att[n] / dsm;
      const i = Math.min(fi | 0, SPINE_W - 2);
      const fr = fi - i;
      const o = i * 4;
      const o1 = (SPINE_W + i) * 4;
      x = sp[o] + (sp[o + 4] - sp[o]) * fr;
      y = sp[o + 1] + (sp[o + 5] - sp[o + 1]) * fr;
      z = sp[o + 2] + (sp[o + 6] - sp[o + 2]) * fr;
      const am = Math.atan2(-sp[o1], sp[o1 + 1]);
      const P0 = this.stalk[n] * 0.3;
      const P = this.stalk[n];
      const len = this.len[n];
      const ds = this.ds[n];
      const lam = this.splay[n] > 0 ? 0.14 + 0.12 * len : 0.75 * len;
      const ph = n * 0.85;
      const row = 3 + n * 3;
      const yaw = this.yaw[n];
      const pit = this.pitch[n];
      const side = Math.sign(L.fork);
      const g = this.grow[n];
      const flow = L.flow + side * (L.spread * (1 - g) - 0.3 * L.spread + 0.07 * Math.sin(n * 1.7));
      const bend = side * (this.splay[n] > 0 ? -0.1 : 0.7);
      for (let k = 0; k < BLADE_N; k++) {
        const sg = -P + k * ds;
        const along = sg + P;
        const f = Math.pow(along / (len + P), 1.2);
        const relax = Math.exp(-along / lam);
        const a =
          flow +
          (am + L.fork * this.splay[n] * (1 - Math.exp(-along / P0)) - flow) * relax +
          bend * Math.max(sg, 0) +
          yaw +
          f *
            (0.08 * Math.sin(2.0 * sg - 0.9 * t + ph) +
              0.04 * Math.sin(4.4 * sg - 1.7 * t + ph * 1.3));
        const b =
          0.08 +
          0.1 * Math.max(sg, 0) +
          pit +
          f *
            (0.18 * Math.sin(1.7 * sg - 1.05 * t + ph) +
              0.07 * Math.sin(3.8 * sg - 2.0 * t + 2 + ph));
        const psi = 0.4 * Math.max(sg, 0) + f * 0.45 * Math.sin(1.3 * sg - 0.8 * t + ph * 0.7);
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const cb = Math.cos(b);
        const sb = Math.sin(b);
        const tx = cb * ca;
        const ty = cb * sa;
        const tz = sb;
        if (k > 0) {
          x += 0.5 * (ptx + tx) * ds;
          y += 0.5 * (pty + ty) * ds;
          z += 0.5 * (ptz + tz) * ds;
        }
        ptx = tx;
        pty = ty;
        ptz = tz;
        // FRAME
        // lateral in plane, normal toward camera, then twisted about the tangent
        const cp = Math.cos(psi);
        const spsi = Math.sin(psi);
        const nx0 = -sb * ca;
        const ny0 = -sb * sa;
        const nz0 = cb;
        const lx = cp * -sa + spsi * nx0;
        const ly = cp * ca + spsi * ny0;
        const lz = spsi * nz0;
        let off = 0;
        if (sg > 0) {
          const q = Math.min((sg / len) * (FIELD_S - 1), FIELD_S - 1.001);
          off = spline(this.lat, n * FIELD_S, FIELD_S, q);
        }
        store(
          sp,
          row,
          k,
          x + lx * off,
          y + ly * off,
          z + lz * off,
          lx,
          ly,
          lz,
          cp * nx0 + spsi * sa,
          cp * ny0 - spsi * ca,
          cp * nz0,
        );
      }
    }
  }

  // FIELD
  // the cursor's push, then a damped wave equation that drifts downstream
  private stir(dt: number) {
    const speed = Math.hypot(this.vx, this.vy) / this.cssH;
    const pushing = this.has && speed > 0.02;
    this.force.fill(0);
    this.forceLat.fill(0);
    this.forceMain.fill(0);
    this.torqueY.fill(0);
    this.torqueP.fill(0);
    if (pushing) {
      const mag = SPEED_CAP * Math.tanh(speed / SPEED_CAP);
      const ux = this.vx / this.cssH / speed;
      const uy = -this.vy / this.cssH / speed;
      const reach = this.cssH * REACH * (1 + 0.5 * Math.tanh(speed));
      const inv = 1 / (reach * reach);
      const sp = this.spine;
      for (let n = 0; n < NB; n++) {
        const row = 3 + n * 3;
        const len = this.len[n];
        const i0 = this.stalk[n] / this.ds[n];
        for (let j = 0; j < FIELD_S; j++) {
          const s = j / (FIELD_S - 1);
          const fi = i0 + (s * len) / this.ds[n];
          const i = Math.min(fi | 0, BLADE_N - 2);
          const o = (row * SPINE_W + i) * 4;
          const o1 = o + SPINE_W * 4;
          const cx = sp[o];
          const cy = sp[o + 1];
          const cz = sp[o + 2];
          const lx = sp[o1];
          const ly = sp[o1 + 1];
          const lz = sp[o1 + 2];
          const across = (ux * lx + uy * ly) / (Math.hypot(lx, ly) || 1);
          const w = width(s, this.wid[n]);
          let peak = 0;
          for (let k = 0; k < FIELD_U; k++) {
            const u = -1 + (2 * k) / (FIELD_U - 1);
            const fall = this.fall(cx + lx * u * w, cy + ly * u * w, cz + lz * u * w, inv);
            if (fall > peak) peak = fall;
            this.force[(n * FIELD_U + k) * FIELD_S + j] =
              -mag * fall * (PUSH_H + PUSH_TILT * across * u);
          }
          this.forceLat[n * FIELD_S + j] = PUSH_LAT * mag * across * peak;
          this.torqueY[n] += (across * peak * mag * s) / FIELD_S;
          this.torqueP[n] -= (peak * mag * s) / FIELD_S;
          if (peak > 0.05) this.stirred = true;
        }
        const ob = (row * SPINE_W + 8) * 4;
        const fb = this.fall(sp[ob], sp[ob + 1], sp[ob + 2], inv);
        const ol = ob + SPINE_W * 4;
        const acrossB = (ux * sp[ol] + uy * sp[ol + 1]) / (Math.hypot(sp[ol], sp[ol + 1]) || 1);
        this.torqueY[n] += acrossB * fb * mag * 0.6;
        const jm = Math.round((this.att[n] / this.lay.len) * (MAIN_F - 1));
        // STIPE PUSH
        // spread over a few samples so the stipe bends instead of kinking
        for (let d = -3; d <= 3; d++) {
          const jj = jm + d;
          if (jj >= 0 && jj < MAIN_F)
            this.forceMain[jj] += KERNEL[d + 3] * PUSH_MAIN * mag * acrossB * fb;
        }
        if (fb > 0.05) this.stirred = true;
      }
      for (let j = 0; j < MAIN_F; j++) {
        const i = Math.round((j / (MAIN_F - 1)) * (SPINE_W - 1));
        const o = i * 4;
        const o1 = (SPINE_W + i) * 4;
        const across = (ux * sp[o1] + uy * sp[o1 + 1]) / (Math.hypot(sp[o1], sp[o1 + 1]) || 1);
        const fall = this.fall(sp[o], sp[o + 1], sp[o + 2], inv);
        this.forceMain[j] += PUSH_MAIN * mag * across * fall;
        if (fall > 0.05) this.stirred = true;
      }
    }
    if (!this.stirred) return;
    this.acc += dt;
    let n = 0;
    while (this.acc >= STEP_S && n < 8) {
      this.acc -= STEP_S;
      n++;
      this.substep(STEP_S);
    }
    let energy = 0;
    for (let i = 0; i < H_N; i++) energy += Math.abs(this.h[i]) + Math.abs(this.hv[i]);
    for (let i = 0; i < L_N; i++) energy += Math.abs(this.lat[i]) + Math.abs(this.latv[i]);
    for (let i = 0; i < MAIN_F; i++) energy += Math.abs(this.ml[i]) + Math.abs(this.mlv[i]);
    for (let i = 0; i < NB; i++)
      energy += Math.abs(this.yaw[i]) + Math.abs(this.yawv[i]) + Math.abs(this.pitch[i]);
    this.uploaded = false;
    if (!Number.isFinite(energy) || (energy < 1e-4 && !pushing)) {
      this.h.fill(0);
      this.hv.fill(0);
      this.lat.fill(0);
      this.latv.fill(0);
      this.ml.fill(0);
      this.mlv.fill(0);
      this.yaw.fill(0);
      this.yawv.fill(0);
      this.pitch.fill(0);
      this.pitchv.fill(0);
      this.stirred = false;
    }
  }

  private fall(x: number, y: number, z: number, inv: number) {
    project(x, y, z, this.aspect);
    const qx = (SCR[0] * 0.5 + 0.5) * this.cssW - this.px;
    const qy = (0.5 - SCR[1] * 0.5) * this.cssH - this.py;
    return Math.exp(-(qx * qx + qy * qy) * inv);
  }

  private substep(dt: number) {
    const c2 = WAVE_C * WAVE_C;
    const h = this.h;
    const hv = this.hv;
    const ha = this.ha;
    const hva = this.hva;
    for (let n = 0; n < NB; n++) {
      const dS = this.len[n] / (FIELD_S - 1);
      const dU = (this.wid[n] * 1.4) / (FIELD_U - 1);
      const adv = Math.min(1, (FLOW_U * dt) / dS);
      const is2 = Math.min(c2 / (dS * dS), 0.2 / (dt * dt));
      const iu2 = Math.min(c2 / (dU * dU), 0.2 / (dt * dt));
      // ADVECT
      for (let k = 0; k < FIELD_U; k++) {
        const r = (n * FIELD_U + k) * FIELD_S;
        ha[r] = h[r] * (1 - adv);
        hva[r] = hv[r] * (1 - adv);
        for (let j = 1; j < FIELD_S; j++) {
          ha[r + j] = h[r + j] * (1 - adv) + h[r + j - 1] * adv;
          hva[r + j] = hv[r + j] * (1 - adv) + hv[r + j - 1] * adv;
        }
      }
      // WAVE
      for (let k = 0; k < FIELD_U; k++) {
        const r = (n * FIELD_U + k) * FIELD_S;
        const up = k > 0 ? r - FIELD_S : r;
        const dn = k < FIELD_U - 1 ? r + FIELD_S : r;
        for (let j = 0; j < FIELD_S; j++) {
          const c = ha[r + j];
          const l = j > 0 ? ha[r + j - 1] : 0;
          const rr = j < FIELD_S - 1 ? ha[r + j + 1] : c;
          const lap = (l + rr - 2 * c) * is2 + (ha[up + j] + ha[dn + j] - 2 * c) * iu2;
          let v = hva[r + j];
          v += (lap - H_K * c - H_D * v + this.force[r + j]) * dt;
          hv[r + j] = v;
          h[r + j] = c + v * dt;
        }
      }
      // SWING
      const lat = this.lat;
      const latv = this.latv;
      const la = this.la;
      const lva = this.lva;
      const r = n * FIELD_S;
      la[r] = lat[r] * (1 - adv);
      lva[r] = latv[r] * (1 - adv);
      for (let j = 1; j < FIELD_S; j++) {
        la[r + j] = lat[r + j] * (1 - adv) + lat[r + j - 1] * adv;
        lva[r + j] = latv[r + j] * (1 - adv) + latv[r + j - 1] * adv;
      }
      for (let j = 0; j < FIELD_S; j++) {
        const c = la[r + j];
        const l = j > 0 ? la[r + j - 1] : 0;
        const rr = j < FIELD_S - 1 ? la[r + j + 1] : c;
        let v = lva[r + j];
        v += ((l + rr - 2 * c) * is2 - LAT_K * c - LAT_D * v + this.forceLat[r + j]) * dt;
        latv[r + j] = v;
        lat[r + j] = c + v * dt;
      }
      // BOB
      this.yawv[n] +=
        (-BOB_K * this.yaw[n] - BOB_D * this.yawv[n] + PUSH_BOB * this.torqueY[n]) * dt;
      this.yaw[n] += this.yawv[n] * dt;
      this.pitchv[n] +=
        (-BOB_K * this.pitch[n] - BOB_D * this.pitchv[n] + PUSH_BOB * 0.5 * this.torqueP[n]) * dt;
      this.pitch[n] += this.pitchv[n] * dt;
    }
    // STIPE
    const dM = this.lay.len / (MAIN_F - 1);
    const im2 = Math.min(c2 / (dM * dM), 0.3 / (dt * dt));
    for (let j = 0; j < MAIN_F; j++) {
      const c = this.ml[j];
      const l = j > 0 ? this.ml[j - 1] : 0;
      const rr = j < MAIN_F - 1 ? this.ml[j + 1] : c;
      this.mlv[j] +=
        ((l + rr - 2 * c) * im2 - MAIN_K * c - MAIN_D * this.mlv[j] + this.forceMain[j]) * dt;
    }
    for (let j = 0; j < MAIN_F; j++) this.ml[j] += this.mlv[j] * dt;
  }

  // STATE
  // readout: base drift plus the cursor's surge
  private report(dt: number) {
    this.stateT += dt * 1000;
    const v = Math.round(
      (0.12 + 0.03 * Math.sin(this.t * 0.21) + 0.35 * Math.tanh(this.surge)) * 100,
    );
    if (v === this.reported || this.stateT < STATE_MS) return;
    this.stateT = 0;
    this.reported = v;
    this.onState(v / 100);
  }

  // RESIZE
  private resize() {
    const gl = this.gl;
    const w = Math.round(this.cssW * this.dpr);
    const h = Math.round(this.cssH * this.dpr);
    this.sized = true;
    if (w !== this.canvas.width || h !== this.canvas.height) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.aspect = this.cssW / this.cssH;
    this.frond();
    perspective(this.proj, this.aspect);
    this.mvp.set(this.proj);
    this.mvp[14] = this.proj[10] * -CAM_Z + this.proj[14];
    this.mvp[15] = CAM_Z;
    this.depth0 = this.mvp[14] / CAM_Z;
    if (w !== this.sceneW || h !== this.sceneH) this.target(w, h);

    // BACKGROUND TARGET
    const bw = Math.max(1, Math.round(w * BG_SCALE));
    const bh = Math.max(1, Math.round(h * BG_SCALE));
    if (bw !== this.bgW || bh !== this.bgH || !this.bgTex) {
      if (this.bgTex) gl.deleteTexture(this.bgTex);
      this.bgW = bw;
      this.bgH = bh;
      this.bgTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, bw, bh);
      params(gl, gl.LINEAR);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bgFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.bgTex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }
  }

  // FROND
  // oldest and largest at the root; spacing and size shrink toward the tip
  private frond() {
    const L = (this.lay = layout(this.aspect));
    this.dsMain = L.len / (SPINE_W - 1);
    // SPACING
    // geometric gaps, scaled so the last float lands on the stipe's end
    let sum = 0;
    for (let n = 0; n < NB - 1; n++) sum += Math.pow(GAP_R, n);
    let pos = FIRST_AT;
    for (let n = 0; n < NB; n++) {
      if (n > 0) pos += ((1 - FIRST_AT) * Math.pow(GAP_R, n - 1)) / sum;
      const apex = n === NB - 1;
      const g = n / (NB - 2);
      this.att[n] = L.len * Math.min(pos, 1);
      this.len[n] = L.ls * 2.7 * Math.pow(SIZE_R, n) * (apex ? 1.3 : 1);
      this.wid[n] = L.ws * 0.19 * Math.pow(0.875, n);
      this.bulb[n] = L.ws * 0.06 * Math.pow(0.89, n) * (1 + 0.08 * Math.sin(n * 2.7) * (1 - g));
      this.stalk[n] = this.bulb[n] * (8.2 + 1.1 * Math.sin(n * 3.3) * (1 - 0.6 * g));
      this.grow[n] = g;
      // APEX
      // the stipe runs on into the curved apical blade
      this.splay[n] = apex ? 0 : 1 + 0.2 * Math.sin(n * 2.3);
      this.ds[n] = (this.len[n] + this.stalk[n]) / (BLADE_N - 1);
      const o = n * 4;
      this.b0[o] = this.len[n];
      this.b0[o + 1] = this.wid[n];
      this.b0[o + 2] = this.stalk[n] / this.ds[n];
      this.b0[o + 3] = 1 / this.ds[n];
      this.b1[o] = BLADE_N - 1;
      this.b1[o + 1] = n * 0.85;
      this.b1[o + 2] = Math.max(0.05, 1 - this.grow[n] * 0.9);
      this.b1[o + 3] = this.bulb[n] * 0.2;
      const at = this.att[n] / L.len;
      this.b2[o + 3] = STIPE_R * Math.sqrt(L.ws) * (1 - 0.6 * smooth(0.6, 1, at));
      this.b2[o] = this.stalk[n];
      this.b2[o + 1] = this.bulb[n];
      this.b2[o + 2] = 0.82 + 0.06 * Math.sin(n * 1.9);
    }
    // ZIGZAG
    // alternating heading kink at each node, rounded over ZIG_ROUND
    const side = Math.sign(L.fork);
    for (let i = 0; i < SPINE_W; i++) {
      const sg = i * this.dsMain;
      let z = 1;
      for (let n = 0; n < NB - 1; n++)
        z -=
          (n % 2 ? -1 : 1) *
          (1 +
            Math.tanh(
              (sg - this.att[n]) / Math.max(0.025, ZIG_ROUND * (this.att[n + 1] - this.att[n])),
            ));
      this.zig[i] = side * ZIG_RAD * z;
    }
  }

  // DRAW
  private draw() {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const sunX = 0.3 * this.aspect;
    const sunY = 1.75;

    gl.bindTexture(gl.TEXTURE_2D, this.spineTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SPINE_W, 3 * (NB + 1), gl.RGBA, gl.FLOAT, this.spine);
    if (!this.uploaded) {
      gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, FIELD_S, FIELD_U * NB, gl.RED, gl.FLOAT, this.h);
      this.uploaded = true;
    }

    // BACKGROUND
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.empty);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.bgFbo);
    gl.viewport(0, 0, this.bgW, this.bgH);
    gl.useProgram(this.bgProg);
    gl.uniform2f(this.ubg.uRes, this.bgW, this.bgH);
    gl.uniform1f(this.ubg.uTime, this.t);
    gl.uniform1f(this.ubg.uAspect, this.aspect);
    gl.uniform2f(this.ubg.uSun, sunX, sunY);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.spineTex);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
    gl.useProgram(this.copyProg);
    gl.uniform1i(this.ucp.uBg, 0);
    gl.uniform2f(this.ucp.uRes, w, h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.clear(gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

    // STIPE AND BULBS
    // marked in the stencil so the layer pass leaves them alone
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.enable(gl.STENCIL_TEST);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
    gl.stencilFunc(gl.ALWAYS, 1, 0xff);
    gl.useProgram(this.tubeProg);
    const ut = this.utu;
    this.lit(ut, w, h, sunX, sunY);
    gl.uniform4fv(ut.uB2, this.b2);
    gl.uniform4f(
      ut.uStipe,
      this.lay.len,
      SPINE_W - 1,
      1 / this.dsMain,
      STIPE_R * Math.sqrt(this.lay.ws),
    );
    gl.bindVertexArray(this.tubeVao);
    // CULL
    // tube winding faces inward; front-culling hides the open stalk ends
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.FRONT);
    gl.uniform1f(ut.uMain, 1);
    gl.drawElements(gl.TRIANGLES, this.tubeCount, gl.UNSIGNED_INT, 0);
    gl.uniform1f(ut.uMain, 0);
    gl.drawElementsInstanced(gl.TRIANGLES, this.tubeCount, gl.UNSIGNED_INT, 0, NB);
    gl.disable(gl.CULL_FACE);

    // BLADES
    // alpha keeps the frond's coverage for the soft focus in post
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.bladeProg);
    this.lit(this.ubl, w, h, sunX, sunY);
    gl.uniform1i(this.ubl.uField, 2);
    gl.bindVertexArray(this.bladeVao);
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    gl.drawElementsInstanced(gl.TRIANGLES, this.bladeCount, gl.UNSIGNED_INT, 0, NB);

    // LAYERS
    // occluded blades multiply into the one in front
    gl.useProgram(this.dimProg);
    const ud = this.udm;
    gl.uniformMatrix4fv(ud.uMvp, false, this.mvp);
    gl.uniform1i(ud.uSpine, 1);
    gl.uniform1i(ud.uField, 2);
    gl.uniform1f(ud.uTime, this.t);
    gl.uniform4fv(ud.uB0, this.b0);
    gl.uniform4fv(ud.uB1, this.b1);
    gl.uniform2f(ud.uDepth, this.depth0, DEPTH_STEP);
    gl.depthFunc(gl.GREATER);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-1, -8);
    gl.depthMask(false);
    // STENCIL
    // once per pixel, so a stack of blades reads as two layers, not black
    gl.stencilFunc(gl.EQUAL, 0, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR);
    gl.blendFunc(gl.ZERO, gl.SRC_COLOR);
    gl.drawElementsInstanced(gl.TRIANGLES, this.bladeCount, gl.UNSIGNED_INT, 0, NB);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.disable(gl.STENCIL_TEST);

    // MOTES
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.depthMask(false);
    gl.useProgram(this.moteProg);
    const u = this.umo;
    gl.uniformMatrix4fv(u.uProj, false, this.proj);
    gl.uniform1f(u.uTime, this.t);
    gl.uniform1f(u.uTan, FOV_TAN);
    gl.uniform1f(u.uAspect, this.aspect);
    gl.uniform1f(u.uCamZ, CAM_Z);
    gl.uniform1f(u.uDpr, this.dpr * (this.cssH / 800));
    gl.uniform4f(
      u.uFlow,
      (this.px / this.cssW) * 2 - 1,
      1 - (this.py / this.cssH) * 2,
      (this.vx / this.cssW) * 0.5,
      (-this.vy / this.cssH) * 0.5,
    );
    gl.uniform2f(u.uSun, sunX, sunY);
    gl.bindVertexArray(this.moteVao);
    gl.drawArrays(gl.POINTS, 0, MOTES);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    this.post(w, h);
    gl.bindVertexArray(null);

    if (!this.shown) {
      this.shown = true;
      this.onShown();
    }
  }

  // POST
  private post(w: number, h: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.sceneFbo);
    if (this.samples) {
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.resolveFbo);
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.invalidateFramebuffer(gl.READ_FRAMEBUFFER, this.dropAll);
    } else gl.invalidateFramebuffer(gl.READ_FRAMEBUFFER, this.dropDepth);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(this.empty);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.softTex);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.softFbo);
    gl.viewport(0, 0, this.softW, this.softH);
    gl.useProgram(this.softProg);
    gl.uniform1i(this.uso.uScene, 3);
    gl.uniform2f(this.uso.uRes, this.softW, this.softH);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.postProg);
    const u = this.upo;
    gl.uniform1i(u.uScene, 3);
    gl.uniform1i(u.uBg, 0);
    gl.uniform1i(u.uSoft, 4);
    gl.uniform1f(u.uBlur, BLUR_PX * this.dpr);
    gl.uniform2f(u.uRes, w, h);
    gl.uniform1f(u.uTime, this.t);
    gl.uniform1f(u.uRipple, this.reducedMotion ? 0 : RIPPLE_PX * this.dpr);
    gl.uniform1f(u.uFringe, FRINGE_PX * this.dpr);
    gl.uniform1f(u.uGrain, GRAIN_PX * this.dpr);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private target(w: number, h: number) {
    const gl = this.gl;
    this.sceneW = w;
    this.sceneH = h;
    if (this.sceneTex) gl.deleteTexture(this.sceneTex);
    if (this.colorRb) gl.deleteRenderbuffer(this.colorRb);
    if (this.depthRb) gl.deleteRenderbuffer(this.depthRb);
    this.colorRb = null;
    this.sceneTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    params(gl, gl.LINEAR);
    if (this.softTex) gl.deleteTexture(this.softTex);
    this.softW = Math.max(1, w >> 1);
    this.softH = Math.max(1, h >> 1);
    this.softTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.softTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, this.softW, this.softH);
    params(gl, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.softFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.softTex, 0);
    this.depthRb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthRb);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    if (this.samples) {
      const n = this.samples;
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, n, gl.DEPTH24_STENCIL8, w, h);
      this.colorRb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.colorRb);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, n, gl.RGBA8, w, h);
      gl.framebufferRenderbuffer(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.RENDERBUFFER,
        this.colorRb,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.resolveFbo);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        this.sceneTex,
        0,
      );
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneFbo);
    } else {
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, w, h);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        this.sceneTex,
        0,
      );
    }
    gl.framebufferRenderbuffer(
      gl.FRAMEBUFFER,
      gl.DEPTH_STENCIL_ATTACHMENT,
      gl.RENDERBUFFER,
      this.depthRb,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private lit(
    u: Record<string, WebGLUniformLocation | null>,
    w: number,
    h: number,
    sx: number,
    sy: number,
  ) {
    const gl = this.gl;
    gl.uniform1i(u.uBg, 0);
    gl.uniform1i(u.uSpine, 1);
    gl.uniform2f(u.uRes, w, h);
    gl.uniform1f(u.uAspect, this.aspect);
    gl.uniform1f(u.uTime, this.t);
    gl.uniform2f(u.uSun, sx, sy);
    gl.uniform3f(u.uCam, 0, 0, CAM_Z);
    gl.uniformMatrix4fv(u.uMvp, false, this.mvp);
    gl.uniform4fv(u.uB0, this.b0);
    gl.uniform4fv(u.uB1, this.b1);
    gl.uniform2f(u.uDepth, this.depth0, DEPTH_STEP);
  }

  dispose() {
    unraf(this.raf);
    this.raf = 0;
    const gl = this.gl;
    gl.deleteProgram(this.bgProg);
    gl.deleteProgram(this.copyProg);
    gl.deleteProgram(this.bladeProg);
    gl.deleteProgram(this.dimProg);
    gl.deleteProgram(this.tubeProg);
    gl.deleteProgram(this.moteProg);
    this.buffers.forEach((b) => gl.deleteBuffer(b));
    gl.deleteVertexArray(this.bladeVao);
    gl.deleteVertexArray(this.tubeVao);
    gl.deleteVertexArray(this.moteVao);
    gl.deleteVertexArray(this.empty);
    gl.deleteTexture(this.spineTex);
    gl.deleteTexture(this.fieldTex);
    if (this.bgTex) gl.deleteTexture(this.bgTex);
    gl.deleteFramebuffer(this.bgFbo);
    gl.deleteProgram(this.postProg);
    gl.deleteProgram(this.softProg);
    gl.deleteFramebuffer(this.softFbo);
    if (this.softTex) gl.deleteTexture(this.softTex);
    gl.deleteFramebuffer(this.sceneFbo);
    gl.deleteFramebuffer(this.resolveFbo);
    if (this.sceneTex) gl.deleteTexture(this.sceneTex);
    if (this.colorRb) gl.deleteRenderbuffer(this.colorRb);
    if (this.depthRb) gl.deleteRenderbuffer(this.depthRb);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

// LAYOUT
// wide: stipe arcs in from lower left, blades stream up-right; tall: blades stream up
function layout(aspect: number): Layout {
  const k = Math.min(1, Math.max(0, (aspect - 0.5) / 1.1));
  const mix = (a: number, b: number) => a + (b - a) * k;
  return {
    x: mix(-0.34, -0.95),
    y: mix(-1.5, -1.8),
    z: -0.1,
    a0: mix(1.5, 1.2),
    ak: mix(-0.06, -0.36),
    len: mix(2.6, 3.15),
    flow: mix(1.55, 0.6),
    fork: k < 0.4 ? -0.6 : 0.9,
    ls: mix(0.85, 1.05),
    ws: mix(0.75, 1.05),
    spread: mix(0.46, 0.58),
  };
}

const width = (s: number, w: number) =>
  w *
  Math.pow(Math.sin(Math.PI * Math.pow(s, 0.55)), 0.5) *
  (1 - 0.2 * s) *
  Math.pow(smooth(0, 0.2, s), 0.7);

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function store(
  sp: Float32Array,
  row: number,
  i: number,
  x: number,
  y: number,
  z: number,
  lx: number,
  ly: number,
  lz: number,
  nx: number,
  ny: number,
  nz: number,
) {
  let o = (row * SPINE_W + i) * 4;
  sp[o] = x;
  sp[o + 1] = y;
  sp[o + 2] = z;
  o += SPINE_W * 4;
  sp[o] = lx;
  sp[o + 1] = ly;
  sp[o + 2] = lz;
  o += SPINE_W * 4;
  sp[o] = nx;
  sp[o + 1] = ny;
  sp[o + 2] = nz;
}

// CATMULL-ROM
// clamped at the ends
function spline(a: Float32Array, base: number, n: number, q: number) {
  const j = Math.min(Math.max(q | 0, 0), n - 2);
  const t = q - j;
  const p0 = a[base + Math.max(j - 1, 0)];
  const p1 = a[base + j];
  const p2 = a[base + j + 1];
  const p3 = a[base + Math.min(j + 2, n - 1)];
  return (
    0.5 *
    (2 * p1 +
      (p2 - p0) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
      (3 * p1 - p0 - 3 * p2 + p3) * t * t * t)
  );
}

const SCR = new Float64Array(2);
function project(x: number, y: number, z: number, aspect: number) {
  const d = CAM_Z - z;
  SCR[0] = x / (d * FOV_TAN * aspect);
  SCR[1] = y / (d * FOV_TAN);
}

function perspective(m: Float32Array, aspect: number) {
  const f = 1 / FOV_TAN;
  const near = 0.1;
  const far = 20;
  m.fill(0);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
}

function grid(ns: number, nu: number, ring: boolean) {
  const v = new Float32Array((ns + 1) * (nu + 1) * 2);
  let o = 0;
  for (let j = 0; j <= ns; j++)
    for (let i = 0; i <= nu; i++) {
      v[o++] = j / ns;
      v[o++] = ring ? (i / nu) * Math.PI * 2 : -1 + (2 * i) / nu;
    }
  const idx = new Uint32Array(ns * nu * 6);
  o = 0;
  for (let j = 0; j < ns; j++)
    for (let i = 0; i < nu; i++) {
      const a = j * (nu + 1) + i;
      const b = a + nu + 1;
      idx[o++] = a;
      idx[o++] = b;
      idx[o++] = a + 1;
      idx[o++] = a + 1;
      idx[o++] = b;
      idx[o++] = b + 1;
    }
  return { v, idx };
}

function params(gl: WebGL2RenderingContext, filter: number) {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
}

// RAF
// workers without rAF fall back to a timer
const raf = (fn: (now: number) => void) =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(fn)
    : (setTimeout(() => fn(performance.now()), 16) as unknown as number);
const unraf = (id: number) =>
  typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : clearTimeout(id);

function uniforms(gl: WebGL2RenderingContext, p: WebGLProgram, names: readonly string[]) {
  const out: Record<string, WebGLUniformLocation | null> = {};
  for (const n of names) out[n] = gl.getUniformLocation(p, n);
  return out;
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
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
    gl.deleteShader(s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
  return p;
}

function software(gl: WebGL2RenderingContext) {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
  return /swiftshader|llvmpipe|software|basic render/i.test(name);
}
