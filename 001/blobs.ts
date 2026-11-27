import { BufferAttribute, BufferGeometry } from "three";
import { edgeTable, triTable } from "three/examples/jsm/objects/MarchingCubes.js";
import { benchY } from "./bench";

// METABALL SURFACE
// particles splat into a density grid, marching cubes extracts the iso surface

export const BLOB = {
  radius: 0.3,
  iso: 0.42, // change higher to pull the skin in
  blur: 3, // change for a smoother skin
  bridge: 0.45,
  fill: 0.2,
  fillMax: 600,
  strand: 5,
  gap: 0.5,
  cell: 0.07, // change smaller for smoother, slower
};

const SIZE = [6.6, 3.85, 6.6];
const MAX_TRIS = 40000;
const CREASE = {
  near: 0.26,
  far: 0.46,
  full: 0.3,
};
// SKIN ATTRIBUTES
// per-particle rest pos, flour, strain, tack splatted on a coarse grid
const ATTR = { cell: 0.14, radius: 0.36, solid: 0.35 };
const CH = 10;
const FALLBACK = { flour: 0.15, strain: 1.6, tack: 0.4 };
const CONTACT_TAPS = [0.012, 0.035, 0.08];
const FOLLOW_CELLS = 2.5;
const NODE = 6;
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_FULL = HASH_SIZE * 0.7;
const PICK_FAR = 40;
// FLOOR
// grid starts below the worktop so the board clips the skin with no gap
const FLOOR_DEPTH = -0.42;

const CORNER = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1];
const EDGE = [0, 1, 1, 2, 3, 2, 0, 3, 4, 5, 5, 6, 7, 6, 4, 7, 0, 4, 1, 5, 2, 6, 3, 7];

export type Skin = {
  count: number;
  rest: Float32Array;
  flour: Float32Array;
  strain: Float32Array;
  tack: Float32Array;
};

export class Blobs {
  readonly geometry = new BufferGeometry();
  readonly nx: number;
  private ny: number;
  readonly nz: number;
  private field: Float32Array;
  private tmp: Float32Array;
  private pos = new Float32Array(MAX_TRIS * 9);
  private nor = new Float32Array(MAX_TRIS * 9);
  private rest = new Float32Array(MAX_TRIS * 9);
  private mat = new Float32Array(MAX_TRIS * 12);
  private anx: number;
  private any: number;
  private anz: number;
  private attr: Float32Array;
  private acc = new Float32Array(CH);
  private ea = new Float32Array(12 * 6);
  private hkey = new Int32Array(HASH_SIZE);
  private hstamp = new Uint32Array(HASH_SIZE);
  private nval = new Float32Array((HASH_SIZE + 1) * 6);
  private stamp = 0;
  private cached = 0;
  private ev = new Float32Array(36);
  private en = new Float32Array(36);
  private cv = new Float32Array(8);
  private gx = new Float32Array(8);
  private gy = new Float32Array(8);
  private gz = new Float32Array(8);
  private box = new Int32Array([0, 0, 0, 0, 0, 0]);
  // SETTLE
  // drawn field eases toward the new one; 1 snaps
  blend = 1;
  private prev: Float32Array;
  private last = new Int32Array(6);
  private wide = new Int32Array(6);
  private primed = false;
  private span = new Int32Array(6);
  private near = new Uint8Array(0);
  private min = new Float64Array(3);

  constructor() {
    const c = BLOB.cell;
    this.nx = Math.ceil(SIZE[0] / c) + 1;
    this.ny = Math.ceil(SIZE[1] / c) + 1;
    this.nz = Math.ceil(SIZE[2] / c) + 1;
    this.min[0] = -SIZE[0] / 2;
    this.min[1] = FLOOR_DEPTH;
    this.min[2] = -SIZE[2] / 2;
    this.field = new Float32Array(this.nx * this.ny * this.nz);
    this.tmp = new Float32Array(this.field.length);
    this.prev = new Float32Array(this.field.length);
    this.anx = Math.ceil(SIZE[0] / ATTR.cell) + 2;
    this.any = Math.ceil(SIZE[1] / ATTR.cell) + 2;
    this.anz = Math.ceil(SIZE[2] / ATTR.cell) + 2;
    this.attr = new Float32Array(this.anx * this.any * this.anz * CH);
    this.geometry.setAttribute("position", new BufferAttribute(this.pos, 3));
    this.geometry.setAttribute("normal", new BufferAttribute(this.nor, 3));
    this.geometry.setAttribute("aRest", new BufferAttribute(this.rest, 3));
    this.geometry.setAttribute("aMat", new BufferAttribute(this.mat, 4));
    this.geometry.setDrawRange(0, 0);
  }

