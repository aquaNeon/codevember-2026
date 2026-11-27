import {
  BACKDROPS,
  CLUSTER,
  FELT,
  FLOSS,
  FRAME,
  FUZZ,
  GATHER,
  MAX_COCOONS,
  REST_SHARE,
  TURN,
  WEB,
} from "./scene";
import { FELT_FS, FELT_VS, FLOSS_VS, FULL_VS, FUZZ_VS, HAIR_FS, SILK_FS, WEB_VS } from "./shaders";

const MAX_DPR = 2;
const MAX_DT_S = 1 / 20;
const REF_AREA_PX = 1440 * 900;
const REF_PX = 0.0011;
const N = CLUSTER.length;

// MOTION
// sways as one about the gather point, lower ones lag; each twists on its silk
const SWING = { rad: 0.018, hz: 0.045, lagS: 0.7 };
const TWIST = { rad: 0.35, hz: 0.018 };
const DRIFT = 0.006;
const DIM_PER_Z = 0.5;
const Z_SPREAD = 0.35;
const WALL_Z = -0.85; // change together with WALL_Z in shaders.ts

// STRANDS
// weight per strand on the nearest cocoon
const WEIGHT = { felt: 0.3, floss: 0.7, fuzz: 0.85, web: 1.3 };
const WIDE = { felt: 0.9, floss: 0.7, fuzz: 0.65, web: 0.85 };

// LIGHT
// one slider: front-left key, round to the side, then a torch behind grazing the wall
const CLUSTER_C = [0.0, 0.05] as const;
const KEY_SWEEP = [0.85, 1.12] as const;
const KEY_LIFT = 0.42;
const BACK_POWER = 1.6;
const BACK_CONE = 0.6;
const BACK_FROM = [-0.55, 0.15] as const;
const LIGHT_TAU_S = 0.35;
const LIGHTS = ["Front", "Side", "Back"];

type Prog = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };

export class Cocoon {
  private gl: WebGL2RenderingContext;
  private progs: Prog[] = [];
  private feltP: Prog;
  private flossP: Prog;
  private fuzzP: Prog;
  private webP: Prog;
  private silkP: Prog;
  private vao: WebGLVertexArrayObject;
  private densTex: WebGLTexture | null = null;
  private densFb: WebGLFramebuffer;
  private float: boolean;
  private parallel: boolean;
  private compiled = false;

  private raf = 0;
  private last = 0;
  private visible = false;
  private sized = false;
  private drawn = false;
  private reducedMotion: boolean;
  private cleanups: (() => void)[] = [];

  // VIEW
  private css = { w: 1, h: 1, dpr: 1 };
  private res = new Float32Array(2);
  private view = new Float32Array(4);
  private frame0 = new Float32Array(4);
  private px = 0.001;
  private quality = 1;

  // CLUSTER
  // far to near. co: x, y, depth, scale; cr: cos and sin of tilt, yaw, dim
  private order = new Int32Array(MAX_COCOONS);
  private slot = new Int32Array(MAX_COCOONS);
  private depth = new Float32Array(N);
  private hero = 0;
  private bg = new Float32Array(3);
  private sweep = new Float32Array(2);
  private co = new Float32Array(4 * MAX_COCOONS);
  private cr = new Float32Array(4 * MAX_COCOONS);
  private feltRun = new Int32Array(MAX_COCOONS + 1);
  private flossRun = new Int32Array(MAX_COCOONS + 1);
  private fuzzRun = new Int32Array(MAX_COCOONS + 1);
  private webRun = new Int32Array(MAX_COCOONS + 1);
  private instW = new Float32Array(MAX_COCOONS);
  private webW = new Float32Array(MAX_COCOONS);
  private gather = new Float32Array(GATHER);

  // TURN
  private yaw = 0;
  private yawTo = 0;
  private pitch = 0;
  private pitchTo = 0;
  private spin = 0;
  private pressed = false;
  private dragX = 0;
  private dragY = 0;

  // TIME
  private t = 0;

  // LIGHT
  private torch = new Float32Array(4);
  private torchD = new Float32Array(4);
  private key = new Float32Array(3);
  private light = 1;
  private lightTo = 1;
  private reported = -1;

  onShown: () => void = () => {};
  onLost: () => void = () => {};
  onLight: (light: string) => void = () => {};

