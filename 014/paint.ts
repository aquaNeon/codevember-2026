import {
  BOARD,
  BRIDGE_Y_U,
  H_U,
  HITCH_Y_U,
  HOLE,
  KNOB_DY_U,
  KNOB_R_U,
  NUT_DY_U,
  STRINGS,
  W_U,
  shoulder,
  type Spec,
} from "./layout";

export type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const FRAME_R_U = 38;
const DEPTH_U = 13;

// SHADOW OFFSET
// light from the upper left
export const SHADOW_DX_U = 5;
export const SHADOW_DY_U = 7;

// SHAPES
// top edge follows shoulder()
export function outline(ctx: Ctx, l: number, r: number, dTop: number, b: number, rad: number) {
  const tl = shoulder(l) + dTop;
  const tr = shoulder(r) + dTop;
  ctx.moveTo(l, b - rad);
  ctx.lineTo(l, tl + rad);
  ctx.arcTo(l, tl, l + rad, shoulder(l + rad) + dTop, rad);
  for (let x = l + rad; x < r - rad; x += 6) ctx.lineTo(x, shoulder(x) + dTop);
  ctx.lineTo(r - rad, shoulder(r - rad) + dTop);
  ctx.arcTo(r, tr, r, tr + rad, rad);
  ctx.lineTo(r, b - rad);
  ctx.arcTo(r, b, r - rad, b, rad);
  ctx.lineTo(l + rad, b);
  ctx.arcTo(l, b, l, b - rad, rad);
  ctx.closePath();
}

const frame = (ctx: Ctx, dy = 0) => {
  ctx.beginPath();
  outline(ctx, 0, W_U, dy, H_U + dy, FRAME_R_U);
};
export const board = (ctx: Ctx) => {
  ctx.beginPath();
  outline(ctx, BOARD.l, BOARD.r, BOARD.dTop, BOARD.b, BOARD.rad);
};

