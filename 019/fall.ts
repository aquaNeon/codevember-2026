// FALL
// a stony meteoroid through the air, in km and seconds: drag, ablation, the curve of the
// earth, fragments shed as the air pressure climbs past the rock's strength, and an airburst
// when it climbs past it all at once. no dom and no gl, so it runs anywhere

const R_EARTH_KM = 6371;
const H_SCALE_KM = 7.16;
const RHO0 = 1.225;
const G_M_S2 = 9.81;
const CD = 1;
const RHO_ROCK = 3300;
const ABLATE = 1.2e-7; // stylised, change for a faster burn
const CURVE_GAIN = 2.5; // stylised lift, so grazers skip back out
const ENTRY_KM = 112;
const ENTRY_V_KM_S = 19;
export const MASS0_KG = 1800;
const FRAG_Q_PA = 1.2e6; // first break-up
const FRAG_STEP = 1.45; // each later one needs this much more pressure
const FRAG_SHARE = 0.12; // mass a fragment takes
const BURST_Q_PA = 2.6e6;
const BURST_SHARE = 0.35; // a body worn down to this share of its mass breaks up
export const VIS_KM = 0.005; // drawn radius of the full mass, km; stylised, change for a bigger rock
const SHRINK_POW = 1.1;
const LOOSEN_S = [0.15, 0.7] as const; // sim seconds between rips: least, mean of the rest
const CRACK_S = 0.35; // the seam glows this long before the piece goes
const CLOSE_PUSH_KM_S = 0.22; // how hard pieces are thrown clear in the chase
const CLOSE_GAP_S = [0.3, 0.25] as const; // sim seconds between rips in the chase: least, spread
// where seams open: across the path, along it; forward, on the hot face and its shoulders
const SHOULDER = [0.6, 0.8] as const;
const LOOSE_SHARE = 0.03; // a big chunk; the small ones are a fraction of it
const LOOSE_KICK_KM_S = 0.06;
const BITE_S = 1.1; // the bite glows and wears smooth over this // drawn size against mass; above 1/3 so the wearing away shows

// drawn radius of a body, km
export const visR = (m: number) => VIS_KM * Math.pow(Math.max(0, m) / MASS0_KG, SHRINK_POW);
// pieces are drawn by volume, so they read as real chunks of the rock
export const pieceR = (m: number) => VIS_KM * 0.9 * Math.cbrt(Math.max(0, m) / MASS0_KG);
const BURNT_KG = 0.5;
const DARK_KM_S = 3.5; // slower than this it no longer glows
const LUM_REF = 6e10; // light at which a body reads 1
const STEP_S = 1 / 240;
const PREDICT_S = 60;

export const PATH_Z_KM = -90; // the path runs this far in front of the town
const END_X_KM = 14; // where the end lands across the view

export const MAX_BODIES = 24;
export const HIST_N = 224;
export const HIST_DT_S = 1 / 40;
export const PATH_N = 96;
export const ROWS = MAX_BODIES * 2; // two rows per body
export const MAX_SPARKS = 1100;
// drawn size per kind: grain, drop, ember, melt sheet, chunk
const SPARK_SIZE = [1, 1.6, 1.3, 2.8, 5] as const;
export const SPARK_STRIDE = 10; // x y z, vx vy vz, age, life, size, kind

export const OUT = { flying: 0, burst: 1, burnt: 2, skip: 3, dark: 4 } as const;

// PREDICTION
// one body, no fragments, from a state; what the director plans the shots on
export class Forecast {
  out: number = OUT.flying;
  tEnd = 0;
  tLow = 0; // when it is lowest
  end = new Float32Array(3);
  low = new Float32Array(3);
  path = new Float32Array(PATH_N * 3);
}

