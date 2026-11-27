import { busy, finish, pass, raf, software, unraf, type Opts, type Pass } from "./gl";
import { BUBBLES, FULL_VS, MAGMA_FS, MAT_SCALE, SCARS, SPLASH } from "./shaders";

export type Hud = {
  temp: number;
  seams: number;
  bursts: number;
  over: boolean;
};

const MAX_DPR = 2;
const MAX_DT_S = 0.05;
const LOOP_S = 48;
const SPIN_S = 96;
const PITCH_RAD = 0.3;
const PITCH_MAX_RAD = 0.95;
const SPIN_TAU_S = 1.4;
const HEAT_TAU_S = 0.5;
const PHONE_PX = 640;
const TURN_PX = 6;
const HUD_MS = 250;
const SCALE_MIN = 0.45;
const SCALE_MAX = 1;
const SCALE_START = 0.75;
const SLOW_MS = 21;
const FAST_MS = 17.5;
const PROBE_N = 40;
const CAM_Z = 5;
// MARCH
// 23 steps, 5 halvings, 4 normal taps, the hit; keep in sync with shaders.ts
const MARCH_ITER = 34;

// BUBBLES
// each slot swells, bursts and skins over a whole number of times per loop
const CYCLES = [4, 3, 5, 4, 3, 5];
const LIFE = 0.72;
const OFFSET = [0.05, 0.4, 0.22, 0.71, 0.88, 0.55];
const KEEP = 3;
const SCAR_CYCLES = 2.2;

export class Magma {
  onHud: (h: Hud) => void = () => {};
  onShown: () => void = () => {};

  private gl: WebGL2RenderingContext;
  private p: Pass;
  private vao: WebGLVertexArrayObject;
  private parallel: boolean;
  private linked = false;
  private raf = 0;
  private dead = false;
  private visible = false;
  private reduced: boolean;
  private drawn = false;
  private dirty = true;
  private sized = false;
  private last = 0;
  private t = 0;

  private cssW = 1;
  private cssH = 1;
  private dpr = 1;
  private scale = SCALE_START;
  private k = 1;
  private probeMs = 0;
  private probeN = 0;
  private tunes = 0;

  // VIEW
  private cx = 0;
  private cy = 0;
  private rad = 1;
  private yaw = 0.6;
  private pitch = PITCH_RAD;
  private vYaw = 0;
  private vPitch = 0;
  private dragging = false;
  private turned = false;
  private downX = 0;
  private downY = 0;
  private px = 0;
  private py = 0;

  // HEAT
  private hover = false;
  private onSphere = false;
  private heat = 0;
  private hx = 0;
  private hy = 0;
  private hz = 1;

  private rot = new Float32Array(9);
  // UNIFORMS
  // live bubbles, then scars with w = 2 + age, as the shader reads them
  private bub = new Float32Array((BUBBLES + SCARS) * 4);
  private cyc = new Int32Array(BUBBLES).fill(-1);
  private sites = new Float32Array(BUBBLES * KEEP * 3);
  private siteC = new Int32Array(BUBBLES * KEEP).fill(-0x7fffffff);
  private scarN = 0;
  private spotObj = new Float32Array(BUBBLES * 4);
  private bursts = 0;
  private hudAt = -1e9;

  constructor(
    private canvas: HTMLCanvasElement | OffscreenCanvas,
    opts: Opts,
  ) {
    this.reduced = opts.reducedMotion;
    this.t = opts.at > 0 ? opts.at : 0;
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
    this.parallel = !!gl.getExtension("KHR_parallel_shader_compile");
    this.p = pass(gl, FULL_VS, MAGMA_FS);
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("no vao");
    this.vao = vao;
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
    this.dirty = true;
    this.wake();
  }

  // INPUT
  // drag spins with inertia; hover heats the crust under the pointer
  press(x: number, y: number) {
    this.dragging = true;
    this.turned = false;
    this.downX = x;
    this.downY = y;
    this.px = x;
    this.py = y;
    this.vYaw = 0;
    this.vPitch = 0;
    this.aim(x, y);
  }

