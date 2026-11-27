import { OUT, PATH_Z_KM, type Fall } from "./fall";

// DIRECTOR
// shot plan timed on the predicted path, replanned when the path is steered

export const SHOT = { establish: 0, track: 1, low: 2, chase: 3, wide: 4, calm: 5 } as const;
export const SHOT_NAMES = ["Establishing", "Tracking", "Low angle", "Chase", "Wide", "Wide"];

const HILL = [5, 0.9, 9] as const;
const TOWN = [1.2, 0.04, -1.5] as const;
const ESTABLISH_SIM_S = 2.6;
const LOW_SIM_S = 1.5;
const CHASE_SIM_S = 1.8;
const ORBIT_KM = 0.17;
const WIDE_LEAD_SIM_S = 0.45;
const TRACK_REAL_S = 3.6;
const WIDE_REAL_S = 4.5;
const RATE = [1.9, 1.35, 1.0, 0.42, 0.8, 0.6];
const FOV_DEG = [50, 30, 74, 36, 52, 54];
const HAND_RAD = [0.0022, 0.0028, 0.0035, 0.006, 0.0022, 0];
const LOOK_TAU_S = [0.9, 0.45, 0.3, 0.12, 0.8, 1.5];
const SHAKE_S = 0.9;
const CHASE_REAL_S = CHASE_SIM_S / RATE[3];
const SHAKE_RAD = 0.018;
// FRAMING
// subject height on screen per shot, ndc
const FRAME_Y = [0.3, 0.28, 0.32, 0.14, 0.32, 0.3];

export class Director {
  shot: number = SHOT.establish;
  cut = false;
  rate = 1;
  readonly eye = new Float32Array(3);
  readonly fwd = new Float32Array(3);
  readonly right = new Float32Array(3);
  readonly up = new Float32Array(3);
  readonly shift = new Float32Array(2);
  readonly vel = new Float32Array(3);
  tanHalf = 0.4;

  private look = new Float32Array(3);
  private goal = new Float32Array(3);
  private eyeGoal = new Float32Array(3);
  private prevEye = new Float32Array(3);
  private fov = 50;
  private roll = 0;
  private orbit = 0;
  private tShot = 0;
  private wall = 0;
  private shake = 0;
  private hand = 1;
  private reduced: boolean;
  private passN = 0;
  // PLAN
  // shot start times, sim seconds since launch
  private tTrack = 0;
  private tLow = 0;
  private tChase = 0;
  private tWide = 0;
  private tEnd = 0;

  constructor(reduced: boolean) {
    this.reduced = reduced;
    this.eye.set(HILL);
    this.look.set([HILL[0] - 6, HILL[1] + 22, PATH_Z_KM]);
    this.goal.set(this.look);
    this.shot = reduced ? SHOT.calm : SHOT.establish;
  }

  motion(reduced: boolean) {
    this.reduced = reduced;
    if (reduced) this.shot = SHOT.calm;
  }

  start(f: Fall) {
    this.passN++;
    this.plan(f);
    this.go(this.reduced ? SHOT.calm : SHOT.establish, true);
  }

  plan(f: Fall) {
    const fc = f.fc;
    const anchor = fc.out === OUT.skip ? fc.tLow + 1.2 : fc.tEnd;
    const t0 = f.t;
    this.tWide = t0 + Math.max(0.5, anchor - WIDE_LEAD_SIM_S);
    this.tEnd = t0 + fc.tEnd;
    this.tChase = this.tWide - CHASE_SIM_S;
    this.tLow = this.tChase - LOW_SIM_S;
    if (this.tLow < t0 + ESTABLISH_SIM_S || this.passN % 2 === 0) this.tLow = this.tChase;
    if (this.tChase < t0 + 1.2) this.tChase = this.tLow = this.tWide;
    this.tTrack = Math.min(t0 + ESTABLISH_SIM_S, this.tLow * 0.45);
  }

  shock(e: number) {
    if (!this.reduced) this.shake = Math.min(1.4, e);
  }

  private go(shot: number, hard: boolean) {
    this.shot = shot;
    this.tShot = 0;
    this.cut = hard;
    this.orbit = Math.random() < 0.5 ? -1 : 1;
  }

