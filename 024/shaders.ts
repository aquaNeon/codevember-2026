import { SEG, SHAPE_GLSL } from "./form";

const HEAD = `#version 300 es
precision highp float;
precision highp int;
`;

const NOISE = `
float h3(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vn3(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(h3(i), h3(i + vec3(1, 0, 0)), f.x), mix(h3(i + vec3(0, 1, 0)), h3(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(h3(i + vec3(0, 0, 1)), h3(i + vec3(1, 0, 1)), f.x), mix(h3(i + vec3(0, 1, 1)), h3(i + 1.0), f.x), f.y),
    f.z
  );
}
`;

// LIGHT
// warm low key from the right, cool fill, warm back light through the thin green blades
const LIGHT = `
uniform vec3  uKey;
uniform vec3  uBack;
uniform vec3  uEye;
uniform mat4  uLight;
uniform highp sampler2DShadow uShadow;
uniform float uShadowPx;

const vec3 KEY_C  = vec3(1.0, 0.8, 0.58) * 3.6;
const vec3 FILL_C = vec3(0.55, 0.52, 0.5) * 0.6;
const vec3 BACK_C = vec3(1.0, 0.74, 0.45) * 1.1;
const vec2 TAPS[8] = vec2[8](
  vec2(-0.613, 0.617), vec2(0.17, -0.04), vec2(-0.299, -0.792), vec2(0.645, 0.493),
  vec2(-0.651, -0.072), vec2(0.421, -0.735), vec2(-0.017, 0.997), vec2(0.958, -0.2)
);

float shadowAt(vec3 p, vec3 n, float soft) {
  // NORMAL OFFSET
  // bias along the lit-side normal, larger at grazing angles
  float c = dot(n, uKey);
  vec3 nl = c < 0.0 ? -n : n;
  vec4 q = uLight * vec4(p + nl * (0.008 + 0.012 * (1.0 - abs(c))), 1.0);
  vec3 s = q.xyz * 0.5 + 0.5;
  if (s.x < 0.0 || s.y < 0.0 || s.x > 1.0 || s.y > 1.0) return 1.0;
  float z = s.z - 0.002;
  float a = 0.0;
  for (int i = 0; i < 8; i++) a += texture(uShadow, vec3(s.xy + TAPS[i] * uShadowPx * soft, z));
  return a * 0.125;
}

vec3 tone(vec3 c) {
  c = 1.0 - exp(-c * 1.1);
  return pow(c, vec3(1.0 / 2.2));
}
`;

