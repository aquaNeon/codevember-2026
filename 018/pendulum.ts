import { Beams, STRIDE } from "./beams";
import { crystal, type Crystal } from "./crystal";
import { Follow, Osc, orient } from "./motion";
import { SCENE, SUN, sunlit } from "./scene";
import {
  BLIT_FS,
  CRYSTAL_VS,
  FULL_VS,
  LINE_FS,
  LINE_VS,
  SHADE_FS,
  SHADOW_FS,
  SHADOW_VS,
  CAUSTIC_FS,
  causticVs,
  SPOT_FS,
  SPOT_VS,
  GLINT_FS,
  GLINT_VS,
  WALL_FS,
  crystalFs,
} from "./shaders";

const MAX_DPR = 2;
const MAX_DT_S = 1 / 20;
const PERIOD_S = 2.8; // one full swing, change for a longer thread feel
const TWIST_PERIOD_S = 7.5;
const SWING_HALF_S = 14; // swing amplitude halves this often
const TWIST_HALF_S = 9;
const MAX_DEPTH_RAD = 0.22; // lean toward the wall, kept clear of it at any swing
const MAX_W_RAD_S = 6.5; // fastest swing, change for wilder loops
const STEP_S = 1 / 240; // swing integration step
const POINTER_TAU_S = 0.035; // pointer speed smoothing
const POINTER_STALE_MS = 80; // a pointer that stopped this long before letting go throws softly
const PIVOT_CLEAR_M = 0.05; // how far above the view the pivot's shadow sits
const TALL_REST_Y = 0.26; // on a tall screen the stone rests about mid-frame
const SEEN_TAU_S = 0.07; // how fast the wall light follows the stone into and out of view
const MAX_TWIST_RAD = 4;
const FOLLOW_W = 16; // how tightly the held crystal follows, 1/s
const TWIST_KICK = 0.25; // release swing speed that turns into spin
const TAP_SPIN = 2.4; // rad/s a tap gives
const KEY_PUSH = 0.45; // rad/s an arrow key gives
const RING_R = 0.014;
const LINK_M = 0.011; // chain link length
const DOTS = 7; // small glints bounced onto the wall
const SETTLE = 1e-4;
const BOUNCES = 3; // inside the crystal, per pixel

// IDLE
// air in the room: a faint sway and a slow turn that never quite repeat
const IDLE = { x: 0.014, z: 0.01, twist: 0.32 };

const W_SWING = (Math.PI * 2) / PERIOD_S;
const W2 = W_SWING * W_SWING; // g over l
const DAMP = Math.LN2 / SWING_HALF_S;
const W_TWIST = (Math.PI * 2) / TWIST_PERIOD_S;

// attribute slots shared by every program
const SLOTS: Record<string, number> = {
  aPos: 0,
  aNormal: 1,
  aEdge: 2,
  aCorner: 0,
  aGlint: 1,
  aEnds: 1,
  aLight: 2,
  aLine: 1,
  aColor: 2,
  aAlong: 3,
};

const LINE_FLOATS = 11;
const GLINTS = 5;
const GLINT_COS = Math.cos((14 * Math.PI) / 180); // how far off the sun a face still glints
const GLINT_PX = 34; // star size, css px
const RING_SEGS = 14;
const SHADOW_QUADS = 2 + RING_SEGS; // chain, bail and ring shadows, drawn under the light
const LINE_QUADS = SHADOW_QUADS * 2;
const PENUMBRA_PX = 1.3; // soft shadow edge, css px

export class Pendulum {
  private gl: WebGL2RenderingContext;
  private c: Crystal;
  private beams: Beams;
  private progs: WebGLProgram[] = [];
  private u: Record<string, WebGLUniformLocation | null> = {};
  private wallP: WebGLProgram;
  private blitP: WebGLProgram;
  private wallTex: WebGLTexture;
  private wallFb: WebGLFramebuffer;
  private maskTex: WebGLTexture;
  private maskFb: WebGLFramebuffer;
  private shadeP: WebGLProgram;
  private shadowP: WebGLProgram;
  private causticP: WebGLProgram;
  private spotP: WebGLProgram;
  private lineP: WebGLProgram;
  private crystalP: WebGLProgram;
  private crystalVao: WebGLVertexArrayObject;
  private spotVao: WebGLVertexArrayObject;
  private glintVao: WebGLVertexArrayObject;
  private glintBuf: WebGLBuffer;
  private glintP: WebGLProgram;
  private glints = new Float32Array(GLINTS * 4); // world xyz, strength
  private glintN = 0;
  private lineVao: WebGLVertexArrayObject;
  private spotBuf: WebGLBuffer;
  private lineBuf: WebGLBuffer;
  private buffers: WebGLBuffer[] = [];
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
  private vp = new Float32Array(16);
  private half = new Float32Array(2);
  private dist = 1;
  private tanHalf = Math.tan((SCENE.fovDeg * Math.PI) / 360);
  private rect = { width: 1, height: 1, dpr: 1 };

