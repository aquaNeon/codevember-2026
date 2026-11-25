// CLOTH
// a long sheer veil as a particle grid solved by position based dynamics at a fixed step:
// stretch, shear and a soft bend, air drag across the cloth, a divergence free wind that
// never repeats, a soft pull back to the middle of the frame, and particles that keep a
// hair's breadth apart so layers lie over each other instead of through. no allocation
// after the constructor

export const NX = 30; // across, 1.3 m
export const NY = 200; // along, 7 m
export const N = NX * NY;
export const STEP_S = 1 / 60;
export const WIDTH_M = 1.3;
export const LENGTH_M = 7;

const ITERS = 4;
const GRAVITY = -0.08; // m/s², nearly weightless
const DAMP_TAU_S = 2.4;
const KN = 4.2; // air across the cloth, 1/s
const KT = 0.25; // and along it
const MAX_V = 2.2;
const WIND = 0.5; // m/s
const LIFT = 0.04; // a slow updraft that keeps it aloft
const LEASH_K = 0.8; // 1/s², the centre of mass drawn gently home
const LEASH_C = 0.8;
const ORIENT_K = 2.2; // and each end eased toward its point along the lean
const END_ROWS = 24;
export const SPAN_MAX_M = 6; // the furthest the two ends are drawn apart
const TOUCH = 2.2; // how much of the pointer's speed the air takes on
const R_SELF = 0.019; // layers keep this far apart
const CELL = R_SELF * 2; // with this, two cells per axis always hold every neighbour
const HASH = 16384;
const BREATH_R = 0.5;
const SLOW = 0.72; // the clock of the air and the path, slowed for grace
const KEEP = 0.5; // a safety: nothing crushes closer than this share of its flat length

export class Cloth {
  readonly x = new Float32Array(N * 3);
  readonly n = new Float32Array(N * 3);
  readonly uv = new Float32Array(N * 2);
  private p = new Float32Array(N * 3);
  private v = new Float32Array(N * 3);
  private w = new Float32Array(N * 3); // the air at each particle
  private f = new Float32Array(N * 3); // air force, gathered from the faces
  private area = new Float32Array(N); // each particle's share of the flat cloth
  private ca: Uint16Array;
  private cb: Uint16Array;
  private cr: Float32Array;
  private ck: Float32Array;
  private ka: Uint16Array;
  private kb: Uint16Array;
  private kr: Float32Array;
  private cellStart = new Int32Array(HASH + 1);
  private cellItems = new Int32Array(N);
  private cellOf = new Int32Array(N);
  private cursor = new Int32Array(HASH);
  t = 0;
  wind = WIND;
  tilt = 0; // rad, the path's lean, set from the frame's shape
  span = SPAN_MAX_M; // m end to end along the lean, set wider than the frame
  private tiltNow = 0;
  speed = 0; // mean particle speed, m/s
  // BREATH: a ray from the eye through the pointer, and the way the pointer moved
  private bo = new Float32Array(3);
  private bd = new Float32Array(3);
  private bm = new Float32Array(3);
  bS = 0;

