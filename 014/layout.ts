// INSTRUMENT
// millimetres; shared by renderer, input and the still so all agree on string positions
export const W_U = 520;
export const H_U = 800;
export const COUNT = 7;
export const X0_U = 104;
export const DX_U = 52;
export const CURVE_U = 250;
const CURVE_POW = 1.7;

export const RAIL_DY_U = 90;
export const KNOB_DY_U = 46;
export const NUT_DY_U = 106;
export const KNOB_R_U = 15;
export const BRIDGE_Y_U = 668;
export const HITCH_Y_U = 748;
export const BOARD = { l: 48, r: 472, dTop: RAIL_DY_U, b: 708, rad: 16 } as const;
export const HOLE = { x: 260, y: 478, r: 40 } as const;

export const MARGIN = { x: 70, top: 40, bottom: 110 } as const;
export const BOX_W_U = W_U + 2 * MARGIN.x;
export const BOX_H_U = H_U + MARGIN.top + MARGIN.bottom;

export const shoulder = (x: number) =>
  CURVE_U * Math.pow(Math.min(1, Math.max(0, x / W_U)), CURVE_POW);

// TUNING
// g major pentatonic, low on the left, so any strum is consonant
const NOTES_HZ = [146.83, 164.81, 196.0, 220.0, 246.94, 293.66, 329.63];
const TENSION_N = [64, 68, 72, 62, 66, 70, 68];
const WIDTH_U = [2.9, 2.55, 2.25, 1.75, 1.6, 1.5, 1.4];
const WOUND = 3;
export const T_RANGE = [0.5, 1.7] as const;

// SPEC
// SI: len m, mu kg/m, t0 N; t60 = seconds to fall 60 dB
export type Spec = {
  x: number;
  nut: number;
  bridge: number;
  len: number;
  mu: number;
  t0: number;
  f0: number;
  wound: boolean;
  width: number;
  t60: number;
  pan: number;
};

export const STRINGS: Spec[] = NOTES_HZ.map((f0, i) => {
  const x = X0_U + i * DX_U;
  const nut = shoulder(x) + NUT_DY_U;
  const len = (BRIDGE_Y_U - nut) / 1000;
  const t0 = TENSION_N[i];
  return {
    x,
    nut,
    bridge: BRIDGE_Y_U,
    len,
    mu: t0 / (2 * len * f0) ** 2,
    t0,
    f0,
    wound: i < WOUND,
    width: WIDTH_U[i],
    t60: 4.2 - i * 0.22,
    pan: (i / (COUNT - 1) - 0.5) * 0.7,
  };
});

// MERSENNE'S LAW
// f = (1 / 2L) sqrt(T / mu)
export const hz = (s: Spec, t: number) => Math.sqrt(t / s.mu) / (2 * s.len);

export const turn = (s: Spec, t: number) => (t / s.t0 - 1) * Math.PI * 1.4;

// PLACEMENT
// keep in step with the .still rules in index.html
export type Place = { s: number; ox: number; oy: number };

export function place(w: number, h: number, out: Place) {
  const phone = w <= 640;
  const padT = phone ? 172 : 76;
  const padB = phone ? 132 : 60;
  const side = phone ? 16 : 36;
  const cx = phone ? 0.5 : 0.6;
  const availH = h - padT - padB;
  const availW = 2 * Math.min(cx, 1 - cx) * w - 2 * side;
  const s = Math.max(0.05, Math.min(availH / H_U, availW / W_U));
  out.s = s;
  out.ox = w * cx - (s * W_U) / 2;
  out.oy = padT + availH / 2 - (s * H_U) / 2;
  return out;
}