// BLADES
// one ribbon per blade along its surface path; grows to uBuild, slack, then pulls tight
export const BLADE_VS = (defs: string) => `${HEAD}${defs}
layout(location = 0) in vec2 aMesh;
layout(location = 1) in vec4 aA;
layout(location = 2) in vec4 aB;
layout(location = 3) in vec4 aC;
layout(location = 4) in vec4 aD;

uniform mat4  uViewProj;
uniform mat4  uModel;
uniform float uBuild;
uniform float uAge;
uniform float uWin;
uniform vec4  uWind;

out vec3 vPos;
out vec3 vN;
out vec3 vT;
out vec3 vNs;
out vec2 vUv;
out float vAo;
out float vOver;
flat out vec4 vK;
${SHAPE_GLSL}

float gTight;
float gH;
float gSide;
float gFlex;
float gOver;
bool gHor;
float gDoor;

vec2 pathAt(float u) {
  if (aB.w > 1.5) {
    float k = aA.z + aD.x * 12.0 * sin(u * aD.y * 6.2832 + aB.z * 6.2832);
    return doorRing(k, aA.x + aA.w * u);
  }
  float s = aA.x + aA.z * u + aD.x * sin(u * aD.y * 6.2832 + aB.z * 6.2832);
  vec2 sp = vec2(s, aA.y + aA.w * u);
  bool stray = fract(aB.z * 53.0) < 0.025 && (int(aC.y + 0.5) & 8) != 0;
  return stray ? sp : door(sp, gHor, gDoor);
}

float offAt(float u, vec2 sp) {
  float r = radiusAt(clamp(sp.x, 0.0, 1.0));
  // OVER AND UNDER
  // one field, opposite sign per slant direction, so crossing strands alternate
  float g = sin(sp.x * 70.0) * sin(sp.y * r * 34.0);
  gOver = gSide * g;
  float off = aB.x + gSide * 0.005 * g;
  off -= 0.05 * gEdge * gEdge;
  float slack = 1.0 - gTight;
  off += slack * 0.025 * sin(3.14159 * clamp(u / max(gH, 0.01), 0.0, 1.0));
  float head = sstep(gH - 0.22, gH, u) * slack;
  off += head * 0.08;
  gFlex = head;
  return max(off, -0.5 * r);
}

vec3 looseAt(float u, vec3 ns) {
  int fl = int(aC.y + 0.5);
  float e = 0.0;
  if ((fl & 2) != 0) e = pow(sstep(0.84, 1.0, u), 1.4);
  if ((fl & 16) != 0) e = max(e, pow(sstep(0.14, 0.0, u), 1.4));
  e *= gTight;
  if (e <= 0.0) return vec3(0.0);
  gFlex = max(gFlex, e);
  vec3 side = cross(ns, vec3(0.0, 1.0, 0.0));
  side = side / max(length(side), 1e-3);
  float len = 0.03 + 0.1 * fract(aB.z * 13.0);
  vec3 dir = ns * 0.4 + side * (fract(aB.z * 7.0) - 0.5) * 1.6 - vec3(0.0, 0.3, 0.0);
  return dir * e * len;
}

vec3 point(float u, out vec3 ns) {
  vec2 sp = pathAt(u);
  vec3 p = surf(sp.x, sp.y);
  vec3 a = surf(sp.x + 0.004, sp.y) - surf(sp.x - 0.004, sp.y);
  vec3 b = surf(sp.x, sp.y + 0.02) - surf(sp.x, sp.y - 0.02);
  ns = normalize(cross(b, a));
  return p + ns * offAt(u, sp) + looseAt(u, ns);
}

vec3 near(float u, vec3 ns) {
  vec2 sp = pathAt(u);
  return surf(sp.x, sp.y) + ns * offAt(u, sp) + looseAt(u, ns);
}

void main() {
  float b = aC.x;
  float grow = b < 0.0 ? 1.0 : clamp((uBuild - b) / uWin, 0.0, 1.0);
  gH = grow * grow * (3.0 - 2.0 * grow);
  gTight = b < 0.0 ? 1.0 : sstep(b + uWin * 0.8, b + uWin * 1.7, uBuild);
  gSide = aB.w > 0.5 ? 1.0 : sign(aA.w * 4.0 + aA.z + 1e-4);
  gHor = abs(aA.w) * DOOR_RR > abs(aA.z) * DOOR_SPD;
  gDoor = gHor
    ? sign(aA.x + aA.z * 0.5 - DOOR_S + 1e-4)
    : sign(wrapPi(aA.y + aA.w * 0.5 - DOOR_PH) + 1e-4);
  int fl = int(aC.y + 0.5);
  float m = aMesh.x;
  bool loops = (fl & 1) != 0;
  float uu = loops ? (m < 0.78 ? m / 0.78 * 0.86 : 0.86 + (m - 0.78) / 0.22 * 0.14) : m;
  float u = uu * gH;

  vec3 ns;
  float du = 0.006;
  vec3 Pn = point(min(u + du, 1.0), ns);
  vec3 Pp = near(max(u - du, 0.0), ns);
  vec3 P = near(u, ns);
  float flex = gFlex;
  float over = gOver;
  vec3 T = normalize(Pn - Pp);

  // TUCK
  // the end loops out, round and back under
  if (loops) {
    float la = clamp((u - 0.86) / 0.14, 0.0, 1.0) * gTight;
    float a = la * 6.2832;
    P += (ns * (1.0 - cos(a)) + T * sin(a) * 0.8) * 0.018 * gTight * sstep(0.0, 0.05, la);
    T = normalize(T * cos(a) + ns * sin(a) * sstep(0.0, 0.05, la));
  }

  float flut = 0.6 + 0.4 * sin(uWind.w * 5.0 + aB.z * 40.0 + u * 4.0);
  P += uWind.xyz * flex * flut;

  vec3 W = cross(ns, T);
  W = dot(W, W) < 1e-6 ? vec3(1.0, 0.0, 0.0) : normalize(W);
  float tw = aC.z > 0.0 ? 3.14159 * sstep(aC.z - 0.05, aC.z + 0.05, u) : 0.0;
  tw += 0.12 * sin(u * 9.0 + aB.z * 20.0);
  vec3 Wd = cos(tw) * W + sin(tw) * ns;
  vec3 n = normalize(cross(T, Wd));

  float tip = pow(clamp((gH - u) / 0.07, 0.0, 1.0), 0.6);
  float width = aB.y * tip * mix(0.75, 1.0, clamp(u / 0.03, 0.0, 1.0));
  P += Wd * aMesh.y * width * 0.5;

  vec4 w = uModel * vec4(P, 1.0);
  vPos = w.xyz;
  mat3 R = mat3(uModel);
  vN = R * n;
  vT = R * T;
  vNs = R * ns;
  vUv = vec2(u, aMesh.y);
  vAo = sstep(-0.05, 0.01, aB.x);
  vOver = over;
  float green = b < 0.0 ? 0.0 : 1.0 - clamp((uAge - b) / 1.5, 0.0, 1.0);
  green = clamp(green * mix(0.75, 1.25, aC.w), 0.0, 1.0);
  vK = vec4(aB.z, green, aC.w, aC.y);
  gl_Position = grow <= 0.0 ? vec4(0.0, 0.0, -2.0, 1.0) : uViewProj * w;
}`;