  move(x: number, y: number, dtMs: number) {
    if (this.dragging && !this.turned && Math.hypot(x - this.downX, y - this.downY) > TURN_PX) {
      this.turned = true;
    }
    if (this.dragging && this.turned) {
      const k = this.k / this.rad;
      const dy = (y - this.py) * k;
      const dx = (x - this.px) * k;
      this.yaw += dx;
      this.pitch = Math.max(-PITCH_MAX_RAD, Math.min(PITCH_MAX_RAD, this.pitch + dy));
      const s = Math.max(8, dtMs) / 1000;
      this.vYaw = dx / s;
      this.vPitch = dy / s;
      this.px = x;
      this.py = y;
      this.dirty = true;
    }
    this.aim(x, y);
  }

  lift() {
    this.dragging = false;
    this.turned = false;
    this.wake();
  }

  leave() {
    this.hover = false;
    this.wake();
  }

  key(k: string) {
    const s = k === "ArrowLeft" ? -1 : k === "ArrowRight" ? 1 : 0;
    const p = k === "ArrowUp" ? -1 : k === "ArrowDown" ? 1 : 0;
    this.vYaw += s * 1.6;
    this.vPitch += p * 1.2;
    this.dirty = true;
    this.wake();
  }

  private aim(x: number, y: number) {
    const k = this.k;
    const sx = (x * k - this.cx) / this.rad;
    const sy = (this.cssH * k - y * k - this.cy) / this.rad;
    let dx = sx;
    let dy = sy;
    let dz = -CAM_Z;
    const l = Math.hypot(dx, dy, dz);
    dx /= l;
    dy /= l;
    dz /= l;
    const b = CAM_Z * dz;
    const c = CAM_Z * CAM_Z - 1;
    const h = b * b - c;
    this.hover = true;
    this.onSphere = h > 0;
    if (h > 0) {
      const t = -b - Math.sqrt(h);
      this.hx = dx * t;
      this.hy = dy * t;
      this.hz = CAM_Z + dz * t;
    }
    this.wake();
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
    if (!this.linked) {
      if (this.parallel && busy(gl, this.p)) return this.wake();
      finish(gl, this.p);
      this.linked = true;
      gl.useProgram(this.p.prog);
      gl.uniform1i(this.p.u.uCells, 27);
      gl.uniform1i(this.p.u.uBubN, BUBBLES);
      gl.uniform1i(this.p.u.uIter, MARCH_ITER);
      gl.uniform1i(this.p.u.uSplash, SPLASH);
      gl.uniform1i(this.p.u.uOct, 4);
    }
    if (!this.sized) this.resize();
    const rawMs = this.last ? now - this.last : 0;
    const dt = this.last ? Math.min(MAX_DT_S, Math.max(0, rawMs) / 1000) : 0;
    this.last = now;
    const live = !this.reduced;
    if (live) this.t += dt;

    // SPIN
    const decay = Math.exp(-dt / SPIN_TAU_S);
    if (!this.dragging) {
      this.yaw += this.vYaw * dt;
      this.pitch = Math.max(-PITCH_MAX_RAD, Math.min(PITCH_MAX_RAD, this.pitch + this.vPitch * dt));
      this.vYaw *= decay;
      this.vPitch *= decay;
      if (Math.abs(this.vYaw) < 1e-3) this.vYaw = 0;
      if (Math.abs(this.vPitch) < 1e-3) this.vPitch = 0;
      if (live) this.pitch += (PITCH_RAD - this.pitch) * (1 - Math.exp(-dt / 6));
    }
    if (live) this.yaw += ((Math.PI * 2) / SPIN_S) * dt;

    // HEAT
    const goal = this.hover && this.onSphere && !this.turned ? 1 : 0;
    const prevHeat = this.heat;
    this.heat += (goal - this.heat) * (1 - Math.exp(-dt / HEAT_TAU_S));
    if (Math.abs(goal - this.heat) < 1e-3) this.heat = goal;

    this.pose();
    this.schedule();
    this.draw();
    this.adapt(rawMs);
    if (!this.drawn) {
      this.drawn = true;
      this.onShown();
    }
    this.report(now);

    const moving =
      live || this.vYaw !== 0 || this.vPitch !== 0 || this.dirty || this.heat !== prevHeat;
    this.dirty = false;
    if (moving) this.wake();
    else this.last = 0;
  };

