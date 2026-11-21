// GARDEN
// the renderer, the clock and the loop. no dom in here, so it runs in a worker on an
// offscreen canvas or on the page as a fallback. the summer runs on by itself; scrolling
// hurries it, then it eases back. the sun crosses the sky over each cycle and leans a little
// toward the pointer; the plants' soft shadows swing with it. at the end one seed drifts off
// to the gap where the next plant is already coming up, and the camera goes with it. the
// loop sleeps once nothing can change on screen

import { busy, finish, pass, raf, software, unraf, type Opts, type Pass } from "./gl";
import {
  END_D,
  G0_D,
  HEAD_STRIDE,
  LEAF_STRIDE,
  MAX_HEADS,
  MAX_NODES,
  MAX_SEEDS,
  NUT_MAX_D,
  nutOf,
  Plant,
  ROWS,
  SEED_STRIDE,
  SPINE_N,
  TWIG_N,
  TWIG_ROW,
  type Stage,
} from "./plant";
import {
  BG_FS,
  BG_VS,
  FLORETS,
  FLORET_FS,
  FLORET_VS,
  GROUND_FS,
  GROUND_VS,
  HEAD_FS,
  HEAD_RINGS,
  HEAD_SIDES,
  HEAD_VS,
  LEAF_FS,
  LEAF_GU,
  LEAF_GV,
  LEAF_VS,
  SEED_FS,
  SEED_VS,
  SOFT_FS,
  TUBE_FS,
  TUBE_SIDES,
  TUBE_VS,
} from "./shaders";

const MAX_DPR = 2;
const MAX_DT_S = 1 / 20;
const FOV_RAD = (26 * Math.PI) / 180;
const AUTO_RATE_D = 0.6; // days per second, the summer's own pace
const SPROUT_X = 1.8; // the seedling weeks run this much faster
const RATE_TAU_S = 0.6; // the pace eases toward its goal over this
const BOOST_MAX_D = 7; // the most scrolling can add, days per second
const BOOST_TAU_S = 1.4; // and how long it takes to ease back
const BOOST_PER_PX = 0.012; // days per second added per pixel scrolled
const NEXT_D = 14; // how far the next seedling has come by the time the seed lands
const AUTO_CYCLES = 3; // untouched cycles before it comes to rest in seed
const ORBIT_RAD = 2 * Math.PI; // the camera turns this far round the plant over a cycle
const AZ0_RAD = 0.2; // where the first cycle's orbit starts
const SLOT_M = 0.72; // spacing of the bed
const NEAR_SLOTS = 6; // neighbours kept either side; the outer ones are lost in the paper
const GONE_M = 3.7; // past this from the plant in view, everything has faded to paper
const POOL = 6; // the plant growing, the next, and the dried ones behind
const PREVS = 4;
const NEIGHBOURS = 12;
const FLY_S = 7; // the seed's drift to the soil
const SHADOW_DIV = 2; // the shadow mask renders at half the size
const LEAN_RAD = 0.35; // how far the pointer can lean the sun, about 20°
const LEAN_S = 0.8; // and how gently
const HUD_MS = 120;
const SLOW_MS = 24; // frames slower than this lower the resolution
const MIN_SCALE = 0.6;
const CAM = {
  rosette: 0.7, // the rosette's frame, m, against 0.86 before
  wide: 0.22, // how much wider the frame opens mid-climb
  crown: 0.85, // how far it closes in on the crown, 0 to 1
  crane: 0.12, // rise past the end of the bed, rad
};
const DIE_S = 6; // the old stalk's going, once the seed is down
const FALL_RAD = 1.45; // how far over it lies
const SWAY_K = (2 * Math.PI * 0.55) ** 2;
const SWAY_C = 2 * 0.16 * Math.sqrt(SWAY_K);
const SHAKE_S = 0.22; // a click's push lasts this long, then the stalk rings on its spring
const SHAKE_RAD = 0.24; // how far a shake leans it; less before seed
const SWAY_MAX_RAD = 0.36; // repeated shakes never lean it further than this

