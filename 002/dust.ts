import { BLAST, DROP, DUST, SMOKE, TIP_X, tail } from "./scene";

export const DUST_STRIDE = 11; // start xyz, velocity xyz, local x, drag time, size, seed, landing time
const YAW = (DROP.YAW_DEG * Math.PI) / 180;
const C = Math.cos(YAW);
const S = Math.sin(YAW);
const tmp = [0, 0, 0];

// local drop frame to world
export function world(lx: number, ly: number, lz: number, out: number[]) {
  out[0] = DROP.AT[0] + C * lx - S * lz;
  out[1] = 1 + ly;
  out[2] = DROP.AT[2] + S * lx + C * lz;
  return out;
}

// DUST
// where every grain starts, inside the drop, and how it flies when the bulb detonates:
// a hard blast away from the tail, quick drag, a fall, a skid. when it lands is solved
// here once, so the vertex shader can place any grain at any moment in closed form
export function dust(rnd: () => number) {
  const n = DUST.fine + DUST.chips;
  const out = new Float32Array(n * DUST_STRIDE);
  const p = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const chip = i >= DUST.fine;
    let lx: number;
    let ly: number;
    let lz: number;
    let dx: number;
    let dy: number;
    let dz: number;
    let speed: number;
    const inTail = rnd() < 0.22;
    if (inTail) {
      // the tail goes to powder where it lies, a puff outward
      const u = Math.pow(rnd(), 1.6);
      tail(u, tmp);
      const a = rnd() * Math.PI * 2;
      const rr = tmp[0] * Math.sqrt(rnd());
      lx = DROP.JOIN_X - u * DROP.TAIL_U;
      ly = tmp[1] + Math.cos(a) * rr;
      lz = tmp[2] + Math.sin(a) * rr;
      dx = (rnd() - 0.5) * 0.6;
      dy = Math.cos(a) + 0.6;
      dz = Math.sin(a);
      speed = 2 + rnd() * 5;
    } else {
      for (;;) {
        lx = (rnd() * 2 - 1) * DROP.STRETCH;
        ly = rnd() * 2 - 1;
        lz = rnd() * 2 - 1;
        if ((lx / DROP.STRETCH) ** 2 + ly * ly + lz * lz < 1) break;
      }
      // a cone off the far side of the bulb, opened wide, lifted a little, thrown back
      // across the floor away from the viewer
      dx = 0.55 + lx * 0.35 + (rnd() - 0.5) * 1.2;
      dy = 0.35 + ly * 0.4 + (rnd() - 0.5) * 0.7;
      dz = lz * 0.35 + (rnd() - 0.5) * 1.2;
      speed = chip ? 9 + rnd() * 13 : 16 + rnd() * 30;
    }
    const sl = Math.hypot(dx, dy, dz) || 1;
    world(lx, ly, lz, p);
    let vx = ((C * dx - S * dz) / sl) * speed;
    const vy = (dy / sl) * speed;
    let vz = ((S * dx + C * dz) / sl) * speed;
    if (!inTail) {
      // turned in world space toward the back of the studio
      vz -= speed * 0.7;
      vx *= 0.6;
    }
    const tau = chip ? 0.08 + rnd() * 0.08 : 0.028 + rnd() * 0.032;
    const size = chip ? 0.016 + rnd() * 0.022 : 0.006 + rnd() * 0.012;
    // LANDING
    // first time the grain comes down to rest height, by stepping then halving
    const rest = size * 0.35;
    const y = (t: number) =>
      p[1] + (vy + BLAST.g * tau) * tau * (1 - Math.exp(-t / tau)) - BLAST.g * tau * t;
    let a = 0;
    let b = 0.01;
    while (b < 4 && y(b) > rest) {
      a = b;
      b += 0.01;
    }
    for (let k = 0; k < 20; k++) {
      const m = (a + b) / 2;
      if (y(m) > rest) a = m;
      else b = m;
    }
    const o = i * DUST_STRIDE;
    out[o] = p[0];
    out[o + 1] = p[1];
    out[o + 2] = p[2];
    out[o + 3] = vx;
    out[o + 4] = vy;
    out[o + 5] = vz;
    out[o + 6] = Math.max(lx, TIP_X);
    out[o + 7] = tau;
    out[o + 8] = size;
    out[o + 9] = rnd();
    out[o + 10] = b;
  }
  return out;
}

// SMOKE
// the finest glass dust: soft puffs that billow and hang, and motes that glint in them.
// thrown out gently, slowed fast; the drift itself is curl noise in time, in the shader
export const SMOKE_STRIDE = 9; // start xyz, velocity xyz, seed, size, kind (0 puff, 1 mote)
export function smoke(rnd: () => number) {
  const n = SMOKE.puffs + SMOKE.motes;
  const out = new Float32Array(n * SMOKE_STRIDE);
  const p = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const puff = i < SMOKE.puffs;
    let lx: number;
    let ly: number;
    let lz: number;
    if (rnd() < 0.15) {
      // some rises off the tail as it goes too
      const u = rnd();
      tail(u, tmp);
      lx = DROP.JOIN_X - u * DROP.TAIL_U;
      ly = tmp[1];
      lz = tmp[2];
      world(lx, ly, lz, p);
    } else {
      for (;;) {
        lx = (rnd() * 2 - 1) * DROP.STRETCH;
        ly = rnd() * 2 - 1;
        lz = rnd() * 2 - 1;
        if ((lx / DROP.STRETCH) ** 2 + ly * ly + lz * lz < 1) break;
      }
      world(lx * 0.8, ly * 0.8, lz * 0.8, p);
    }
    const dx = lx + 0.4 + (rnd() - 0.5) * 0.8;
    const dy = ly + 0.5 + (rnd() - 0.5) * 0.6;
    const dz = lz + (rnd() - 0.5) * 0.8;
    const sl = Math.hypot(dx, dy, dz) || 1;
    const speed = (puff ? 2 : 3) + rnd() * 5;
    const o = i * SMOKE_STRIDE;
    out[o] = p[0];
    out[o + 1] = p[1];
    out[o + 2] = p[2];
    out[o + 3] = ((C * dx - S * dz) / sl) * speed;
    out[o + 4] = (dy / sl) * speed;
    out[o + 5] = ((S * dx + C * dz) / sl) * speed - speed * 0.4;
    out[o + 6] = rnd();
    out[o + 7] = puff ? 0.22 + rnd() * 0.4 : 0.004 + rnd() * 0.006;
    out[o + 8] = puff ? 0 : 1;
  }
  return out;
}

// the bulb or the tail under a local point, for picking: 1 bulb, 2 tail, 0 neither
export function part(lx: number, ly: number, lz: number) {
  if ((lx / DROP.STRETCH) ** 2 + ly * ly + lz * lz < 1.1) return 1;
  if (lx > DROP.JOIN_X || lx < TIP_X - 0.2) return 0;
  const u = (DROP.JOIN_X - lx) / DROP.TAIL_U;
  tail(Math.min(u, 1), tmp);
  const d = Math.hypot(ly - tmp[1], lz - tmp[2]);
  return d < tmp[0] + 0.4 ? 2 : 0; // generous: the tail is a thin target for a finger
}

// seeded, so the powder flies the same way every time
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