export class Fall {
  // BODIES
  readonly px = new Float32Array(MAX_BODIES);
  readonly py = new Float32Array(MAX_BODIES);
  readonly pz = new Float32Array(MAX_BODIES);
  readonly vx = new Float32Array(MAX_BODIES);
  readonly vy = new Float32Array(MAX_BODIES);
  readonly vz = new Float32Array(MAX_BODIES);
  readonly mass = new Float32Array(MAX_BODIES);
  readonly lum = new Float32Array(MAX_BODIES);
  readonly alive = new Uint8Array(MAX_BODIES);
  readonly seed = new Float32Array(MAX_BODIES);
  readonly char = new Float32Array(MAX_BODIES); // fusion crust, 0 fresh to 1 charred
  readonly born = new Float32Array(MAX_BODIES);
  readonly fuse = new Float32Array(MAX_BODIES); // sim seconds left of a vaporising piece
  readonly fuse0 = new Float32Array(MAX_BODIES);
  private qNext = new Float32Array(MAX_BODIES);
  private sparkAcc = new Float32Array(MAX_BODIES);
  private sampleAt = new Float32Array(MAX_BODIES);

  // HISTORY
  // a ring per body, its newest slot always the live head; rows ready for a float texture
  readonly hist = new Float32Array(HIST_N * ROWS * 4);
  readonly head = new Int32Array(MAX_BODIES);
  readonly count = new Int32Array(MAX_BODIES);
  dirty = true;

  // SPARKS
  readonly sparks = new Float32Array(MAX_SPARKS * SPARK_STRIDE);
  private nextSpark = 0;

  // PASS
  t = 0;
  out: number = OUT.flying;
  active = false;
  burstQ = BURST_Q_PA;
  gamma = 0.42; // entry angle below the horizon, rad
  readonly burst = new Float32Array(8); // x y z, energy, time, direction
  readonly fc = new Forecast();
  private low = false; // the main body has dropped into the air
  readonly crack = new Float32Array(4); // seam opening on the main body: direction, progress
  readonly bite = new Float32Array(4); // bite left where a piece came off: direction, glow
  private cut = new Float32Array(3);
  private crackA = 0;
  private loosenAt = 0;
  private ripped = 0; // kg torn off in pieces, kept out of the burst timing so the plan holds
  rate = 1; // sim seconds per screen second, from the host, so burn-ups read the same in slow motion
  closeUp = 1; // the host raises this in the chase, so more pieces come off up close
  private sheetAcc = 0;
  private chunkAcc = 0;
  onEvent: (kind: "frag" | "burst" | "end") => void = () => {};

  // the chase starts: the first rip comes almost at once
  ripSoon() {
    this.loosenAt = Math.min(this.loosenAt, this.t + 0.06);
  }

  // LAUNCH
  // place the entry so the end lands across the view whatever the angle
  launch(gamma: number) {
    this.gamma = gamma;
    this.burstQ = BURST_Q_PA * (0.88 + Math.random() * 0.3);
    this.alive.fill(0);
    this.count.fill(0);
    this.lum.fill(0);
    this.sparks.fill(0);
    this.t = 0;
    this.out = OUT.flying;
    this.low = false;
    this.crack.fill(0);
    this.bite.fill(0);
    this.loosenAt = 1.5;
    this.ripped = 0;
    this.burst[3] = 0;
    this.spawn(0, 0, ENTRY_KM, PATH_Z_KM, gamma, MASS0_KG);
    this.forecast();
    const dx = END_X_KM - this.fc.end[0];
    this.px[0] += dx;
    this.forecast();
    this.active = true;
  }

  // the path the first one will take, so the opening frame is framed before it arrives
  aim(gamma: number) {
    this.gamma = gamma;
    if (this.active) return;
    this.spawn(0, 0, ENTRY_KM, PATH_Z_KM, gamma, MASS0_KG);
    this.forecast();
    this.px[0] += END_X_KM - this.fc.end[0];
    this.forecast();
    this.alive[0] = 0;
    this.count[0] = 0;
  }

