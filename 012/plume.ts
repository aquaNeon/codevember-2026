// PLUME
// the feather is drawn once, barb by barb, into a canvas: a quill, a tapering rachis,
// two vanes of fine curved barbs with a few splits, barring across them, and loose down
// at the base. the scene only ever samples it

export const TEX_W = 512;
export const TEX_H = 1536;
const BARBS = 760; // per side, change for a finer vane
const BASE_V = 0.1; // where the bare quill ends and the vane starts
const DOWN_V = 0.3;
const TIP_V = 0.975; // the vane closes here // down gives way to the firm vane here
const LEFT_W = 0.44; // vane widths, share of the texture width
const RIGHT_W = 0.3;

type Rgb = [number, number, number];

export type Look = {
  base: Rgb;
  bar: Rgb;
  down: Rgb;
  shaft: Rgb;
  bars: number; // dark bands along the feather, 0 for none
};

export const LOOKS: Record<"a" | "b", Look> = {
  // a: warm grey-brown, barred like a hawk's tail covert
  a: {
    base: [164, 128, 96],
    bar: [62, 40, 26],
    down: [226, 218, 206],
    shaft: [236, 226, 206],
    bars: 6.5,
  },
  // b: plain white, a swan's breast feather
  b: {
    base: [238, 234, 226],
    bar: [196, 188, 176],
    down: [252, 250, 246],
    shaft: [250, 246, 236],
    bars: 0,
  },
};

// SEEDED NOISE
// the same feather on every load
let seed = 7;
const rand = () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647;
};

export const rachisX = (v: number) => 0.5 + 0.025 * Math.sin(Math.PI * v);

function vaneWidth(v: number, side: number) {
  const t = Math.min(1, Math.max(0, (v - BASE_V) / (TIP_V - BASE_V)));
  const grow = smooth(0, 0.16, t);
  // closes like an ellipse, so the tip comes out round
  const close = Math.sqrt(Math.max(0, 1 - Math.pow(t, 2.6)));
  return (side < 0 ? LEFT_W : RIGHT_W) * grow * close * (1 - 0.18 * t);
}

