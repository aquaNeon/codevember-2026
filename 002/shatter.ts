import { dust, DUST_STRIDE, part, rng, smoke, SMOKE_STRIDE } from "./dust";
import {
  DROP,
  DUST,
  END_S,
  FRONT_UPS,
  KEY,
  MEND_AFTER_MS,
  MEND_RATE,
  phys,
  SLOW,
  TIP_X,
  VIEW,
} from "./scene";
import { DROP_FS, DUST_FS, DUST_VS, FULL_VS, SMOKE_FS, SMOKE_VS } from "./shaders";

const MAX_DPR = 2;
const MAX_DT_S = 1 / 20;
const NEAR_M = 0.1;
const FAR_M = 80;
const TAP_MEND_RATE = 1.6;
const TINK_S = 0.5;
const POL_TAU_S = 0.35;
const SEED = 11;
// SNAP
// only the thin tail snaps; bulb and neck shrug off a blow
const SNAP_X = TIP_X + 3.0; // change default snap point here
const SNAP_MAX_X = DROP.JOIN_X - 0.45 * DROP.TAIL_U;
const TIP_ZONE_U = 0.7;
const YAW = (DROP.YAW_DEG * Math.PI) / 180;

export type Phase = "whole" | "breaking" | "held" | "mending";
const PHASES: Phase[] = ["whole", "breaking", "held", "mending"];

type Prog = { p: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };

const v3 = new Float32Array(3);

export class Shatter {
  onShown: () => void = () => {};
  onLost: () => void = () => {};
  onState: (
    time: number,
    real: number,
    pieces: number,
    phase: Phase,
    over: boolean,
    dur: number,
  ) => void = () => {};

  private gl: WebGL2RenderingContext;
  private drop: Prog;
  private dustP: Prog;
  private emptyVao: WebGLVertexArrayObject;
  private dustVao: WebGLVertexArrayObject;
  private dustBuf: WebGLBuffer;
  private dustN: number;
  private smokeP: Prog;
  private smokeVao: WebGLVertexArrayObject;
  private smokeBuf: WebGLBuffer;
  private smokeN: number;

  private raf = 0;
  private last = 0;
  private visible = false;
  private sized = false;
  private shown = false;
  private cleanups: (() => void)[] = [];

  // VIEW
  private css = { w: 1, h: 1, dpr: 1 };
  private eye = new Float32Array(3);
  private fwd = new Float32Array(3);
  private right = new Float32Array(3);
  private up = new Float32Array(3);
  private tan = new Float32Array(2);
  private res = new Float32Array(2);
  private viewProj = new Float32Array(16);
  private px = 1;
  private cross = new Float32Array(2);

  // LIGHT
  private key = new Float32Array(KEY.dir);
  private swayX = 0;
  private swayZ = 0;
  private swayToX = 0;
  private swayToZ = 0;
  private pol = 0;
  private polTo = 0;
  private tink = 0;

  // TIME
  private broken = false;
  private snap = SNAP_X;
  private t = 0;
  private rate = 0;
  private held = false;
  private mendTimer = 0;
  private over = false;
  private reported = -1;

  constructor(
    private canvas: HTMLCanvasElement | OffscreenCanvas,
    private reduced: boolean,
    at = -1,
  ) {
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: "high-performance",
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("webgl2 unavailable");
    // SOFTWARE GL
    // a cpu renderer would take seconds a frame; the page shows the still instead
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
    if (/swiftshader|llvmpipe|software|basic render/i.test(name)) {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      throw new Error("software gl");
    }
    this.gl = gl;
    this.drop = this.program(FULL_VS, DROP_FS);
    this.dustP = this.program(DUST_VS, DUST_FS);
    this.smokeP = this.program(SMOKE_VS, SMOKE_FS);
    this.emptyVao = gl.createVertexArray();

    // POWDER
    const data = dust(rng(SEED));
    this.dustN = data.length / DUST_STRIDE;
    this.dustVao = gl.createVertexArray();
    this.dustBuf = gl.createBuffer();
    gl.bindVertexArray(this.dustVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dustBuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    let off = 0;
    [3, 3, 1, 1, 1, 1, 1].forEach((size, loc) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, DUST_STRIDE * 4, off * 4);
      off += size;
    });
    gl.bindVertexArray(null);

