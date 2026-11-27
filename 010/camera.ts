// CAMERA
// shared with sketch.ts; portrait steps back and up to fit the wall
const EYE_WIDE = [0.2, 1.15, 6.0] as const;
const AIM_WIDE = [0.2, 1.5, 0.3] as const;
const FOCAL_WIDE = 3.0;
const EYE_TALL = [0.15, 1.9, 4.8] as const;
const FOCAL_TALL = 1.5;
const AIM_TALL = [0.15, 0.95, 0.5] as const;

export type Camera = {
  eye: Float32Array;
  fwd: Float32Array;
  right: Float32Array;
  up: Float32Array;
  focal: number;
};

export const camera = (): Camera => ({
  eye: new Float32Array(3),
  fwd: new Float32Array(3),
  right: new Float32Array(3),
  up: new Float32Array(3),
  focal: FOCAL_WIDE,
});

export function aim(c: Camera, aspect: number) {
  const wide = Math.min(1, Math.max(0, (aspect - 0.5) / 0.9));
  const { eye: e, fwd: f, right: r, up: u } = c;
  for (let i = 0; i < 3; i++) {
    e[i] = EYE_TALL[i] + (EYE_WIDE[i] - EYE_TALL[i]) * wide;
    f[i] = AIM_TALL[i] + (AIM_WIDE[i] - AIM_TALL[i]) * wide - e[i];
  }
  norm(f);
  r[0] = -f[2];
  r[1] = 0;
  r[2] = f[0];
  norm(r);
  u[0] = r[1] * f[2] - r[2] * f[1];
  u[1] = r[2] * f[0] - r[0] * f[2];
  u[2] = r[0] * f[1] - r[1] * f[0];
  c.focal = Math.min(FOCAL_WIDE, Math.max(FOCAL_TALL, aspect * 2.3));
}

export function project(c: Camera, x: number, y: number, z: number, w: number, h: number) {
  const dx = x - c.eye[0];
  const dy = y - c.eye[1];
  const dz = z - c.eye[2];
  const d = dx * c.fwd[0] + dy * c.fwd[1] + dz * c.fwd[2];
  const half = h / 2;
  const sx = ((dx * c.right[0] + dy * c.right[1] + dz * c.right[2]) / d) * c.focal;
  const sy = ((dx * c.up[0] + dy * c.up[1] + dz * c.up[2]) / d) * c.focal;
  return [w / 2 + sx * half, half - sy * half, d] as const;
}

function norm(v: Float32Array) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  v[0] /= l;
  v[1] /= l;
  v[2] /= l;
}
