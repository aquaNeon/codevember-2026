import { MAX_RIM, type Crystal } from "./crystal";
import { orient } from "./motion";
import { SCENE, SUN } from "./scene";

// BEAMS
// one sunbeam per sunlit face, traced through the solid on the cpu: refract in, bounce off
// the inside until it can leave, leave once for red and once for violet, land on the wall.
// every way a beam can switch paths (crossing a face edge, tipping into total reflection,
// turning from the sun) is faded through zero, so flecks fade out and in but never jump

export const STRIDE = 7; // red xy, violet xy, radius, gain, seed (negative: plain light)
const BOUNCES = 5;
const MIN_GAIN = 0.02;
const EDGE_FADE = 0.3; // of a beam's radius, how close to an edge a beam starts to fade
const TIR_FADE = 0.2; // how far below the critical angle a leaving beam starts to fade
const GAIN = 7;
// SWAY
// each face feels only its own share of the swing, so the flecks slide at different rates
// and stretch on their own instead of riding the crystal as one block
const SWAY = [0.12, 0.55];
const TRAVEL = 0.18; // how much of the crystal's own travel the flecks share
// GLIDE
// each fleck trails its beam by its own few frames, so the field drifts rather than snaps
const LAG_S = [0.08, 0.3];
// LOOK
// small soft flecks: a short run of colour a few radii long, never a string
const RADIUS_M = [0.007, 0.036];
const RUN = [0.6, 3.4]; // red to violet run, in radii
const MAX_STRETCH = 1.8; // grazing beams lengthen up to this
const STRENGTH = [0.35, 1.1];
const FLECKS = 3; // most flecks on the wall at once
const LEVEL_RAD = 1.35; // swing angle by which the flecks are gone

const IOR = SCENE.ior;
const IOR_R = SCENE.ior - SCENE.spread / 2;
const IOR_V = SCENE.ior + SCENE.spread / 2;

export class Beams {
  readonly data: Float32Array;
  count = 0;
  restY: number = SCENE.restY; // where the stone's top hangs at rest
  private s = new Float32Array(3);
  private hit = new Float32Array(2);
  private r = new Float32Array(9);
  private dirX = 0;
  private dirY = 0;

  private look: Float32Array; // radius, run, strength, lag per face and bounce
  private sway: Float32Array; // per face
  private raw: Float32Array; // this frame's fleck per slot
  private eased: Float32Array; // what is drawn, per slot
  private alive: Uint8Array;
  private slots: number;
  private seed: Float32Array;
  private top = new Int32Array(FLECKS + 1);
  private topG = new Float32Array(FLECKS + 1);

  // extra: slots after the flecks the host fills itself
  constructor(
    private c: Crystal,
    extra: number,
  ) {
    const n = c.faces * BOUNCES;
    this.slots = n;
    this.data = new Float32Array((FLECKS + extra) * STRIDE);
    this.seed = new Float32Array(n);
    for (let k = 0; k < n; k++) this.seed[k] = hash(k * 11 + 3);
    this.raw = new Float32Array(n * STRIDE);
    this.eased = new Float32Array(n * STRIDE);
    this.alive = new Uint8Array(n);
    this.look = new Float32Array(n * 4);
    for (let k = 0; k < n; k++) {
      this.look[k * 4] = RADIUS_M[0] + (RADIUS_M[1] - RADIUS_M[0]) * hash(k * 3 + 1) ** 2;
      this.look[k * 4 + 1] = RUN[0] + (RUN[1] - RUN[0]) * hash(k * 3 + 2);
      this.look[k * 4 + 2] = STRENGTH[0] + (STRENGTH[1] - STRENGTH[0]) * hash(k * 3 + 3) ** 2;
      this.look[k * 4 + 3] = LAG_S[0] + (LAG_S[1] - LAG_S[0]) * hash(k * 7 + 5);
    }
    this.sway = new Float32Array(c.faces);
    for (let i = 0; i < c.faces; i++)
      this.sway[i] = SWAY[0] + (SWAY[1] - SWAY[0]) * hash(i * 13 + 7);
  }