  constructor() {
    // REST
    // laid out streaming from the hand that holds it, with a wave to start the folds
    const dx = WIDTH_M / (NX - 1);
    const dy = LENGTH_M / (NY - 1);
    for (let j = 0; j < NY; j++)
      for (let i = 0; i < NX; i++) {
        const k = j * NX + i;
        const v = j / (NY - 1);
        const u = i / (NX - 1);
        this.x[k * 3] = (v - 0.5) * LENGTH_M * 0.92;
        this.x[k * 3 + 1] = 0.35 + (u - 0.5) * WIDTH_M * 0.9 + Math.sin(v * LENGTH_M * 1.56) * 0.15;
        this.x[k * 3 + 2] = Math.sin(v * LENGTH_M * 1.1 + u) * 0.25;
        this.uv[k * 2] = u * WIDTH_M;
        this.uv[k * 2 + 1] = v * LENGTH_M;
      }
    this.p.set(this.x);
    for (let j = 0; j < NY; j++)
      for (let i = 0; i < NX; i++) {
        const ex = i === 0 || i === NX - 1 ? 0.5 : 1;
        const ey = j === 0 || j === NY - 1 ? 0.5 : 1;
        this.area[j * NX + i] = dx * dy * ex * ey;
      }

    // CONSTRAINTS
    // rest lengths from the flat sheet, not the laid out pose
    const pairs: number[] = [];
    const add = (a: number, b: number, k: number, r: number) => pairs.push(a, b, k, r);
    const diag = Math.hypot(dx, dy);
    for (let j = 0; j < NY; j++)
      for (let i = 0; i < NX; i++) {
        const k = j * NX + i;
        if (i < NX - 1) add(k, k + 1, 1, dx);
        if (j < NY - 1) add(k, k + NX, 1, dy);
        if (i < NX - 1 && j < NY - 1) {
          add(k, k + NX + 1, 0.5, diag);
          add(k + 1, k + NX, 0.5, diag);
        }
        if (i < NX - 2) add(k, k + 2, 0.2, dx * 2);
        if (j < NY - 2) add(k, k + NX * 2, 0.2, dy * 2);
      }
    // KEEP: one-sided, only pushing apart what has been crushed together
    const keep: number[] = [];
    for (let j = 0; j < NY; j++)
      for (let i = 0; i < NX; i++) {
        const k = j * NX + i;
        if (j < NY - 5) keep.push(k, k + NX * 5, dy * 5 * KEEP);
        if (i < NX - 5) keep.push(k, k + 5, dx * 5 * KEEP);
      }
    this.ka = new Uint16Array(keep.length / 3);
    this.kb = new Uint16Array(keep.length / 3);
    this.kr = new Float32Array(keep.length / 3);
    for (let c = 0; c < keep.length / 3; c++) {
      this.ka[c] = keep[c * 3];
      this.kb[c] = keep[c * 3 + 1];
      this.kr[c] = keep[c * 3 + 2];
    }
    const m = pairs.length / 4;
    this.ca = new Uint16Array(m);
    this.cb = new Uint16Array(m);
    this.cr = new Float32Array(m);
    this.ck = new Float32Array(m);
    for (let c = 0; c < m; c++) {
      this.ca[c] = pairs[c * 4];
      this.cb[c] = pairs[c * 4 + 1];
      this.ck[c] = pairs[c * 4 + 2];
      this.cr[c] = pairs[c * 4 + 3];
    }
    // settle the laid out pose into a sheet before anything else
    for (let s = 0; s < 40; s++) this.solve(1);
    this.p.set(this.x);
    this.normals();
  }

  // a few seconds in the new lean, for a frame that opens already composed
  settle(dt: number, steps: number) {
    this.tiltNow = this.tilt;
    for (let s = 0; s < steps; s++) {
      this.normals();
      this.step(dt);
    }
    this.normals();
  }

  // INPUT
  breath(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    mx: number,
    my: number,
    mz: number,
  ) {
    this.bo[0] = ox;
    this.bo[1] = oy;
    this.bo[2] = oz;
    this.bd[0] = dx;
    this.bd[1] = dy;
    this.bd[2] = dz;
    // eased toward the latest motion, so a flick is a breath and not a blow
    this.bm[0] += (mx - this.bm[0]) * 0.35;
    this.bm[1] += (my - this.bm[1]) * 0.35;
    this.bm[2] += (mz - this.bm[2]) * 0.35;
    this.bS = Math.min(1, this.bS + 0.25);
  }