  update(x: Float32Array, count: number, la?: Uint16Array, lb?: Uint16Array, skin?: Skin) {
    if (this.shape(x, count, la, lb, skin)) this.mesh(skin);
  }

  // FIELD
  // split from mesh() so a cold first build can yield between them
  shape(x: Float32Array, count: number, la?: Uint16Array, lb?: Uint16Array, skin?: Skin) {
    const { nx, ny, field, box, span } = this;
    const sxy = nx * ny;

    // CLEAR
    for (let k = box[2]; k <= box[5]; k++)
      for (let j = box[1]; j <= box[4]; j++)
        field.fill(0, k * sxy + j * nx + box[0], k * sxy + j * nx + box[3] + 1);

    // FOLLOW
    // re-centre on the dough, snapped to whole cells so the skin does not shimmer
    let lo0 = Infinity,
      hi0 = -Infinity,
      lo2 = Infinity,
      hi2 = -Infinity;
    for (let i = 0; i < count; i++) {
      const px = x[i * 3],
        pz = x[i * 3 + 2];
      if (px < lo0) lo0 = px;
      if (px > hi0) hi0 = px;
      if (pz < lo2) lo2 = pz;
      if (pz > hi2) hi2 = pz;
    }
    if (count) {
      const c = BLOB.cell;
      const tx = (lo0 + hi0) / 2 - SIZE[0] / 2,
        tz = (lo2 + hi2) / 2 - SIZE[2] / 2;
      const di =
        Math.abs(tx - this.min[0]) > c * FOLLOW_CELLS ? Math.round((tx - this.min[0]) / c) : 0;
      const dk =
        Math.abs(tz - this.min[2]) > c * FOLLOW_CELLS ? Math.round((tz - this.min[2]) / c) : 0;
      if (di || dk) {
        this.min[0] += di * c;
        this.min[2] += dk * c;
        this.shift(di, dk);
      }
    }

    // SPLAT
    span[0] = nx;
    span[1] = ny;
    span[2] = this.nz;
    span[3] = 0;
    span[4] = 0;
    span[5] = 0;
    for (let i = 0; i < count; i++) this.splat(x[i * 3], x[i * 3 + 1], x[i * 3 + 2]);

    // BRIDGE
    // filler blobs along long links whose end has few short neighbours (strands only)
    if (la && lb) {
      const { near } = this;
      if (near.length < count) this.near = new Uint8Array(count);
      const nb = this.near;
      nb.fill(0, 0, count);
      for (let k = 0; k < la.length; k++) {
        if (this.linkLen(x, la[k], lb[k]) > BLOB.bridge) continue;
        if (nb[la[k]] < 255) nb[la[k]]++;
        if (nb[lb[k]] < 255) nb[lb[k]]++;
      }
      let total = 0;
      for (let k = 0; k < la.length; k++) {
        const len = this.linkLen(x, la[k], lb[k]);
        if (
          len > BLOB.bridge &&
          (len > BLOB.gap || nb[la[k]] < BLOB.strand || nb[lb[k]] < BLOB.strand)
        )
          total += len;
      }
      const gap = Math.max(BLOB.fill, total / BLOB.fillMax);
      for (let k = 0; k < la.length; k++) {
        const len = this.linkLen(x, la[k], lb[k]);
        if (
          len <= BLOB.bridge ||
          (len <= BLOB.gap && nb[la[k]] >= BLOB.strand && nb[lb[k]] >= BLOB.strand)
        )
          continue;
        const i = la[k] * 3,
          j = lb[k] * 3;
        const steps = Math.max(2, Math.ceil(len / gap));
        for (let s2 = 1; s2 < steps; s2++) {
          const t = s2 / steps;
          this.splat(
            x[i] + (x[j] - x[i]) * t,
            x[i + 1] + (x[j + 1] - x[i + 1]) * t,
            x[i + 2] + (x[j + 2] - x[i + 2]) * t,
          );
        }
      }
    }

    if (span[0] > span[3]) {
      this.geometry.setDrawRange(0, 0);
      box.fill(0);
      return false;
    }
    box.set(span);

    for (let p = 0; p < BLOB.blur; p++) this.smooth();
    this.settle();

    if (skin) {
      this.splatSkin(x, skin);
      this.stamp = (this.stamp + 1) >>> 0 || 1;
      this.cached = 0;
    }
    return true;
  }

