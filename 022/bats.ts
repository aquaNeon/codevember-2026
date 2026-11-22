import { frame, sample, type Frame, type Tunnel } from "./tunnel";

// WING
// half a wing in its own plane: x along the span, z forward. the shader draws it from these
export const WING = {
  BODY: 0.07, // where the wing leaves the body
  WRIST: 0.42,
  POLY: [
    [0.06, 0.05],
    [0.4, 0.17],
    [0.98, 0.03],
    [0.85, -0.33],
    [0.61, -0.5],
    [0.35, -0.46],
    [0.09, -0.3],
  ],
  // trailing edges that sag in between the finger tips
  SCALLOP_EDGES: [2, 3, 4, 5],
  SAG: 0.2,
  FINGERS: [2, 3, 4, 5],
  THUMB: [0.45, 0.25],
};

// circles that cut each scallop: centre x, z and radius
export function scallops() {
  const out: number[][] = [];
  const P = WING.POLY;
  for (const e of WING.SCALLOP_EDGES) {
    const a = P[e];
    const b = P[(e + 1) % P.length];
    const mx = (a[0] + b[0]) / 2;
    const mz = (a[1] + b[1]) / 2;
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l = Math.hypot(dx, dz);
    const h = l * WING.SAG;
    const rho = (l * l) / 4 / (2 * h) + h / 2;
    // the walk is clockwise, so outward is to its left
    const nx = -dz / l;
    const nz = dx / l;
    out.push([mx + nx * (rho - h), mz + nz * (rho - h), rho]);
  }
  return out;
}

// GRID
// a flat sheet over the whole bat, bent by the flap in the vertex shader
export function sheet() {
  const NX = 33;
  const NZ = 10;
  const Z0 = -0.56;
  const Z1 = 0.3;
  const position = new Float32Array(NX * NZ * 3);
  const index = new Uint16Array((NX - 1) * (NZ - 1) * 6);
  for (let j = 0; j < NZ; j++) {
    for (let i = 0; i < NX; i++) {
      const o = (j * NX + i) * 3;
      // denser near the body and wrist joints, where the sheet bends most
      const u = (i / (NX - 1)) * 2 - 1;
      position[o] = u;
      position[o + 2] = Z0 + ((Z1 - Z0) * j) / (NZ - 1);
    }
  }
  let k = 0;
  for (let j = 0; j < NZ - 1; j++) {
    for (let i = 0; i < NX - 1; i++) {
      const a = j * NX + i;
      index[k++] = a;
      index[k++] = a + NX;
      index[k++] = a + 1;
      index[k++] = a + 1;
      index[k++] = a + NX;
      index[k++] = a + NX + 1;
    }
  }
  return { position, index };
}

// FLOCK
// bats live in tunnel coordinates (distance along, side, up) so their paths bend with the cave
const Kind = { Cross: 0, Pass: 1, Drop: 2 } as const;
type KindT = (typeof Kind)[keyof typeof Kind];

type Bat = {
  on: boolean;
  wait: number;
  kind: KindT;
  age: number;
  s: number;
  x: number;
  y: number;
  vs: number;
  vx: number;
  vy: number;
  phase: number;
  hz: number;
  fold: number;
  size: number;
  seed: number;
};

export const FLOCK = {
  COUNT: 7,
  DROP_S: 0.42, // free fall before the wings open
  GRAVITY_M_S2: 7,
};

export class Flock {
  readonly bats: Bat[] = [];
  readonly out = new Float32Array(FLOCK.COUNT * 9);
  private f: Frame = frame();
  private rand: () => number;

  constructor(
    private t: Tunnel,
    seed = 7,
  ) {
    let a = seed | 0;
    this.rand = () => {
      a = (a + 0x6d2b79f5) | 0;
      let r = Math.imul(a ^ (a >>> 15), 1 | a);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = 0; i < FLOCK.COUNT; i++) {
      this.bats.push({
        on: false,
        wait: 0.4 + i * 0.9,
        kind: Kind.Cross,
        age: 0,
        s: 0,
        x: 0,
        y: 0,
        vs: 0,
        vx: 0,
        vy: 0,
        phase: 0,
        hz: 6,
        fold: 0,
        size: 1,
        seed: 0,
      });
    }
  }

