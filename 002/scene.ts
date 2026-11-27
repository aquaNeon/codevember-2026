// DROP
// 1 unit = 5 mm (bulb radius); origin at the bulb centre, tail along local -x
export const DROP = {
  STRETCH: 1.08,
  JOIN_X: -0.55,
  TAIL_U: 7.6,
  NECK_R: 0.5,
  TIP_R: 0.018,
  TAPER: 4.2,
  CURL: 0.9,
  YAW_DEG: 28,
  AT: [0.9, 0, 0.6] as const,
};
export const TIP_X = DROP.JOIN_X - DROP.TAIL_U;

// TAIL
// out = radius, centreline y, z at u (0 neck, 1 tip)
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
// front at 0.3 units/us (1.5 km/s); run slowed, held at the bulb, blast at real speed
export const FRONT_UPS = 0.3;
export const SLOW = { runS: 2.4, holdS: 0.034, blastS: 4.2, playRunS: 0.2 };
export const END_S = SLOW.runS + SLOW.holdS + SLOW.blastS;

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
// softbox up left, swayed by the pointer
export const KEY = { dir: [-0.5, 0.78, 0.38], sway: 0.28, tauS: 0.35 };

export const MEND_AFTER_MS = 6000;
export const MEND_RATE = 1.4;
export const DUST = { fine: 22000, chips: 2200 };
export const SMOKE = { puffs: 900, motes: 7000, fadeS: [0.9, 3.9] as const };
export const BLAST = { g: 130, skidS: 0.08 };
