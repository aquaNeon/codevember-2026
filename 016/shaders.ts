export const SLOTS = 3;

// NOISE
// ashima 3d simplex
export const NOISE = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

// PROFILE
// Lycoperdon perlatum; body units, foot at y = 0
export const HEAD_A = 2.3; // change head-to-stem angle here
export const HEAD_T = 0.62;
export const STEM_IN = 0.34; // change stem taper here

// FORM
// stem length, crown flattening, foot pinch, age (0 young, 1 old)
export type Form = readonly [number, number, number, number];

export function headY(f: Form) {
  return f[0] - Math.cos(HEAD_A);
}

export function poreY(f: Form) {
  return headY(f) + (1 - f[1]) + 0.06 - 0.12 * f[3];
}

// OUTLINE
// vertex shader outline without pleats; out = [radius, height]
export function profile(th: number, f: Form, out: Float32Array) {
  const H = headY(f);
  if (th < HEAD_T) {
    const a = (th / HEAD_T) * HEAD_A;
    const c = Math.cos(a);
    out[0] = Math.sin(a);
    out[1] = H + (c > 0 ? c * (1 - f[1]) : c) + (0.06 - 0.12 * f[3]) * Math.exp(-a * a * 50);
  } else {
    const s = (th - HEAD_T) / (1 - HEAD_T);
    out[1] = f[0] * (1 - s);
    let r = Math.sin(HEAD_A) - STEM_IN * (2 * s - s * s);
    r *= 1 - f[2] * Math.exp(-(((s - 0.8) / 0.12) ** 2));
    const h = Math.min(1, Math.max(0, (s - 0.88) / 0.12));
    const k = h * h * (3 - 2 * h);
    out[0] = r * Math.sqrt(Math.max(0, 1 - k * k));
  }
}

const CONSTS = /* glsl */ `
uniform vec4 uForm;

const float PI = 3.14159265;
const float A = ${HEAD_A.toFixed(4)};
const float TH = ${HEAD_T.toFixed(4)};
const float STEM_IN = ${STEM_IN.toFixed(4)};
#define NECK uForm.x
#define H (uForm.x - cos(A))
#define FLAT uForm.y
#define PINCH uForm.z
#define AGE uForm.w
`;

// INK
// plate look helpers: hashes, cells, screen stipple, form lines
const INK = /* glsl */ `
uniform float uDpr;
uniform float uInkScale;

vec2 hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}

vec3 hash3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453);
}

// CELLS
// nearest point distance; 2x2x2 search, jitter held to the middle half of each cell
float cells(vec3 p) {
  vec3 i = floor(p - 0.5);
  vec3 f = p - i;
  float d = 8.0;
  for (int z = 0; z <= 1; z++)
    for (int y = 0; y <= 1; y++)
      for (int x = 0; x <= 1; x++) {
        vec3 g = vec3(float(x), float(y), float(z));
        vec3 r = g + 0.25 + 0.5 * hash3(i + g) - f;
        d = min(d, dot(r, r));
      }
  return sqrt(d);
}

// STIPPLE
// dot per screen cell under the tone; two rotated lattices hide the grid
float stipple(float tone, float cellPx) {
  float d = 0.0;
  for (int k = 0; k < 2; k++) {
    float fk = float(k);
    vec2 q = gl_FragCoord.xy / (uDpr * uInkScale * cellPx * (1.0 + 0.37 * fk));
    q = fk > 0.5 ? mat2(0.8, -0.6, 0.6, 0.8) * q + 13.7 : q;
    vec2 i = floor(q);
    vec2 h = hash2(i + fk * 41.0);
    vec2 f = fract(q) - 0.5 - (hash2(i + 17.0 + fk * 7.0) - 0.5) * 0.8;
    float on = step(h.x, tone * (0.62 - 0.12 * fk));
    float r = 0.15 + 0.12 * h.y;
    d = max(d, on * (1.0 - smoothstep(r, r + 0.1, length(f))));
  }
  return d;
}

// SINGLE LATTICE
// half the cost; hatching hides the grid on the bodies
float stipple1(float tone, float cellPx) {
  vec2 q = gl_FragCoord.xy / (uDpr * uInkScale * cellPx);
  vec2 i = floor(q);
  vec2 h = hash2(i);
  vec2 f = fract(q) - 0.5 - (hash2(i + 17.0) - 0.5) * 0.8;
  float r = 0.15 + 0.12 * h.y;
  return step(h.x, tone) * (1.0 - smoothstep(r, r + 0.1, length(f)));
}

// LINES
// engraved line at every whole x, width as a share of the spacing
float lines(float x, float width) {
  float w = fwidth(x);
  float f = abs(fract(x) - 0.5);
  return smoothstep(0.5 - width - w, 0.5 - width, f) * step(0.001, width);
}
`;