  // MESH
  mesh(skin?: Skin) {
    const skinned = !!skin;
    const { field, box, nx, ny } = this;
    const sxy = nx * ny;
    const { pos, nor, ev, en, cv, gx, gy, gz, nz, ea, rest, mat } = this;
    const iso = BLOB.iso;
    const c = BLOB.cell;
    const x0 = box[0],
      y0 = box[1],
      z0 = box[2],
      x1 = box[3],
      y1 = box[4],
      z1 = box[5];
    let v = 0;
    const limit = MAX_TRIS * 9;
    for (let k = z0 - 1; k <= z1; k++) {
      for (let j = y0 - 1; j <= y1; j++) {
        for (let i = x0 - 1; i <= x1; i++) {
          let idx = 0;
          for (let n = 0; n < 8; n++) {
            const q =
              (k + CORNER[n * 3 + 2]) * sxy + (j + CORNER[n * 3 + 1]) * nx + i + CORNER[n * 3];
            const f = field[q];
            cv[n] = f;
            if (f < iso) idx |= 1 << n;
          }
          const bits = edgeTable[idx];
          if (!bits) continue;

          for (let n = 0; n < 8; n++) {
            const ci = i + CORNER[n * 3],
              cj = j + CORNER[n * 3 + 1],
              ck = k + CORNER[n * 3 + 2];
            const q = ck * sxy + cj * nx + ci;
            const sx = ci > 1 && ci < nx - 2 ? 2 : 1,
              sy = cj > 1 && cj < ny - 2 ? 2 : 1,
              sz = ck > 1 && ck < nz - 2 ? 2 : 1;
            gx[n] = field[q - sx] - field[q + sx];
            gy[n] = field[q - sy * nx] - field[q + sy * nx];
            gz[n] = field[q - sz * sxy] - field[q + sz * sxy];
          }
          for (let e = 0; e < 12; e++) {
            if (!(bits & (1 << e))) continue;
            const a = EDGE[e * 2],
              b = EDGE[e * 2 + 1];
            const fa = cv[a],
              fb = cv[b];
            const t = Math.abs(fb - fa) > 1e-6 ? (iso - fa) / (fb - fa) : 0.5;
            ev[e * 3] = this.min[0] + (i + CORNER[a * 3] + (CORNER[b * 3] - CORNER[a * 3]) * t) * c;
            ev[e * 3 + 1] =
              this.min[1] +
              (j + CORNER[a * 3 + 1] + (CORNER[b * 3 + 1] - CORNER[a * 3 + 1]) * t) * c;
            ev[e * 3 + 2] =
              this.min[2] +
              (k + CORNER[a * 3 + 2] + (CORNER[b * 3 + 2] - CORNER[a * 3 + 2]) * t) * c;
            const ngx = gx[a] + (gx[b] - gx[a]) * t;
            const ngy = gy[a] + (gy[b] - gy[a]) * t;
            const ngz = gz[a] + (gz[b] - gz[a]) * t;
            const l = Math.sqrt(ngx * ngx + ngy * ngy + ngz * ngz) || 1;
            en[e * 3] = ngx / l;
            en[e * 3 + 1] = ngy / l;
            en[e * 3 + 2] = ngz / l;
            if (!skinned) continue;
            // SKIN
            const sa = this.node(i + CORNER[a * 3], j + CORNER[a * 3 + 1], k + CORNER[a * 3 + 2]);
            const sb = this.node(i + CORNER[b * 3], j + CORNER[b * 3 + 1], k + CORNER[b * 3 + 2]);
            const nv = this.nval;
            for (let ch = 0; ch < NODE; ch++)
              ea[e * NODE + ch] = nv[sa + ch] + (nv[sb + ch] - nv[sa + ch]) * t;
          }
          const base = idx * 16;
          for (let m = 0; triTable[base + m] !== -1 && v < limit; m++) {
            const e = triTable[base + m] * 3;
            pos[v] = ev[e];
            pos[v + 1] = ev[e + 1];
            pos[v + 2] = ev[e + 2];
            nor[v] = en[e];
            nor[v + 1] = en[e + 1];
            nor[v + 2] = en[e + 2];
            if (skinned) {
              const q = (e / 3) * NODE,
                m = (v / 3) * 4;
              rest[v] = ea[q];
              rest[v + 1] = ea[q + 1];
              rest[v + 2] = ea[q + 2];
              mat[m + 1] = ea[q + 3];
              mat[m + 2] = ea[q + 4];
              mat[m + 3] = ea[q + 5];
            }
            v += 3;
          }
        }
      }
    }
    this.geometry.setDrawRange(0, v / 3);

    // CREASES
    // field just outside a vertex = another layer pressed against it
    const lim = BLOB.iso * CREASE.full;
    for (let o = 0; o < v; o += 3) {
      const px = pos[o],
        py = pos[o + 1],
        pz = pos[o + 2];
      const qx = nor[o],
        qy = nor[o + 1],
        qz = nor[o + 2];
      const f = Math.max(
        this.sample(px + qx * CREASE.near, py + qy * CREASE.near, pz + qz * CREASE.near),
        this.sample(px + qx * CREASE.far, py + qy * CREASE.far, pz + qz * CREASE.far),
      );
      const t = Math.min(1, f / lim);
      const m = (o / 3) * 4;
      mat[m] = t * t * (3 - 2 * t);
    }
    const ra = this.geometry.attributes.aRest as BufferAttribute;
    const ma = this.geometry.attributes.aMat as BufferAttribute;
    ra.clearUpdateRanges();
    ma.clearUpdateRanges();
    ra.addUpdateRange(0, v);
    ma.addUpdateRange(0, (v / 3) * 4);
    ra.needsUpdate = true;
    ma.needsUpdate = true;
    const pa = this.geometry.attributes.position as BufferAttribute;
    const na = this.geometry.attributes.normal as BufferAttribute;
    pa.clearUpdateRanges();
    na.clearUpdateRanges();
    pa.addUpdateRange(0, v);
    na.addUpdateRange(0, v);
    pa.needsUpdate = true;
    na.needsUpdate = true;
  }