  // STEP
  step(dt: number) {
    const x = this.x;
    const p = this.p;
    const v = this.v;
    const w = this.w;
    const f = this.f;
    const t = this.t;
    const damp = Math.exp(-dt / DAMP_TAU_S);

    // LEASH
    // only the whole veil is held: its centre of mass drifts home on a soft spring, and its
    // two ends are eased toward the frame's lean. nothing tells a single fold where to go
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let vx0 = 0;
    let vy0 = 0;
    let vz0 = 0;
    for (let i = 0; i < N; i++) {
      const i3 = i * 3;
      v[i3] = (x[i3] - p[i3]) / dt;
      v[i3 + 1] = (x[i3 + 1] - p[i3 + 1]) / dt;
      v[i3 + 2] = (x[i3 + 2] - p[i3 + 2]) / dt;
      cx += x[i3];
      cy += x[i3 + 1];
      cz += x[i3 + 2];
      vx0 += v[i3];
      vy0 += v[i3 + 1];
      vz0 += v[i3 + 2];
    }
    cx /= N;
    cy /= N;
    cz /= N;
    vx0 /= N;
    vy0 /= N;
    vz0 /= N;
    // on tall screens home sits a little left, as the lean carries the far end right
    const hx =
      -0.05 - 0.6 * Math.sin(this.tiltNow) + 0.15 * Math.cos(this.tiltNow) * Math.sin(t * 0.041);
    const lx = -LEASH_K * (cx - hx) - LEASH_C * vx0;
    const hy = 0.15 + 0.15 * Math.cos(this.tiltNow) + 0.1 * Math.sin(t * 0.053 + 1);
    const ly = -LEASH_K * (cy - hy) - LEASH_C * vy0;
    const lz = -LEASH_K * 4 * cz - LEASH_C * 1.5 * vz0;
    this.tiltNow += (this.tilt - this.tiltNow) * (1 - Math.exp(-dt / 1.5));
    // each end eased toward its own point along the lean, level with home and past the frame,
    // so the veil holds a band across the middle instead of sagging with its ends afloat
    let ax = 0;
    let ay = 0;
    let az = 0;
    let bx = 0;
    let by = 0;
    let bz = 0;
    const E = END_ROWS * NX;
    for (let k = 0; k < E; k++) {
      ax += x[k * 3];
      ay += x[k * 3 + 1];
      az += x[k * 3 + 2];
      const q = (N - 1 - k) * 3;
      bx += x[q];
      by += x[q + 1];
      bz += x[q + 2];
    }
    const ex = Math.cos(this.tiltNow) * this.span * 0.5;
    const ey = Math.sin(this.tiltNow) * this.span * 0.5;
    const oax = (hx - ex - ax / E) * ORIENT_K;
    const oay = (hy - ey - ay / E) * ORIENT_K;
    const oaz = (-az / E) * ORIENT_K * 0.5;
    const obx = (hx + ex - bx / E) * ORIENT_K;
    const oby = (hy + ey - by / E) * ORIENT_K;
    const obz = (-bz / E) * ORIENT_K * 0.5;

    // WIND
    // a slow, large swirl that never repeats, and gusts: broad fronts that travel across the
    // frame, so one end lifts before the other and folds roll along with them
    const breathe = 0.85 + 0.15 * Math.sin(t * 0.31) + 0.08 * Math.sin(t * 0.17 + 1.0);
    const W = this.wind * breathe;
    const ga = 0.35 * Math.sin(t * 0.029);
    const gdx = Math.cos(ga);
    const gdy = Math.sin(ga);
    const S = this.bS;
    const br2 = 1 / (BREATH_R * BREATH_R);
    const bsp = Math.hypot(this.bm[0], this.bm[1]);
    for (let i = 0; i < N; i++) {
      const i3 = i * 3;
      const px = x[i3];
      const py = x[i3 + 1];
      const pz = x[i3 + 2];
      const X = px * 0.45 + t * 0.05;
      const Y = py * 0.45 + t * 0.037 + 1.3;
      const Z = pz * 0.45 + t * 0.027 + 2.1;
      let wx = (Math.sin(Z) + 0.8 * Math.cos(Y)) * 0.6;
      let wy = (0.9 * Math.sin(X) + Math.cos(Z)) * 0.6;
      let wz = (0.8 * Math.sin(Y) + 0.9 * Math.cos(X)) * 0.6;
      // GUSTS: two trains of fronts at different speeds along the gust direction
      const along = px * gdx + py * gdy;
      const g1 = Math.max(0, Math.sin(along * 1.6 - t * 0.9));
      const g2 = Math.max(0, Math.sin(along * 0.9 - t * 0.55 + 2.0));
      const g = g1 * g1 * g1 * 0.9 + g2 * g2 * 0.6;
      wx += g * gdx * 0.7;
      wy += g * (gdy * 0.7 + 0.3);
      wz += g * 0.55 * Math.sin(t * 0.07 + along * 0.8);
      wx *= W;
      wy = wy * W + LIFT;
      wz *= W * 0.6;
      // TOUCH: air dragged along by the moving pointer, near its ray
      if (S > 0.01) {
        const qx = px - this.bo[0];
        const qy = py - this.bo[1];
        const qz = pz - this.bo[2];
        const al = qx * this.bd[0] + qy * this.bd[1] + qz * this.bd[2];
        const rx = qx - this.bd[0] * al;
        const ry = qy - this.bd[1] * al;
        const rz = qz - this.bd[2] * al;
        const k = S * Math.exp(-(rx * rx + ry * ry + rz * rz) * br2);
        if (k > 0.002) {
          wx += k * this.bm[0] * TOUCH;
          wy += k * (this.bm[1] * TOUCH + bsp * 0.5);
          wz -= k * bsp * 0.6;
        }
      }
      // the free edges catch a little more
      const ii = i % NX;
      const edge = ii < 2 || ii > NX - 3 ? 1.25 : 1;
      w[i3] = wx * edge;
      w[i3 + 1] = wy * edge;
      w[i3 + 2] = wz * edge;
      f[i3] = 0;
      f[i3 + 1] = 0;
      f[i3 + 2] = 0;
    }

    // DRAG per triangle: air pushes on a face by how squarely it meets it, like a sail
    for (let j = 0; j < NY - 1; j++)
      for (let i = 0; i < NX - 1; i++) {
        const a = j * NX + i;
        this.face(a, a + NX, a + 1);
        this.face(a + 1, a + NX, a + NX + 1);
      }

    let sp = 0;
    for (let i = 0; i < N; i++) {
      const i3 = i * 3;
      const m = this.area[i];
      let vx = v[i3];
      let vy = v[i3 + 1];
      let vz = v[i3 + 2];
      // a little drag along the cloth too
      let fx = f[i3] / m + KT * (w[i3] - vx) + lx;
      let fy = f[i3 + 1] / m + KT * (w[i3 + 1] - vy) + ly + GRAVITY;
      let fz = f[i3 + 2] / m + KT * (w[i3 + 2] - vz) + lz;
      const row = (i - (i % NX)) / NX;
      if (row < END_ROWS) {
        fx += oax;
        fy += oay;
        fz += oaz;
      } else if (row >= NY - END_ROWS) {
        fx += obx;
        fy += oby;
        fz += obz;
      }
      vx = vx * damp + fx * dt;
      vy = vy * damp + fy * dt;
      vz = vz * damp + fz * dt;
      const v2 = vx * vx + vy * vy + vz * vz;
      if (v2 > MAX_V * MAX_V) {
        const k = MAX_V / Math.sqrt(v2);
        vx *= k;
        vy *= k;
        vz *= k;
      }
      sp += Math.sqrt(Math.min(v2, MAX_V * MAX_V));
      p[i3] = x[i3];
      p[i3 + 1] = x[i3 + 1];
      p[i3 + 2] = x[i3 + 2];
      x[i3] += vx * dt;
      x[i3 + 1] += vy * dt;
      x[i3 + 2] += vz * dt;
    }
    this.speed = sp / N;
    this.solve(ITERS);
    this.keep();
    this.collide();
    this.t += dt * SLOW;
    // the pointer's air dies quickly once it stops
    this.bS *= Math.exp(-dt / 0.45);
    const fade = Math.exp(-dt / 0.3);
    this.bm[0] *= fade;
    this.bm[1] *= fade;
    this.bm[2] *= fade;
  }

