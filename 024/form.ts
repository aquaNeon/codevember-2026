import { mulberry } from "./math";

// FORM
// a baya weaver's nest: a long twisted neck bound to the stem, swelling into a pear-shaped
// chamber with a round doorway low on one side. it is a surface of revolution round a
// vertical spine, s from the stem (0) to the bottom of the belly (1). every strand is a path
// on it, sixteen floats the vertex shader turns into a flat ribbon; the shape is written
// here and in glsl (SHAPE_GLSL), the doorway in glsl only, as a push out of its disc

export const STRIDE = 16;
export const TOP_Y = 1.16; // where the neck is bound to the stem
export const HEIGHT = 2.36;
export const WIN = 0.03; // how much of the build one strand takes to thread in
export const SEG = 40; // along a strand
export const FINE_SEG = 18; // along a fine one, which is short and thin
export const NECK_N = 110;
export const RING_N = 18;
export const DOOR_N = 150;
export const FINE_N = 3300; // shredded grass, thin as hair
export const BLADE_N = 150; // a few broad strips among it
export const WEAVE_N = DOOR_N + FINE_N + BLADE_N;

const BODY = { c: 0.69, top: 0.43, bot: 0.31, r: 0.6 }; // the chamber, a pear in s
export const DOOR = { s: 0.82, ph: 1.32, r: 0.29, band: 0.15 }; // the doorway and its edge
const Z_SQUASH = 0.95;
const TAU = Math.PI * 2;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const smax = (a: number, b: number, k: number) => {
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.max(a, b) + h * h * k * 0.25;
};

export function radius(s: number) {
  const q = (s - BODY.c) / (s < BODY.c ? BODY.top : BODY.bot);
  const k = Math.max(0, 1 - q * q);
  // the top of the pear draws out into the neck
  const body = BODY.r * Math.pow(k, s < BODY.c ? 0.85 : 0.5);
  const neck = 0.034 + 0.05 * smoothstep(0.04, 0.3, s);
  return Math.max(0.03, smax(body, neck, 0.08));
}

// a hand-made shape is never quite round
const lump = (s: number, ph: number) =>
  1 + 0.04 * Math.sin(3 * ph + 7 * s) + 0.03 * Math.sin(5 * ph - 11 * s + 1);

export const spineX = (s: number) => 0.05 * Math.sin(s * 3.2) - 0.02;
export const spineY = (s: number) => TOP_Y - HEIGHT * s;

export function surf(s: number, ph: number, o: Float32Array) {
  s = Math.min(0.995, Math.max(0, s));
  const r = radius(s) * lump(s, ph);
  o[0] = spineX(s) + r * Math.cos(ph);
  o[1] = spineY(s);
  o[2] = r * Z_SQUASH * Math.sin(ph);
  return o;
}

// the doorway in surface units: world per unit of s down the side, and the radius there
const probe = new Float32Array(3);
const probe2 = new Float32Array(3);
surf(DOOR.s - 0.004, DOOR.ph, probe);
surf(DOOR.s + 0.004, DOOR.ph, probe2);
const DOOR_SPD =
  Math.hypot(probe2[0] - probe[0], probe2[1] - probe[1], probe2[2] - probe[2]) / 0.008;
const DOOR_R = radius(DOOR.s);

const f = (n: number) => n.toFixed(5);

