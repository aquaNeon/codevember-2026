import { build, HALF_LANE, R_CENTRE, R_OUT } from "./path";

const SIZE_PX = 720;
const WALL = 0.16;

// STILL
// flat drawing fallback without webgl
export function still() {
  const c = document.createElement("canvas");
  c.width = c.height = SIZE_PX;
  const g = c.getContext("2d");
  if (!g) return c;
  const p = build();
  const k = SIZE_PX / (2 * (R_OUT + 1.6));
  g.translate(SIZE_PX / 2, SIZE_PX / 2);
  g.scale(k, -k);
  const ink = "#b5aa98";
  const sand = "#ece6db";
  g.fillStyle = "#ddd5c7";
  g.beginPath();
  g.arc(0, 0, R_OUT, 0, Math.PI * 2);
  g.fill();
  const trace = (from: number, to: number) => {
    g.beginPath();
    g.moveTo(p.x[from], p.y[from]);
    for (let i = from + 1; i < to; i++) g.lineTo(p.x[i], p.y[i]);
    g.stroke();
  };
  g.lineJoin = "round";
  g.strokeStyle = ink;
  g.lineWidth = HALF_LANE * 2;
  trace(0, p.spiral);
  g.strokeStyle = sand;
  g.lineWidth = HALF_LANE * 2 - WALL;
  trace(0, p.spiral);
  g.fillStyle = sand;
  g.beginPath();
  g.arc(0, 0, R_CENTRE - WALL / 2, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = ink;
  g.lineWidth = WALL / 2;
  trace(p.spiral - 20, p.n);
  return c;
}