  // POSE
  private t = 0;
  // SWING
  // the swing across the wall is the full pendulum, stepped, so a hard throw goes over the top
  private th = 0.05;
  private om = 0;
  private seen = 0; // how much of the stone's light reaches the wall: in view, hanging, in sun
  private shadowX = 0;
  private shadowY = 0;
  private sz = new Osc(W_SWING * 1.012, DAMP, MAX_DEPTH_RAD); // a hair off, so ellipses turn slowly
  private len: number = SCENE.length;
  private pivotY = SCENE.restY + SCENE.length;
  private tw = new Osc(W_TWIST, Math.LN2 / TWIST_HALF_S, MAX_TWIST_RAD);
  private fx = new Follow(FOLLOW_W);
  private fz = new Follow(FOLLOW_W);
  private ax = 0;
  private az = 0;
  private twist = 0;
  private rot = new Float32Array(9);
  private at = new Float32Array(3);
  private eye = new Float32Array(3);
  private lines: Float32Array;
  private ink = new Float32Array(2); // half width, kind

  // GESTURE
  private held = false;
  private targetX = 0;
  private lastA = 0;
  private lastMs = 0;
  private pw = 0; // smoothed pointer angular speed

  onShown: () => void = () => {};
  onLost: () => void = () => {};

  constructor(
    private canvas: HTMLCanvasElement | OffscreenCanvas,
    reduced: boolean,
  ) {
    const gl = canvas.getContext("webgl2", {
      antialias: true,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: "default",
    });
    if (!gl) throw new Error("webgl2 unavailable");
    this.gl = gl;
    this.reducedMotion = reduced;

    // PROGRAMS
    // linked in parallel where the driver allows, checked once before the first frame
    this.parallel = !!gl.getExtension("KHR_parallel_shader_compile");
    this.c = crystal();
    this.beams = new Beams(this.c, DOTS);
    this.wallP = this.program(FULL_VS, WALL_FS);
    this.blitP = this.program(FULL_VS, BLIT_FS);
    this.shadowP = this.program(SHADOW_VS, SHADOW_FS);
    this.shadeP = this.program(FULL_VS, SHADE_FS);
    this.causticP = this.program(causticVs(this.c.faces, this.c.height), CAUSTIC_FS);
    this.spotP = this.program(SPOT_VS, SPOT_FS);
    this.glintP = this.program(GLINT_VS, GLINT_FS);
    this.lineP = this.program(LINE_VS, LINE_FS);
    this.crystalP = this.program(CRYSTAL_VS, crystalFs(this.c.faces, this.c.height));

    // CRYSTAL MESH
    this.crystalVao = gl.createVertexArray();
    gl.bindVertexArray(this.crystalVao);
    this.attrib(this.c.pos, 0, 3);
    this.attrib(this.c.normal, 1, 3);
    this.attrib(this.c.edge, 2, 1);

    // SPOTS
    this.spotVao = gl.createVertexArray();
    gl.bindVertexArray(this.spotVao);
    this.attrib(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), 0, 2);
    this.spotBuf = this.buffer(this.beams.data.byteLength, gl.DYNAMIC_DRAW);
    const sb = STRIDE * 4;
    for (const [slot, size, off] of [
      [1, 4, 0],
      [2, 3, 16],
    ]) {
      gl.enableVertexAttribArray(slot);
      gl.vertexAttribPointer(slot, size, gl.FLOAT, false, sb, off);
      gl.vertexAttribDivisor(slot, 1);
    }

