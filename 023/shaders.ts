export const FULL_VS = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const BUBBLES = 6;
export const SPLASH = 17;
export const SCARS = BUBBLES * 3;
// MATERIAL FRAME
// plate domain divided back to sphere units
export const MAT_SCALE = [1.65, 3.7, 1.65] as const;

export const MAGMA_FS = `#version 300 es
precision highp float;

uniform vec2  uRes;
uniform vec3  uView;
uniform mat3  uRot;
uniform float uTau;
uniform float uState;
uniform vec4  uHeat;
uniform vec4  uSpot[${BUBBLES + SCARS}];
uniform vec4  uSpotObj[${BUBBLES}];
uniform int   uCells;
uniform int   uBubN;
uniform int   uIter;
uniform int   uSplash;
uniform int   uOct;
uniform int   uSpotN;

out vec4 outColor;

const float HMAX = 0.16;
const float CAM_Z = 5.0;
const int   STEPS = 22;
const vec3  BG = vec3(0.0);
const float BURST = 0.5;
const float CRUST = 1.06;
const vec3  MAT = vec3(${MAT_SCALE.join(", ")});

// NOISE
float h13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
vec3 h33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}
float vn(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(h13(i), h13(i + vec3(1, 0, 0)), f.x),
        mix(h13(i + vec3(0, 1, 0)), h13(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(h13(i + vec3(0, 0, 1)), h13(i + vec3(1, 0, 1)), f.x),
        mix(h13(i + vec3(0, 1, 1)), h13(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float fbm(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  // FBM
  // uniform loop bound keeps the octaves rolled, so the compile stays short
  for (int i = 0; i < uOct; i++) {
    s += a * vn(p);
    p = p * 2.03 + 17.1;
    a *= 0.5;
  }
  return s;
}
// RIDGED
float ridge(vec3 p) {
  return 1.0 - abs(2.0 * vn(p) - 1.0);
}

// CELLS
// cellular noise: x nearest, y second, z cell id; cc the nearest seed
vec3 vor(vec3 q, out vec3 cc) {
  vec3 i = floor(q);
  vec3 f = fract(q);
  float f1 = 9.0;
  float f2 = 9.0;
  float id = 0.0;
  cc = vec3(0.0);
  for (int k = 0; k < uCells; k++) {
    vec3 g = vec3(float(k % 3), float((k / 3) % 3), float(k / 9)) - 1.0;
    vec3 o = h33(i + g) * 0.8 + 0.1;
    vec3 r = g + o - f;
    float d = dot(r, r);
    if (d < f1) {
      f2 = f1;
      f1 = d;
      cc = i + g + o;
      id = h13(i + g + 7.7);
    } else if (d < f2) {
      f2 = d;
    }
  }
  return vec3(sqrt(f1), sqrt(f2), id);
}

struct Surf {
  float h;
  float plate;
  float gap;
  float open;
  float hot;
  float skin;
  float edge;
  float thin;
  float fresh;
  float crack;
  float ember;
  float scar;
  float id;
  vec3  q;
};

mat2 rot(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c);
}

// DOMAIN
// latitude-dependent twist about y, oscillating over the loop, plus noise warp
vec3 domain(vec3 n) {
  vec3 m = n;
  m.xz = rot(0.16 * sin(uTau + n.y * 2.4)) * m.xz;
  vec3 loop = vec3(cos(uTau), sin(uTau), 0.0) * 0.18;
  vec3 w = vec3(vn(m * 2.1 + loop), vn(m * 2.1 + 31.0 - loop), vn(m * 2.1 + 57.0 + loop.yxz));
  return m * MAT + (w - 0.5) * 1.25;
}

// SURFACE
// mode 0 march, 1 adds fine relief for normals, 2 adds melt texture
Surf surf(vec3 n, int mode) {
  Surf s;
  vec3 q = domain(n);
  // MATERIAL SPACE
  // bubbles and scars live here, so they ride the plate's shear and drift
  vec3 md = normalize(q / MAT);
  vec3 cc;
  // PLATES
  // one vor() call site for plates and melt cells; inlining twice doubles the compile
  vec3 v = vec3(0.0);
  vec3 cv = vec3(0.0, 1.0, 0.0);
  int passes = mode == 2 ? 2 : 1;
  for (int pi = 0; pi < passes; pi++) {
    vec3 c0;
    vec3 at = pi == 0 ? q : q * 3.4 + vec3(sin(uTau), cos(uTau), 0.0) * 0.6;
    vec3 r0 = vor(at, c0);
    if (pi == 0) {
      v = r0;
      cc = c0;
    } else cv = r0;
  }
  float e = v.y - v.x + 0.09 * (vn(q * 6.5) - 0.5);
  s.id = v.z;
  s.q = q;

  // OPEN
  // latitude bands, noise-warped, width oscillating over the loop
  float band = sin(n.y * 5.2 + 2.2 * vn(n * 1.6 + 4.0) - uTau);
  float open = smoothstep(0.45, 0.97, band) * (0.25 + 0.75 * uState);
  float hdot = max(dot(n, uHeat.xyz), 0.0);
  open += uHeat.w * 0.13 * smoothstep(0.9, 1.0, hdot);

  // CRUST
  // seams either fused into folds or open as cracks
  float fuse = smoothstep(0.42, 0.6, vn(q * 0.9 + 13.0));
  float w = mix(-0.06, 0.045, fuse) + 0.38 * open;
  vec3 rnd = h33(cc * 3.1) - 0.5;
  float bevel = mix(0.3, 0.05 + 0.14 * (rnd.z + 0.5), fuse);
  float c = clamp((e - w) / bevel, 0.0, 1.0);
  float prof = pow(c * (2.0 - c), 0.65) * step(0.0001, c);

  float thick = 0.06 + 0.03 * (vn(q * 0.7 + 3.0) - 0.5);
  float tilt = 0.014 * dot(q - cc, normalize(rnd + vec3(0.0, 0.25, 0.0)));
  float pillow = 0.026 * (1.0 - smoothstep(0.0, 0.85, v.x));
  float ph = prof * (thick + tilt + pillow);

  // MELT LEVEL
  vec3 flow = q * 2.2 + vec3(cos(uTau), 0.0, sin(uTau)) * 0.7;
  float churn = fbm(flow);
  float melt = 0.004 * churn;

  // CRUST OR MELT
  // open bands win; crater and scar detail only on crust, edge broken by churn noise
  float crustK = mix(1.0, smoothstep(0.05, 0.4, prof + 0.3 * (churn - 0.5)), smoothstep(0.05, 0.3, open));

  // BUBBLES
  // swell, thin and crack the crust, tear open, skin over
  float lift = 0.0;
  float thin = 0.0;
  float rimC = 0.0;
  float pCov = 0.0;
  vec3  pSite = vec3(0.0);
  float pX = 1.0;
  float pHeat = 0.0;
  float pAge = 0.0;
  float pFront = 0.0;
  float crack = 0.0;
  float hole = 0.0;
  float bubHot = 0.0;
  float skin = 0.0;
  float rip = 0.0;
  // SPOTS
  // live bubbles, then scars (w = 2 + age); shared noise sampled outside the loop
  float nearest = 9.0;
  for (int i = 0; i < uSpotN; i++) {
    vec4 b = uSpot[i];
    if (b.w <= 0.0 || (b.w >= 1.0 && b.w < 2.0)) continue;
    nearest = min(nearest, length(md - b.xyz));
  }
  float N9 = 0.5;
  float N31 = 0.5;
  float tex = 0.5;
  float N55 = 0.5;
  float craze = 0.0;
  if (nearest < 0.26) {
    N9 = vn(md * 9.0);
    N31 = vn(md * 31.0);
    float N14 = vn(md * 14.0);
    tex = 0.6 * vn(md * 16.0 + 5.0) + 0.4 * N31;
    N55 = vn(md * 55.0);
    vec3 cz = md * 44.0 + 1.5 * (vec3(N9, N14, N31) - 0.5);
    craze = max(ridge(cz), ridge(cz * 0.55 + 7.0) * 0.98);
  }
  float wob = 1.0 + 0.3 * (N9 - 0.5) + 0.55 * (N31 - 0.5) + 0.3 * (N55 - 0.5);
  for (int i = 0; i < uSpotN; i++) {
    vec4 b = uSpot[i];
    bool isScar = b.w >= 2.0;
    if (!isScar && (b.w <= 0.0 || b.w >= 1.0)) continue;
    float d = length(md - b.xyz);
    if (d > 0.26) continue;
    float u = b.w;
    float r = 0.065 + 0.03 * h13(b.xyz * 7.0);
    if (!isScar && u < BURST) {
      float k = u / BURST;
      float x = d / (r * (0.55 + 0.45 * k));
      float dm = max(0.0, 1.0 - x * x);
      lift = max(lift, 0.075 * k * k * dm * sqrt(dm));
      thin = max(thin, k * k * smoothstep(1.0, 0.1, x));
      float cr = craze;
      float cw = (0.02 + 0.18 * k * k) * smoothstep(1.1, 0.0, x);
      crack = max(crack, smoothstep(1.0 - cw, 1.0 - cw * 0.3, cr) * smoothstep(1.0, 0.35, x) * smoothstep(0.15, 0.5, k));
      bubHot = max(bubHot, (0.6 + 0.35 * k) * smoothstep(1.0, 0.0, x));
    } else {
      float k = isScar ? 1.0 : (u - BURST) / (1.0 - BURST);
      float a = isScar ? u - 2.0 : 0.0;
      float sag = 1.0 - smoothstep(0.0, 0.035, k);
      float xd = d / r;
      float dm = max(0.0, 1.0 - xd * xd);
      lift = max(lift, 0.075 * sag * dm * sqrt(dm));
      float R = r * (0.3 + 0.62 * smoothstep(0.0, 0.05, k));
      float x = d / (R * wob);
      float inHole = smoothstep(1.1, 0.88, x);
      float keep = isScar ? smoothstep(a * 1.2 - 0.14, a * 1.2, tex) : 1.0;
      rimC = max(rimC, 0.011 * exp(-pow((x - 1.08) / 0.13, 2.0)) * (0.4 + N55) * smoothstep(0.0, 0.08, k) * keep * (1.0 - a));
      float close = 1.0 - pow(1.0 - smoothstep(0.1, 1.0, k), 1.6);
      float front = 1.02 * (1.0 - close);
      float xf = x + 0.22 * (tex - 0.5);
      float pool = inHole * smoothstep(front, front - 0.06, xf);
      float heal = mix(1.0 - smoothstep(0.0, 0.25, k), 1.0, crustK);
      hole = max(hole, pool);
      lift = max(lift, -0.01 * pool * heal * (1.0 - smoothstep(0.15, 0.7, k)));
      float rr = k * 0.55;
      rip += (1.0 - crustK) * 0.008 * sin((d - rr) * 110.0) * exp(-k * 7.0) * smoothstep(rr + 0.02, rr - 0.08, d) * smoothstep(0.0, 0.02, k);
      float cool = 0.72 + 0.28 * smoothstep(1.0, 0.2, x);
      bubHot = max(bubHot, pool * heal * cool * mix(0.88, 0.6, smoothstep(0.04, 0.6, k)));
      skin = max(skin, pool * heal * crustK * smoothstep(front - 0.1, front, xf) * 0.5);
      float cov = inHole * (1.0 - pool) * keep;
      if (cov > pCov) {
        pCov = cov;
        pSite = b.xyz;
        pX = x;
        pHeat = isScar ? 0.4 * exp(-a * 3.5) : mix(1.0, 0.4, close);
        pAge = a;
        pFront = exp(-max(xf - front, 0.0) / 0.07) * (1.0 - close);
      }
    }
  }

  skin = max(skin, thin * (1.0 - crustK) * 0.45);
  thin *= crustK;
  crack *= crustK;
  rimC *= crustK;
  float melting = pCov * crustK * (1.0 - crustK) * 4.0;
  pCov *= crustK;
  melt += rip;

  float ph0 = ph;
  if (mode > 0 && prof > 0.0) {
    // RELIEF
    vec3 sd = normalize(vec3(rnd.y, 2.5, rnd.z));
    float rp = dot(q - cc, sd) * 26.0 + 9.0 * fbm(q * 1.7 + rnd * 9.0);
    float rope = 1.0 - abs(sin(rp));
    rope = rope * rope * (1.0 - 0.6 * smoothstep(0.0, 1.0, prof * prof));
    float fold = ridge(q * 2.4 + rnd * 4.0);
    float wrinkle = vn(q * 11.0) + 0.5 * vn(q * 23.0) + 0.25 * vn(q * 47.0);
    float swell = fbm(q * 2.6 + rnd * 5.0);
    float grain = vn(q * 95.0) + 0.5 * vn(q * 190.0);
    float pit = smoothstep(0.72, 0.86, vn(q * 52.0 + 7.0));
    ph += prof * (0.0045 * rope + 0.01 * fold * fold + 0.004 * (wrinkle - 0.875) +
      0.022 * (swell - 0.5) + 0.0011 * (grain - 0.75) - 0.0028 * pit);
  }

  ph += lift;
  melt += lift * (1.0 - hole);
  ph = melt + max(ph - melt, 0.0) * (1.0 - 0.75 * thin);
  ph -= crack * 0.006;
  ph += rimC;

  // NEW CRUST
  // ropy rings over a crater, bent by the plate's folds; glow lingers in cracks
  float ember = 0.0;
  if (pCov > 0.0) {
    vec3 sd = pSite * 13.0;
    float ring = 0.5 + 0.5 * sin(26.0 * sqrt(pX) + 8.0 * vn(q * 5.0 + sd));
    ring *= smoothstep(0.3, 0.7, vn(q * 9.0 - sd));
    float grain = vn(q * 60.0 + sd) + 0.5 * vn(q * 120.0 - sd);
    float nh = 0.064 + 0.006 * smoothstep(0.9, 0.2, pX) + 0.0035 * ring * ring + 0.0016 * (grain - 0.75);
    float own = ph - ph0;
    ph = mix(ph, melt + lift + nh * mix(0.45, 1.0, prof) + own * 0.7, pCov);
    float cracks = smoothstep(0.86, 0.97, ridge(md * 58.0 + sd));
    float spots = smoothstep(0.8, 0.93, vn(md * 36.0 + sd));
    ember = pCov * max(pFront * 0.9, (cracks + 0.8 * spots * smoothstep(0.7, 0.0, pX)) * pHeat);
  }
  ember = max(ember, melting * 0.7);
  ph = mix(ph, melt - 0.006, hole);

  s.h = max(ph, melt);
  s.plate = ph > melt ? max(mix(prof, 1.0, pCov) * (1.0 - hole), 0.02) : 0.0;
  s.ember = ember;
  s.scar = pCov * (1.0 - pAge);
  s.gap = clamp((w - e) / max(w, 0.02), 0.0, 1.0);
  s.edge = max(e - w, 0.0);
  s.open = open;
  s.thin = thin;
  s.crack = crack;
  s.fresh = max(exp(-s.edge / 0.08) * (1.0 - fuse * 0.6), s.scar * 0.85);

  // MELT HEAT
  // thin cracks stay red-orange, wide bands reach yellow-white cores
  vec3 fq = q * vec3(3.0, 6.0, 3.0) + vec3(sin(uTau), 0.0, cos(uTau)) * 0.9;
  float vein = ridge(fq);
  vein = vein * vein;
  float t = 0.45 + 0.08 * open + 0.12 * s.gap * open + 0.1 * s.gap;
  t += 0.16 * (churn - 0.5) + 0.18 * (vein - 0.35) * (0.4 + open);
  float conv = 1.0;
  if (mode == 2) {
    // CONVECTION
    conv = smoothstep(0.0, 0.1, cv.y - cv.x);
    float swirl = fbm(q * 7.0 - vec3(cos(uTau), 0.0, sin(uTau)) * 1.2);
    t += 0.1 * (conv - 0.6) + 0.12 * (swirl - 0.5);
  }
  t = max(t, bubHot + 0.28 * (churn - 0.5));
  t += rip * 45.0;
  skin = max(skin, smoothstep(0.62, 0.8, churn + 0.22 * (1.0 - open) - 0.12 * s.gap - 0.2 * vein));
  skin = max(skin, (1.0 - conv) * 0.3 * (1.0 - 0.5 * open));
  skin *= 1.0 - crack;
  s.skin = skin;
  s.hot = clamp(t, 0.0, 1.0);
  return s;
}

// BLACKBODY
// linear ramp, before tone mapping
vec3 ramp(float t) {
  vec3 c = mix(vec3(0.0), vec3(0.4, 0.004, 0.0), smoothstep(0.0, 0.25, t));
  c = mix(c, vec3(1.6, 0.05, 0.0), smoothstep(0.25, 0.5, t));
  c = mix(c, vec3(3.0, 0.3, 0.006), smoothstep(0.5, 0.7, t));
  c = mix(c, vec3(4.5, 1.3, 0.08), smoothstep(0.7, 0.9, t));
  c = mix(c, vec3(6.0, 3.6, 1.3), smoothstep(0.93, 1.0, t));
  return c;
}

vec2 sphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float h = b * b - c;
  if (h < 0.0) return vec2(-1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

// RAY-SEGMENT
// closest approach: x distance, y ray depth; pa nearest point, h along the segment
vec2 segRay(vec3 o, vec3 d, vec3 a, vec3 b, out vec3 pa, out float h) {
  vec3 ba = b - a;
  vec3 oa = o - a;
  float bb = dot(ba, ba) + 1e-8;
  float bd = dot(ba, d);
  float od = dot(oa, d);
  float ob = dot(oa, ba);
  float den = bb - bd * bd;
  h = clamp((ob - od * bd) / max(den, 1e-8), 0.0, 1.0);
  pa = a + ba * h;
  float t = max(dot(pa - o, d), 0.0);
  return vec2(length(o + d * t - pa), t);
}

// SPLASH PIECES
// xyzw: spread angle, range, peak height, flight time; kind 0 drop, 1 ligament, 2 ember
vec4 piece(int i, int j, out float r, out float lag, out float kind, out float delay) {
  vec3 h = h33(vec3(float(i) * 7.3 + 1.0, float(j) * 3.1 + 2.0, 5.1));
  vec3 g = h33(vec3(float(j) * 5.7 + 9.0, float(i) * 1.9 + 4.0, 2.3));
  float ang = (float(j) + 0.8 * g.x) * 2.3999 + float(i);
  delay = 0.03 * g.y * g.y;
  if (j < 8) {
    kind = 0.0;
    r = 0.006 + 0.015 * h.z * h.z;
    lag = 0.06 + 0.06 * h.x;
    return vec4(ang, 0.035 + 0.17 * h.y * h.y, 0.02 + 0.09 * g.z, 0.05 + 0.06 * h.y);
  }
  if (j < 11) {
    kind = 1.0;
    r = 0.0035 + 0.002 * h.z;
    lag = 0.5;
    return vec4(ang, 0.05 + 0.08 * h.y, 0.05 + 0.05 * h.z, 0.05 + 0.03 * h.y);
  }
  kind = 2.0;
  r = 0.0028 + 0.0036 * h.z;
  lag = 0.22 + 0.14 * g.z;
  return vec4(ang, 0.14 + 0.3 * h.y, 0.08 + 0.16 * h.z * g.x, 0.1 + 0.1 * h.x);
}

vec3 arc(vec3 up, vec3 dir, vec4 pc, float k) {
  return normalize(up + dir * pc.y * k) * (CRUST + pc.z * 4.0 * k * (1.0 - k));
}

void main() {
  vec2 p = (gl_FragCoord.xy - uView.xy) / uView.z;
  vec3 ro = vec3(0.0, 0.0, CAM_Z);
  vec3 rd = normalize(vec3(p, 0.0) - ro);
  float px = 1.1 / uView.z;

  vec2 outer = sphere(ro, rd, 1.0 + HMAX + 0.2);
  if (outer.x < 0.0) {
    outColor = vec4(BG, 1.0);
    return;
  }

  mat3 inv = transpose(uRot);
  vec3 o = inv * ro;
  vec3 d = inv * rd;
  vec2 shell = sphere(o, d, 1.0 + HMAX);
  vec2 inner = sphere(o, d, 0.985);
  float t0 = shell.x;
  float t1 = inner.x > 0.0 ? inner.x : shell.y;

  // MARCH
  // one loop, one surf() call site: fixed steps, bisection, 4 normal taps, final hit
  float dt = (t1 - t0) / float(STEPS);
  float ta = t0;
  float tb = -1.0;
  float fa = 1.0;
  float fb = -1.0;
  int phase = shell.x > 0.0 ? 0 : 9;
  int k = 0;
  vec3 pos = vec3(0.0);
  vec4 grad = vec4(0.0);
  Surf hit;
  for (int i = 0; i < uIter; i++) {
    if (phase == 9) break;
    vec3 at;
    float tm = 0.5 * (ta + tb);
    vec3 e = vec3(k == 0 || k == 3 ? 1.0 : -1.0, k == 2 || k == 3 ? 1.0 : -1.0, k == 1 || k == 3 ? 1.0 : -1.0);
    if (phase == 0) at = o + d * (t0 + dt * float(k));
    else if (phase == 1) at = o + d * tm;
    else if (phase == 2) at = pos + e * 0.0018;
    else at = pos;
    float r = length(at);
    Surf s = surf(at / r, phase == 3 ? 2 : phase == 2 ? 1 : 0);
    float f = r - 1.0 - s.h;
    if (phase == 0) {
      if (f < 0.0) {
        tb = t0 + dt * float(k);
        fb = f;
        phase = 1;
        k = 0;
      } else {
        ta = t0 + dt * float(k);
        fa = f;
        k++;
        if (k > STEPS) break;
      }
    } else if (phase == 1) {
      if (f < 0.0) {
        tb = tm;
        fb = f;
      } else {
        ta = tm;
        fa = f;
      }
      k++;
      if (k >= 5) {
        float th = ta + (tb - ta) * fa / max(fa - fb, 1e-5);
        pos = o + d * th;
        phase = 2;
        k = 0;
      }
    } else if (phase == 2) {
      grad.xyz += e * f;
      k++;
      if (k >= 4) phase = 3;
    } else {
      hit = s;
      grad.w = 1.0;
      break;
    }
  }

  float th = grad.w > 0.0 ? dot(pos - o, d) : 1e9;
  vec3 col = BG;

  // SPLASH AND SPATTER
  // drops, ligaments and ember streaks along their ballistic arcs, then landing splats
  vec3 hn = grad.w > 0.0 ? normalize(pos) : vec3(0.0);
  float splat = 0.0;
  float splatHot = 0.0;
  vec3 fC = vec3(0.0);
  float fA = 0.0;
  vec3 Lw = normalize(vec3(-0.55, 0.65, 0.55));
  for (int i = 0; i < uBubN; i++) {
    vec4 b = uSpot[i];
    if (b.w <= BURST) continue;
    vec3 up = normalize(uSpotObj[i].xyz);
    bool landed = grad.w > 0.0 && length(hn - up) < 0.5;
    vec2 bound = sphere(o - up * 1.12, d, 0.55);
    bool flying = b.w < BURST + 0.3 && (bound.x > 0.0 || bound.y > 0.0);
    if (!landed && !flying) continue;
    vec3 ta1 = normalize(cross(up, abs(up.y) < 0.9 ? vec3(0, 1, 0) : vec3(1, 0, 0)));
    vec3 tb1 = cross(up, ta1);
    for (int j = 0; j < uSplash; j++) {
      float r;
      float lag;
      float kind;
      float delay;
      vec4 pc = piece(i, j, r, lag, kind, delay);
      vec3 dir = ta1 * cos(pc.x) + tb1 * sin(pc.x);
      bool em = kind == 2.0;
      float age = b.w - BURST - delay - pc.w;
      if (landed && kind != 1.0 && age > 0.0 && age < (em ? 0.14 : 0.45)) {
        vec3 L = normalize(up + dir * pc.y);
        float rm = em ? r * 1.6 : r * 2.4;
        vec3 tl = hn - L;
        float dd = length(vec2(dot(tl, dir) * 0.6, dot(tl, cross(L, dir))));
        dd += rm * 0.35 * (vn(hn * 110.0 + float(j) * 3.0) - 0.5);
        float m = smoothstep(rm, rm * 0.45, dd);
        float hot = (1.0 - smoothstep(0.0, em ? 0.14 : 0.16, age)) * (em ? 0.8 : 1.0);
        float fade = em ? 0.0 : 1.0 - smoothstep(0.18, 0.45, age);
        splat = max(splat, m * fade);
        splatHot = max(splatHot, m * hot);
      }
      float k = (b.w - BURST - delay) / pc.w;
      if (!flying || k <= 0.0 || k >= 1.0) continue;
      // EMBER STREAK
      // two segments per arc so the streak bends
      int segs = em ? 2 : 1;
      for (int sg = 0; sg < segs; sg++) {
        float fs = float(sg);
        float k1 = em ? k - lag * 0.5 * fs : k;
        float k0 = em ? k - lag * 0.5 * (fs + 1.0) : k - lag;
        vec3 head = arc(up, dir, pc, k1);
        vec3 tail = arc(up, dir, pc, max(k0, 0.0));
        vec3 pa;
        float h;
        vec2 sr = segRay(o, d, tail, head, pa, h);
        if (sr.y > th) continue;
        float g = em ? (h + 1.0 - fs) * 0.5 : h;
        float rr = kind == 0.0 ? r * mix(0.55, 1.0, g) : kind == 1.0 ? r * (1.0 - smoothstep(0.35, 0.6, k)) : r * mix(0.08, 1.0, g * g * g);
        float re = max(rr, px);
        float cov = smoothstep(re, re * 0.45, sr.x) * min(1.0, rr / px);
        if (cov <= 0.0) continue;
        float core = sqrt(max(1.0 - (sr.x / re) * (sr.x / re), 0.0));
        vec3 c;
        if (em) {
          float temp = (1.0 - 0.7 * k) - 0.5 * (1.0 - g);
          c = ramp(clamp(temp, 0.0, 1.0)) * (0.6 + 0.6 * g + 1.2 * smoothstep(0.85, 1.0, g));
          cov *= smoothstep(0.0, 0.3, g);
        } else {
          float temp = mix(0.97, 0.62, k);
          vec3 nb = normalize((o + d * sr.y - pa) / re - d * core);
          float glint = pow(max(dot(reflect(rd, uRot * nb), Lw), 0.0), 24.0);
          c = ramp(temp * (0.58 + 0.42 * core)) + vec3(1.0, 0.7, 0.5) * glint * 0.6;
        }
        fC += c * cov * (1.0 - fA);
        fA += cov * (1.0 - fA);
      }
    }
  }


  if (grad.w > 0.0) {
    vec3 n = normalize(pos);
    Surf s = hit;
    vec3 nrm = uRot * normalize(grad.xyz);
    vec3 nw = uRot * n;
    vec3 v = -rd;

    // MELT
    // emissive under a translucent skin, plus specular sheen
    float facing = max(dot(nrm, v), 0.0);
    float sk = s.skin * (0.75 + 0.5 * vn(s.q * 38.0));
    vec3 melt = ramp(s.hot) * mix(1.0, 0.1 + 0.08 * s.hot, clamp(sk, 0.0, 1.0)) * mix(0.6, 1.0, facing);

    // CRUST
    // basalt albedo; glassy sheen on fresh crust
    vec3 L = normalize(vec3(-0.55, 0.65, 0.55));
    float dif = max(dot(nrm, L), 0.0);
    vec3 hv = normalize(L + v);
    float nh = max(dot(nrm, hv), 0.0);
    float a2 = mix(0.32, 0.07, s.fresh);
    float dd = nh * nh * (a2 - 1.0) + 1.0;
    float spec = a2 / (3.1416 * dd * dd);
    float fres = 0.04 + 0.5 * pow(1.0 - facing, 5.0);
    float hgt = clamp(s.h / 0.09, 0.0, 1.0);
    // AO
    float ao = mix(0.15, 1.0, smoothstep(0.0, 0.7, s.plate)) * mix(0.45, 1.0, hgt);
    float hue = vn(s.q * 1.3 + 4.0);
    float tone = (0.75 + 0.5 * s.id) * (0.7 + 0.6 * vn(s.q * 5.0 + s.id * 40.0));
    vec3 alb = mix(vec3(0.026, 0.026, 0.027), vec3(0.034, 0.027, 0.021), hue) * tone;
    alb *= (1.0 - 0.55 * splat) * (1.0 - 0.35 * s.scar);
    vec3 rock = alb * (dif * vec3(1.5, 1.46, 1.42) + vec3(0.08, 0.085, 0.1) * (0.4 + 0.6 * nrm.y)) * ao;
    rock += spec * fres * (0.6 + 0.8 * s.fresh) * vec3(0.9, 0.92, 1.0) * ao * smoothstep(0.0, 0.25, dif);

    // MELT LIGHT
    // melt as an emitter lighting nearby walls
    float face = max(dot(nrm, nw), 0.0);
    float wall = (1.0 - s.plate) * (1.0 - 0.4 * face) + 0.05;
    float near = exp(-s.plate * 4.0);
    rock += ramp(min(1.0, s.hot + 0.05)) * 0.5 * wall * near;
    // SEAM GLOW
    rock += ramp(s.hot * 0.8) * 0.07 * exp(-s.edge / 0.04) * (1.0 - s.skin * 0.5);
    rock += ramp(0.46) * 0.35 * exp(-s.edge / 0.01) * (1.0 - smoothstep(0.0, 0.6, s.plate));
    rock += ramp(0.42 + 0.42 * s.thin) * s.thin * sqrt(s.thin) * 0.7;
    rock = mix(rock, ramp(0.6 + 0.3 * s.thin), s.crack);
    float emb = clamp(s.ember, 0.0, 1.0);
    rock += ramp(0.3 + 0.42 * emb) * emb;
    rock += ramp(0.4 + 0.55 * splatHot) * splatHot;

    float sheen = pow(nh, 60.0) * 2.5 + fres * 0.25;
    melt += vec3(1.0, 0.62, 0.42) * sheen * (0.4 - 0.25 * s.skin) * 0.3;
    melt += ramp(0.4 + 0.55 * splatHot) * splatHot * 0.5;
    col = s.plate > 0.0 ? rock : melt + rock * 0.15 * s.skin;
    float rimL = pow(1.0 - max(dot(nw, v), 0.0), 3.0);
    col += ramp(0.45) * rimL * 0.04;
  }

  col = col * (1.0 - fA) + fC;

  // TONE
  col = 1.0 - exp(-col * 1.15);
  col = pow(col, vec3(1.0 / 2.2));
  outColor = vec4(col, 1.0);
}`;