  // ROTATION
  // object to world: tilt about x after the spin about y; column major
  private pose() {
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    const cp = Math.cos(this.pitch);
    const sp = Math.sin(this.pitch);
    const r = this.rot;
    r[0] = cy;
    r[1] = sp * sy;
    r[2] = -cp * sy;
    r[3] = 0;
    r[4] = cp;
    r[5] = sp;
    r[6] = sy;
    r[7] = -sp * cy;
    r[8] = cp * cy;
  }

  // BUBBLE SCHEDULE
  // deterministic sites per slot and cycle; a warm pointer pulls the next one under it
  private schedule() {
    const b = this.bub;
    const r = this.rot;
    const ox = r[0] * this.hx + r[1] * this.hy + r[2] * this.hz;
    const oy = r[3] * this.hx + r[4] * this.hy + r[5] * this.hz;
    const oz = r[6] * this.hx + r[7] * this.hy + r[8] * this.hz;
    let sn = 0;
    for (let i = 0; i < BUBBLES; i++) {
      const n = CYCLES[i];
      const per = LOOP_S / n;
      const f = this.t / per + OFFSET[i];
      const c = Math.floor(f);
      const u = (f - c) / LIFE;
      const o = i * 4;
      if (c !== this.cyc[i]) {
        if (this.cyc[i] >= 0 && this.drawn) this.bursts++;
        this.cyc[i] = c;
        if (this.heat > 0.4) {
          const j = hash(i * 13 + c) - 0.5;
          const l = hash(i * 7 + c * 3) - 0.5;
          toMat(ox + j * 0.25, oy + l * 0.25, oz + (j - l) * 0.2, this.tau());
          this.store(i, c, MAT[0], MAT[1], MAT[2]);
        }
      }
      const at = this.site(i, c);
      b[o] = this.sites[at];
      b[o + 1] = this.sites[at + 1];
      b[o + 2] = this.sites[at + 2];
      b[o + 3] = u > 0 && u < 1 ? u : 0;
      if (b[o + 3] > 0) {
        toObj(b[o], b[o + 1], b[o + 2], this.tau());
        this.spotObj[o] = OBJ[0];
        this.spotObj[o + 1] = OBJ[1];
        this.spotObj[o + 2] = OBJ[2];
      }
      // SCARS
      // each closed crater of this slot, aged from the moment it skinned over
      for (let m = 0; m < KEEP; m++) {
        const cm = c - m;
        const age = this.t - (cm + LIFE - OFFSET[i]) * per;
        const a = age / (SCAR_CYCLES * per);
        if (a < 0 || a >= 1) continue;
        const k = this.site(i, cm);
        const q = (BUBBLES + sn) * 4;
        b[q] = this.sites[k];
        b[q + 1] = this.sites[k + 1];
        b[q + 2] = this.sites[k + 2];
        b[q + 3] = 2 + a;
        sn++;
      }
    }
    this.scarN = sn;
  }

  // SITE
  // remembered if a warm pointer placed it, else hashed from slot and cycle
  private site(i: number, c: number) {
    const slot = i * KEEP + (((c % KEEP) + KEEP) % KEEP);
    if (this.siteC[slot] !== c) {
      const n = CYCLES[i];
      const k = ((c % n) + n) % n;
      const lat = (hash(i * 31 + k * 7) * 2 - 1) * 0.7;
      const lon = hash(i * 17 + k * 11 + 5) * Math.PI * 2;
      const cl = Math.sqrt(1 - lat * lat);
      this.store(i, c, cl * Math.cos(lon), lat, cl * Math.sin(lon));
    }
    return slot * 3;
  }

