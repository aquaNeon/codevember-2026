import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Mesh,
  MeshPhysicalMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  Vector2,
} from "three";
import type { Blobs } from "./blobs";
import { benchY } from "./bench";

// TEA TOWEL
// small-step xpbd particle grid

const SIDE = 36;
const SIZE = 2.9;
const SUBSTEPS = 6;
const GRAVITY = -9;
const DAMP_PER_S = 3.2; // change air drag here
const STRETCH_COMPLIANCE = 1e-6;
const BEND_COMPLIANCE = 2e-4; // change lower for stiffer linen
const SKIN_MARGIN = 0.4;
const FLOOR_Y = 0.012;
const DROP_Y = 1.9;
const SETTLE_SPEED = 0.35;
const SETTLE_S = 0.4;
const CONTACT_DAMP = 0.55;
const MAX_SPEED = 8;
const LAND_S = 1.2;
const DRAG_RAMP = 10;
const DRAG_MAX = 25;
const DOUGH_FRICTION = 0.6; // change towel grip on the dough here
const LIFT_PULL = 0.25;
const LIFT_SPEED = 6;
const GONE_Y = 6;
const TEX_PX = 1024;
const SUB = 3; // change render verts per sim cell edge here
const RSIDE = (SIDE - 1) * SUB + 1;
const WEAVE_PX = 64;
const WEAVE_THREADS = 8;
const WEAVE_REPEAT = 34;
const LINEN = "#efe8dc";
const STRIPE = "#44608f";

export class Cloth {
  readonly mesh: Mesh;
  private geo = new BufferGeometry();
  private mat: MeshPhysicalMaterial;
  private tex: CanvasTexture | null = null;
  private weave: CanvasTexture | null = null;
  private cw = new Float32Array(SUB * 4);
  private rows = new Float32Array(SIDE * RSIDE * 3);
  private n = SIDE * SIDE;
  private x: Float32Array;
  private p: Float32Array;
  private v: Float32Array;
  private pre: Float32Array;
  private touch: Uint8Array;
  private calm = 0;
  private age = 0;
  private asleep = false;
  private pos: Float32Array;
  private nor: Float32Array;
  private ca: Uint16Array;
  private cb: Uint16Array;
  private rest: Float32Array;
  private comp: Float32Array;
  private liftT = 0;
  private lx = 0;
  private ly = 0;
  private lz = 0;

  covering = false;
  lifting = false;
  speed = 0;