    // GLINTS
    this.glintVao = gl.createVertexArray();
    gl.bindVertexArray(this.glintVao);
    this.attrib(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), 0, 2);
    this.glintBuf = this.buffer(this.glints.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, 0);
    gl.vertexAttribDivisor(1, 1);

    // LINES
    this.lines = new Float32Array(LINE_QUADS * 6 * LINE_FLOATS);
    this.lineVao = gl.createVertexArray();
    gl.bindVertexArray(this.lineVao);
    this.lineBuf = this.buffer(this.lines.byteLength, gl.DYNAMIC_DRAW);
    const lb = LINE_FLOATS * 4;
    for (const [slot, size, off] of [
      [0, 3, 0],
      [1, 3, 12],
      [2, 4, 24],
      [3, 1, 40],
    ]) {
      gl.enableVertexAttribArray(slot);
      gl.vertexAttribPointer(slot, size, gl.FLOAT, false, lb, off);
    }
    gl.bindVertexArray(null);

    // WALL TEXTURE
    // sized and drawn on resize, read by everything that sits on or looks at the wall
    this.wallTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.wallTex);
    // mipmapped, so the stone can see the wall through it blurred for the price of one read
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.wallFb = gl.createFramebuffer();
    // SHADOW MASK
    // every occluder's shadow, drawn with max blending so they join as one
    this.maskTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.maskFb = gl.createFramebuffer();

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.CULL_FACE);
    gl.clearColor(0, 0, 0, 0);

    // start mid-turn, so the first frame already has light on the wall
    this.tw.set(0, 0.35, 0.4);
    this.sz.set(0, 0, 0.04);

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
  // the host owns the page: it says how big, whether anyone can see it, and where the pointer is
  spin(dir = 1) {
    this.kick(0, 0, TAP_SPIN * dir);
  }

  size(width: number, height: number, dpr: number) {
    this.rect.width = width || 1;
    this.rect.height = height || 1;
    this.rect.dpr = Math.min(dpr || 1, MAX_DPR);
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

  get period() {
    return PERIOD_S;
  }

  // GL SETUP
  private program(vs: string, fs: string) {
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
    for (const name in SLOTS)
      if (vs.includes(` ${name};`)) gl.bindAttribLocation(p, SLOTS[name], name);
    gl.linkProgram(p);
    this.progs.push(p);
    return p;
  }

  // lazily, once linking is done: status check and uniform lookups
  private link() {
    const gl = this.gl;
    for (const p of this.progs) {
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(p);
        throw new Error(`link: ${log}`);
      }
    }
    const find = (key: string, p: WebGLProgram, name: string) =>
      (this.u[key] = gl.getUniformLocation(p, name));
    find("wHalf", this.wallP, "uHalf");
    for (const [k, p] of [
      ["s", this.shadowP],
      ["k", this.causticP],
      ["c", this.crystalP],
    ] as const) {
      find(`${k}VP`, p, "uVP");
      find(`${k}Rot`, p, "uRot");
      find(`${k}Pos`, p, "uPos");
    }
    find("cEye", this.crystalP, "uEye");
    find("cHalf", this.crystalP, "uHalf");
    find("pVP", this.spotP, "uVP");
    find("gVP", this.glintP, "uVP");
    find("gSize", this.glintP, "uSize");
    find("kPx", this.causticP, "uPx2");
    find("hStep", this.shadeP, "uStep");
    find("lVP", this.lineP, "uVP");
    gl.useProgram(this.lineP);
    gl.uniform1f(gl.getUniformLocation(this.lineP, "uLink"), LINK_M);
    // every sampler reads the wall from unit 0, which never holds anything else
    for (const p of [this.blitP, this.shadeP, this.causticP, this.crystalP]) {
      gl.useProgram(p);
      gl.uniform1i(gl.getUniformLocation(p, "uWall"), 0);
      gl.uniform1i(gl.getUniformLocation(p, "uMask"), 1);
    }
    for (const p of [this.causticP, this.crystalP]) {
      gl.useProgram(p);
      gl.uniform4fv(gl.getUniformLocation(p, "uPlanes[0]"), this.c.planes);
      gl.uniform1i(gl.getUniformLocation(p, "uFaces"), this.c.faces);
    }
    gl.uniform1i(gl.getUniformLocation(this.crystalP, "uBounces"), BOUNCES);
    this.compiled = true;
  }

  private ready() {
    if (this.compiled) return true;
    if (this.parallel) {
      const done = 0x91b1; // COMPLETION_STATUS_KHR
      for (const p of this.progs) if (!this.gl.getProgramParameter(p, done)) return false;
    }
    this.link();
    return true;
  }

  private buffer(data: Float32Array | number, usage: number) {
    const gl = this.gl;
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    if (typeof data === "number") gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    else gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    this.buffers.push(b);
    return b;
  }

  private attrib(data: Float32Array, slot: number, size: number) {
    const gl = this.gl;
    this.buffer(data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(slot);
    gl.vertexAttribPointer(slot, size, gl.FLOAT, false, 0, 0);
  }

  // INPUT
  // the pointer lands on the plane the crystal hangs in
  private worldX(cx: number) {
    const r = this.rect;
    return (((cx / r.width) * 2 - 1) * this.half[0] * (this.dist - SCENE.crystalZ)) / this.dist;
  }

  private worldY(cy: number) {
    const r = this.rect;
    return ((1 - (cy / r.height) * 2) * this.half[1] * (this.dist - SCENE.crystalZ)) / this.dist;
  }

  // the pointer's angle round the pivot
  private angle(x: number, y: number) {
    return Math.atan2(this.worldX(x), this.pivotY - this.worldY(y));
  }

  // x, y in css px from the canvas corner, ms the event's time
  down(x: number, y: number, ms: number) {
    // pick up the crystal where it is, moving as it moves
    const t = this.t;
    const rm = this.reducedMotion;
    this.fx.x = this.ax;
    this.fz.x = this.az;
    this.fx.v = rm ? 0 : this.om + idleV(t, IDLE.x, 0);
    this.fz.v = rm ? 0 : this.sz.v(t) + idleV(t, IDLE.z, 1);
    this.targetX = this.ax;
    this.lastA = this.angle(x, y);
    this.lastMs = ms;
    this.pw = 0;
    this.held = true;
    this.wake();
  }

  // the held stone turns round the pivot with the pointer, as many times as it is taken round
  move(x: number, y: number, ms: number) {
    if (!this.held) return;
    const a = this.angle(x, y);
    const da = wrap(a - this.lastA);
    this.targetX += da;
    this.lastA = a;
    const dt = (ms - this.lastMs) / 1000;
    if (dt > 0) {
      this.pw += (da / dt - this.pw) * (1 - Math.exp(-dt / POINTER_TAU_S));
      this.lastMs = ms;
    }
    this.wake();
  }

  up(x: number, tap: boolean, ms: number) {
    if (!this.held) return;
    this.held = false;
    const t = this.t;
    if (this.reducedMotion) {
      this.wake();
      return;
    }
    // LET GO
    // the swing carries on from where the hand left it, as fast as the hand was going
    const idleMs = ms - this.lastMs;
    const pw = idleMs > 0 ? this.pw * Math.exp(-idleMs / POINTER_STALE_MS) : this.pw;
    const w = Math.abs(pw) > Math.abs(this.fx.v) ? pw : this.fx.v;
    this.th = wrap(this.fx.x - idle(t, IDLE.x, 0));
    this.om = clamp(w - idleV(t, IDLE.x, 0), MAX_W_RAD_S);
    this.sz.set(t, this.fz.x - idle(t, IDLE.z, 1), this.fz.v - idleV(t, IDLE.z, 1));
    let spin = clamp(w * TWIST_KICK, TAP_SPIN);
    if (tap) {
      // tap right of the crystal turns it one way, left the other
      const side = this.worldX(x) - this.at[0];
      spin += TAP_SPIN * (side >= 0 ? 1 : -1);
    }
    this.kick(0, 0, spin);
  }

  // true when the key did something
  key(k: string) {
    if (k === "ArrowLeft" || k === "ArrowRight")
      this.kick(k === "ArrowLeft" ? -KEY_PUSH : KEY_PUSH, 0, 0);
    else if (k === "ArrowUp" || k === "ArrowDown")
      this.kick(0, k === "ArrowUp" ? -KEY_PUSH : KEY_PUSH, 0);
    else if (k === "Enter" || k === " ") this.spin();
    else return false;
    return true;
  }

  // adds speed to the free swing without moving it
  private kick(vx: number, vz: number, vt: number) {
    if (this.held || this.reducedMotion) return;
    const t = this.t;
    if (vx) this.om = clamp(this.om + vx, MAX_W_RAD_S);
    if (vz) this.sz.set(t, this.sz.x(t), this.sz.v(t) + vz);
    if (vt) this.tw.set(t, this.tw.x(t), this.tw.v(t) + vt);
    this.wake();
  }

  // the full pendulum, in small fixed steps so it stays true at any frame rate
  private swing(dt: number) {
    const n = Math.ceil(dt / STEP_S);
    const h = n ? dt / n : 0;
    let th = this.th;
    let om = this.om;
    for (let i = 0; i < n; i++) {
      om += (-W2 * Math.sin(th) - 2 * DAMP * om) * h;
      if (om > MAX_W_RAD_S) om = MAX_W_RAD_S;
      else if (om < -MAX_W_RAD_S) om = -MAX_W_RAD_S;
      th += om * h;
    }
    // over the top: fold back
    if (th > Math.PI) th -= Math.PI * 2;
    else if (th < -Math.PI) th += Math.PI * 2;
    this.th = th;
    this.om = om;
  }

  // LOOP
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
    const dt = this.last ? Math.min(MAX_DT_S, Math.max(0, now - this.last) / 1000) : 0;
    this.last = now;
    if (!this.sized) this.resize();

    const moving = this.pose(dt);
    this.draw();
    if (!this.drawn) {
      this.drawn = true;
      this.onShown();
    }
    if (moving) this.wake();
    else this.last = 0;
  };

  // POSE
  // returns whether anything will still move
  private pose(dt: number) {
    const rm = this.reducedMotion;
    if (!rm) this.t += dt;
    const t = this.t;
    let moving = !rm;
    if (this.held) {
      this.fx.step(this.targetX, dt);
      this.fz.step(this.fz.x, dt);
      this.ax = this.fx.x;
      this.az = this.fz.x;
      moving = true;
    } else if (rm) {
      // no swinging: let go and it eases back to hanging still
      this.fx.step(0, dt || 1 / 60);
      this.fz.step(0, dt || 1 / 60);
      this.ax = this.fx.x;
      this.az = this.fz.x;
      moving =
        Math.abs(this.ax) + Math.abs(this.az) + Math.abs(this.fx.v) + Math.abs(this.fz.v) > SETTLE;
    } else {
      this.swing(dt);
      this.ax = this.th + idle(t, IDLE.x, 0);
      this.az = this.sz.x(t) + idle(t, IDLE.z, 1);
    }
    this.twist = this.tw.x(t) + (rm ? 0 : idleTwist(t));

    const r = this.rot;
    orient(r, this.ax, this.az, this.twist);

    const L = this.len;
    const py = this.pivotY;
    this.at[0] = -r[3] * L;
    this.at[1] = py - r[4] * L;
    this.at[2] = SCENE.crystalZ - r[5] * L;

    // camera in the crystal's frame
    const ex = -this.at[0];
    const ey = -this.at[1];
    const ez = this.dist - this.at[2];
    this.eye[0] = r[0] * ex + r[1] * ey + r[2] * ez;
    this.eye[1] = r[3] * ex + r[4] * ey + r[5] * ez;
    this.eye[2] = r[6] * ex + r[7] * ey + r[8] * ez;

    this.see(dt);
    this.beams.trace(this.ax, this.az, this.twist, this.at, dt);
    // flecks only while the stone is there to throw them
    const bd = this.beams.data;
    for (let i = 0; i < this.beams.count; i++) bd[i * STRIDE + 5] *= this.seen;
    this.thread(py);
    this.sparkle();
    return moving;
  }

  // GLINTS
  // the few faces that mirror the sun straight at you get a star; kept brightest first
  private sparkle() {
    const r = this.rot;
    const at = this.at;
    const pl = this.c.planes;
    const ce = this.c.centroid;
    const g = this.glints;
    this.glintN = 0;
    for (let i = 0; i < this.c.faces; i++) {
      const lx = pl[i * 4];
      const ly = pl[i * 4 + 1];
      const lz = pl[i * 4 + 2];
      const nx = r[0] * lx + r[3] * ly + r[6] * lz;
      const ny = r[1] * lx + r[4] * ly + r[7] * lz;
      const nz = r[2] * lx + r[5] * ly + r[8] * lz;
      const cx = ce[i * 3];
      const cy = ce[i * 3 + 1];
      const cz = ce[i * 3 + 2];
      const wx = r[0] * cx + r[3] * cy + r[6] * cz + at[0];
      const wy = r[1] * cx + r[4] * cy + r[7] * cz + at[1];
      const wz = r[2] * cx + r[5] * cy + r[8] * cz + at[2];
      let vx = wx;
      let vy = wy;
      let vz = wz - this.dist;
      const vl = Math.hypot(vx, vy, vz);
      vx /= vl;
      vy /= vl;
      vz /= vl;
      const vn = vx * nx + vy * ny + vz * nz;
      if (vn >= -0.05) continue;
      const rx = vx - 2 * vn * nx;
      const ry = vy - 2 * vn * ny;
      const rz = vz - 2 * vn * nz;
      const a = -(rx * SUN[0] + ry * SUN[1] + rz * SUN[2]);
      if (a <= GLINT_COS) continue;
      const t = (a - GLINT_COS) / (1 - GLINT_COS);
      const s = Math.sqrt(t * t * (3 - 2 * t)) * Math.min(1, -vn * 3);
      // insert by strength, the weakest falls off the end
      let k = Math.min(this.glintN, GLINTS - 1);
      if (this.glintN === GLINTS && g[k * 4 + 3] >= s) continue;
      while (k > 0 && g[(k - 1) * 4 + 3] < s) {
        g[k * 4] = g[(k - 1) * 4];
        g[k * 4 + 1] = g[(k - 1) * 4 + 1];
        g[k * 4 + 2] = g[(k - 1) * 4 + 2];
        g[k * 4 + 3] = g[(k - 1) * 4 + 3];
        k--;
      }
      g[k * 4] = wx;
      g[k * 4 + 1] = wy;
      g[k * 4 + 2] = wz;
      g[k * 4 + 3] = s;
      if (this.glintN < GLINTS) this.glintN++;
    }
  }

  // SEEN
  // the wall light belongs to the stone: it is there only while the stone is in view, hangs
  // below its pivot and stands in the sun, and follows it out within a fraction of a second
  private see(dt: number) {
    const r = this.rot;
    const h = this.c.height * 0.45;
    const cx = this.at[0] - r[3] * h;
    const cy = this.at[1] - r[4] * h;
    const cz = this.at[2] - r[5] * h;
    const k = this.dist / (this.dist - cz);
    const edge = Math.max(Math.abs((cx * k) / this.half[0]), Math.abs((cy * k) / this.half[1]));
    const s = cz / -SUN[2];
    this.shadowX = cx + SUN[0] * s;
    this.shadowY = cy + SUN[1] * s;
    const want =
      smooth(1.08, 0.94, edge) *
      smooth(-0.1, 0.35, Math.cos(this.ax)) *
      smooth(0.15, 0.5, sunlit(this.shadowX, this.shadowY));
    this.seen += (want - this.seen) * (dt > 0 ? 1 - Math.exp(-dt / SEEN_TAU_S) : 1);
  }

  // SPARKS
  // small glints the stone's faces throw round its shadow: each sits at its own distance and
  // turns with the stone, and shows while its face takes the sun
  private sparks(d: Float32Array, at: number) {
    const r = this.rot;
    const pl = this.c.planes;
    const tw = this.twist;
    const sw = Math.sin(this.ax);
    const t = this.t;
    for (let i = 0; i < DOTS; i++) {
      const s = i * 6;
      const rho = SPARKS[s];
      const drift = SPARKS[s + 2];
      const blink = SPARKS[s + 3];
      const ph = SPARKS[s + 4];
      const size = SPARKS[s + 5];
      const a = SPARKS[s + 1] + tw * drift * 0.35 + this.ax * drift * 0.5;
      const x = this.shadowX + rho * Math.cos(a);
      const y = this.shadowY + rho * 0.8 * Math.sin(a);
      // the face this glint comes off, turned into the world
      const f = ((i * 5) % this.c.faces) * 4;
      const nx = r[0] * pl[f] + r[3] * pl[f + 1] + r[6] * pl[f + 2];
      const ny = r[1] * pl[f] + r[4] * pl[f + 1] + r[7] * pl[f + 2];
      const nz = r[2] * pl[f] + r[5] * pl[f + 1] + r[8] * pl[f + 2];
      const face = smooth(0.15, 0.7, -(nx * SUN[0] + ny * SUN[1] + nz * SUN[2]));
      const w = 0.5 + 0.5 * Math.sin(tw * blink + sw * blink * 7 + t * 0.21 * drift + ph);
      const o = at + i * STRIDE;
      d[o] = x - size * 0.4;
      d[o + 1] = y;
      d[o + 2] = x + size * 0.4;
      d[o + 3] = y + size * 0.1;
      d[o + 4] = size * 1.8;
      d[o + 5] = 0.32 * w * w * (3 - 2 * w) * face * this.seen; // change glint strength here
      d[o + 6] = -2;
    }
  }

  // CHAIN
  // pivot to the top of the bail ring, the bail stem and the ring, and the shadow of each
  // thrown along the sun. shadows fill the first quads, metal the rest
  private thread(py: number) {
    const r = this.rot;
    const at = this.at;
    const dpr = this.rect.dpr;
    let s = 0;
    let q = SHADOW_QUADS;
    const ringC = RING_R * 1.45;
    const topY = ringC + RING_R;
    const tx = at[0] + r[3] * topY;
    const ty = at[1] + r[4] * topY;
    const tz = at[2] + r[5] * topY;
    const len = Math.hypot(tx, ty - py, tz - SCENE.crystalZ);
    const pz = SCENE.crystalZ;

    s = this.cast(s, 0, py, pz, tx, ty, tz, 1.0 * dpr, len);
    q = this.quad(q, 0, py, pz, tx, ty, tz, 0.95 * dpr, 0, len, 2);
    this.paint(q - 1, INK.chain);

    // the bail: a short stem into the table
    const b0 = -0.002;
    const b1 = ringC - RING_R * 0.9;
    const ax = at[0] + r[3] * b0;
    const ay = at[1] + r[4] * b0;
    const az = at[2] + r[5] * b0;
    const bx = at[0] + r[3] * b1;
    const by = at[1] + r[4] * b1;
    const bz = at[2] + r[5] * b1;
    s = this.cast(s, ax, ay, az, bx, by, bz, 1.6 * dpr, 0);
    q = this.quad(q, ax, ay, az, bx, by, bz, 1.8 * dpr, 0, 0, 0);
    this.paint(q - 1, INK.metal);

    for (let i = 0; i < RING_SEGS; i++) {
      const a0 = (i / RING_SEGS) * Math.PI * 2;
      const a1 = ((i + 1) / RING_SEGS) * Math.PI * 2;
      const x0 = Math.sin(a0) * RING_R;
      const y0 = ringC + Math.cos(a0) * RING_R;
      const x1 = Math.sin(a1) * RING_R;
      const y1 = ringC + Math.cos(a1) * RING_R;
      const ux = at[0] + r[0] * x0 + r[3] * y0;
      const uy = at[1] + r[1] * x0 + r[4] * y0;
      const uz = at[2] + r[2] * x0 + r[5] * y0;
      const vx = at[0] + r[0] * x1 + r[3] * y1;
      const vy = at[1] + r[1] * x1 + r[4] * y1;
      const vz = at[2] + r[2] * x1 + r[5] * y1;
      s = this.cast(s, ux, uy, uz, vx, vy, vz, 0.75 * dpr, 0);
      q = this.quad(q, ux, uy, uz, vx, vy, vz, 0.85 * dpr, 0, 0, 0);
      // the ring catches light on its upper right, where the sun comes from
      const lit = 0.75 + 0.45 * Math.max(0, Math.cos(a0 - 0.8));
      INK.ring[0] = INK.metal[0] * lit;
      INK.ring[1] = INK.metal[1] * lit;
      INK.ring[2] = INK.metal[2] * lit;
      this.paint(q - 1, INK.ring);
    }
  }

  // a segment's shadow on the wall, along the sun; a chain keeps its links
  private cast(
    q: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    halfPx: number,
    along: number,
  ) {
    const ka = az / -SUN[2];
    const kb = bz / -SUN[2];
    const sx = ax + SUN[0] * ka;
    const sy = ay + SUN[1] * ka;
    const ex = bx + SUN[0] * kb;
    const ey = by + SUN[1] * kb;
    const next = this.quad(q, sx, sy, 0, ex, ey, 0, halfPx, 0, along, along ? 1 : 3);
    this.paint(q, INK.shadow);
    return next;
  }

  // one line segment as two triangles, widened square to the view
  private quad(
    q: number,
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    halfPx: number,
    alongA: number,
    alongB: number,
    kind: number,
  ) {
    const sx = bx - ax;
    const sy = by - ay;
    // view direction is close enough to +z for a few-pixel-wide line
    let nx = -sy;
    let ny = sx;
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    const scale = (2 * this.tanHalf) / this.canvas.height;
    const wa = (halfPx + 1) * scale * (this.dist - az);
    const wb = (halfPx + 1) * scale * (this.dist - bz);
    const k = this.ink;
    k[0] = halfPx;
    k[1] = kind;
    const o = q * 6;
    this.corner(o, ax - nx * wa, ay - ny * wa, az, -1, alongA);
    this.corner(o + 1, bx - nx * wb, by - ny * wb, bz, -1, alongB);
    this.corner(o + 2, ax + nx * wa, ay + ny * wa, az, 1, alongA);
    this.corner(o + 3, ax + nx * wa, ay + ny * wa, az, 1, alongA);
    this.corner(o + 4, bx - nx * wb, by - ny * wb, bz, -1, alongB);
    this.corner(o + 5, bx + nx * wb, by + ny * wb, bz, 1, alongB);
    return q + 1;
  }

  private corner(v: number, x: number, y: number, z: number, side: number, along: number) {
    const l = this.lines;
    const o = v * LINE_FLOATS;
    l[o] = x;
    l[o + 1] = y;
    l[o + 2] = z;
    l[o + 3] = side;
    l[o + 4] = this.ink[0];
    l[o + 5] = this.ink[1];
    l[o + 10] = along;
  }

  // premultiplied colour onto all six corners of quad q
  private paint(q: number, c: Float32Array) {
    const l = this.lines;
    const a = c[3];
    for (let v = q * 6; v < q * 6 + 6; v++) {
      const o = v * LINE_FLOATS;
      l[o + 6] = c[0] * a;
      l[o + 7] = c[1] * a;
      l[o + 8] = c[2] * a;
      l[o + 9] = a;
    }
  }

  // DRAW
  private draw() {
    const gl = this.gl;
    const u = this.u;
    // MASK
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.maskFb);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.blendEquation(gl.MAX);
    gl.useProgram(this.shadowP);
    gl.uniformMatrix4fv(u.sVP, false, this.vp);
    gl.uniformMatrix3fv(u.sRot, false, this.rot);
    gl.uniform3fv(u.sPos, this.at);
    gl.bindVertexArray(this.crystalVao);
    gl.drawArrays(gl.TRIANGLES, 0, this.c.tris * 3);
    gl.useProgram(this.lineP);
    gl.uniformMatrix4fv(u.lVP, false, this.vp);
    gl.bindVertexArray(this.lineVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.lines);
    gl.disable(gl.CULL_FACE);
    gl.drawArrays(gl.TRIANGLES, 0, SHADOW_QUADS * 6);
    gl.blendEquation(gl.FUNC_ADD);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.wallTex);
    gl.disable(gl.BLEND);
    gl.useProgram(this.blitP);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.BLEND);

    // SHADOW
    // only over the box the shadow can reach
    gl.useProgram(this.shadeP);
    const tap = PENUMBRA_PX * this.rect.dpr;
    gl.uniform2f(u.hStep, tap / this.canvas.width, tap / this.canvas.height);
    this.box();
    gl.enable(gl.SCISSOR_TEST);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.SCISSOR_TEST);

    // the sun let through, bent face by face, once per colour
    gl.useProgram(this.causticP);
    gl.uniformMatrix4fv(u.kVP, false, this.vp);
    gl.uniformMatrix3fv(u.kRot, false, this.rot);
    gl.uniform3fv(u.kPos, this.at);
    const px = (2 * this.half[1]) / this.canvas.height;
    gl.uniform1f(u.kPx, px * px);
    gl.bindVertexArray(this.crystalVao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, this.c.tris * 3, 3);

    // the flecks, then the glints
    const n = this.beams.count;
    const d = this.beams.data;
    this.sparks(d, n * STRIDE);
    gl.useProgram(this.spotP);
    gl.uniformMatrix4fv(u.pVP, false, this.vp);
    gl.bindVertexArray(this.spotVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.spotBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, d, 0, (n + DOTS) * STRIDE);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n + DOTS);

    gl.useProgram(this.lineP);
    gl.bindVertexArray(this.lineVao);
    gl.drawArrays(gl.TRIANGLES, SHADOW_QUADS * 6, (LINE_QUADS - SHADOW_QUADS) * 6);
    gl.enable(gl.CULL_FACE);

    gl.useProgram(this.crystalP);
    gl.uniformMatrix4fv(u.cVP, false, this.vp);
    gl.uniformMatrix3fv(u.cRot, false, this.rot);
    gl.uniform3fv(u.cPos, this.at);
    gl.uniform3fv(u.cEye, this.eye);
    gl.uniform2fv(u.cHalf, this.half);
    gl.bindVertexArray(this.crystalVao);
    gl.drawArrays(gl.TRIANGLES, 0, this.c.tris * 3);

    if (this.glintN) {
      gl.useProgram(this.glintP);
      gl.uniformMatrix4fv(u.gVP, false, this.vp);
      gl.uniform2f(
        u.gSize,
        (GLINT_PX * 2 * this.rect.dpr) / this.canvas.width,
        (GLINT_PX * 2 * this.rect.dpr) / this.canvas.height,
      );
      gl.bindVertexArray(this.glintVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.glintBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.glints, 0, this.glintN * 4);
      gl.disable(gl.CULL_FACE);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.glintN);
      gl.enable(gl.CULL_FACE);
    }
    gl.bindVertexArray(null);
  }

  // RESIZE
  private resize() {
    const dpr = this.rect.dpr;
    const w = Math.round(this.rect.width * dpr);
    const h = Math.round(this.rect.height * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);

    // keep the whole of fitH by fitW of wall in view
    const aspect = this.rect.width / this.rect.height;
    const hh = Math.max(SCENE.fitH / 2, SCENE.fitW / 2 / aspect);
    this.half[0] = hh * aspect;
    this.half[1] = hh;
    this.dist = hh / this.tanHalf;
    const near = 0.1;
    const far = this.dist + 1;
    const f = 1 / this.tanHalf;
    const m = this.vp;
    m.fill(0);
    m[0] = f / aspect;
    m[5] = f;
    m[10] = (far + near) / (near - far);
    m[11] = -1;
    // projection times a step back of dist
    m[14] = (2 * far * near) / (near - far) - m[10] * this.dist;
    m[15] = this.dist;
    // the pivot just out of view on every screen, so a big swing keeps its arc on screen
    // PIVOT
    // high enough that the pivot and its shadow are both above the view, so chain and shadow
    // run straight off the top at any angle. on narrow screens the stone hangs a little
    // higher, so a swing keeps more of its arc in frame
    const rest = aspect < 0.8 ? TALL_REST_Y : SCENE.restY;
    this.pivotY = hh + (SCENE.crystalZ * -SUN[1]) / -SUN[2] + PIVOT_CLEAR_M;
    this.len = this.pivotY - rest;
    this.beams.restY = rest;
    this.bake(w, h);
    this.sized = true;
  }

  // SHADOW BOX
  // the chain's shadow from the top of the view down, and the stone's, in canvas pixels
  private box() {
    const r = this.rot;
    const at = this.at;
    const k = SCENE.crystalZ / -SUN[2];
    const ka = at[2] / -SUN[2];
    const h = this.c.height;
    const tz = at[2] - r[5] * h;
    const kt = tz / -SUN[2];
    const x0 = SUN[0] * k;
    const y0 = this.pivotY + SUN[1] * k;
    const x1 = at[0] + SUN[0] * ka;
    const y1 = at[1] + SUN[1] * ka;
    const x2 = at[0] - r[3] * h + SUN[0] * kt;
    const y2 = at[1] - r[4] * h + SUN[1] * kt;
    const pad = this.c.radius * 1.6 + 0.03;
    const w = this.canvas.width;
    const hh = this.canvas.height;
    const sx = w / (2 * this.half[0]);
    const sy = hh / (2 * this.half[1]);
    const l = Math.max(0, Math.floor((Math.min(x0, x1, x2) - pad + this.half[0]) * sx));
    const rt = Math.min(w, Math.ceil((Math.max(x0, x1, x2) + pad + this.half[0]) * sx));
    const b = Math.max(0, Math.floor((Math.min(y0, y1, y2) - pad + this.half[1]) * sy));
    const t = Math.min(hh, Math.ceil((Math.max(y0, y1, y2) + pad + this.half[1]) * sy));
    this.gl.scissor(l, b, Math.max(0, rt - l), Math.max(0, t - b));
  }

  // the wall, once per size, into the texture the frame starts from
  private bake(w: number, h: number) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.maskFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.maskTex, 0);
    gl.bindTexture(gl.TEXTURE_2D, this.wallTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.wallFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.wallTex, 0);
    gl.disable(gl.BLEND);
    gl.useProgram(this.wallP);
    gl.uniform2fv(this.u.wHalf, this.half);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.cleanups.forEach((fn) => fn());
    this.cleanups.length = 0;
    const gl = this.gl;
    this.progs.forEach((p) => gl.deleteProgram(p));
    this.buffers.forEach((b) => gl.deleteBuffer(b));
    gl.deleteVertexArray(this.crystalVao);
    gl.deleteVertexArray(this.spotVao);
    gl.deleteVertexArray(this.glintVao);
    gl.deleteVertexArray(this.lineVao);
    gl.deleteTexture(this.wallTex);
    gl.deleteFramebuffer(this.wallFb);
    gl.deleteTexture(this.maskTex);
    gl.deleteFramebuffer(this.maskFb);
    this.progs.length = 0;
    this.buffers.length = 0;
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