  private spawn(i: number, x: number, y: number, z: number, gamma: number, m: number) {
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = -ENTRY_V_KM_S * Math.cos(gamma);
    this.vy[i] = -ENTRY_V_KM_S * Math.sin(gamma);
    this.vz[i] = 0;
    this.mass[i] = m;
    this.alive[i] = 1;
    this.seed[i] = Math.random();
    this.char[i] = 0;
    this.born[i] = this.t;
    this.fuse[i] = 0;
    this.qNext[i] = FRAG_Q_PA;
    this.head[i] = 0;
    this.count[i] = 0;
    this.sampleAt[i] = this.t;
    this.sparkAcc[i] = 0;
  }

  forecast() {
    const f = this.fc;
    let x = this.px[0];
    let y = this.py[0];
    let z = this.pz[0];
    let ux = this.vx[0];
    let uy = this.vy[0];
    let uz = this.vz[0];
    let m = this.mass[0];
    let q0 = this.qNext[0];
    let t = 0;
    let low = y;
    let descended = false;
    f.out = OUT.flying;
    f.tLow = 0;
    f.low[0] = x;
    f.low[1] = y;
    f.low[2] = z;
    const every = PREDICT_S / STEP_S / PATH_N;
    let k = 0;
    for (let n = 0; n < PREDICT_S / STEP_S; n++) {
      if (n % Math.ceil(every) === 0 && k < PATH_N) {
        f.path[k * 3] = x;
        f.path[k * 3 + 1] = y;
        f.path[k * 3 + 2] = z;
        k++;
      }
      const v = Math.hypot(ux, uy, uz);
      const rho = RHO0 * Math.exp(-y / H_SCALE_KM);
      const q = rho * v * v * 1e6;
      if (q > q0) {
        m *= 1 - FRAG_SHARE;
        q0 *= FRAG_STEP;
      }
      // every pass ends in an airburst: the air crushes it, it wears too thin, or a
      // grazer bursts at its lowest point
      if (q > this.burstQ || m < BURST_SHARE * MASS0_KG || (descended && uy > 0) || v < DARK_KM_S)
        f.out = OUT.burst;
      if (f.out !== OUT.flying) break;
      const r = Math.cbrt((3 * m) / (4 * Math.PI * RHO_ROCK));
      const a = Math.PI * r * r;
      const drag = 0.5 * CD * rho * (a / m) * 1e3 * v;
      const vh2 = ux * ux + uz * uz;
      const lift = (CURVE_GAIN * vh2) / (R_EARTH_KM + y) - G_M_S2 / 1e3;
      ux -= drag * ux * STEP_S;
      uy += (-drag * uy + lift) * STEP_S;
      uz -= drag * uz * STEP_S;
      m -= ABLATE * 1e9 * rho * v * v * v * a * STEP_S;
      x += ux * STEP_S;
      y += uy * STEP_S;
      z += uz * STEP_S;
      t += STEP_S;
      if (y < low) {
        low = y;
        f.tLow = t;
        f.low[0] = x;
        f.low[1] = y;
        f.low[2] = z;
      }
      if (y < ENTRY_KM - 6) descended = true;
    }
    for (; k < PATH_N; k++) {
      f.path[k * 3] = x;
      f.path[k * 3 + 1] = y;
      f.path[k * 3 + 2] = z;
    }
    if (f.out === OUT.flying) f.out = OUT.burst;
    f.tEnd = t;
    f.end[0] = x;
    f.end[1] = y;
    f.end[2] = z;
  }

  // STEP
  step(dt: number) {
    let left = dt;
    while (left > 1e-6) {
      const h = Math.min(STEP_S * 2, left);
      this.sub(h);
      left -= h;
    }
    this.loosen(dt);
    this.sparkStep(dt);
    this.record();
  }