export const PUFF_VS = /* glsl */ `
uniform float uDeflate;
uniform vec4  uDent[${SLOTS}];

varying vec3  vNormal;
varying vec3  vView;
varying vec3  vPos;
varying float vDent;
varying float vSag;

${NOISE}
${CONSTS}

// BODY
// unit sphere direction in, body point out; rest is the undented point
vec3 body(vec3 n, out float dent, out vec3 rest, out float fold) {
  float th = acos(clamp(n.y, -1.0, 1.0)) / PI;
  float lxz = length(n.xz);
  vec2 dir = lxz > 1e-5 ? n.xz / lxz : vec2(1.0, 0.0);
  float phi = atan(dir.y, dir.x);
  float r;
  float y;
  if (th < TH) {
    float a = th / TH * A;
    float c = cos(a);
    r = sin(a);
    y = H + (c > 0.0 ? c * (1.0 - FLAT) : c);
    y += (0.06 - 0.12 * AGE) * exp(-a * a * 50.0);
  } else {
    // STEM
    // starts on the head's tangent so head and stem join smoothly
    float s = (th - TH) / (1.0 - TH);
    y = mix(NECK, 0.0, s);
    r = sin(A) - STEM_IN * (2.0 * s - s * s);
    r *= 1.0 - PINCH * exp(-pow((s - 0.8) / 0.12, 2.0));
    float wr = sin(phi * 11.0 + s * 3.0 + 0.6 * snoise(vec3(dir * 3.0, s * 2.0)));
    wr += 0.5 * sin(phi * 23.0 - s * 5.0);
    r *= 1.0 + 0.022 * wr * (smoothstep(0.1, 0.5, s) + smoothstep(0.55, 0.95, s));
    float heel = smoothstep(0.88, 1.0, s);
    r *= sqrt(max(0.0, 1.0 - heel * heel));
  }
  vec3 p = vec3(dir.x * r, y, dir.y * r);
  rest = p;

  vec3 out3 = normalize(p - vec3(0.0, min(p.y, H), 0.0) + vec3(0.0, 1e-4, 0.0));
  float head = smoothstep(NECK - 0.1, NECK + 0.3, p.y);

  // DIMPLES
  // pit with radial creases
  dent = 0.0;
  float push = 0.0;
  for (int i = 0; i < ${SLOTS}; i++) {
    vec3 d = uDent[i].xyz;
    float a = uDent[i].w;
    float c = 1.0 - dot(out3, d);
    float pit = exp(-c * 7.0);
    vec3 t = normalize(cross(d, vec3(0.0, 1.0, 0.0)) + vec3(1e-4, 0.0, 0.0));
    vec3 b = cross(d, t);
    float ang = atan(dot(out3, b), dot(out3, t));
    float ring = exp(-c * 2.6) - pit;
    float crease = 0.5 + 0.5 * sin(ang * 9.0);
    push += a * (pit + 0.14 * ring * crease * crease);
    dent += a * pit;
  }

  // SAG
  float sag = max(uDeflate, 0.75 * AGE);
  float upper = smoothstep(NECK, H + 0.9, p.y);
  // FOLDS
  // squared sin, not a root of |sin|, so folds round over without a seam
  float sf = sin(phi * 6.0 + 0.8 * snoise(p * 1.5));
  float f = sf * sf;
  push += sag * 0.06 * f * upper * (1.0 - upper * 0.6);
  p -= out3 * push * head;
  p.y = mix(p.y, NECK + (p.y - NECK) * (1.0 - 0.16 * sag), head);
  p.xz *= 1.0 + 0.06 * sag * head * (1.0 - upper);
  fold = sag * f * upper;
  return p;
}

void main() {
  vec3 n = normalize(position);
  vec3 t1 = normalize(cross(n, abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 t2 = cross(n, t1);
  float dent;
  float fold;
  float skip;
  vec3 rest;
  vec3 junk;
  vec3 p = body(n, dent, rest, fold);
  vec3 p1 = body(normalize(n + t1 * 0.01), skip, junk, skip);
  vec3 p2 = body(normalize(n + t2 * 0.01), skip, junk, skip);
  vec3 nrm = cross(p1 - p, p2 - p);
  // POLES
  // degenerate neighbour at the poles, fall back to straight up or down
  nrm = dot(nrm, nrm) > 1e-12 ? normalize(nrm) : vec3(0.0, sign(n.y), 0.0);
  vNormal = normalize(normalMatrix * nrm);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vView = -mv.xyz;
  vPos = rest;
  vDent = dent;
  vSag = fold;
  gl_Position = projectionMatrix * mv;
}
`;