export const BLADE_FS = (defs: string) => `${HEAD}${defs}
in vec3 vPos;
in vec3 vN;
in vec3 vT;
in vec3 vNs;
in vec2 vUv;
in float vAo;
in float vOver;
flat in vec4 vK;
${NOISE}
${LIGHT}
out vec4 o;

void main() {
  float u = vUv.x;
  float v = vUv.y;
  float seed = vK.x;
  float green = vK.y;
  float hue = vK.z;
  int fl = int(vK.w + 0.5);
  // FRAY
  // the cut ends split into fibres
  float alpha = 1.0;
  if ((fl & 4) != 0 && (fl & 8) == 0) {
    float fr = max(smoothstep(0.955, 1.0, u), 1.0 - smoothstep(0.0, 0.025, u));
    float fib = fract(v * 3.1 + seed * 7.0);
    float len = h3(vec3(floor(v * 3.1 + seed * 7.0), seed, 3.0));
    alpha *= 1.0 - step(0.5, fib) * step(1.0 - fr, len * 0.9 + 0.05) * step(0.02, fr);
  }
#ifdef SHADOW
  if (alpha < 0.5) discard;
  o = vec4(1.0);
#else
  // MATERIAL
  // fresh blades are green, drying through olive to straw; a few stay pale or go brown
  vec3 straw = mix(vec3(0.66, 0.55, 0.3), vec3(0.82, 0.74, 0.5), hue);
  straw = mix(straw, vec3(0.5, 0.4, 0.22), step(0.86, hue) * 0.7);
  vec3 fresh = mix(vec3(0.24, 0.44, 0.06), vec3(0.5, 0.62, 0.12), hue);
  fresh = mix(fresh, vec3(0.64, 0.66, 0.22), step(0.78, hue) * 0.8);
  fresh = mix(fresh, vec3(0.36, 0.4, 0.14), step(hue, 0.12) * 0.7);
  float shade0 = mix(0.62, 1.12, fract(seed * 17.0));
  float dry = step(0.86, fract(seed * 31.0));
  green *= 1.0 - dry * 0.85;
  vec3 base = mix(straw, fresh, green);
  base = mix(base, vec3(0.56, 0.54, 0.2), green * (1.0 - green) * 1.3);
  // VEINS
  // parallel veins, paler midrib, darker margins; faded below a pixel via fwidth
  float av = abs(v);
  float vf = 1.0 - smoothstep(0.6, 1.4, fwidth(v * 14.0));
  base *= 1.0 + 0.1 * vf * sin(v * 14.0 + seed * 3.0);
  base *= 1.0 + 0.1 * (1.0 - smoothstep(0.0, 0.18, av));
  base *= 1.0 - 0.42 * smoothstep(0.66, 1.0, av);
  base *= 0.86 + 0.24 * vn3(vec3(u * 60.0, v * 1.5, seed * 40.0));
  base *= 1.0 - 0.2 * smoothstep(0.7, 0.85, vn3(vec3(u * 9.0, v * 0.6, seed * 17.0)));
  base *= shade0;
  base = pow(base, vec3(2.2));

  // LIGHT
  vec3 V = normalize(uEye - vPos);
  vec3 n = normalize(vN);
  if (dot(n, V) < 0.0) n = -n;
  vec3 ns = normalize(vNs);
  vec3 T = normalize(vT);
  float inside = smoothstep(0.15, -0.25, dot(n, ns));
  float ao = (0.45 + 0.55 * vAo) * mix(1.0, 0.28, inside) * (0.62 + 0.38 * smoothstep(-0.9, 0.6, vOver));
  float sh = shadowAt(vPos, n, 2.2);
  float ndl = dot(n, uKey);
  float diff = clamp(ndl * 1.1, 0.0, 1.0);
  float thin = 0.3 + 0.7 * green;
  vec3 trans = vec3(1.0, 0.95, 0.45) * thin * clamp(-ndl, 0.0, 1.0) * 0.8;
  // SHEEN
  // Kajiya-Kay along the blade: a sharp white lobe and a tinted one
  vec3 H = normalize(uKey + V);
  float th = dot(T, H);
  float sinTH = sqrt(max(1.0 - th * th, 0.0));
  float spec = pow(sinTH, 70.0) * 0.16;
  vec3 spec2 = base * pow(sinTH, 14.0) * 0.14;
  float front = smoothstep(-0.1, 0.3, ndl);
  // BACK LIGHT
  // rim on the side facing uBack, transmitted through thin green blades
  float rim = pow(1.0 - abs(dot(ns, V)), 2.0);
  float bk = smoothstep(-0.2, 0.5, dot(ns, uBack)) * ao * rim;
  float bl = dot(n, uBack);
  vec3 back = BACK_C * (max(bl, 0.0) * 0.6 + vec3(1.0, 0.95, 0.45) * thin * max(-bl, 0.0) * 1.6) * bk;
  vec3 c = base * (KEY_C * sh * (diff * mix(0.7, 1.0, ao) + trans) + FILL_C * ao + back);
  c += KEY_C * sh * front * (spec + spec2) * (1.0 - 0.5 * inside);
  o = vec4(tone(c), alpha);
#endif
}`;

