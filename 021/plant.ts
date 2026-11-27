// PLANT
// every part is a smooth function of growth day g, so scrubbing is exact; metres, days

export const END_D = 70;
export const G0_D = -50;
export const SPINE_N = 40;
export const TWIG_N = 8;
export const MAX_NODES = 60;
export const MAX_BRANCH = 16;
export const MAX_TWIGS = 96;
export const MAX_HEADS = 1 + MAX_BRANCH + MAX_TWIGS;
export const SEEDS_PER_HEAD = 14;
export const MAX_SEEDS = MAX_HEADS * SEEDS_PER_HEAD;
export const ROWS = 1 + MAX_BRANCH + MAX_TWIGS;
export const TWIG_ROW = 1 + MAX_BRANCH;
export const LEAF_STRIDE = 24;
export const HEAD_STRIDE = 14;
export const SEED_STRIDE = 10;

const GOLDEN = 2.399963;
const NUT_DAYS = 1.5;
export const NUT_MAX_D = 0.9;
const KIND_ROSETTE = 0;
const KIND_STEM = 1;
const KIND_BRACT = 2;
const SEED_LIFE_S = 16;

export type Stage =
  "Sprouting" | "Rosette" | "Bolting" | "Budding" | "Flowering" | "Going to seed" | "Dispersal";

export class Plant {
  // GENOME
  // randomised once per cycle
  boltD = 11;
  hMax = 1.1;
  private panicle = 12;
  private nodes = 0;
  private twigs = 0;
  heads = 0;
  private leanX = -0.6;
  private leanZ = 0;
  private nutPhase = 0;
  nutAt = NaN;
  openD = 40;
  seedD = 50;
  lastD = 66;
  puffD = 60;
  budD = 30;

  private nBirth = new Float32Array(MAX_NODES);
  private nInter = new Float32Array(MAX_NODES);
  private nStep = new Float32Array(MAX_NODES);
  private nElong = new Float32Array(MAX_NODES);
  private nElongDur = new Float32Array(MAX_NODES);
  private nLen = new Float32Array(MAX_NODES);
  private nWid = new Float32Array(MAX_NODES);
  private nElev = new Float32Array(MAX_NODES);
  private nDroop = new Float32Array(MAX_NODES);
  private nCup = new Float32Array(MAX_NODES);
  private nRuffle = new Float32Array(MAX_NODES);
  private nKind = new Uint8Array(MAX_NODES);
  private nAz = new Float32Array(MAX_NODES);
  private nSen = new Float32Array(MAX_NODES);
  private nSeed = new Float32Array(MAX_NODES);
  private nS = new Float32Array(MAX_NODES);

  private bNode = new Uint8Array(MAX_BRANCH);
  private bLen = new Float32Array(MAX_BRANCH);
  private bAngle = new Float32Array(MAX_BRANCH);
  private bBirth = new Float32Array(MAX_BRANCH);
  private bShown = new Float32Array(MAX_BRANCH);

  private tBranch = new Uint8Array(MAX_TWIGS);
  private tFrac = new Float32Array(MAX_TWIGS);
  private tLen = new Float32Array(MAX_TWIGS);
  private tAz = new Float32Array(MAX_TWIGS);
  private tBirth = new Float32Array(MAX_TWIGS);

  private hKind = new Uint8Array(MAX_HEADS);
  private hRef = new Uint8Array(MAX_HEADS);
  private hBirth = new Float32Array(MAX_HEADS);
  private hOpen = new Float32Array(MAX_HEADS);
  private hSize = new Float32Array(MAX_HEADS);
  private hSeed = new Float32Array(MAX_HEADS);
  private hx = new Float32Array(MAX_HEADS * 3);
  private ha = new Float32Array(MAX_HEADS * 3);
  private hPuff = new Float32Array(MAX_HEADS);

  private sRel = new Float32Array(MAX_SEEDS);
  private sHash = new Float32Array(MAX_SEEDS);
  private sFly = new Uint8Array(MAX_SEEDS);
  private sPos = new Float32Array(MAX_SEEDS * 3);
  private sVel = new Float32Array(MAX_SEEDS * 3);
  private sDir = new Float32Array(MAX_SEEDS * 3);
  private sAge = new Float32Array(MAX_SEEDS);

  // POSE
  spine = new Float32Array(SPINE_N * ROWS * 4);
  leaves = new Float32Array(MAX_NODES * LEAF_STRIDE);
  leafN = 0;
  headData = new Float32Array(MAX_HEADS * HEAD_STRIDE);
  headN = 0;
  seedData = new Float32Array(MAX_SEEDS * SEED_STRIDE);
  seedN = 0;
  flying = 0;
  loose = 0;
  private shook = 0;
  branchN = 0;
  twigN = 0;
  top = 0;
  dry = 0;
  open = 0;
  private H = 0;
  private stemT = new Float32Array(SPINE_N * 3);
  // SCRATCH
  private px = 0;
  private py = 0;
  private pz = 0;
  private tx = 0;
  private ty = 1;
  private tz = 0;
  private pr = 0;

  ox = 0;
  oz = 0;

  constructor(seed: number) {
    this.reseed(seed);
  }