  private spawn(b: Bat, camS: number) {
    const r = this.rand;
    const f = this.f;
    const roll = r();
    b.kind = roll < 0.42 ? Kind.Cross : roll < 0.74 ? Kind.Pass : Kind.Drop;
    b.age = 0;
    b.seed = r();
    b.size = 0.4 + r() * 0.14;
    b.phase = r() * 6.28;
    b.fold = 0;
    if (b.kind === Kind.Cross) {
      b.s = camS + 8 + r() * 12;
      sample(this.t, b.s, f);
      const dir = r() < 0.5 ? -1 : 1;
      b.x = -dir * f.rw * 0.85;
      b.y = (0.1 + r() * 0.45) * f.rh;
      b.vx = dir * (2.6 + r() * 1.4);
      b.vy = (r() - 0.6) * 0.5;
      b.vs = (r() - 0.5) * 2.2;
      b.hz = 6.5 + r() * 2;
    } else if (b.kind === Kind.Pass) {
      b.s = camS + 22 + r() * 8;
      sample(this.t, b.s, f);
      const side = r() < 0.5 ? -1 : 1;
      b.x = side * f.rw * (0.4 + r() * 0.2);
      b.y = (0.3 + r() * 0.25) * f.rh;
      b.vx = -side * 0.15;
      b.vy = -0.1;
      b.vs = -(2.8 + r() * 1.6);
      b.hz = 5.5 + r() * 1.5;
    } else {
      b.s = camS + 9 + r() * 7;
      sample(this.t, b.s, f);
      const side = r() < 0.5 ? -1 : 1;
      b.x = side * f.rw * (0.4 + r() * 0.3);
      b.y = f.rh * 0.62 + f.ch * 1.2;
      b.vx = side * 0.3;
      b.vy = 0;
      b.vs = 0;
      b.fold = 1;
      b.hz = 7 + r() * 1.5;
    }
    b.on = true;
  }

  // writes every bat's pose into out; a parked bat gets scale 0
  step(dt: number, camS: number) {
    const f = this.f;
    for (let i = 0; i < this.bats.length; i++) {
      const b = this.bats[i];
      const o = i * 9;
      if (!b.on) {
        b.wait -= dt;
        if (b.wait <= 0) this.spawn(b, camS);
        else {
          this.out[o + 6] = 0;
          continue;
        }
      }
      b.age += dt;
      if (b.kind === Kind.Drop) {
        if (b.age < FLOCK.DROP_S) {
          b.vy -= FLOCK.GRAVITY_M_S2 * dt;
          b.fold = 1 - b.age / FLOCK.DROP_S;
        } else {
          // pull out of the dive and swoop away down the tunnel
          const k = 1 - Math.exp(-dt / 0.35);
          b.vy += (0.5 - b.vy) * k;
          b.vs += (3.4 - b.vs) * k;
          b.fold = 0;
        }
      }
      b.s += b.vs * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.phase += dt * b.hz * 6.2832;
      sample(this.t, b.s, f);
      const wob = Math.sin(b.age * 2.3 + b.seed * 9) * 0.18;
      const bob = Math.sin(b.phase) * 0.035 + Math.sin(b.age * 1.7 + b.seed * 5) * 0.12;
      const lx = Math.max(-f.rw * 0.85, Math.min(f.rw * 0.85, b.x + wob));
      const ly = Math.max(-f.rh * 0.3, Math.min(f.rh * 0.75 + f.ch * 1.2, b.y + bob));
      for (let a = 0; a < 3; a++) {
        this.out[o + a] = f.c[a] + f.s[a] * lx + f.u[a] * ly;
        this.out[o + 3 + a] = f.t[a] * b.vs + f.s[a] * b.vx + f.u[a] * b.vy;
      }
      this.out[o + 6] = b.size;
      this.out[o + 7] = b.phase;
      this.out[o + 8] = b.fold;
      const rel = b.s - camS;
      const gone =
        rel < -1.5 ||
        b.age > 9 ||
        (b.kind === Kind.Cross && Math.abs(b.x) > f.rw * 0.9 && b.age > 0.6);
      if (gone) {
        b.on = false;
        b.wait = 0.3 + this.rand() * 2.2;
      }
    }
  }
}
