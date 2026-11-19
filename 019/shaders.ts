import { HIST_N } from "./fall";

// CAMERA
// a pinhole with a vertical lens shift, so the subject can sit above the title and hud
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
// everything that is not the meteor, per pixel from the camera ray: the dusk dome, stars and
// a crescent moon, two cloud decks on the curve of the earth, ridges round the town, the
// ground and its lights. the meteor layer is laid in at its own depth between them
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
uniform vec2 uShock; // ring radius km, strength
uniform float uTime;
out vec4 o;

const float R = 6371.0;
const float SEA_KM = 3.0;
const float CIRRUS_KM = 9.0;
const vec3 NAVY = vec3(0.035, 0.05, 0.16);

float h3(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

// nearest hit of the eye ray with the shell at altitude k, or -1
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

// the dusk: warm low toward the sun, violet, then deep blue; darker and thinner up high
vec3 dome(vec3 d, float alt) {
  float dip = sqrt(2.0 * max(alt, 0.0) / R);
  float up = smoothstep(4.0, 45.0, alt);
  float e = (asin(clamp(d.y, -1.0, 1.0)) + dip) * (1.0 + up * 5.0);
  vec2 hz = normalize(d.xz + 1e-5);
  float sunward = max(0.0, dot(hz, normalize(uSun.xz)));
  float sw = pow(sunward, 3.0);
  vec3 lo = mix(vec3(0.96, 0.55, 0.62), vec3(1.0, 0.8, 0.55), sw);
  vec3 c = lo;
  c = mix(c, mix(vec3(0.74, 0.42, 0.64), vec3(0.98, 0.56, 0.48), sw), smoothstep(0.0, 0.07, e));
  c = mix(c, mix(vec3(0.42, 0.3, 0.6), vec3(0.66, 0.36, 0.6), sw), smoothstep(0.05, 0.2, e));
  c = mix(c, vec3(0.2, 0.2, 0.47), smoothstep(0.16, 0.45, e));
  c = mix(c, vec3(0.08, 0.11, 0.3), smoothstep(0.4, 0.95, e));
  c = mix(c, NAVY, smoothstep(0.9, 1.5, e));
  // the glow over where the sun went down
  float sa = max(0.0, dot(d, uSun));
  c += vec3(1.0, 0.62, 0.3) * pow(sa, 24.0) * 0.55 * exp(-max(e, 0.0) * 5.0);
  c = mix(c, c * vec3(0.32, 0.36, 0.55), up * smoothstep(0.02, 0.4, e));
  return c;
}

vec3 stars(vec3 d, float n, float px) {
  vec3 p = d * n;
  vec3 cell = floor(p);
  float h = h3(cell);
  if (h > 0.045) return vec3(0.0);
  vec3 sp = normalize(cell + 0.5 + (vec3(h3(cell + 7.1), h3(cell + 3.3), h3(cell + 5.7)) - 0.5) * 0.7);
  float a2 = 2.0 * max(0.0, 1.0 - dot(sp, d));
  float r = px * 0.9;
  float b = pow(h3(cell + 1.9), 4.0) * 1.6 + 0.12;
  float s = exp(-a2 / (r * r)) * b;
  // the brightest few get a small cross
  if (b > 1.0) {
    vec3 q = d - sp;
    float x = abs(dot(q, uRight)) / px;
    float y = abs(dot(q, uUp)) / px;
    s += (exp(-x * 1.2) * exp(-y / 4.0) + exp(-y * 1.2) * exp(-x / 4.0)) * 0.35 * b;
  }
  vec3 tint = mix(vec3(0.8, 0.86, 1.0), vec3(1.0, 0.9, 0.8), h3(cell + 9.0));
  return tint * s;
}

vec3 moon(vec3 d, float px) {
  const float MR = 0.034;
  float c = dot(d, uMoon);
  float ang = sqrt(2.0 * max(0.0, 1.0 - c));
  vec3 col = vec3(1.0, 0.86, 0.7) * exp(-ang / 0.07) * 0.12;
  if (ang < MR * 1.2) {
    vec3 mr = normalize(cross(uMoon, vec3(0, 1, 0)));
    vec3 mu = cross(mr, uMoon);
    vec2 q = vec2(dot(d, mr), dot(d, mu)) / MR;
    float rr = dot(q, q);
    float disc = smoothstep(1.0 + px / MR, 1.0 - px / MR, sqrt(rr));
    vec3 nrm = mr * q.x + mu * q.y - uMoon * sqrt(max(0.0, 1.0 - rr));
    float lit = smoothstep(-0.02, 0.06, dot(nrm, uSun));
    col += disc * mix(vec3(0.12, 0.14, 0.26), vec3(1.0, 0.94, 0.8) * 1.15, lit);
  }
  return col;
}

// RIDGES
// two rings of mountains round the town, heights by bearing
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

void hill(vec3 d, float r, float k, inout float tHit, inout vec3 col, vec3 fogCol) {
  vec2 ts = cyl(d, r);
  for (int i = 0; i < 2; i++) {
    float t = i == 0 ? ts.x : ts.y;
    if (t <= 0.0 || t >= tHit) continue;
    vec3 p = uEye + d * t;
    float a = atan(p.z, p.x);
    float drop = r * r / (2.0 * R);
    float top = ridge(a, k) - drop;
    if (p.y > top) continue;
    float edge = smoothstep(top - 0.16, top - 0.02, p.y);
    float facing = max(0.0, dot(normalize(p.xz), normalize(uSun.xz)) * -1.0 + 0.3);
    vec3 base = k > 1.0 ? vec3(0.2, 0.17, 0.36) : vec3(0.075, 0.07, 0.17);
    vec3 c = base + edge * vec3(0.62, 0.34, 0.42) * (0.25 + facing) * (k > 1.0 ? 0.7 : 0.45);
    float fog = 1.0 - exp(-t / (k > 1.0 ? 70.0 : 110.0));
    col = mix(c, fogCol, fog * 0.85);
    tHit = t;
    return;
  }
}

// a light on clouds and ground: the meteor, the airburst
float glow(vec3 p, vec4 l, float reach) {
  vec3 q = p - l.xyz;
  return l.w / (1.0 + dot(q, q) / (reach * reach));
}

// HAZE
// thin blue air close by, the glowing horizon band far off; deeper from high up
vec3 haze(vec3 c, float t, vec3 fogCol, float near) {
  float high = smoothstep(4.0, 30.0, uEye.y);
  float f = 1.0 - exp(-t / mix(near + uEye.y * 3.0, 70.0 + uEye.y * 4.5, high));
  vec3 hz = mix(mix(fogCol, vec3(0.17, 0.16, 0.36), high), fogCol, smoothstep(0.45, 0.97, f));
  return mix(c, hz, f * (1.0 - 0.25 * high));
}

vec4 sea(vec3 d, float t, vec3 fogCol, float px) {
  vec3 p = uEye + d * t;
  vec2 q = p.xz;
  // two scales of the sheet, turned against each other, so it never reads as a tile
  float above = step(SEA_KM, uEye.y);
  vec2 uv = q / mix(15.0, 46.0, above);
  vec2 uv2 = mat2(0.8, 0.6, -0.6, 0.8) * q / 110.0 + 0.37;
  // from above the sheet is read blurred: big simple masses, not detail
  float r1 = texture(uCloud, uv, above * 1.6).r;
  float dens = mix(r1, r1 * 0.55 + texture(uCloud, uv2, 1.6).r * 0.45, above);
  // large scale: clear patches, and streets of cloud along the wind
  float cov = texture(uCloud, q / 55.0).b * 0.6 + texture(uCloud, q / 170.0 + 0.21).b * 0.4;
  float streets = 0.5 + 0.5 * sin(dot(q, vec2(0.6, 0.8)) / 3.5 + cov * 6.0);
  float cover = above > 0.5
    ? smoothstep(0.38, 0.7, cov) * (0.36 + 0.08 * streets) + 0.07
    : smoothstep(0.3, 0.75, texture(uCloud, q / 45.0).b) * 0.42 + 0.1;
  cover *= smoothstep(6.0, 18.0, length(q - vec2(2.0, -4.0)));
  float th = 1.0 - cover;
  float soft = mix(0.05, 0.12, above) + min(0.3, t * px * 0.6);
  float a = smoothstep(th, th + soft, dens);
  if (a < 0.003) return vec4(0.0);
  vec2 sun = normalize(uSun.xz);
  float sw = max(0.0, dot(normalize(q - uEye.xz), sun));
  float dS = texture(uCloud, uv + sun * 0.025).r;
  float light;
  if (uEye.y > SEA_KM) {
    // PUFFS
    // a normal from the slope of the sheet, lit low from the sunset side, with the
    // shadow each puff throws away from it
    float gx = texture(uCloud, uv + vec2(0.012, 0.0), 1.6).r - r1;
    float gz = texture(uCloud, uv + vec2(0.0, 0.012), 1.6).r - r1;
    float k = 34.0 / (1.0 + t * px * 3.0);
    vec3 n = normalize(vec3(-gx * k, 1.0, -gz * k));
    float lam = dot(n, normalize(vec3(uSun.x, 0.3, uSun.z))) * 0.5 + 0.5;
    float sh = smoothstep(0.0, 0.1, dS - r1);
    float top = smoothstep(th, th + 0.25, dens);
    light = lam * (1.0 - sh * 0.55) * (0.62 + 0.5 * top);
  } else light = clamp((r1 - dS) * 9.0 + 0.42, 0.0, 1.0);
  vec3 shadow = vec3(0.2, 0.2, 0.46);
  vec3 mid = mix(vec3(0.62, 0.42, 0.66), vec3(0.92, 0.56, 0.6), sw * sw * 0.7);
  vec3 rim = vec3(1.0, 0.76, 0.56);
  vec3 c = mix(shadow * 0.85, shadow, smoothstep(0.2, 0.34, light));
  c = mix(c, mid, smoothstep(0.4, 0.5, light));
  c = mix(c, rim, smoothstep(0.62, 0.7, light) * (0.4 + sw * 0.6));
  // rounded tops: crevices between puffs sink into shade
  c *= mix(0.72, 1.08, smoothstep(th, th + 0.3, dens));
  // the meteor and the airburst light the tops facing them
  float lm = glow(p, uHead, 55.0) + glow(p, uBurst, 70.0) * 2.0;
  if (lm > 0.004) {
    vec2 to = normalize(uHead.xz - q + 1e-4);
    float dM = texture(uCloud, uv + to * 0.03).r;
    float edge = smoothstep(0.02, 0.08, r1 - dM);
    c += vec3(1.0, 0.82, 0.6) * lm * (0.35 + edge * 1.2);
  }
  // the shock of the airburst running out across the cloud tops
  if (uShock.y > 0.0) {
    float band = exp(-abs(length(q - uBurst.xz) - uShock.x) / 1.6);
    c += vec3(1.0, 0.86, 0.76) * band * uShock.y;
  }
  c = haze(c, t, fogCol, 90.0);
  return vec4(c * a, a);
}

// CIRRUS
// soft brushy streaks: a wide feathered falloff, fibres along their length, thin ends
vec4 cirrus(vec3 d, float t, vec3 fogCol, float px) {
  vec3 p = uEye + d * t;
  vec2 uv = vec2(p.x * 0.8 + p.z * 0.3, p.z - p.x * 0.3) / vec2(60.0, 16.0);
  float dens = texture(uCloud, uv).g;
  float fib = texture(uCloud, uv * vec2(0.5, 6.0) + vec2(0.3, 0.1)).g;
  float fib2 = texture(uCloud, uv * vec2(1.1, 9.0) + 0.6).g;
  float pat = smoothstep(0.35, 0.75, texture(uCloud, p.xz / 90.0 + 0.5).b);
  float body = dens * (0.68 + 0.36 * pat) + (fib - 0.5) * 0.2;
  float a = smoothstep(0.56, 0.9, body);
  a *= 0.6 + 0.4 * smoothstep(0.3, 0.75, fib2);
  // from above, the streaks are only a faint veil
  a *= 0.55 * mix(0.2, 1.0, step(uEye.y, CIRRUS_KM));
  if (a < 0.003) return vec4(0.0);
  float dS = texture(uCloud, uv + vec2(0.0, 0.025)).g;
  float lit = smoothstep(-0.02, 0.08, dens - dS);
  float sw = pow(max(0.0, dot(normalize(p.xz - uEye.xz), normalize(uSun.xz))), 2.0);
  float below = step(uEye.y, CIRRUS_KM);
  vec3 c = mix(vec3(0.5, 0.4, 0.72), vec3(0.98, 0.62, 0.64), sw * 0.8 + 0.12);
  c = mix(c, vec3(1.0, 0.84, 0.68), lit * (0.25 + sw * 0.6) * below);
  c *= mix(0.55, 1.0, below);
  float lm = glow(p, uHead, 45.0) + glow(p, uBurst, 60.0) * 2.0;
  c += vec3(1.0, 0.85, 0.65) * lm * (0.3 + lit);
  float fog = 1.0 - exp(-t / 260.0);
  c = mix(c, fogCol, fog);
  return vec4(c * a, a);
}

vec3 ground(vec3 d, float t, vec3 fogCol, float px) {
  vec3 p = uEye + d * t;
  // LAND
  // land and sea at the largest scale, ridges on the land, a faint line of coast
  float m = texture(uCloud, p.xz / 260.0 + 0.13).b;
  float land = smoothstep(0.47, 0.5, m);
  float fp = t * px;
  vec2 sun = normalize(uSun.xz);
  float sw = max(0.0, dot(normalize(p.xz - uEye.xz), sun));
  vec3 c = vec3(0.03, 0.045, 0.12) + fogCol * 0.07 * sw;
  vec3 lc = vec3(0.07, 0.055, 0.12);
  if (uEye.y > 8.0) {
    // RELIEF
    // ranges from a height sheet, lit low from the sunset: warm ridges, shadowed valleys
    vec2 gu = p.xz / 70.0 + 0.31;
    float hgt = texture(uCloud, gu, 1.0).r;
    float hx = texture(uCloud, gu + vec2(0.012, 0.0), 1.0).r;
    float hz = texture(uCloud, gu + vec2(0.0, 0.012), 1.0).r;
    float range = smoothstep(0.5, 0.68, hgt);
    vec3 n = normalize(vec3(-(hx - hgt) * 26.0, 1.0, -(hz - hgt) * 26.0));
    float relief = dot(n, normalize(vec3(uSun.x, 0.3, uSun.z)));
    lc *= 0.6 + 0.9 * range * (relief * 0.5 + 0.5);
    lc += vec3(0.55, 0.28, 0.26) * 0.2 * range * smoothstep(0.55, 0.85, relief);
    // RIVERS
    // thin lines along a noise contour, never under a pixel and a half, catching the glow
    float rv = texture(uCloud, p.xz / 38.0 + 0.9, 0.5).r;
    float w = 0.01 + fp / 38.0 * 1.5;
    float river = (1.0 - smoothstep(0.0, w, abs(rv - 0.5))) * min(1.0, 0.012 / w) * (1.0 - range);
    river *= smoothstep(0.55, 0.7, texture(uCloud, p.xz / 90.0 + 0.2).b);
    lc = mix(lc, fogCol * 0.5, river * 0.7);
  }
  c = mix(c, lc, land);
  // the coast, a shade lighter
  c += vec3(0.25, 0.2, 0.3) * 0.22 * (1.0 - abs(land * 2.0 - 1.0));
  // the terminator glow on the sunset side
  c += vec3(0.5, 0.28, 0.25) * 0.08 * sw * sw;
  // TOWNS
  // lights clustered into towns, seen through the gaps from high up
  if (fp < 1.4 && uEye.y > 8.0) {
    vec2 g = p.xz / 1.2;
    vec2 cell = floor(g);
    float h = h3(vec3(cell, 8.0));
    float town = smoothstep(0.55, 0.7, texture(uCloud, p.xz / 70.0 + 0.7).b) * land;
    if (h < town * 0.08) {
      vec2 lp = cell + 0.5 + (vec2(h3(vec3(cell, 5.0)), h3(vec3(cell, 6.0))) - 0.5) * 0.7;
      float rad = max(0.06, fp * 1.4 / 1.2);
      float k = exp(-dot(g - lp, g - lp) / (rad * rad)) * min(1.0, 0.06 / rad) * 1.6;
      c += vec3(1.0, 0.72, 0.4) * k * smoothstep(1.4, 0.5, fp);
    }
  }
  // the town below the hill: lights on a grid of streets round the origin
  float r = length(p.xz);
  if (r < 3.2) {
    vec2 g = p.xz / 0.06;
    vec2 cell = floor(g);
    float h = h3(vec3(cell, 4.0));
    float street = max(step(0.9, fract(cell.x / 6.0)), step(0.85, fract(cell.y / 5.0)));
    if (h < 0.1 + street * 0.25) {
      vec2 lp = cell + 0.5 + (vec2(h3(vec3(cell, 1.0)), h3(vec3(cell, 2.0))) - 0.5) * 0.6;
      float rad = max(0.05, fp / 0.06 * 1.4);
      float k = exp(-dot(g - lp, g - lp) / (rad * rad)) * min(1.0, 0.05 / rad) * 1.6;
      vec3 lc = mix(vec3(1.0, 0.72, 0.38), vec3(1.0, 0.9, 0.7), h3(vec3(cell, 3.0)));
      c += lc * k * smoothstep(3.2, 1.5, r);
    }
    c += vec3(0.5, 0.32, 0.2) * 0.05 * smoothstep(3.0, 0.5, r);
  }
  c += vec3(1.0, 0.8, 0.6) * (glow(p, uHead, 60.0) * 0.15 + glow(p, uBurst, 80.0) * 0.4);
  return haze(c, t, fogCol, 55.0);
}

void over(inout vec3 c, inout float T, vec4 l) {
  c += T * l.rgb;
  T *= 1.0 - l.a;
}

void main() {
  vec2 ndc = gl_FragCoord.xy / uRes * 2.0 - 1.0;
  vec2 cam = vec2((ndc.x - uShift.x) * uTan * uAspect, (ndc.y - uShift.y) * uTan);
  vec3 d = normalize(uFwd + uRight * cam.x + uUp * cam.y);
  float px = 2.0 * uTan / uRes.y;
  float alt = uEye.y;

  vec3 fogCol = dome(normalize(vec3(d.x, -sqrt(2.0 * max(alt, 0.0) / R) + 0.01, d.z)), alt);
  float tHit = 1e9;
  vec3 bg = dome(d, alt);
  float tg = shell(d, 0.0);
  if (tg > 0.0) {
    bg = ground(d, tg, fogCol, px);
    tHit = tg;
  }
  if (alt < 12.0) {
    hill(d, 26.0, 0.0, tHit, bg, fogCol);
    hill(d, 48.0, 2.0, tHit, bg, fogCol);
  }
  if (tHit > 1e8) {
    float sv = smoothstep(0.02, 0.35, d.y + 0.1) * (1.0 - uFlash * 0.6);
    bg += (stars(d, 260.0, px) + stars(d, 90.0, px) * 0.8) * sv;
    bg += moon(d, px);
  }
  // the flash fills the sky toward the burst
  if (uFlash > 0.0) {
    vec3 tb = normalize(uBurst.xyz - uEye);
    float k = max(0.0, dot(d, tb));
    // held back behind the type: the title and hud bands stay readable
    vec2 sv = gl_FragCoord.xy / uRes;
    float text = smoothstep(0.0, 0.34, sv.y) * mix(0.55, 1.0, smoothstep(0.92, 0.78, sv.y));
    bg += vec3(1.0, 0.86, 0.72) * uFlash * (0.07 + 0.75 * pow(k, 8.0)) * mix(0.35, 1.0, text);
  }

  // LAYERS
  // nearest first: the cloud decks and the meteor, then the backdrop
  float tc = shell(d, CIRRUS_KM);
  float ts = shell(d, SEA_KM);
  vec4 lc = tc > 0.0 && tc < tHit ? cirrus(d, tc, fogCol, px) : vec4(0.0);
  vec4 ls = ts > 0.0 && ts < tHit ? sea(d, ts, fogCol, px) : vec4(0.0);
  vec2 uv = gl_FragCoord.xy / uRes;
  vec4 m = uMeteorDist < tHit || tHit > 1e8 ? texture(uMeteor, uv) : vec4(0.0);
  m.rgb = 1.0 - exp(-m.rgb * 1.15);
  if (lc.a > 0.0 && ls.a > 0.0 && ts < tc) {
    vec4 x = lc;
    lc = ls;
    ls = x;
    float y = tc;
    tc = ts;
    ts = y;
  }
  vec3 c = vec3(0.0);
  float T = 1.0;
  bool met = false;
  if (lc.a > 0.0) {
    if (!met && uMeteorDist < tc) { over(c, T, m); met = true; }
    over(c, T, lc);
  }
  if (ls.a > 0.0) {
    if (!met && uMeteorDist < ts) { over(c, T, m); met = true; }
    over(c, T, ls);
  }
  if (!met) over(c, T, m);
  c += T * bg;

  // GRADE
  float vig = 1.0 - 0.28 * dot(ndc * vec2(0.8, 1.0), ndc * vec2(0.8, 1.0)) * 0.5;
  c *= vig;
  c += (h3(vec3(gl_FragCoord.xy, uTime)) - 0.5) / 255.0;
  o = vec4(c, 1.0);
}`;

// TRAIL
// each strand is a strip along a body's history, widened on screen. strands twist round the
// path and spread as the gas cools, white to gold to magenta, violet and blue
export const TRAIL_VS = `#version 300 es
precision highp float;
precision highp sampler2D;
${CAMERA}
uniform sampler2D uHist;
uniform float uTime;
uniform vec3 uWind;
layout(location = 0) in vec4 aStrand; // phase, spread, width, hue
layout(location = 1) in vec4 aMeta; // row, head, count, kind: 0 main, 1 fragment, 2 guide
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
  // the lingering train drifts and curls in the high wind
  c += uWind * age * age;
  c += (n1 * sin(float(ic) * 0.05 + aStrand.x * 2.0 + age * 0.4) + n2 * 0.6 * cos(float(ic) * 0.037 + age * 0.3)) * 0.05 * age * age;
  // fresh plasma flickers
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
  float minPx = guide ? 0.8 : (aMeta.w > 0.5 ? 1.0 : 2.0) * aStrand.z;
  float wpx = min(max(px, minPx), 90.0);
  a.xy += nrm * side * wpx * 2.0 / uRes.y * a.w;
  gl_Position = a;
  vAcross = side;
  vT = guide ? 0.0 : pow(age / life, 0.5);
  // both ends ease: the oldest points taper away, so a fresh trail grows in from its head
  float tail = smoothstep(float(last), float(last) - 40.0, float(i)) * smoothstep(0.0, 2.0, float(count));
  // once the body is gone its end of the trail tapers too
  if (fract(aMeta.w) > 0.2) tail *= smoothstep(0.0, 14.0, float(i));
  vBright = i > last || count == 0 ? 0.0 : max(sqrt(lum) * 1.3, 0.08) * max(0.75, sqrt(px / wpx)) * tail;
  vHue = aStrand.w;
  vKind = aMeta.w + (aStrand.z > 3.0 ? 4.0 : 0.0);
}`;

export const TRAIL_FS = `#version 300 es
precision highp float;
in float vAcross;
in float vT;
in float vBright;
in float vHue;
in float vKind;
out vec4 o;
vec3 ramp(float t) {
  vec3 c = mix(vec3(1.0, 0.97, 0.9), vec3(1.0, 0.72, 0.26), smoothstep(0.0, 0.06, t));
  c = mix(c, vec3(1.0, 0.3, 0.5), smoothstep(0.12, 0.28, t));
  c = mix(c, vec3(0.6, 0.28, 1.0), smoothstep(0.28, 0.5, t));
  c = mix(c, vec3(0.2, 0.46, 1.0), smoothstep(0.5, 0.8, t));
  return c;
}
void main() {
  float a = abs(vAcross);
  float prof = smoothstep(1.0, 0.6, a) * 0.55 + smoothstep(0.45, 0.0, a) * 0.7;
  // with age the strands soften and diffuse into a glow
  prof = mix(prof, (1.0 - a) * (1.0 - a) * 0.7, smoothstep(0.2, 0.7, vT));
  if (vKind > 3.5) prof = (1.0 - a) * (1.0 - a) * 0.45;
  float t = clamp(vT + vHue, 0.0, 1.0);
  float fade = (1.0 - smoothstep(0.45, 1.0, vT)) * exp(-vT * 0.9);
  float b = vBright / (1.0 + vBright * 0.6);
  o = vec4(ramp(t) * b * prof * fade * 1.05, 0.0);
}`;

// SPARKS
// burning grains and molten drops, streaked by their motion against the camera
export const SPARK_VS = `#version 300 es
precision highp float;
${CAMERA}
${CORNER}
uniform vec3 uCamVel;
layout(location = 0) in vec3 aP;
layout(location = 1) in vec3 aV;
layout(location = 2) in vec4 aL; // age, life, size, kind
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
  float len = length(d) * (aL.w > 3.5 ? 0.2 : 1.0); // chunks read as tumbling bits, not streaks
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
  float r = length(vec2(vQ.x * 0.35, vQ.y));
  float k = smoothstep(1.0, 0.2, length(vQ * vec2(0.6, 1.0)));
  vec3 hot = vKind > 0.5 ? vec3(1.0, 0.6, 0.25) : vec3(1.0, 0.9, 0.62);
  vec3 cool = vKind > 1.5 ? vec3(0.9, 0.2, 0.12) : vec3(1.0, 0.36, 0.14);
  if (vKind > 2.5) {
    // melt sheets bright and thin; chunks glow and dim to a dark red
    hot = vKind > 3.5 ? vec3(1.0, 0.5, 0.18) : vec3(1.2, 0.85, 0.45);
    cool = vKind > 3.5 ? vec3(0.4, 0.08, 0.06) : vec3(1.0, 0.3, 0.1);
  }
  vec3 c = mix(hot, cool, smoothstep(0.1, 0.8, vT));
  float fade = (1.0 - vT) * (1.0 - vT) * smoothstep(0.0, 0.08, vT);
  o = vec4(c * k * fade * vB * 1.8 * (1.0 - r * 0.2), 0.0);
}`;

// SPRITES
// the head, the airburst fireball and its ring in the world; flare ghosts on the lens
export const SPRITE_VS = `#version 300 es
precision highp float;
${CAMERA}
${CORNER}
layout(location = 0) in vec3 aP;
layout(location = 1) in vec3 aD;
layout(location = 2) in vec4 aS; // radius km or size px, light, kind, seed
out vec2 vPx;
out float vR;
out vec2 vDir;
out vec4 vS;
out vec3 vTint;
out float vExt;
void main() {
  vec2 q = corner();
  vExt = 1e6;
  float kind = aS.z;
  vS = aS;
  vTint = aD;
  if (kind > 2.5 && kind < 6.5) {
    // lens: aP.xy is the place in ndc, aS.x the size in px
    vec2 ext = kind > 5.5 ? vec2(aS.x, 7.0) : vec2(aS.x);
    vPx = q * ext;
    vR = aS.x;
    vDir = vec2(1.0, 0.0);
    gl_Position = vec4(aP.xy + vPx * 2.0 / (vec2(uAspect, 1.0) * uRes.y), 0.0, 1.0);
    return;
  }
  vec4 c = project(aP);
  if (c.w < 0.002) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  float rpx = aS.x / kmPerPx(c.w);
  float ext = kind < 0.5 ? max(rpx * 9.0, 50.0 + 110.0 * min(aS.y, 3.0)) : max(rpx * 3.0, 40.0);
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
uniform vec4 uBite; // where a piece came off the main body, and how fresh the bite is
uniform vec4 uCrack; // a seam opening on the main body, and how far
in vec2 vPx;
in float vR;
in vec2 vDir;
in vec4 vS;
in vec3 vTint;
in float vExt;
out vec4 o;
float hex(vec2 p) {
  p = abs(p);
  return max(p.x * 0.866 + p.y * 0.5, p.y);
}
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
    // the flight direction in the world and on screen
    vec3 U = normalize(vTint);
    vec2 U2 = vec2(dot(U, uRight), dot(U, uUp));
    vec2 f = vDir;
    vec2 s = vec2(-f.y, f.x);
    float u = dot(p, f);
    float v = dot(p, s);
    float R = max(vR, 0.6);
    float Lc = min(L, 2.5);
    float win = 1.0 - smoothstep(0.55, 1.0, d / vExt);
    vec3 col = vec3(1.0, 0.62, 0.36) * Lc * 0.45 * exp(-d / (8.0 + 14.0 * Lc));
    col += vec3(1.0, 0.9, 0.78) * Lc * exp(-d / (2.0 + 2.2 * Lc)) * 0.9;
    float ub = u < 0.0 ? u * 0.3 : u * 1.3;
    col += vec3(1.0, 0.86, 0.62) * exp(-length(vec2(ub, v)) / (R * 1.3 + 1.5)) * Lc * 0.6;
    // BOW SHOCK
    // a soft glowing cap that hugs the face into the air and wraps round it
    vec2 g = p / R;
    float r = length(g);
    float fr = dot(g / max(r, 1e-3), U2) + (1.0 - length(U2)) * 0.9;
    float cap = exp(-max(0.0, r - 1.05) / 0.6) * smoothstep(-0.35, 0.9, fr);
    col += vec3(0.8, 0.9, 1.0) * cap * Lc * 0.5 * smoothstep(1.5, 5.0, R);
    float cr = exp(-abs(p.y) * 0.8) * exp(-abs(p.x) / (26.0 + 70.0 * L));
    cr += exp(-abs(p.x) * 0.8) * exp(-abs(p.y) / (14.0 + 34.0 * L)) * 0.55;
    col += vec3(1.0, 0.9, 0.8) * cr * min(L, 2.0) * 0.3;
    col *= win;
    // ROCK
    // a lumpy body shaded in 3D: facets in its own frame, so every angle holds up
    // worn: 0 fresh, 1 eaten down; the air rounds it off as it goes
    float worn = floor(wv) / 15.0;
    float ang = atan(g.y, g.x);
    float lump = 0.13 * sin(ang * 3.0 + seed * 20.0) + 0.08 * sin(ang * 5.0 - seed * 13.0);
    lump = 1.0 + (lump + 0.04 * sin(ang * 9.0 + seed * 7.0)) * (1.0 - 0.6 * worn);
    // the bite a piece left in the outline, wearing smooth
    vec2 B2 = vec2(dot(uBite.xyz, uRight), dot(uBite.xyz, uUp));
    float bl = length(B2);
    if (isMain && uBite.w > 0.01 && bl > 0.05) {
      float depth = 0.3 * sqrt(uBite.w) * bl;
      lump -= depth * smoothstep(0.8, 0.97, dot(g / max(r, 1e-3), B2 / bl));
    }
    float rock = smoothstep(R * lump + 0.7, R * lump - 0.7, d) * smoothstep(1.5, 4.0, R);
    if (rock <= 0.0) {
      o = vec4(col, 0.0);
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
    // the crust cracks open and pits as it is eaten away
    float seam = 1.0 - smoothstep(0.0, 0.05 + 0.07 * worn, min(e.x, min(e.y, e.z)));
    vec3 fc = fract(cp) - 0.5;
    float pit = smoothstep(1.0 - worn * 0.7, 1.0, h3(cell + 5.1)) * smoothstep(0.3, 0.1, length(fc));
    // lit by its own plasma: the face into the air white-hot, cooling back across the body
    float heat = dot(N, U);
    vec3 hot = mix(vec3(1.0, 0.4, 0.1), vec3(2.0, 1.7, 1.3), smoothstep(0.4, 0.95, heat));
    float molten = smoothstep(-0.15 - 0.2 * worn, 0.45, heat);
    float glow = 0.18 + 0.82 * max(0.0, heat * 0.6 + 0.4);
    vec3 crust = mix(vec3(0.24, 0.1, 0.07), vec3(0.07, 0.045, 0.055), worn) * glow;
    crust += vec3(1.0, 0.38, 0.1) * max(seam, pit) * smoothstep(-0.8, 0.2, heat) * (0.5 + 0.5 * worn + 0.3 * Lc);
    float rim = pow(1.0 - nv.z, 2.5) * smoothstep(0.3, -0.4, heat);
    crust += vec3(0.42, 0.56, 1.0) * rim * 0.75;
    vec3 rc = mix(crust, hot, molten);
    if (isMain) {
      // the fresh face where a piece broke off glows, then cools with the bite
      float bd = smoothstep(0.76, 0.9, dot(N0, uBite.xyz)) * uBite.w;
      rc = mix(rc, vec3(1.5, 0.7, 0.22), bd);
      // the seam glows open round the piece about to go, which darkens as it lifts
      float cd = dot(N0, uCrack.xyz);
      float seamOpen = (1.0 - smoothstep(0.0, 0.03 + 0.03 * uCrack.w, abs(cd - 0.8))) * uCrack.w;
      rc *= 1.0 - 0.35 * step(0.8, cd) * uCrack.w;
      rc += vec3(1.6, 0.66, 0.16) * seamOpen * 1.6;
    }
    rock *= 0.92;
    o = vec4(col * (1.0 - rock * 0.75) + rc * rock, rock);
    return;
  }
  if (kind < 1.5) {
    // FIREBALL
    // white, then orange, then red as it cools; vTint.x is its age 0 to 1
    float x = d / max(vR, 1.0);
    float cool = vTint.x;
    vec3 hot = mix(vec3(1.0, 0.97, 0.9), vec3(1.0, 0.55, 0.2), smoothstep(0.0, 0.35, cool));
    hot = mix(hot, vec3(0.75, 0.2, 0.22), smoothstep(0.3, 0.8, cool));
    vec3 c = mix(hot, hot * vec3(1.0, 0.6, 0.5), smoothstep(0.0, 0.9, x));
    float k = smoothstep(1.0, 0.0, x);
    float win = 1.0 - smoothstep(0.5, 1.0, d / vExt);
    o = vec4(c * L * (k * k * 1.6 + exp(-x * 1.6) * 0.5 * win), 0.0);
    return;
  }
  if (kind < 2.5) {
    // SHOCK RING
    float w = 1.5 + vR * 0.05;
    o = vec4(vec3(0.8, 0.9, 1.0) * L * exp(-abs(d - vR) / w) * 0.6, 0.0);
    return;
  }
  if (kind > 6.5) {
    // DEBRIS CLOUD
    // the smoke left behind, billowing, lit pink from the dusk on one side; vTint.x heat
    float x = d / max(vR, 1.0);
    float a2 = atan(p.y, p.x);
    float edge = 1.0 + 0.12 * sin(a2 * 5.0 + seed * 9.0) + 0.07 * sin(a2 * 11.0 - seed * 4.0);
    float body = smoothstep(edge, edge - 0.35, x);
    float puff = 0.5 + 0.5 * sin(p.x / vR * 7.0 + seed * 5.0) * sin(p.y / vR * 6.0 - seed * 3.0);
    float lit = clamp(dot(p / vR, normalize(vec2(0.7, 0.55))) * 0.6 + 0.45 + puff * 0.15, 0.0, 1.0);
    vec3 c = mix(vec3(0.17, 0.12, 0.27), vec3(0.88, 0.5, 0.55), smoothstep(0.35, 0.75, lit));
    c += vec3(1.0, 0.42, 0.14) * vTint.x * smoothstep(0.8, 0.0, x) * 1.4;
    float a = body * L;
    o = vec4(c * a, a * 0.85);
    return;
  }
  // LENS
  float x = d / vR;
  float k = 0.0;
  if (kind < 3.5) k = smoothstep(1.0, 0.85, x) * (0.5 + 0.5 * x);
  else if (kind < 4.5) k = exp(-abs(x - 0.9) * 22.0);
  else if (kind < 5.5) k = smoothstep(1.0, 0.94, hex(p / vR)) * 0.8;
  else k = exp(-abs(p.y) / 1.6) * pow(max(0.0, 1.0 - abs(p.x) / vR), 2.0);
  o = vec4(vTint * k * L, 0.0);
}`;