  // UPDATE
  update(dt: number, f: Fall, aspect: number, busy: boolean) {
    this.wall += dt;
    this.tShot += dt;
    this.cut = false;
    const t = f.t;
    const flying = f.active && f.out === OUT.flying;
    if (!this.reduced && f.active) {
      if (this.shot === SHOT.establish && t >= this.tTrack) this.go(SHOT.track, false);
      if (this.shot === SHOT.track && t >= this.tLow && this.tLow < this.tChase && flying)
        this.go(SHOT.low, true);
      if (this.shot <= SHOT.low && t >= this.tChase && this.tChase < this.tWide && flying)
        this.go(SHOT.chase, true);
      if (this.shot !== SHOT.wide && (t >= this.tWide || !flying)) this.go(SHOT.wide, true);
    }
    const s = this.shot;
    let rate = RATE[s];
    if (s === SHOT.track) rate = Math.max(rate, (this.tLow - this.tTrack) / TRACK_REAL_S);
    if (s === SHOT.wide && flying) rate = Math.max(rate, (this.tEnd - t) / WIDE_REAL_S);
    if (!flying && s === SHOT.wide) rate = 1;
    this.rate = rate;

    // SUBJECT
    const hx = f.px[0];
    const hy = f.py[0];
    const hz = f.pz[0];
    const fc = f.fc;
    const fy = FRAME_Y[s];
    let fov = FOV_DEG[s];
    this.prevEye.set(this.eye);
    if (s === SHOT.establish || s === SHOT.calm) {
      this.eyeGoal.set(HILL);
      const k = s === SHOT.calm ? 0.5 : 0.62;
      const px = fc.path[0] * k + fc.end[0] * (1 - k);
      const py = fc.path[1] * k + fc.end[1] * (1 - k);
      this.goal[0] = px;
      this.goal[1] = py * 0.82;
      this.goal[2] = PATH_Z_KM;
      if (s === SHOT.establish) fov -= Math.min(6, this.tShot * 1.2);
    } else if (s === SHOT.track) {
      this.eyeGoal.set(HILL);
      this.eyeGoal[0] -= Math.min(1.5, this.tShot * 0.4);
      this.goal[0] = hx - 6;
      this.goal[1] = hy;
      this.goal[2] = hz;
      fov = Math.max(16, fov - this.tShot * 4);
    } else if (s === SHOT.low) {
      this.eyeGoal.set(TOWN);
      this.goal[0] = hx - 10;
      this.goal[1] = hy;
      this.goal[2] = hz;
    } else if (s === SHOT.chase) {
      // ORBIT
      // eased half turn round the head, from ahead to above and behind
      const vx = f.vx[0];
      const vy = f.vy[0];
      const vz = f.vz[0];
      const v = Math.hypot(vx, vy, vz) || 1;
      const ux = vx / v;
      const uy = vy / v;
      const uz = vz / v;
      let sx = uz * this.orbit;
      let sz = -ux * this.orbit;
      const sl = Math.hypot(sx, sz) || 1;
      sx /= sl;
      sz /= sl;
      let px = -sz * uy;
      let py = sz * ux - sx * uz;
      let pz = sx * uy;
      const pl = Math.hypot(px, py, pz) || 1;
      px /= pl;
      py /= pl;
      pz /= pl;
      if (py < 0) {
        px = -px;
        py = -py;
        pz = -pz;
      }
      const k0 = Math.min(1, this.tShot / CHASE_REAL_S);
      const k = k0 * k0 * (3 - 2 * k0);
      const th = 1.1 + (-1.35 - 1.1) * k;
      const el = 0.45 - 0.1 * k;
      const ce = Math.cos(el) * ORBIT_KM;
      const se = Math.sin(el) * ORBIT_KM;
      this.eye[0] = hx + (sx * Math.cos(th) + ux * Math.sin(th)) * ce + px * se;
      this.eye[1] = hy + uy * Math.sin(th) * ce + py * se;
      this.eye[2] = hz + (sz * Math.cos(th) + uz * Math.sin(th)) * ce + pz * se;
      this.eyeGoal.set(this.eye);
      this.look[0] = this.goal[0] = hx;
      this.look[1] = this.goal[1] = hy;
      this.look[2] = this.goal[2] = hz;
    } else {
      this.eyeGoal.set(HILL);
      this.eyeGoal[0] += 1.2;
      const follow = fc.out === OUT.skip && f.alive[0];
      this.goal[0] = follow ? hx + 10 : fc.end[0] + 5;
      this.goal[1] = follow ? hy : fc.end[1] + 1;
      this.goal[2] = PATH_Z_KM;
    }

    // EASE
    const snap = this.tShot === dt || this.cut || this.tShot <= dt;
    const kl = snap ? 1 : 1 - Math.exp(-dt / LOOK_TAU_S[s]);
    const ke = snap ? 1 : 1 - Math.exp(-dt / (s === SHOT.chase ? 0.0001 : 1.2));
    for (let i = 0; i < 3; i++) {
      this.look[i] += (this.goal[i] - this.look[i]) * kl;
      this.eye[i] += (this.eyeGoal[i] - this.eye[i]) * ke;
    }
    const kf = snap ? 1 : 1 - Math.exp(-dt / 0.6);
    this.fov += (fov - this.fov) * kf;
    const rollGoal = s === SHOT.low ? 0.03 * this.orbit : 0;
    this.roll += (rollGoal - this.roll) * (snap ? 1 : kf);

    // HANDHELD, SHAKE
    const w = this.wall;
    this.hand += ((busy ? 1 : 0) - this.hand) * (1 - Math.exp(-dt / 1.5));
    if (!busy && this.hand < 0.01) this.hand = 0;
    const hand = HAND_RAD[s] * this.hand;
    let yaw = hand * (Math.sin(w * 0.71) + 0.6 * Math.sin(w * 1.37 + 1.3));
    let pitch = hand * (Math.sin(w * 0.53 + 2.1) + 0.5 * Math.sin(w * 1.91));
    if (this.shake > 0.001) {
      const a = SHAKE_RAD * this.shake;
      yaw += a * Math.sin(w * 61) * Math.sin(w * 23);
      pitch += a * Math.sin(w * 47 + 1) * Math.cos(w * 19);
      this.shake *= Math.exp(-dt / (SHAKE_S * 0.35));
    } else this.shake = 0;

    // BASIS
    let fx = this.look[0] - this.eye[0];
    let fy2 = this.look[1] - this.eye[1];
    let fz = this.look[2] - this.eye[2];
    const fl = Math.hypot(fx, fy2, fz) || 1;
    fx /= fl;
    fy2 /= fl;
    fz /= fl;
    fx += -fz * yaw;
    fz += fx * yaw;
    fy2 += pitch;
    const fl2 = Math.hypot(fx, fy2, fz) || 1;
    fx /= fl2;
    fy2 /= fl2;
    fz /= fl2;
    let rx = -fz;
    let rz = fx;
    const rl = Math.hypot(rx, rz) || 1;
    rx /= rl;
    rz /= rl;
    let ux = -rz * fy2;
    let uy = rz * fx - rx * fz;
    let uz = rx * fy2;
    const cr = Math.cos(this.roll);
    const sr = Math.sin(this.roll);
    const r0 = rx * cr + ux * sr;
    const r1 = uy * sr;
    const r2 = rz * cr + uz * sr;
    ux = ux * cr - rx * sr;
    uy = uy * cr;
    uz = uz * cr - rz * sr;
    this.fwd[0] = fx;
    this.fwd[1] = fy2;
    this.fwd[2] = fz;
    this.right[0] = r0;
    this.right[1] = r1;
    this.right[2] = r2;
    this.up[0] = ux;
    this.up[1] = uy;
    this.up[2] = uz;

    // LENS
    // portrait keeps a minimum horizontal fov
    const tv = Math.tan((this.fov * Math.PI) / 360);
    this.tanHalf = Math.max(tv, (tv * 0.82) / Math.max(0.3, aspect));
    this.shift[0] = 0;
    this.shift[1] = fy;
    for (let i = 0; i < 3; i++) this.vel[i] = dt > 0 ? (this.eye[i] - this.prevEye[i]) / dt : 0;
    if (this.cut || snap) this.vel.fill(0);
  }

  settled() {
    return this.shake === 0 && this.hand === 0;
  }
}
