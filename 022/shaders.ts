import { WING, scallops } from "./bats";

// SONAR
const SPEED_M_S = 28; // change front speed here
const RANGE_M = 95;
const HOLD_S = 1.8; // change afterglow here
const END_S = HOLD_S * 2;

export const SONAR = {
  MAX_PINGS: 48,
  SPEED_M_S,
  RANGE_M,
  LIFE_S: RANGE_M / SPEED_M_S + END_S,
  GLOW_S: 0.45, // change flash length here
  HOLD_S,
  END_S,
  FALL: 0.00017, // change distance falloff here
  FLOOR: 0.17,
  CELL_PX: 3.2, // change stipple size here
  MIN_CELL_M: 0.012,
};

const f = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));
const v2 = (p: number[]) => `vec2(${f(p[0])}, ${f(p[1])})`;

// COMMON
// ping field and stipple, shared by rock, water and bats
const COMMON = `
#define MAX_PINGS ${SONAR.MAX_PINGS}
uniform vec4  uPings[MAX_PINGS];
uniform float uTime;
uniform float uPx;
uniform float uDpr;
uniform vec4  uWater;

const float SPEED  = ${f(SONAR.SPEED_M_S)};
const float LIFE   = ${f(SONAR.LIFE_S)};
const float GLOW   = ${f(SONAR.GLOW_S)};
const float HOLD   = ${f(SONAR.HOLD_S)};
const float END    = ${f(SONAR.END_S)};
const float RANGE  = ${f(SONAR.RANGE_M)};
const float FLOOR  = ${f(SONAR.FLOOR)};
const float FALL   = ${f(SONAR.FALL)};
const float CELL   = ${f(SONAR.CELL_PX)};
const float MIN_CELL = ${f(SONAR.MIN_CELL_M)};
const vec3  BONE   = vec3(0.016, 0.027, 0.039);
const vec3  DEEP   = vec3(0.07, 0.36, 0.46);
const vec3  CYAN   = vec3(0.3, 0.82, 0.98);
const vec3  PALE   = vec3(0.86, 0.97, 1.0);

// SONAR
// x held echo, y fronts, z freshness; uniform-only branches keep fwidth valid
vec3 sonar(vec3 p, vec3 n, float two) {
  vec3 o = vec3(0.0);
  for (int i = 0; i < MAX_PINGS; i++) {
    vec4 g = uPings[i];
    float age = uTime - g.w;
    if (age < 0.0 || age > LIFE) continue;
    vec3 d = g.xyz - p;
    float r = max(length(d), 1e-3);
    float aa = max(fwidth(r), 1e-4);
    float x = age * SPEED - r;
    float dn = dot(n, d / r);
    float face = mix(max(dn, 0.0), abs(dn), two);
    float reach = 1.0 - smoothstep(RANGE * 0.9, RANGE, r);
    float e = reach / (1.0 + r * r * FALL);
    float since = x / SPEED;
    float life = 1.0 - smoothstep(HOLD, END, since);
    float glow = x > 0.0 ? (0.55 * exp(-since / GLOW) + 0.45 * exp(-since / HOLD)) * life : 0.0;
    float front = 1.0 - smoothstep(aa * 1.0, aa * 2.4, abs(x));
    float tail = (1.0 - smoothstep(aa * 0.4, aa * 1.3, abs(x - 0.6))) * 0.3
               + (1.0 - smoothstep(aa * 0.4, aa * 1.3, abs(x - 1.5))) * 0.12;
    o.x += glow * max(e * (0.45 + 0.55 * face), FLOOR * reach);
    o.y += e * (front + tail) * (0.3 + 0.7 * face);
    o.z = max(o.z, exp(-since / GLOW) * step(0.0, x) * life);
  }
  return o;
}

uvec3 pcg3(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}

float dotsAt(vec3 p, float cell, float rad, float aa) {
  vec3 q = p / cell;
  vec3 id = floor(q);
  vec3 h = vec3(pcg3(uvec3(ivec3(id) + 65536))) / 4294967295.0;
  float d = length(q - id - h);
  rad *= 0.7 + 0.6 * h.x;
  return 1.0 - smoothstep(rad - aa, rad + aa, d);
}

// STIPPLE
// constant screen density: two octave cell sizes crossfaded by log2 depth
float stipple(vec3 p, float depth, float amount) {
  float lod = log2(max(depth * uPx * CELL, MIN_CELL));
  float fl = floor(lod);
  float k = lod - fl;
  float c0 = exp2(fl);
  float rad = 0.42 * sqrt(clamp(amount, 0.0, 1.0));
  float px = depth * uPx / (uDpr * c0);
  return mix(dotsAt(p, c0, rad, px), dotsAt(p, c0 * 2.0, rad, px * 0.5), k);
}

vec3 tone(float fresh) {
  vec3 c = mix(DEEP, CYAN, smoothstep(0.0, 0.55, fresh));
  return mix(c, PALE, smoothstep(0.55, 1.0, fresh));
}
`;

