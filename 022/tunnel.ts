import { fbm3, noise1, rng } from "./noise";

export const CAVE = {
  DS_M: 0.25, // ring spacing along the loop
  AROUND: 160, // vertices around each ring
  CHUNK_RINGS: 32,
  RW_M: 3.2, // tunnel half width
  RH_M: 2.7, // tunnel half height
  CHAMBER_W_M: 6.6, // extra half width in a chamber
  CHAMBER_H_M: 3.4,
  CHAMBER_HALF_M: 26, // open length each side of a chamber's middle
  CHAMBER_LIFT_M: 1.1, // the roof rises more than the floor drops
};

// where the chambers sit along the loop, on its gentle stretches
const CHAMBERS_AT = [0.14, 0.56, 0.8];

// the camera roams this fraction of the half width / height, spikes keep clear of it
export const SAFE = { X: 0.3, Y: 0.24, MARGIN_M: 0.8, DIP_M: 1.7 };

export type Chamber = { s: number; x: number; y: number; z: number; water: number };

export type Chunk = {
  position: Float32Array;
  normal: Float32Array;
  index: Uint16Array | Uint32Array;
  ring: number; // first ring
};

export type Tunnel = {
  L: number;
  N: number;
  ds: number;
  C: Float32Array; // ring centres
  T: Float32Array; // tangents
  S: Float32Array; // sides
  U: Float32Array; // ups
  RW: Float32Array;
  RH: Float32Array;
  CH: Float32Array; // 0 in the tunnel, 1 in the middle of a chamber
  chambers: Chamber[];
  chunks: Chunk[];
};

const TAU = Math.PI * 2;