function rounded(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function castShadow(
  ctx: Ctx,
  k: number,
  build: () => void,
  color: string,
  blur: number,
  dx: number,
  dy: number,
) {
  ctx.save();
  build();
  ctx.shadowColor = color;
  ctx.shadowBlur = blur * k;
  ctx.shadowOffsetX = dx * k;
  ctx.shadowOffsetY = dy * k;
  ctx.fillStyle = "#1c0f07";
  ctx.fill();
  ctx.restore();
}

// WOOD
// grain lines that flow together through one warp field
function grain(
  ctx: Ctx,
  rnd: () => number,
  n: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  warp: number,
  pick: (r: number) => string,
  wMin: number,
  wMax: number,
) {
  for (let i = 0; i < n; i++) {
    const gx = x0 + rnd() * (x1 - x0);
    const ph = rnd() * 6.28;
    ctx.beginPath();
    for (let y = y0; y <= y1; y += 14) {
      const x =
        gx +
        warp * (Math.sin(y * 0.0042 + gx * 0.011) + 0.45 * Math.sin(y * 0.013 - gx * 0.027 + 1.7)) +
        0.9 * Math.sin(y * 0.05 + ph);
      if (y === y0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = pick(rnd());
    ctx.lineWidth = wMin + rnd() * (wMax - wMin);
    ctx.stroke();
  }
}

// STATIC LAYER
// frame, board, bridges, knobs, dead string lengths; ctx in design units, k = px per unit
export function paintStatic(ctx: Ctx, k: number) {
  const rnd = rng(14);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // FLOOR SHADOW
  castShadow(ctx, k, () => frame(ctx), "rgba(70, 46, 24, 0.26)", 70, 6, 46);
  castShadow(ctx, k, () => frame(ctx), "rgba(48, 30, 14, 0.34)", 16, 2, 18);

  // THICKNESS
  frame(ctx, DEPTH_U);
  const side = ctx.createLinearGradient(0, 0, W_U, 0);
  side.addColorStop(0, "#2a170c");
  side.addColorStop(0.5, "#22130a");
  side.addColorStop(1, "#160c06");
  ctx.fillStyle = side;
  ctx.fill();

  // FACE
  frame(ctx);
  const face = ctx.createLinearGradient(0, 0, W_U * 0.7, H_U);
  face.addColorStop(0, "#6e4a2e");
  face.addColorStop(0.45, "#55361f");
  face.addColorStop(1, "#3b2414");
  ctx.fillStyle = face;
  ctx.fill();
  ctx.save();
  frame(ctx);
  ctx.clip();
  grain(
    ctx,
    rnd,
    340,
    -30,
    W_U + 30,
    -20,
    H_U + 30,
    7,
    (r) =>
      r < 0.72 ? `rgba(28, 14, 6, ${0.08 + r * 0.26})` : `rgba(150, 102, 62, ${(r - 0.7) * 0.5})`,
    0.3,
    2.2,
  );
  // SHEEN
  const sheen = ctx.createLinearGradient(0, 0, W_U, H_U * 0.9);
  sheen.addColorStop(0, "rgba(255, 232, 200, 0.2)");
  sheen.addColorStop(0.28, "rgba(255, 232, 200, 0.03)");
  sheen.addColorStop(0.55, "rgba(255, 232, 200, 0.09)");
  sheen.addColorStop(0.7, "rgba(255, 232, 200, 0)");
  sheen.addColorStop(1, "rgba(0, 0, 0, 0.12)");
  frame(ctx);
  ctx.fillStyle = sheen;
  ctx.fill();
  // BEVEL
  const bevel = ctx.createLinearGradient(0, 0, W_U, H_U);
  bevel.addColorStop(0, "rgba(255, 226, 190, 0.55)");
  bevel.addColorStop(0.5, "rgba(255, 226, 190, 0.12)");
  bevel.addColorStop(1, "rgba(16, 8, 3, 0.5)");
  frame(ctx);
  ctx.strokeStyle = bevel;
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.restore();
  frame(ctx);
  ctx.strokeStyle = "rgba(20, 10, 4, 0.55)";
  ctx.lineWidth = 0.8;
  ctx.stroke();

  // PURFLING
  // a black and maple inlay around the board
  ctx.beginPath();
  outline(ctx, BOARD.l - 11, BOARD.r + 11, BOARD.dTop - 11, BOARD.b + 11, BOARD.rad + 11);
  ctx.strokeStyle = "rgba(18, 9, 4, 0.7)";
  ctx.lineWidth = 2.8;
  ctx.stroke();
  ctx.strokeStyle = "rgba(226, 196, 150, 0.75)";
  ctx.lineWidth = 1.1;
  ctx.stroke();

  // SOUNDBOARD
  board(ctx);
  const top = shoulder(BOARD.l) + BOARD.dTop;
  const spruce = ctx.createLinearGradient(BOARD.l, top, BOARD.r, BOARD.b);
  spruce.addColorStop(0, "#ecd3a1");
  spruce.addColorStop(0.5, "#ddbb82");
  spruce.addColorStop(1, "#c9a165");
  ctx.fillStyle = spruce;
  ctx.fill();
  ctx.save();
  board(ctx);
  ctx.clip();
  grain(
    ctx,
    rnd,
    26,
    BOARD.l,
    BOARD.r,
    top - 10,
    BOARD.b + 10,
    1.8,
    (r) =>
      r < 0.5
        ? `rgba(160, 112, 58, ${0.04 + r * 0.08})`
        : `rgba(255, 240, 210, ${(r - 0.5) * 0.14})`,
    6,
    18,
  );
  grain(
    ctx,
    rnd,
    120,
    BOARD.l,
    BOARD.r,
    top - 10,
    BOARD.b + 10,
    1.8,
    (r) => `rgba(150, 100, 48, ${0.12 + r * 0.3})`,
    0.3,
    1,
  );
  // RAIL SHADOW
  const hole = () => {
    ctx.beginPath();
    ctx.rect(-200, -200, W_U + 400, H_U + 400);
    outline(ctx, BOARD.l, BOARD.r, BOARD.dTop, BOARD.b, BOARD.rad);
  };
  ctx.save();
  hole();
  ctx.shadowColor = "rgba(46, 24, 8, 0.6)";
  ctx.shadowBlur = 9 * k;
  ctx.shadowOffsetX = 4 * k;
  ctx.shadowOffsetY = 6 * k;
  ctx.fillStyle = "#000";
  ctx.fill("evenodd");
  ctx.restore();
  ctx.save();
  hole();
  ctx.shadowColor = "rgba(255, 238, 205, 0.55)";
  ctx.shadowBlur = 1.5 * k;
  ctx.shadowOffsetX = -1.2 * k;
  ctx.shadowOffsetY = -1.2 * k;
  ctx.fillStyle = "#000";
  ctx.fill("evenodd");
  ctx.restore();
  ctx.restore();

  rosette(ctx);
  nut(ctx, k);
  bridge(ctx, k);

  // DEAD LENGTHS AND PINS
  for (const s of STRINGS) {
    const knobY = shoulder(s.x) + KNOB_DY_U;
    deadString(ctx, s, knobY, s.nut - 3);
    deadString(ctx, s, s.bridge + 2, HITCH_Y_U);
    pin(ctx, k, s.x, HITCH_Y_U);
  }
  for (const s of STRINGS) knob(ctx, k, s.x, shoulder(s.x) + KNOB_DY_U);
}

function rosette(ctx: Ctx) {
  const { x, y, r } = HOLE;
  const ring = (rad: number, w: number, c: string) => {
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.strokeStyle = c;
    ctx.lineWidth = w;
    ctx.stroke();
  };
  ring(r + 21, 0.7, "rgba(60, 34, 14, 0.55)");
  ring(r + 16, 5.5, "rgba(58, 32, 14, 0.85)");
  ring(r + 16, 3.2, "rgba(232, 208, 166, 0.95)");
  ctx.fillStyle = "rgba(58, 32, 14, 0.85)";
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(x + Math.cos(a) * (r + 16), y + Math.sin(a) * (r + 16), 0.9, 0, Math.PI * 2);
    ctx.fill();
  }
  ring(r + 9, 0.9, "rgba(60, 34, 14, 0.6)");
  ring(r + 6, 0.6, "rgba(60, 34, 14, 0.45)");
  const g = ctx.createRadialGradient(x + 12, y + 14, 2, x, y, r);
  g.addColorStop(0, "#3d2613");
  g.addColorStop(0.6, "#1c1008");
  g.addColorStop(1, "#0d0603");
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r - 0.8, -0.2, 2.1);
  ctx.strokeStyle = "rgba(240, 212, 162, 0.5)";
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, r + 0.4, 3.3, 5.6);
  ctx.strokeStyle = "rgba(40, 22, 8, 0.5)";
  ctx.lineWidth = 1.2;
  ctx.stroke();
}

