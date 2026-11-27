import { HIST_N } from "./fall";

// CAMERA
// pinhole with a vertical lens shift, subject framed above the type
const CAMERA = `
uniform vec3 uEye;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uFwd;
uniform float uTan;
uniform float uAspect;
uniform vec2 uShift;
uniform vec2 uRes;
vec4 project(vec3 p) {
  vec3 d = p - uEye;
  float w = dot(d, uFwd);
  float x = dot(d, uRight) / (uTan * uAspect);
  float y = dot(d, uUp) / uTan;
  return vec4(x + uShift.x * w, y + uShift.y * w, w - 0.0004, w);
}
float kmPerPx(float w) {
  return 2.0 * max(w, 1e-4) * uTan / uRes.y;
}
`;

const CORNER = `
vec2 corner() {
  return vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1)) * 2.0 - 1.0;
}
`;

// CLOUD BAKE
// one tiling sheet, drawn once: r cumulus, g cirrus streaks, b coverage
export const BAKE_FS = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform int uOct;
out vec4 o;
float h2(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float vn(vec2 p, vec2 per) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = h2(mod(i, per));
  float b = h2(mod(i + vec2(1, 0), per));
  float c = h2(mod(i + vec2(0, 1), per));
  float d = h2(mod(i + 1.0, per));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 uv, vec2 per) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 8; i++) {
    if (i >= uOct) break;
    s += a * vn(uv * per, per);
    per *= 2.0;
    a *= 0.5;
  }
  return s;
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 warp = vec2(fbm(uv + 0.3, vec2(4.0)), fbm(uv + 0.7, vec2(4.0))) - 0.5;
  float cu = fbm(uv + warp * 0.12, vec2(6.0));
  cu = mix(cu, 1.0 - abs(cu * 2.0 - 1.0), 0.35);
  float ci = fbm(uv + vec2(warp.y * 0.05, warp.x * 0.2), vec2(2.0, 12.0));
  float cov = fbm(uv + warp * 0.3, vec2(3.0));
  o = vec4(cu, ci, cov, 1.0);
}`;

// SKY
// per-pixel camera ray; each layer returns tone and screened ink, meteor layer at its depth
export const SKY_FS = `#version 300 es
precision highp float;
${CAMERA}
uniform sampler2D uCloud;
uniform sampler2D uMeteor;
uniform float uMeteorDist;
uniform vec3 uSun;
uniform vec3 uMoon;
uniform vec4 uHead;
uniform vec4 uBurst;
uniform float uFlash;
uniform vec2 uShock;
uniform float uTime;
uniform float uCell;
uniform float uLine;
uniform vec4 uFocus;
uniform vec2 uFlow;
uniform float uBoil;
uniform float uImpact;
uniform vec4 uBox[2];
uniform vec4 uBand;
out vec4 o;

const float R = 6371.0;
const float SEA_KM = 3.0;
const float CIRRUS_KM = 9.0;
const vec3 PAPER = vec3(0.922, 0.898, 0.855);
const vec3 INK = vec3(0.105, 0.098, 0.09);
const vec3 HOT = vec3(1.0, 0.46, 0.1);
const vec3 COOL = vec3(0.92, 0.14, 0.42);