  constructor() {
    const n = this.n;
    this.x = new Float32Array(n * 3);
    this.p = new Float32Array(n * 3);
    this.v = new Float32Array(n * 3);
    this.pre = new Float32Array(n * 3);
    this.touch = new Uint8Array(n);
    this.pos = new Float32Array(RSIDE * RSIDE * 3);
    this.nor = new Float32Array(RSIDE * RSIDE * 3);
    for (let s = 0; s < SUB; s++) {
      const t = s / SUB,
        t2 = t * t,
        t3 = t2 * t;
      this.cw[s * 4] = 0.5 * (-t3 + 2 * t2 - t);
      this.cw[s * 4 + 1] = 0.5 * (3 * t3 - 5 * t2 + 2);
      this.cw[s * 4 + 2] = 0.5 * (-3 * t3 + 4 * t2 + t);
      this.cw[s * 4 + 3] = 0.5 * (t3 - t2);
    }

    // LINKS
    // structural, shear and skip-one bend constraints
    const a: number[] = [];
    const b: number[] = [];
    const c: number[] = [];
    const link = (i0: number, j0: number, i1: number, j1: number, comp: number) => {
      if (i1 < 0 || j1 < 0 || i1 >= SIDE || j1 >= SIDE) return;
      a.push(j0 * SIDE + i0);
      b.push(j1 * SIDE + i1);
      c.push(comp);
    };
    for (let j = 0; j < SIDE; j++) {
      for (let i = 0; i < SIDE; i++) {
        link(i, j, i + 1, j, STRETCH_COMPLIANCE);
        link(i, j, i, j + 1, STRETCH_COMPLIANCE);
        link(i, j, i + 1, j + 1, STRETCH_COMPLIANCE);
        link(i, j, i - 1, j + 1, STRETCH_COMPLIANCE);
        link(i, j, i + 2, j, BEND_COMPLIANCE);
        link(i, j, i, j + 2, BEND_COMPLIANCE);
      }
    }
    this.ca = new Uint16Array(a);
    this.cb = new Uint16Array(b);
    this.comp = new Float32Array(c);
    const cell = SIZE / (SIDE - 1);
    this.rest = new Float32Array(a.length);
    for (let k = 0; k < a.length; k++) {
      const di = (a[k] % SIDE) - (b[k] % SIDE);
      const dj = Math.floor(a[k] / SIDE) - Math.floor(b[k] / SIDE);
      this.rest[k] = Math.hypot(di, dj) * cell;
    }

    // MESH
    const R = RSIDE;
    const uv = new Float32Array(R * R * 2);
    for (let j = 0; j < R; j++) {
      for (let i = 0; i < R; i++) {
        uv[(j * R + i) * 2] = i / (R - 1);
        uv[(j * R + i) * 2 + 1] = j / (R - 1);
      }
    }
    const idx = new Uint16Array((R - 1) * (R - 1) * 6);
    let t = 0;
    for (let j = 0; j < R - 1; j++) {
      for (let i = 0; i < R - 1; i++) {
        const q = j * R + i;
        idx[t++] = q;
        idx[t++] = q + R;
        idx[t++] = q + 1;
        idx[t++] = q + 1;
        idx[t++] = q + R;
        idx[t++] = q + R + 1;
      }
    }
    this.geo.setIndex(new BufferAttribute(idx, 1));
    this.geo.setAttribute("position", new BufferAttribute(this.pos, 3));
    this.geo.setAttribute("normal", new BufferAttribute(this.nor, 3));
    this.geo.setAttribute("uv", new BufferAttribute(uv, 2));

    this.mat = new MeshPhysicalMaterial({
      color: LINEN,
      roughness: 0.88,
      sheen: 1,
      sheenColor: new Color("#8a8072"),
      sheenRoughness: 0.55,
      side: DoubleSide,
    });
    this.mesh = new Mesh(this.geo, this.mat);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  prep() {
    if (this.tex) return;
    this.tex = new CanvasTexture(towel());
    this.tex.colorSpace = SRGBColorSpace;
    this.tex.anisotropy = 8;
    this.weave = new CanvasTexture(weave());
    this.weave.wrapS = this.weave.wrapT = RepeatWrapping;
    this.weave.repeat.set(WEAVE_REPEAT, WEAVE_REPEAT);
    this.weave.anisotropy = 8;
    this.mat.color.set(0xffffff);
    this.mat.map = this.tex;
    this.mat.normalMap = this.weave;
    this.mat.normalScale = new Vector2(0.4, 0.4);
    this.mat.needsUpdate = true;
  }

  get points() {
    return this.x;
  }

  get count() {
    return this.mesh.visible ? this.n : 0;
  }

  drop(cx: number, cz: number) {
    const cell = SIZE / (SIDE - 1);
    const rot = 0.3;
    const cs = Math.cos(rot),
      sn = Math.sin(rot);
    const tilt = 0.04;
    for (let j = 0; j < SIDE; j++) {
      for (let i = 0; i < SIDE; i++) {
        const o = (j * SIDE + i) * 3;
        const u = i * cell - SIZE / 2;
        const w = j * cell - SIZE / 2;
        this.x[o] = cx + u * cs - w * sn;
        this.x[o + 1] = DROP_Y + u * tilt;
        this.x[o + 2] = cz + u * sn + w * cs;
      }
    }
    this.p.set(this.x);
    this.v.fill(0);
    this.covering = true;
    this.asleep = false;
    this.calm = 0;
    this.age = 0;
    this.lifting = false;
    this.prep();
    this.mesh.visible = true;
    this.sync();
  }

  lift() {
    if (!this.covering || this.lifting) return;
    this.lifting = true;
    this.asleep = false;
    this.liftT = 0;
    const o = (SIDE - 1) * SIDE * 3;
    this.lx = this.x[o];
    this.ly = this.x[o + 1];
    this.lz = this.x[o + 2];
  }

  hide() {
    this.covering = false;
    this.lifting = false;
    this.mesh.visible = false;
  }

  step(dt: number, skin: Blobs, doughMoving: boolean) {
    if (!this.mesh.visible) return false;
    if (this.asleep) {
      if (!doughMoving && !skin.touches(this.x, this.n, SKIN_MARGIN * 0.5)) return false;
      this.asleep = false;
      this.calm = 0;
    }
    const h = dt / SUBSTEPS;
    const { x, p, v, n, ca, cb, rest, comp, touch } = this;
    this.age += dt;
    const drag = this.lifting ? 0 : Math.min(DRAG_MAX, Math.max(0, this.age - LAND_S) * DRAG_RAMP);
    const damp = Math.exp(-(DAMP_PER_S + drag) * h);
    const ih2 = 1 / (h * h);

    if (this.lifting) {
      this.liftT += dt;
      this.ly += LIFT_SPEED * dt;
      this.lz -= LIFT_SPEED * 0.6 * dt;
    }

    let maxV2 = 0;
    for (let s = 0; s < SUBSTEPS; s++) {
      for (let i = 0; i < n * 3; i += 3) {
        v[i + 1] += GRAVITY * h;
        p[i] = x[i] + v[i] * h;
        p[i + 1] = x[i + 1] + v[i + 1] * h;
        p[i + 2] = x[i + 2] + v[i + 2] * h;
      }
      if (this.lifting) {
        for (let i = 0; i < SIDE; i++) {
          const o = ((SIDE - 1) * SIDE + i) * 3;
          const off = (i - (SIDE - 1) / 2) * (SIZE / (SIDE - 1)) * 0.6;
          p[o] += (this.lx + off - p[o]) * LIFT_PULL;
          p[o + 1] += (this.ly - p[o + 1]) * LIFT_PULL;
          p[o + 2] += (this.lz - p[o + 2]) * LIFT_PULL;
        }
      }
      for (let k = 0; k < ca.length; k++) {
        const i = ca[k] * 3,
          j = cb[k] * 3;
        const dx = p[i] - p[j],
          dy = p[i + 1] - p[j + 1],
          dz = p[i + 2] - p[j + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (len < 1e-6) continue;
        const corr = (len - rest[k]) / (len * (2 + comp[k] * ih2));
        p[i] -= dx * corr;
        p[i + 1] -= dy * corr;
        p[i + 2] -= dz * corr;
        p[j] += dx * corr;
        p[j + 1] += dy * corr;
        p[j + 2] += dz * corr;
      }
      this.pre.set(p);
      skin.push(p, n, SKIN_MARGIN);
      const pre = this.pre;
      touch.fill(0);
      for (let i = 0; i < n * 3; i += 3) {
        if (p[i] === pre[i] && p[i + 1] === pre[i + 1] && p[i + 2] === pre[i + 2]) continue;
        touch[i / 3] = 1;
        p[i] -= (p[i] - x[i]) * DOUGH_FRICTION;
        p[i + 2] -= (p[i + 2] - x[i + 2]) * DOUGH_FRICTION;
      }
      for (let i = 0; i < n * 3; i += 3) {
        const fy = benchY(p[i], p[i + 2]) + FLOOR_Y;
        if (p[i + 1] < fy) {
          p[i + 1] = fy;
          touch[i / 3] = 1;
          p[i] -= (p[i] - x[i]) * 0.8;
          p[i + 2] -= (p[i + 2] - x[i + 2]) * 0.8;
        }
      }
      maxV2 = 0;
      for (let i = 0; i < n * 3; i += 3) {
        const dk = touch[i / 3] ? damp * CONTACT_DAMP : damp;
        const vx = ((p[i] - x[i]) / h) * dk;
        const vy = ((p[i + 1] - x[i + 1]) / h) * dk;
        const vz = ((p[i + 2] - x[i + 2]) / h) * dk;
        const s2 = vx * vx + vy * vy + vz * vz;
        const cap = s2 > MAX_SPEED * MAX_SPEED ? MAX_SPEED / Math.sqrt(s2) : 1;
        v[i] = vx * cap;
        v[i + 1] = vy * cap;
        v[i + 2] = vz * cap;
        x[i] = p[i];
        x[i + 1] = p[i + 1];
        x[i + 2] = p[i + 2];
        if (s2 * cap * cap > maxV2) maxV2 = s2 * cap * cap;
      }
    }
    this.speed = Math.sqrt(maxV2);
    this.sync();

    if (this.lifting && this.liftT > 0.4 && x[(SIDE >> 1) * SIDE * 3 + 1] > GONE_Y) this.hide();
    if (this.lifting) return true;
    this.calm = this.speed < SETTLE_SPEED ? this.calm + dt : 0;
    if (this.calm > SETTLE_S && !doughMoving) {
      this.asleep = true;
      v.fill(0);
      return false;
    }
    return true;
  }

  // GEOMETRY
  // sim grid resampled with catmull-rom along rows, then columns; normals from the fine grid
  private sync() {
    const { x, pos, nor, rows, cw } = this;
    const R = RSIDE;
    for (let j = 0; j < SIDE; j++) {
      for (let i = 0; i < R; i++) {
        const c = Math.min(SIDE - 2, Math.floor(i / SUB));
        const s = i - c * SUB;
        const o = (j * R + i) * 3;
        if (s === SUB) {
          const q = (j * SIDE + SIDE - 1) * 3;
          rows[o] = x[q];
          rows[o + 1] = x[q + 1];
          rows[o + 2] = x[q + 2];
          continue;
        }
        const a = (j * SIDE + Math.max(0, c - 1)) * 3,
          b = (j * SIDE + c) * 3,
          d = (j * SIDE + c + 1) * 3,
          e = (j * SIDE + Math.min(SIDE - 1, c + 2)) * 3;
        const w0 = cw[s * 4],
          w1 = cw[s * 4 + 1],
          w2 = cw[s * 4 + 2],
          w3 = cw[s * 4 + 3];
        rows[o] = x[a] * w0 + x[b] * w1 + x[d] * w2 + x[e] * w3;
        rows[o + 1] = x[a + 1] * w0 + x[b + 1] * w1 + x[d + 1] * w2 + x[e + 1] * w3;
        rows[o + 2] = x[a + 2] * w0 + x[b + 2] * w1 + x[d + 2] * w2 + x[e + 2] * w3;
      }
    }
    for (let j = 0; j < R; j++) {
      const c = Math.min(SIDE - 2, Math.floor(j / SUB));
      const s = j - c * SUB;
      for (let i = 0; i < R; i++) {
        const o = (j * R + i) * 3;
        if (s === SUB) {
          const q = ((SIDE - 1) * R + i) * 3;
          pos[o] = rows[q];
          pos[o + 1] = rows[q + 1];
          pos[o + 2] = rows[q + 2];
          continue;
        }
        const a = (Math.max(0, c - 1) * R + i) * 3,
          b = (c * R + i) * 3,
          d = ((c + 1) * R + i) * 3,
          e = (Math.min(SIDE - 1, c + 2) * R + i) * 3;
        const w0 = cw[s * 4],
          w1 = cw[s * 4 + 1],
          w2 = cw[s * 4 + 2],
          w3 = cw[s * 4 + 3];
        pos[o] = rows[a] * w0 + rows[b] * w1 + rows[d] * w2 + rows[e] * w3;
        pos[o + 1] = rows[a + 1] * w0 + rows[b + 1] * w1 + rows[d + 1] * w2 + rows[e + 1] * w3;
        pos[o + 2] = rows[a + 2] * w0 + rows[b + 2] * w1 + rows[d + 2] * w2 + rows[e + 2] * w3;
      }
    }
    for (let j = 0; j < R; j++) {
      for (let i = 0; i < R; i++) {
        const o = (j * R + i) * 3;
        const l = (j * R + Math.max(i - 1, 0)) * 3,
          r = (j * R + Math.min(i + 1, R - 1)) * 3;
        const d = (Math.max(j - 1, 0) * R + i) * 3,
          u = (Math.min(j + 1, R - 1) * R + i) * 3;
        const ax = pos[r] - pos[l],
          ay = pos[r + 1] - pos[l + 1],
          az = pos[r + 2] - pos[l + 2];
        const bx = pos[u] - pos[d],
          by = pos[u + 1] - pos[d + 1],
          bz = pos[u + 2] - pos[d + 2];
        let nx = by * az - bz * ay,
          ny = bz * ax - bx * az,
          nz = bx * ay - by * ax;
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= len;
        ny /= len;
        nz /= len;
        nor[o] = nx;
        nor[o + 1] = ny;
        nor[o + 2] = nz;
      }
    }
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
  }

  dispose() {
    this.geo.dispose();
    this.mat.dispose();
    this.tex?.dispose();
    this.weave?.dispose();
  }
}

// TEXTURES
// canvas-drawn linen: slubs, woven stripes, hem with stitch line
function towel() {
  const c = document.createElement("canvas");
  c.width = c.height = TEX_PX;
  const g = c.getContext("2d");
  if (!g) return c;
  const P = TEX_PX;
  g.fillStyle = LINEN;
  g.fillRect(0, 0, P, P);
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 420; k++) {
    const along = rand() < 0.5;
    const at = Math.floor(rand() * P);
    const from = rand() * P;
    const len = 20 + rand() * 160;
    g.fillStyle = rand() < 0.5 ? "rgba(120,100,72,0.07)" : "rgba(255,252,244,0.25)";
    if (along) g.fillRect(from, at, len, 1.5);
    else g.fillRect(at, from, 1.5, len);
  }
  const stripe = (at: number, w: number) => {
    for (const y of [at, 1 - at - w]) {
      const y0 = y * P,
        h = w * P;
      g.fillStyle = STRIPE;
      g.fillRect(0, y0, P, h);
      g.fillStyle = "rgba(239,232,220,0.55)";
      for (let x = 0; x < P; x += 4) {
        g.fillRect(x, y0 - 0.5, 2, 1.5);
        g.fillRect(x + 2, y0 + h - 1, 2, 1.5);
      }
      g.fillStyle = "rgba(20,30,60,0.12)";
      for (let x = 0; x < P; x += 3) g.fillRect(x, y0, 1, h);
    }
  };
  stripe(0.075, 0.034);
  stripe(0.128, 0.011);
  const hem = 0.022 * P;
  g.fillStyle = "rgba(110,92,64,0.07)";
  g.fillRect(0, 0, P, hem);
  g.fillRect(0, P - hem, P, hem);
  g.fillRect(0, hem, hem, P - hem * 2);
  g.fillRect(P - hem, hem, hem, P - hem * 2);
  g.fillStyle = "rgba(96,80,56,0.3)";
  for (let k = 6; k < P - 6; k += 9) {
    g.fillRect(k, hem - 2, 5, 1);
    g.fillRect(k, P - hem + 1, 5, 1);
    g.fillRect(hem - 2, k, 1, 5);
    g.fillRect(P - hem + 1, k, 1, 5);
  }
  for (let e = 0; e < 4; e++) {
    g.fillStyle = `rgba(90,72,48,${0.16 - e * 0.04})`;
    g.fillRect(0, e, P, 1);
    g.fillRect(0, P - 1 - e, P, 1);
    g.fillRect(e, 0, 1, P);
    g.fillRect(P - 1 - e, 0, 1, P);
  }
  return c;
}

// WEAVE
// plain weave height as a tangent-space normal map
function weave() {
  const c = document.createElement("canvas");
  c.width = c.height = WEAVE_PX;
  const g = c.getContext("2d");
  if (!g) return c;
  const P = WEAVE_PX;
  const cell = P / WEAVE_THREADS;
  const h = new Float32Array(P * P);
  for (let y = 0; y < P; y++) {
    for (let x = 0; x < P; x++) {
      const ti = Math.floor(x / cell),
        tj = Math.floor(y / cell);
      const u = (x % cell) / cell - 0.5,
        v = (y % cell) / cell - 0.5;
      const warp = Math.cos(u * Math.PI) * (0.8 + 0.2 * Math.cos(v * Math.PI * 2));
      const weft = Math.cos(v * Math.PI) * (0.8 + 0.2 * Math.cos(u * Math.PI * 2));
      h[y * P + x] = (ti + tj) % 2 ? weft : warp;
    }
  }
  const img = g.createImageData(P, P);
  const k = 2.2;
  for (let y = 0; y < P; y++) {
    for (let x = 0; x < P; x++) {
      const dx = h[y * P + ((x + 1) % P)] - h[y * P + ((x + P - 1) % P)];
      const dy = h[((y + 1) % P) * P + x] - h[((y + P - 1) % P) * P + x];
      const nx = -dx * k,
        ny = dy * k;
      const l = Math.hypot(nx, ny, 1);
      const o = (y * P + x) * 4;
      img.data[o] = (nx / l) * 127.5 + 127.5;
      img.data[o + 1] = (ny / l) * 127.5 + 127.5;
      img.data[o + 2] = (1 / l) * 127.5 + 127.5;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}