  // GENOME
  reseed(seed: number) {
    const rnd = mulberry(seed);
    this.shook = 0;
    const R = 14 + Math.floor(rnd() * 3);
    const S = 10 + Math.floor(rnd() * 4);
    const P = (this.panicle = 12 + Math.floor(rnd() * 4));
    const B = (this.boltD = 10 + rnd() * 2.5);
    this.hMax = 0.78 + rnd() * 0.18;
    this.nodes = R + S + P;
    const az0 = rnd() * Math.PI * 2;
    this.leanX = -(0.6 + 0.4 * rnd());
    this.leanZ = (rnd() - 0.5) * 0.7;
    this.nutPhase = rnd() * Math.PI * 2;
    this.nutAt = NaN;

    let bolt = 0;
    for (let k = 0; k < this.nodes; k++) {
      this.nAz[k] = az0 + k * GOLDEN + (rnd() - 0.5) * (k < R ? 0.05 : 0.3);
      this.nSeed[k] = rnd();
      this.nStep[k] = 0;
      if (k < R) {
        // ROSETTE
        const f = k / (R - 1);
        this.nKind[k] = KIND_ROSETTE;
        this.nBirth[k] = -48 + k * 3.3;
        this.nLen[k] =
          (0.13 + 0.07 * Math.sin((Math.PI * (k + 2)) / (R + 3))) * (0.9 + 0.2 * rnd());
        this.nWid[k] = (0.49 + 0.05 * rnd()) * (1 - 0.45 * f);
        // NESTING
        // elevation, steepness and arch monotonic in k, so inner leaves never cross outer
        this.nElev[k] = 0.22 + 0.85 * f ** 1.6;
        this.nDroop[k] = 0.95 - 0.75 * f;
        this.nCup[k] = -0.25 + 0.3 * f;
        this.nRuffle[k] = 0.9 + 0.25 * rnd();
        this.nSen[k] = 34 + k * 0.45;
        const top = k - (R - 6);
        this.nStep[k] = 0.0065 + 0.005 * f;
        this.nInter[k] = top < 0 ? 0 : 0.012 + 0.009 * top;
        this.nElong[k] = top < 0 ? -999 : B + top * 0.6;
        this.nElongDur[k] = 6;
        if (top >= 0) bolt += this.nInter[k];
      } else if (k < R + S) {
        // STEM LEAVES
        const j = k - R;
        const f = j / S;
        this.nKind[k] = KIND_STEM;
        this.nBirth[k] = B + j * 0.95;
        this.nLen[k] = 0.13 * (1 - 0.62 * f) * (0.9 + 0.2 * rnd());
        this.nWid[k] = 0.34 - 0.12 * f;
        this.nElev[k] = 0.62 + 0.25 * f;
        this.nDroop[k] = 0.6 - 0.25 * f;
        this.nCup[k] = 0.35;
        this.nRuffle[k] = 0.5 * (1 - f);
        this.nSen[k] = 50 + j * 0.4;
        this.nInter[k] = 0.055 + 0.035 * Math.sin((Math.PI * (j + 1)) / (S + 1));
        this.nElong[k] = this.nBirth[k] + 0.2;
        this.nElongDur[k] = 6.5;
        bolt += this.nInter[k];
      } else {
        // PANICLE
        const j = k - R - S;
        const f = j / (P - 1);
        this.nKind[k] = KIND_BRACT;
        this.nBirth[k] = B + S * 0.95 + 0.8 + j * 0.7;
        this.nLen[k] = 0.035 * (1 - 0.6 * f);
        this.nWid[k] = 0.24;
        this.nElev[k] = 0.7;
        this.nDroop[k] = 0.3;
        this.nCup[k] = 0.4;
        this.nRuffle[k] = 0;
        this.nSen[k] = 55;
        this.nInter[k] = 0.05 * (1 - 0.45 * f);
        this.nElong[k] = this.nBirth[k] + 0.3;
        this.nElongDur[k] = 6;
        bolt += this.nInter[k];
      }
    }
    const scale = (this.hMax - 0.04) / bolt;
    for (let k = R - 6; k < this.nodes; k++) this.nInter[k] *= scale;

    // BRANCHES AND PEDICELS
    let t = 0;
    let h = 0;
    const last = this.nodes - 1;
    this.hKind[h] = 0;
    this.hRef[h] = 0;
    this.hBirth[h] = this.nBirth[last] + 0.6;
    this.hSize[h] = 1.12;
    h++;
    for (let b = 0; b < P; b++) {
      const k = R + S + b;
      const f = b / (P - 1);
      this.bNode[b] = k;
      this.bLen[b] = (0.44 - 0.3 * f) * (0.85 + 0.3 * rnd());
      this.bAngle[b] = 0.62 + 0.3 * rnd();
      this.bBirth[b] = this.nBirth[k] + 1.2;
      this.hKind[h] = 1;
      this.hRef[h] = b;
      this.hBirth[h] = this.bBirth[b] + 3;
      this.hSize[h] = 1.0;
      h++;
      const c = Math.min(8, Math.max(2, Math.round(2 + 6 * (1 - f) + rnd())));
      for (let i = 0; i < c && t < MAX_TWIGS; i++, t++) {
        const q = 0.26 + (0.64 * (i + 0.5 + (rnd() - 0.5) * 0.3)) / c;
        this.tBranch[t] = b;
        this.tFrac[t] = q;
        this.tLen[t] = 0.03 + 0.045 * rnd();
        this.tAz[t] = i * GOLDEN + rnd();
        this.tBirth[t] = this.bBirth[b] + 1 + q * 5;
        this.hKind[h] = 2;
        this.hRef[h] = t;
        this.hBirth[h] = this.tBirth[t] + 1;
        this.hSize[h] = 0.85 + 0.2 * rnd();
        h++;
      }
    }
    this.twigs = t;
    this.heads = h;
    this.budD = 99;
    this.openD = 99;
    this.seedD = 99;
    this.lastD = 0;
    // FLOWERING
    // buds sync, then the whole spray opens within a few days
    let born = 0;
    for (let i = 0; i < h; i++) born = Math.max(born, this.hBirth[i]);
    const F0 = born + 3;
    this.puffD = F0 + 13.6;
    for (let i = 0; i < h; i++) {
      this.hSeed[i] = rnd();
      this.hOpen[i] = i === 0 ? F0 - 1 : Math.max(this.hBirth[i] + 5, F0) + rnd() * 4;
      this.budD = Math.min(this.budD, this.hBirth[i]);
      this.openD = Math.min(this.openD, this.hOpen[i]);
      for (let s = 0; s < SEEDS_PER_HEAD; s++) {
        const j = i * SEEDS_PER_HEAD + s;
        this.sRel[j] = Math.max(this.hOpen[i] + 9.5, F0 + 14) + rnd() * 4.5;
        this.sHash[j] = rnd();
        this.sFly[j] = 0;
        this.sAge[j] = 0;
        this.seedD = Math.min(this.seedD, this.sRel[j]);
        this.lastD = Math.max(this.lastD, this.sRel[j]);
      }
    }
  }