export const SHAPE_GLSL = `
float sstep(float a, float b, float x) { float t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float smax(float a, float b, float k) { float h = max(k - abs(a - b), 0.0) / k; return max(a, b) + h * h * k * 0.25; }
float radiusAt(float s) {
  bool up = s < ${f(BODY.c)};
  float q = (s - ${f(BODY.c)}) / (up ? ${f(BODY.top)} : ${f(BODY.bot)});
  float k = max(0.0, 1.0 - q * q);
  float body = ${f(BODY.r)} * pow(k, up ? 0.85 : 0.5);
  float neck = 0.034 + 0.05 * sstep(0.04, 0.3, s);
  return max(0.03, smax(body, neck, 0.08));
}
vec3 surf(float s, float ph) {
  s = clamp(s, 0.0, 0.995);
  float r = radiusAt(s) * (1.0 + 0.04 * sin(3.0 * ph + 7.0 * s) + 0.03 * sin(5.0 * ph - 11.0 * s + 1.0));
  return vec3(0.05 * sin(s * 3.2) - 0.02 + r * cos(ph), ${f(TOP_Y)} - ${f(HEIGHT)} * s, r * ${f(Z_SQUASH)} * sin(ph));
}
const float DOOR_S   = ${f(DOOR.s)};
const float DOOR_PH  = ${f(DOOR.ph)};
const float DOOR_RAD = ${f(DOOR.r)};
const float DOOR_M   = ${f(DOOR.band)};
const float DOOR_SPD = ${f(DOOR_SPD)};
const float DOOR_RR  = ${f(DOOR_R)};
float wrapPi(float a) { return a - 6.28318 * floor((a + 3.14159) / 6.28318); }
float gEdge = 0.0;
// the doorway is a ragged oval, taller than wide and fuller below, its edge never quite even
// only a fine raggedness at the edge; the outline itself is a clean oval
float doorJit(float x) { return 1.0 + 0.02 * sin(x * 150.0 + 1.0); }
float doorB(float below) { return DOOR_RAD * (below > 0.0 ? 1.18 : 0.96); }
const float DOOR_A = DOOR_RAD * 0.9;
// strands that would cross the doorway are pushed out of it, easing into a loose band at its
// edge, where they dip and curl in over it. those running round the nest are pushed over or
// under it; those running down it are pushed round it, out from a point off to the far side,
// so they part smoothly over the arch rather than meeting in a peak
vec2 door(vec2 sp, bool hor, float side) {
  gEdge = 0.0;
  float dx = wrapPi(sp.y - DOOR_PH) * DOOR_RR;
  float dy = (sp.x - DOOR_S) * DOOR_SPD;
  if (hor) {
    float w = sstep(DOOR_A + 0.05, DOOR_A, abs(dx));
    if (w <= 0.0) return sp;
    float hh = doorB(side) * sqrt(max(0.0, 1.0 - dx * dx / (DOOR_A * DOOR_A))) * doorJit(dx);
    float q = side * dy;
    float lim = hh + DOOR_M;
    float lo = -(DOOR_RAD * 1.2 + DOOR_M);
    if (q >= lim || q <= lo) return sp;
    float qn = mix(q, hh + (q - lo) / (lim - lo) * DOOR_M, w);
    gEdge = w * (1.0 - clamp((qn - hh) / DOOR_M, 0.0, 1.0));
    sp.x = DOOR_S + side * qn / DOOR_SPD;
    return sp;
  }
  // in the oval's own units it is a unit circle
  vec2 n = vec2(dx / DOOR_A, dy / doorB(dy));
  vec2 cs = vec2(-side * 0.45, 0.0);
  vec2 d = n - cs;
  float L = length(d);
  vec2 u = d / max(L, 1e-4);
  float bq = dot(cs, u);
  float te = -bq + sqrt(max(0.0, bq * bq - dot(cs, cs) + 1.0));
  te *= doorJit(atan(u.y, u.x) * 0.3);
  float m = DOOR_M / DOOR_A;
  if (L >= te + m) return sp;
  float Ln = te + L / (te + m) * m;
  gEdge = 1.0 - (Ln - te) / m;
  vec2 nn = cs + u * Ln;
  return vec2(DOOR_S + nn.y * doorB(nn.y) / DOOR_SPD, DOOR_PH + nn.x * DOOR_A / DOOR_RR);
}
// a point at angle a round the doorway, k times out from its edge
vec2 doorRing(float k, float a) {
  float dx = DOOR_A * cos(a) * k;
  float dy = doorB(sin(a)) * sin(a) * k;
  gEdge = clamp(1.0 - (k - 1.0) * 4.0, 0.0, 1.0);
  return vec2(DOOR_S + dy / DOOR_SPD, DOOR_PH + dx / DOOR_RR);
}
`;

