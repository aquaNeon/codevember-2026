// SHARED
// every motion is a whole number of cycles per LOOP_S, so the clock can wrap without a seam

export const LOOP_S = 120;
export const HORIZON = 0.42; // share of the height, from the bottom

export const FULL_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

// HAZE
// a screenprint of a horizon: paper, a few flat inks that multiply where they overlap, and a
// system of horizontal rules. below the horizon, stacked layers of hot air each show a slice
// of what is above, alternately upside down and upright, so the sun, the power line and the
// acacia come back mirrored, squashed and stacked
export const HAZE_FS = `#version 300 es
precision highp float;

uniform vec2  uRes;
uniform float uT;
uniform float uHeat;
uniform float uHeatX;
uniform float uEye;
uniform float uAspect;
uniform float uK;

out vec4 outColor;

#define HORIZON ${HORIZON}
const float W = 6.2831853 / ${LOOP_S}.0;

// INKS
const vec3 PAPER = vec3(0.941, 0.906, 0.831);
const vec3 CREAM = vec3(0.925, 0.835, 0.690);
const vec3 OCHRE_LT = vec3(0.875, 0.647, 0.361);
const vec3 OCHRE = vec3(0.769, 0.478, 0.208);
const vec3 EARTH = vec3(0.494, 0.247, 0.133);
const vec3 SUN = vec3(0.878, 0.290, 0.133);
const vec3 INK = vec3(0.129, 0.086, 0.059);

// RULES
// one rhythm of horizontal cuts, thickening downward: the sun's cuts and the gaps between the
// air layers both come from it
const float CUT[4] = float[4](0.0024, 0.0034, 0.0046, 0.006);

// POWER LINE
// poles every DZ in depth, receding to a vanishing point on the horizon
const float DZ = 0.5;
const float POLE_H = 0.17;
const float ARM_Y = 0.152;
const float ARM2_Y = 0.136;
const float WIRE_Y = 0.1572;
const float WIRE_O[2] = float[2](-0.0135, 0.0135);
const float SAG = 0.009;

float hash(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}

float cover(float d, float px) {
  return clamp(0.5 - d / px, 0.0, 1.0);
}

float sdBox(vec2 p, vec2 c, vec2 b) {
  vec2 d = abs(p - c) - b;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

float sdEll(vec2 p, vec2 c, vec2 r) {
  vec2 q = (p - c) / r;
  return (length(q) - 1.0) * min(r.x, r.y);
}

// portrait screens lay the same elements out closer in
float tall() {
  return smoothstep(1.1, 0.65, uAspect);
}

// a share across the screen, in object space
float fx(float f) {
  return (f - 0.5) * uAspect / uK;
}

// overprint: an ink multiplies whatever is under it, its density varying a touch with the grain
vec3 inkOn(vec3 c, vec3 ink, float a, float g) {
  return c * mix(vec3(1.0), ink / PAPER, a * (0.94 + 0.06 * g));
}

// one pole at depth scale sg, as a distance
float pole(vec2 q, float x, float sg) {
  vec2 r = (q - vec2(x, 0.0)) / sg;
  float d = sdBox(r, vec2(0.0, POLE_H * 0.5), vec2(mix(0.0026, 0.0017, clamp(r.y / POLE_H, 0.0, 1.0)), POLE_H * 0.5));
  d = min(d, sdBox(r, vec2(0.0, ARM_Y), vec2(0.0175, 0.0015)));
  d = min(d, sdBox(r, vec2(0.0, ARM2_Y), vec2(0.0105, 0.0013)));
  // insulators: small caps on the arms
  for (int i = 0; i < 2; i++) {
    d = min(d, sdBox(r, vec2(WIRE_O[i], ARM_Y + 0.0032), vec2(0.0009, 0.0017)) - 0.0003);
    d = min(d, sdBox(r, vec2(WIRE_O[i] * 0.42, ARM_Y + 0.0032), vec2(0.0009, 0.0017)) - 0.0003);
  }
  d = min(d, sdBox(r, vec2(-0.0085, ARM2_Y + 0.0029), vec2(0.0008, 0.0015)) - 0.0003);
  d = min(d, sdBox(r, vec2(0.0085, ARM2_Y + 0.0029), vec2(0.0008, 0.0015)) - 0.0003);
  return d * sg;
}

// SCENE ABOVE THE HORIZON
// q in object space, y up from the horizon; px is object units per pixel
vec3 sky(vec2 q, float px, float g) {
  vec3 c = PAPER;
  c = inkOn(c, CREAM, cover(q.y - 0.052, px), g);

  // SUN
  // flat, with cuts on the shared rhythm; it overprints the cream band
  vec2 sc = vec2(fx(mix(0.6, 0.47, tall())), 0.078);
  float dy = q.y - sc.y;
  float cut = 0.0;
  for (int i = 0; i < 4; i++) {
    cut = max(cut, cover(abs(dy + 0.017 + float(i) * 0.0135) - CUT[i] * 0.5, px));
  }
  c = inkOn(c, SUN, cover(length(q - sc) - 0.066, px) * (1.0 - cut), g);

  // MESA
  // a far table of rock with a butte, banded like its strata; the darker plate sits a hair off
  // register
  float x0 = fx(mix(0.855, 0.93, tall()));
  float x1 = fx(1.02);
  float mh = 0.013 * clamp((q.x - x0) / 0.03, 0.0, 1.0) * clamp((x1 - q.x) / 0.02, 0.0, 1.0);
  mh = min(mh, 0.013 * clamp((q.x - x0) / 0.022 + 0.25, 0.0, 1.0));
  float bx0 = fx(mix(0.905, 1.0, tall()));
  float bx1 = fx(mix(0.955, 1.08, tall()));
  float butte = 0.028 * clamp((q.x - bx0) / 0.006, 0.0, 1.0) * clamp((bx1 - q.x) / 0.009, 0.0, 1.0);
  mh = max(mh, min(butte, 0.013 + 0.6 * max(min(q.x - bx0 + 0.012, bx1 + 0.014 - q.x), 0.0)));
  float mesa = cover(q.y - mh, px) * step(0.0004, mh);
  c = inkOn(c, OCHRE_LT, mesa, g);
  vec2 qm = q + vec2(0.0008, -0.0005);
  float band = cover(abs(qm.y - 0.0072) - 0.0011, px) + cover(abs(qm.y - 0.019) - 0.0014, px) * step(0.014, mh);
  c = inkOn(c, OCHRE, clamp(band, 0.0, 1.0) * mesa, g);
  c = inkOn(c, OCHRE, cover(abs(qm.y - mh + 0.0012) - 0.0012, px) * mesa, g);

  // POWER LINE
  // the nearest poles stand off the left edge; the line runs to the vanishing point unbroken
  float vx = fx(mix(0.44, 0.26, tall()));
  float A = 0.6 * uAspect / uK;
  float ink = 1e3;
  float fade = 1.0;
  if (q.x < vx) {
    float sg = (vx - q.x) / A;
    float k = (1.0 / sg - 1.0) / DZ;
    float j0 = floor(k);
    for (int j = -1; j <= 2; j++) {
      float z = 1.0 + (j0 + float(j)) * DZ;
      if (z < 0.2) continue;
      float sj = 1.0 / z;
      ink = min(ink, pole(q, vx - A * sj, sj));
    }
    // where the poles crowd closer than a few pixels they thin into a ruled line
    fade = smoothstep(px * 1.5, px * 6.0, A * sg * sg * DZ);
    for (int i = 0; i < 2; i++) {
      float a = A - WIRE_O[i];
      float sw = (vx - q.x) / a;
      float f = fract((1.0 / sw - 1.0) / DZ);
      float y = sw * (WIRE_Y - SAG * 4.0 * f * (1.0 - f));
      float slope = WIRE_Y / a;
      ink = min(ink, abs(q.y - y) / sqrt(1.0 + slope * slope) - px * 0.28);
    }
  }
  c = inkOn(c, INK, cover(ink, px) * mix(0.55, 1.0, fade), g);

  // ACACIA
  // a flat crown on a forked trunk
  float tx = fx(mix(0.775, 0.83, tall()));
  float tr = sdSeg(q, vec2(tx, 0.0), vec2(tx + 0.002, 0.026)) - mix(0.0024, 0.0016, clamp(q.y / 0.026, 0.0, 1.0));
  tr = min(tr, sdSeg(q, vec2(tx + 0.002, 0.025), vec2(tx - 0.017, 0.047)) - 0.0012);
  tr = min(tr, sdSeg(q, vec2(tx + 0.002, 0.025), vec2(tx + 0.02, 0.047)) - 0.0012);
  tr = min(tr, sdSeg(q, vec2(tx + 0.006, 0.034), vec2(tx + 0.004, 0.047)) - 0.0009);
  tr = min(tr, max(sdEll(q, vec2(tx + 0.001, 0.0465), vec2(0.066, 0.0105)), 0.0462 - q.y));
  tr = min(tr, max(sdEll(q, vec2(tx - 0.012, 0.054), vec2(0.036, 0.0068)), 0.0535 - q.y));
  c = inkOn(c, INK, cover(tr, px), g);

  return c;
}

// GROUND
// two ochres overprinted, ruled with faint furrows that drift toward you
vec3 ground(vec2 p, float px, float k, float fw, float g) {
  float u = -p.y;
  vec3 c = inkOn(PAPER, OCHRE_LT, 1.0, g);
  c = inkOn(c, OCHRE * PAPER / OCHRE_LT, cover(0.064 * uK - u, px), g);
  float dk = min(fract(k), 1.0 - fract(k));
  float line = clamp(1.0 - dk / fw, 0.0, 1.0) * (1.0 - smoothstep(0.1, 0.3, fw));
  return inkOn(c, EARTH, line * 0.16, g);
}

void main() {
  float h = uRes.y;
  vec2 p = vec2((gl_FragCoord.x - 0.5 * uRes.x) / h, gl_FragCoord.y / h - HORIZON);
  float px = 1.0 / h;
  float t = uT;
  float row = floor(gl_FragCoord.y / max(1.0, floor(h / 600.0)));
  float g = hash(gl_FragCoord.xy);

  // HEAT
  // a calm shimmer everywhere, boiling where the cursor warms the ground
  float hx = uHeat * exp(-pow((p.x - uHeatX) / 0.3, 2.0));
  float s = clamp(0.16 + 0.84 * hx + 0.05 * sin(2.0 * W * t + p.x * 2.3), 0.0, 1.0);
  float low = mix(1.75, 0.55, uEye);
  float eyeF = mix(0.45, 1.5, uEye);
  float D = 0.024 * low * (0.6 + 2.1 * s) * uK;
  D *= 1.0 + 0.06 * sin(p.x * 9.0 + 5.0 * W * t) + 0.035 * sin(p.x * 23.0 - 9.0 * W * t);

  // furrow index, worked out before any branch so its derivative is sound
  float k = 0.32 * eyeF * uK / max(-p.y, 1e-4) - uT * 16.0 / ${LOOP_S}.0;
  float fw = fwidth(k);

  vec3 col;
  float u = -p.y;
  if (p.y < 0.0 && u < D) {
    // MIRAGE
    // band i shows a slice of the world above the horizon, flipped on even bands; each slice
    // is tall enough to carry the sun and the poles, so the stack fills with copies
    float n = 1.0 + 3.4 * s * s * low * 0.7;
    float v = u / D * n
      + 0.2 * s * sin(p.x * 11.0 + 7.0 * W * t + u * 60.0)
      + 0.045 * sin(p.x * 41.0 - 13.0 * W * t);
    v = max(v, 0.0);
    float i = floor(v);
    float f = fract(v);
    float r = i < 0.5 ? 1.5 : i < 1.5 ? 0.8 : i < 2.5 ? 2.2 : i < 3.5 ? 1.1 : 1.8;
    r *= 1.0 + 0.16 * sin(3.0 * W * t + i * 2.1 + p.x * 1.7);
    float span = (0.05 + 0.018 * i) * r / 1.4 * uK;
    float ys = mod(i, 2.0) < 0.5 ? f * span : (1.0 - f) * span;
    float xj = (0.002 * sin(row * 1.37 + 17.0 * W * t) + 0.001 * (hash(vec2(row, floor(t * 10.0))) - 0.5)) * (0.4 + s);
    float bandH = D / n;
    col = sky(vec2(p.x + xj, ys) / uK, px * span / bandH / uK, g);
    col = inkOn(col, OCHRE_LT, 0.2 + 0.08 * min(i, 4.0), g);
    // the gap above each lower layer, cut on the same rhythm as the sun
    float gap = CUT[int(clamp(i - 1.0, 0.0, 3.0))] * 0.5 * uK;
    if (i > 0.5) col = mix(col, PAPER, cover(f * bandH - gap, px));
  } else if (p.y < 0.0) {
    col = ground(p, px, k, fw, g);
  } else {
    // LOOMING
    // just above the horizon the warm air stretches things up
    float L = 0.05 * uK;
    float ys = p.y * (1.0 - 0.4 * s * exp(-p.y / L));
    float xj = 0.0014 * s * sin(row * 1.9 + 13.0 * W * t) * exp(-p.y / (0.02 * uK));
    col = sky(vec2(p.x + xj, ys) / uK, px / uK, g);
  }

  // the horizon, ruled
  col = inkOn(col, INK, 0.38 * cover(abs(p.y) - px * 0.35, px), g);

  // PAPER
  // fine and even
  col *= 1.0 + (g - 0.5) * 0.035;
  outColor = vec4(col, 1.0);
}
`;