  stageDay(name: string) {
    if (name === "rosette") return 2;
    if (name === "bolt") return this.boltD + 9;
    if (name === "bud") return this.openD - 3;
    if (name === "flower") return this.openD + 3.2;
    if (name === "puff" || name === "blow") return this.puffD;
    if (name === "end") return END_D;
    if (name === "sprout") return -40;
    const n = Number(name);
    return Number.isFinite(n) ? Math.min(END_D, Math.max(G0_D, n)) : 0;
  }

  stage(g: number): Stage {
    if (this.flying > 0 || g >= this.seedD) return "Dispersal";
    if (g < -30) return "Sprouting";
    if (g < this.boltD + 1) return "Rosette";
    if (g < this.budD + 2) return "Bolting";
    if (this.open > 0) return "Flowering";
    if (g < this.openD) return "Budding";
    return g < this.openD + 6 ? "Flowering" : "Going to seed";
  }

  // GROWTH
  private inter(k: number, g: number) {
    if (g < this.nBirth[k]) return 0;
    return (
      this.nStep[k] * ease(g - this.nBirth[k]) +
      this.nInter[k] * ease((g - this.nElong[k]) / this.nElongDur[k])
    );
  }

  heightAt(g: number) {
    let s = 0.024;
    for (let k = 0; k < this.nodes; k++) s += this.inter(k, g);
    return s + 0.012;
  }

  // POSE
  // sx, sz: sway lean at the top in radians; t: seconds
  pose(g: number, sx: number, sz: number, t: number, wind: number) {
    this.stem(g, sx, sz);
    this.leafs(g);
    this.branches(g, sx, sz, t, wind);
    this.flowers(g);
  }

  private stem(g: number, sx: number, sz: number) {
    let s = 0.024;
    for (let k = 0; k < this.nodes; k++) {
      this.nS[k] = s;
      s += this.inter(k, g);
    }
    const H = (this.H = s + 0.012);
    // NOD AND NUTATION
    // a fast-rising tip hooks over and circles slowly
    const rate = (this.heightAt(g + 0.3) - this.heightAt(g - 0.3)) / 0.6;
    const nod = 0.95 * Math.min(1, rate / 0.07);
    const ph = (Number.isNaN(this.nutAt) ? nutOf(g) : this.nutAt) + this.nutPhase;
    const nx = (Math.cos(ph) + this.leanX * 0.8) * nod;
    const nz = (Math.sin(ph) + this.leanZ * 0.8) * nod;
    const zoneA = H - Math.min(0.17, H * 0.5);
    const swayOn = smooth(0.12, 0.4, H);
    const ds = H / (SPINE_N - 1);
    const rB = 0.0022 + 0.0066 * ease((g - this.boltD) / 18);
    const sp = this.spine;
    let x = this.ox;
    let y = -0.012;
    let z = this.oz;
    let top = 0;
    for (let i = 0; i < SPINE_N; i++) {
      const o = i * 4;
      const f = (i * ds) / H;
      sp[o] = x;
      sp[o + 1] = y;
      sp[o + 2] = z;
      sp[o + 3] = rB * (1 - 0.72 * f) + 0.0011;
      if (y > top) top = y;
      const m = (i + 0.5) * ds;
      const fm = m / H;
      const zone = smooth(zoneA, H, m);
      const sw = fm ** 1.4 * swayOn;
      const lean = 0.02 + 0.07 * fm;
      tilt(
        this.leanX * lean + nx * zone * zone + sx * sw,
        this.leanZ * lean + nz * zone * zone + sz * sw,
      );
      x += dX * ds;
      y += dY * ds;
      z += dZ * ds;
    }
    this.top = Math.max(top, 0.03);
    const T = this.stemT;
    for (let i = 0; i < SPINE_N; i++) {
      const a = Math.max(0, i - 1) * 4;
      const b = Math.min(SPINE_N - 1, i + 1) * 4;
      let ux = sp[b] - sp[a];
      let uy = sp[b + 1] - sp[a + 1];
      let uz = sp[b + 2] - sp[a + 2];
      const l = Math.hypot(ux, uy, uz) || 1;
      ux /= l;
      uy /= l;
      uz /= l;
      T[i * 3] = ux;
      T[i * 3 + 1] = uy;
      T[i * 3 + 2] = uz;
    }
  }