  // SHIFT
  // smoothed field moves with the grid
  private shift(di: number, dk: number) {
    if (!this.primed) return;
    const { prev, last, nx, ny, nz } = this;
    if (Math.abs(di) >= nx || Math.abs(dk) >= nz) {
      this.primed = false;
      return;
    }
    const o = dk * nx * ny + di;
    if (o > 0) {
      prev.copyWithin(0, o);
      prev.fill(0, prev.length - o);
    } else {
      prev.copyWithin(-o, 0, prev.length + o);
      prev.fill(0, 0, -o);
    }
    last[0] = Math.max(1, last[0] - di);
    last[3] = Math.min(nx - 2, last[3] - di);
    last[2] = Math.max(1, last[2] - dk);
    last[5] = Math.min(nz - 2, last[5] - dk);
  }

  private settle() {
    const { field, prev, box, last, wide, nx, ny } = this;
    const sxy = nx * ny;
    const a = this.primed ? this.blend : 1;
    for (let k = 0; k < 3; k++) {
      wide[k] = this.primed ? Math.min(box[k], last[k]) : box[k];
      wide[k + 3] = this.primed ? Math.max(box[k + 3], last[k + 3]) : box[k + 3];
    }
    if (a < 1) {
      for (let k = wide[2]; k <= wide[5]; k++)
        for (let j = wide[1]; j <= wide[4]; j++) {
          const row = k * sxy + j * nx;
          for (let i = wide[0]; i <= wide[3]; i++) {
            const q = row + i;
            field[q] = prev[q] + (field[q] - prev[q]) * a;
          }
        }
    }
    if (this.primed)
      for (let k = last[2]; k <= last[5]; k++)
        for (let j = last[1]; j <= last[4]; j++)
          prev.fill(0, k * sxy + j * nx + last[0], k * sxy + j * nx + last[3] + 1);
    for (let k = wide[2]; k <= wide[5]; k++)
      for (let j = wide[1]; j <= wide[4]; j++) {
        const row = k * sxy + j * nx;
        prev.set(field.subarray(row + wide[0], row + wide[3] + 1), row + wide[0]);
      }
    last.set(box);
    box.set(wide);
    this.primed = true;
  }