  private face(a: number, b: number, c: number) {
    const x = this.x;
    const v = this.v;
    const w = this.w;
    const f = this.f;
    const a3 = a * 3;
    const b3 = b * 3;
    const c3 = c * 3;
    const ux = x[b3] - x[a3];
    const uy = x[b3 + 1] - x[a3 + 1];
    const uz = x[b3 + 2] - x[a3 + 2];
    const vx = x[c3] - x[a3];
    const vy = x[c3 + 1] - x[a3 + 1];
    const vz = x[c3 + 2] - x[a3 + 2];
    // twice the area, along the normal
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (l < 1e-9) return;
    const rx = (w[a3] + w[b3] + w[c3] - v[a3] - v[b3] - v[c3]) / 3;
    const ry = (w[a3 + 1] + w[b3 + 1] + w[c3 + 1] - v[a3 + 1] - v[b3 + 1] - v[c3 + 1]) / 3;
    const rz = (w[a3 + 2] + w[b3 + 2] + w[c3 + 2] - v[a3 + 2] - v[b3 + 2] - v[c3 + 2]) / 3;
    // area times (n . r) times n, shared by the three corners
    const s = (KN * (nx * rx + ny * ry + nz * rz)) / (6 * l);
    const fx = nx * s;
    const fy = ny * s;
    const fz = nz * s;
    f[a3] += fx;
    f[a3 + 1] += fy;
    f[a3 + 2] += fz;
    f[b3] += fx;
    f[b3 + 1] += fy;
    f[b3 + 2] += fz;
    f[c3] += fx;
    f[c3 + 1] += fy;
    f[c3 + 2] += fz;
  }