// LOOP
// a closed curve with a few low harmonics; checked for no cusps and wide clearance between laps
function curve(t: number, o: Float64Array) {
  o[0] =
    70 * Math.cos(t) +
    14 * Math.cos(2 * t + 0.7) +
    4 * Math.sin(3 * t + 0.3) +
    1.1 * Math.cos(5 * t + 1.1);
  o[1] = 4 * Math.sin(2 * t + 0.4) + 2 * Math.sin(3 * t + 1.1) + 0.6 * Math.sin(5 * t);
  o[2] =
    56 * Math.sin(t) +
    15 * Math.sin(2 * t + 1.3) +
    3 * Math.cos(4 * t + 0.4) +
    0.9 * Math.sin(6 * t + 2);
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function build(): Tunnel {
  // ARC LENGTH
  const SAMPLES = 16384;
  const P = new Float64Array((SAMPLES + 1) * 3);
  const acc = new Float64Array(SAMPLES + 1);
  const o = new Float64Array(3);
  for (let i = 0; i <= SAMPLES; i++) {
    curve((i / SAMPLES) * TAU, o);
    P.set(o, i * 3);
    if (i > 0) {
      const dx = P[i * 3] - P[i * 3 - 3];
      const dy = P[i * 3 + 1] - P[i * 3 - 2];
      const dz = P[i * 3 + 2] - P[i * 3 - 1];
      acc[i] = acc[i - 1] + Math.hypot(dx, dy, dz);
    }
  }
  const total = acc[SAMPLES];
  const N = Math.round(total / CAVE.DS_M);
  const ds = total / N;
  const L = total;

  const C = new Float32Array(N * 3);
  const T = new Float32Array(N * 3);
  const S = new Float32Array(N * 3);
  const U = new Float32Array(N * 3);
  const RW = new Float32Array(N);
  const RH = new Float32Array(N);
  const CH = new Float32Array(N);
  const FLAT = new Float32Array(N);

  const chamberS = CHAMBERS_AT.map((f) => f * L);
  const near = (s: number) => {
    let best = Infinity;
    for (const c of chamberS) {
      let d = Math.abs(s - c);
      d = Math.min(d, L - d);
      best = Math.min(best, d);
    }
    return best;
  };

  let k = 0;
  for (let i = 0; i < N; i++) {
    const s = i * ds;
    while (k < SAMPLES - 1 && acc[k + 1] < s) k++;
    const f = (s - acc[k]) / (acc[k + 1] - acc[k] || 1);
    for (let a = 0; a < 3; a++) C[i * 3 + a] = P[k * 3 + a] + (P[k * 3 + 3 + a] - P[k * 3 + a]) * f;
    const d = near(s);
    CH[i] = 1 - smooth(CAVE.CHAMBER_HALF_M * 0.35, CAVE.CHAMBER_HALF_M * 1.2, d);
    FLAT[i] = 1 - smooth(CAVE.CHAMBER_HALF_M * 1.2, CAVE.CHAMBER_HALF_M * 1.2 + 16, d);
  }

  // MEANDER AND LEVEL
  // a looping wiggle on top of the curve, calmed in chambers; their floor is held level for the pool
  const tangent = (i: number, out: Float64Array) => {
    const a = ((i + 1) % N) * 3;
    const b = ((i - 1 + N) % N) * 3;
    const x = C[a] - C[b];
    const y = C[a + 1] - C[b + 1];
    const z = C[a + 2] - C[b + 2];
    const l = Math.hypot(x, y, z) || 1;
    out[0] = x / l;
    out[1] = y / l;
    out[2] = z / l;
  };
  const t0 = new Float64Array(3);
  const levelY = chamberS.map((c) => C[Math.round(c / ds) * 3 + 1]);
  const W = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const s = i * ds;
    tangent(i, t0);
    const sx = -t0[2];
    const sz = t0[0];
    const sl = Math.hypot(sx, sz) || 1;
    const calm = 1 - FLAT[i];
    const m =
      calm * (1.6 * Math.sin((TAU * 17 * s) / L + 0.6) + 0.4 * Math.sin((TAU * 29 * s) / L + 2.1));
    const v = calm * 0.7 * Math.sin((TAU * 11 * s) / L + 1.3);
    W[i * 3] = (sx / sl) * m;
    W[i * 3 + 2] = (sz / sl) * m;
    let ly = levelY[0];
    let best = Infinity;
    chamberS.forEach((c, j) => {
      let d = Math.abs(s - c);
      d = Math.min(d, L - d);
      if (d < best) {
        best = d;
        ly = levelY[j];
      }
    });
    W[i * 3 + 1] = v + (ly - C[i * 3 + 1]) * FLAT[i];
  }
  for (let i = 0; i < C.length; i++) C[i] += W[i];

  // FRAMES AND RADII
  for (let i = 0; i < N; i++) {
    const s = i * ds;
    tangent(i, t0);
    T.set(t0, i * 3);
    let sx = -t0[2];
    let sz = t0[0];
    const sl = Math.hypot(sx, sz) || 1;
    sx /= sl;
    sz /= sl;
    S[i * 3] = sx;
    S[i * 3 + 2] = sz;
    // up = side x tangent
    U[i * 3] = -sz * t0[1];
    U[i * 3 + 1] = sz * t0[0] - sx * t0[2];
    U[i * 3 + 2] = sx * t0[1];
    const ch = CH[i];
    RW[i] = CAVE.RW_M + 0.7 * (noise1(s * 0.06, 1) - 0.5) * 2 + ch * CAVE.CHAMBER_W_M;
    RH[i] = CAVE.RH_M + 0.5 * (noise1(s * 0.07, 2) - 0.5) * 2 + ch * CAVE.CHAMBER_H_M;
  }

  const chambers: Chamber[] = chamberS.map((cs) => {
    const i = Math.round(cs / ds) % N;
    const floor = floorAt(0, RW[i], RH[i], CH[i]);
    return {
      s: cs,
      x: C[i * 3],
      y: C[i * 3 + 1],
      z: C[i * 3 + 2],
      water: C[i * 3 + 1] + floor + 0.75,
    };
  });

  const tunnel: Tunnel = { L, N, ds, C, T, S, U, RW, RH, CH, chambers, chunks: [] };
  tunnel.chunks = chunks(tunnel);
  return tunnel;
}

// FLOOR
// level in the tunnel; in a chamber a basin under the pool with a shelf of shore along each side
function floorAt(lx: number, rw: number, rh: number, ch: number) {
  const q = Math.abs(lx) / (0.72 * rw);
  const dip = q < 1 ? 0.5 - 1.5 * (1 - q * q) : 0.5 + 0.9 * (q - 1);
  return -rh * 0.62 + ch * dip;
}