  // SKIN SPLAT
  // weighted sums on the coarse grid; a vertex reads sum / weight
  private splatSkin(x: Float32Array, skin: Skin) {
    const { attr, anx, any, anz } = this;
    attr.fill(0);
    const c = ATTR.cell;
    const R = ATTR.radius;
    const R2 = R * R;
    const reach = Math.ceil(R / c);
    const sxy = anx * any;
    const { rest, flour, strain, tack } = skin;
    for (let p = 0; p < skin.count; p++) {
      const px = x[p * 3],
        py = x[p * 3 + 1],
        pz = x[p * 3 + 2];
      const ci = Math.round((px - this.min[0]) / c),
        cj = Math.round((py - this.min[1]) / c),
        ck = Math.round((pz - this.min[2]) / c);
      const a0 = Math.max(0, ci - reach),
        a1 = Math.min(anx - 1, ci + reach);
      const b0 = Math.max(0, cj - reach),
        b1 = Math.min(any - 1, cj + reach);
      const d0 = Math.max(0, ck - reach),
        d1 = Math.min(anz - 1, ck + reach);
      const r0 = rest[p * 3],
        r1 = rest[p * 3 + 1],
        r2 = rest[p * 3 + 2];
      const fl = flour[p],
        st = strain[p],
        tk = tack[p];
      for (let k = d0; k <= d1; k++) {
        const dz = this.min[2] + k * c - pz;
        for (let j = b0; j <= b1; j++) {
          const dy = this.min[1] + j * c - py;
          const dyz = dy * dy + dz * dz;
          if (dyz >= R2) continue;
          for (let i = a0; i <= a1; i++) {
            const dx = this.min[0] + i * c - px;
            const d2 = dx * dx + dyz;
            if (d2 >= R2) continue;
            const t = 1 - d2 / R2;
            const w = t * t * t;
            const q = (k * sxy + j * anx + i) * CH;
            attr[q] += w;
            attr[q + 1] += w * r0;
            attr[q + 2] += w * r1;
            attr[q + 3] += w * r2;
            attr[q + 4] += w * px;
            attr[q + 5] += w * py;
            attr[q + 6] += w * pz;
            attr[q + 7] += w * fl;
            attr[q + 8] += w * st;
            attr[q + 9] += w * tk;
          }
        }
      }
    }
  }

  // CONTACT
  // field / (2 iso) at three heights per column, rgb; drives the board crevice shadow
  contact(out: Uint8Array, box: Float32Array) {
    const { nx, nz } = this;
    const c = BLOB.cell;
    const s = 127.5 / BLOB.iso;
    for (let k = 0; k < nz; k++) {
      const z = this.min[2] + k * c;
      for (let i = 0; i < nx; i++) {
        const x = this.min[0] + i * c;
        const b = benchY(x, z);
        const o = (k * nx + i) * 4;
        out[o] = Math.min(255, this.sample(x, b + CONTACT_TAPS[0], z) * s);
        out[o + 1] = Math.min(255, this.sample(x, b + CONTACT_TAPS[1], z) * s);
        out[o + 2] = Math.min(255, this.sample(x, b + CONTACT_TAPS[2], z) * s);
        out[o + 3] = 255;
      }
    }
    box[0] = this.min[0] - c * 0.5;
    box[1] = this.min[2] - c * 0.5;
    box[2] = nx * c;
    box[3] = nz * c;
  }