  constructor(
    private canvas: HTMLCanvasElement | OffscreenCanvas,
    reduced: boolean,
    at = 0,
    bg = 0,
  ) {
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("webgl2 unavailable");
    this.gl = gl;
    this.reducedMotion = reduced;
    this.t = Math.max(0, at);
    this.float = !!gl.getExtension("EXT_color_buffer_float");
    this.parallel = !!gl.getExtension("KHR_parallel_shader_compile");

    this.feltP = this.program(FELT_VS, FELT_FS);
    this.flossP = this.program(FLOSS_VS, HAIR_FS);
    this.fuzzP = this.program(FUZZ_VS, HAIR_FS);
    this.webP = this.program(WEB_VS, HAIR_FS);
    this.silkP = this.program(FULL_VS, SILK_FS);
    this.vao = gl.createVertexArray();
    this.densFb = gl.createFramebuffer();

    for (let i = 0; i < N; i++) this.order[i] = i;
    const hex = BACKDROPS[Math.min(BACKDROPS.length - 1, Math.max(0, bg | 0))];
    const c = parseInt(hex.slice(1), 16);
    this.bg[0] = Math.pow(((c >> 16) & 255) / 255, 2.2);
    this.bg[1] = Math.pow(((c >> 8) & 255) / 255, 2.2);
    this.bg[2] = Math.pow((c & 255) / 255, 2.2);
    // WEB RUN
    // owned by no cocoon, so one run that never ends
    this.webRun.fill(1 << 30);
    this.webRun[0] = 0;
    this.webW[0] = 1;

    const onLost = (e: Event) => {
      e.preventDefault();
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.onLost();
    };
    canvas.addEventListener("webglcontextlost", onLost);
    this.cleanups.push(() => canvas.removeEventListener("webglcontextlost", onLost));
  }

  // PUBLIC
  size(width: number, height: number, dpr: number) {
    this.css.w = width || 1;
    this.css.h = height || 1;
    this.css.dpr = Math.min(dpr || 1, MAX_DPR);
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

  // ANGLE
  // 0 front key, 1 torch behind; eased
  angle(v: number) {
    this.lightTo = Math.min(1, Math.max(0, v));
    this.wake();
  }

  down(x: number, y: number) {
    this.pressed = true;
    this.dragX = x;
    this.dragY = y;
    this.spin = 0;
    this.wake();
  }

  move(x: number, y: number) {
    if (!this.pressed) return;
    const dx = (x - this.dragX) * TURN.radPerPx;
    const dy = (y - this.dragY) * TURN.radPerPx;
    this.yawTo = clamp(this.yawTo + dx, TURN.yawRad);
    this.pitchTo = clamp(this.pitchTo + dy * 0.4, TURN.pitchRad);
    // FLING
    // running velocity estimate for the glide after release
    this.spin = this.spin * 0.6 + dx * 0.4 * 60;
    this.dragX = x;
    this.dragY = y;
    this.wake();
  }

  up() {
    this.pressed = false;
    this.wake();
  }

  leave() {
    this.pressed = false;
  }

  // GL SETUP
  private program(vs: string, fs: string): Prog {
    const gl = this.gl;
    const p = gl.createProgram();
    for (const [type, src] of [
      [gl.VERTEX_SHADER, vs],
      [gl.FRAGMENT_SHADER, fs],
    ] as const) {
      const s = gl.createShader(type);
      if (!s) throw new Error("shader");
      gl.shaderSource(s, src);
      gl.compileShader(s);
      gl.attachShader(p, s);
      gl.deleteShader(s);
    }
    gl.linkProgram(p);
    const prog = { p, u: {} };
    this.progs.push(prog);
    return prog;
  }

  private link() {
    const gl = this.gl;
    for (const { p, u } of this.progs) {
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
      }
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
      for (let i = 0; i < n; i++) {
        const info = gl.getActiveUniform(p, i);
        if (info) u[info.name] = gl.getUniformLocation(p, info.name);
      }
    }
    gl.useProgram(this.silkP.p);
    gl.uniform1i(this.silkP.u.uDens, 0);
    this.compiled = true;
  }

  private ready() {
    if (this.compiled) return true;
    if (this.parallel) {
      const done = 0x91b1; // COMPLETION_STATUS_KHR
      for (const { p } of this.progs) if (!this.gl.getProgramParameter(p, done)) return false;
    }
    this.link();
    return true;
  }