  private atStem(s: number) {
    const f = Math.min(SPINE_N - 1.001, Math.max(0, (s / this.H) * (SPINE_N - 1)));
    const i = Math.floor(f);
    const u = f - i;
    const sp = this.spine;
    const T = this.stemT;
    const a = i * 4;
    const b = a + 4;
    this.px = sp[a] + (sp[b] - sp[a]) * u;
    this.py = sp[a + 1] + (sp[b + 1] - sp[a + 1]) * u;
    this.pz = sp[a + 2] + (sp[b + 2] - sp[a + 2]) * u;
    this.pr = sp[a + 3] + (sp[b + 3] - sp[a + 3]) * u;
    const c = i * 3;
    const d = c + 3;
    let tx = T[c] + (T[d] - T[c]) * u;
    let ty = T[c + 1] + (T[d + 1] - T[c + 1]) * u;
    let tz = T[c + 2] + (T[d + 2] - T[c + 2]) * u;
    const l = Math.hypot(tx, ty, tz) || 1;
    tx /= l;
    ty /= l;
    tz /= l;
    this.tx = tx;
    this.ty = ty;
    this.tz = tz;
  }

  private atRow(row: number, n: number, q: number) {
    const f = Math.min(n - 1.001, Math.max(0, q * (n - 1)));
    const i = Math.floor(f);
    const u = f - i;
    const sp = this.spine;
    const a = (row * SPINE_N + i) * 4;
    const b = a + 4;
    this.px = sp[a] + (sp[b] - sp[a]) * u;
    this.py = sp[a + 1] + (sp[b + 1] - sp[a + 1]) * u;
    this.pz = sp[a + 2] + (sp[b + 2] - sp[a + 2]) * u;
    this.pr = sp[a + 3] + (sp[b + 3] - sp[a + 3]) * u;
    const c = (row * SPINE_N + Math.max(0, i - 1)) * 4;
    const d = (row * SPINE_N + Math.min(n - 1, i + 2)) * 4;
    let tx = sp[d] - sp[c];
    let ty = sp[d + 1] - sp[c + 1];
    let tz = sp[d + 2] - sp[c + 2];
    const l = Math.hypot(tx, ty, tz);
    if (l < 1e-7) {
      tx = 0;
      ty = 1;
      tz = 0;
    } else {
      tx /= l;
      ty /= l;
      tz /= l;
    }
    this.tx = tx;
    this.ty = ty;
    this.tz = tz;
  }

  // LEAVES
  private leafs(g: number) {
    const L = this.leaves;
    let top = this.top;
    const boltP = ease((g - this.boltD) / 16);
    let n = 0;
    for (let k = 0; k < this.nodes; k++) {
      const kind = this.nKind[k];
      const age = g - this.nBirth[k] - (kind === KIND_ROSETTE ? 0 : 1.5);
      if (age <= 0) continue;
      const dur = kind === KIND_ROSETTE ? 13 : kind === KIND_STEM ? 8 : 4;
      const grow = ease(age / dur);
      const pop = ease(age / 1.2);
      const unf = ease((age - dur * 0.1) / (dur * 0.75));
      const sen = ease((g - this.nSen[k]) / 13);
      const len = this.nLen[k] * (0.08 + 0.92 * grow) * (1 - 0.12 * sen) * pop;
      const wid = len * this.nWid[k] * (0.35 + 0.65 * unf);
      let elev = Math.max(
        0.1,
        mix(1.1, this.nElev[k], unf) -
          0.3 * sen -
          (kind === KIND_ROSETTE ? 0.16 * boltP * (1 - this.nElev[k]) : 0),
      );
      if (kind === KIND_ROSETTE && this.nElong[k] > -99) {
        const lift = ease(
          ((this.inter(k, g) - this.nStep[k]) / Math.max(this.nInter[k], 1e-6)) * 1.5,
        );
        elev = mix(elev, Math.min(elev, 0.6), lift);
      }
      let droop = mix(-0.45, this.nDroop[k], unf) + 0.55 * sen;
      if (kind !== KIND_ROSETTE) droop = Math.min(droop, elev + 0.05);

      this.atStem(this.nS[k]);
      const tx = this.tx;
      const ty = this.ty;
      const tz = this.tz;
      let dx = Math.cos(this.nAz[k]);
      let dy = 0;
      let dz = Math.sin(this.nAz[k]);
      const dt = dx * tx + dz * tz;
      dx -= tx * dt;
      dy -= ty * dt;
      dz -= tz * dt;
      const dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl;
      dy /= dl;
      dz /= dl;
      const ce = Math.cos(elev);
      const se = Math.sin(elev);
      const fx = dx * ce + tx * se;
      const fy = dy * ce + ty * se;
      const fz = dz * ce + tz * se;
      let ax = ty * dz - tz * dy;
      let ay = tz * dx - tx * dz;
      let az = tx * dy - ty * dx;
      const al = Math.hypot(ax, ay, az) || 1;
      ax /= al;
      ay /= al;
      az /= al;
      const tw = kind === KIND_ROSETTE ? 0 : (this.nSeed[k] - 0.5) * 0.3;
      const ct = Math.cos(tw);
      const st = Math.sin(tw);
      const nx = fy * az - fz * ay;
      const ny = fz * ax - fx * az;
      const nz = fx * ay - fy * ax;
      ax = ax * ct + nx * st;
      ay = ay * ct + ny * st;
      az = az * ct + nz * st;
      const r = this.pr * (kind === KIND_ROSETTE ? 1.05 : 1.3) + 0.0008;
      // SOIL
      // droop capped so the tip clears the soil
      if (droop > 0.01) {
        const by = this.py + dy * r;
        const clear = 0.026 + 0.006 * k - by;
        const e0 = Math.asin(Math.max(-1, Math.min(1, fy)));
        if (dropOf(e0, droop) * len < clear) {
          let lo = 0;
          let hi = droop;
          for (let i = 0; i < 18; i++) {
            const mid = (lo + hi) / 2;
            if (dropOf(e0, mid) * len < clear) hi = mid;
            else lo = mid;
          }
          droop = lo;
        }
      }
      const o = n++ * LEAF_STRIDE;
      L[o] = this.px + dx * r;
      L[o + 1] = this.py + dy * r;
      L[o + 2] = this.pz + dz * r;
      L[o + 3] = fx;
      L[o + 4] = fy;
      L[o + 5] = fz;
      L[o + 6] = ax;
      L[o + 7] = ay;
      L[o + 8] = az;
      L[o + 9] = len;
      L[o + 10] = wid;
      L[o + 11] = droop;
      L[o + 12] = this.nCup[k] * unf;
      L[o + 13] = unf;
      L[o + 14] = this.nRuffle[k] * (0.4 + 0.6 * grow);
      L[o + 15] = kind;
      L[o + 16] = this.nSeed[k];
      L[o + 17] = sen;
      L[o + 18] = kind === KIND_ROSETTE ? 0.12 : 0.8;
      L[o + 19] = kind === KIND_ROSETTE ? Math.min(1, k / 14) : 1;
      L[o + 20] = 0;
      const tip = L[o + 1] + len * Math.max(0, fy) * 0.8;
      if (tip > top) top = tip;
    }
    this.leafN = n;
    this.top = top;
  }