  // the crystal's lean and twist, and its origin in the world
  trace(ax: number, az: number, twist: number, at: Float32Array, dt: number) {
    this.alive.fill(0);
    // flecks belong to a hanging stone: they fade out as a big swing goes past level
    ax -= Math.PI * 2 * Math.round(ax / (Math.PI * 2));
    const up = smooth(LEVEL_RAD, LEVEL_RAD * 0.6, Math.abs(ax));
    const c = this.c;
    const pl = c.planes;
    const s = this.s;
    const rot = this.r;

    for (let i = 0; i < c.faces; i++) {
      const nx = pl[i * 4];
      const ny = pl[i * 4 + 1];
      const nz = pl[i * 4 + 2];
      const k = this.sway[i];
      orient(rot, ax * k, az * k, twist);
      for (let q = 0; q < 3; q++)
        s[q] = rot[q * 3] * SUN[0] + rot[q * 3 + 1] * SUN[1] + rot[q * 3 + 2] * SUN[2];
      const cosIn = -(nx * s[0] + ny * s[1] + nz * s[2]);
      if (cosIn < 0.02) continue;

      // IN
      const eta = 1 / IOR;
      const k0 = 1 - eta * eta * (1 - cosIn * cosIn);
      const m0 = eta * cosIn - Math.sqrt(k0);
      let dx = eta * s[0] + m0 * nx;
      let dy = eta * s[1] + m0 * ny;
      let dz = eta * s[2] + m0 * nz;
      let px = c.centroid[i * 3];
      let py = c.centroid[i * 3 + 1];
      let pz = c.centroid[i * 3 + 2];
      let gain = cosIn * smooth(0.02, 0.25, cosIn) * (1 - fresnel(cosIn)) * up;
      const reach = c.aperture[i] * 0.5 * Math.sqrt(cosIn);

      for (let b = 0; b < BOUNCES && gain > MIN_GAIN; b++) {
        // OUT
        let t = 1e3;
        let j = -1;
        for (let q = 0; q < c.faces; q++) {
          const dn = dx * pl[q * 4] + dy * pl[q * 4 + 1] + dz * pl[q * 4 + 2];
          if (dn <= 1e-5) continue;
          const tq =
            (pl[q * 4 + 3] - (px * pl[q * 4] + py * pl[q * 4 + 1] + pz * pl[q * 4 + 2])) / dn;
          if (tq < t) {
            t = tq;
            j = q;
          }
        }
        if (j < 0) break;
        px += dx * t;
        py += dy * t;
        pz += dz * t;
        const mx = pl[j * 4];
        const my = pl[j * 4 + 1];
        const mz = pl[j * 4 + 2];
        gain *= smooth(0, EDGE_FADE * reach, this.edge(j, px, py, pz, mx, my, mz));
        if (gain <= MIN_GAIN) break;

        const ci = dx * mx + dy * my + dz * mz;
        const sin2 = 1 - ci * ci;
        // fades to nothing as violet nears total reflection; what does not leave reflects on
        const leave = smooth(1, 1 - TIR_FADE, IOR_V * IOR_V * sin2);
        if (leave > 0) {
          this.emit(at, px, py, pz, dx, dy, dz, mx, my, mz, ci, gain * leave, i * BOUNCES + b);
          gain *= 1 - leave;
        }
        dx -= 2 * ci * mx;
        dy -= 2 * ci * my;
        dz -= 2 * ci * mz;
      }
    }
    this.ease(dt);
  }

  // every slot glides toward this frame's fleck and fades out when its beam is gone. cloudy
  // quartz scatters most of the light, so only the strongest few reach the wall as colour,
  // each dimmed by the next in line so one taking another's place fades instead of popping
  private ease(dt: number) {
    const raw = this.raw;
    const e = this.eased;
    const top = this.top;
    const topG = this.topG;
    topG.fill(0);
    top.fill(-1);
    for (let k = 0; k < this.slots; k++) {
      const o = k * STRIDE;
      const was = e[o + 5];
      const a = dt > 0 ? 1 - Math.exp(-dt / this.look[k * 4 + 3]) : 1;
      if (this.alive[k]) {
        // a fleck coming back from nothing appears where it is, it does not fly in
        const snap = was < MIN_GAIN ? 1 : a;
        for (let q = 0; q < 5; q++) e[o + q] += (raw[o + q] - e[o + q]) * snap;
        e[o + 5] = was + (raw[o + 5] - was) * a;
      } else e[o + 5] = was * (1 - a);
      const g = e[o + 5];
      if (g < MIN_GAIN || g <= topG[FLECKS]) continue;
      let i = FLECKS;
      while (i > 0 && topG[i - 1] < g) {
        topG[i] = topG[i - 1];
        top[i] = top[i - 1];
        i--;
      }
      topG[i] = g;
      top[i] = k;
    }
    const out = this.data;
    this.count = 0;
    for (let i = 0; i < FLECKS; i++) {
      const g = topG[i] - topG[FLECKS];
      if (top[i] < 0 || g < MIN_GAIN) continue;
      const o = top[i] * STRIDE;
      const d = this.count * STRIDE;
      for (let q = 0; q < 5; q++) out[d + q] = e[o + q];
      out[d + 5] = g;
      out[d + 6] = this.seed[top[i]];
      this.count++;
    }
  }