// SURFACE
// one point of the wall at ring i and angle th, with its offset in the ring's own plane
const LOCAL = new Float64Array(2);
function surface(t: Tunnel, i: number, th: number, out: Float64Array, o: number) {
  const { C, S, U, RW, RH, CH } = t;
  const rw = RW[i];
  const rh = RH[i];
  const ch = CH[i];
  const c = Math.cos(th);
  const sn = Math.sin(th);
  let lx = c * rw;
  let ly = sn * rh + ch * CAVE.CHAMBER_LIFT_M;
  const i3 = i * 3;
  const wx = C[i3] + S[i3] * lx + U[i3] * ly;
  const wy = C[i3 + 1] + S[i3 + 1] * lx + U[i3 + 1] * ly;
  const wz = C[i3 + 2] + S[i3 + 2] * lx + U[i3 + 2] * ly;
  let disp =
    fbm3(wx * 0.19, wy * 0.19, wz * 0.19) * (1.9 + ch * 2.2) +
    fbm3(wx * 0.75 + 3, wy * 0.75, wz * 0.75) * 0.55 +
    fbm3(wx * 2.4, wy * 2.4 + 9, wz * 2.4) * 0.16;
  // STRATA
  // bedding planes in the walls: each layer swells out and breaks off in a ledge
  const band = wy * 1.25 + fbm3(wx * 0.21, wy * 0.08, wz * 0.21) * 2.4;
  const fr = band - Math.floor(band);
  disp -= Math.abs(c) * (0.18 + 0.2 * ch) * fr * fr * fr;
  lx -= c * disp;
  ly -= sn * disp;
  const fl = floorAt(lx, rw, rh, ch) + fbm3(wx * 1.3, 5, wz * 1.3) * 0.16;
  if (ly < fl) ly = fl;
  LOCAL[0] = lx;
  LOCAL[1] = ly;
  out[o] = C[i3] + S[i3] * lx + U[i3] * ly;
  out[o + 1] = C[i3 + 1] + S[i3 + 1] * lx + U[i3 + 1] * ly;
  out[o + 2] = C[i3 + 2] + S[i3 + 2] * lx + U[i3 + 2] * ly;
}

// NORMALS
// from neighbours on a grid; rows run along, columns wrap around
function gridNormals(
  pos: Float32Array,
  base: number,
  rows: number,
  cols: number,
  nrm: Float32Array,
  axis: (r: number, out: Float64Array) => void,
  inward: boolean,
) {
  const ax = new Float64Array(3);
  const at = (r: number, c: number) => (base + r * cols + ((c + cols) % cols)) * 3;
  for (let r = 0; r < rows; r++) {
    axis(r, ax);
    for (let c = 0; c < cols; c++) {
      const a = at(Math.min(rows - 1, r + 1), c);
      const b = at(Math.max(0, r - 1), c);
      const e = at(r, c + 1);
      const f = at(r, c - 1);
      const ux = pos[a] - pos[b];
      const uy = pos[a + 1] - pos[b + 1];
      const uz = pos[a + 2] - pos[b + 2];
      const vx = pos[e] - pos[f];
      const vy = pos[e + 1] - pos[f + 1];
      const vz = pos[e + 2] - pos[f + 2];
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const p = at(r, c);
      const dot = (ax[0] - pos[p]) * nx + (ax[1] - pos[p + 1]) * ny + (ax[2] - pos[p + 2]) * nz;
      if (dot < 0 === inward) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      const l = Math.hypot(nx, ny, nz) || 1;
      nrm[p] = nx / l;
      nrm[p + 1] = ny / l;
      nrm[p + 2] = nz / l;
    }
  }
}

// SPIKES
// stalactites, stalagmites, columns and straws, each a fluted cone on a grid
type Spike = {
  x: number;
  y: number;
  z: number;
  dir: number; // -1 hangs, 1 stands
  len: number;
  base: number;
  kind: 0 | 1 | 2 | 3; // stalactite, stalagmite, column, straw
  seed: number;
  rows: number;
  cols: number;
};