export type Hud = {
  day: number;
  cm: number;
  temp: number;
  hours: number;
  stage: Stage | "Drifting";
  resting: boolean;
  ripe: boolean;
  // the plant's box on screen, css px
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

// one plant's buffers on the gpu
type Slot = {
  tex: WebGLTexture;
  leafVao: WebGLVertexArrayObject;
  leafBuf: WebGLBuffer;
  headVao: WebGLVertexArrayObject;
  floretVao: WebGLVertexArrayObject;
  headBuf: WebGLBuffer;
  seedVao: WebGLVertexArrayObject;
  seedBuf: WebGLBuffer;
};

type Target = { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number };

export class Garden {
  onShown: () => void = () => {};
  onHud: (h: Hud) => void = () => {};

  private gl: WebGL2RenderingContext;
  private parallel: boolean;
  private passes: Pass[];
  private bgP: Pass;
  private groundP: Pass;
  private tubeP: Pass;
  private leafP: Pass;
  private headP: Pass;
  private floretP: Pass;
  private seedP: Pass;
  private softP: Pass;
  private linked = false;
  private vaos: WebGLVertexArrayObject[] = [];
  private bufs: WebGLBuffer[] = [];
  private texs: WebGLTexture[] = [];
  private bgVao: WebGLVertexArrayObject;
  private groundVao: WebGLVertexArrayObject;
  private tubeVao: WebGLVertexArrayObject;
  private leafIdx: WebGLBuffer;
  private leafIdxLo: WebGLBuffer;
  private leafLoN: number;
  private headIdx: WebGLBuffer;
  private gpu: Slot[] = [];
  private nbVao: WebGLVertexArrayObject;
  private nbBuf: WebGLBuffer;
  private heroVao: WebGLVertexArrayObject;
  private heroBuf: WebGLBuffer;
  private shA: Target | null = null;
  private shB: Target | null = null;

  // PLANTS
  // a pool: the one growing, the next one already up in its gap, the dried ones behind;
  // and the calm rosettes of the bed. nothing is made or let go where it can be seen
  private pool: Plant[] = [];
  private cur = 0;
  private next = -1;
  private prev = new Int8Array(PREVS).fill(-1);
  private curSlot = 0;
  private slotOf = new Int32Array(POOL);
  private gNext = G0_D;
  private nbPlants: Plant[] = [];
  private nbLeaves = new Float32Array(NEIGHBOURS * MAX_NODES * LEAF_STRIDE);
  private nbN = 0;
  private seed: number;
  // the old stalk on its way out: drying to straw, lying down, going into the soil
  private dying = -1;
  private dieT = 0;
  private dieX = 1;
  private straw = 0;
  private strawOn = 0; // straw for the plant being drawn

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
  private slow = 0;
  private frames = 0;

  // CLOCK
  private g = 0;
  private t = 0;
  private rate = 0;
  private boost = 0;
  private cycles = 0;
  private resting = false;
  private blowAt = 0;
  private at: string;
  private cycAz = AZ0_RAD;
  private cycDir = 1;
  private cycG0 = 0; // the day this cycle's orbit set out from

  // DRIFT
  // one seed carried from the old plant to the soil, the camera with it
  private flying = false;
  private flyT = 0;
  private path = new Float32Array(12);
  private landSlot = 0;
  private hero = new Float32Array(SEED_STRIDE);
  private heroOn = 0;
  private fromT = new Float32Array(3);
  private fromDist = 1;
  private fromEl = 0.2;
  private fromNear = 0;

  // SUN
  // where the pointer last was; before any, high on the left
  private sunX = -1;
  private hover = false;
  private sun = new Float32Array([-0.62, 0.62, 0.32]);
  private heat = 0;
  private warm = 0;
  private lean = 0;
  // screen fractions the type takes at the top and the bottom; the scene keeps clear of them
  private resT = 0;
  private resB = 0;

  // WIND
  private gust = 0;
  private breeze = 0;
  private sign = 1;
  private toward = 0.2;
  private sx = 0;
  private sz = 0;
  private vx = 0;
  private vz = 0;
  private wx = 1;
  private wz = 0;
  private kick = 0; // a shake's push still to run, s
  private kx = 0;
  private kz = 0;
  private kAcc = 0;
  private kSide = 1;

  // CAMERA
  private viewProj = new Float32Array(16);
  private view = new Float32Array(16);
  private proj = new Float32Array(16);
  private eye = new Float32Array(3);
  private focus = new Float32Array(3);
  private focal = 1;
  private top = 0; // the plant's top, eased so a gust never jolts the frame
  private az = 0;
  private dist = 1;
  private frm = new Float32Array(6);
  private el = 0.4;
  private near = 0; // how close in on the crown, for the depth of field

  private hudAt = -1e9;
  private hud: Hud = {
    day: 1,
    cm: 0,
    temp: 0,
    hours: 0,
    stage: "Rosette",
    resting: false,
    ripe: false,
    x0: 0,
    y0: 0,
    x1: 0,
    y1: 0,
  };
  private scr = new Float32Array(2);

  constructor(
    private canvas: HTMLCanvasElement | OffscreenCanvas,
    opts: Opts,
  ) {
    this.reduced = opts.reducedMotion;
    this.hold = opts.hold;
    this.at = opts.at;
    this.seed = opts.seed || (Math.random() * 1e9) | 0;
    const gl = canvas.getContext("webgl2", {
      antialias: true,
      alpha: false,
      depth: true,
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
    this.bgP = pass(gl, BG_VS, BG_FS);
    this.groundP = pass(gl, GROUND_VS, GROUND_FS);
    this.tubeP = pass(gl, TUBE_VS, TUBE_FS);
    this.leafP = pass(gl, LEAF_VS, LEAF_FS);
    this.headP = pass(gl, HEAD_VS, HEAD_FS);
    this.floretP = pass(gl, FLORET_VS, FLORET_FS);
    this.seedP = pass(gl, SEED_VS, SEED_FS);
    this.softP = pass(gl, BG_VS, SOFT_FS);
    this.passes = [
      this.bgP,
      this.groundP,
      this.tubeP,
      this.leafP,
      this.headP,
      this.floretP,
      this.seedP,
      this.softP,
    ];

    this.bgVao = this.vao();
    this.groundVao = this.vao();
    this.buffer(new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.attr(0, 2, 8, 0, 0);
    this.tubeVao = this.vao();
    this.index(grid(SPINE_N, TUBE_SIDES + 1));
    gl.bindVertexArray(null);
    this.leafIdx = this.index(grid(LEAF_GV, LEAF_GU));
    // a coarse leaf for the shaft mask, every fourth vertex along and every other across
    const lo = gridSub(LEAF_GV, LEAF_GU, 2, 4);
    this.leafLoN = lo.length;
    this.leafIdxLo = this.index(lo);
    this.headIdx = this.index(grid(HEAD_RINGS, HEAD_SIDES + 1));

    // PER PLANT
    for (let i = 0; i < POOL; i++) {
      const tex = gl.createTexture();
      this.texs.push(tex);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, SPINE_N, ROWS);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      const leafVao = this.vao();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.leafIdx);
      const leafBuf = this.buffer(MAX_NODES * LEAF_STRIDE * 4, gl.DYNAMIC_DRAW);
      this.leafAttrs();
      const headVao = this.vao();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.headIdx);
      const headBuf = this.buffer(MAX_HEADS * HEAD_STRIDE * 4, gl.DYNAMIC_DRAW);
      this.headAttrs(1);
      const floretVao = this.vao();
      gl.bindBuffer(gl.ARRAY_BUFFER, headBuf);
      this.headAttrs(FLORETS);
      const seedVao = this.vao();
      const seedBuf = this.buffer(MAX_SEEDS * SEED_STRIDE * 4, gl.DYNAMIC_DRAW);
      this.seedAttrs();
      this.gpu.push({ tex, leafVao, leafBuf, headVao, floretVao, headBuf, seedVao, seedBuf });
    }

    // NEIGHBOURS and the drifting seed
    this.nbVao = this.vao();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.leafIdx);
    this.nbBuf = this.buffer(this.nbLeaves.byteLength, gl.DYNAMIC_DRAW);
    this.leafAttrs();
    this.heroVao = this.vao();
    this.heroBuf = this.buffer(SEED_STRIDE * 4, gl.DYNAMIC_DRAW);
    this.seedAttrs();
    gl.bindVertexArray(null);

    for (let i = 0; i < POOL; i++) this.pool.push(new Plant(this.seed + i));
    for (let i = 0; i < NEIGHBOURS; i++) this.nbPlants.push(new Plant(i + 1));
    this.pool[0].reseed(this.seed);
    this.slotOf[0] = 0;
    this.weather();
    this.sow();
    this.neighbours();
    this.start();
  }

  // GL SETUP
  private vao() {
    const v = this.gl.createVertexArray();
    this.gl.bindVertexArray(v);
    this.vaos.push(v);
    return v;
  }

  private buffer(data: Float32Array | number, usage: number) {
    const gl = this.gl;
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    if (typeof data === "number") gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    else gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    this.bufs.push(b);
    return b;
  }

  private index(data: Uint16Array) {
    const gl = this.gl;
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data, gl.STATIC_DRAW);
    this.bufs.push(b);
    return b;
  }

  private attr(slot: number, size: number, stride: number, off: number, div: number) {
    const gl = this.gl;
    gl.enableVertexAttribArray(slot);
    gl.vertexAttribPointer(slot, size, gl.FLOAT, false, stride, off);
    gl.vertexAttribDivisor(slot, div);
  }

  private leafAttrs() {
    const ls = LEAF_STRIDE * 4;
    this.attr(0, 3, ls, 0, 1);
    this.attr(1, 3, ls, 12, 1);
    this.attr(2, 3, ls, 24, 1);
    this.attr(3, 4, ls, 36, 1);
    this.attr(4, 4, ls, 52, 1);
    this.attr(5, 4, ls, 68, 1);
  }

  private headAttrs(div: number) {
    const hs = HEAD_STRIDE * 4;
    this.attr(0, 3, hs, 0, div);
    this.attr(1, 3, hs, 12, div);
    this.attr(2, 4, hs, 24, div);
    this.attr(3, 4, hs, 40, div);
  }

  private seedAttrs() {
    const ss = SEED_STRIDE * 4;
    this.attr(0, 3, ss, 0, 1);
    this.attr(1, 3, ss, 12, 1);
    this.attr(2, 4, ss, 24, 1);
  }

  private target(w: number, h: number): Target {
    const gl = this.gl;
    const tex = gl.createTexture();
    const fbo = gl.createFramebuffer();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w, h };
  }

  private free(t: Target | null) {
    if (!t) return;
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fbo);
  }

  // where the first frame begins: ?at, the flowers under reduced motion, else the rosette
  private start() {
    const p = this.pool[this.cur];
    if (this.at === "fly") this.g = END_D;
    else if (this.at) this.g = p.stageDay(this.at);
    else this.g = this.reduced ? p.stageDay("flower") : 0;
    this.cycG0 = this.g;
  }

  // BED
  // slot i of the long bed: two rosettes, then a gap where a seed can take
  private slotX(i: number) {
    return i * SLOT_M;
  }

  private slotZ(i: number) {
    return (hash(i * 7.1) - 0.5) * 0.1;
  }

  private planted(i: number) {
    return ((i % 3) + 3) % 3 !== 0;
  }

  private isPlant(i: number) {
    if (i === this.curSlot) return true;
    for (let k = 0; k < PREVS; k++)
      if (this.prev[k] >= 0 && this.slotOf[this.prev[k]] === i) return true;
    return false;
  }

  // the neighbours' leaves, posed once whenever the bed in view changes; those added or
  // dropped are always past GONE_M, already lost in the paper
  private neighbours() {
    // around both the plant in view and the gap its seed is bound for
    const lo = Math.min(this.curSlot, this.landSlot);
    const hi = Math.max(this.curSlot, this.landSlot);
    let n = 0;
    let j = 0;
    for (let i = lo - NEAR_SLOTS; i <= hi + NEAR_SLOTS && j < NEIGHBOURS; i++) {
      if (!this.planted(i)) continue;
      const p = this.nbPlants[j++];
      p.ox = this.slotX(i);
      p.oz = this.slotZ(i);
      p.reseed(((hash(i * 1.3) * 1e9) | 0) + 11);
      p.pose(2 + hash(i * 5.3) * 6, 0, 0, 0, 0);
      this.nbLeaves.set(p.leaves.subarray(0, p.leafN * LEAF_STRIDE), n * LEAF_STRIDE);
      n += p.leafN;
    }
    this.nbN = n;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nbBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.nbLeaves, 0, n * LEAF_STRIDE);
  }

  // each cycle its own prevailing wind: along the bed toward the nearest free gap, away from
  // where the camera ends up when there's a choice
  private weather() {
    const c = this.curSlot;
    const d = this.cycDir;
    let land = c - 3 * d;
    if (this.isPlant(land)) land = c + 3 * d;
    if (this.isPlant(land)) land = c - 6 * d;
    this.landSlot = land;
    this.sign = land < c ? -1 : 1;
    this.toward = -0.25 + (((this.seed >>> 4) % 1000) / 1000) * 0.5;
    this.wx = this.sign * 0.95;
    this.wz = this.toward;
    const l = Math.hypot(this.wx, this.wz);
    this.wx /= l;
    this.wz /= l;
  }

  // the next plant comes up in the landing gap from the start of the cycle, from bare soil
  private sow() {
    let n = -1;
    for (let i = 0; i < POOL && n < 0; i++) if (!this.inUse(i)) n = i;
    if (n < 0) n = this.dropFarthest();
    this.next = n;
    const p = this.pool[n];
    p.ox = this.slotX(this.landSlot);
    p.oz = this.slotZ(this.landSlot);
    p.reseed((this.seed * 1664525 + 1013904223) >>> 0);
    this.slotOf[n] = this.landSlot;
    this.gNext = G0_D;
  }

  private inUse(i: number) {
    if (i === this.cur || i === this.next) return true;
    for (let k = 0; k < PREVS; k++) if (this.prev[k] === i) return true;
    return false;
  }

  // the dried stalk furthest from view gives up its place, by then long gone into the paper
  private dropFarthest() {
    let best = -1;
    let far = -1;
    for (let k = 0; k < PREVS; k++) {
      const i = this.prev[k];
      if (i < 0) continue;
      const d = Math.abs(this.slotOf[i] - this.landSlot) + Math.abs(this.slotOf[i] - this.curSlot);
      if (d > far) {
        far = d;
        best = k;
      }
    }
    const i = this.prev[best];
    this.prev[best] = -1;
    return i;
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

  // the title's and the hud's boxes, css px: the bed is framed in the band between them
  keepOut(
    _ax: number,
    ay: number,
    aw: number,
    ah: number,
    _bx: number,
    by: number,
    bw: number,
    bh: number,
  ) {
    const H = this.cssH;
    this.resT = 0;
    this.resB = 0;
    if (aw > 0) this.reserve(ay, ah, H);
    if (bw > 0) this.reserve(by, bh, H);
    this.wake();
  }

  private reserve(y: number, h: number, H: number) {
    if (y + h / 2 < H / 2) this.resT = Math.max(this.resT, (y + h) / H);
    else this.resB = Math.max(this.resB, 1 - y / H);
  }

  // INPUT
  // the sun leans toward the pointer wherever it hovers; a touch leaves it leaning there
  press(x: number, _y: number) {
    this.sunX = x;
    this.hover = true;
    this.wake();
  }

  move(x: number, _y: number) {
    this.sunX = x;
    this.hover = true;
    this.wake();
  }

  lift(tap: boolean, x: number) {
    if (tap) this.shake(x);
  }

  leave() {
    this.hover = false;
    this.wake();
  }

  // scrolling hurries the summer; it never runs it back
  wheel(px: number) {
    if (this.hold) return;
    this.touch();
    this.boost = Math.min(BOOST_MAX_D, this.boost + Math.abs(px) * BOOST_PER_PX);
    this.wake();
  }

  key(k: string) {
    if (k === "Enter" || k === " ") this.shake(this.kSide > 0 ? 0 : this.cssW);
    else this.wheel(240);
  }

  private touch() {
    this.cycles = 0;
    this.resting = false;
  }

  // GUST
  // a quick tap blows away from the side you tapped and takes ripe seed with it
  private blow(x: number) {
    const s = this.reduced ? 0.45 : 1;
    const side = x < this.cssW * 0.5 ? 1 : -1;
    this.wx = Math.cos(this.az) * side;
    this.wz = -Math.sin(this.az) * side;
    this.gust = s;
    this.vx += this.wx * 0.55 * s;
    this.vz += this.wz * 0.55 * s;
    this.pool[this.cur].blow(this.g, s);
    this.wake();
  }

  // SHAKE
  // a click pushes the stalk away from the side you clicked, briefly, and it rings on its
  // spring; in seed each shake shakes a burst of seed loose. never leans past SWAY_MAX_RAD
  private shake(x: number) {
    const p = this.pool[this.cur];
    const ripe = !this.flying && p.loose > 0;
    const s = this.reduced ? 0.45 : 1;
    const cx = (this.hud.x0 + this.hud.x1) / 2 || this.cssW / 2;
    this.kSide = x < cx ? 1 : -1;
    this.kx = Math.cos(this.az) * this.kSide;
    this.kz = -Math.sin(this.az) * this.kSide;
    const w = Math.sqrt(SWAY_K);
    const now = Math.sqrt(
      this.sx * this.sx + this.sz * this.sz + (this.vx * this.vx + this.vz * this.vz) / (w * w),
    );
    const amp = Math.min(SHAKE_RAD * (ripe ? 1 : 0.55) * s, Math.max(0, SWAY_MAX_RAD - now));
    // the push whose impulse leans it by amp
    this.kAcc = (amp * w * Math.PI) / (2 * SHAKE_S);
    this.kick = SHAKE_S;
    this.gust = Math.max(this.gust, (ripe ? 0.45 : 0.12) * s);
    if (ripe) p.shake(this.g);
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
      for (const p of this.passes) if (this.parallel && busy(gl, p)) return this.wake();
      for (const p of this.passes) finish(gl, p);
      this.linked = true;
    }
    if (!this.sized) this.resize();
    const rawMs = this.last ? now - this.last : 0;
    const dt = this.last ? Math.min(MAX_DT_S, Math.max(0, rawMs) / 1000) : 0;
    this.last = now;
    this.t += dt;
    const wantFly = !this.drawn && this.at === "fly";
    if (!this.drawn && this.at === "blow") this.blowAt = now + 500;
    if (this.blowAt && now >= this.blowAt) {
      this.blowAt = 0;
      this.blow(this.cssW * 0.15);
    }

    // CLOCK
    // always on its way at the summer's pace; scrolling adds a push that eases back off
    const p = this.pool[this.cur];
    const auto = !this.reduced && !this.hold && !this.resting;
    this.boost *= Math.exp(-dt / BOOST_TAU_S);
    if (this.boost < 0.01) this.boost = 0;
    let goal = (auto ? AUTO_RATE_D : 0) + this.boost;
    if (this.g < 0) goal *= SPROUT_X;
    if (this.flying || this.g >= END_D) goal = 0;
    this.rate += (goal - this.rate) * (1 - Math.exp(-dt / RATE_TAU_S));
    if (this.rate < 1e-3 && goal === 0) this.rate = 0;
    this.g = Math.min(END_D, this.g + this.rate * dt);
    if (!this.flying && this.g >= END_D && (auto || this.boost > 0)) this.takeOff();
    if (auto && this.cycles >= AUTO_CYCLES && this.g >= p.stageDay("puff") + 1) {
      this.resting = true;
    }

    // SUN
    // the light goes from cool to warm as the days lengthen, and a little warmer when hurried
    const heatGoal = Math.min(1, this.boost / 4);
    this.heat += (heatGoal - this.heat) * (1 - Math.exp(-dt / 1.2));
    this.warm = Math.min(1, 0.15 + 0.55 * smooth(-40, 40, this.g) + 0.2 * this.heat);
    const sunMoving = this.aimSun(dt);

    // WIND
    // a light breeze while it lives, gusts on top; the plant leans on a spring
    const bGoal = auto
      ? 0.6 + 0.25 * Math.sin(this.t * 0.41) + 0.15 * Math.sin(this.t * 1.13 + 1)
      : 0;
    this.breeze += (bGoal - this.breeze) * (1 - Math.exp(-dt / 1.5));
    if (this.breeze < 1e-3 && !auto) this.breeze = 0;
    this.gust *= Math.exp(-dt / 1.3);
    if (this.gust < 0.002) this.gust = 0;
    const push = this.breeze * 0.03 + this.gust * 0.2;
    const steps = dt > 0 ? 2 : 0;
    for (let i = 0; i < steps; i++) {
      const h = dt / steps;
      let ka = 0;
      if (this.kick > 0) {
        ka = this.kAcc * Math.sin((Math.PI * (SHAKE_S - this.kick)) / SHAKE_S);
        this.kick = Math.max(0, this.kick - h);
      }
      this.vx += (SWAY_K * (this.wx * push - this.sx) - SWAY_C * this.vx + ka * this.kx) * h;
      this.vz += (SWAY_K * (this.wz * push - this.sz) - SWAY_C * this.vz + ka * this.kz) * h;
      this.sx += this.vx * h;
      this.sz += this.vz * h;
    }
    const swaying =
      Math.abs(this.vx) + Math.abs(this.vz) > 2e-4 || Math.abs(this.sx) + Math.abs(this.sz) > 2e-4;
    if (!swaying && !auto && !this.gust && !this.kick) this.sx = this.sz = this.vx = this.vz = 0;

    // POSE
    const wind = this.breeze * 0.25 + this.gust;
    // NOD
    // the tip's sweep runs on real time once hurried, so a fast summer never whips it round
    if (Number.isNaN(p.nutAt)) p.nutAt = nutOf(this.g);
    p.nutAt += nutOf(Math.min(this.rate, NUT_MAX_D) * dt);
    p.pose(this.g, this.sx, this.sz, this.t, wind);
    p.seeds(this.g, dt, this.t, this.wx, this.wz, this.breeze, this.gust);
    // the next one, a seedling in its gap, a fortnight on by the time the seed comes down
    this.gNext = G0_D + NEXT_D * smooth(-20, END_D, this.g);
    const q = this.pool[this.next];
    q.pose(this.gNext, 0, 0, this.t, wind);
    let airborne = p.flying;
    for (let i = 0; i < PREVS; i++) {
      const r = this.prev[i];
      if (r < 0 || r === this.dying || !this.pool[r].flying) continue;
      this.pool[r].seeds(END_D, dt, this.t, this.wx, this.wz, this.breeze, this.gust);
      airborne += this.pool[r].flying;
    }
    if (wantFly) {
      this.camera();
      this.takeOff();
    }
    if (this.flying) this.drift(dt);
    else if (this.heroOn > 0) this.heroOn = Math.max(0, this.heroOn - dt / 3);
    if (this.dying >= 0) this.wither(dt);

    this.adapt(rawMs, auto);
    // the plant in view, which a landing this frame has just handed on
    const c = this.pool[this.cur];
    const top = Math.max(c.heightAt(this.g), c.top);
    const prevTop = this.top;
    this.top = this.drawn ? this.top + (top - this.top) * (1 - Math.exp(-dt / 0.3)) : top;
    this.camera();
    this.render(wind);
    if (!this.drawn) {
      this.drawn = true;
      this.onShown();
    }
    this.report(now);

    // SLEEP
    // nothing running, swaying, drifting or settling: wait for input
    const busyNow =
      this.rate > 0 ||
      auto ||
      this.boost > 0 ||
      this.flying ||
      swaying ||
      sunMoving ||
      this.gust > 0 ||
      this.breeze > 0 ||
      airborne > 0 ||
      this.heroOn > 0 ||
      this.blowAt > 0 ||
      this.kick > 0 ||
      this.dying >= 0 ||
      Math.abs(this.heat - heatGoal) > 1e-3 ||
      Math.abs(top - prevTop) > 1e-4;
    if (busyNow) this.wake();
    else {
      this.last = 0;
      this.hudAt = -1e9;
      this.report(now);
    }
  };

  // SUN
  // up in the sky behind the plant, out of frame: over a cycle it climbs as the days lengthen
  // and swings from one side to the other; the pointer leans it by at most LEAN_RAD
  private aimSun(dt: number) {
    const prog = (this.g - G0_D) / (END_D - G0_D);
    const h0 = this.cycDir > 0 ? mix(-1.0, 0.85, prog) : mix(0.85, -1.0, prog);
    const goal = this.hover && this.sunX >= 0 ? ((this.sunX / this.cssW) * 2 - 1) * LEAN_RAD : 0;
    const r = this.drawn ? 1 - Math.exp(-dt / LEAN_S) : 1;
    this.lean += (goal - this.lean) * r;
    const h = h0 + this.lean;
    const e = mix(0.42, 0.78, smooth(-40, 40, this.g));
    const az = this.az;
    const ce = Math.cos(e);
    // across the frame by h, and back behind the plant, so leaves glow and shadows fall forward
    const a = Math.sin(h) * ce;
    const b = -Math.cos(h) * ce * 0.4;
    let x = Math.cos(az) * a + Math.sin(az) * b;
    let y = Math.sin(e);
    let z = -Math.sin(az) * a + Math.cos(az) * b;
    const l = Math.hypot(x, y, z) || 1;
    x /= l;
    y /= l;
    z /= l;
    const S = this.sun;
    const d = Math.abs(x - S[0]) + Math.abs(y - S[1]) + Math.abs(z - S[2]);
    S[0] += (x - S[0]) * r;
    S[1] += (y - S[1]) * r;
    S[2] += (z - S[2]) * r;
    const m = Math.hypot(S[0], S[1], S[2]) || 1;
    S[0] /= m;
    S[1] /= m;
    S[2] /= m;
    return d > 1e-3 || Math.abs(goal - this.lean) > 1e-3;
  }

  // TAKE OFF
  // the last seed leaves the crown for the gap where the next plant is coming up
  private takeOff() {
    const p = this.pool[this.cur];
    this.flying = true;
    this.flyT = 0;
    this.rate = 0;
    this.boost = 0;
    const land = this.landSlot;
    const s = p.spine;
    const o = (SPINE_N - 1) * 4;
    const P = this.path;
    const lx = this.slotX(land);
    const lz = this.slotZ(land);
    P[0] = s[o];
    P[1] = s[o + 1] + 0.02;
    P[2] = s[o + 2];
    P[3] = P[0] + this.sign * 0.35;
    P[4] = P[1] + 0.2;
    P[5] = P[2] + this.toward * 0.3;
    P[6] = lx - this.sign * 0.3;
    P[7] = 0.36;
    P[8] = lz + 0.1;
    // it comes down just beside the seedling, a little toward the eye
    P[9] = lx - this.sign * 0.05;
    P[10] = 0.006;
    P[11] = lz + 0.07;
    this.fromT[0] = this.focus[0];
    this.fromT[1] = this.focus[1];
    this.fromT[2] = this.focus[2];
    this.fromDist = this.dist;
    this.fromEl = this.el;
    this.fromNear = this.near;
    this.heroOn = 1;
    this.neighbours();
  }

  private drift(dt: number) {
    this.flyT += dt;
    const s = Math.min(1, this.flyT / FLY_S);
    const e = 0.5 - 0.5 * Math.cos(Math.PI * s);
    const P = this.path;
    const u = 1 - e;
    const a = u * u * u;
    const b = 3 * u * u * e;
    const c = 3 * u * e * e;
    const d = e * e * e;
    const fl = Math.sin(Math.PI * s);
    const H = this.hero;
    H[0] = a * P[0] + b * P[3] + c * P[6] + d * P[9] + 0.03 * fl * Math.sin(this.t * 2.9);
    H[1] = a * P[1] + b * P[4] + c * P[7] + d * P[10] + 0.025 * fl * Math.sin(this.t * 2.1 + 1);
    H[2] = a * P[2] + b * P[5] + c * P[8] + d * P[11] + 0.03 * fl * Math.sin(this.t * 1.7 + 2);
    // pappus up, rocking as it floats; settled at a slant in the soil
    const r = 0.35 * fl;
    H[3] = Math.cos(this.t * 1.9) * r + 0.25 * (1 - fl) * this.sign;
    H[4] = 1;
    H[5] = Math.sin(this.t * 1.9) * r;
    const l = Math.hypot(H[3], H[4], H[5]);
    H[3] /= l;
    H[4] /= l;
    H[5] /= l;
    H[6] = 0.02;
    H[7] = 0.017;
    H[8] = 1;
    H[9] = 2.37;
    if (s >= 1) this.land();
  }

  // LAND
  // the seedling in the gap takes over; the old plant stays behind, dried
  private land() {
    this.flying = false;
    if (this.prev[PREVS - 1] >= 0) this.dropFarthest();
    // keep the dried ones in order, newest first
    let w = 0;
    for (let k = 0; k < PREVS; k++) if (this.prev[k] >= 0) this.prev[w++] = this.prev[k];
    for (let k = w; k < PREVS; k++) this.prev[k] = -1;
    for (let k = PREVS - 1; k > 0; k--) this.prev[k] = this.prev[k - 1];
    this.prev[0] = this.cur;
    if (this.dying >= 0) this.bury();
    this.dying = this.cur;
    this.dieT = 0;
    // it lies down along the row, away from the seedling
    this.dieX = this.pool[this.cur].ox > this.slotX(this.landSlot) ? 1 : -1;
    this.cur = this.next;
    this.next = -1;
    this.curSlot = this.landSlot;
    this.g = this.gNext;
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    // the next orbit sets out from exactly where the drift left the camera
    this.cycDir = -this.cycDir;
    this.cycAz = this.az;
    this.cycG0 = this.g;
    this.cycles++;
    this.weather();
    this.sow();
    this.neighbours();
    this.top = this.pool[this.cur].top;
  }

  // all the way round over a cycle, eased in from rest and out to rest at take-off, so it
  // hands over to the drift and back without a jolt. the old stalk is gone long before the
  // camera comes round its end of the bed
  private azimuth() {
    const u = Math.min(1, Math.max(0, (this.g - this.cycG0) / Math.max(1, END_D - this.cycG0)));
    return this.cycAz - ORBIT_RAD * (0.5 - 0.5 * Math.cos(Math.PI * u));
  }

  // WITHER
  // the old stalk dries to straw, bends, tips over and lies down, then settles into the soil
  private wither(dt: number) {
    this.dieT += dt;
    const u = this.dieT / DIE_S;
    if (u >= 1) return this.bury();
    const p = this.pool[this.dying];
    this.straw = smooth(0, 0.35, u);
    const bend = 0.4 * smooth(0.05, 0.4, u) * this.dieX;
    // a slow lean that gives way, then comes to rest on the ground
    const tip = smooth(0.15, 0.6, u);
    const fall = FALL_RAD * tip * tip * (3 - 2 * tip);
    const go = smooth(0.55, 1, u);
    p.pose(END_D, bend, 0, this.t, 0);
    p.fell(fall, this.dieX, 0, 1 - go, 0.03 * go);
    p.seeds(END_D, dt, this.t, this.wx, this.wz, this.breeze, this.gust);
    this.upload(this.dying);
  }

  private bury() {
    for (let k = 0; k < PREVS; k++) if (this.prev[k] === this.dying) this.prev[k] = -1;
    this.dying = -1;
    this.straw = 0;
  }

  // QUALITY
  // a run of slow frames lowers the resolution
  private adapt(ms: number, moving: boolean) {
    if (!moving || ms <= 0 || ms > 200) return;
    this.frames++;
    if (ms > SLOW_MS) this.slow++;
    if (this.frames < 40) return;
    if (this.slow > 24 && this.scale > MIN_SCALE) {
      this.scale = Math.max(MIN_SCALE, this.scale * 0.85);
      this.sized = false;
    }
    this.frames = 0;
    this.slow = 0;
  }

  private resize() {
    const dpr = Math.min(this.dpr || 1, MAX_DPR) * this.scale;
    const W = Math.max(1, Math.round(this.cssW * dpr));
    const H = Math.max(1, Math.round(this.cssH * dpr));
    this.canvas.width = W;
    this.canvas.height = H;
    const w = Math.max(1, Math.ceil(W / SHADOW_DIV));
    const h = Math.max(1, Math.ceil(H / SHADOW_DIV));
    if (!this.shA || this.shA.w !== w || this.shA.h !== h) {
      this.free(this.shA);
      this.free(this.shB);
      this.shA = this.target(w, h);
      this.shB = this.target(w, h);
    }
    this.sized = true;
  }

  // CAMERA
  // close over the rosette, pulled back wide and low while the stalk shoots up, then in again
  // on the flowers and the seed heads; all the while turning round the plant. in the drift it
  // rides along with the seed
  private camera() {
    const aspect = this.cssW / this.cssH;
    const tanH = Math.tan(FOV_RAD / 2);
    // the band left free by the type: under the title on a phone, under the bar elsewhere
    const portrait = aspect < 0.8;
    const rt = Math.max(portrait ? 0.25 : 0.06, this.resT + 0.02);
    const rb = Math.max(portrait ? 0.09 : 0.01, this.resB + 0.01);
    const free = 1 - rt - rb;
    const sy = 1 - 2 * (rt + free / 2);
    if (!this.flying) this.az = this.azimuth();
    const F = this.frm;
    const p = this.pool[this.cur];
    let tx: number;
    let ty: number;
    let tz: number;
    let dist: number;
    let el: number;
    let near: number;
    if (this.flying) {
      // from the old framing, along with the seed, to exactly the framing the seedling
      // takes over with when it lands, so the handover never jumps
      const q = this.pool[this.next];
      this.framing(q, this.gNext, q.top, 0, portrait, free, aspect, tanH);
      const s = Math.min(1, this.flyT / FLY_S);
      const w1 = smooth(0, 0.3, s);
      const w2 = smooth(0.62, 1, s);
      const h = this.hero;
      const mid = Math.max(0.8 / 2 / tanH / free, 0.34 / (tanH * aspect));
      tx = mix(mix(this.fromT[0], h[0], w1), F[0], w2);
      ty = mix(mix(this.fromT[1], h[1] * 0.6, w1), F[1], w2);
      tz = mix(mix(this.fromT[2], h[2], w1), F[2], w2);
      dist = mix(mix(this.fromDist, mid, w1), F[3], w2);
      el = mix(mix(this.fromEl, 0.3, w1), F[4], w2);
      near = mix(this.fromNear * (1 - w1), F[5], w2);
    } else {
      this.framing(p, this.g, this.top, this.rate, portrait, free, aspect, tanH);
      tx = F[0];
      ty = F[1];
      tz = F[2];
      dist = F[3];
      el = F[4];
      near = F[5];
    }
    this.near = near;
    this.dist = dist;
    this.el = el;
    const f = this.focus;
    f[0] = tx;
    f[1] = ty;
    f[2] = tz;
    const az = this.az;
    const e = this.eye;
    e[0] = tx + dist * Math.cos(el) * Math.sin(az);
    e[1] = ty + dist * Math.sin(el);
    e[2] = tz + dist * Math.cos(el) * Math.cos(az);
    lookAt(this.view, e[0], e[1], e[2], tx, ty, tz);
    perspective(this.proj, FOV_RAD, aspect, dist * 0.05, dist * 4 + 6);
    mul(this.viewProj, this.proj, this.view);
    const m = this.viewProj;
    m[1] += sy * m[3];
    m[5] += sy * m[7];
    m[9] += sy * m[11];
    m[13] += sy * m[15];
    this.focal = (this.proj[5] * this.canvas.height) / 2;
  }

  // FRAMING
  // close over the rosette, wide while the stalk climbs, in on the crown; into frm as focus
  // x y z, distance, elevation and how close in on the crown
  private framing(
    p: Plant,
    g: number,
    top: number,
    rate: number,
    portrait: boolean,
    free: number,
    aspect: number,
    tanH: number,
  ) {
    const H = p.heightAt(g);
    const k = smooth(0.14, 0.75, H);
    // headroom grows with the pace, so a fast climb never outruns the frame
    const tall = Math.max(0.18, top + 0.03 + 0.04 * k + Math.min(0.12, rate * 0.03));
    const climb = 4 * k * (1 - k);
    // on a phone the hud runs right across the foot of the frame, so it only leans in
    const crown = CAM.crown * (portrait ? 0.3 : 1) * smooth(p.openD - 4, p.openD + 6, g);
    let span = Math.max(mix(CAM.rosette, 0.86, k), tall * (1.05 + 0.3 * (1 - k)));
    span *= 1 + CAM.wide * climb;
    // in on the crown: its top third, the lower stalk running out of the frame
    const ty = mix(mix(0.24, tall * 0.45, k), top * 0.72, crown);
    span = mix(span, top * 0.62, crown);
    const halfW =
      (portrait ? 0.4 : 0.34) *
      mix(1, CAM.rosette / 0.86, 1 - k) *
      (portrait ? 1 : 1 - 0.3 * crown);
    // up a little as it turns past the end of the bed, over the rosettes in front
    const end = Math.sin(this.az) ** 2;
    const F = this.frm;
    F[0] = p.ox;
    F[1] = ty;
    F[2] = p.oz;
    F[3] = Math.max(span / 2 / tanH / free, halfW / (tanH * aspect));
    F[4] = mix(0.42, 0.12, Math.min(1, k * 1.5)) + CAM.crane * end;
    F[5] = crown;
  }

  // RENDER
  private common(p: Pass, wind: number, mask: number) {
    const gl = this.gl;
    gl.useProgram(p.prog);
    const u = p.u;
    if (u.uViewProj) gl.uniformMatrix4fv(u.uViewProj, false, this.viewProj);
    if (u.uRes) gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
    if (u.uFade) gl.uniform1f(u.uFade, 1);
    if (u.uSun) gl.uniform3fv(u.uSun, this.sun);
    if (u.uEye) gl.uniform3fv(u.uEye, this.eye);
    if (u.uTime) gl.uniform1f(u.uTime, this.t % 1000);
    if (u.uWind) gl.uniform1f(u.uWind, wind);
    if (u.uWarm) gl.uniform1f(u.uWarm, this.warm);
    if (u.uFocus) gl.uniform3fv(u.uFocus, this.focus);
    if (u.uNear) gl.uniform1f(u.uNear, this.near);
    if (u.uStraw) gl.uniform1f(u.uStraw, this.strawOn);
    if (u.uMask) gl.uniform1f(u.uMask, mask);
    if (u.uCast) gl.uniform1f(u.uCast, mask);
  }

  // is a plant close enough to the view to be worth drawing at all
  private inView(i: number) {
    const p = this.pool[i];
    return Math.abs(p.ox - this.focus[0]) < GONE_M + 0.6;
  }

  private render(wind: number) {
    const gl = this.gl;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const A = this.shA;
    const B = this.shB;
    if (!A || !B) return;
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);

    // UPLOAD
    // the growing plants change every frame; the dried ones went up when they were left
    this.upload(this.cur);
    this.upload(this.next);

    // SHADOWS
    // every plant flattened onto the soil along the sun, coarse, then softened into a wash
    gl.bindFramebuffer(gl.FRAMEBUFFER, A.fbo);
    gl.viewport(0, 0, A.w, A.h);
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.drawLeaves(this.nbVao, this.nbN, wind, 1);
    for (let i = PREVS - 1; i >= 0; i--) {
      const r = this.prev[i];
      if (r >= 0 && this.inView(r)) this.drawDried(r, wind, 1);
    }
    this.drawPlant(this.next, wind, 1);
    this.drawPlant(this.cur, wind, 1);
    this.soften(A, B, 1.3, 0);
    this.soften(B, A, 0, 1.3);

    // PLATE
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.depthMask(true);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    this.common(this.bgP, wind, 0);
    gl.bindVertexArray(this.bgVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    // SOIL
    {
      const q = this.groundP;
      this.common(q, wind, 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, A.tex);
      gl.uniform1i(q.u.uShadowTex, 1);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindVertexArray(this.groundVao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // NEIGHBOURS and PLANTS
    gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    this.drawLeaves(this.nbVao, this.nbN, wind, 0);
    for (let i = PREVS - 1; i >= 0; i--) {
      const r = this.prev[i];
      if (r >= 0 && this.inView(r)) this.drawDried(r, wind, 0);
    }
    this.drawPlant(this.next, wind, 0);
    this.drawPlant(this.cur, wind, 0);
    gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);

    // SEEDS
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    const q = this.seedP;
    this.common(q, wind, 0);
    gl.uniform1f(q.u.uFocal, this.focal);
    for (let i = PREVS - 1; i >= 0; i--) {
      const r = this.prev[i];
      if (r >= 0 && this.inView(r)) this.drawSeeds(r);
    }
    this.drawSeeds(this.cur);
    if (this.heroOn > 0) {
      this.hero[8] = this.heroOn;
      gl.bindVertexArray(this.heroVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.heroBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.hero);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  // one blur pass from a to b, along the given step in texels
  private soften(a: Target, b: Target, sx: number, sy: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, b.fbo);
    const q = this.softP;
    gl.useProgram(q.prog);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, a.tex);
    gl.uniform1i(q.u.uTex, 1);
    gl.uniform2f(q.u.uStep, sx / a.w, sy / a.h);
    gl.uniform2f(q.u.uRes, b.w, b.h);
    gl.bindVertexArray(this.bgVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }

  private upload(i: number) {
    const gl = this.gl;
    const p = this.pool[i];
    const G = this.gpu[i];
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, G.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SPINE_N, ROWS, gl.RGBA, gl.FLOAT, p.spine);
    gl.bindBuffer(gl.ARRAY_BUFFER, G.leafBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, p.leaves, 0, p.leafN * LEAF_STRIDE);
    gl.bindBuffer(gl.ARRAY_BUFFER, G.headBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, p.headData, 0, p.headN * HEAD_STRIDE);
  }

  // leaves of one plant or of the whole bed; the shadow pass uses a coarse grid
  private drawLeaves(vao: WebGLVertexArrayObject, n: number, wind: number, mask: number) {
    if (!n) return;
    const gl = this.gl;
    const q = this.leafP;
    this.common(q, wind, mask);
    gl.bindVertexArray(vao);
    if (mask) {
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.leafIdxLo);
      gl.drawElementsInstanced(gl.TRIANGLES, this.leafLoN, gl.UNSIGNED_SHORT, 0, n);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.leafIdx);
    } else {
      const c = (LEAF_GU - 1) * (LEAF_GV - 1) * 6;
      gl.drawElementsInstanced(gl.TRIANGLES, c, gl.UNSIGNED_SHORT, 0, n);
    }
  }

  private drawDried(i: number, wind: number, mask: number) {
    this.strawOn = i === this.dying ? this.straw : 0;
    this.drawPlant(i, wind, mask);
    this.strawOn = 0;
  }

  private drawPlant(i: number, wind: number, mask: number) {
    const gl = this.gl;
    const p = this.pool[i];
    const G = this.gpu[i];
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, G.tex);

    // STEMS
    const q = this.tubeP;
    this.common(q, wind, mask);
    gl.uniform1i(q.u.uSpine, 0);
    gl.uniform1f(q.u.uDry, p.dry);
    gl.bindVertexArray(this.tubeVao);
    gl.uniform1i(q.u.uRow0, 0);
    gl.uniform1i(q.u.uRings, SPINE_N);
    gl.drawElementsInstanced(
      gl.TRIANGLES,
      (SPINE_N - 1) * TUBE_SIDES * 6,
      gl.UNSIGNED_SHORT,
      0,
      1 + p.branchN,
    );
    if (p.twigN) {
      gl.uniform1i(q.u.uRow0, TWIG_ROW);
      gl.uniform1i(q.u.uRings, TWIG_N);
      gl.drawElementsInstanced(
        gl.TRIANGLES,
        (TWIG_N - 1) * TUBE_SIDES * 6,
        gl.UNSIGNED_SHORT,
        0,
        p.twigN,
      );
    }

    // LEAVES
    this.drawLeaves(G.leafVao, p.leafN, wind, mask);

    // HEADS and FLORETS
    if (p.headN) {
      this.common(this.headP, wind, mask);
      gl.bindVertexArray(G.headVao);
      const n = (HEAD_RINGS - 1) * HEAD_SIDES * 6;
      gl.drawElementsInstanced(gl.TRIANGLES, n, gl.UNSIGNED_SHORT, 0, p.headN);
      this.common(this.floretP, wind, mask);
      gl.bindVertexArray(G.floretVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 18, p.headN * FLORETS);
    }
  }

  private drawSeeds(i: number) {
    const p = this.pool[i];
    if (!p.seedN) return;
    const gl = this.gl;
    const G = this.gpu[i];
    gl.bindVertexArray(G.seedVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, G.seedBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, p.seedData, 0, p.seedN * SEED_STRIDE);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, p.seedN);
  }

  // HUD
  // the day since the seed went in, the heat, the length of the day
  private report(now: number) {
    if (now - this.hudAt < HUD_MS) return;
    this.hudAt = now;
    const p = this.pool[this.cur];
    const h = this.hud;
    const g = this.g;
    const day = Math.floor(g - G0_D) + 1;
    const cm = Math.round(p.top * 100);
    const temp = Math.round(13 + 15 * smooth(-30, 50, g) + 3 * this.heat);
    const hours = Math.round((12.6 + 3.6 * smooth(-40, 40, g)) * 10) / 10;
    const stage = this.flying ? "Drifting" : p.stage(g);
    const ripe = !this.flying && p.loose > 0;
    // the box round the plant: its base either side and its top, padded
    const rx = Math.cos(this.az) * 0.2;
    const rz = -Math.sin(this.az) * 0.2;
    this.project(p.ox - rx, 0, p.oz - rz);
    let x0 = this.scr[0];
    let x1 = x0;
    let y1 = this.scr[1];
    this.project(p.ox + rx, 0, p.oz + rz);
    x0 = Math.min(x0, this.scr[0]);
    x1 = Math.max(x1, this.scr[0]);
    y1 = Math.max(y1, this.scr[1]);
    this.project(p.ox, p.top + 0.03, p.oz);
    const y0 = Math.round(this.scr[1]);
    x0 = Math.round(Math.min(x0, this.scr[0]));
    x1 = Math.round(Math.max(x1, this.scr[0]));
    y1 = Math.round(y1);
    if (
      h.day === day &&
      h.cm === cm &&
      h.temp === temp &&
      h.hours === hours &&
      h.stage === stage &&
      h.resting === this.resting &&
      h.ripe === ripe &&
      h.x0 === x0 &&
      h.y0 === y0 &&
      h.x1 === x1 &&
      h.y1 === y1
    )
      return;
    h.day = day;
    h.cm = cm;
    h.temp = temp;
    h.hours = hours;
    h.stage = stage;
    h.resting = this.resting;
    h.ripe = ripe;
    h.x0 = x0;
    h.y0 = y0;
    h.x1 = x1;
    h.y1 = y1;
    this.onHud(h);
  }

  // a world point to css px, into scr
  private project(x: number, y: number, z: number) {
    const m = this.viewProj;
    const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1e-6;
    this.scr[0] = ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w + 1) * 0.5 * this.cssW;
    this.scr[1] = (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) * 0.5 * this.cssH;
  }

  dispose() {
    this.dead = true;
    unraf(this.raf);
    this.raf = 0;
    const gl = this.gl;
    this.free(this.shA);
    this.free(this.shB);
    for (const t of this.texs) gl.deleteTexture(t);
    for (const p of this.passes) gl.deleteProgram(p.prog);
    for (const v of this.vaos) gl.deleteVertexArray(v);
    for (const b of this.bufs) gl.deleteBuffer(b);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

function hash(x: number) {
  const s = Math.sin(x * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

// a coarser triangle grid over the same vertices: every sr-th row and sc-th column, ends kept
function gridSub(rows: number, cols: number, sr: number, sc: number) {
  const rs: number[] = [];
  const cs: number[] = [];
  for (let r = 0; r < rows; r += sr) rs.push(r);
  if (rs[rs.length - 1] !== rows - 1) rs.push(rows - 1);
  for (let c = 0; c < cols; c += sc) cs.push(c);
  if (cs[cs.length - 1] !== cols - 1) cs.push(cols - 1);
  const out = new Uint16Array((rs.length - 1) * (cs.length - 1) * 6);
  let k = 0;
  for (let r = 0; r < rs.length - 1; r++) {
    for (let c = 0; c < cs.length - 1; c++) {
      const a = rs[r] * cols + cs[c];
      const b = rs[r + 1] * cols + cs[c];
      const a1 = rs[r] * cols + cs[c + 1];
      const b1 = rs[r + 1] * cols + cs[c + 1];
      out[k++] = a;
      out[k++] = b;
      out[k++] = a1;
      out[k++] = a1;
      out[k++] = b;
      out[k++] = b1;
    }
  }
  return out;
}

// a rows x cols vertex grid as triangles, rows along the first index
function grid(rows: number, cols: number) {
  const out = new Uint16Array((rows - 1) * (cols - 1) * 6);
  let k = 0;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + cols;
      out[k++] = a;
      out[k++] = b;
      out[k++] = a + 1;
      out[k++] = a + 1;
      out[k++] = b;
      out[k++] = b + 1;
    }
  }
  return out;
}

function perspective(out: Float32Array, fov: number, aspect: number, near: number, far: number) {
  const f = 1 / Math.tan(fov / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
}

function lookAt(
  out: Float32Array,
  ex: number,
  ey: number,
  ez: number,
  tx: number,
  ty: number,
  tz: number,
) {
  let zx = ex - tx;
  let zy = ey - ty;
  let zz = ez - tz;
  const zl = Math.hypot(zx, zy, zz) || 1;
  zx /= zl;
  zy /= zl;
  zz /= zl;
  // x = up × z
  let xx = zz;
  let xy = 0;
  let xz = -zx;
  const xl = Math.hypot(xx, xy, xz) || 1;
  xx /= xl;
  xy /= xl;
  xz /= xl;
  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;
  out[0] = xx;
  out[1] = yx;
  out[2] = zx;
  out[3] = 0;
  out[4] = xy;
  out[5] = yy;
  out[6] = zy;
  out[7] = 0;
  out[8] = xz;
  out[9] = yz;
  out[10] = zz;
  out[11] = 0;
  out[12] = -(xx * ex + xy * ey + xz * ez);
  out[13] = -(yx * ex + yy * ey + yz * ez);
  out[14] = -(zx * ex + zy * ey + zz * ez);
  out[15] = 1;
}

function mul(out: Float32Array, a: Float32Array, b: Float32Array) {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] +
        a[4 + r] * b[c * 4 + 1] +
        a[8 + r] * b[c * 4 + 2] +
        a[12 + r] * b[c * 4 + 3];
    }
  }
}

function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function mix(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