// ROCK
export const CAVE_VS = `
uniform vec4 uWater;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vDepth;

void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vNormal = normal;
#ifdef MIRROR
  w.y = 2.0 * uWater.y - w.y;
#endif
  vec4 v = viewMatrix * w;
  vDepth = -v.z;
  gl_Position = projectionMatrix * v;
}
`;

export const CAVE_FS = `
${COMMON}
varying vec3 vWorld;
varying vec3 vNormal;
varying float vDepth;

void main() {
#ifdef MIRROR
  if (vWorld.y < uWater.y) discard;
#else
  if (vWorld.y < uWater.y && distance(vWorld.xz, uWater.xz) < uWater.w) discard;
#endif
  vec3 s = sonar(vWorld, normalize(vNormal), 0.0);
  float amt = 1.0 - exp(-1.3 * s.x);
  float st = stipple(vWorld, vDepth, amt);
  vec3 col = tone(s.z) * (st * (0.2 + 1.2 * amt) + amt * 0.03) + PALE * min(s.y, 1.0);
#ifdef MIRROR
  col *= 0.68;
#endif
  gl_FragColor = vec4(BONE + col, 1.0);
}
`;

// WATER
export const WATER_VS = `
varying vec3 vWorld;
varying float vDepth;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vec4 v = viewMatrix * w;
  vDepth = -v.z;
  gl_Position = projectionMatrix * v;
}
`;

export const WATER_FS = `
${COMMON}
varying vec3 vWorld;
varying float vDepth;

void main() {
  if (distance(vWorld.xz, uWater.xz) > uWater.w) discard;
  vec3 s = sonar(vWorld, vec3(0.0, 1.0, 0.0), 0.0);
  float st = stipple(vWorld, vDepth * 1.6, min(s.x * 1.4, 1.0));
  vec3 col = mix(CYAN, PALE, 0.5) * min(s.y * 1.6, 1.0) + CYAN * st * 0.5;
  gl_FragColor = vec4(col, 0.3);
}
`;

// BATS
// sheet hinged at shoulder and wrist; outline from a polygon SDF minus scallop circles
const poly = WING.POLY.map(v2).join(", ");
const cuts = scallops();
const cutsGlsl = cuts.map((c) => `vec3(${f(c[0])}, ${f(c[1])}, ${f(c[2])})`).join(", ");
const bones = [
  [WING.POLY[0], WING.POLY[1]],
  ...WING.FINGERS.map((i) => [WING.POLY[1], WING.POLY[i]]),
  [WING.POLY[1], WING.THUMB],
];
const bonesGlsl = bones.map(([a, b]) => `vec4(${f(a[0])}, ${f(a[1])}, ${f(b[0])}, ${f(b[1])})`);