function spikes(t: Tunnel, i: number, out: Spike[]) {
  const r = rng(i * 7919 + 13);
  const s = i * t.ds;
  const ch = t.CH[i];
  const rw = t.RW[i];
  const rh = t.RH[i];
  const cluster = smooth(0.35, 0.75, noise1(s * 0.11, 3));
  const p = new Float64Array(3);
  const safeX = SAFE.X * rw + SAFE.MARGIN_M;
  const safeTop = SAFE.Y * rh + SAFE.MARGIN_M;
  const safeBottom = -SAFE.Y * rh - SAFE.DIP_M * ch - SAFE.MARGIN_M;
  const spawn = (kind: Spike["kind"], th: number, want: number, base: number) => {
    surface(t, i, th, p, 0);
    const lx = LOCAL[0];
    const ly = LOCAL[1];
    const fl = floorAt(lx, rw, rh, ch);
    const roof = rh * 0.9 + ch * CAVE.CHAMBER_LIFT_M;
    const clear = Math.abs(lx) < safeX;
    if (kind === 2 && Math.abs(lx) < safeX + 0.8) return;
    let len = want;
    if (kind === 0 || kind === 3) len = Math.min(len, ly - fl - 0.5, clear ? ly - safeTop : 99);
    else if (kind === 1) len = Math.min(len, roof - ly - 0.5, clear ? safeBottom - ly : 99);
    else len = ly - fl + 0.35;
    if (len < (kind === 3 ? 0.08 : 0.22)) return;
    out.push({
      x: p[0],
      y: p[1],
      z: p[2],
      dir: kind === 1 ? 1 : -1,
      len,
      base,
      kind,
      seed: r(),
      rows: kind === 3 ? 4 : len > 2 ? 18 : 11,
      cols: kind === 3 ? 6 : 14,
    });
  };

  // STALACTITES
  if (r() < (0.2 + ch * 0.55) * (0.25 + cluster)) {
    const th = Math.PI / 2 + (r() - 0.5) * (1.7 + ch * 0.5);
    const want = (0.35 + Math.pow(r(), 1.8) * (1.5 + ch * 4.2)) * (0.6 + cluster * 0.6);
    spawn(0, th, want, 0.07 + want * (0.11 + r() * 0.05));
  }
  // COLUMNS
  // only off to the sides of a chamber, never across the flight path
  if (ch > 0.6 && r() < 0.035) {
    const th = Math.PI / 2 + (r() < 0.5 ? -1 : 1) * (0.75 + r() * 0.35);
    spawn(2, th, 0, 0.35 + r() * 0.45);
  }
  // STALAGMITES
  if (r() < (0.09 + ch * 0.35) * (0.3 + cluster)) {
    const th = -Math.PI / 2 + (r() - 0.5) * (1.8 + ch * 0.6);
    const want = (0.25 + Math.pow(r(), 2) * (0.8 + ch * 2.2)) * (0.6 + cluster * 0.5);
    spawn(1, th, want, 0.14 + want * (0.2 + r() * 0.08));
  }
  // STRAWS
  // thin soda straws in clusters, the fine grain that makes the roof read
  const straws = Math.floor(r() * r() * 5 * cluster * (1 + ch));
  for (let k = 0; k < straws; k++) {
    const th = Math.PI / 2 + (r() - 0.5) * 2.2;
    spawn(3, th, 0.12 + r() * 0.45, 0.018 + r() * 0.016);
  }
}

function cone(sp: Spike, pos: Float32Array, nrm: Float32Array, base: number) {
  const { rows, cols, kind } = sp;
  const embed = 0.35;
  const span = sp.len + embed;
  const ph = sp.seed * TAU;
  const leanX = Math.cos(ph * 3.1) * 0.06;
  const leanZ = Math.sin(ph * 2.3) * 0.06;
  for (let r = 0; r < rows; r++) {
    const h = r / (rows - 1);
    let prof: number;
    if (kind === 0) prof = Math.pow(1 - h, 1.35) + 0.55 * Math.pow(1 - h, 9);
    else if (kind === 1) prof = Math.pow(Math.max(0, 1 - Math.pow(h, 2.4)), 0.6) * (1 - 0.25 * h);
    else if (kind === 2) prof = 0.38 + 0.62 * Math.pow(Math.abs(2 * h - 1), 1.7);
    else prof = 1 - h * 0.55;
    // drip rings down the length
    prof *= 1 + 0.09 * Math.sin(h * span * 8 + ph) * (kind === 3 ? 0 : 1);
    if (kind !== 2 && r === rows - 1) prof = 0.02;
    const rad = sp.base * prof;
    const y = sp.y + sp.dir * (h * span - embed);
    const cx = sp.x + leanX * h * h * span;
    const cz = sp.z + leanZ * h * h * span;
    for (let c = 0; c < cols; c++) {
      const a = (c / cols) * TAU;
      const flute = 1 + 0.13 * Math.cos(4 * a + ph) + 0.05 * Math.cos(9 * a + ph * 2);
      const o = (base + r * cols + c) * 3;
      pos[o] = cx + Math.cos(a) * rad * flute;
      pos[o + 1] = y;
      pos[o + 2] = cz + Math.sin(a) * rad * flute;
    }
  }
  gridNormals(
    pos,
    base,
    rows,
    cols,
    nrm,
    (r, out) => {
      const h = r / (rows - 1);
      out[0] = sp.x + leanX * h * h * span;
      out[1] = sp.y + sp.dir * (h * span - embed);
      out[2] = sp.z + leanZ * h * h * span;
    },
    false,
  );
}