    // SMOKE
    const fume = smoke(rng(SEED + 1));
    this.smokeN = fume.length / SMOKE_STRIDE;
    this.smokeVao = gl.createVertexArray();
    this.smokeBuf = gl.createBuffer();
    gl.bindVertexArray(this.smokeVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.smokeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, fume, gl.STATIC_DRAW);
    off = 0;
    [3, 3, 1, 1, 1].forEach((size, loc) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, SMOKE_STRIDE * 4, off * 4);
      off += size;
    });
    gl.bindVertexArray(null);

    const onLost = (e: Event) => {
      e.preventDefault();
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      this.onLost();
    };
    canvas.addEventListener("webglcontextlost", onLost);
    this.cleanups.push(() => canvas.removeEventListener("webglcontextlost", onLost));

    if (at >= 0) {
      this.held = true;
      this.broken = true;
      this.t = Math.min(at, END_S);
    }
  }

  // PUBLIC
  size(w: number, h: number, dpr: number) {
    this.css.w = w || 1;
    this.css.h = h || 1;
    this.css.dpr = Math.min(dpr || 1, MAX_DPR);
    this.sized = false;
    this.wake();
  }

  show(v: boolean) {
    this.visible = v;
    this.last = 0;
    this.wake();
  }

  motion(reduced: boolean) {
    this.reduced = reduced;
  }

  // POLARISCOPE
  // photoelastic fringes from residual stress; the studio goes dark
  polarise(on: boolean) {
    this.polTo = on ? 1 : 0;
    if (this.reduced) this.pol = this.polTo;
    this.wake();
  }

  tap(x: number, y: number) {
    this.held = false;
    const phase = this.phase();
    const what = this.pick(x, y);
    if (phase === "whole") {
      if (what === 2 && v3[0] <= SNAP_MAX_X) this.snapAt(v3[0]);
      else if (what) {
        this.tink = this.reduced ? 0 : 1;
        this.wake();
      }
    } else if (phase === "mending") this.play(1);
    else this.play(-TAP_MEND_RATE);
  }

  hover(x: number, y: number) {
    this.swayToX = (x / this.css.w - 0.5) * 2 * KEY.sway;
    this.swayToZ = (y / this.css.h - 0.5) * 2 * KEY.sway;
    const over = this.phase() !== "whole" || (this.pick(x, y) === 2 && v3[0] <= SNAP_MAX_X);
    if (over !== this.over) {
      this.over = over;
      this.report();
    }
    this.wake();
  }

  leave() {
    this.swayToX = 0;
    this.swayToZ = 0;
    this.wake();
  }

  nudge(s: number) {
    this.seek(this.t + s, s > 0);
  }

  seek(s: number, snaps = s > 0) {
    if (!this.broken) {
      if (!snaps) return;
      this.broken = true;
      this.snap = SNAP_X;
    }
    this.t = Math.min(Math.max(s, 0), END_S);
    if (this.t <= 0) this.broken = false;
    this.rate = 0;
    this.later();
    this.wake();
  }

  go() {
    if (this.phase() === "whole") this.snapAt(SNAP_X);
    else this.play(-TAP_MEND_RATE);
  }

  // TIME
  private phase(): Phase {
    if (this.rate > 0) return "breaking";
    if (this.rate < 0) return "mending";
    return this.broken && this.t > 0 ? "held" : "whole";
  }

  private snapAt(lx: number) {
    this.snap = lx < TIP_X + TIP_ZONE_U ? TIP_X + 0.08 : lx;
    this.broken = true;
    this.t = 0;
    this.play(1);
  }

  private play(rate: number) {
    clearTimeout(this.mendTimer);
    if (!this.broken) return;
    if (this.reduced) {
      this.t = rate > 0 ? END_S : 0;
      this.rate = 0;
      if (rate > 0) this.later();
      else this.broken = false;
    } else this.rate = rate;
    this.wake();
  }

  private later() {
    clearTimeout(this.mendTimer);
    if (this.held || this.t <= 0) return;
    this.mendTimer = setTimeout(() => this.play(-MEND_RATE), MEND_AFTER_MS) as unknown as number;
  }

  // PICKING
  // 1 bulb, 2 tail, 0 none; local x into v3
  private pick(x: number, y: number) {
    const nx = (x / this.css.w) * 2 - 1;
    const ny = 1 - (y / this.css.h) * 2;
    const e = this.eye;
    let dx = this.fwd[0] + nx * this.tan[0] * this.right[0] + ny * this.tan[1] * this.up[0];
    let dy = this.fwd[1] + nx * this.tan[0] * this.right[1] + ny * this.tan[1] * this.up[1];
    let dz = this.fwd[2] + nx * this.tan[0] * this.right[2] + ny * this.tan[1] * this.up[2];
    const l = Math.hypot(dx, dy, dz);
    dx /= l;
    dy /= l;
    dz /= l;
    const c = Math.cos(YAW);
    const s = Math.sin(YAW);
    for (let t = 0; t < 30; t += 0.03) {
      const wx = e[0] + dx * t - DROP.AT[0];
      const wy = e[1] + dy * t - 1;
      const wz = e[2] + dz * t - DROP.AT[2];
      if (wy < -1.05) break;
      const lx = c * wx + s * wz;
      const lz = -s * wx + c * wz;
      const what = part(lx, wy, lz);
      if (what) {
        v3[0] = lx;
        return what;
      }
    }
    return 0;
  }

  // LOOP
  // visible = on screen and tab shown; the loop also stops once all is still
  private wake() {
    if (!this.raf && this.visible) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.visible) return;
    const dt = this.last ? Math.min(MAX_DT_S, Math.max(0, now - this.last) / 1000) : 1 / 60;
    this.last = now;
    if (!this.sized) this.resize();
    let busy = false;
    if (this.rate !== 0) {
      const quick = this.t < SLOW.runS ? SLOW.runS / SLOW.playRunS : 1;
      this.t += dt * this.rate * quick;
      busy = true;
      if (this.t >= END_S) {
        this.t = END_S;
        this.rate = 0;
        this.later();
      } else if (this.t <= 0) {
        this.t = 0;
        this.rate = 0;
        this.broken = false;
      }
    }
    // LIGHT
    // softbox eases toward the pointer sway
    const k = this.reduced ? 1 : 1 - Math.exp(-dt / KEY.tauS);
    this.swayX += (this.swayToX - this.swayX) * k;
    this.swayZ += (this.swayToZ - this.swayZ) * k;
    const kp = this.reduced ? 1 : 1 - Math.exp(-dt / POL_TAU_S);
    this.pol += (this.polTo - this.pol) * kp;
    if (this.tink > 0) this.tink = Math.max(0, this.tink - dt / TINK_S);
    busy ||=
      Math.abs(this.swayToX - this.swayX) > 1e-3 ||
      Math.abs(this.swayToZ - this.swayZ) > 1e-3 ||
      Math.abs(this.polTo - this.pol) > 1e-3 ||
      this.tink > 0;
    const kx = KEY.dir[0] + this.swayX;
    const ky = KEY.dir[1];
    const kz = KEY.dir[2] + this.swayZ;
    const kl = Math.hypot(kx, ky, kz);
    this.key[0] = kx / kl;
    this.key[1] = ky / kl;
    this.key[2] = kz / kl;

    this.draw();
    this.report();
    if (!this.shown) {
      this.shown = true;
      this.onShown();
    }
    if (busy) this.wake();
    else this.last = 0;
  };

  private report() {
    const phase = this.phase();
    const cs = Math.round(this.t * 1000);
    const key = cs * 8 + PHASES.indexOf(phase) * 2 + (this.over ? 1 : 0);
    if (key === this.reported) return;
    this.reported = key;
    const real = this.broken ? phys(this.t, this.endUs()) : 0;
    const pieces = this.broken && this.t > SLOW.runS ? DUST.fine + DUST.chips : 1;
    this.onState(this.t, real, pieces, phase, this.over, END_S);
  }

  private endUs() {
    return (DROP.STRETCH - this.snap) / FRONT_UPS;
  }

  // DRAW
  private draw() {
    const gl = this.gl;
    const tp = this.broken ? phys(this.t, this.endUs()) : 0;
    const end = this.endUs() * 1e-6;
    const front = this.broken ? tp * 1e6 * FRONT_UPS : 0;
    const here = this.broken ? 1 - smooth((tp - end) / 0.004) : 1;
    const milk = this.broken ? smooth((tp - end * 0.85) / (end * 0.15)) : 0;
    gl.viewport(0, 0, this.res[0], this.res[1]);

    let pr = this.drop;
    gl.useProgram(pr.p);
    gl.uniform3fv(pr.u.uEye, this.eye);
    gl.uniform3fv(pr.u.uRight, this.right);
    gl.uniform3fv(pr.u.uUp, this.up);
    gl.uniform3fv(pr.u.uFwd, this.fwd);
    gl.uniform2fv(pr.u.uTan, this.tan);
    gl.uniform2fv(pr.u.uRes, this.res);
    gl.uniform2fv(pr.u.uCross, this.cross);
    gl.uniform3fv(pr.u.uKey, this.key);
    gl.uniform1f(pr.u.uHere, here);
    gl.uniform1f(pr.u.uPol, this.pol);
    gl.uniform1i(pr.u.uOne, 1);
    gl.uniform1f(pr.u.uSnap, this.snap);
    gl.uniform1f(pr.u.uFront, front);
    gl.uniform1f(pr.u.uMilk, milk);
    gl.uniform1f(pr.u.uTink, this.tink * this.tink);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // SMOKE
    if (this.broken && tp > end) {
      pr = this.smokeP;
      gl.useProgram(pr.p);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniformMatrix4fv(pr.u.uViewProj, false, this.viewProj);
      gl.uniform3fv(pr.u.uEye, this.eye);
      gl.uniform3fv(pr.u.uKey, this.key);
      gl.uniform1f(pr.u.uT, tp - end);
      gl.uniform1f(pr.u.uPx, this.px);
      gl.uniform1f(pr.u.uPol, this.pol);
      gl.bindVertexArray(this.smokeVao);
      gl.drawArrays(gl.POINTS, 0, this.smokeN);
      gl.disable(gl.BLEND);
    }

    // POWDER AND SPARKS
    if (this.broken) {
      pr = this.dustP;
      gl.useProgram(pr.p);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniformMatrix4fv(pr.u.uViewProj, false, this.viewProj);
      gl.uniform3fv(pr.u.uEye, this.eye);
      gl.uniform3fv(pr.u.uKey, this.key);
      gl.uniform1f(pr.u.uT, tp);
      gl.uniform1f(pr.u.uSnap, this.snap);
      gl.uniform1f(pr.u.uPx, this.px);
      gl.uniform1f(pr.u.uHere, here);
      gl.uniform1f(pr.u.uPol, this.pol);
      gl.bindVertexArray(this.dustVao);
      gl.drawArrays(gl.POINTS, 0, this.dustN);
      gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);
  }

  // RESIZE
  // resizing clears the canvas, so it only happens right before a draw
  private resize() {
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
    const k = Math.min(
      Math.max((aspect - VIEW.tallAspect) / (VIEW.wideAspect - VIEW.tallAspect), 0),
      1,
    );
    const at = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      this.eye[i] = VIEW.tall.eye[i] + (VIEW.wide.eye[i] - VIEW.tall.eye[i]) * k;
      at[i] = VIEW.tall.at[i] + (VIEW.wide.at[i] - VIEW.tall.at[i]) * k;
    }
    const fov = ((VIEW.tall.fovDeg + (VIEW.wide.fovDeg - VIEW.tall.fovDeg) * k) * Math.PI) / 180;
    const e = this.eye;
    const f = norm(this.fwd, at[0] - e[0], at[1] - e[1], at[2] - e[2]);
    const r = norm(this.right, -f[2], 0, f[0]);
    norm(this.up, r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]);
    const u = this.up;
    this.tan[1] = Math.tan(fov / 2);
    this.tan[0] = this.tan[1] * aspect;
    this.px = ph / (2 * this.tan[1]);

    // VIEW PROJECTION
    // column major
    const py = 1 / this.tan[1];
    const px = py / aspect;
    const a = (FAR_M + NEAR_M) / (NEAR_M - FAR_M);
    const b = (2 * FAR_M * NEAR_M) / (NEAR_M - FAR_M);
    const m = this.viewProj;
    const tr = -(r[0] * e[0] + r[1] * e[1] + r[2] * e[2]);
    const tu = -(u[0] * e[0] + u[1] * e[1] + u[2] * e[2]);
    const tf = f[0] * e[0] + f[1] * e[1] + f[2] * e[2];
    for (let i = 0; i < 3; i++) {
      m[i * 4] = px * r[i];
      m[i * 4 + 1] = py * u[i];
      m[i * 4 + 2] = -a * f[i];
      m[i * 4 + 3] = f[i];
    }
    m[12] = px * tr;
    m[13] = py * tu;
    m[14] = a * tf + b;
    m[15] = -tf;
    // POLARISCOPE CROSS
    const bx = DROP.AT[0];
    const bz = DROP.AT[2];
    const cw = m[3] * bx + m[7] + m[11] * bz + m[15];
    this.cross[0] = (((m[0] * bx + m[4] + m[8] * bz + m[12]) / cw) * 0.5 + 0.5) * pw;
    this.cross[1] = (((m[1] * bx + m[5] + m[9] * bz + m[13]) / cw) * 0.5 + 0.5) * ph;
    this.sized = true;
  }

  // GL
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
      if (import.meta.env.DEV && !gl.getShaderParameter(s, gl.COMPILE_STATUS))
        console.error(gl.getShaderInfoLog(s));
      gl.attachShader(p, s);
      gl.deleteShader(s);
    }
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(p) ?? "link");
    const u: Prog["u"] = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      if (info) u[info.name] = gl.getUniformLocation(p, info.name);
    }
    return { p, u };
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    clearTimeout(this.mendTimer);
    this.cleanups.forEach((fn) => fn());
    this.cleanups.length = 0;
    const gl = this.gl;
    gl.deleteProgram(this.drop.p);
    gl.deleteProgram(this.dustP.p);
    gl.deleteProgram(this.smokeP.p);
    gl.deleteVertexArray(this.smokeVao);
    gl.deleteBuffer(this.smokeBuf);
    gl.deleteVertexArray(this.emptyVao);
    gl.deleteVertexArray(this.dustVao);
    gl.deleteBuffer(this.dustBuf);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

function smooth(x: number) {
  const u = Math.min(Math.max(x, 0), 1);
  return u * u * (3 - 2 * u);
}

function norm(out: Float32Array, x: number, y: number, z: number) {
  const l = Math.hypot(x, y, z) || 1;
  out[0] = x / l;
  out[1] = y / l;
  out[2] = z / l;
  return out;
}
