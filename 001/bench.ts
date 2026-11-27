// BENCH
// height field: board top at 0, rounded-box sdf smoothstep down to the worktop
export const BENCH = { hw: 2.95, hd: 1.95, r: 0.3, drop: 0.13, edge: 0.14 };

export function benchY(x: number, z: number) {
  const { hw, hd, r, drop, edge } = BENCH;
  const qx = Math.abs(x) - (hw - r),
    qz = Math.abs(z) - (hd - r);
  const ox = qx > 0 ? qx : 0,
    oz = qz > 0 ? qz : 0;
  const d = Math.sqrt(ox * ox + oz * oz) + Math.min(Math.max(qx, qz), 0) - r;
  if (d <= -0.03) return 0;
  const t = Math.min(1, (d + 0.03) / edge);
  return -drop * t * t * (3 - 2 * t);
}