export const TYPE = { wrap: 0, door: 2 } as const;
export const FLAG = { loop: 1, loose: 2, fray: 4, fine: 8, start: 16 } as const;

type Strand = {
  s0: number; // door: its start angle round the doorway
  ph0: number;
  ds: number; // door: its distance from the doorway's middle
  dph: number;
  depth: number;
  width: number;
  type: number;
  b: number; // where in the build it threads in; below 0 it is always there
  flags: number;
  twist: number; // where along it a half twist sits, 0 for none
  hue: number;
  mAmp: number; // meander in s
  mFreq: number;
  key: number; // build order
  layer: number; // which lies over which
};

export class Form {
  readonly data: Float32Array;
  readonly n: number;
  readonly coarseN: number;
  readonly fineN: number;
  // the build share at which each strand is in, in order, and the running length of grass
  readonly order: Float32Array;
  readonly lengthTo: Float32Array;
  readonly fixed = NECK_N + RING_N;
  readonly fixedLen: number;
  // where the chamber, the belly and the doorway start in the build
  readonly marks = new Float32Array(3);

  constructor() {
    const rnd = mulberry(2424);
    const range = (a: number, b: number) => a + (b - a) * rnd();
    const fixed: Strand[] = [];
    const weave: Strand[] = [];
    const base = (): Strand => ({
      s0: 0,
      ph0: rnd() * TAU,
      ds: 0,
      dph: 0,
      depth: 0,
      width: 0.008,
      type: TYPE.wrap,
      b: -1,
      flags: FLAG.fine,
      twist: 0,
      hue: rnd(),
      mAmp: range(0.002, 0.008),
      mFreq: range(1, 3),
      key: 0,
      layer: 0,
    });

    // NECK
    // strands twisted into a cord from the stem down into the top of the chamber, and a few
    // turns binding it
    for (let i = 0; i < NECK_N; i++) {
      const s = base();
      const bind = i % 5 === 0;
      const broad = rnd() < 0.18;
      s.s0 = bind ? range(0, 0.22) : range(0, 0.06);
      s.ds = bind ? range(-0.03, 0.05) : range(0.24, 0.42);
      s.dph = bind ? range(2, 4) * Math.PI : range(1.4, 3.2) * (rnd() < 0.85 ? 1 : -1);
      s.depth = range(-0.004, 0.012);
      s.width = broad ? range(0.018, 0.03) : range(0.006, 0.012);
      s.flags = (broad ? FLAG.fray : FLAG.fine) | (rnd() < 0.3 ? FLAG.loose : 0);
      fixed.push(s);
    }

    // RING
    // the first ring, round the top of the shoulder where the neck opens out; the body is
    // woven down from it
    for (let i = 0; i < RING_N; i++) {
      const s = base();
      s.s0 = range(0.27, 0.31);
      s.ph0 += range(-0.12, 0.12);
      s.ds = range(-0.02, 0.02);
      s.dph = TAU * 1.15 * (i % 2 ? 1 : -1);
      s.depth = range(-0.03, -0.022);
      s.width = range(0.008, 0.02);
      s.flags = rnd() < 0.3 ? FLAG.fray : FLAG.fine;
      fixed.push(s);
    }

    // DOORWAY
    // short runs along the opening's edge, a little thicker there and ragged, many ends loose
    for (let i = 0; i < DOOR_N; i++) {
      const s = base();
      s.type = TYPE.door;
      s.s0 = rnd() * TAU;
      s.ds = 1 + Math.pow(rnd(), 1.5) * 0.45; // times out from the edge
      s.dph = range(0.5, 1.05) * Math.PI * (rnd() < 0.5 ? -1 : 1);
      s.width = range(0.006, 0.014);
      s.flags = FLAG.fine | (rnd() < 0.6 ? FLAG.loose : 0) | (rnd() < 0.45 ? FLAG.start : 0);
      // the doorway is never built on its own: its edge is the finishing
      const j = rnd();
      s.layer = j * 0.2;
      s.key = 0.92 + 0.08 * j;
      weave.push(s);
    }

    // BODY
    // fine strands and broad strips laid evenly over the chamber: s is drawn by how much
    // surface there is at each height
    const CDF_N = 512;
    const S0 = 0.2;
    const cdf = new Float32Array(CDF_N + 1);
    const p = new Float32Array(3);
    const q = new Float32Array(3);
    for (let i = 0; i < CDF_N; i++) {
      const s = S0 + ((i + 0.5) / CDF_N) * (1 - S0);
      surf(s - 0.001, 0, p);
      surf(s + 0.001, 0, q);
      const ds = Math.hypot(q[0] - p[0], q[1] - p[1]) / 0.002;
      cdf[i + 1] = cdf[i] + radius(s) * ds;
    }
    const total = cdf[CDF_N];
    const pickS = (u: number) => {
      const v = u * total;
      let lo = 0;
      let hi = CDF_N;
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (cdf[m] < v) lo = m;
        else hi = m;
      }
      return S0 + ((lo + (v - cdf[lo]) / Math.max(1e-6, cdf[hi] - cdf[lo])) / CDF_N) * (1 - S0);
    };
    const n = FINE_N + BLADE_N;
    for (let i = 0; i < n; i++) {
      const s = base();
      const broad = i % Math.round(n / BLADE_N) === 0;
      const s0 = Math.min(0.99, pickS((i + rnd()) / n));
      const r = radius(s0);
      const warp = rnd() < 0.4;
      const len = broad ? range(0.9, 1.8) : range(0.5, 1.5);
      s.s0 = s0;
      // round it, down it, or tangled across at a slant
      const slant = !warp && rnd() < 0.35;
      s.dph = warp
        ? range(-0.6, 0.6)
        : Math.min(3 * Math.PI, (len / Math.max(0.1, r)) * (slant ? 0.6 : 1)) *
          (rnd() < 0.5 ? -1 : 1);
      s.ds = warp
        ? range(0.08, 0.24) * (rnd() < 0.5 ? -1 : 1)
        : slant
          ? range(0.06, 0.16) * (rnd() < 0.5 ? -1 : 1)
          : range(-0.1, 0.1);
      s.width = broad ? range(0.022, 0.04) : range(0.005, 0.012);
      s.flags = broad
        ? FLAG.fray | (rnd() < 0.2 ? FLAG.loop : 0) | (rnd() < 0.15 ? FLAG.loose : 0)
        : FLAG.fine | (rnd() < 0.22 ? FLAG.loose : 0) | (rnd() < 0.1 ? FLAG.start : 0);
      s.twist = broad && rnd() < 0.3 ? range(0.15, 0.85) : 0;
      // SHOULDER, CHAMBER, BELLY
      // down from the neck, closing round toward where the doorway is left open
      const sm = s0 + s.ds * 0.5;
      const pm = s.ph0 + s.dph * 0.5;
      const front = 0.5 + 0.5 * Math.cos(pm - DOOR.ph);
      const j = rnd();
      s.key = Math.min(0.9, Math.max(0, 0.84 * smoothstep(0.2, 1, sm) + 0.06 * front + 0.06 * j));
      // the layering the finished nest was tuned with: which strand lies over which
      const dx = Math.atan2(Math.sin(pm - DOOR.ph), Math.cos(pm - DOOR.ph)) * DOOR_R;
      const dy = (sm - DOOR.s) * DOOR_SPD;
      const near = Math.hypot(dx, dy) < DOOR.r + 0.14;
      s.layer = near
        ? 0.06 + 0.24 * j
        : 0.2 +
          0.42 * front +
          0.24 * smoothstep(0.25, 0.9, sm) +
          0.14 * smoothstep(0.82, 0.98, sm) +
          (j - 0.5) * 0.12;
      weave.push(s);
    }

