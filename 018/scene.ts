// SCENE
// metres; the wall is the plane z = 0, the camera looks straight at it

// SUN
// light travel direction, from behind the viewer, high right
const n = Math.hypot(-0.42, -0.5, -0.76);
export const SUN = [-0.42 / n, -0.5 / n, -0.76 / n] as const;

export const SCENE = {
  fovDeg: 30,
  fitH: 3.0,
  fitW: 2.1,
  crystalZ: 0.78,
  restY: 0.5,
  length: 2.4,
  ior: 1.544,
  spread: 0.05, // change dispersion here, real quartz is ~0.015
};

// SHAFTS
// bands across the slope in metres: from, to, penumbra, strength
export const SHAFTS = {
  slope: [0.42, 1] as const,
  bands: [
    [-1.38, -0.2, 0.09, 1],
    [0.5, 0.74, 0.12, 0.5],
  ] as const,
  upright: [1.72, 2.06, 0.05, 0.9] as const,
};

// SUNLIT
// baked wall light, without waver and plaster
export function sunlit(x: number, y: number) {
  const sl = Math.hypot(SHAFTS.slope[0], SHAFTS.slope[1]);
  const u = (x * SHAFTS.slope[1] - y * SHAFTS.slope[0]) / sl;
  const v = (x * SHAFTS.slope[0] + y * SHAFTS.slope[1]) / sl;
  const pen = 1 + 0.6 * step(1.5, -2, v);
  let lit = 0;
  const bs = SHAFTS.bands;
  for (let i = 0; i < bs.length; i++) lit += bs[i][3] * band(u, bs[i][0], bs[i][1], bs[i][2] * pen);
  const up = SHAFTS.upright;
  lit += up[3] * band(x, up[0], up[1], up[2]);
  return Math.min(1, lit);
}

function band(u: number, a: number, b: number, s: number) {
  return step(a - s, a + s, u) * (1 - step(b - s, b + s, u));
}

function step(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