  private sub(dt: number) {
    this.t += dt;
    for (let i = 0; i < MAX_BODIES; i++) {
      if (!this.alive[i]) continue;
      const ux = this.vx[i];
      const uy = this.vy[i];
      const uz = this.vz[i];
      const y = this.py[i];
      const v = Math.hypot(ux, uy, uz);
      const rho = RHO0 * Math.exp(-y / H_SCALE_KM);
      const q = rho * v * v * 1e6;
      const m = this.mass[i];
      const r = Math.cbrt((3 * m) / (4 * Math.PI * RHO_ROCK));
      const a = Math.PI * r * r;
      const drag = 0.5 * CD * rho * (a / m) * 1e3 * v;
      const vh2 = ux * ux + uz * uz;
      const lift = (CURVE_GAIN * vh2) / (R_EARTH_KM + y) - G_M_S2 / 1e3;
      const dm = ABLATE * 1e9 * rho * v * v * v * a;
      this.vx[i] -= drag * ux * dt;
      this.vy[i] += (-drag * uy + lift) * dt;
      this.vz[i] -= drag * uz * dt;
      this.mass[i] = m - dm * dt;
      this.px[i] += this.vx[i] * dt;
      this.py[i] += this.vy[i] * dt;
      this.pz[i] += this.vz[i] * dt;
      // a fresh fragment flares as it breaks away
      let flare = i ? 1.0 * Math.exp(-(this.t - this.born[i]) / 0.9) : 0.04;
      if (this.fuse[i] > 0) {
        // a bright flare as it goes, fading with it
        this.fuse[i] -= dt;
        flare = 2.2 * Math.sqrt(Math.max(0, this.fuse[i] / this.fuse0[i]));
        if (this.fuse[i] <= 0) {
          this.die(i, OUT.burnt);
          continue;
        }
      }
      this.lum[i] = Math.min(5, (dm * v * v * 1e6) / LUM_REF + flare);
      this.char[i] = Math.min(1, this.char[i] + dt * this.lum[i] * 0.35);
      this.sparkAcc[i] += dt * this.lum[i] * (i ? 60 : 150);

      if (
        i === 0 &&
        (q > this.burstQ ||
          this.mass[0] + this.ripped < BURST_SHARE * MASS0_KG ||
          (this.low && this.vy[0] > 0) ||
          v < DARK_KM_S)
      )
        this.airburst(q);
      else if (q > this.qNext[i] && this.mass[i] > 5) this.shed(i);
      else if (this.mass[i] < BURNT_KG || v < DARK_KM_S) this.die(i, OUT.burnt);
      if (i === 0 && this.py[0] < ENTRY_KM - 6) this.low = true;
    }
  }

  private die(i: number, out: number) {
    this.alive[i] = 0;
    this.lum[i] = 0;
    if (i === 0) {
      this.out = out;
      this.onEvent("end");
    }
  }

  private free() {
    for (let i = 1; i < MAX_BODIES; i++) {
      if (this.alive[i]) continue;
      const n = this.count[i];
      if (!n) return i;
      const birth = this.hist[(i * 2 * HIST_N + this.head[i]) * 4 + 3];
      if (this.t - birth > 0.8) return i;
    }
    return -1;
  }

  // a piece breaks off and goes its own way
  private shed(i: number) {
    this.qNext[i] *= FRAG_STEP;
    const n = i === 0 ? 1 + Math.floor(Math.random() * 2) : 1;
    for (let k = 0; k < n; k++) this.piece(i, FRAG_SHARE * (i ? 2 : 1), 0.35 + Math.random() * 0.5);
    if (i === 0) this.onEvent("frag");
  }

  private piece(i: number, share: number, kick: number, a = Math.random() * Math.PI * 2) {
    const j = this.free();
    if (j < 0) return -1;
    const m = this.mass[i] * share;
    this.mass[i] -= m;
    this.spawn(j, this.px[i], this.py[i], this.pz[i], 0, m);
    // same velocity plus a sideways kick
    const ux = this.vx[i];
    const uy = this.vy[i];
    const uz = this.vz[i];
    const v = Math.hypot(ux, uy, uz) || 1;
    // two axes across the path
    let nx = -uz;
    let nz = ux;
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl;
    nz /= nl;
    const bx = (uy * nz) / v;
    const by = (uz * nx - ux * nz) / v;
    const bz = (-uy * nx) / v;
    const c = Math.cos(a) * kick;
    const s = Math.sin(a) * kick;
    this.vx[j] = ux + nx * c + bx * s;
    this.vy[j] = uy + by * s;
    this.vz[j] = uz + nz * c + bz * s;
    this.char[j] = this.char[i] * 0.4;
    this.qNext[j] = this.qNext[i] * 1.3;
    // where on the body it came from, for the bite it leaves
    this.cut[0] = (nx * Math.cos(a) + bx * Math.sin(a)) * SHOULDER[0] + (ux / v) * SHOULDER[1];
    this.cut[1] = by * Math.sin(a) * SHOULDER[0] + (uy / v) * SHOULDER[1];
    this.cut[2] = (nz * Math.cos(a) + bz * Math.sin(a)) * SHOULDER[0] + (uz / v) * SHOULDER[1];
    const cl = Math.hypot(this.cut[0], this.cut[1], this.cut[2]) || 1;
    this.cut[0] /= cl;
    this.cut[1] /= cl;
    this.cut[2] /= cl;
    return j;
  }