  // BRANCHES
  private branches(g: number, sx: number, sz: number, t: number, wind: number) {
    const sp = this.spine;
    const P = this.panicle;
    for (let b = 0; b < P; b++) {
      const k = this.bNode[b];
      const grow = ease((g - this.bBirth[b]) / 9);
      const len = this.bLen[b] * grow;
      const row = 1 + b;
      const ro = row * SPINE_N * 4;
      this.bShown[b] = len > 0.002 ? 1 : 0;
      this.atStem(this.nS[k]);
      const bx = this.px;
      const by = this.py;
      const bz = this.pz;
      const tx = this.tx;
      const ty = this.ty;
      const tz = this.tz;
      const fh = Math.min(1, this.nS[k] / this.H);
      let hx = Math.cos(this.nAz[k]);
      let hz = Math.sin(this.nAz[k]);
      const ca = Math.cos(this.bAngle[b]);
      const sa = Math.sin(this.bAngle[b]);
      const d0x = tx * ca + hx * sa;
      const d0y = ty * ca;
      const d0z = tz * ca + hz * sa;
      const phi0 = Math.acos(Math.min(1, Math.max(-1, d0y / (Math.hypot(d0x, d0y, d0z) || 1))));
      const hl = Math.hypot(d0x, d0z) || 1;
      hx = d0x / hl;
      hz = d0z / hl;
      const flut = wind * 0.12 * Math.sin(t * 5.1 + b * 1.7);
      const swx = sx * fh ** 1.4 * 1.15 + flut * hz;
      const swz = sz * fh ** 1.4 * 1.15 - flut * hx;
      const ds = len / (SPINE_N - 1);
      let x = bx;
      let y = by;
      let z = bz;
      for (let i = 0; i < SPINE_N; i++) {
        const o = ro + i * 4;
        const q = i / (SPINE_N - 1);
        sp[o] = x;
        sp[o + 1] = y;
        sp[o + 2] = z;
        sp[o + 3] = len > 0.002 ? (0.0021 * (1 - 0.6 * q) + 0.0005) * Math.sqrt(grow) : 0;
        const qm = (i + 0.5) / (SPINE_N - 1);
        const phi = phi0 * (1 - 0.55 * qm) + (1 - grow) * 0.7 * qm * qm;
        tilt(hx * phi + swx * qm, hz * phi + swz * qm);
        x += dX * ds;
        y += dY * ds;
        z += dZ * ds;
      }
    }
    this.branchN = P;

    // PEDICELS
    for (let i = 0; i < this.twigs; i++) {
      const b = this.tBranch[i];
      const row = TWIG_ROW + i;
      const ro = row * SPINE_N * 4;
      const grow = ease((g - this.tBirth[i]) / 4) * this.bShown[b];
      const len = this.tLen[i] * grow;
      this.atRow(1 + b, SPINE_N, this.tFrac[i]);
      const bx = this.px;
      const by = this.py;
      const bz = this.pz;
      const tx = this.tx;
      const ty = this.ty;
      const tz = this.tz;
      let ux = -tz;
      const uy = 0;
      let uz = tx;
      let ul = Math.hypot(ux, uy, uz);
      if (ul < 1e-4) {
        ux = 1;
        uz = 0;
        ul = 1;
      }
      ux /= ul;
      uz /= ul;
      const vx = ty * uz - tz * uy;
      const vy = tz * ux - tx * uz;
      const vz = tx * uy - ty * ux;
      const c = Math.cos(this.tAz[i]);
      const s = Math.sin(this.tAz[i]);
      const ca = Math.cos(0.62);
      const sa = Math.sin(0.62);
      const d0x = tx * ca + (ux * c + vx * s) * sa;
      const d0y = ty * ca + (uy * c + vy * s) * sa;
      const d0z = tz * ca + (uz * c + vz * s) * sa;
      const dl = Math.hypot(d0x, d0y, d0z) || 1;
      const phi0 = Math.acos(Math.min(1, Math.max(-1, d0y / dl)));
      const hl = Math.hypot(d0x, d0z) || 1;
      const hx = d0x / hl;
      const hz = d0z / hl;
      const flut = wind * 0.2 * Math.sin(t * 7.3 + i * 2.3);
      const ds = len / (TWIG_N - 1);
      let x = bx;
      let y = by;
      let z = bz;
      for (let j = 0; j < TWIG_N; j++) {
        const o = ro + j * 4;
        const q = j / (TWIG_N - 1);
        sp[o] = x;
        sp[o + 1] = y;
        sp[o + 2] = z;
        sp[o + 3] = len > 0.001 ? 0.0009 * (1 - 0.3 * q) : 0;
        const phi = phi0 * (1 - 0.6 * ((j + 0.5) / (TWIG_N - 1)));
        tilt(hx * phi + flut * hz, hz * phi - flut * hx);
        x += dX * ds;
        y += dY * ds;
        z += dZ * ds;
      }
    }
    this.twigN = this.twigs;
  }