function quads(
  idx: Uint16Array | Uint32Array,
  o: number,
  base: number,
  rows: number,
  cols: number,
) {
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols; c++) {
      const a = base + r * cols + c;
      const b = base + r * cols + ((c + 1) % cols);
      const d = a + cols;
      const e = b + cols;
      idx[o++] = a;
      idx[o++] = d;
      idx[o++] = b;
      idx[o++] = b;
      idx[o++] = d;
      idx[o++] = e;
    }
  }
  return o;
}

// CHUNKS
// the wall in runs of rings plus the spikes rooted there, so the renderer can skip what is far
function chunks(t: Tunnel): Chunk[] {
  const { N, C } = t;
  const A = CAVE.AROUND;
  const K = CAVE.CHUNK_RINGS;
  const list: Chunk[] = [];
  const count = Math.ceil(N / K);
  const sp: Spike[] = [];
  for (let n = 0; n < count; n++) {
    const first = n * K;
    const rows = Math.min(K, N - first) + 1;
    sp.length = 0;
    for (let i = first; i < first + rows - 1; i++) spikes(t, i, sp);
    let verts = rows * A;
    let tris = (rows - 1) * A * 2;
    for (const s of sp) {
      verts += s.rows * s.cols;
      tris += (s.rows - 1) * s.cols * 2;
    }
    const position = new Float32Array(verts * 3);
    const normal = new Float32Array(verts * 3);
    const index = verts > 65535 ? new Uint32Array(tris * 3) : new Uint16Array(tris * 3);
    const p = new Float64Array(3);
    for (let r = 0; r < rows; r++) {
      const i = (first + r) % N;
      for (let a = 0; a < A; a++) {
        surface(t, i, (a / A) * TAU, p, 0);
        position.set(p, (r * A + a) * 3);
      }
    }
    gridNormals(
      position,
      0,
      rows,
      A,
      normal,
      (r, out) => {
        const i = ((first + r) % N) * 3;
        out[0] = C[i];
        out[1] = C[i + 1];
        out[2] = C[i + 2];
      },
      true,
    );
    let o = quads(index, 0, 0, rows, A);
    let base = rows * A;
    for (const s of sp) {
      cone(s, position, normal, base);
      o = quads(index, o, base, s.rows, s.cols);
      base += s.rows * s.cols;
    }
    list.push({ position, normal, index, ring: first });
  }
  return list;
}

// FRAME
// centre, axes and radii at any distance along the loop, interpolated between rings
export type Frame = {
  c: Float64Array;
  t: Float64Array;
  s: Float64Array;
  u: Float64Array;
  rw: number;
  rh: number;
  ch: number;
};

export const frame = (): Frame => ({
  c: new Float64Array(3),
  t: new Float64Array(3),
  s: new Float64Array(3),
  u: new Float64Array(3),
  rw: 0,
  rh: 0,
  ch: 0,
});

export function sample(t: Tunnel, dist: number, f: Frame) {
  const x = (((dist / t.ds) % t.N) + t.N) % t.N;
  const i = Math.floor(x);
  const j = (i + 1) % t.N;
  const k = x - i;
  for (let a = 0; a < 3; a++) {
    f.c[a] = t.C[i * 3 + a] + (t.C[j * 3 + a] - t.C[i * 3 + a]) * k;
    f.t[a] = t.T[i * 3 + a] + (t.T[j * 3 + a] - t.T[i * 3 + a]) * k;
    f.s[a] = t.S[i * 3 + a] + (t.S[j * 3 + a] - t.S[i * 3 + a]) * k;
    f.u[a] = t.U[i * 3 + a] + (t.U[j * 3 + a] - t.U[i * 3 + a]) * k;
  }
  f.rw = t.RW[i] + (t.RW[j] - t.RW[i]) * k;
  f.rh = t.RH[i] + (t.RH[j] - t.RH[i]) * k;
  f.ch = t.CH[i] + (t.CH[j] - t.CH[i]) * k;
}