export const BAT_VS = `
uniform vec4 uWater;
attribute vec3 aFlap;
varying vec2 vUv;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vDepth;

const float BODY  = ${f(WING.BODY)};
const float WRIST = ${f(WING.WRIST)};

void main() {
  float ax = abs(position.x);
  float sg = position.x < 0.0 ? -1.0 : 1.0;
  float fold = aFlap.z;
  float a1 = mix(0.7 * sin(aFlap.y) + 0.08, -1.25, fold);
  float a2 = mix(0.5 * sin(aFlap.y - 1.1) - 0.1, -1.9, fold);
  float s1 = clamp(ax, BODY, WRIST) - BODY;
  float s2 = max(ax - WRIST, 0.0) * (1.0 - 0.35 * fold);
  vec3 q = vec3(BODY + s1 * cos(a1) + s2 * cos(a1 + a2), s1 * sin(a1) + s2 * sin(a1 + a2), position.z);
  float ang = ax > WRIST ? a1 + a2 : a1;
  vec3 n = vec3(-sin(ang), cos(ang), 0.0);
  if (ax < BODY) {
    q = vec3(ax, 0.0, position.z);
    n = vec3(0.0, 1.0, 0.0);
  }
  q.x *= sg;
  n.x *= sg;
  mat4 m = modelMatrix * instanceMatrix;
  vec4 w = m * vec4(q, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(mat3(m) * n);
  vUv = position.xz;
#ifdef MIRROR
  w.y = 2.0 * uWater.y - w.y;
#endif
  vec4 v = viewMatrix * w;
  vDepth = -v.z;
  gl_Position = projectionMatrix * v;
}
`;

export const BAT_FS = `
${COMMON}
varying vec2 vUv;
varying vec3 vWorld;
varying vec3 vNormal;
varying float vDepth;

const vec2 POLY[${WING.POLY.length}] = vec2[](${poly});
const vec3 CUTS[${cuts.length}] = vec3[](${cutsGlsl});
const vec4 BONES[${bones.length}] = vec4[](${bonesGlsl.join(", ")});

float seg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

float wing(vec2 p) {
  float d = dot(p - POLY[0], p - POLY[0]);
  float s = 1.0;
  for (int i = 0, j = ${WING.POLY.length - 1}; i < ${WING.POLY.length}; j = i, i++) {
    vec2 e = POLY[j] - POLY[i];
    vec2 w = p - POLY[i];
    vec2 b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
    d = min(d, dot(b, b));
    bvec3 c = bvec3(p.y >= POLY[i].y, p.y < POLY[j].y, e.x * w.y > e.y * w.x);
    if (all(c) || all(not(c))) s = -s;
  }
  d = s * sqrt(d);
  for (int i = 0; i < ${cuts.length}; i++) d = max(d, CUTS[i].z - length(p - CUTS[i].xy));
  return d;
}

float bonesAt(vec2 p) {
  float d = 1e3;
  for (int i = 0; i < ${bones.length}; i++) d = min(d, seg(p, BONES[i].xy, BONES[i].zw));
  return d;
}

float body(vec2 p) {
  float torso = length((p - vec2(0.0, -0.07)) / vec2(0.075, 0.19)) - 1.0;
  float head = (length(p - vec2(0.0, 0.14)) - 0.058) / 0.06;
  float ear = (seg(p, vec2(0.022, 0.17), vec2(0.045, 0.255)) - 0.014) / 0.03;
  return min(min(torso, head), ear);
}

void main() {
  vec2 p = vec2(abs(vUv.x), vUv.y);
  float px = length(fwidth(vUv));
  float dw = wing(p);
  float db = bonesAt(p);
  float dt = body(p);
  float inWing = 1.0 - smoothstep(-px, px, dw);
  float inBody = 1.0 - smoothstep(-0.08, 0.08, dt);
  float edge = 1.0 - smoothstep(px * 0.35, px * 1.05, abs(dw));
  float bone = (1.0 - smoothstep(px * 0.3, px * 0.9 + 0.003, db)) * step(dw, px);
  if (inWing + inBody + edge < 0.002) discard;

  vec3 s = sonar(vWorld, normalize(vNormal), 1.0);
  float amt = min(s.x * 2.4, 1.0);
  vec3 t = tone(s.z);
  float st = stipple(vWorld, vDepth, amt);
  float lines = max(edge, bone * 0.7) + inBody * 0.55;
  vec3 col = t * (lines * amt * 1.3 + inWing * st * 0.6) + PALE * min(s.y * 2.0, 1.0) * max(edge, inBody);
#ifdef MIRROR
  col *= 0.68;
#endif
  gl_FragColor = vec4(BONE + col, 1.0);
}
`;