  // HEADS
  // bud, a day in flower, closed while ripening, then a puff
  private flowers(g: number) {
    const D = this.headData;
    let n = 0;
    let open = 0;
    let top = this.top;
    for (let h = 0; h < this.heads; h++) {
      this.hPuff[h] = 0;
      const grow = ease((g - this.hBirth[h]) / 5);
      const kind = this.hKind[h];
      const ref = this.hRef[h];
      if (kind === 1 && !this.bShown[ref]) continue;
      if (kind === 2 && !this.bShown[this.tBranch[ref]]) continue;
      if (grow < 0.02) continue;
      if (kind === 0) this.atRow(0, SPINE_N, 1);
      else if (kind === 1) this.atRow(1 + ref, SPINE_N, 1);
      else this.atRow(TWIG_ROW + ref, TWIG_N, 1);
      let ax = this.tx;
      let ay = this.ty + 0.35;
      let az = this.tz;
      const al = Math.hypot(ax, ay, az) || 1;
      ax /= al;
      ay /= al;
      az /= al;
      const o = this.hOpen[h];
      const op = ease((g - o) / 0.4) * (1 - ease((g - o - 2.2) / 0.6));
      const mat = ease((g - o - 2.6) / 3);
      const puff = ease((g - o - 7) / 1.5);
      const dryH = ease((g - o - 4.5) / 3);
      if (op > 0.5) open++;
      const sz = this.hSize[h] * (0.25 + 0.75 * grow);
      const k = n++ * HEAD_STRIDE;
      D[k] = this.px;
      D[k + 1] = this.py;
      D[k + 2] = this.pz;
      D[k + 3] = ax;
      D[k + 4] = ay;
      D[k + 5] = az;
      D[k + 6] = sz;
      D[k + 7] = op;
      D[k + 8] = mat;
      D[k + 9] = puff;
      D[k + 10] = this.hSeed[h];
      D[k + 11] = grow;
      D[k + 12] = dryH;
      D[k + 13] = 0;
      const lh = 0.026 * sz * (1 + 0.25 * mat) * (1 - 0.6 * puff);
      this.hx[h * 3] = this.px + ax * lh;
      this.hx[h * 3 + 1] = this.py + ay * lh;
      this.hx[h * 3 + 2] = this.pz + az * lh;
      this.ha[h * 3] = ax;
      this.ha[h * 3 + 1] = ay;
      this.ha[h * 3 + 2] = az;
      this.hPuff[h] = puff;
      if (this.py + 0.02 > top) top = this.py + 0.02;
    }
    this.headN = n;
    this.open = open;
    this.top = top;
    this.dry = ease((g - 52) / 12);
  }