float h3(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

// SCREENS
// 45 deg dots for tone, line screen for hatching, 15 deg dots for the accent plate
float gDot;
float gDotW;
float gLine;
float gLineW;
float gAcc;
float gAccW;
float gFade;
float gLift;

float dots(float v) {
  v = v * (1.0 - gFade) - gLift;
  return v <= 0.012 ? 0.0 : v >= 0.988 ? 1.0 : smoothstep(-gDotW, gDotW, gDot - 1.0 + v);
}
float hatch(float v) {
  v = v * (1.0 - gFade) - gLift;
  return v <= 0.012 ? 0.0 : smoothstep(-gLineW, gLineW, gLine - 1.0 + v);
}
float accDots(float v) {
  v = clamp(v, 0.0, 1.0) * (1.0 - gFade * 0.5);
  return v <= 0.02 ? 0.0 : v >= 0.98 ? 1.0 : smoothstep(-gAccW, gAccW, gAcc - 1.0 + v);
}
// STROKE
// e px from the edge, w px half width
float stroke(float e, float w) {
  w *= 1.0 - gFade;
  return clamp(w + 0.5 - abs(e), 0.0, 1.0) * min(1.0, w * 2.0);
}

// TYPE CLEARANCE
// rounded-box sdf with a wide soft margin round each type block
float clear(vec4 b, vec2 p) {
  if (b.z <= b.x) return 0.0;
  vec2 d = max(b.xy - p, p - b.zw) + 90.0;
  float dist = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - 90.0;
  return smoothstep(200.0, 0.0, dist);
}

// SHELL
// nearest eye-ray hit with the sphere shell at altitude k, or -1
float shell(vec3 d, float k) {
  vec3 e = uEye;
  float b = e.x * d.x + (e.y + R) * d.y + e.z * d.z;
  float c = e.x * e.x + e.z * e.z + (e.y - k) * (2.0 * R + e.y + k);
  float h = b * b - c;
  if (h < 0.0) return -1.0;
  h = sqrt(h);
  if (c < 0.0) return -c / (b + h);
  if (b > 0.0) return -1.0;
  return c / (-b + h);
}

// DOME
// paper toward the sunset to near-solid ink overhead; space darkens it with altitude
float dome(vec3 d, float alt) {
  float dip = sqrt(2.0 * max(alt, 0.0) / R);
  float up = smoothstep(4.0, 45.0, alt);
  float e = (asin(clamp(d.y, -1.0, 1.0)) + dip) * (1.0 + up * 5.0);
  vec2 hz = normalize(d.xz + 1e-5);
  float sw = pow(max(0.0, dot(hz, normalize(uSun.xz))), 3.0);
  float v = mix(0.1, 0.0, sw);
  v = mix(v, mix(0.3, 0.14, sw), smoothstep(0.02, 0.14, e));
  v = mix(v, 0.5, smoothstep(0.12, 0.34, e));
  v = mix(v, 1.0, smoothstep(0.3, 0.62, e));
  float sa = max(0.0, dot(d, uSun));
  v -= pow(sa, 14.0) * 0.3 * exp(-max(e, 0.0) * 4.0);
  v = mix(v, 1.0, up * smoothstep(0.015, 0.22, e));
  return clamp(v, 0.0, 1.0);
}

// STARS
// paper specks cut from the tone, brightest with a cross
float stars(vec3 d, float n, float px) {
  vec3 p = d * n;
  vec3 cell = floor(p);
  float h = h3(cell);
  if (h > 0.04) return 0.0;
  vec3 sp = normalize(cell + 0.5 + (vec3(h3(cell + 7.1), h3(cell + 3.3), h3(cell + 5.7)) - 0.5) * 0.7);
  float b = pow(h3(cell + 1.9), 3.0);
  vec3 q = d - sp;
  float x = abs(dot(q, uRight)) / px;
  float y = abs(dot(q, uUp)) / px;
  float r = (0.7 + 1.6 * b) * uLine;
  float s = clamp(r + 0.5 - length(vec2(x, y)), 0.0, 1.0);
  if (b > 0.55) {
    float arm = 7.0 * b * uLine;
    s = max(s, clamp(0.5 * uLine + 0.5 - x, 0.0, 1.0) * step(y, arm) * (1.0 - y / arm));
    s = max(s, clamp(0.5 * uLine + 0.5 - y, 0.0, 1.0) * step(x, arm) * (1.0 - x / arm));
  }
  return s;
}

// MOON
// paper crescent, dark side in tone; x ink, y tone, z cover
vec3 moon(vec3 d, float px) {
  const float MR = 0.034;
  float c = dot(d, uMoon);
  float ang = sqrt(2.0 * max(0.0, 1.0 - c));
  if (ang > MR * 1.3) return vec3(0.0);
  vec3 mr = normalize(cross(uMoon, vec3(0, 1, 0)));
  vec3 mu = cross(mr, uMoon);
  vec2 q = vec2(dot(d, mr), dot(d, mu)) / MR;
  float rr = dot(q, q);
  float e = (1.0 - sqrt(rr)) * MR / px;
  float disc = clamp(e + 0.5, 0.0, 1.0);
  vec3 nrm = mr * q.x + mu * q.y - uMoon * sqrt(max(0.0, 1.0 - rr));
  float lit = smoothstep(-0.01, 0.01, dot(nrm, uSun));
  float tone = mix(0.82, 0.0, lit);
  float ink = max(dots(tone), stroke(e - 1.2 * uLine, 1.1 * uLine));
  return vec3(ink, tone, disc);
}

// RIDGES
// two rings round the town, height by bearing
float ridge(float a, float k) {
  float h = 0.9 + 0.5 * sin(a * 3.0 + k);
  h += 1.1 * pow(1.0 - abs(sin(a * 7.0 + k * 2.3)), 2.0);
  h += 0.55 * pow(1.0 - abs(sin(a * 17.0 + k * 5.1)), 3.0);
  h += 0.18 * sin(a * 41.0 + k);
  return h * (k > 1.0 ? 1.45 : 0.95);
}

vec2 cyl(vec3 d, float r) {
  vec2 e = uEye.xz;
  vec2 v = d.xz;
  float a = dot(v, v);
  float b = dot(e, v);
  float c = dot(e, e) - r * r;
  float h = b * b - a * c;
  if (h < 0.0 || a < 1e-8) return vec2(-1.0);
  h = sqrt(h);
  return vec2((-b - h) / a, (-b + h) / a);
}

// HILL
// near ridge ink with hatched sunward slopes, far ridge light tone, crest inked
void hill(vec3 d, float r, float k, float px, float fogT, inout float tHit, inout vec4 c) {
  vec2 ts = cyl(d, r);
  for (int i = 0; i < 2; i++) {
    float t = i == 0 ? ts.x : ts.y;
    if (t <= 0.0 || t >= tHit) continue;
    vec3 p = uEye + d * t;
    float a = atan(p.z, p.x);
    float drop = r * r / (2.0 * R);
    float top = ridge(a, k) - drop;
    if (p.y > top) continue;
    float da = 0.0015;
    float slope = (ridge(a + da, k) - ridge(a - da, k)) / (2.0 * da * r);
    float e = (top - p.y) / sqrt(1.0 + slope * slope) / (t * px);
    vec3 tang = normalize(vec3(-sin(a), 0.0, cos(a)));
    float lit = slope * dot(tang.xz, normalize(uSun.xz));
    float far = step(1.0, k);
    float tone = mix(1.0, 0.3, far);
    float face = smoothstep(0.05, 0.4, lit) * smoothstep(60.0 * uLine, 4.0 * uLine, e);
    float fog = (1.0 - exp(-t / mix(160.0, 90.0, far))) * 0.8;
    tone = mix(tone, fogT, fog);
    float ink = far > 0.5 ? dots(tone) : mix(dots(tone), hatch(0.55), face);
    float wob = 0.75 + 0.6 * textureLod(uCloud, vec2(a * 2.0, k * 0.3), 0.0).r;
    float w = uLine * mix(1.6, 1.0, far) * wob * (1.0 + 0.6 * smoothstep(0.0, -0.4, lit));
    ink = max(ink, stroke(e - w, w));
    c = vec4(ink, tone, 1.0, 0.0);
    tHit = t;
    return;
  }
}

// GLOW
// inverse-square falloff from the meteor or airburst
float glow(vec3 p, vec4 l, float reach) {
  vec3 q = p - l.xyz;
  return l.w / (1.0 + dot(q, q) / (reach * reach));
}

// HAZE
// distance fog toward the horizon tone
float haze(float v, float t, float fogT, float near) {
  float high = smoothstep(4.0, 30.0, uEye.y);
  float f = 1.0 - exp(-t / mix(near + uEye.y * 3.0, 70.0 + uEye.y * 4.5, high));
  return mix(v, fogT, f * (1.0 - 0.3 * high));
}

// CLOUD DECK
// density threshold, contour thins with distance; x ink, y tone, z cover, w accent
vec4 sea(vec3 d, float t, float fogT, float px) {
  vec3 p = uEye + d * t;
  vec2 q = p.xz;
  float above = step(SEA_KM, uEye.y);
  vec2 uv = q / mix(15.0, 46.0, above);
  vec2 uv2 = mat2(0.8, 0.6, -0.6, 0.8) * q / 110.0 + 0.37;
  float r1 = texture(uCloud, uv, above * 1.6).r;
  float dens = mix(r1, r1 * 0.55 + texture(uCloud, uv2, 1.6).r * 0.45, above);
  float cov = texture(uCloud, q / 55.0).b * 0.6 + texture(uCloud, q / 170.0 + 0.21).b * 0.4;
  float streets = 0.5 + 0.5 * sin(dot(q, vec2(0.6, 0.8)) / 3.5 + cov * 6.0);
  float cover = above > 0.5
    ? smoothstep(0.38, 0.7, cov) * (0.36 + 0.08 * streets) + 0.07
    : smoothstep(0.3, 0.75, texture(uCloud, q / 45.0).b) * 0.42 + 0.1;
  cover *= smoothstep(6.0, 18.0, length(q - vec2(2.0, -4.0)));
  float th = 1.0 - cover;
  float e = dens - th - 0.03;
  float ew = max(fwidth(e), 1e-5);
  float epx = e / ew;
  float fp = t * px;
  float lw = uLine * mix(1.3, 0.45, smoothstep(0.03, 0.3, fp));
  float body = clamp(epx + 0.5, 0.0, 1.0);
  float a = max(body, clamp(lw + 1.0 + epx, 0.0, 1.0));
  if (a < 0.003) return vec4(0.0);
  vec2 sun = normalize(uSun.xz);
  float sw = max(0.0, dot(normalize(q - uEye.xz), sun));
  float dS = texture(uCloud, uv + sun * 0.025).r;
  float light;
  if (uEye.y > SEA_KM) {
    float gx = texture(uCloud, uv + vec2(0.012, 0.0), 1.6).r - r1;
    float gz = texture(uCloud, uv + vec2(0.0, 0.012), 1.6).r - r1;
    float k = 34.0 / (1.0 + fp * 3.0);
    vec3 n = normalize(vec3(-gx * k, 1.0, -gz * k));
    float lam = dot(n, normalize(vec3(uSun.x, 0.3, uSun.z))) * 0.5 + 0.5;
    float sh = smoothstep(0.0, 0.1, dS - r1);
    float top = smoothstep(th, th + 0.25, dens);
    light = lam * (1.0 - sh * 0.55) * (0.62 + 0.5 * top);
  } else light = clamp((r1 - dS) * 9.0 + 0.42, 0.0, 1.0);
  float tone;
  if (above > 0.5) {
    tone = mix(0.45, 0.2, smoothstep(0.34, 0.38, light));
    tone = mix(tone, 0.0, smoothstep(0.5, 0.54, light + sw * 0.08));
  } else {
    tone = mix(0.62, 0.32, smoothstep(0.3, 0.36, light));
    tone = mix(tone, 0.0, smoothstep(0.5, 0.56, light + sw * 0.3));
  }
  tone = haze(tone, t, fogT, 90.0);
  float ink = dots(tone);
  float w = lw * (1.25 - 0.6 * smoothstep(0.3, 0.6, light));
  ink = max(ink, stroke(epx + w, w));
  float inner = stroke((e - 0.1) / ew, lw * 0.45) * (1.0 - smoothstep(0.4, 0.5, light));
  ink = max(ink, inner * (1.0 - smoothstep(0.02, 0.2, fp)));
  float lm = glow(p, uHead, 30.0) + glow(p, uBurst, 60.0) * 2.0;
  float acc = 0.0;
  if (lm > 0.004) {
    vec2 to = normalize(uHead.xz - q + 1e-4);
    float dM = texture(uCloud, uv + to * 0.03).r;
    float edge = smoothstep(0.02, 0.08, r1 - dM);
    acc = accDots((lm * edge - 0.12) * 1.5);
  }
  if (uShock.y > 0.0) {
    float band = exp(-abs(length(q - uBurst.xz) - uShock.x) / 1.6);
    acc = max(acc, accDots(band * uShock.y * 1.6));
  }
  return vec4(ink, max(tone, ink * 0.5), a, acc);
}

// CIRRUS
// paper streaks cut from the tone, hairline on the shadow edge
vec4 cirrus(vec3 d, float t, float fogT, float px) {
  vec3 p = uEye + d * t;
  vec2 uv = vec2(p.x * 0.8 + p.z * 0.3, p.z - p.x * 0.3) / vec2(60.0, 16.0);
  float dens = texture(uCloud, uv).g;
  float fib = texture(uCloud, uv * vec2(0.5, 6.0) + vec2(0.3, 0.1)).g;
  float pat = smoothstep(0.35, 0.75, texture(uCloud, p.xz / 90.0 + 0.5).b);
  float body = dens * (0.68 + 0.36 * pat) + (fib - 0.5) * 0.2;
  float e = body - 0.76;
  float ew = max(fwidth(e), 1e-5);
  float epx = e / ew;
  float below = step(uEye.y, CIRRUS_KM);
  float a = clamp(epx + 0.5, 0.0, 1.0) * below;
  if (a < 0.003) return vec4(0.0);
  float sw = pow(max(0.0, dot(normalize(p.xz - uEye.xz), normalize(uSun.xz))), 2.0);
  float fog = 1.0 - exp(-t / 260.0);
  float tone = mix(mix(0.12, 0.0, sw), fogT, fog * 0.6);
  float ink = dots(tone);
  float fade = 1.0 - smoothstep(0.004, 0.02, t * px);
  ink = max(ink, stroke(epx - 1.6 * uLine, 0.6 * uLine) * fade * step(0.25, fogT));
  float lm = glow(p, uHead, 45.0) + glow(p, uBurst, 60.0) * 2.0;
  return vec4(ink, tone, a, accDots(lm * 0.6 - 0.15));
}

// LAND
// sea in ink, land in dots with hatched shadow slopes, inked coast, paper rivers and lights
vec4 ground(vec3 d, float t, float fogT, float px) {
  vec3 p = uEye + d * t;
  float fp = t * px;
  float m = texture(uCloud, p.xz / 260.0 + 0.13).b;
  float em = m - 0.485;
  float emw = max(fwidth(em), 1e-5);
  float land = clamp(em / emw + 0.5, 0.0, 1.0);
  float tone = 1.0;
  float lt = 0.94;
  float shade = 0.0;
  float river = 0.0;
  if (uEye.y > 8.0) {
    vec2 gu = p.xz / 70.0 + 0.31;
    float hgt = texture(uCloud, gu, 1.0).r;
    float hx = texture(uCloud, gu + vec2(0.012, 0.0), 1.0).r;
    float hz = texture(uCloud, gu + vec2(0.0, 0.012), 1.0).r;
    float range = smoothstep(0.5, 0.68, hgt);
    vec3 n = normalize(vec3(-(hx - hgt) * 26.0, 1.0, -(hz - hgt) * 26.0));
    float relief = dot(n, normalize(vec3(uSun.x, 0.3, uSun.z)));
    lt = mix(0.78, 0.45, range * smoothstep(0.5, 0.8, relief));
    shade = range * smoothstep(0.45, 0.2, relief);
    float rv = texture(uCloud, p.xz / 38.0 + 0.9, 0.5).r;
    float w = 0.01 + fp / 38.0 * 1.5;
    river = (1.0 - smoothstep(0.0, w, abs(rv - 0.5))) * min(1.0, 0.012 / w) * (1.0 - range);
    river *= smoothstep(0.55, 0.7, texture(uCloud, p.xz / 90.0 + 0.2).b);
  }
  tone = mix(tone, lt, land);
  tone = haze(tone, t, fogT, 55.0);
  float ink = mix(dots(tone), max(dots(tone), hatch(0.6)), shade * land);
  ink *= 1.0 - smoothstep(0.3, 0.6, river);
  ink = max(ink, stroke(em / emw, uLine * 0.7) * (1.0 - smoothstep(0.004, 0.03, fp)));
  // TOWNS
  float cut = 0.0;
  if (fp < 1.4 && uEye.y > 8.0) {
    vec2 g = p.xz / 1.2;
    vec2 cell = floor(g);
    float h = h3(vec3(cell, 8.0));
    float town = smoothstep(0.55, 0.7, texture(uCloud, p.xz / 70.0 + 0.7).b) * land;
    if (h < town * 0.08) {
      vec2 lp = cell + 0.5 + (vec2(h3(vec3(cell, 5.0)), h3(vec3(cell, 6.0))) - 0.5) * 0.7;
      float dpx = length(g - lp) * 1.2 / fp;
      cut = clamp(0.9 * uLine + 0.5 - dpx, 0.0, 1.0) * smoothstep(1.4, 0.4, fp);
    }
  }
  float r = length(p.xz);
  if (r < 3.2) {
    vec2 g = p.xz / 0.06;
    vec2 cell = floor(g);
    float h = h3(vec3(cell, 4.0));
    float street = max(step(0.9, fract(cell.x / 6.0)), step(0.85, fract(cell.y / 5.0)));
    if (h < 0.1 + street * 0.25) {
      vec2 lp = cell + 0.5 + (vec2(h3(vec3(cell, 1.0)), h3(vec3(cell, 2.0))) - 0.5) * 0.6;
      float dpx = length(g - lp) * 0.06 / fp;
      cut = max(cut, clamp(uLine + 0.5 - dpx, 0.0, 1.0) * smoothstep(3.2, 1.5, r));
    }
  }
  ink *= 1.0 - cut;
  float lm = glow(p, uHead, 20.0) * 0.3 + glow(p, uBurst, 30.0) * 0.8;
  return vec4(ink, tone, 1.0, accDots(lm - 0.15));
}

void over(inout vec4 c, vec4 l) {
  c.x = mix(c.x, l.x, l.z);
  c.y = mix(c.y, l.y, l.z);
  c.w = mix(c.w, l.w, l.z);
}

// METEOR
// silhouette at a cover level; fire flat accent, white core, glow dots; z is the fire
vec4 gMet;
float gHue;
void meteor(inout vec4 c, vec2 uv) {
  vec2 tx = 1.0 / vec2(textureSize(uMeteor, 0));
  vec4 m = texture(uMeteor, uv);
  vec4 mx0 = texture(uMeteor, uv - vec2(tx.x, 0.0));
  vec4 mx1 = texture(uMeteor, uv + vec2(tx.x, 0.0));
  vec4 my0 = texture(uMeteor, uv - vec2(0.0, tx.y));
  vec4 my1 = texture(uMeteor, uv + vec2(0.0, tx.y));
  vec4 one = vec4(1.0, 0.0, 1.0, 1.0);
  float F = dot(m, one);
  if (F + dot(mx0 + mx1 + my0 + my1, one) < 0.01) return;
  float lpx = uRes.x * tx.x;
  vec2 gF = vec2(dot(mx1 - mx0, one), dot(my1 - my0, one)) * 0.5 / lpx;
  float sd = (F - 0.5) / max(length(gF), 1e-4);
  float fill = clamp(sd + 0.5, 0.0, 1.0);
  vec2 gB = vec2(mx1.b - mx0.b, my1.b - my0.b) * 0.5 / lpx;
  float core = clamp((m.b - 0.9) / max(length(gB), 1e-4) + 0.5, 0.0, 1.0);
  float E = m.r + m.b;
  float solid = clamp((m.a / max(F, 1e-4) - 0.5) * 8.0 + 0.5, 0.0, 1.0);
  float tone = m.g / max(m.a, 1e-4);
  gHue = clamp(0.5 - (E - 1.2) / max(length(gF), 1e-4), 0.0, 1.0);
  c.w = max(c.w * (1.0 - fill), accDots(E * 0.9) * (1.0 - fill));
  float ink = mix(c.x, dots(tone) * solid, fill);
  float acc = max(c.w, fill * (1.0 - solid));
  acc *= 1.0 - core;
  ink *= 1.0 - core * (1.0 - solid);
  float w = uLine * (1.1 + 0.5 * smoothstep(0.5, 3.0, F));
  float line = stroke(sd + w * 0.6, w);
  c.x = max(ink, line);
  c.y = mix(c.y, max(tone * solid, 0.2), fill);
  c.z = fill;
  c.w = acc * (1.0 - line);
  gMet = vec4(fill, core * (1.0 - solid), line, 0.0);
}

// SPEED LINES
// radial focus lines and parallel streaks, reseeded a few times a second (boil)
float hs(float a, float b) {
  return fract(sin(a * 12.9898 + b * 78.233) * 43758.5453);
}
float speed(vec2 ndc) {
  vec2 asp = vec2(uAspect, 1.0);
  float pxN = 2.0 / uRes.y;
  float l = 0.0;
  vec2 v = (ndc - uFocus.xy) * asp;
  float r = length(v);
  if (uFocus.z > 0.002) {
    const float N = 240.0;
    float s = (atan(v.y, v.x) / 6.2832 + 0.5) * N;
    float id = floor(s);
    float h = hs(id, uBoil);
    float r0 = mix(0.3, 0.85, hs(id, uBoil + 3.1)) * (1.3 - 0.4 * uFocus.z);
    float hw = mix(0.06, 0.2, hs(id, 9.0)) * smoothstep(r0, r0 + 1.2, r) * step(h, 0.25 + 0.4 * uFocus.z);
    hw *= 1.0 - gFade;
    float aa = pxN / max(r * 6.2832 / N, 1e-4);
    l = smoothstep(hw + aa, hw - aa, abs(fract(s) - 0.5)) * step(r0, r);
  }
  if (uFocus.w > 0.002) {
    vec2 p = ndc * asp / pxN;
    vec2 f = uFlow;
    vec2 n = vec2(-f.y, f.x);
    float lane = 7.0 * uLine;
    float s = dot(p, n) / lane;
    float id = floor(s);
    float h = hs(id, 7.0);
    float per = mix(260.0, 700.0, hs(id, 2.0)) * uLine;
    float len = mix(0.25, 0.7, hs(id, 5.0));
    float g = fract(dot(p, f) / per + h + uTime * mix(1.2, 2.6, h));
    float taper = sin(3.1416 * clamp(g / len, 0.0, 1.0));
    float hw = 0.34 * taper * step(hs(id, uBoil + 1.7), 0.12 + 0.3 * uFocus.w) * (1.0 - gFade);
    float aa = 1.0 / lane;
    float pl = smoothstep(hw + aa, hw - aa, abs(fract(s) - 0.5)) * step(g, len);
    l = max(l, pl * smoothstep(0.12, 0.4, r));
  }
  return l;
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 uv = fc / uRes;
  vec2 ndc = uv * 2.0 - 1.0;
  vec2 cam = vec2((ndc.x - uShift.x) * uTan * uAspect, (ndc.y - uShift.y) * uTan);
  vec3 d = normalize(uFwd + uRight * cam.x + uUp * cam.y);
  float px = 2.0 * uTan / uRes.y;
  float alt = uEye.y;

  // SCREENS
  vec2 q = mat2(0.7071, 0.7071, -0.7071, 0.7071) * fc / uCell;
  gDot = 0.5 + 0.25 * (cos(6.2832 * q.x) + cos(6.2832 * q.y));
  gDotW = max(fwidth(gDot) * 0.6, 1e-3);
  gLine = 0.5 + 0.5 * cos(6.2832 * dot(fc, vec2(0.259, 0.966)) / (uCell * 0.8));
  gLineW = max(fwidth(gLine) * 0.6, 1e-3);
  vec2 qa = mat2(0.966, 0.259, -0.259, 0.966) * fc / (uCell * 0.85);
  gAcc = 0.5 + 0.25 * (cos(6.2832 * qa.x) + cos(6.2832 * qa.y));
  gAccW = max(fwidth(gAcc) * 0.6, 1e-3);
  vec2 css = fc / uLine;
  float band = max(smoothstep(uBand.y, uBand.x, uv.y) * 0.9, smoothstep(uBand.z, uBand.w, uv.y) * 0.85);
  gFade = max(max(clear(uBox[0], css), clear(uBox[1], css)) * 0.97, band);
  gLift = 0.0;
  if (uFlash > 0.0) {
    float k = max(0.0, dot(d, normalize(uBurst.xyz - uEye)));
    gLift = uFlash * (0.12 + 0.9 * pow(k, 6.0));
  }

  float fogT = dome(normalize(vec3(d.x, -sqrt(2.0 * max(alt, 0.0) / R) + 0.01, d.z)), alt);
  float tHit = 1e9;
  float dt = dome(d, alt);
  vec4 c = vec4(dots(dt), dt, 1.0, 0.0);
  float tg = shell(d, 0.0);
  if (tg > 0.0) {
    c = ground(d, tg, fogT, px);
    tHit = tg;
  }
  if (alt < 12.0) {
    hill(d, 26.0, 0.0, px, fogT, tHit, c);
    hill(d, 48.0, 2.0, px, fogT, tHit, c);
  }
  if (tHit > 1e8) {
    float sv = smoothstep(0.35, 0.6, dt) * (1.0 - uFlash);
    c.x *= 1.0 - max(stars(d, 260.0, px), stars(d, 90.0, px)) * sv;
    vec3 mn = moon(d, px);
    c.x = mix(c.x, mn.x, mn.z);
    c.y = mix(c.y, mn.y, mn.z);
  }

  // LAYERS
  // far to near: cloud decks, meteor at its depth between them
  float tc = shell(d, CIRRUS_KM);
  float ts = shell(d, SEA_KM);
  vec4 near = tc > 0.0 && tc < tHit ? cirrus(d, tc, fogT, px) : vec4(0.0);
  vec4 far = ts > 0.0 && ts < tHit ? sea(d, ts, fogT, px) : vec4(0.0);
  if (near.z > 0.0 && far.z > 0.0 && ts < tc) {
    vec4 x = near;
    near = far;
    far = x;
    float y = tc;
    tc = ts;
    ts = y;
  } else if (near.z <= 0.0) {
    near = far;
    tc = ts;
    far = vec4(0.0);
  }
  gMet = vec4(0.0);
  gHue = 1.0;
  bool mv = uMeteorDist < tHit || tHit > 1e8;
  bool met = !mv;
  if (!met && far.z > 0.0 && uMeteorDist > ts) {
    meteor(c, uv);
    met = true;
  }
  over(c, far);
  if (!met && near.z > 0.0 && uMeteorDist > tc) {
    meteor(c, uv);
    met = true;
  }
  over(c, near);
  if (!met) meteor(c, uv);

  // LINES
  // ink on the light, paper on the dark, never over the fire
  float sl = speed(ndc) * (1.0 - gMet.x);
  float lineInk = step(c.y, 0.6);
  c.x = mix(c.x, lineInk, sl);
  c.w *= 1.0 - sl;

  // PRINT
  vec3 accent = mix(HOT, COOL, gHue);
  vec3 col = mix(PAPER, PAPER * accent * 1.04, c.w);
  col = mix(col, vec3(1.0, 0.985, 0.95), gMet.y);
  col = mix(col, INK, c.x);
  // IMPACT
  // one inverted frame, then one flat accent frame
  if (uImpact > 1.5) col = mix(PAPER * HOT, INK, step(0.5, c.x) * (1.0 - gMet.y));
  else if (uImpact > 0.5) col = mix(INK, PAPER, max(c.x, gMet.x * (1.0 - gMet.z)));
  o = vec4(col, 1.0);
}`;

// TRAIL
// aStrand: phase, spread, width, hue; aMeta: row, head, count, kind
export const TRAIL_VS = `#version 300 es
precision highp float;
precision highp sampler2D;
${CAMERA}
uniform sampler2D uHist;
uniform float uTime;
uniform vec3 uWind;
layout(location = 0) in vec4 aStrand;
layout(location = 1) in vec4 aMeta;
out float vAcross;
out float vT;
out float vBright;
out float vHue;
out float vKind;
const int N = ${HIST_N};
vec4 at(int row, int i) {
  int c = aMeta.w > 1.5 ? i : (int(aMeta.y) - i + N * 4) % N;
  return texelFetch(uHist, ivec2(c, row), 0);
}
void main() {
  int row = int(aMeta.x);
  int count = int(aMeta.z);
  int i = gl_VertexID >> 1;
  float side = float(gl_VertexID & 1) * 2.0 - 1.0;
  bool guide = aMeta.w > 1.5;
  int last = max(count - 1, 0);
  int ic = min(i, last);
  vec4 P = at(row, ic);
  vec3 Pp = at(row, max(ic - 1, 0)).xyz;
  vec3 Pn = at(row, min(ic + 1, last)).xyz;
  vec3 T = guide ? Pn - Pp : Pp - Pn;
  T = dot(T, T) < 1e-12 ? vec3(-1.0, 0.0, 0.0) : normalize(T);
  float lum = guide ? 1.0 : at(row + 1, ic).x;
  float age = guide ? 0.0 : max(0.0, uTime - P.w);
  float life = aMeta.w < 0.5 ? 5.5 : 0.7;
  vec3 n1 = normalize(cross(T, vec3(0.0, 1.0, 0.0)) + vec3(0.0, 0.0, 1e-4));
  vec3 n2 = cross(T, n1);
  float sp = (0.002 + 0.012 * sqrt(age) + 0.12 * age) * aStrand.y;
  float th = aStrand.x * 6.2832 + age * (aStrand.x > 0.5 ? 0.9 : -0.7) + float(ic) * 0.04;
  vec3 c = P.xyz + (n1 * cos(th) + n2 * sin(th)) * sp;
  c += n2 * sin(float(ic) * 0.09 + aStrand.x * 4.0 + uTime * 0.35) * 0.02 * age * aStrand.y;
  c += uWind * age * age;
  c += (n1 * sin(float(ic) * 0.05 + aStrand.x * 2.0 + age * 0.4) + n2 * 0.6 * cos(float(ic) * 0.037 + age * 0.3)) * 0.05 * age * age;
  c += n2 * sin(age * 90.0 + aStrand.x * 17.0 + uTime * 23.0) * 0.0015 * aStrand.y * smoothstep(0.0, 0.05, age);
  vec4 a = project(c);
  vec4 b = project(c + T * max(0.002, abs(a.w) * 0.01));
  vec2 sa = a.xy / max(a.w, 1e-4);
  vec2 sb = b.xy / max(b.w, 1e-4);
  vec2 dir = (sb - sa) * vec2(uAspect, 1.0);
  dir = dot(dir, dir) > 1e-12 ? normalize(dir) : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x) / vec2(uAspect, 1.0);
  float ww = (0.0012 + 0.04 * age + 0.006 * sqrt(age)) * aStrand.z;
  float px = ww / kmPerPx(a.w);
  float minPx = guide ? 0.8 : (aMeta.w > 0.5 ? 1.0 : 2.8) * aStrand.z;
  float wpx = min(max(px, minPx), 90.0);
  a.xy += nrm * side * wpx * 2.0 / uRes.y * a.w;
  gl_Position = a;
  vAcross = side;
  vT = guide ? 0.0 : pow(age / life, 0.5);
  float tail = smoothstep(float(last), float(last) - 40.0, float(i)) * smoothstep(0.0, 2.0, float(count));
  if (fract(aMeta.w) > 0.2) tail *= smoothstep(0.0, 14.0, float(i));
  vBright = i > last || count == 0 ? 0.0 : max(sqrt(lum) * 1.3, 0.08) * max(0.75, sqrt(px / wpx)) * tail;
  vHue = aStrand.w;
  vKind = aMeta.w + (aStrand.z > 3.0 ? 4.0 : 0.0);
}`;

// METEOR LAYER
// premultiplied: r accent heat, g ink tone x cover, b white heat, a solid cover

export const TRAIL_FS = `#version 300 es
precision highp float;
in float vAcross;
in float vT;
in float vBright;
in float vHue;
in float vKind;
out vec4 o;
void main() {
  float a = abs(vAcross);
  float prof = smoothstep(1.0, 0.55, a);
  float t = clamp(vT + vHue * 0.6, 0.0, 1.0);
  float fade = (1.0 - smoothstep(0.45, 1.0, vT)) * exp(-vT * 0.9);
  float b = vBright / (1.0 + vBright * 0.6);
  float young = 1.0 - smoothstep(0.02, 0.2, t);
  float smoke = smoothstep(0.3, 0.55, vT);
  float heat = b * prof * fade * (1.0 - smoke) * 1.6;
  float white = heat * young * smoothstep(0.6, 0.1, a) * 1.4;
  float cover = b * (1.0 - a) * smoke * (1.0 - smoothstep(0.75, 1.0, vT)) * 1.1;
  if (vKind > 3.5) {
    heat = b * (1.0 - a) * (1.0 - a) * fade * 0.55 * (1.0 - smoke);
    white = 0.0;
    cover = 0.0;
  }
  o = vec4(heat, cover * 0.4, white, cover);
}`;

// SPARKS
// aL: age, life, size, kind; streaked by motion relative to the camera
export const SPARK_VS = `#version 300 es
precision highp float;
${CAMERA}
${CORNER}
uniform vec3 uCamVel;
layout(location = 0) in vec3 aP;
layout(location = 1) in vec3 aV;
layout(location = 2) in vec4 aL;
out vec2 vQ;
out float vT;
out float vKind;
out float vB;
void main() {
  vec2 q = corner();
  vQ = q;
  vT = aL.x / max(aL.y, 1e-3);
  vKind = aL.w;
  vec3 rel = aV - uCamVel;
  vec4 a = project(aP);
  vec4 b = project(aP - rel * 0.035);
  if (aL.x >= aL.y || a.w < 0.001 || b.w < 0.001) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec2 sa = a.xy / a.w;
  vec2 sb = b.xy / b.w;
  vec2 d = (sa - sb) * vec2(uAspect, 1.0) * uRes.y * 0.5;
  float len = length(d) * (aL.w > 3.5 ? 0.2 : 1.0);
  vec2 dir = len > 1e-4 ? normalize(d) : vec2(1.0, 0.0);
  float spx = aL.z * 0.00035 / kmPerPx(a.w);
  float s = max(spx * 0.6, 0.9);
  vB = min(1.0, spx / s + 0.25);
  len = min(len, 110.0); // change for longer speed streaks
  vec2 mid = (sa + sb) * 0.5;
  vec2 off = dir * q.x * (len * 0.5 + s) + vec2(-dir.y, dir.x) * q.y * s;
  gl_Position = vec4(mid + off / (vec2(uAspect, 1.0) * uRes.y * 0.5), 0.0, 1.0);
}`;

export const SPARK_FS = `#version 300 es
precision highp float;
in vec2 vQ;
in float vT;
in float vKind;
in float vB;
out vec4 o;
void main() {
  float k = smoothstep(1.0, 0.3, length(vQ * vec2(0.6, 1.0)));
  float fade = (1.0 - vT) * (1.0 - vT) * smoothstep(0.0, 0.08, vT);
  float heat = k * fade * vB * 1.9;
  if (vKind > 3.5) {
    float cold = smoothstep(0.3, 0.7, vT);
    o = vec4(heat * (1.0 - cold), k * cold * fade * 0.8, 0.0, k * cold * fade);
    return;
  }
  o = vec4(heat, 0.0, heat * (1.0 - smoothstep(0.0, 0.3, vT)) * step(vKind, 0.5) * 0.6, 0.0);
}`;

// SPRITES
// head, fireball, shock ring, debris cloud; aS: radius km, light, kind, seed
export const SPRITE_VS = `#version 300 es
precision highp float;
${CAMERA}
${CORNER}
layout(location = 0) in vec3 aP;
layout(location = 1) in vec3 aD;
layout(location = 2) in vec4 aS;
out vec2 vPx;
out float vR;
out vec2 vDir;
out vec4 vS;
out vec3 vTint;
out float vExt;
void main() {
  vec2 q = corner();
  float kind = aS.z;
  vS = aS;
  vTint = aD;
  vec4 c = project(aP);
  if (c.w < 0.002) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float rpx = aS.x / kmPerPx(c.w);
  float ext = kind < 0.5 ? max(rpx * 4.0, 30.0 + 60.0 * min(aS.y, 3.0)) : max(rpx * 3.0, 40.0);
  ext = min(ext, uRes.y * 1.4);
  vExt = ext;
  vec4 b = project(aP + aD * max(0.001, c.w * 0.01));
  vec2 dd = (b.xy / max(b.w, 1e-4) - c.xy / c.w) * vec2(uAspect, 1.0);
  vDir = dot(dd, dd) > 1e-12 ? normalize(dd) : vec2(-1.0, 0.0);
  vPx = q * ext;
  vR = rpx;
  c.xy += vPx * 2.0 / (vec2(uAspect, 1.0) * uRes.y) * c.w;
  gl_Position = c;
}`;

export const SPRITE_FS = `#version 300 es
precision highp float;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uFwd;
uniform vec4 uBite;
uniform vec4 uCrack;
in vec2 vPx;
in float vR;
in vec2 vDir;
in vec4 vS;
in vec3 vTint;
in float vExt;
out vec4 o;
float h3(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
void main() {
  vec2 p = vPx;
  float d = length(p);
  float L = vS.y;
  float kind = vS.z;
  float seed = fract(vS.w);
  bool isMain = vS.w >= 100.0;
  float wv = isMain ? vS.w - 100.0 : vS.w;
  if (kind < 0.5) {
    // HEAD
    vec3 U = normalize(vTint);
    vec2 U2 = vec2(dot(U, uRight), dot(U, uUp));
    vec2 f = vDir;
    vec2 s = vec2(-f.y, f.x);
    float u = dot(p, f);
    float v = dot(p, s);
    float R = max(vR, 0.6);
    float Lc = min(L, 2.5);
    float win = 1.0 - smoothstep(0.6, 1.0, d / vExt);
    float ub = u < 0.0 ? u * 0.45 : u * 1.4;
    float fl = length(vec2(ub, v)) / (R * 1.4 + 4.5 + 3.5 * Lc);
    float heat = Lc * (1.3 * exp(-fl * 1.3) + 0.35 * exp(-d / (6.0 + 10.0 * Lc))) * win;
    float white = Lc * 1.5 * exp(-fl * 2.2) * smoothstep(-0.3 * R - 2.0, R * 0.8, u + R * 0.6);
    // BOW SHOCK
    vec2 g = p / R;
    float r = length(g);
    float fr = dot(g / max(r, 1e-3), U2) + (1.0 - length(U2)) * 0.9;
    float cap = exp(-max(0.0, r - 1.05) / 0.5) * smoothstep(-0.2, 0.9, fr) * smoothstep(1.5, 5.0, R);
    white += cap * Lc * 0.8;
    // ROCK
    // lumpy ink body, facets in its own frame, leading face hot
    float worn = floor(wv) / 15.0;
    float ang = atan(g.y, g.x);
    float lump = 0.13 * sin(ang * 3.0 + seed * 20.0) + 0.08 * sin(ang * 5.0 - seed * 13.0);
    lump = 1.0 + (lump + 0.04 * sin(ang * 9.0 + seed * 7.0)) * (1.0 - 0.6 * worn);
    vec2 B2 = vec2(dot(uBite.xyz, uRight), dot(uBite.xyz, uUp));
    float bl = length(B2);
    if (isMain && uBite.w > 0.01 && bl > 0.05) {
      float depth = 0.3 * sqrt(uBite.w) * bl;
      lump -= depth * smoothstep(0.8, 0.97, dot(g / max(r, 1e-3), B2 / bl));
    }
    float rock = smoothstep(R * lump + 0.7, R * lump - 0.7, d) * smoothstep(1.5, 4.0, R);
    if (rock <= 0.0) {
      o = vec4(heat, 0.0, white, 0.0);
      return;
    }
    vec2 q = g / lump;
    vec3 nv = vec3(q, sqrt(max(0.0, 1.0 - dot(q, q))));
    vec3 N = normalize(uRight * nv.x + uUp * nv.y - uFwd * nv.z);
    vec3 N0 = N;
    vec3 cp = N * 2.6 + seed * 7.0;
    vec3 cell = floor(cp);
    vec3 e = min(fract(cp), 1.0 - fract(cp));
    vec3 tilt = vec3(h3(cell), h3(cell + 1.3), h3(cell + 2.7)) - 0.5;
    N = normalize(N + tilt * 0.75 * (1.0 - 0.5 * worn));
    float seam = 1.0 - smoothstep(0.0, 0.05 + 0.07 * worn, min(e.x, min(e.y, e.z)));
    vec3 fc = fract(cp) - 0.5;
    float pit = smoothstep(1.0 - worn * 0.7, 1.0, h3(cell + 5.1)) * smoothstep(0.3, 0.1, length(fc));
    float hd = dot(N, U);
    float tone = mix(0.95, 0.6, step(-0.1, hd));
    tone = mix(tone, 0.3, step(0.35, hd));
    float molten = smoothstep(0.5 - 0.25 * worn, 0.65 - 0.25 * worn, hd);
    float rh = molten * 2.0 + max(seam, pit) * step(-0.6, hd) * (0.8 + worn);
    float rw = smoothstep(0.82, 0.9, hd) * 1.6;
    if (isMain) {
      float bd = smoothstep(0.76, 0.9, dot(N0, uBite.xyz)) * uBite.w;
      rh += bd * 2.0;
      float cd = dot(N0, uCrack.xyz);
      float seamOpen = (1.0 - smoothstep(0.0, 0.03 + 0.03 * uCrack.w, abs(cd - 0.8))) * uCrack.w;
      tone = mix(tone, 0.95, step(0.8, cd) * uCrack.w * 0.6);
      rh += seamOpen * 3.0;
    }
    float sol = rock * (1.0 - smoothstep(0.4, 0.9, rh + rw));
    o = vec4(heat * (1.0 - rock) + rh * rock, tone * sol, white * (1.0 - rock) + rw * rock, sol);
    return;
  }
  if (kind < 1.5) {
    // FIREBALL
    // accent bloom, white while young, ragged rim; vTint.x is age 0-1
    float a2 = atan(p.y, p.x);
    float spike = pow(0.5 + 0.5 * sin(a2 * 9.0 + seed * 7.0), 6.0) * (1.0 - vTint.x);
    float x = d / max(vR, 1.0);
    x *= 1.0 + 0.08 * sin(a2 * 7.0 + seed * 9.0) + 0.05 * sin(a2 * 13.0);
    x /= 1.0 + 0.45 * spike;
    float cool = vTint.x;
    float k = smoothstep(1.0, 0.0, x);
    float heat = L * (k * 1.8 + exp(-x * 2.0) * 0.5);
    float white = L * smoothstep(0.75 - 0.6 * cool, 0.0, x) * (1.0 - smoothstep(0.2, 0.6, cool)) * 2.0;
    o = vec4(heat, 0.0, white, 0.0);
    return;
  }
  if (kind < 2.5) {
    // SHOCK RING
    float w = 1.2 + vR * 0.012;
    float a = L * smoothstep(w + 0.8, w - 0.8, abs(d - vR)) * 1.2;
    o = vec4(0.0, a, 0.0, a);
    return;
  }
  // DEBRIS CLOUD
  float x = d / max(vR, 1.0);
  float a2 = atan(p.y, p.x);
  float edge = 1.0 + 0.12 * sin(a2 * 5.0 + seed * 9.0) + 0.07 * sin(a2 * 11.0 - seed * 4.0);
  float body = smoothstep(edge, edge - 0.2, x);
  float puff = 0.5 + 0.5 * sin(p.x / vR * 7.0 + seed * 5.0) * sin(p.y / vR * 6.0 - seed * 3.0);
  float lit = dot(p / vR, normalize(vec2(0.7, 0.55))) * 0.6 + 0.45 + puff * 0.15;
  float tone = mix(0.62, 0.22, step(0.55, lit));
  float heat = vTint.x * smoothstep(0.8, 0.0, x) * 2.4;
  float a = body * L * 2.0 * (1.0 - smoothstep(0.4, 0.9, heat));
  o = vec4(heat * body * L * 2.0, tone * a, 0.0, a);
}`;