  // LOOSEN
  // now and then a seam glows open on the hot face, where the heat and the ram pressure peak;
  // the pieces break away, splay out and fall back past the body, leaving a glowing bite
  private loosen(dt: number) {
    this.bite[3] *= Math.exp(-dt / BITE_S);
    if (!this.alive[0]) {
      this.crack[3] = 0;
      return;
    }
    if (this.crack[3] > 0) {
      this.crack[3] += dt / CRACK_S;
      if (this.crack[3] < 1) return;
      this.crack[3] = 0;
      // the seam rips: a cluster goes at once, a big chunk or two and a spray of small ones
      const n = 3 + Math.floor(Math.random() * 4);
      const r = visR(this.mass[0]);
      for (let k = 0; k < n; k++) {
        const big = k < 1 + (Math.random() < 0.4 ? 1 : 0);
        const share = big ? LOOSE_SHARE : LOOSE_SHARE * (0.12 + Math.random() * 0.25);
        const kick = LOOSE_KICK_KM_S * (big ? 1 : 1.5 + Math.random() * 2);
        const j = this.piece(0, share, kick, this.crackA + (Math.random() - 0.5) * 1.1);
        if (j < 0) break;
        this.ripped += this.mass[j];
        if (k === 0) {
          this.bite[0] = this.cut[0];
          this.bite[1] = this.cut[1];
          this.bite[2] = this.cut[2];
          this.bite[3] = 1;
        }
        const o = r * (0.8 + Math.random() * 0.4);
        this.px[j] += this.cut[0] * o;
        this.py[j] += this.cut[1] * o;
        this.pz[j] += this.cut[2] * o;
        // up close they are thrown clear, out along the tear and back down the trail
        const close = this.closeUp > 1;
        const push = close ? CLOSE_PUSH_KM_S * (0.6 + Math.random() * 0.8) : 0;
        // the push splays them sideways first, so they fall back past the body, not through it
        const vv = this.speed(0) || 1;
        const hx = this.vx[0] / vv;
        const hy = this.vy[0] / vv;
        const hz = this.vz[0] / vv;
        const along = this.cut[0] * hx + this.cut[1] * hy + this.cut[2] * hz;
        let lx = this.cut[0] - hx * along;
        let ly = this.cut[1] - hy * along;
        let lz = this.cut[2] - hz * along;
        const ll = Math.hypot(lx, ly, lz) || 1;
        lx /= ll;
        ly /= ll;
        lz /= ll;
        this.vx[j] += lx * push - hx * push * 0.7;
        this.vy[j] += ly * push - hy * push * 0.7;
        this.vz[j] += lz * push - hz * push * 0.7;
        // then they flare and vaporise: a blink in a wide shot, long enough to follow up close
        const life = close ? (big ? 0.85 : 0.6) : big ? 0.3 : 0.18;
        this.fuse[j] = this.fuse0[j] = this.rate * life * (0.85 + Math.random() * 0.3);
      }
      return;
    }
    if (this.lum[0] < (this.closeUp > 1 ? 0.15 : 0.4) || this.t < this.loosenAt) return;
    // calm, then a violent rip: irregular gaps that close up as the air thickens
    const v0 = this.speed(0);
    const q = RHO0 * Math.exp(-this.py[0] / H_SCALE_KM) * v0 * v0 * 1e6;
    const fury = 0.5 + 3 * Math.min(1, q / this.burstQ);
    const gap = LOOSEN_S[0] - Math.log(1 - Math.random() * 0.95) * LOOSEN_S[1];
    // up close the rips come steadily, so the orbit always sees a few
    this.loosenAt =
      this.t + (this.closeUp > 1 ? CLOSE_GAP_S[0] + Math.random() * CLOSE_GAP_S[1] : gap / fury);
    // the seam: aim where the piece will go, so the crack shows on the right side
    this.crackA = Math.random() * Math.PI * 2;
    const ux = this.vx[0];
    const uz = this.vz[0];
    const v = this.speed(0) || 1;
    let nx = -uz;
    let nz = ux;
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl;
    nz /= nl;
    const uy = this.vy[0];
    const bx = (uy * nz) / v;
    const by = (uz * nx - ux * nz) / v;
    const bz = (-uy * nx) / v;
    const a = this.crackA;
    let cx = (nx * Math.cos(a) + bx * Math.sin(a)) * SHOULDER[0] + (ux / v) * SHOULDER[1];
    let cy = by * Math.sin(a) * SHOULDER[0] + (uy / v) * SHOULDER[1];
    let cz = (nz * Math.cos(a) + bz * Math.sin(a)) * SHOULDER[0] + (uz / v) * SHOULDER[1];
    const cl = Math.hypot(cx, cy, cz) || 1;
    cx /= cl;
    cy /= cl;
    cz /= cl;
    this.crack[0] = cx;
    this.crack[1] = cy;
    this.crack[2] = cz;
    this.crack[3] = 1e-3;
  }