  // SEEDS
  // attached until their release day, then simulated in real time
  seeds(g: number, dt: number, t: number, wx: number, wz: number, breeze: number, gust: number) {
    const S = this.seedData;
    let n = 0;
    let flying = 0;
    let loose = 0;
    const speed = 0.14 + breeze * 0.12 + gust * 0.7;
    const lift = -0.035 + gust * 0.06;
    for (let h = 0; h < this.heads; h++) {
      const puff = this.hPuff[h];
      const cx = this.hx[h * 3];
      const cy = this.hx[h * 3 + 1];
      const cz = this.hx[h * 3 + 2];
      const ax = this.ha[h * 3];
      const ay = this.ha[h * 3 + 1];
      const az = this.ha[h * 3 + 2];
      let ux = -az;
      let uz = ax;
      let ul = Math.hypot(ux, uz);
      if (ul < 1e-4) {
        ux = 1;
        uz = 0;
        ul = 1;
      }
      ux /= ul;
      uz /= ul;
      const vx = ay * uz;
      const vy = az * ux - ax * uz;
      const vz = -ay * ux;
      const cap = 0.2 + 1.75 * puff;
      const ccap = Math.cos(cap);
      for (let s = 0; s < SEEDS_PER_HEAD; s++) {
        const j = h * SEEDS_PER_HEAD + s;
        const j3 = j * 3;
        if (g < this.sRel[j] || puff < 0.9) {
          this.sFly[j] = 0;
          this.sAge[j] = 0;
          if (puff < 0.02) continue;
          if (puff >= 0.9) loose++;
          // ATTACHED
          const ct = 1 - ((s + 0.5) / SEEDS_PER_HEAD) * (1 - ccap);
          const st = Math.sqrt(Math.max(0, 1 - ct * ct));
          const p = s * GOLDEN + this.hSeed[h] * 6.283;
          const cp = Math.cos(p) * st;
          const sp = Math.sin(p) * st;
          const dx = ax * ct + ux * cp + vx * sp;
          const dy = ay * ct + vy * sp;
          const dz = az * ct + uz * cp + vz * sp;
          this.sPos[j3] = cx;
          this.sPos[j3 + 1] = cy;
          this.sPos[j3 + 2] = cz;
          this.sDir[j3] = dx;
          this.sDir[j3 + 1] = dy;
          this.sDir[j3 + 2] = dz;
          const o = n++ * SEED_STRIDE;
          S[o] = cx;
          S[o + 1] = cy;
          S[o + 2] = cz;
          S[o + 3] = dx;
          S[o + 4] = dy;
          S[o + 5] = dz;
          S[o + 6] = 0.017 * puff;
          S[o + 7] = 0.014 * puff;
          S[o + 8] = Math.min(1, puff * 1.4);
          S[o + 9] = this.sHash[j];
          continue;
        }
        if (this.sFly[j] === 2) continue;
        if (this.sFly[j] === 0) {
          // LET GO
          this.sFly[j] = 1;
          this.sAge[j] = -((this.sHash[j] * 7.31) % 1) * 1.6;
        }
        if (this.sAge[j] < 0) {
          this.sAge[j] += dt;
          flying++;
          const d = this.sDir;
          if (this.sAge[j] >= 0) {
            this.sVel[j3] = d[j3] * 0.15 + wx * speed * 0.6;
            this.sVel[j3 + 1] = d[j3 + 1] * 0.08;
            this.sVel[j3 + 2] = d[j3 + 2] * 0.15 + wz * speed * 0.6;
          } else {
            const o = n++ * SEED_STRIDE;
            S[o] = this.sPos[j3];
            S[o + 1] = this.sPos[j3 + 1];
            S[o + 2] = this.sPos[j3 + 2];
            S[o + 3] = d[j3];
            S[o + 4] = d[j3 + 1];
            S[o + 5] = d[j3 + 2];
            S[o + 6] = 0.017;
            S[o + 7] = 0.014;
            S[o + 8] = 1;
            S[o + 9] = this.sHash[j];
            continue;
          }
        }
        // DRIFT
        // per-seed drag, sink and spin, advected by a curl-noise field
        const h1 = this.sHash[j];
        const h2 = (h1 * 7.31) % 1;
        const h3 = (h1 * 13.7) % 1;
        const P = this.sPos;
        const V = this.sVel;
        const x = P[j3];
        const y = P[j3 + 1];
        const z = P[j3 + 2];
        const kd = 1 - Math.exp(-dt / (0.3 + 0.7 * h2));
        const sp = speed * (0.5 + 0.9 * h3);
        const fx = x * 1.7 + h1 * 0.9;
        const fy = y * 1.7;
        const fz = z * 1.7 + h2 * 0.9;
        const tt = t * 0.55;
        // CURL NOISE
        // curl of A = (sin y + sin z, sin z + sin x, sin x + sin y), per-axis phase
        const dAzdy = 2.5 * Math.cos(2.5 * fy + 0.4 * tt + 3.0);
        const dAydz = 1.9 * Math.cos(1.9 * fz + 0.5 * tt + 2.1);
        const dAxdz = 2.3 * Math.cos(2.3 * fz + 0.9 * tt + 1.3);
        const dAzdx = 1.6 * Math.cos(1.6 * fx + 0.7 * tt + 0.7);
        const dAydx = 2.1 * Math.cos(2.1 * fx + 0.8 * tt);
        const dAxdy = 1.7 * Math.cos(1.7 * fy + 0.6 * tt);
        const turb = 0.075 * (0.7 + gust * 1.5);
        const tx = wx * sp + turb * (dAzdy - dAydz);
        const ty = lift + (h1 - 0.62) * 0.12 + turb * (dAxdz - dAzdx);
        const tz = wz * sp + turb * (dAydx - dAxdy);
        V[j3] += (tx - V[j3]) * kd;
        V[j3 + 1] += (ty - V[j3 + 1]) * kd;
        V[j3 + 2] += (tz - V[j3 + 2]) * kd;
        P[j3] = x + V[j3] * dt;
        P[j3 + 1] = y + V[j3 + 1] * dt;
        P[j3 + 2] = z + V[j3 + 2] * dt;
        // TUMBLE
        // pappus self-rights like a parachute, rocking as it spins
        const D = this.sDir;
        const r = 1 - Math.exp(-dt / (0.25 + 0.5 * h3));
        const ph = t * (h2 - 0.5) * 5 + h1 * 6.283;
        const rock = 0.3 + 0.5 * h3;
        const gx = Math.cos(ph) * rock - V[j3] * 0.5;
        const gz = Math.sin(ph) * rock - V[j3 + 2] * 0.5;
        D[j3] += (gx - D[j3]) * r;
        D[j3 + 1] += (1 - D[j3 + 1]) * r;
        D[j3 + 2] += (gz - D[j3 + 2]) * r;
        const dl = Math.hypot(D[j3], D[j3 + 1], D[j3 + 2]) || 1;
        D[j3] /= dl;
        D[j3 + 1] /= dl;
        D[j3 + 2] /= dl;
        const age = (this.sAge[j] += dt);
        if (age > SEED_LIFE_S || P[j3 + 1] > 4 || Math.abs(P[j3]) > 5 || Math.abs(P[j3 + 2]) > 5) {
          this.sFly[j] = 2;
          continue;
        }
        flying++;
        const size = 0.7 + 0.65 * h3;
        const o = n++ * SEED_STRIDE;
        S[o] = P[j3];
        S[o + 1] = P[j3 + 1];
        S[o + 2] = P[j3 + 2];
        S[o + 3] = D[j3];
        S[o + 4] = D[j3 + 1];
        S[o + 5] = D[j3 + 2];
        S[o + 6] = 0.017 * size;
        S[o + 7] = 0.014 * size;
        S[o + 8] = 1 - smooth(SEED_LIFE_S - 3, SEED_LIFE_S, age);
        S[o + 9] = h1 + 2;
      }
    }
    this.seedN = n;
    this.flying = flying;
    this.loose = loose;
  }