// SPARKS
// the glints the stone throws round its shadow: distance, angle, drift rate, twinkle rate,
// phase, size
const SPARKS = new Float32Array([
  0.35, -0.6, 1.3, 2.1, 0.4, 0.016, 0.55, -1.0, 0.8, 3.3, 2.2, 0.013, 0.42, -1.6, 1.7, 1.6, 4.1,
  0.011, 0.7, -0.3, 1.1, 2.7, 1.3, 0.015, 0.62, -1.3, 0.6, 3.9, 5.2, 0.012, 0.3, 2.2, 1.5, 2.4, 3.0,
  0.01, 0.8, -0.8, 0.9, 1.9, 0.7, 0.009,
]);

// INK
// straight rgba, premultiplied as it is painted
const INK = {
  shadow: new Float32Array([0.14, 0.14, 0.15, 0.34]),
  chain: new Float32Array([0.74, 0.75, 0.77, 1]),
  metal: new Float32Array([0.7, 0.71, 0.73, 1]),
  ring: new Float32Array([0, 0, 0, 1]),
};

function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function wrap(a: number) {
  return a - Math.PI * 2 * Math.round(a / (Math.PI * 2));
}

function clamp(x: number, max: number) {
  return Math.min(max, Math.max(-max, x));
}

// IDLE CURVES
// two slow sines each, so the sway breathes instead of ticking
function idle(t: number, amp: number, phase: number) {
  return (
    amp * Math.sin(W_SWING * t + phase * 1.7) * (0.65 + 0.35 * Math.sin(0.23 * t + phase * 2.1))
  );
}

function idleV(t: number, amp: number, phase: number) {
  const a = W_SWING * t + phase * 1.7;
  const b = 0.23 * t + phase * 2.1;
  return (
    amp *
    (W_SWING * Math.cos(a) * (0.65 + 0.35 * Math.sin(b)) + Math.sin(a) * 0.35 * 0.23 * Math.cos(b))
  );
}

function idleTwist(t: number) {
  return (
    IDLE.twist * Math.sin((Math.PI * 2 * t) / 23) +
    IDLE.twist * 0.4 * Math.sin((Math.PI * 2 * t) / 8.3 + 1.1)
  );
}