export const PUFF_FS = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uFoot;
uniform vec3 uShade;
uniform vec3 uWart;
uniform vec3 uInk;

varying vec3  vNormal;
varying vec3  vView;
varying vec3  vPos;
varying float vDent;
varying float vSag;

${NOISE}
${CONSTS}
${INK}

vec3 bump(vec3 pos, vec3 N, float h) {
  vec3 dpx = dFdx(pos);
  vec3 dpy = dFdy(pos);
  float dhx = dFdx(h);
  float dhy = dFdy(h);
  vec3 r1 = cross(dpy, N);
  vec3 r2 = cross(N, dpx);
  float det = dot(dpx, r1);
  vec3 g = sign(det) * (dhx * r1 + dhy * r2);
  return normalize(abs(det) * N - g);
}

void main() {
#ifdef SECTION
  // CUTAWAY
  // near half discarded; the cut face is its own mesh
  if (vPos.z > 0.0) discard;
#endif
  vec3 Ng = normalize(vNormal);
  vec3 V = normalize(vView);
  float head = smoothstep(NECK - 0.2, NECK + 0.5, vPos.y);
  float crown = smoothstep(H - 0.2, H + 0.85, vPos.y);

  // WARTS
  float sd = cells(vPos * 8.0);
  float spine = 1.0 - smoothstep(0.0, 0.34, sd);
  float grain = 1.0 - smoothstep(0.0, 0.3, cells(vPos * 24.0 + 7.0));
  spine *= crown;
  grain *= head * (0.35 + 0.65 * crown);
  vec3 N = bump(-vView, Ng, spine * spine * 0.022 + grain * 0.006);

  vec3 L = normalize(vec3(-0.55, 0.75, 0.45));
  float wrap = dot(N, L) * 0.5 + 0.5;
  float diff = smoothstep(0.08, 1.0, wrap);
  float rim = pow(1.0 - max(dot(N, V), 0.0), 3.0);
  float pr = 0.035 + 0.07 * AGE;
  float pore = (1.0 - smoothstep(pr, pr + 0.025, length(vPos.xz))) * step(H + 0.4, vPos.y);
  float foot = 1.0 - smoothstep(0.0, 0.3, vPos.y);

#ifdef PLATE
  // PLATE
  // watercolour wash under ink stipple, hatching and a contour
  float edge = 1.0 - abs(dot(Ng, V));
  float tone = 1.0 - diff;
  tone += 0.4 * vSag + 0.35 * smoothstep(0.0, 0.25, vDent) + 0.3 * foot;
  tone = clamp(tone, 0.0, 1.0);
  vec3 wash = mix(uTop, uFoot, smoothstep(0.2, 0.8, tone));
  wash = mix(wash, uShade, smoothstep(0.65, 1.0, tone) * 0.5);
  wash *= 0.95 + 0.08 * snoise(vPos * 1.8 + 3.0);
  wash = mix(wash, uFoot * 0.92, smoothstep(0.55, 0.95, edge) * 0.35);
  float ink = stipple1(pow(tone, 1.7) * 0.55, 3.0);
  // HATCHING
  // rings round the body in shade, meridians across them in the deepest
  float phi = atan(vPos.z, vPos.x);
  ink = max(ink, lines(vPos.y * 30.0, 0.16 * smoothstep(0.6, 1.0, tone)) * 0.7);
  ink = max(ink, lines(phi * 9.5493, 0.14 * smoothstep(0.85, 1.0, tone)) * 0.55);
  // FLECKS
  // size held in screen px via fwidth, so it stays fine at any scale
  vec3 fw = fwidth(vPos * 8.0);
  float px = max(fw.x, max(fw.y, fw.z));
  float fr = min(px * 0.6 * uDpr * uInkScale, 0.1);
  ink = max(ink, (1.0 - smoothstep(fr, fr + px * 0.8, sd)) * crown * 0.85);
  ink = max(ink, smoothstep(0.85, 0.98, grain) * 0.3 * crown);
  ink = max(ink, pore);
  // CONTOUR
  float thr = 0.86 - 0.12 * tone;
  ink = max(ink, smoothstep(thr, thr + 0.05, edge));
  gl_FragColor = vec4(mix(wash, uInk, ink * 0.92), 1.0);
#else
  // GOUACHE
  vec3 base = mix(uFoot, uTop, smoothstep(0.0, H + 0.5, vPos.y));
  base *= 0.96 + 0.04 * snoise(vPos * 3.0) + 0.025 * snoise(vPos * 40.0);
  base = mix(base, uWart, spine * 0.75 + grain * 0.35);
  base = mix(base, uShade, spine * crown * smoothstep(0.6, 1.0, spine) * 0.3);
  base = mix(base, uShade * 0.45, pore);
  float lit = 0.4 + 0.6 * diff;
  lit *= 1.0 - 0.28 * smoothstep(0.0, 0.25, vDent) - 0.3 * foot;
  vec3 col = mix(uShade, base, lit);
  col = mix(col, uShade * 0.95, 0.4 * vSag);
  col += vec3(0.85, 0.62, 0.42) * max(-N.y, 0.0) * 0.18;
  col += vec3(1.0, 0.95, 0.86) * rim * 0.14;
  gl_FragColor = vec4(col, 1.0);
#endif
}
`;

// SECTION
// cut face, a flat shape in the body's xy plane
export const SECTION_VS = /* glsl */ `
varying vec2 vLocal;