  // SHAKE
  // each shake releases a further share of ripe seed in a quick burst
  shake(g: number) {
    this.shook += 0.3;
    let n = 0;
    for (let h = 0; h < this.heads; h++) {
      if (this.hPuff[h] < 0.9) continue;
      for (let s = 0; s < SEEDS_PER_HEAD; s++) {
        const j = h * SEEDS_PER_HEAD + s;
        if (g >= this.sRel[j] || this.sHash[j] >= this.shook) continue;
        this.sRel[j] = g - 1e-3;
        this.sFly[j] = 1;
        this.sAge[j] = -0.04 - ((this.sHash[j] * 13.7) % 1) * 0.26;
        n++;
      }
    }
    return n;
  }

  // FALL
  // rigid rotation about the foot by a toward (dx, dz), scaled by k, sunk by sink
  fell(a: number, dx: number, dz: number, k: number, sink: number) {
    const c = Math.cos(a);
    const s = Math.sin(a);
    const t = 1 - c;
    const ax = dz;
    const az = -dx;
    const R = FR;
    R[0] = c + ax * ax * t;
    R[1] = -az * s;
    R[2] = ax * az * t;
    R[3] = az * s;
    R[4] = c;
    R[5] = -ax * s;
    R[6] = az * ax * t;
    R[7] = ax * s;
    R[8] = c + az * az * t;
    fK = k;
    fBx = this.ox;
    fBz = this.oz;
    fSink = sink;
    const sp = this.spine;
    for (let o = 0; o < sp.length; o += 4) {
      fellPt(sp, o);
      sp[o + 3] *= k;
    }
    const L = this.leaves;
    for (let i = 0; i < this.leafN; i++) {
      const o = i * LEAF_STRIDE;
      fellPt(L, o);
      fellDir(L, o + 3);
      fellDir(L, o + 6);
      L[o + 9] *= k;
      L[o + 10] *= k;
    }
    const D = this.headData;
    for (let i = 0; i < this.headN; i++) {
      const o = i * HEAD_STRIDE;
      fellPt(D, o);
      fellDir(D, o + 3);
      D[o + 6] *= k;
    }
    for (let h = 0; h < this.heads; h++) {
      fellPt(this.hx, h * 3);
      fellDir(this.ha, h * 3);
    }
  }

  blow(g: number, strength: number) {
    let n = 0;
    for (let h = 0; h < this.heads; h++) {
      if (this.hPuff[h] < 0.9) continue;
      for (let s = 0; s < SEEDS_PER_HEAD; s++) {
        const j = h * SEEDS_PER_HEAD + s;
        if (g >= this.sRel[j]) continue;
        const ready = 1 - Math.min(1, (this.sRel[j] - g) / 8);
        if (this.sHash[j] < strength * (0.2 + 0.55 * ready)) {
          this.sRel[j] = g - 1e-3;
          n++;
        }
      }
    }
    return n;
  }
}

// FELL
const FR = new Float32Array(9);
let fK = 1;
let fBx = 0;
let fBz = 0;
let fSink = 0;
function fellPt(A: Float32Array, o: number) {
  const R = FR;
  const x = A[o] - fBx;
  const y = A[o + 1];
  const z = A[o + 2] - fBz;
  A[o] = fBx + (R[0] * x + R[1] * y + R[2] * z) * fK;
  A[o + 1] = (R[3] * x + R[4] * y + R[5] * z) * fK - fSink;
  A[o + 2] = fBz + (R[6] * x + R[7] * y + R[8] * z) * fK;
}
function fellDir(A: Float32Array, o: number) {
  const R = FR;
  const x = A[o];
  const y = A[o + 1];
  const z = A[o + 2];
  A[o] = R[0] * x + R[1] * y + R[2] * z;
  A[o + 1] = R[3] * x + R[4] * y + R[5] * z;
  A[o + 2] = R[6] * x + R[7] * y + R[8] * z;
}

export function nutOf(g: number) {
  return (g / NUT_DAYS) * Math.PI * 2;
}

// TILT
// lean (radians toward x and z) to a unit direction in dX dY dZ
let dX = 0;
let dY = 1;
let dZ = 0;
function tilt(x: number, z: number) {
  const m = Math.hypot(x, z);
  const s = m > 1e-6 ? Math.sin(m) / m : 1;
  dX = x * s;
  dY = Math.cos(m);
  dZ = z * s;
}

// LEAF DROP
// tip height over base per unit length: rising at e, bending down by d
function dropOf(e: number, d: number) {
  return (Math.cos(e - d) - Math.cos(e)) / d;
}

function ease(x: number) {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

function smooth(a: number, b: number, x: number) {
  return ease((x - a) / (b - a));
}

function mix(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