    // each strand is laid over the ones before it, so the newest lie on top
    weave.sort((a, b) => a.layer - b.layer);
    weave.forEach((s, rank) => {
      s.depth = -0.05 + 0.058 * (rank / weave.length) + range(-0.002, 0.002);
      // the doorway's edge sits in with the body, not proud of it
      if (s.type === TYPE.door) s.depth = -0.016 + range(-0.004, 0.03) * 0.4;
    });
    // and threaded in from the neck down, the doorway's lip last
    weave.sort((a, b) => a.key - b.key);
    const span = 1 - WIN;
    weave.forEach((s, rank) => {
      s.b = (rank / (weave.length - 1)) * span;
    });
    // where the chamber, the belly and the doorway start in the build
    const markKey = [0.84 * smoothstep(0.2, 1, 0.45), 0.84 * smoothstep(0.2, 1, 0.8), 0.91];
    for (let m = 0; m < 3; m++) {
      const hit = weave.find((s) => s.key >= markKey[m]);
      this.marks[m] = hit ? hit.b : 1;
    }

    // the lengths, in build order, for the hud
    this.order = new Float32Array(weave.length);
    this.lengthTo = new Float32Array(weave.length + 1);
    let fixedLen = 0;
    for (const s of fixed) fixedLen += this.length(s, p, q);
    weave.forEach((s, w) => {
      this.order[w] = s.b;
      this.lengthTo[w + 1] = this.lengthTo[w] + this.length(s, p, q);
    });
    this.fixedLen = fixedLen;

