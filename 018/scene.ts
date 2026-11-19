// SCENE
// world in metres-ish: the wall is the plane z = 0, the camera looks straight at it

const n = Math.hypot(-0.42, -0.5, -0.76);
// direction the sunlight travels, from a window behind you, high on the right
export const SUN = [-0.42 / n, -0.5 / n, -0.76 / n] as const;

export const SCENE = {
  fovDeg: 30,
  fitH: 3.0, // wall height always in view
  fitW: 2.1, // wall width always in view, decides on narrow screens
  crystalZ: 0.78, // how far the crystal hangs off the wall
  restY: 0.5, // where the top of the crystal rests
  length: 2.4, // chain, pivot to crystal
  ior: 1.544, // quartz
  spread: 0.05, // red to violet ior gap; real quartz is ~0.015, wider reads better
};

// SHAFTS
// sun through a tall window lands as long soft bands rising to the right. each band is a
// range across the slope, in metres, with its own penumbra and strength
export const SHAFTS = {
  slope: [0.42, 1] as const, // direction a band runs
  bands: [
    [-1.38, -0.2, 0.09, 1],
    [0.5, 0.74, 0.12, 0.5],
  ] as const, // from, to, penumbra, strength
  upright: [1.72, 2.06, 0.05, 0.9] as const, // a narrow vertical band at the far right
};

// how sunlit a wall point is, as the baked wall has it less its waver and plaster
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
