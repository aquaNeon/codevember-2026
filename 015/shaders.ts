import { COLORS, SCENE } from "./scene";

// SHADERS

export { SCENE };

const hex = (h: string) => {
  const n = parseInt(h.slice(1), 16);
  const c = (s: number) => (((n >> s) & 255) / 255).toFixed(3);
  return `vec3(${c(16)}, ${c(8)}, ${c(0)})`;
};

const f = (n: number) => n.toFixed(4);

const PALETTE = Object.entries(COLORS)
  .map(([name, value]) => `const vec3 ${name} = ${hex(value)};`)
  .join("\n");

export const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// HASHES
// no sin: large arguments differ between compiles and made things jump
const NOISE = `
float hash(float n) {
  n = fract(n * 0.1031);
  n *= n + 33.33;
  n *= n + n;
  return fract(n);
}
float hash2(vec2 p) {
  vec3 q = fract(p.xyx * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float noise(float x) {
  float i = floor(x);
  float t = fract(x);
  t = t * t * (3.0 - 2.0 * t);
  return mix(hash(i), hash(i + 1.0), t);
}
float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 t = fract(p);
  t = t * t * (3.0 - 2.0 * t);
  float a = hash2(i);
  float b = hash2(i + vec2(1.0, 0.0));
  float c = hash2(i + vec2(0.0, 1.0));
  float d = hash2(i + vec2(1.0, 1.0));
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}
const float CLOUD_SEED = 19.0; // change for another cloud layout`;

const S = SCENE;
const POLES = `uPoleX, ${f(S.POLE_SPACING_M)}, ${f(S.POLE_PHASE_M)}, ${f(S.POLE_H)}, ${f(S.POLE_W)}`;

export const TRAFFIC_N = 3;