  // NODE CACHE
  // hashed per-node attributes; edges lerp two nodes so neighbouring cubes agree
  private node(i: number, j: number, k: number) {
    const q = (k * this.ny + j) * this.nx + i;
    const { hkey, hstamp } = this;
    let h = Math.imul(q, 0x9e3779b1) >>> (32 - HASH_BITS);
    for (let probe = 0; probe < 32; probe++) {
      if (hstamp[h] !== this.stamp) {
        if (this.cached > HASH_FULL) break;
        hstamp[h] = this.stamp;
        hkey[h] = q;
        this.cached++;
        this.fillNode(h * NODE, i, j, k);
        return h * NODE;
      }
      if (hkey[h] === q) return h * NODE;
      h = (h + 1) & (HASH_SIZE - 1);
    }
    this.fillNode(HASH_SIZE * NODE, i, j, k);
    return HASH_SIZE * NODE;
  }

  private fillNode(o: number, i: number, j: number, k: number) {
    const c = BLOB.cell;
    const px = this.min[0] + i * c,
      py = this.min[1] + j * c,
      pz = this.min[2] + k * c;
    const { acc, nval } = this;
    const w = this.sampleSkin(px, py, pz);
    const s = Math.min(1, w / ATTR.solid);
    const iw = w > 1e-5 ? 1 / w : 0;
    nval[o] = px + (acc[1] - acc[4]) * iw * s;
    nval[o + 1] = py + (acc[2] - acc[5]) * iw * s;
    nval[o + 2] = pz + (acc[3] - acc[6]) * iw * s;
    nval[o + 3] = FALLBACK.flour + (acc[7] * iw - FALLBACK.flour) * s;
    nval[o + 4] = FALLBACK.strain + (acc[8] * iw - FALLBACK.strain) * s;
    nval[o + 5] = FALLBACK.tack + (acc[9] * iw - FALLBACK.tack) * s;
  }

  private sampleSkin(x: number, y: number, z: number) {
    const { attr, anx, any, anz, acc } = this;
    acc[0] = 0;
    const c = ATTR.cell;
    const fx = (x - this.min[0]) / c,
      fy = (y - this.min[1]) / c,
      fz = (z - this.min[2]) / c;
    const i = Math.floor(fx),
      j = Math.floor(fy),
      k = Math.floor(fz);
    if (i < 0 || j < 0 || k < 0 || i >= anx - 1 || j >= any - 1 || k >= anz - 1) return 0;
    const tx = fx - i,
      ty = fy - j,
      tz = fz - k;
    const ox = CH,
      oy = anx * CH,
      oz = anx * any * CH;
    const q = ((k * any + j) * anx + i) * CH;
    const ux = 1 - tx,
      uy = 1 - ty,
      uz = 1 - tz;
    const w0 = ux * uy * uz,
      w1 = tx * uy * uz,
      w2 = ux * ty * uz,
      w3 = tx * ty * uz,
      w4 = ux * uy * tz,
      w5 = tx * uy * tz,
      w6 = ux * ty * tz,
      w7 = tx * ty * tz;
    for (let ch = 0; ch < CH; ch++) {
      const r = q + ch;
      acc[ch] =
        attr[r] * w0 +
        attr[r + ox] * w1 +
        attr[r + oy] * w2 +
        attr[r + ox + oy] * w3 +
        attr[r + oz] * w4 +
        attr[r + ox + oz] * w5 +
        attr[r + oy + oz] * w6 +
        attr[r + ox + oy + oz] * w7;
    }
    return acc[0];
  }