  // POSE
  private pose(dt: number) {
    const t = this.t;
    const rm = this.reducedMotion;
    const f = this.frame0;
    const v = this.view;
    const d = rm ? 0 : DRIFT;
    v[0] = f[0] + d * Math.sin(t * 0.07);
    v[1] = f[1] + d * Math.sin(t * 0.053 + 1.3);
    v[2] = f[2];
    v[3] = f[3];

    // TURN
    // eased toward the drag target; a fling glides on and settles
    if (!this.pressed && !rm) {
      this.yawTo = clamp(this.yawTo + this.spin * dt, TURN.yawRad);
      this.spin *= Math.exp(-dt / TURN.glideS);
      if (Math.abs(this.yawTo) >= TURN.yawRad) this.spin = 0;
    }
    const ke = rm ? 1 : 1 - Math.exp(-dt / TURN.tauS);
    this.yaw += (this.yawTo - this.yaw) * ke;
    this.pitch += (this.pitchTo - this.pitch) * ke;
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    // DEPTH
    // pivot at mid depth; depth values drive dim, Z_SPREAD of them the real z
    const mz = -0.55;
    // WALL CLEARANCE
    // far enough off the wall that turning never crosses it or the back torch
    const zc = -0.42;
    for (let i = 0; i < N; i++) {
      const c = CLUSTER[i];
      const z = (c[2] - mz) * Z_SPREAD;
      this.depth[i] = zc - c[0] * sy * cp + z * cy * cp + (c[1] - CLUSTER_C[1]) * sp;
    }
    // SORT
    // insertion sort far to near, in place
    for (let i = 1; i < N; i++) {
      const v = this.order[i];
      let j = i - 1;
      while (j >= 0 && this.depth[this.order[j]] > this.depth[v]) {
        this.order[j + 1] = this.order[j];
        j--;
      }
      this.order[j + 1] = v;
    }
    for (let k = 0; k < N; k++) this.slot[this.order[k]] = k;
    this.hero = N - 1;
    for (let k = 0; k < N; k++) if (this.order[k] === 0) this.hero = k;
    if (this.runsDirty()) this.budget();

    // CLUSTER
    const gx = GATHER[0];
    const gy = GATHER[1];
    for (let k = 0; k < N; k++) {
      const i = this.order[k];
      const c = CLUSTER[i];
      const z = (c[2] - mz) * Z_SPREAD;
      const x = c[0] * cy + z * sy;
      const y = CLUSTER_C[1] + (c[1] - CLUSTER_C[1]) * cp - (z * cy - c[0] * sy) * sp;
      const lag = (gy - c[1]) * SWING.lagS;
      const sw = rm ? 0 : SWING.rad * Math.sin((t - lag) * SWING.hz * Math.PI * 2);
      const cs = Math.cos(sw);
      const sn = Math.sin(sw);
      const dx = x - gx;
      const dy = y - gy;
      const o = k * 4;
      this.co[o] = gx + cs * dx - sn * dy;
      this.co[o + 1] = gy + sn * dx + cs * dy;
      const depth = this.depth[i];
      this.co[o + 2] = depth;
      const seen = mz + (depth - zc) / Z_SPREAD;
      this.co[o + 3] = c[3] * (1 + 0.12 * (seen - c[2]));
      // LEAN
      // projected tilt shortens side-on; each turns on its own axis too
      const tilt = Math.atan(Math.tan(c[4]) * Math.abs(cy)) + sw;
      this.cr[o] = Math.cos(tilt);
      this.cr[o + 1] = Math.sin(tilt);
      this.cr[o + 2] =
        c[5] + this.yaw + (rm ? 0 : TWIST.rad * Math.sin(t * TWIST.hz * Math.PI * 2 + c[5]));
      this.cr[o + 3] = Math.exp(Math.min(0, seen) * DIM_PER_Z);
    }

    // LIGHT
    this.light += (this.lightTo - this.light) * (rm ? 1 : 1 - Math.exp(-dt / LIGHT_TAU_S));
    const L = this.light;
    const th = KEY_SWEEP[0] + (KEY_SWEEP[1] - KEY_SWEEP[0]) * smooth(0, 0.65, L);
    const kx = -Math.sin(th);
    const kz = Math.cos(th);
    const kl = Math.hypot(kx, KEY_LIFT, kz);
    const back = smooth(0.5, 1, L);
    const kd = 1 - 0.75 * back;
    this.key[0] = (kx / kl) * kd;
    this.key[1] = (KEY_LIFT / kl) * kd;
    this.key[2] = (kz / kl) * kd;

    // BACK TORCH
    // just off the wall on the left, aimed back through the cluster
    const tr = this.torch;
    tr[0] = CLUSTER_C[0] + BACK_FROM[0];
    tr[1] = CLUSTER_C[1] + BACK_FROM[1];
    tr[2] = WALL_Z + 0.12;
    tr[3] = BACK_POWER * back;
    let fx = CLUSTER_C[0] + 0.1 - tr[0];
    let fy = CLUSTER_C[1] - tr[1];
    let fz = -0.45 - tr[2];
    const n = Math.hypot(fx, fy, fz);
    fx /= n;
    fy /= n;
    fz /= n;
    const td = this.torchD;
    td[0] = fx;
    td[1] = fy;
    td[2] = fz;
    td[3] = BACK_CONE;
  }