const NUT_L_U = STRINGS[0].x - 30;
const NUT_R_U = STRINGS[STRINGS.length - 1].x + 30;

function nutPath(ctx: Ctx, dy: number) {
  ctx.beginPath();
  for (let x = NUT_L_U; x <= NUT_R_U; x += 6) {
    const y = shoulder(x) + NUT_DY_U + dy;
    if (x === NUT_L_U) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
}

function nut(ctx: Ctx, k: number) {
  ctx.save();
  ctx.shadowColor = "rgba(40, 20, 6, 0.5)";
  ctx.shadowBlur = 6 * k;
  ctx.shadowOffsetX = 3 * k;
  ctx.shadowOffsetY = 6 * k;
  nutPath(ctx, 0);
  ctx.strokeStyle = "#1b120d";
  ctx.lineWidth = 10;
  ctx.stroke();
  ctx.restore();
  nutPath(ctx, -2.6);
  ctx.strokeStyle = "rgba(255, 236, 214, 0.16)";
  ctx.lineWidth = 2;
  ctx.stroke();
  nutPath(ctx, 0);
  ctx.strokeStyle = "#9c7538";
  ctx.lineWidth = 2.8;
  ctx.stroke();
  nutPath(ctx, -0.6);
  ctx.strokeStyle = "rgba(255, 236, 180, 0.85)";
  ctx.lineWidth = 0.8;
  ctx.stroke();
}

function bridge(ctx: Ctx, k: number) {
  const x = STRINGS[0].x - 28;
  const w = STRINGS[STRINGS.length - 1].x + 28 - x;
  const y = BRIDGE_Y_U - 7;
  const h = 15;
  ctx.save();
  ctx.shadowColor = "rgba(46, 24, 8, 0.45)";
  ctx.shadowBlur = 8 * k;
  ctx.shadowOffsetX = 3 * k;
  ctx.shadowOffsetY = 7 * k;
  rounded(ctx, x, y, w, h, 3.5);
  const bone = ctx.createLinearGradient(0, y, 0, y + h);
  bone.addColorStop(0, "#f7f0e2");
  bone.addColorStop(0.45, "#e9dcc2");
  bone.addColorStop(1, "#b7a17c");
  ctx.fillStyle = bone;
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.moveTo(x + 3, BRIDGE_Y_U);
  ctx.lineTo(x + w - 3, BRIDGE_Y_U);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.7)";
  ctx.lineWidth = 0.8;
  ctx.stroke();
}