  private linkLen(x: Float32Array, a: number, b: number) {
    const i = a * 3,
      j = b * 3;
    const dx = x[j] - x[i],
      dy = x[j + 1] - x[i + 1],
      dz = x[j + 2] - x[i + 2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  private splat(px: number, py: number, pz: number) {
    const { nx, ny, nz, field, span } = this;
    const c = BLOB.cell;
    const R = BLOB.radius;
    const R2 = R * R;
    const reach = Math.ceil(R / c);
    const sxy = nx * ny;
    const ci = Math.round((px - this.min[0]) / c),
      cj = Math.round((py - this.min[1]) / c),
      ck = Math.round((pz - this.min[2]) / c);
    // BORDER
    // one empty cell border so marching cubes always closes the skin
    const a0 = Math.max(1, ci - reach),
      a1 = Math.min(nx - 2, ci + reach);
    const b0 = Math.max(1, cj - reach),
      b1 = Math.min(ny - 2, cj + reach);
    const d0 = Math.max(1, ck - reach),
      d1 = Math.min(nz - 2, ck + reach);
    if (a0 > a1 || b0 > b1 || d0 > d1) return;
    if (a0 < span[0]) span[0] = a0;
    if (b0 < span[1]) span[1] = b0;
    if (d0 < span[2]) span[2] = d0;
    if (a1 > span[3]) span[3] = a1;
    if (b1 > span[4]) span[4] = b1;
    if (d1 > span[5]) span[5] = d1;
    for (let k = d0; k <= d1; k++) {
      const dz = this.min[2] + k * c - pz;
      const dz2 = dz * dz;
      if (dz2 >= R2) continue;
      for (let j = b0; j <= b1; j++) {
        const dy = this.min[1] + j * c - py;
        const dyz = dy * dy + dz2;
        if (dyz >= R2) continue;
        const row = k * sxy + j * nx;
        for (let i = a0; i <= a1; i++) {
          const dx = this.min[0] + i * c - px;
          const d2 = dx * dx + dyz;
          if (d2 >= R2) continue;
          const t = 1 - d2 / R2;
          field[row + i] += t * t * t;
        }
      }
    }
  }

  // PICK
  // ray march through the field, linear refine at the crossing
  readonly hit = new Float32Array(3);

  pick(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) {
    const step = BLOB.cell * 0.5;
    const iso = BLOB.iso;
    let prev = 0;
    for (let t = 0; t < PICK_FAR; t += step) {
      const f = this.sample(ox + dx * t, oy + dy * t, oz + dz * t);
      if (f >= iso) {
        const back = f > prev ? (f - iso) / (f - prev) : 0;
        const th = t - step * back;
        this.hit[0] = ox + dx * th;
        this.hit[1] = oy + dy * th;
        this.hit[2] = oz + dz * th;
        return true;
      }
      prev = f;
    }
    return false;
  }

  private sample(x: number, y: number, z: number) {
    const { nx, ny, nz, field } = this;
    const c = BLOB.cell;
    const fx = (x - this.min[0]) / c,
      fy = (y - this.min[1]) / c,
      fz = (z - this.min[2]) / c;
    const i = Math.floor(fx),
      j = Math.floor(fy),
      k = Math.floor(fz);
    if (i < 0 || j < 0 || k < 0 || i >= nx - 1 || j >= ny - 1 || k >= nz - 1) return 0;
    const tx = fx - i,
      ty = fy - j,
      tz = fz - k;
    const sxy = nx * ny;
    const b = k * sxy + j * nx + i;
    const x00 = field[b] + (field[b + 1] - field[b]) * tx;
    const x10 = field[b + nx] + (field[b + nx + 1] - field[b + nx]) * tx;
    const x01 = field[b + sxy] + (field[b + sxy + 1] - field[b + sxy]) * tx;
    const x11 = field[b + sxy + nx] + (field[b + sxy + nx + 1] - field[b + sxy + nx]) * tx;
    const y0 = x00 + (x10 - x00) * ty;
    const y1 = x01 + (x11 - x01) * ty;
    return y0 + (y1 - y0) * tz;
  }

  // OUTSIDE
  // trilinear field sample, newton steps along the gradient
  push(q: Float32Array, count: number, margin: number) {
    const { nx, ny, nz, field } = this;
    const c = BLOB.cell;
    const sxy = nx * ny;
    const target = BLOB.iso * (1 - margin);
    for (let p = 0; p < count; p++) {
      const o = p * 3;
      for (let it = 0; it < 2; it++) {
        const fx = (q[o] - this.min[0]) / c,
          fy = (q[o + 1] - this.min[1]) / c,
          fz = (q[o + 2] - this.min[2]) / c;
        const i = Math.floor(fx),
          j = Math.floor(fy),
          k = Math.floor(fz);
        if (i < 0 || j < 0 || k < 0 || i >= nx - 1 || j >= ny - 1 || k >= nz - 1) break;
        const tx = fx - i,
          ty = fy - j,
          tz = fz - k;
        const b = k * sxy + j * nx + i;
        const f000 = field[b],
          f100 = field[b + 1],
          f010 = field[b + nx],
          f110 = field[b + nx + 1];
        const f001 = field[b + sxy],
          f101 = field[b + sxy + 1],
          f011 = field[b + sxy + nx],
          f111 = field[b + sxy + nx + 1];
        const x00 = f000 + (f100 - f000) * tx,
          x10 = f010 + (f110 - f010) * tx;
        const x01 = f001 + (f101 - f001) * tx,
          x11 = f011 + (f111 - f011) * tx;
        const y0 = x00 + (x10 - x00) * ty,
          y1 = x01 + (x11 - x01) * ty;
        const f = y0 + (y1 - y0) * tz;
        if (f <= target) break;
        const gx =
          ((f100 - f000) * (1 - ty) * (1 - tz) +
            (f110 - f010) * ty * (1 - tz) +
            (f101 - f001) * (1 - ty) * tz +
            (f111 - f011) * ty * tz) /
          c;
        const gy = ((x10 - x00) * (1 - tz) + (x11 - x01) * tz) / c;
        const gz = (y1 - y0) / c;
        const g2 = gx * gx + gy * gy + gz * gz;
        if (g2 < 1e-8) break;
        const k2 = (f - target) / g2;
        q[o] -= gx * k2;
        if (gy < 0) q[o + 1] -= gy * k2;
        q[o + 2] -= gz * k2;
      }
    }
  }

  touches(q: Float32Array, count: number, margin: number) {
    const target = BLOB.iso * (1 - margin);
    for (let p = 0; p < count * 3; p += 3)
      if (this.sample(q[p], q[p + 1], q[p + 2]) > target) return true;
    return false;
  }

  // BLUR
  // separable 1-2-1 per axis, inside the touched box
  private smooth() {
    const { nx, ny, nz, field, tmp, box } = this;
    box[0] = Math.max(1, box[0] - 1);
    box[1] = Math.max(1, box[1] - 1);
    box[2] = Math.max(1, box[2] - 1);
    box[3] = Math.min(nx - 2, box[3] + 1);
    box[4] = Math.min(ny - 2, box[4] + 1);
    box[5] = Math.min(nz - 2, box[5] + 1);
    this.clearTmp();
    this.pass(field, tmp, 1);
    this.pass(tmp, field, nx);
    this.pass(field, tmp, nx * ny);
    this.pass(tmp, field, 0);
  }

  private clearTmp() {
    const { nx, ny, nz, tmp, box } = this;
    const sxy = nx * ny;
    const x0 = Math.max(0, box[0] - 1),
      x1 = Math.min(nx - 1, box[3] + 1);
    const y0 = Math.max(0, box[1] - 1),
      y1 = Math.min(ny - 1, box[4] + 1);
    const z0 = Math.max(0, box[2] - 1),
      z1 = Math.min(nz - 1, box[5] + 1);
    for (let k = z0; k <= z1; k++)
      for (let j = y0; j <= y1; j++) tmp.fill(0, k * sxy + j * nx + x0, k * sxy + j * nx + x1 + 1);
  }

  private pass(src: Float32Array, dst: Float32Array, step: number) {
    const { nx, ny, box } = this;
    const sxy = nx * ny;
    for (let k = box[2]; k <= box[5]; k++)
      for (let j = box[1]; j <= box[4]; j++) {
        const row = k * sxy + j * nx;
        for (let i = box[0]; i <= box[3]; i++) {
          const q = row + i;
          dst[q] = step ? (src[q - step] + 2 * src[q] + src[q + step]) * 0.25 : src[q];
        }
      }
  }

  dispose() {
    this.geometry.dispose();
  }
}