// STEM
// a thin bare stem the nest hangs from: a bezier, round, with a few nodes
export const STEM_VS = (defs: string) => `${HEAD}${defs}
layout(location = 0) in vec2 aMesh;
uniform mat4 uViewProj;
uniform vec3 uStem[4];
out vec3 vPos;
out vec3 vN;
out vec2 vUv;
vec3 bez(float t) {
  float u = 1.0 - t;
  return u * u * u * uStem[0] + 3.0 * u * u * t * uStem[1] + 3.0 * u * t * t * uStem[2] + t * t * t * uStem[3];
}
void main() {
  float t = aMesh.x;
  float ph = aMesh.y;
  vec3 P = bez(t);
  vec3 T = normalize(bez(min(t + 0.01, 1.0)) - bez(max(t - 0.01, 0.0)));
  vec3 S = normalize(cross(T, vec3(0.0, 0.0, 1.0)));
  vec3 U = cross(S, T);
  float node = exp(-pow(fract(t * 5.0 + 0.3) - 0.5, 2.0) / 0.0006);
  float r = mix(0.026, 0.012, t) * (1.0 + 0.22 * node) * sqrt(clamp((1.0 - t) * 30.0, 0.0, 1.0));
  vec3 n = S * cos(ph) + U * sin(ph);
  vPos = P + n * r;
  vN = n;
  vUv = vec2(t, ph);
  gl_Position = uViewProj * vec4(vPos, 1.0);
}`;