  private airburst(q: number) {
    const m = this.mass[0];
    const v = Math.hypot(this.vx[0], this.vy[0], this.vz[0]);
    this.burst[0] = this.px[0];
    this.burst[1] = this.py[0];
    this.burst[2] = this.pz[0];
    // steeper means more pressure and more mass left: a harder burst
    this.burst[3] = Math.min(1.9, 0.6 + 0.45 * Math.min(2, q / this.burstQ) + m / 2500 + v / 80);
    this.burst[4] = this.t;
    this.burst[5] = this.vx[0] / v;
    this.burst[6] = this.vy[0] / v;
    this.burst[7] = this.vz[0] / v;
    for (let k = 0; k < 13; k++) this.piece(0, 0.07, 1.2 + Math.random() * 3);
    for (let k = 0; k < 260; k++) this.spark(0, 1.2 + Math.random() * 4, k % 3 === 0 ? 2 : 0);
    this.die(0, OUT.burst);
    this.out = OUT.burst;
    this.onEvent("burst");
  }

  // SPARKS
  private spark(i: number, spread: number, kind: number) {
    const s = this.sparks;
    const o = this.nextSpark * SPARK_STRIDE;
    this.nextSpark = (this.nextSpark + 1) % MAX_SPARKS;
    // melt sheets slide back along the body, chunks fall behind faster
    const lag =
      kind === 2
        ? 0.9
        : kind === 3
          ? 0.985 + Math.random() * 0.01
          : kind === 4
            ? 0.94 + Math.random() * 0.03
            : 0.965 + Math.random() * 0.03;
    const u = Math.random() * 2 - 1;
    const a = Math.random() * Math.PI * 2;
    const w = Math.sqrt(1 - u * u);
    // grains peel off the hot face and the rim behind it
    const v = this.speed(i) || 1;
    const vr = visR(this.mass[i]);
    const r = vr * (0.6 + Math.random() * 0.5);
    const ahead = vr * 0.7;
    s[o] = this.px[i] + Math.cos(a) * w * r + (this.vx[i] / v) * ahead;
    s[o + 1] = this.py[i] + u * r + (this.vy[i] / v) * ahead;
    s[o + 2] = this.pz[i] + Math.sin(a) * w * r + (this.vz[i] / v) * ahead;
    s[o + 3] = this.vx[i] * lag + Math.cos(a) * w * spread;
    s[o + 4] = this.vy[i] * lag + u * spread;
    s[o + 5] = this.vz[i] * lag + Math.sin(a) * w * spread;
    s[o + 6] = 0;
    s[o + 7] = kind === 1 || kind === 4 ? 0.9 + Math.random() * 0.9 : 0.25 + Math.random() * 0.6;
    s[o + 8] = SPARK_SIZE[kind] * (0.7 + Math.random() * 0.6);
    s[o + 9] = kind;
  }