export const SCENE_FS = `#version 300 es
precision highp float;

uniform vec2      uRes;
uniform float     uAspect;
uniform float     uZoom;
uniform float     uHor;
uniform float     uVp;
uniform float     uTime;
uniform float     uTravel;
uniform float     uPuddle;
uniform float     uCam;
uniform float     uShimmer;
uniform vec2      uSun;
uniform float     uTop;
uniform float     uPoleX;
uniform vec4      uTraffic[${TRAFFIC_N + 1}];
uniform ivec4     uLoop;
uniform float     uReveal;
uniform vec2      uFrame;
uniform float     uLine;

out vec4 outColor;

${PALETTE}
${NOISE}

const float CAM_H = ${f(S.CAM_H)};
const float ROAD_HALF = ${f(S.ROAD_HALF)};
const float PX_FLOOR = 1e-4;
const float SKY_K = ${f(S.LENS / S.SKY_LENS)};
const float DUNE_K = ${f(Math.sqrt(S.LENS / S.SKY_LENS))};
const float SUN_R = 0.052;
const float TAU = 6.2831853;

float px;
float fl;
vec2 p0;
vec2 cloudP;
float skyPh;
float skyA;
bool water = false;

float steady(float z) {
  return smoothstep(${f(S.STEADY_M)}, ${f(S.STEADY_M * 1.6)}, z);
}

float band(float d, float hw, float aa) {
  float w = max(hw, aa * 0.5);
  return clamp((w - abs(d)) / aa + 0.5, 0.0, 1.0) * (hw / w);
}

float fogAt(float z) {
  return 1.0 - exp(-z * ${f(S.FOG_PER_M)});
}

// LINES
// too fine to resolve, lines fade to their mean instead of moire
float lines(float ph, float w, float fw) {
  w = clamp(w, 0.0, 0.92);
  float d = abs(fract(ph + 0.5) - 0.5) / fw;
  float hw = 0.5 * w / fw;
  float ww = max(hw, 0.5);
  float cov = clamp(ww - d + 0.5, 0.0, 1.0) * (hw / ww);
  return mix(cov, w, smoothstep(0.3, 0.55, fw));
}

// THE BURIN
float swell = 0.6;
float even = 1.0;

float burin(float a, float id, float t) {
  float n = noise(a * 0.045 + hash(id) * 97.0);
  float taper = clamp((n - 0.55 + 2.0 * even * t) * 6.0, 0.0, 1.0);
  return taper * (1.0 + swell * (noise(a * 0.025 + id * 0.61) - 0.5));
}

float cut(float t, float ph, float a, float fw) {
  return lines(ph, clamp(t * 1.3, 0.0, 0.85) * burin(a, floor(ph + 0.5), t), fw);
}

float cut2(float t, float ph, float a, float fw, float ph2, float a2, float fw2) {
  float c = lines(ph, clamp(t * 1.25, 0.0, 0.7) * burin(a, floor(ph + 0.5), t), fw);
  float t2 = t - 0.42;
  if (t2 > 0.0) {
    float w2 = clamp(t2 * 1.5, 0.0, 0.55) * burin(a2, floor(ph2 + 0.5) + 311.0, t2 + 0.25);
    c += lines(ph2, w2, fw2) * (1.0 - c);
  }
  return c;
}

vec3 figure(vec3 c, float cov, float inner, float fill, float fade) {
  float ink = (cov - min(inner, cov) + min(inner, cov) * fill) * fade;
  return c * (1.0 - cov) + PAPER * (cov - ink) + INK * ink;
}

// HEAT
// smooth noise in long waves rising through the air, so every line stays a soft curve
float soft(vec2 p) {
  vec2 i = floor(p);
  vec2 t = fract(p);
  t = t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
  float a = hash2(i);
  float b = hash2(i + vec2(1.0, 0.0));
  float c = hash2(i + vec2(0.0, 1.0));
  float d = hash2(i + vec2(1.0, 1.0));
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}

float flow(vec2 q, float seed) {
  float t = uTime;
  float a = soft(vec2(q.x * 9.0 + t * 0.12 + seed, q.y * 13.0 - t * 1.1));
  float b = soft(vec2(q.x * 17.0 - t * 0.08 + seed * 1.7, q.y * 24.0 - t * 1.7) + 5.3);
  float c = soft(vec2(q.x * 5.0 + seed * 0.6, q.y * 7.0 - t * 0.6) + 11.1);
  return 0.5 * a + 0.3 * b + 0.2 * c - 0.5;
}

float sway;

// SKY
float skyTone(float h) {
  return 0.07 + 0.25 * pow(smoothstep(0.0, uTop * 1.15, h), 1.25);
}

vec3 sky(vec2 p, float t, bool sun) {
  vec2 ds = p - uSun;
  float d = length(ds);
  float glow = sun ? exp(-max(d - SUN_R, 0.0) * 9.0) : 0.0;
  t *= (1.0 - 0.55 * glow) * smoothstep(SUN_R * 1.15, SUN_R * 2.4, d);

  // CLOUDS
  // in front of the sun: paper on top, heavier lines under, a fine line round the top
  float cover = 0.0;
  float ct = 0.0;
  float edge = 0.0;
  for (int i = 0; i < uLoop.x; i++) {
    float fi = float(i);
    float y0 = uTop * (0.34 + 0.17 * fi) + 0.02 * hash(fi * 3.1 + 0.5);
    float x = cloudP.x * (1.2 + 0.4 * fi) + uTime * 0.006 * (1.0 + fi) + fi * 13.7 + CLOUD_SEED;
    float n = 0.65 * noise(x * 2.1) + 0.35 * noise(x * 5.3 + 2.0);
    float thick = 0.034 * sqrt(uFrame.x) * (1.0 - 0.3 * fi) * smoothstep(0.52, 0.85, n);
    float y = cloudP.y - y0 - (n - 0.5) * 0.02;
    float inside = smoothstep(px, -px, abs(y) - thick) * smoothstep(0.0, 2.0 * px, thick);
    float lit = smoothstep(-0.2 * thick - 3.0 * px, -0.2 * thick + 3.0 * px, y);
    ct = mix(ct, mix(0.5, 0.0, lit), inside);
    cover = max(cover, inside);
    edge = max(edge, band(y - thick, 0.5 * px, px) * smoothstep(px, 4.0 * px, thick));
  }
  swell = 0.15;
  even = sun ? 3.0 : 1.0;
  float ink = cut(t, skyPh, skyA, fl);
  float cink = max(cut(ct, skyPh, skyA, fl), edge * 0.85);
  swell = 0.6;
  even = 1.0;
  vec3 c = mix(PAPER, mix(INK, SUN_INK, glow), ink);

  // SUN
  if (sun && d < SUN_R * 2.8) {
    float ang = atan(ds.y, ds.x);
    float rph = ang / TAU * 56.0;
    float rid = floor(rph + 0.5);
    float len = (mod(rid, 2.0) < 0.5 ? 2.5 : 1.85) * (0.9 + 0.2 * hash(rid + 3.0));
    float u = clamp((d - SUN_R * 1.3) / (SUN_R * (len - 1.3)), 0.0, 1.0);
    float ray = lines(rph, 0.17 * smoothstep(0.0, 0.08, u) * (1.0 - u), px * 56.0 / (TAU * d));
    float ring = band(d - SUN_R, 0.6 * px, px);
    c = mix(c, SUN_INK, max(ray, ring));
    vec2 dw = ds - vec2(0.005, -0.004);
    float wd = length(dw) + 0.005 * (noise2(dw / max(length(dw), 1e-4) * 1.7 + 3.0) - 0.5);
    float wash = smoothstep(SUN_R * 1.04 + 2.0 * px, SUN_R * 1.04 - px, wd);
    wash = 0.85 * max(wash, 0.18 * exp(-max(wd - SUN_R, 0.0) * 16.0));
    c *= mix(vec3(1.0), SUN_WASH / PAPER, wash);
  }
  // the sun behind warms the cloud's rim and wash
  float warm = sun ? exp(-max(d - SUN_R, 0.0) * 7.0) : 0.0;
  vec3 cc = mix(PAPER, mix(INK, SUN_INK, warm), cink);
  cc *= mix(vec3(1.0), SUN_WASH / PAPER, 0.3 * warm * (1.0 - cink));
  return mix(c, cc, max(cover, edge));
}

// DUNES

vec4 ridge(float x, float amp, float seed, out float cell) {
  x += 0.8 * noise(x * 0.29 + seed);
  cell = floor(x);
  float s = fract(x);
  float k = 0.18 + 0.5 * hash(cell + seed);
  float a = amp * (0.3 + 0.7 * hash(cell * 1.7 + seed));
  a *= hash(cell * 3.1 + seed) < 0.22 ? 0.35 : 1.0;
  float backPow = 1.0 + 1.1 * hash(cell * 5.3 + seed);
  float prof = s < k ? 1.0 - pow(1.0 - s / k, 1.7) : 1.0 - pow((s - k) / (1.0 - k), backPow);
  return vec4(a * prof, s, k, a);
}

float duneAt(float x, float amp, float fi, out vec4 r, out float cell) {
  float cellA;
  float cellB;
  vec4 ra = ridge(x, amp, fi * 7.0, cellA);
  vec4 rb = ridge(x * 1.63 + 0.5, amp * 0.62, fi * 7.0 + 3.0, cellB);
  bool front = rb.x > ra.x;
  r = front ? rb : ra;
  cell = front ? cellB + 101.0 : cellA;
  return r.x + amp * 0.35 * noise(x * 0.37 + fi);
}

vec3 dunes(vec2 p, vec3 c, bool mirror) {
  float lw = uLine / DUNE_K;
  for (int i = 0; i < uLoop.x; i++) {
    float fi = float(i);
    float freq = 1.5 + 1.6 * fi;
    float amp = (0.105 - 0.03 * fi) * (1.0 - 0.15 * fi);
    float x = p.x * freq + fi * 31.7 + uCam * (0.002 + 0.004 * fi);
    if (p.y > amp * 1.35 + px) continue;
    vec4 r;
    float cell;
    float h = duneAt(x, amp, fi, r, cell);
    if (p.y > h + 2.0 * px) continue;
    vec4 r2;
    float cell2;
    float k = (duneAt(x + freq * px, amp, fi, r2, cell2) - h) / px;
    float sl = sqrt(1.0 + k * k);
    float cover = smoothstep(h + px * sl, h - px * sl, p.y);

    float swell = h - r.x;
    float v = clamp(p.y / max(r.w + swell, 1e-3), 0.0, 1.0);
    float wob = 0.03 * (noise(p.y * 60.0 + cell * 5.0) - 0.5);
    float bend = 0.45 + 0.4 * hash(cell * 2.3);
    float term = r.z * (0.25 + 0.75 * pow(v, bend)) + wob;
    float lit = smoothstep(term - 0.018, term + 0.018, r.y);
    float back = smoothstep(0.76, 0.82, r.y + 0.35 * (1.0 - v) + wob);
    float t = mix(0.72 + 0.06 * fi, mix(0.26 + 0.05 * fi, 0.45, back), lit);
    t *= 1.0 - 0.6 * lit * (1.0 - back) * v * v;
    float cs = smoothstep(0.42, 0.82, noise2(vec2(p.x * 1.4 + uTime * 0.008 + fi * 5.0, fi * 3.0)));
    t += 0.14 * cs;
    float haze = clamp(0.3 - 0.1 * fi + 0.5 * (1.0 - smoothstep(0.0, 0.012, p.y)), 0.0, 1.0);
    t *= 1.0 - haze;

    if (mirror) {
      float tm = max(t, 0.5 * (1.0 - haze)) * 0.9;
      c = mix(c, mix(PAPER, INK, cut(tm, skyPh, skyA, fl)), cover);
      continue;
    }
    float ph = (h - p.y) / lw + fi * 0.37;
    float ink = cut2(
      t, ph, p.x / lw, fl * sl,
      (p.x * 0.55 + p.y * 0.84) / lw, (p.x * 0.84 - p.y * 0.55) / lw, fl
    );
    c = mix(c, mix(PAPER, INK, ink), cover);
    float cw = (0.55 + 0.5 * (1.0 - lit) + 0.2 * fi) * px;
    c = mix(c, INK, band(p.y - h, cw, px * sl) * (1.0 - haze * 0.85));
  }
  return c;
}

// ABOVE
// one call site, shared by the sky and the water, keeps the compile short
vec3 above(vec2 p, vec2 pd, float t, bool mirror) {
  float px0 = px;
  px = px0 / SKY_K;
  vec3 c = sky(p / SKY_K, t, !mirror);
  px = px0 * (mirror ? ${f(S.DUNE_SQUASH)} : 1.0) / DUNE_K;
  c = dunes((mirror ? pd : p) / DUNE_K, c, mirror);
  px = px0;
  return c;
}

// POSTS
void posts(vec2 p, float eye, float sq, float xw, float spacing, float phase, float h, float w, bool pole, inout vec3 c) {
  float ax = xw - uCam;
  if (p.x * ax <= 0.0) return;
  float za = ax / p.x;
  float kc = floor((za + uTravel - phase) / spacing);
  for (int jj = 0; jj < uLoop.x; jj++) {
    float zk = (kc + float(1 - jj)) * spacing + phase - uTravel;
    if (zk < 1.5) continue;
    float inv = 1.0 / zk;
    vec2 q = water ? p : mix(p0, p, steady(zk));
    float base = -eye * inv;
    float top = (sq * (water ? min(h, ${f(S.MIRROR_H)}) : h) - eye) * inv;
    if (q.y < base - px || q.y > top + 0.4 * inv + px) continue;
    float dx = q.x - ax * inv;
    float up = clamp((q.y - base) / (top - base), 0.0, 1.0);
    float hw = 0.5 * w * inv * (pole ? 1.0 - 0.3 * up : 1.0);
    float mid = q.y - 0.5 * (top + base);
    float hh = 0.5 * abs(top - base);
    float cov = band(dx, hw, px) * band(mid, hh, px);
    float inner = band(dx, max(hw - 1.1 * px, 0.0), px) * band(mid, max(hh - 1.1 * px, 0.0), px);
    float lit = smoothstep(-0.2, 0.6, dx / max(hw, px));
    float fade = (1.0 - fogAt(zk) * 0.8);
    float fill;
    if (pole) {
      fill = mix(0.9, 0.3, lit);
      float ay = (sq * ${f(S.ARM_Y)} - eye) * inv;
      float vi = sq * inv;
      float arm = band(dx, ${f(S.ARM_HALF)} * inv, px) * band(q.y - ay, 0.09 * vi, px);
      float ix = abs(abs(dx) - 0.82 * ${f(S.ARM_HALF)} * inv);
      float ins = band(ix, 0.07 * inv, px) * band(q.y - ay - 0.2 * vi, 0.12 * vi, px);
      float ix2 = abs(abs(dx) - 0.32 * ${f(S.ARM_HALF)} * inv);
      ins = max(ins, band(ix2, 0.07 * inv, px) * band(q.y - ay - 0.2 * vi, 0.12 * vi, px));
      float extra = water ? 0.0 : max(arm, ins) * (1.0 - cov);
      c = mix(c, INK, extra * fade);
    } else {
      fill = mix(0.5, 0.06, lit);
    }
    fill = cut(fill, q.x / uLine * 1.3, q.y / uLine, fl * 1.3);
    if (!pole) fill = max(fill, step(0.8, up) * step(up, 0.92));
    if (water) c = mix(c, INK, cov * fade * lines(skyPh, 0.8, fl));
    else c = figure(c, cov, inner, fill, fade);
  }
}

// SAND DEVIL
const float DEVIL_H = ${f(S.DEVIL_H)};

void devil(vec2 p, float eye, float sq, inout vec3 c) {
  float t = uTime;
  float z = ${f(S.DEVIL_M)} + 40.0 * sin(t * 0.031);
  float share = (uAspect < 0.8 ? 0.22 : 0.23) + 0.015 * sin(t * 0.047 + 1.3);
  float s = 2.0 * (0.5 - share);
  float h = (p.y * z + eye) / sq;
  if (water || h < -1.2 || h > DEVIL_H + 0.5) return;
  float xm = p.x * z + z * uFrame.y * s;
  if (abs(xm) > 4.0) return;
  float u = clamp(h / DEVIL_H, 0.0, 1.0);
  float axis = 0.9 * u * u + 0.18 * sin(h * 0.6 - t * 1.1) + 0.12 * sin(t * 0.21);
  float r = mix(0.22, 1.1, pow(u, 1.2));
  float d = clamp((xm - axis) / r, -1.0, 1.0);
  float body = smoothstep(1.0, 0.6, abs(d)) * smoothstep(DEVIL_H, DEVIL_H * 0.6, h) * smoothstep(-0.2, 0.3, h);
  // a helix seen from the side: each stroke bends round the column in a soft arc
  float zp = z * px;
  float rim = sqrt(max(1.0 - d * d, 0.05));
  float ph = h * 1.6 + 0.9 * asin(d * 0.98) - t * 2.4;
  float fw = zp * sqrt(2.56 + 0.81 / (r * r * rim * rim));
  float fray = smoothstep(0.2, 0.6, noise(ph * 0.5 + floor(ph + 0.5) * 2.3 - t * 0.3));
  float w = 0.7 * body * (1.0 - 0.5 * u) * mix(1.0, fray, u) * mix(1.2, 0.6, 0.5 + 0.5 * d);
  float ink = lines(ph, w, fw);
  float skirt = smoothstep(1.0, 0.2, length(vec2((xm - 0.15 * sin(t * 0.9)) / 1.4, (h - 0.3) / 0.6)));
  float sw = h * 2.2 + 0.3 * sin(xm * 1.6 - t * 1.4);
  ink = max(ink, lines(sw, 0.45 * skirt, zp * 2.2 / sq));
  float fade = 1.0 - fogAt(z) * 0.45;
  c = mix(c, PAPER, 0.75 * body * fade);
  c = mix(c, INK, ink * fade);
}

// HAWK
void hawk(vec2 p, inout vec3 c) {
  float top = uTop * SKY_K;
  float t = uTime;
  float cyc = fract(t / ${f(S.HAWK_CYCLE_S)});
  float away = smoothstep(0.55, 0.72, cyc) * smoothstep(0.98, 0.82, cyc);
  float a = t * 0.24;
  float rx = 0.06 * (0.8 + 0.3 * sin(t * 0.053));
  float ry = rx * (0.22 + 0.08 * sin(t * 0.071));
  vec2 ctr = vec2(-0.13 + 0.03 * sin(t * 0.031), top * (0.5 + 0.06 * sin(t * 0.029)));
  ctr += away * vec2(-0.5, 0.05);
  vec2 q = p - ctr - vec2(rx * cos(a), ry * sin(a));
  float span = 0.011;
  if (dot(q, q) > span * span) return;
  float across = abs(sin(a));
  float bank = (0.2 + 0.35 * (0.5 + 0.5 * sin(t * 0.11))) * cos(a);
  q = mat2(cos(bank), -sin(bank), sin(bank), cos(bank)) * q / span;
  q.x /= mix(0.45, 1.0, across);
  // FLAPS
  float beatT = mod(t, ${f(S.HAWK_FLAP_S)});
  float burst = smoothstep(0.0, 0.1, beatT) * smoothstep(1.3, 1.1, beatT);
  float flap = burst * sin(beatT * 6.2832 * 2.2);
  vec2 w = vec2(abs(q.x), q.y);
  vec2 b0 = vec2(0.22, 0.07 + 0.16 * flap);
  vec2 b1 = vec2(0.5 - 0.08 * abs(flap), 0.32 * flap);
  float s0 = clamp(dot(w, b0) / dot(b0, b0), 0.0, 1.0);
  float d0 = length(w - b0 * s0) - mix(0.06, 0.035, s0);
  vec2 e = b1 - b0;
  float s1 = clamp(dot(w - b0, e) / dot(e, e), 0.0, 1.0);
  float d1 = length(w - b0 - e * s1) - mix(0.035, 0.012, s1);
  float body = length(vec2(q.x / 0.05, (q.y + 0.03) / 0.11)) - 1.0;
  float d = min(min(d0, d1), body * 0.05);
  float aa = px / span;
  float cov = smoothstep(aa, -aa, d);
  c = mix(c, INK, cov * 0.9);
}

// VEHICLES
const float SINK_PER_M = 0.007;
const float R2 = 0.70710678;

float sinkAt(float z) {
  return max(0.0, z - ${f(S.FLOAT_M)}) * SINK_PER_M;
}

// HULLS
void clip(vec3 o, vec3 d, vec3 n, float w, inout vec3 span, inout vec3 nn) {
  float dn = dot(n, d);
  float s = w - dot(n, o);
  if (dn < -1e-6) {
    float t = s / dn;
    if (t > span.x) {
      span.x = t;
      nn = n;
    }
  } else if (dn > 1e-6) {
    float t = s / dn;
    if (t < span.y) span.yz = vec2(t, dn);
  } else if (s < 0.0) span.y = -1.0;
}

vec2 blockHit(vec3 o, vec3 d, vec3 lo, vec3 hi, float ch, out vec3 nn) {
  vec3 span = vec3(0.0, 1e9, 1.0);
  nn = vec3(0.0, 0.0, -1.0);
  vec3 n6 = vec3(R2, R2, 0.0);
  vec3 n7 = vec3(-R2, R2, 0.0);
  vec3 n8 = vec3(0.0, R2, R2);
  vec3 n9 = vec3(0.0, R2, -R2);
  vec3 n10 = vec3(R2, 0.0, R2);
  vec3 n11 = vec3(-R2, 0.0, R2);
  vec3 n12 = vec3(R2, 0.0, -R2);
  vec3 n13 = vec3(-R2, 0.0, -R2);
  float w6 = R2 * (hi.x + hi.y - ch);
  float w7 = R2 * (-lo.x + hi.y - ch);
  float w8 = R2 * (hi.y + hi.z - ch);
  float w9 = R2 * (hi.y - lo.z - ch);
  float w10 = R2 * (hi.x + hi.z - ch);
  float w11 = R2 * (-lo.x + hi.z - ch);
  float w12 = R2 * (hi.x - lo.z - ch);
  float w13 = R2 * (-lo.x - lo.z - ch);
  clip(o, d, vec3(1.0, 0.0, 0.0), hi.x, span, nn);
  clip(o, d, vec3(-1.0, 0.0, 0.0), -lo.x, span, nn);
  clip(o, d, vec3(0.0, 1.0, 0.0), hi.y, span, nn);
  clip(o, d, vec3(0.0, -1.0, 0.0), -lo.y, span, nn);
  clip(o, d, vec3(0.0, 0.0, 1.0), hi.z, span, nn);
  clip(o, d, vec3(0.0, 0.0, -1.0), -lo.z, span, nn);
  clip(o, d, n6, w6, span, nn);
  clip(o, d, n7, w7, span, nn);
  clip(o, d, n8, w8, span, nn);
  clip(o, d, n9, w9, span, nn);
  clip(o, d, n10, w10, span, nn);
  clip(o, d, n11, w11, span, nn);
  clip(o, d, n12, w12, span, nn);
  clip(o, d, n13, w13, span, nn);
  if (span.x >= span.y || span.x <= 0.0) return vec2(1e9, 0.0);
  return vec2(span.x, span.z * (span.y - span.x));
}

vec2 cabHit(vec3 o, vec3 d, float y0, float y1, float c0, float r0, float c1, float r1, float wb, float wt, out vec3 nn) {
  float hgt = y1 - y0;
  vec3 nf = normalize(vec3(0.0, r0, -hgt));
  vec3 nb = normalize(vec3(0.0, r1, hgt));
  vec3 ns = normalize(vec3(hgt, wb - wt, 0.0));
  vec3 nt = normalize(vec3(-hgt, wb - wt, 0.0));
  float wf = dot(nf, vec3(0.0, y0, c0));
  float wbk = dot(nb, vec3(0.0, y0, c1));
  float ws = dot(ns, vec3(wb, y0, 0.0));
  float wt2 = dot(nt, vec3(-wb, y0, 0.0));
  vec3 span = vec3(0.0, 1e9, 1.0);
  nn = vec3(0.0, 0.0, -1.0);
  clip(o, d, vec3(0.0, 1.0, 0.0), y1, span, nn);
  clip(o, d, vec3(0.0, -1.0, 0.0), -y0, span, nn);
  clip(o, d, nf, wf, span, nn);
  clip(o, d, nb, wbk, span, nn);
  clip(o, d, ns, ws, span, nn);
  clip(o, d, nt, wt2, span, nn);
  if (span.x >= span.y || span.x <= 0.0) return vec2(1e9, 0.0);
  return vec2(span.x, span.z * (span.y - span.x));
}

float faceTone(vec3 n) {
  float side = n.x > 0.0 ? 0.26 : 0.68;
  return 0.04 * n.y * n.y + side * n.x * n.x + 0.56 * n.z * n.z;
}

void vehicle(vec2 p, float eye, float sq, vec4 v, inout vec3 c) {
  float z = v.x;
  if (z < 1.2) return;
  if (!water) p = mix(p0, p, steady(z));
  float k = v.z;
  bool head = k > 0.5;
  bool truck = k > 2.5;
  bool pickup = k > 1.5 && !truck;
  float rel = v.y - uCam;
  float hw = truck ? 1.0 : pickup ? 0.88 : 0.84;
  float len = truck ? 6.2 : pickup ? 5.1 : 4.4;
  float x0 = (p.x - rel / z) * z;
  float x1 = (p.x - rel / (z + len)) * (z + len);
  float wide = (truck ? 1.1 : hw) + 0.3 + 8.0 * px * z;
  if (min(abs(x0), abs(x1)) > wide && x0 * x1 > 0.0) return;
  float h0 = (p.y * z + eye) / sq;
  if (h0 > (truck ? 4.0 : 2.8) || h0 < -1.6 * max(eye, 0.0) / z - 0.05) return;

  float sink = sinkAt(z);
  float paint = (v.w - 1.5) * 0.07;
  float sill = truck ? 0.34 : pickup ? 0.3 : 0.24;
  float belt = truck ? 2.2 : pickup ? 1.0 : 0.8;
  float roof = pickup ? 1.72 : 1.38;
  float wr = truck ? 0.38 : 0.31;
  float fade = (1.0 - fogAt(z) * 0.4) * (water ? 1.0 - smoothstep(200.0, 700.0, z) : 1.0);
  float phV = p.x / uLine * 1.2;
  float phH = p.y / uLine * 1.2;

  // CONTACT SHADOW
  if (!water && sink == 0.0) {
    float d = abs(p.y) > 1e-6 ? -eye / p.y : -1.0;
    if (d > z - 2.0 && d < z + len) {
      vec2 g = vec2(p.x * d - rel, d);
      float sh = smoothstep(1.0, 0.6, length(vec2((g.x + 0.35) / (hw * 1.2), (g.y - z - 0.5 * len + 0.6) / (0.5 * len + 0.6))));
      float ink = lines((p.x - p.y) * 0.7 / uLine, 0.6 * sh, fl);
      c = mix(c, INK, max(ink, 0.35 * sh) * fade);
    }
  }

  vec3 o = vec3(-rel, eye / sq, -z);
  vec3 d = vec3(p.x, p.y / sq, 1.0);
  float nearT = 1e9;

  // BODY, BOX, CAB
  for (int part = 0; part < uLoop.x; part++) {
    if (part == 1 && !truck) continue;
    if (part == 2 && truck) continue;
    vec3 nn;
    vec2 hh;
    if (part < 2) {
      bool box = part == 1;
      hh = blockHit(
        o, d,
        box ? vec3(-1.08, 0.85, 2.0) : vec3(-hw, 0.06, 0.0),
        box ? vec3(1.08, 3.0, len) : vec3(hw, belt, truck ? 1.9 : len),
        box ? 0.06 : truck ? 0.16 : 0.14,
        nn
      );
    } else {
      hh = cabHit(
        o, d, belt - 0.02, roof,
        pickup ? 1.4 : 1.2, pickup ? 0.3 : 0.6,
        pickup ? 2.85 : 3.6, pickup ? 0.06 : 0.5,
        hw * 0.92, pickup ? hw * 0.8 : hw * 0.68,
        nn
      );
    }
    if (hh.x >= nearT) continue;
    vec3 hp = o + d * hh.x;
    float e = hh.y / (px * hh.x);
    float cov = clamp(e + 0.5, 0.0, 1.0);
    float inner = clamp(e - 0.6, 0.0, 1.0);
    float t = faceTone(nn) + (part == 1 ? -0.1 : paint);
    t = mix(t, 0.95, smoothstep(70.0, 200.0, z));
    if (part == 0) t = mix(t, 0.95, step(hp.y, sill));
    // GLASS
    if (part == 2 && nn.y < 0.95) {
      float u = clamp((hp.y - belt) / (roof - belt), 0.0, 1.0);
      float inY = step(belt + 0.07, hp.y) * step(hp.y, roof - 0.06);
      float win;
      if (abs(nn.z) > abs(nn.x)) {
        float hx = mix(hw * 0.92, pickup ? hw * 0.8 : hw * 0.68, u) - 0.08;
        win = inY * step(abs(hp.x), hx);
      } else {
        float f0 = (pickup ? 1.4 + 0.3 * u : 1.2 + 0.6 * u) + 0.1;
        float f1 = (pickup ? 2.85 - 0.06 * u : 3.6 - 0.5 * u) - 0.1;
        win = inY * step(f0, hp.z) * step(hp.z, f1) * (1.0 - step(abs(hp.z - 0.5 * (f0 + f1)), 0.05));
      }
      t = mix(t, 0.88 - 0.25 * u, win);
    }
    if (part == 0 && truck && nn.y < 0.95) {
      float inY = step(1.45, hp.y) * step(hp.y, 2.05);
      float win = abs(nn.z) > abs(nn.x) ? inY * step(abs(hp.x), hw - 0.14) : inY * step(0.15, hp.z) * step(hp.z, 1.3);
      t = mix(t, 0.85, win);
    }
    bool upright = abs(nn.x) > abs(nn.z);
    float fill = cut2(t, upright ? phV : phH, upright ? phH : phV, fl * 1.2, upright ? phH : phV, upright ? phV : phH, fl * 1.2);
    fill = max(fill, smoothstep(0.76, 0.88, t));
    // LAMPS
    if (part == 0 && nn.z < -0.7) {
      float ly = sill + 0.2;
      vec2 lq = vec2(abs(hp.x) - hw * 0.68, hp.y - ly);
      if (head) {
        fill = mix(fill, 1.0, step(abs(hp.x), 0.42) * step(abs(hp.y - sill - 0.1), 0.07) * 0.8);
        fill = mix(fill, 0.0, smoothstep(0.09, 0.07, length(lq)));
      } else fill = mix(fill, 1.0, step(abs(lq.x), 0.12) * step(abs(lq.y - 0.08), 0.05));
    }
    float keep = smoothstep(sink - 0.02, sink + 0.02, hp.y);
    if (water) c = mix(c, INK, cov * keep * fade * lines(skyPh, 0.85, fl));
    else c = figure(c, cov * keep, inner * keep, fill, fade);
    if (cov > 0.5) nearT = hh.x;
  }

  // WHEELS
  float side = rel < 0.0 ? 1.0 : -1.0;
  float xo = side * (hw + 0.02);
  float tcap = (xo - o.x) / d.x;
  if (tcap > 0.0 && tcap < nearT + 0.3 && d.x * side < 0.0) {
    for (int i = 0; i < uLoop.w; i++) {
      float wz = i == 0 ? (truck ? 1.0 : 0.85) : len - (truck ? 1.3 : 0.9);
      vec2 q = o.yz + d.yz * tcap - vec2(wr, wz);
      float rq = length(q);
      float cov = clamp((wr - rq) / (px * tcap) + 0.5, 0.0, 1.0);
      cov *= smoothstep(sink - 0.02, sink + 0.02, o.y + d.y * tcap);
      float hub = smoothstep(0.5 * wr, 0.4 * wr, rq);
      c = mix(c, INK, cov * (1.0 - 0.6 * hub) * fade * (water ? lines(skyPh, 0.85, fl) : 1.0));
    }
  }
}

// WIRES
void wires(vec2 p, inout vec3 c) {
  if (p.x <= 0.0) return;
  for (int i = 0; i < uLoop.z; i++) {
    float off = i == 0 ? -0.82 : i == 1 ? 0.32 : 0.82;
    float ax = uPoleX + off * ${f(S.ARM_HALF)} - uCam;
    float z = ax / p.x;
    if (z < 1.5) continue;
    vec2 q = mix(p0, p, steady(z));
    z = ax / q.x;
    float u = fract((z + uTravel - ${f(S.POLE_PHASE_M)}) / ${f(S.POLE_SPACING_M)});
    float sag = ${f(S.SAG_M)} * 4.0 * u * (1.0 - u);
    float y = (${f(S.ARM_Y)} + 0.32 - sag - CAM_H) / z;
    float slope = abs(y / q.x);
    float cov = band(q.y - y, max(0.02 / z, 0.4 * px), px * (1.0 + slope));
    c = mix(c, INK, cov * 0.9 * (1.0 - fogAt(z) * 0.8));
  }
}

// SHADOWS
const vec2 SUN_DIR = vec2(-0.8, -0.6);

float shadowOf(vec2 g, float xw, float spacing, float phase, float h, float w, vec2 aa) {
  float len = h * ${f(S.SHADOW_K)};
  float k = ceil((g.y - phase) / spacing);
  float zk = k * spacing + phase;
  vec2 a = vec2(xw, zk);
  vec2 b = a + SUN_DIR * len;
  vec2 ab = b - a;
  float t = clamp(dot(g - a, ab) / dot(ab, ab), 0.0, 1.0);
  vec2 d = g - (a + ab * t);
  vec2 nrm = vec2(-ab.y, ab.x) / len;
  float across = abs(dot(d, nrm));
  float foot = length(abs(nrm) * aa);
  return band(across, 0.5 * w * (1.0 - 0.3 * t), foot) * step(dot(g - a, ab), dot(ab, ab));
}

float rigShadow(vec2 g, vec2 aa) {
  vec2 lean = SUN_DIR * ${f(S.SHADOW_K)};
  float sp = ${f(S.POLE_SPACING_M)};
  float ph = ${f(S.POLE_PHASE_M)};
  float armY = ${f(S.ARM_Y)};
  float armHalf = ${f(S.ARM_HALF)};
  vec2 arm = lean * armY;
  float k = floor((g.y - arm.y - ph) / sp + 0.5);
  vec2 d = g - vec2(uPoleX, k * sp + ph) - arm;
  float s = band(d.x, armHalf, aa.x) * band(d.y, 0.14, aa.y);
  if (k * sp + ph - uTravel < 1.5) s = 0.0;
  vec2 ab = lean * 0.24;
  float foot = 0.7 * length(aa);
  for (int i = 0; i < uLoop.y; i++) {
    float xo = (i < 2 ? 0.82 : 0.32) * (i % 2 == 0 ? 1.0 : -1.0) * armHalf;
    vec2 q = d - vec2(xo, 0.0) - lean * 0.08;
    float t = clamp(dot(q, ab) / dot(ab, ab), 0.0, 1.0);
    s = max(s, band(length(q - ab * t), 0.06, foot));
  }
  return s;
}

// GROUND
vec3 ground(vec2 p) {
  float z = CAM_H / max(-p.y, PX_FLOOR);
  float x = p.x * z + uCam;
  float wz = z + uTravel;
  vec2 aa = vec2(px * z, px * z * z / CAM_H);
  float far = 1.0 - fogAt(z) * 0.82;
  float heat = steady(z) * uShimmer;

  // SAND
  float t = mix(0.17, 0.08, smoothstep(6.0, 160.0, z));
  t -= 0.07 * smoothstep(0.4, 0.8, noise2(vec2(x * 0.04, wz * 0.015)));
  float warp = noise2(vec2(x * 0.18, wz * 0.06)) * 5.0;
  float ripple = sin(wz * 1.1 + warp + x * 0.15);
  float rippleFade = 1.0 - smoothstep(0.25, 0.9, aa.y * 1.1);
  t += 0.14 * smoothstep(0.2, 0.9, ripple) * rippleFade;
  float phS = p.y / uLine + 0.2 * ripple * rippleFade + 0.6 * heat * sway;
  float sand = cut(t * far, phS, p.x / uLine, fl);

  // ROAD
  float ax = abs(x);
  float road = band(x, ROAD_HALF, aa.x);
  float tr = mix(0.55, 0.3, smoothstep(8.0, 170.0, z));
  tr *= 0.9 + 0.2 * noise2(vec2(x * 1.7, wz * 0.4));
  float edge = band(ax - ROAD_HALF + 0.32, 0.08, aa.x);
  float dashAlong = fract(wz / ${f(S.DASH_M)});
  float dashFoot = aa.y / ${f(S.DASH_M)};
  float on = smoothstep(${f(S.DASH_ON)} + dashFoot, ${f(S.DASH_ON)} - dashFoot, dashAlong)
    * smoothstep(-dashFoot, dashFoot, dashAlong);
  on = mix(on, ${f(S.DASH_ON)}, smoothstep(0.15, 0.5, dashFoot));
  float paint = max(edge, band(x, 0.075, aa.x) * on);
  float u = x - uCam + 1.5 * heat * sway * aa.x;
  float sl = sqrt(1.0 + (u / CAM_H) * (u / CAM_H));
  float lv = log2(uLine * z * sl);
  float lk = floor(lv);
  float lf = lv - lk;
  float s = exp2(lk);
  float fw = px * z * sl / s;
  float aR = p.y / uLine;
  float wR = clamp(tr * far * 1.2, 0.0, 0.72);
  float idB = floor(u / (2.0 * s) + 0.5) * 2.0 * s;
  wR *= burin(aR, idB * 3.7, tr);
  float ra = lines(u / s, wR, fw);
  float rb = lines(u / (2.0 * s), wR, fw * 0.5);
  float tar = mix(ra, rb, lf);
  float t2 = tr * far - 0.42;
  if (t2 > 0.0) {
    float phR = (p.x + p.y) * 0.7 / uLine;
    tar += lines(phR, clamp(t2 * 1.5, 0.0, 0.55) * burin((p.x - p.y) * 0.7 / uLine, floor(phR + 0.5) + 311.0, t2 + 0.25), fl) * (1.0 - tar);
  }
  tar *= 1.0 - paint;
  tar = max(tar, band(ax - ROAD_HALF, 0.55 * aa.x, aa.x) * far);
  float ink = mix(sand, tar, road);

  // CAST SHADOWS
  vec2 g = vec2(x, wz);
  float sh = max(shadowOf(g, ${POLES}, aa), rigShadow(g, aa));
  for (int side = 0; side < uLoop.w; side++) {
    float xs = side == 0 ? ${f(S.POST_X)} : -${f(S.POST_X)};
    sh = max(sh, shadowOf(g, xs, ${f(S.POST_SPACING_M)}, 13.0, ${f(S.POST_H)}, ${f(S.POST_W)}, aa));
  }
  ink += 0.72 * sh * far * (1.0 - ink);
  return mix(PAPER, INK, ink);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (uv - vec2(uVp, uHor)) * vec2(uAspect, 1.0) * uZoom;
  px = uZoom / uRes.y;
  fl = px / uLine;
  p0 = p;

  // HEAT SHIMMER
  float heat = exp(-abs(p.y + 0.01 * SKY_K) / (0.055 * SKY_K)) * uShimmer;
  heat *= 1.0 - smoothstep(0.03, 0.07, p.y);
  vec2 hq = p / uZoom;
  sway = flow(hq, 0.0);
  float rise = flow(hq, 4.7);
  p += vec2(sway, 0.7 * rise) * ${f(0.02 * S.HEAT_K)} * uZoom * heat;
  if (p.y < 0.0) {
    float zr = CAM_H / max(-p.y, PX_FLOOR);
    float onTar = 1.0 - smoothstep(ROAD_HALF - 0.3, ROAD_HALF + 0.6, abs(p.x * zr + uCam));
    float boil = exp(-abs(p.y) / (0.11 * SKY_K)) * onTar * uShimmer;
    p.x += rise * ${f(0.012 * S.HEAT_K)} * uZoom * boil;
  }

  bool aloft = p.y >= 0.0;
  vec3 c = PAPER;
  float m = 0.0;
  float z = 0.0;
  float edge = 0.0;
  vec2 r = p;
  if (!aloft) {
    vec2 pg = mix(p0, p, steady(CAM_H / max(-p0.y, PX_FLOOR)));

    // MIRAGE
    // over the sand a thin sheet at the foot of the dunes, wavering
    z = CAM_H / max(-pg.y, PX_FLOOR);
    float x = pg.x * z + uCam;
    float zn = z / uPuddle;
    float side = p.x / uFrame.y;
    float lip = (soft(vec2(p.x / uZoom * 6.0 + uTime * 0.12, uTime * 0.2)) - 0.5) * 0.3 * ${f(S.HEAT_K)};
    float reach = ${f(S.LAKE_M)} * (1.0 + 1.6 * side * side) * (1.0 + lip);
    m = smoothstep(reach * 0.985, reach * 1.015, z);

    // ROAD BANDS
    // each crest of the road's rise and fall catches the sky; fixed to the road, they re-space,
    // swell and merge into the pool as you drive, and slowly form and dissolve as the air moves
    float ex = px * z;
    float tarR = 1.0 - smoothstep(ROAD_HALF - ex, ROAD_HALF + ex, abs(x));
    float wzr = z + uTravel;
    float u = 0.55 * noise(wzr * 0.11) + 0.45 * noise(wzr * 0.29 + 4.0);
    float brk = mix(0.24, 0.05, smoothstep(1.0, 3.0, zn));
    u += brk * (soft(vec2(x * 0.6, wzr * 0.22)) - 0.5);
    u += 0.36 * (soft(vec2(x * 0.3 + uTime * 0.1, wzr * 0.07 - uTime * 0.3)) - 0.5) * min(uShimmer, 1.0);
    u += 0.04 * sway * uShimmer;
    float thr = 0.64 - 0.14 * smoothstep(1.0, 2.6, zn) - 0.6 * smoothstep(2.6, 4.6, zn);
    thr += 1.0 - smoothstep(1.3, 1.6, zn);
    float uw = max(fwidth(u), 1e-3);
    float mr = smoothstep(thr - uw, thr + uw, u);
    // a thin margin of bare paper round each band
    edge = smoothstep(thr - 3.5 * uw, thr - 1.5 * uw, u) * (1.0 - mr) * tarR;
    c = ground(pg);
    c = mix(c, PAPER, edge);
    m = mix(m, mr, tarR);
    r = vec2(p.x + rise * ${f(0.012 * S.HEAT_K)} * uZoom * uShimmer, -p.y);
  }

  // SKY
  // below the horizon, the water: the sky's lines folded down, rocking in long soft curves
  vec3 refl = PAPER;
  float tone = skyTone(p.y / SKY_K);
  vec2 at = p;
  if (aloft) {
    skyPh = p.y / uLine + 0.6 * heat * sway;
    skyA = p.x / uLine;
    cloudP = p0 / SKY_K;
  } else if (m > 0.0) {
    skyPh = -p.y / uLine + (1.1 * sway + 0.5 * rise) * min(uShimmer, 1.2);
    skyA = p.x / uLine + uTime * 0.6;
    at = vec2(r.x, r.y / ${f(S.MIRROR_K)});
    cloudP = at / SKY_K;
    tone = 0.1 + 0.2 * smoothstep(0.0, ${f(S.POOL_DEPTH)} * uZoom, -p.y);
  }
  if (aloft || m > 0.0) {
    vec3 s = above(at, vec2(r.x, r.y * ${f(S.DUNE_SQUASH)}), tone, !aloft);
    if (aloft) c = s;
    else refl = s;
  }

  // PASSES
  // the mirror first, then the scene, so near things stand in front of the water
  for (int pass = 0; pass < uLoop.w; pass++) {
    bool mirror = pass == 0;
    if (mirror && (aloft || m <= 0.0)) continue;
    vec2 qp = mirror ? r : p;
    float eye = mirror ? -CAM_H : CAM_H;
    float sq = mirror ? ${f(S.MIRROR_K)} : 1.0;
    water = mirror;
    vec3 t = mirror ? refl : c;
    devil(qp, eye, sq, t);
    for (int row = 0; row < uLoop.z; row++) {
      if (mirror && row > 0) break;
      bool pole = row == 0;
      posts(
        qp, eye, sq,
        pole ? uPoleX : row == 1 ? ${f(S.POST_X)} : -${f(S.POST_X)},
        pole ? ${f(S.POLE_SPACING_M)} : ${f(S.POST_SPACING_M)},
        pole ? ${f(S.POLE_PHASE_M)} : 13.0,
        pole ? ${f(S.POLE_H)} : ${f(S.POST_H)},
        pole ? ${f(S.POLE_W)} : ${f(S.POST_W)},
        pole, t
      );
    }
    if (!mirror && aloft) {
      wires(qp, t);
      hawk(p0, t);
    }
#ifndef LITE
    vec3 bare = t;
    for (int i = 0; i < uLoop.y; i++) vehicle(qp, eye, sq, uTraffic[i], t);
    t = mix(bare, t, uReveal);
#endif
    if (mirror) {
      t = mix(t, PAPER, fogAt(z) * 0.25);
      c = mix(c, t, m);
    } else c = t;
  }
  water = false;

  c = mix(c, INK, band(p0.y, 0.45 * px, px) * 0.8);
  outColor = vec4(c, 1.0);
}`;