  private keep() {
    const x = this.x;
    const ka = this.ka;
    const kb = this.kb;
    const kr = this.kr;
    for (let c = 0; c < ka.length; c++) {
      const a3 = ka[c] * 3;
      const b3 = kb[c] * 3;
      const dx = x[b3] - x[a3];
      const dy = x[b3 + 1] - x[a3 + 1];
      const dz = x[b3 + 2] - x[a3 + 2];
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d >= kr[c] || d < 1e-7) continue;
      const s = ((d - kr[c]) / d) * 0.12;
      x[a3] += dx * s;
      x[a3 + 1] += dy * s;
      x[a3 + 2] += dz * s;
      x[b3] -= dx * s;
      x[b3 + 1] -= dy * s;
      x[b3 + 2] -= dz * s;
    }
  }

  private solve(iters: number) {
    const x = this.x;
    const ca = this.ca;
    const cb = this.cb;
    const cr = this.cr;
    const ck = this.ck;
    const M = ca.length;
    for (let it = 0; it < iters; it++)
      for (let c = 0; c < M; c++) {
        const a3 = ca[c] * 3;
        const b3 = cb[c] * 3;
        const dx = x[b3] - x[a3];
        const dy = x[b3 + 1] - x[a3 + 1];
        const dz = x[b3 + 2] - x[a3 + 2];
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d < 1e-7) continue;
        const s = ((d - cr[c]) / d) * 0.5 * ck[c];
        x[a3] += dx * s;
        x[a3 + 1] += dy * s;
        x[a3 + 2] += dz * s;
        x[b3] -= dx * s;
        x[b3 + 1] -= dy * s;
        x[b3 + 2] -= dz * s;
      }
  }

  // SELF
  // a spatial hash; any two particles closer than R_SELF that are not near neighbours in the
  // weave are eased apart, and their velocities with them, so layers slide over each other
  private collide() {
    const x = this.x;
    const p = this.p;
    const start = this.cellStart;
    const items = this.cellItems;
    const cellOf = this.cellOf;
    const cursor = this.cursor;
    start.fill(0);
    for (let i = 0; i < N; i++) {
      const h = hash(
        Math.floor(x[i * 3] / CELL),
        Math.floor(x[i * 3 + 1] / CELL),
        Math.floor(x[i * 3 + 2] / CELL),
      );
      cellOf[i] = h;
      start[h + 1]++;
    }
    // cell h spans start[h] .. start[h + 1]
    for (let h = 0; h < HASH; h++) start[h + 1] += start[h];
    cursor.set(start.subarray(0, HASH));
    for (let i = 0; i < N; i++) items[cursor[cellOf[i]]++] = i;
    const r2 = R_SELF * R_SELF;
    for (let i = 0; i < N; i++) {
      const i3 = i * 3;
      const fx = x[i3] / CELL;
      const fy = x[i3 + 1] / CELL;
      const fz = x[i3 + 2] / CELL;
      const gx = Math.floor(fx);
      const gy = Math.floor(fy);
      const gz = Math.floor(fz);
      // the two cells per axis on the near side of this particle
      const sx = fx - gx < 0.5 ? -1 : 0;
      const sy = fy - gy < 0.5 ? -1 : 0;
      const sz = fz - gz < 0.5 ? -1 : 0;
      const ii = i % NX;
      const ij = (i - ii) / NX;
      for (let ox = sx; ox <= sx + 1; ox++)
        for (let oy = sy; oy <= sy + 1; oy++)
          for (let oz = sz; oz <= sz + 1; oz++) {
            const h = hash(gx + ox, gy + oy, gz + oz);
            for (let s = start[h]; s < start[h + 1]; s++) {
              const j = items[s];
              if (j <= i) continue;
              const ji = j % NX;
              const jj = (j - ji) / NX;
              if (Math.abs(ji - ii) <= 2 && Math.abs(jj - ij) <= 2) continue;
              const j3 = j * 3;
              const dx = x[j3] - x[i3];
              const dy = x[j3 + 1] - x[i3 + 1];
              const dz = x[j3 + 2] - x[i3 + 2];
              const d2 = dx * dx + dy * dy + dz * dz;
              if (d2 >= r2 || d2 < 1e-12) continue;
              const d = Math.sqrt(d2);
              const s2 = ((R_SELF - d) / d) * 0.5 * 0.6;
              x[i3] -= dx * s2;
              x[i3 + 1] -= dy * s2;
              x[i3 + 2] -= dz * s2;
              x[j3] += dx * s2;
              x[j3 + 1] += dy * s2;
              x[j3 + 2] += dz * s2;
              // share velocity, the friction of silk on silk
              for (let k = 0; k < 3; k++) {
                const vi = x[i3 + k] - p[i3 + k];
                const vj = x[j3 + k] - p[j3 + k];
                const avg = (vi + vj) * 0.5;
                p[i3 + k] = x[i3 + k] - (vi + (avg - vi) * 0.3);
                p[j3 + k] = x[j3 + k] - (vj + (avg - vj) * 0.3);
              }
            }
          }
    }
  }

  // NORMALS
  // central differences across the grid, one-sided at the edges
  normals() {
    const x = this.x;
    const n = this.n;
    for (let j = 0; j < NY; j++)
      for (let i = 0; i < NX; i++) {
        const l = (j * NX + Math.max(0, i - 1)) * 3;
        const r = (j * NX + Math.min(NX - 1, i + 1)) * 3;
        const u = (Math.max(0, j - 1) * NX + i) * 3;
        const d = (Math.min(NY - 1, j + 1) * NX + i) * 3;
        const ux = x[r] - x[l];
        const uy = x[r + 1] - x[l + 1];
        const uz = x[r + 2] - x[l + 2];
        const vx = x[d] - x[u];
        const vy = x[d + 1] - x[u + 1];
        const vz = x[d + 2] - x[u + 2];
        let nx = uy * vz - uz * vy;
        let ny = uz * vx - ux * vz;
        let nz = ux * vy - uy * vx;
        const L = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= L;
        ny /= L;
        nz /= L;
        const k = (j * NX + i) * 3;
        n[k] = nx;
        n[k + 1] = ny;
        n[k + 2] = nz;
      }
  }
}

function hash(x: number, y: number, z: number) {
  return (Math.imul(x, 92837111) ^ Math.imul(y, 689287499) ^ Math.imul(z, 283923481)) & (HASH - 1);
}