void main() {
  vLocal = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const SECTION_FS = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uFoot;
uniform vec3 uShade;
uniform vec3 uInk;
uniform vec3 uGleba;

varying vec2 vLocal;

${NOISE}
${CONSTS}
${INK}

float stemR(float y) {
  float s = clamp((NECK - y) / NECK, 0.0, 1.0);
  float r = sin(A) - STEM_IN * (2.0 * s - s * s);
  return r * (1.0 - PINCH * exp(-pow((s - 0.8) / 0.12, 2.0)));
}

void main() {
  float x = abs(vLocal.x);
  float y = vLocal.y;
  float hy = y - H;
  hy = hy > 0.0 ? hy / (1.0 - FLAT) : hy;
  float R = y > NECK ? sqrt(max(0.0, 1.0 - hy * hy)) : stemR(y);
  float edge = R - x;

  // REGIONS
  // gleba: spore mass in the head; subgleba: sterile chambers in the stem
  float wob = 0.035 * snoise(vec3(vLocal * 4.0, 0.0));
  float g = length(vec2(x, hy));
  float gleba = 1.0 - smoothstep(0.83 + wob, 0.85 + wob, g);
  float floorY = NECK + 0.08 - 0.08 * x * x + wob;
  gleba *= smoothstep(floorY - 0.02, floorY + 0.02, y);
  float cotton = gleba * smoothstep(0.1, 0.75, hy);

  // GLEBA
  float clump = 0.5 + 0.5 * snoise(vec3(vLocal * 9.0, 3.0));
  float mott = 0.5 + 0.5 * snoise(vec3(vLocal * 3.0, 1.0));
  vec3 glebaCol = mix(uGleba, uGleba * vec3(1.12, 1.1, 0.92), mott);
  glebaCol = mix(glebaCol, mix(uGleba, uTop, 0.45), cotton * 0.6);
  float glebaTone = 0.42 + 0.35 * clump - 0.25 * cotton;
  vec2 w = vLocal * 7.0 + 0.6 * vec2(snoise(vec3(vLocal * 3.0, 5.0)), snoise(vec3(vLocal * 3.0, 9.0)));
  float threads = lines(w.x + w.y * 0.3, 0.035) * cotton * 0.35;

  // SUBGLEBA
  float cham = cells(vec3(vLocal * 15.0, 0.5));
  float ring = 1.0 - smoothstep(0.0, 0.07, abs(cham - 0.34));
  vec3 sub = mix(uTop, uFoot, 0.3 + 0.25 * (1.0 - smoothstep(0.0, NECK, y)));
  float subTone = 0.1 + 0.15 * (1.0 - smoothstep(0.0, 0.5, y));

  vec3 col = mix(sub, glebaCol, gleba);
  col *= 0.95 + 0.07 * snoise(vec3(vLocal * 2.5, 2.0));
  float tone = mix(subTone, glebaTone, gleba);
  float ink = stipple(tone * 0.9, 2.0);
  ink = max(ink, threads);
  ink = max(ink, ring * (1.0 - gleba) * 0.55 * smoothstep(0.08, 0.14, edge));

  // RIND
  float rind = 1.0 - smoothstep(0.05, 0.06, edge);
  col = mix(col, uTop, rind);
  ink = max(ink, 1.0 - smoothstep(0.006, 0.016, edge));
  ink = max(ink, (1.0 - smoothstep(0.003, 0.011, abs(edge - 0.058))) * 0.95);
  // SEAM
  float seam = (1.0 - smoothstep(0.0, 0.15, abs(gleba - 0.5))) * step(0.07, edge);
  ink = max(ink, seam * (0.4 + 0.4 * step(0.4, clump)));
  gl_FragColor = vec4(mix(col, uInk, ink * 0.92), 1.0);
}
`;

// CURL NOISE
// curl of three noise potentials by central differences
const CURL = /* glsl */ `
vec3 curl(vec3 p) {
  const float e = 0.1;
  vec3 dx = vec3(e, 0.0, 0.0);
  vec3 dy = vec3(0.0, e, 0.0);
  vec3 dz = vec3(0.0, 0.0, e);
  vec3 a = vec3(0.0, 31.3, 0.0);
  vec3 b = vec3(17.1, 0.0, 0.0);
  float pzy = snoise(p + dy + b) - snoise(p - dy + b);
  float pyz = snoise(p + dz + a) - snoise(p - dz + a);
  float pxz = snoise(p + dz) - snoise(p - dz);
  float pzx = snoise(p + dx + b) - snoise(p - dx + b);
  float pyx = snoise(p + dx + a) - snoise(p - dx + a);
  float pxy = snoise(p + dy) - snoise(p - dy);
  return vec3(pzy - pyz, pxz - pzx, pyx - pxy) / (2.0 * e);
}
`;

export const SPORE_VS = /* glsl */ `
uniform float uTime;
uniform float uPx;
uniform float uDpr;

attribute vec3  aOrigin;
attribute vec3  aVel;
attribute vec2  aBirth;

varying float vAlpha;
varying float vSeed;
varying float vAge;
varying float vGrain;

${NOISE}
${CURL}

void main() {
  float age = uTime - aBirth.x;
  float seed = aBirth.y;
#ifdef PLATE
  float grain = step(0.06, fract(seed * 13.7));
#else
  float grain = step(0.88, fract(seed * 13.7));
#endif
  float life = mix(5.0, 3.5, grain) + 2.5 * fract(seed * 7.13);
  vSeed = seed;
  vGrain = grain;
  vAge = age;
  if (age < 0.0 || age > life) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vAlpha = 0.0;
    return;
  }
  // DRIFT
  // pore jet with drag, then a slow rise advected by curl noise
  float tau = 0.18 + 0.3 * fract(seed * 5.31);
  vec3 p = aOrigin + aVel * tau * (1.0 - exp(-age / tau));
  float open = 1.0 - exp(-age / 1.2);
  p.xz += aVel.xz * 0.5 * open;
  p.y += 0.08 * age;
  p.x += 0.07 * age;
  vec3 q = aOrigin * 0.6 + (p - aOrigin) * 0.9 + vec3(0.0, -uTime * 0.05, 0.0);
  p += curl(q) * 0.16 * open * (1.0 + 0.5 * grain);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float r = fract(seed * 3.7);
  float t = age / life;
  vAlpha = smoothstep(0.0, 0.06, age) * (1.0 - t) * (1.0 - t);
#ifdef PLATE
  gl_PointSize = grain > 0.5
    ? uDpr * (1.1 + 1.3 * r * r)
    : min(uPx * (0.3 + 0.9 * open) / -mv.z, 512.0);
#else
  float size = grain > 0.5 ? 0.03 + 0.02 * r : (0.12 + 0.7 * open) * (0.6 + 0.7 * r);
  gl_PointSize = min(uPx * size / -mv.z, 512.0);
#endif
}
`;

export const SPORE_FS = /* glsl */ `
uniform vec3 uDust;
uniform vec3 uDustHi;
uniform vec3 uInk;

varying float vAlpha;
varying float vSeed;
varying float vAge;
varying float vGrain;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot(c, c) * 4.0;
  if (d2 > 1.0) discard;
  float fresh = exp(-vAge * 1.1);
#ifdef PLATE
  float dotA = 1.0 - smoothstep(0.55, 1.0, d2);
  float washA = exp(-d2 * 3.0) * 0.035;
  vec3 col = mix(uDustHi, uInk, vGrain);
  float a = vAlpha * mix(washA, dotA * (0.55 + 0.35 * fresh), vGrain);
#else
  // GAUSSIAN HAZE
  float soft = max(exp(-d2 * 3.2) - 0.04, 0.0);
  vec3 col = mix(uDustHi, uDust, 0.1 + 0.35 * fresh);
  col *= 0.95 + 0.1 * fract(vSeed * 11.0);
  float a = soft * vAlpha * mix(0.05 + 0.08 * fresh, 0.4, vGrain);
#endif
  gl_FragColor = vec4(col * a, a);
}
`;