  private sparkStep(dt: number) {
    for (let i = 0; i < MAX_BODIES; i++) {
      if (!this.alive[i]) continue;
      while (this.sparkAcc[i] >= 1) {
        this.sparkAcc[i] -= 1;
        const kind = Math.random() < 0.18 ? 1 : 0;
        this.spark(i, kind ? 0.2 + Math.random() * 0.4 : 0.4 + Math.random() * 1.4, kind);
      }
    }
    // STRIPPING
    // the main body sheds sheets of melt off its hot face and, now and then, a chunk
    if (this.alive[0]) {
      this.sheetAcc += dt * this.lum[0] * 45;
      this.chunkAcc += dt * this.lum[0] * 2.2;
      while (this.sheetAcc >= 1) {
        this.sheetAcc -= 1;
        this.spark(0, 0.25 + Math.random() * 0.45, 3);
      }
      while (this.chunkAcc >= 1) {
        this.chunkAcc -= 1;
        this.spark(0, 0.3 + Math.random() * 0.6, 4);
      }
    }
    const s = this.sparks;
    for (let o = 0; o < s.length; o += SPARK_STRIDE) {
      if (s[o + 6] >= s[o + 7]) continue;
      const kind = s[o + 9];
      const k = Math.exp(-dt * (kind === 1 ? 2.2 : kind === 3 ? 1.0 : 1.4));
      s[o + 3] *= k;
      s[o + 4] = s[o + 4] * k - (kind === 1 || kind === 4 ? 0.25 : 0.04) * dt;
      s[o + 5] *= k;
      s[o] += s[o + 3] * dt;
      s[o + 1] += s[o + 4] * dt;
      s[o + 2] += s[o + 5] * dt;
      s[o + 6] += dt;
    }
  }

  // HISTORY
  private record() {
    const H = this.hist;
    for (let i = 0; i < MAX_BODIES; i++) {
      if (!this.alive[i]) continue;
      if (this.count[i] === 0) this.count[i] = 1;
      else if (this.t - this.sampleAt[i] >= HIST_DT_S) {
        this.sampleAt[i] = this.t;
        this.head[i] = (this.head[i] + 1) % HIST_N;
        this.count[i] = Math.min(HIST_N, this.count[i] + 1);
      }
      const o = (i * 2 * HIST_N + this.head[i]) * 4;
      H[o] = this.px[i];
      H[o + 1] = this.py[i];
      H[o + 2] = this.pz[i];
      H[o + 3] = this.t;
      const o2 = o + HIST_N * 4;
      H[o2] = this.lum[i];
      H[o2 + 1] = this.mass[i];
    }
    this.dirty = true;
  }

  // newest trail point still glowing, for the loop to know when the sky is quiet
  quiet() {
    if (this.active && this.out === OUT.flying) return false;
    for (let i = 0; i < MAX_BODIES; i++) {
      if (this.alive[i]) return false;
      if (!this.count[i]) continue;
      const birth = this.hist[(i * 2 * HIST_N + this.head[i]) * 4 + 3];
      if (this.t - birth < (i ? 0.8 : 5.6)) return false;
    }
    const s = this.sparks;
    for (let o = 0; o < s.length; o += SPARK_STRIDE) if (s[o + 6] < s[o + 7]) return false;
    return this.t - this.burst[4] > 5 || this.burst[3] === 0;
  }

  speed(i: number) {
    return Math.hypot(this.vx[i], this.vy[i], this.vz[i]);
  }
}