  // LOOP
  // runs only while shown; reduced motion draws once per change
  private wake() {
    if (!this.raf && this.visible) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.visible) return;
    if (!this.ready()) {
      this.wake();
      return;
    }
    const rm = this.reducedMotion;
    const dt = this.last && !rm ? Math.min(MAX_DT_S, Math.max(0, now - this.last) / 1000) : 0;
    this.last = now;
    if (!this.sized) this.resize();
    this.t += dt;
    this.pose(dt);
    this.draw();
    this.report();
    if (!this.drawn) {
      this.drawn = true;
      this.onShown();
    }
    if (!rm) this.wake();
    else this.last = 0;
  };

  private report() {
    const k = this.lightTo < 0.34 ? 0 : this.lightTo < 0.67 ? 1 : 2;
    if (k === this.reported) return;
    this.reported = k;
    this.onLight(LIGHTS[k]);
  }

  // DRAW
  private draw() {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);

    // DENSITY
    // additive coverage: felt in r and a, hair lit and unlit in g and b; one draw per kind
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.densFb);
    gl.viewport(0, 0, this.res[0], this.res[1]);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    const out = this.float ? 1 : 1 / 8;
    const q = this.quality;

    this.strands(this.feltP, out, this.feltRun, this.instW, WEIGHT.felt / q, WIDE.felt, FELT.seg);
    this.strands(
      this.flossP,
      out,
      this.flossRun,
      this.instW,
      WEIGHT.floss / q,
      WIDE.floss,
      FLOSS.seg,
    );
    this.strands(this.fuzzP, out, this.fuzzRun, this.instW, WEIGHT.fuzz / q, WIDE.fuzz, FUZZ.seg);
    const we = this.webP;
    this.webRun[0] = 0;
    gl.useProgram(we.p);
    gl.uniform2fv(we.u.uGather, this.gather);
    this.strands(we, out, this.webRun, this.webW, WEIGHT.web, WIDE.web, WEB.seg, 1, WEB.count);
    gl.disable(gl.BLEND);

    // SILK
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const si = this.silkP;
    gl.useProgram(si.p);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.densTex);
    this.scene(si);
    gl.uniform2fv(si.u.uRes, this.res);
    gl.uniform3fv(si.u.uBg, this.bg);
    this.sweep[0] = CLUSTER_C[0];
    this.sweep[1] = CLUSTER_C[1] + 0.15;
    gl.uniform2fv(si.u.uSweep, this.sweep);
    gl.uniform1f(si.u.uPx, this.px);
    // DENSITY SCALE
    // normalised by world per pixel so the look holds at any size
    gl.uniform1f(si.u.uDensK, (1 / out) * (REF_PX / this.px));
    gl.uniform1f(si.u.uSeed, this.reducedMotion ? 0 : (this.t * 60) % 997);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  private scene(pr: Prog) {
    const gl = this.gl;
    gl.uniform4fv(pr.u.uView, this.view);
    gl.uniform1i(pr.u.uN, N);
    gl.uniform4fv(pr.u["uCo[0]"], this.co);
    gl.uniform4fv(pr.u["uCr[0]"], this.cr);
    gl.uniform3fv(pr.u.uKeyW, this.key);
    gl.uniform4fv(pr.u.uTorchW, this.torch);
    gl.uniform4fv(pr.u.uTorchDW, this.torchD);
    gl.uniform1i(pr.u.uHero, this.hero);
    gl.uniform1iv(pr.u["uId[0]"], this.order);
    gl.uniform1iv(pr.u["uSlot[0]"], this.slot);
  }

  private strands(
    pr: Prog,
    out: number,
    run: Int32Array,
    w: Float32Array,
    weight: number,
    wide: number,
    seg: number,
    spark = 0,
    count = run[N],
  ) {
    const gl = this.gl;
    gl.useProgram(pr.p);
    this.scene(pr);
    gl.uniform1f(pr.u.uPx, this.px);
    gl.uniform1f(pr.u.uOut, out);
    gl.uniform1f(pr.u.uTime, this.reducedMotion ? 0 : this.t);
    gl.uniform1f(pr.u.uSpark, spark);
    gl.uniform1iv(pr.u["uStart[0]"], run);
    gl.uniform1fv(pr.u["uInstW[0]"], w);
    gl.uniform1f(pr.u.uWeight, weight);
    gl.uniform1f(pr.u.uWide, wide);
    gl.uniform1i(pr.u.uSeg, seg);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, count * (2 * seg + 4));
  }

  // BUDGET
  // nearest gets the full count, the rest share REST_SHARE by area; weight compensates
  private runsFor = new Int32Array(N).fill(-1);

  private runsDirty() {
    for (let k = 0; k < N; k++) if (this.runsFor[k] !== this.order[k]) return true;
    return false;
  }

  private budget() {
    this.runsFor.set(this.order.subarray(0, N));
    const q = this.quality;
    const hero = CLUSTER[0][3];
    let rest = 0;
    for (let i = 1; i < N; i++) rest += CLUSTER[i][3] ** 2;
    const share = (i: number) => (i === 0 ? 1 : (REST_SHARE * CLUSTER[i][3] ** 2) / rest);
    for (let k = 0; k < N; k++) {
      const i = this.order[k];
      this.instW[k] = Math.min(3, (CLUSTER[i][3] / hero) ** 2 / share(i));
    }
    const runs: [Int32Array, number][] = [
      [this.feltRun, FELT.count],
      [this.flossRun, FLOSS.count],
      [this.fuzzRun, FUZZ.count],
    ];
    for (const [run, count] of runs) {
      run[0] = 0;
      for (let k = 0; k < N; k++)
        run[k + 1] = run[k] + Math.round(count * q * share(this.order[k]));
      for (let k = N + 1; k <= MAX_COCOONS; k++) run[k] = run[N];
    }
  }

  // RESIZE
  // frame the cluster, and size the density target to the canvas
  private resize() {
    const gl = this.gl;
    const { w, h, dpr } = this.css;
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    this.res[0] = pw;
    this.res[1] = ph;
    const aspect = w / h;
    const f = this.frame0;
    const hy = Math.max(FRAME.wide, FRAME.tall / aspect);
    f[0] = aspect < 0.9 ? 0 : FRAME.cx;
    f[1] = aspect < 0.9 ? FRAME.tallCy : FRAME.cy;
    f[2] = hy * aspect;
    f[3] = hy;
    this.px = (2 * hy) / ph;
    this.quality = Math.min(1, Math.max(0.45, Math.sqrt((w * h) / REF_AREA_PX)));
    this.budget();

    if (this.densTex) gl.deleteTexture(this.densTex);
    this.densTex = this.target(pw, ph, this.float);
    if (!this.densTex && this.float) {
      this.float = false;
      this.densTex = this.target(pw, ph, false);
    }
    this.sized = true;
  }

  private target(pw: number, ph: number, float: boolean) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, pw, ph, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, pw, ph, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.densFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (ok) return tex;
    gl.deleteTexture(tex);
    return null;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.cleanups.forEach((fn) => fn());
    this.cleanups.length = 0;
    const gl = this.gl;
    this.progs.forEach(({ p }) => gl.deleteProgram(p));
    this.progs.length = 0;
    gl.deleteVertexArray(this.vao);
    gl.deleteTexture(this.densTex);
    gl.deleteFramebuffer(this.densFb);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

function clamp(x: number, m: number) {
  return Math.max(-m, Math.min(m, x));
}

function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