function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function mix(a: Rgb, b: Rgb, t: number, alpha: number) {
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgba(${r},${g},${bl},${alpha.toFixed(3)})`;
}

// SPLITS
// where the barbs have come unzipped: barbs just below a split lean toward it
function splits(side: number) {
  const n = 3 + Math.floor(rand() * 3);
  const out: { v: number; w: number; k: number }[] = [];
  for (let i = 0; i < n; i++)
    out.push({
      v: DOWN_V + 0.05 + rand() * 0.6,
      w: 0.025 + rand() * 0.05,
      k: (0.12 + rand() * 0.2) * (side < 0 ? 1 : 1.2),
    });
  return out;
}

// two ways to draw it: in colour for the flat still, or as a mask for the shader, which
// colours it itself. the mask is one stroke per barb, so it costs a fraction of the colour pass.
// mask channels: r brightness (half), g down, b shaft, a coverage
export function drawPlume(look: Look, mask = false) {
  const steps = strokes(look, mask);
  let r = steps.next();
  while (!r.done) r = steps.next();
  return r.value;
}

// the same, a slice at a time, so the page stays responsive while it draws
export async function drawPlumeSoon(look: Look, mask = false) {
  const steps = strokes(look, mask);
  let r = steps.next();
  while (!r.done) {
    await new Promise((done) => setTimeout(done, 0));
    r = steps.next();
  }
  return r.value;
}

const SLICE = 60; // barbs drawn between yields

function* strokes(look: Look, mask: boolean): Generator<void, HTMLCanvasElement> {
  seed = 7;
  const c = document.createElement("canvas");
  c.width = TEX_W;
  c.height = TEX_H;
  // cpu-backed, so each slice is rasterised as it is drawn instead of all at upload
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) throw new Error("no 2d");
  g.lineCap = "round";
  g.lineJoin = "round";
  const X = (u: number) => u * TEX_W;
  const Y = (v: number) => (1 - v) * TEX_H;

  for (const side of [-1, 1]) {
    const cuts = splits(side);
    for (let i = 0; i < BARBS; i++) {
      if (i % SLICE === SLICE - 1) yield;
      const v = BASE_V + (TIP_V - 0.012 - BASE_V) * ((i + rand() * 0.6) / BARBS);
      const t = (v - BASE_V) / (1 - BASE_V);
      const down = 1 - smooth(DOWN_V - 0.12, DOWN_V + 0.03, v);
      // barbs leave the shaft steep near the base and lie flatter toward the tip
      let ang = (68 - 40 * t) * (Math.PI / 180);
      for (const s of cuts) {
        const d = (s.v - v) / s.w;
        if (d > 0 && d < 1) ang -= s.k * (1 - d);
      }
      ang += down * (0.5 + rand() * 0.5);
      ang += (rand() - 0.5) * 0.03;

      // reach the outline: walk the barb out until it meets the edge
      const slope = (1 / Math.tan(ang)) * (TEX_W / TEX_H);
      let lo = v;
      let hi = TIP_V;
      for (let k = 0; k < 14; k++) {
        const mid = (lo + hi) / 2;
        if (vaneWidth(mid, side) > (mid - v) / slope) lo = mid;
        else hi = mid;
      }
      let dx = ((lo - v) / slope) * (1 - 0.05 * rand());
      if (down > 0) dx = Math.max(dx, (0.12 + 0.2 * rand()) * down);
      if (rand() < 0.04) dx *= 0.75 + rand() * 0.2;
      const dy = (dx / Math.tan(ang)) * (TEX_W / TEX_H);

      const x0 = rachisX(v);
      const pts = down > 0.2 ? 14 : 6;
      // bow: barbs curve gently toward the tip as they leave the shaft
      const bow = 0.12 + 0.05 * rand();
      let px = X(x0);
      let py = Y(v);
      g.lineWidth = down > 0.2 ? 0.9 : 1.5;
      if (mask) {
        const lum = Math.round(128 * (0.88 + 0.24 * rand()));
        g.strokeStyle = `rgba(${lum},${Math.round(down * 255)},0,${down > 0.2 ? 0.55 : 0.9})`;
        g.beginPath();
        g.moveTo(px, py);
      }
      for (let p = 1; p <= pts; p++) {
        const s = p / pts;
        const ux = x0 + side * dx * s;
        const uv = v + dy * (s + bow * s * (1 - s) * 2) - bow * dy * 0.6 * s * s;
        let wx = 0;
        let wy = 0;
        if (down > 0) {
          const wob = down * 0.012;
          wx = Math.sin(s * 9 + i * 1.7) * wob + (rand() - 0.5) * wob * 0.6;
          wy = Math.cos(s * 7 + i * 2.3) * wob * 0.8 - down * 0.02 * s * s;
        }
        const nx = X(ux + wx);
        const ny = Y(uv + wy);
        if (mask) {
          g.lineTo(nx, ny);
          if (down > 0.3 && p > 1)
            for (let h = 0; h < 2; h++) {
              const a = rand() * Math.PI * 2;
              const l = 3 + rand() * 6;
              g.lineTo(nx + Math.cos(a) * l, ny + Math.sin(a) * l);
              g.moveTo(nx, ny);
            }
          continue;
        }
        // barring runs across the vane, bending a little toward the tip at the edge
        const vm = uv - 0.04 * s;
        const band = look.bars
          ? smooth(0.35, 0.75, 0.5 + 0.5 * Math.sin(vm * look.bars * Math.PI * 2))
          : 0;
        const edge = smooth(0.75, 1, s) * 0.15;
        const tipDark = smooth(0.82, 0.98, vm) * 0.4;
        const ink = Math.min(1, band * 0.9 * (1 - down) + tipDark + edge * (1 - down));
        const firm = mix(look.base, look.bar, ink, 0.9 - 0.25 * s * s);
        g.strokeStyle =
          down > 0
            ? mix(look.down, look.base, (1 - down) * 0.6 + s * 0.2, 0.55 * (1 - s * 0.6))
            : firm;
        if (down > 0 && down < 1) g.strokeStyle = s < 0.5 && down < 0.5 ? firm : g.strokeStyle;
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(nx, ny);
        g.stroke();
        // fluffy barbules off the downy barbs
        if (down > 0.3 && p > 1) {
          g.lineWidth = 0.6;
          for (let h = 0; h < 2; h++) {
            const a = rand() * Math.PI * 2;
            const l = 3 + rand() * 6;
            g.beginPath();
            g.moveTo(nx, ny);
            g.lineTo(nx + Math.cos(a) * l, ny + Math.sin(a) * l);
            g.stroke();
          }
          g.lineWidth = 0.9;
        }
        px = nx;
        py = ny;
      }
      if (mask) g.stroke();
    }
  }

  // AFTERFEATHER
  // a small loose tuft where the vane starts
  g.lineWidth = 0.7;
  for (let i = 0; i < 70; i++) {
    const side = rand() < 0.5 ? -1 : 1;
    const v = BASE_V + rand() * 0.04;
    let x = X(rachisX(v));
    let y = Y(v);
    let a = Math.PI / 2 + side * (0.4 + rand() * 1.1);
    g.strokeStyle = mask
      ? "rgba(150,255,0,0.35)"
      : mix(look.down, [255, 255, 255], rand() * 0.5, 0.35);
    g.beginPath();
    g.moveTo(x, y);
    for (let s = 0; s < 16; s++) {
      a += (rand() - 0.5) * 0.5;
      x += Math.cos(a) * 6;
      y += Math.sin(a) * 6;
      g.lineTo(x, y);
    }
    g.stroke();
  }

  // RACHIS + QUILL
  // a pale tapering shaft with darker edges; the quill below it is hollow and see-through
  const shaft = (v0: number, v1: number, w0: number, w1: number, color: string) => {
    const n = 60;
    g.fillStyle = color;
    g.beginPath();
    for (let i = 0; i <= n; i++) {
      const v = v0 + ((v1 - v0) * i) / n;
      const w = w0 + ((w1 - w0) * i) / n;
      g.lineTo(X(rachisX(v)) - w / 2, Y(v));
    }
    for (let i = n; i >= 0; i--) {
      const v = v0 + ((v1 - v0) * i) / n;
      const w = w0 + ((w1 - w0) * i) / n;
      g.lineTo(X(rachisX(v)) + w / 2, Y(v));
    }
    g.closePath();
    g.fill();
  };
  const [sr, sg, sb] = look.shaft;
  const tone = (k: number, a: number) =>
    mask
      ? `rgba(${Math.round(128 * k)},0,255,${a})`
      : `rgba(${Math.round(sr * k)},${Math.round(sg * k)},${Math.round(sb * k)},${a})`;
  shaft(BASE_V - 0.002, TIP_V - 0.004, 9, 1.2, tone(0.7, 0.55));
  shaft(BASE_V - 0.002, TIP_V - 0.008, 6.5, 0.6, tone(1, 0.98));
  shaft(0.004, BASE_V + 0.01, 13, 10, tone(0.82, 0.5));
  shaft(0.006, BASE_V + 0.01, 10, 7.5, tone(1, 0.62));
  shaft(0.01, BASE_V, 3, 2.5, tone(1.08, 0.5));
  return c;
}

// SHADOW
// a soft copy for the paper: small, blurred
export function blurPlume(src: HTMLCanvasElement) {
  const c = document.createElement("canvas");
  c.width = TEX_W / 4;
  c.height = TEX_H / 4;
  const g = c.getContext("2d");
  if (!g) throw new Error("no 2d");
  g.filter = "blur(3px)";
  g.drawImage(src, 8, 8, c.width - 16, c.height - 16);
  return c;
}