  // distance from a point on face j to its nearest rim edge
  private edge(j: number, px: number, py: number, pz: number, nx: number, ny: number, nz: number) {
    const r = this.c.corners;
    const n = this.c.rimCount[j];
    const o = j * MAX_RIM * 3;
    let min = Infinity;
    for (let k = 0; k < n; k++) {
      const a = o + k * 3;
      const b = o + ((k + 1) % n) * 3;
      const ex = r[b] - r[a];
      const ey = r[b + 1] - r[a + 1];
      const ez = r[b + 2] - r[a + 2];
      // inward perpendicular in the face plane: n x e
      let ix = ny * ez - nz * ey;
      let iy = nz * ex - nx * ez;
      let iz = nx * ey - ny * ex;
      const l = Math.hypot(ix, iy, iz) || 1;
      ix /= l;
      iy /= l;
      iz /= l;
      const d = (px - r[a]) * ix + (py - r[a + 1]) * iy + (pz - r[a + 2]) * iz;
      if (d < min) min = d;
    }
    return min;
  }

  private emit(
    at: Float32Array,
    px: number,
    py: number,
    pz: number,
    dx: number,
    dy: number,
    dz: number,
    mx: number,
    my: number,
    mz: number,
    ci: number,
    gain: number,
    k: number,
  ) {
    const rot = this.r;
    const look = this.look;
    const radius = look[k * 4];
    gain *= look[k * 4 + 2];
    // exit point, with only a share of the crystal's travel off its resting place
    const wx = rot[0] * px + rot[3] * py + rot[6] * pz + at[0] * TRAVEL;
    const wy = rot[1] * px + rot[4] * py + rot[7] * pz + this.restY + (at[1] - this.restY) * TRAVEL;
    const wz = SCENE.crystalZ;
    const o = k * STRIDE;
    const out = this.raw;
    const h = this.hit;

    // red and violet leave at their own angles
    let zr = this.land(wx, wy, wz, dx, dy, dz, mx, my, mz, ci, IOR_R);
    if (zr >= 0) return;
    const rx = h[0];
    const ry = h[1];
    const zv = this.land(wx, wy, wz, dx, dy, dz, mx, my, mz, ci, IOR_V);
    if (zv >= 0) return;

    // grazing beams fade before they would run along the wall
    zr = -0.5 * (zr + zv);
    gain *= smooth(0.12, 0.35, zr) * Math.sqrt(zr) * GAIN;
    if (gain < MIN_GAIN) return;

    // RUN
    // the true split, held to a short run: barely bent beams still show their colours, wide
    // ones never become strings. grazing beams land a little longer
    let sx = h[0] - rx;
    let sy = h[1] - ry;
    const sl = Math.hypot(sx, sy);
    if (sl > 1e-6) {
      sx /= sl;
      sy /= sl;
    } else {
      const ul = Math.hypot(this.dirX, this.dirY) || 1;
      sx = this.dirX / ul;
      sy = this.dirY / ul;
    }
    const want = radius * look[k * 4 + 1] * Math.min(MAX_STRETCH, 1 / Math.sqrt(zr));
    const run = Math.min(want, Math.max(want * 0.6, sl));
    const cx = (rx + h[0]) / 2;
    const cy = (ry + h[1]) / 2;
    out[o] = cx - (sx * run) / 2;
    out[o + 1] = cy - (sy * run) / 2;
    out[o + 2] = cx + (sx * run) / 2;
    out[o + 3] = cy + (sy * run) / 2;
    out[o + 4] = radius;
    out[o + 5] = gain;
    this.alive[k] = 1;
  }

  // refracts out of the face with this ior and finds the wall; returns the world z of the
  // direction (negative when it heads for the wall), hit in this.hit
  private land(
    wx: number,
    wy: number,
    wz: number,
    dx: number,
    dy: number,
    dz: number,
    mx: number,
    my: number,
    mz: number,
    ci: number,
    ior: number,
  ) {
    const rot = this.r;
    const k = 1 - ior * ior * (1 - ci * ci);
    if (k <= 0) return 1;
    const m = Math.sqrt(k) - ior * ci;
    const lx = ior * dx + m * mx;
    const ly = ior * dy + m * my;
    const lz = ior * dz + m * mz;
    const gx = rot[0] * lx + rot[3] * ly + rot[6] * lz;
    const gy = rot[1] * lx + rot[4] * ly + rot[7] * lz;
    const gz = rot[2] * lx + rot[5] * ly + rot[8] * lz;
    if (gz > -1e-3) return 1;
    const t = -wz / gz;
    this.hit[0] = wx + gx * t;
    this.hit[1] = wy + gy * t;
    this.dirX = gx;
    this.dirY = gy;
    return gz;
  }
}

function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function fresnel(c: number) {
  return 0.05 + 0.95 * (1 - c) ** 5;
}

function hash(n: number) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}