function pin(ctx: Ctx, k: number, x: number, y: number) {
  ctx.save();
  ctx.shadowColor = "rgba(20, 10, 4, 0.55)";
  ctx.shadowBlur = 3 * k;
  ctx.shadowOffsetX = 1.5 * k;
  ctx.shadowOffsetY = 2.5 * k;
  ctx.beginPath();
  ctx.arc(x, y, 4.4, 0, Math.PI * 2);
  const g = ctx.createRadialGradient(x - 1.6, y - 1.8, 0.3, x, y, 4.4);
  g.addColorStop(0, "#fbecc0");
  g.addColorStop(0.45, "#c1964f");
  g.addColorStop(1, "#6a4a1d");
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();
}

function knob(ctx: Ctx, k: number, x: number, y: number) {
  const r = KNOB_R_U;
  ctx.save();
  ctx.shadowColor = "rgba(16, 8, 3, 0.6)";
  ctx.shadowBlur = 7 * k;
  ctx.shadowOffsetX = 3 * k;
  ctx.shadowOffsetY = 5 * k;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  const g = ctx.createRadialGradient(x - r * 0.4, y - r * 0.45, 1, x, y, r);
  g.addColorStop(0, "#5a473b");
  g.addColorStop(0.5, "#231812");
  g.addColorStop(1, "#0d0806");
  ctx.fillStyle = g;
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(x, y, r - 0.9, Math.PI * 0.95, Math.PI * 1.65);
  ctx.strokeStyle = "rgba(255, 238, 220, 0.32)";
  ctx.lineWidth = 1.2;
  ctx.stroke();
  // KNURL
  ctx.strokeStyle = "rgba(255, 238, 220, 0.07)";
  ctx.lineWidth = 0.6;
  for (let i = 0; i < 36; i++) {
    const a = (i / 36) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * (r - 3.5), y + Math.sin(a) * (r - 3.5));
    ctx.lineTo(x + Math.cos(a) * (r - 1.2), y + Math.sin(a) * (r - 1.2));
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(x, y, 5.2, 0, Math.PI * 2);
  const b = ctx.createRadialGradient(x - 1.8, y - 2, 0.4, x, y, 5.2);
  b.addColorStop(0, "#fff1c8");
  b.addColorStop(0.5, "#c39a52");
  b.addColorStop(1, "#5e3f17");
  ctx.fillStyle = b;
  ctx.fill();
}

// STRINGS
// cached strokes per string: a dark edge, a body and a thin highlight on the lit side
export type Look = {
  edge: string;
  body: string | CanvasGradient;
  shine: string | CanvasGradient;
  dash: number[];
};

export function looks(ctx: Ctx): Look[] {
  return STRINGS.map((s) => {
    const body = ctx.createLinearGradient(0, s.nut, 0, s.bridge);
    const shine = ctx.createLinearGradient(0, s.nut, 0, s.bridge);
    if (s.wound) {
      body.addColorStop(0, "#ad7d48");
      body.addColorStop(0.4, "#cf9f62");
      body.addColorStop(1, "#9a6a3a");
      shine.addColorStop(0, "rgba(255, 226, 170, 0.6)");
      shine.addColorStop(0.35, "rgba(255, 236, 196, 0.95)");
      shine.addColorStop(1, "rgba(255, 226, 170, 0.5)");
      return { edge: "#3d250f", body, shine, dash: [0.55, 0.75] };
    }
    body.addColorStop(0, "#8e959c");
    body.addColorStop(0.38, "#c4cad0");
    body.addColorStop(1, "#7d848b");
    shine.addColorStop(0, "rgba(255, 255, 255, 0.55)");
    shine.addColorStop(0.36, "rgba(255, 255, 255, 1)");
    shine.addColorStop(1, "rgba(255, 255, 255, 0.45)");
    return { edge: "#33373c", body, shine, dash: [] };
  });
}

function deadString(ctx: Ctx, s: Spec, y0: number, y1: number) {
  const w = s.width;
  const line = (dx: number) => {
    ctx.beginPath();
    ctx.moveTo(s.x + dx, y0);
    ctx.lineTo(s.x + dx, y1);
  };
  line(SHADOW_DX_U * 0.5);
  ctx.strokeStyle = "rgba(30, 16, 6, 0.28)";
  ctx.lineWidth = w * 1.4;
  ctx.stroke();
  line(0);
  ctx.strokeStyle = s.wound ? "#3d250f" : "#33373c";
  ctx.lineWidth = w;
  ctx.stroke();
  ctx.strokeStyle = s.wound ? "#a67844" : "#a9b0b6";
  ctx.lineWidth = w * 0.6;
  ctx.stroke();
  line(-w * 0.18);
  ctx.strokeStyle = s.wound ? "rgba(255, 226, 170, 0.6)" : "rgba(255, 255, 255, 0.6)";
  ctx.lineWidth = w * 0.26;
  ctx.stroke();
}
