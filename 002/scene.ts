// DROP
// scene units: 1 = 5 mm, the bulb's radius. the drop lies on its side on a studio sweep,
// bulb resting on the floor (y = 0), tail drooping back to it. the bulb's centre is the
// local origin; the tail runs out along local -x
export const DROP = {
  STRETCH: 1.08, // the bulb, a little longer than wide
  JOIN_X: -0.55, // where the tail leaves the bulb
  TAIL_U: 7.6, // tail length
  NECK_R: 0.5, // tail radius at the neck
  TIP_R: 0.018,
  TAPER: 4.2,
  CURL: 0.9, // how far the tail curls sideways
  YAW_DEG: 28, // the drop turned on the floor, tail back and to the left
  AT: [0.9, 0, 0.6] as const, // bulb centre on the floor, x z
};
export const TIP_X = DROP.JOIN_X - DROP.TAIL_U;

// tail radius and centreline offset (local y, z) at u, 0 at the neck, 1 at the tip
export function tail(u: number, out: number[]) {
  const r =
    DROP.TIP_R + (DROP.NECK_R - DROP.TIP_R) * Math.exp(-u * DROP.TAPER) * Math.pow(1 - u, 0.3);
  const k = Math.min(1, Math.max(0, u / 0.55));
  const droop = k * k * (3 - 2 * k);
  out[0] = r;
  out[1] = (r - 1) * droop;
  out[2] = DROP.CURL * Math.sin(u * 2.4) * u;
  return out;
}

// PHYSICS
// the fracture front's speed, and how scene time maps to real time: the front's run up
// the drop in extreme slow motion, a beat held at the moment it reaches the far side of
// the bulb, then the detonation at real speed
export const FRONT_UPS = 0.3; // units per microsecond: 1.5 km/s
// the front's run is scrubbed slowly but played in a flash, PLAY_RUN_S long
export const SLOW = { runS: 2.4, holdS: 0.034, blastS: 4.2, playRunS: 0.2 }; // hold: two frames
export const END_S = SLOW.runS + SLOW.holdS + SLOW.blastS;

// scene seconds to physical seconds, for a front that takes endUs to cross the drop
export function phys(s: number, endUs: number) {
  if (s <= 0) return 0;
  if (s < SLOW.runS) return (s / SLOW.runS) * endUs * 1e-6;
  return endUs * 1e-6 + Math.max(0, s - SLOW.runS - SLOW.holdS);
}

// FRAMING
export const VIEW = {
  wide: { eye: [1.3, 4.7, 9.7], at: [-0.95, 0.42, -0.65], fovDeg: 36 },
  tall: { eye: [5.9, 12.8, 4.9], at: [-0.55, 0.2, 0.15], fovDeg: 51 },
  wideAspect: 1.5,
  tallAspect: 0.5,
} as const;

// LIGHT
// a big softbox up and to the left, moved a little by the pointer
export const KEY = { dir: [-0.5, 0.78, 0.38], sway: 0.28, tauS: 0.35 };

export const MEND_AFTER_MS = 6000; // quiet before the drop reforms
export const MEND_RATE = 1.4;
export const DUST = { fine: 22000, chips: 2200 };
export const SMOKE = { puffs: 900, motes: 7000, fadeS: [0.9, 3.9] as const };
export const BLAST = { g: 130, skidS: 0.08 }; // designed gravity, units/s²; how long chips skid