  private store(i: number, c: number, x: number, y: number, z: number) {
    const slot = i * KEEP + (((c % KEEP) + KEEP) % KEEP);
    this.siteC[slot] = c;
    site(this.sites, slot * 3, x, y, z);
  }

  private tau() {
    return ((this.t % LOOP_S) / LOOP_S) * Math.PI * 2;
  }

  private draw() {
    const gl = this.gl;
    const u = this.p.u;
    const r = this.rot;
    const tau = ((this.t % LOOP_S) / LOOP_S) * Math.PI * 2;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.useProgram(this.p.prog);
    gl.bindVertexArray(this.vao);
    gl.uniform2f(u.uRes, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform3f(u.uView, this.cx, this.cy, this.rad);
    gl.uniformMatrix3fv(u.uRot, false, r);
    gl.uniform1f(u.uTau, tau);
    gl.uniform1f(u.uState, this.state(tau));
    const ox = r[0] * this.hx + r[1] * this.hy + r[2] * this.hz;
    const oy = r[3] * this.hx + r[4] * this.hy + r[5] * this.hz;
    const oz = r[6] * this.hx + r[7] * this.hy + r[8] * this.hz;
    gl.uniform4f(u.uHeat, ox, oy, oz, this.heat);
    gl.uniform4fv(u.uSpot, this.bub);
    gl.uniform4fv(u.uSpotObj, this.spotObj);
    gl.uniform1i(u.uSpotN, BUBBLES + this.scarN);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // BAND WIDTH
  // narrow cracks to wide rivers and back, once per loop
  private state(tau: number) {
    return 0.5 + 0.5 * Math.sin(tau + 0.9);
  }

  // RESOLUTION
  // dynamic resolution: shrink on slow frames, grow back when cheap
  private resize() {
    const k = Math.min(this.dpr, MAX_DPR) * this.scale;
    this.k = k;
    const w = Math.max(1, Math.round(this.cssW * k));
    const h = Math.max(1, Math.round(this.cssH * k));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    // LAYOUT
    // centred; raised on tall screens to clear the title
    const tall = this.cssH > this.cssW * 1.1;
    const r = tall
      ? Math.min(this.cssW * 0.4, this.cssH * 0.26)
      : Math.min(this.cssW, this.cssH) * 0.3;
    this.rad = r * k;
    this.cx = (this.cssW / 2) * k;
    this.cy = (tall ? this.cssH * (this.cssW <= PHONE_PX ? 0.5 : 0.58) : this.cssH * 0.52) * k;
    this.sized = true;
    this.dirty = true;
  }

  private adapt(ms: number) {
    if (!ms || this.reduced || this.tunes > 6) return;
    this.probeMs += ms;
    this.probeN++;
    if (this.probeN < PROBE_N) return;
    const avg = this.probeMs / this.probeN;
    this.probeMs = 0;
    this.probeN = 0;
    let s = this.scale;
    if (avg > SLOW_MS && s > SCALE_MIN) s = Math.max(SCALE_MIN, s * 0.82);
    else if (avg < FAST_MS && s < SCALE_MAX) s = Math.min(SCALE_MAX, s * 1.12);
    if (s === this.scale) return;
    this.scale = s;
    this.tunes++;
    this.sized = false;
  }

  private report(now: number) {
    if (now - this.hudAt < HUD_MS) return;
    this.hudAt = now;
    const tau = ((this.t % LOOP_S) / LOOP_S) * Math.PI * 2;
    const st = this.state(tau);
    this.onHud({
      temp: Math.round((1060 + 130 * st + 25 * this.heat) / 5) * 5,
      seams: Math.round(st * 100),
      bursts: this.bursts,
      over: this.onSphere && this.hover,
    });
  }

  dispose() {
    this.dead = true;
    unraf(this.raf);
    this.raf = 0;
    const gl = this.gl;
    gl.deleteProgram(this.p.prog);
    gl.deleteVertexArray(this.vao);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

// CRUST FRAME
// cpu mirror of the shader's domain(), both ways, to seed bubbles and place craters
const MAT = new Float64Array(3);
const OBJ = new Float64Array(3);
const TMP = new Float64Array(3);
const MAT_ITER = 3;

function h13(x: number, y: number, z: number) {
  x = fract(x * 0.1031);
  y = fract(y * 0.1031);
  z = fract(z * 0.1031);
  const d = x * (z + 31.32) + y * (y + 31.32) + z * (x + 31.32);
  x += d;
  y += d;
  z += d;
  return fract((x + y) * z);
}

function vn(x: number, y: number, z: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  let fx = x - ix;
  let fy = y - iy;
  let fz = z - iz;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  fz = fz * fz * (3 - 2 * fz);
  const a = lerp(h13(ix, iy, iz), h13(ix + 1, iy, iz), fx);
  const b = lerp(h13(ix, iy + 1, iz), h13(ix + 1, iy + 1, iz), fx);
  const c = lerp(h13(ix, iy, iz + 1), h13(ix + 1, iy, iz + 1), fx);
  const e = lerp(h13(ix, iy + 1, iz + 1), h13(ix + 1, iy + 1, iz + 1), fx);
  return lerp(lerp(a, b, fy), lerp(c, e, fy), fz);
}

function toMat(x: number, y: number, z: number, tau: number) {
  const l = Math.hypot(x, y, z) || 1;
  x /= l;
  y /= l;
  z /= l;
  const a = 0.16 * Math.sin(tau + y * 2.4);
  const c = Math.cos(a);
  const s = Math.sin(a);
  const mx = c * x + s * z;
  const mz = -s * x + c * z;
  const lx = Math.cos(tau) * 0.18;
  const ly = Math.sin(tau) * 0.18;
  const wx = vn(mx * 2.1 + lx, y * 2.1 + ly, mz * 2.1);
  const wy = vn(mx * 2.1 + 31 - lx, y * 2.1 + 31 - ly, mz * 2.1 + 31);
  const wz = vn(mx * 2.1 + 57 + ly, y * 2.1 + 57 + lx, mz * 2.1 + 57);
  const qx = mx + ((wx - 0.5) * 1.25) / MAT_SCALE[0];
  const qy = y + ((wy - 0.5) * 1.25) / MAT_SCALE[1];
  const qz = mz + ((wz - 0.5) * 1.25) / MAT_SCALE[2];
  const k = Math.hypot(qx, qy, qz) || 1;
  MAT[0] = qx / k;
  MAT[1] = qy / k;
  MAT[2] = qz / k;
}

// INVERSE
// fixed-point iteration, MAT_ITER corrections, into OBJ
function toObj(x: number, y: number, z: number, tau: number) {
  TMP[0] = x;
  TMP[1] = y;
  TMP[2] = z;
  for (let i = 0; i < MAT_ITER; i++) {
    toMat(TMP[0], TMP[1], TMP[2], tau);
    TMP[0] += x - MAT[0];
    TMP[1] += y - MAT[1];
    TMP[2] += z - MAT[2];
  }
  const l = Math.hypot(TMP[0], TMP[1], TMP[2]) || 1;
  OBJ[0] = TMP[0] / l;
  OBJ[1] = TMP[1] / l;
  OBJ[2] = TMP[2] / l;
}

function fract(x: number) {
  return x - Math.floor(x);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function hash(x: number) {
  const s = Math.sin(x * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function site(b: Float32Array, o: number, x: number, y: number, z: number) {
  const l = Math.hypot(x, y, z) || 1;
  b[o] = x / l;
  b[o + 1] = y / l;
  b[o + 2] = z / l;
}