export const STEM_FS = (defs: string) => `${HEAD}${defs}
in vec3 vPos;
in vec3 vN;
in vec2 vUv;
${NOISE}
${LIGHT}
out vec4 o;
void main() {
#ifdef SHADOW
  o = vec4(1.0);
#else
  vec3 n = normalize(vN);
  vec3 base = vec3(0.6, 0.5, 0.32);
  base *= 0.85 + 0.15 * sin(vUv.y * 14.0 + vn3(vec3(vUv.x * 40.0, vUv.y, 1.0)) * 2.0);
  base *= 0.9 + 0.2 * vn3(vec3(vUv.x * 120.0, vUv.y * 3.0, 4.0));
  float node = exp(-pow(fract(vUv.x * 5.0 + 0.3) - 0.5, 2.0) / 0.0004);
  base *= 1.0 - 0.35 * node;
  base = pow(base, vec3(2.2));
  vec3 V = normalize(uEye - vPos);
  float sh = shadowAt(vPos, n, 1.5);
  float diff = clamp(dot(n, uKey) * 0.8 + 0.2, 0.0, 1.0);
  vec3 H = normalize(uKey + V);
  vec3 c = base * (KEY_C * diff * sh + FILL_C) + KEY_C * pow(max(dot(n, H), 0.0), 40.0) * 0.08 * sh;
  o = vec4(tone(c), 1.0);
#endif
}`;

// WALL
// warm plaster: key pool and the nest's shadow from a blurred low-res coverage map
export const WALL_VS = `${HEAD}
uniform mat4 uViewProj;
uniform vec4 uWall;
uniform float uWallZ;
out vec3 vPos;
void main() {
  vec2 c = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 0.5;
  vec2 p = mix(uWall.xy, uWall.zw, c * 2.0);
  vPos = vec3(p, uWallZ);
  gl_Position = uViewProj * vec4(vPos, 1.0);
}`;

export const WALL_FS = `${HEAD}
in vec3 vPos;
uniform vec3  uKey;
uniform mat4  uLight;
uniform sampler2D uCov;
uniform vec3  uTint;
uniform vec2  uPool;
${NOISE}
out vec4 o;
void main() {
  vec4 q = uLight * vec4(vPos, 1.0);
  vec2 s = q.xy * 0.5 + 0.5;
  float cov = texture(uCov, s).r;
  vec2 d = (vPos.xy - uPool) / vec2(3.6, 3.0);
  float pool = exp(-dot(d, d));
  float plaster = (vn3(vec3(vPos.xy * 90.0, 0.0)) - 0.5) * 0.03 + (vn3(vec3(vPos.xy * 7.0, 3.0)) - 0.5) * 0.04;
  float key = 0.5 * (0.55 + 0.45 * pool) * (1.0 - 0.85 * cov);
  vec3 c = uTint * (1.0 + plaster) * (vec3(0.62, 0.62, 0.66) + vec3(1.0, 0.86, 0.68) * key * 1.25);
  o = vec4(pow(c, vec3(1.0 / 2.2)), 1.0);
}`;

// SOFTEN
// a separable gaussian over the coverage map
export const FULL_VS = `${HEAD}
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const BLUR_FS = `${HEAD}
uniform sampler2D uTex;
uniform vec2 uStep;
uniform vec2 uRes;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float c = texture(uTex, uv).r * 0.2;
  c += (texture(uTex, uv + uStep * 1.4).r + texture(uTex, uv - uStep * 1.4).r) * 0.24;
  c += (texture(uTex, uv + uStep * 3.3).r + texture(uTex, uv - uStep * 3.3).r) * 0.11;
  c += (texture(uTex, uv + uStep * 5.2).r + texture(uTex, uv - uStep * 5.2).r) * 0.05;
  o = vec4(c, 0.0, 0.0, 1.0);
}`;

export const STRIP_SEG = SEG;

// COPY
// shader copy, since a blit cannot be trusted to match the canvas format
export const COPY_FS = `${HEAD}
uniform sampler2D uTex;
out vec4 o;
void main() {
  o = vec4(texelFetch(uTex, ivec2(gl_FragCoord.xy), 0).rgb, 1.0);
}`;