    // DRAW ORDER
    // the build lives in each strand's own data, so the buffer is free to be ordered for
    // drawing: everything coarse first, then the fine strands shuffled, so drawing fewer of
    // them thins the whole nest evenly
    const coarse = fixed.concat(
      weave.filter((s) => !(s.flags & FLAG.fine) || s.type !== TYPE.wrap),
    );
    const fine = weave.filter((s) => s.flags & FLAG.fine && s.type === TYPE.wrap);
    for (let i = fine.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = fine[i];
      fine[i] = fine[j];
      fine[j] = t;
    }
    this.coarseN = coarse.length;
    this.fineN = fine.length;
    const all = coarse.concat(fine);
    this.n = all.length;
    this.data = new Float32Array(this.n * STRIDE);
    all.forEach((s, i) => {
      this.data.set(
        [
          s.s0,
          s.ph0,
          s.ds,
          s.dph,
          s.depth,
          s.width,
          rnd(),
          s.type,
          s.b,
          s.flags,
          s.twist,
          s.hue,
          s.mAmp,
          s.mFreq,
          0,
          0,
        ],
        i * STRIDE,
      );
    });
  }

  private length(s: Strand, p: Float32Array, q: Float32Array) {
    if (s.type === TYPE.door) return s.ds * DOOR.r * Math.abs(s.dph);
    let l = 0;
    this.at(s, 0, p);
    for (let k = 1; k <= 24; k++) {
      this.at(s, k / 24, q);
      l += Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
      p.set(q);
    }
    return l;
  }

  private at(s: Strand, u: number, o: Float32Array) {
    return surf(s.s0 + s.ds * u, s.ph0 + s.dph * u, o);
  }

  // how many strands are in at a build share
  count(build: number) {
    let lo = 0;
    let hi = this.order.length;
    const at = build - WIN * 0.5;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (this.order[m] <= at) lo = m + 1;
      else hi = m;
    }
    return lo;
  }
}
