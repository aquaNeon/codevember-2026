// SCENE
// metres. the back wall is the plane z = 0, the floor y = 0, the left wall x = XW with a
// window in it, off to the left of the view. a white plinth stands in front of the back
// wall with the sculpture resting on it

export const SCENE = {
  PLINTH_X_M: -0.35,
  PLINTH_Z_M: 0.6,
  PLINTH_HALF_M: 0.38,
  PLINTH_H_M: 0.92,
  R_M: 0.36, // the sphere, and the height every shape rests at
  WALL_X_M: -2.6, // the window wall
  CEIL_M: 4.2,
};

export const RAYS_N = 256; // rays per side of the grid, change for finer filaments

// the receiver maps, in metres: x and y on the back wall, x and z on the floor
export const WALL_RECT = [-1.6, 0, 4.2, 2.1] as const;
export const FLOOR_RECT = [-1.6, 0, 4.2, 2.1] as const;

const f = (n: number) => n.toFixed(4);
const C_Y = SCENE.PLINTH_H_M + SCENE.R_M;

const COMMON = `
const vec3 C = vec3(${f(SCENE.PLINTH_X_M)}, ${f(C_Y)}, ${f(SCENE.PLINTH_Z_M)});
const vec3 PLINTH_C = vec3(${f(SCENE.PLINTH_X_M)}, ${f(SCENE.PLINTH_H_M / 2)}, ${f(SCENE.PLINTH_Z_M)});
const vec3 PLINTH_B = vec3(${f(SCENE.PLINTH_HALF_M)}, ${f(SCENE.PLINTH_H_M / 2)}, ${f(SCENE.PLINTH_HALF_M)});
const float PLINTH_H = ${f(SCENE.PLINTH_H_M)};
const float R = ${f(SCENE.R_M)};
const float XW = ${f(SCENE.WALL_X_M)};
const float CEIL = ${f(SCENE.CEIL_M)};
const vec4 WIN = vec4(1.6, 1.25, 0.62, 0.55); // window half width, half height, mullion and transom offsets

uniform float uTime;
uniform float uWave;   // surface wobble, metres
uniform vec4  uSq;     // squash along x, along y, slosh, unused
uniform int   uShape;  // 0 sphere, 1 drop, 2 cube
uniform float uBound;  // a sphere round C that holds the shape
uniform vec3  uSun;    // unit, toward the sun
uniform vec2  uWin;    // window centre on the window wall: z, y

// SURFACE
// the shape's skin moves along its normal: a few crossing waves, and the squash and slosh
// from a drag. the base stays put where it rests on the plinth
float disp(vec3 q) {
  vec3 n = q / max(length(q), 1e-4);
  float t = uTime;
  float w = sin(dot(n, vec3(0.83, 0.42, 0.37)) * 5.0 + t * 1.3) * 0.42
          + sin(dot(n, vec3(-0.31, 0.88, 0.36)) * 8.0 - t * 1.7) * 0.28
          + sin(dot(n, vec3(0.45, -0.27, 0.85)) * 12.0 + t * 2.3) * 0.17
          + sin(dot(n, vec3(-0.70, -0.50, 0.50)) * 17.0 - t * 2.9) * 0.09
          + sin(dot(n, vec3(0.20, 0.60, -0.77)) * 25.0 + t * 3.4) * 0.05
          + sin(dot(n, vec3(-0.60, 0.10, -0.79)) * 33.0 - t * 4.1) * 0.03;
  float sq = uSq.x * (1.5 * n.x * n.x - 0.5) + uSq.y * (1.5 * n.y * n.y - 0.5)
           + uSq.z * (n.x * n.z * 2.4 + n.y * n.z * 1.6);
  return (w * uWave + sq) * smoothstep(-0.98, -0.55, n.y);
}

float roundCone(vec3 p, float r1, float r2, float h) {
  float b = (r1 - r2) / h;
  float a = sqrt(1.0 - b * b);
  vec2 q = vec2(length(p.xz), p.y);
  float k = dot(q, vec2(-b, a));
  if (k < 0.0) return length(q) - r1;
  if (k > a * h) return length(q - vec2(0.0, h)) - r2;
  return dot(q, vec2(a, b)) - r1;
}

float roundBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

float shape(vec3 q) {
  if (uShape == 0) return length(q) - R;
  if (uShape == 1) return roundCone(q - vec3(0.0, -R + 0.32, 0.0), 0.32, 0.035, 0.5);
  // a soft cube, turned a little toward the sun
  vec3 b = q - vec3(0.0, -R + 0.27, 0.0);
  float cs = 0.8253;
  float sn = 0.5646;
  b.xz = mat2(cs, sn, -sn, cs) * b.xz;
  return roundBox(b, vec3(0.175), 0.095);
}

float sdf(vec3 p) {
  vec3 q = p - C;
  return shape(q) - disp(q);
}

vec3 normal(vec3 p) {
  const vec2 e = vec2(1.0, -1.0) * 7e-4;
  return normalize(e.xyy * sdf(p + e.xyy) + e.yyx * sdf(p + e.yyx) +
                   e.yxy * sdf(p + e.yxy) + e.xxx * sdf(p + e.xxx));
}

// the bounding sphere along a ray: entry and exit, or a miss
vec2 bound(vec3 ro, vec3 rd) {
  vec3 oc = ro - C;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - uBound * uBound;
  float h = b * b - c;
  if (h < 0.0) return vec2(1.0, -1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

bool hitShape(vec3 ro, vec3 rd, out float t) {
  vec2 b = bound(ro, rd);
  t = max(b.x, 0.0);
  if (b.y < 0.0) return false;
  for (int i = 0; i < 64; i++) {
    float d = sdf(ro + rd * t);
    if (d < 2e-4) return true;
    t += d * 0.8;
    if (t > b.y) return false;
  }
  return false;
}

// from just inside the skin to where the ray leaves
vec3 exitShape(vec3 p, vec3 d) {
  float t = 0.0;
  for (int i = 0; i < 40; i++) {
    float s = -sdf(p + d * t);
    if (s < 2e-4) break;
    t += max(s * 0.8, 1e-3);
  }
  return p + d * t;
}

float fresnel(float c, float f0) {
  return f0 + (1.0 - f0) * pow(1.0 - clamp(c, 0.0, 1.0), 5.0);
}

// WINDOW
// sun through a tall window in the left wall: three panes across, a transom, soft edges
// that widen with the distance the light travels from the glass
float window(vec3 p) {
  float t = (XW - p.x) / uSun.x;
  vec3 w = p + uSun * t;
  vec2 q = vec2(w.z - uWin.x, w.y - uWin.y);
  float s = 0.004 + 0.006 * t;
  float open = smoothstep(-s, s, WIN.x - abs(q.x)) * smoothstep(-s, s, WIN.y - abs(q.y));
  float bars = smoothstep(-s, s, 0.035 - abs(abs(q.x) - WIN.z));
  bars = max(bars, smoothstep(-s, s, 0.035 - abs(q.y - WIN.w)));
  return open * (1.0 - bars);
}

// PLINTH
// a ray against the box: entry distance and the face it crosses, or -1
float boxRay(vec3 ro, vec3 rd, out vec3 n) {
  vec3 m = 1.0 / rd;
  vec3 o = ro - PLINTH_C;
  vec3 k = abs(m) * PLINTH_B;
  vec3 t1 = -m * o - k;
  vec3 t2 = -m * o + k;
  float tn = max(max(t1.x, t1.y), t1.z);
  float tf = min(min(t2.x, t2.y), t2.z);
  n = vec3(0.0);
  if (tn > tf || tf < 0.0) return -1.0;
  n = -sign(rd) * step(t1.yzx, t1.xyz) * step(t1.zxy, t1.xyz);
  return tn;
}
`;

// TRACE
// one pixel per sun ray. the grid covers the shape's bounding disc as seen from the sun;
// each ray refracts in, crosses the liquid, refracts out (once more after a total internal
// reflection), then lands on the back wall, and on the floor or the plinth top. one target
// per colour channel, each with its own index, so the lines fringe. a fourth packs the
// light that got through and which receivers the ray reached
export const QUAD_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export const TRACE_FS = `#version 300 es
precision highp float;
precision highp int;
${COMMON}
uniform vec3 uIor;
uniform vec3 uAbsorb;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;

// where a ray leaving the liquid lands: wall x y, floor or plinth-top x z
vec4 land(vec3 e, vec3 d, out float wallOk, out float flatOk, out float top) {
  vec3 bn;
  float tb = boxRay(e, d, bn);
  float tw = d.z < -1e-4 ? -e.z / d.z : -1.0;
  float tf = d.y < -1e-4 ? -e.y / d.y : -1.0;
  vec3 pw = e + d * max(tw, 0.0);
  vec3 pf = e + d * max(tf, 0.0);
  wallOk = tw > 0.0 ? 1.0 : 0.0;
  flatOk = tf > 0.0 ? 1.0 : 0.0;
  top = 0.0;
  vec2 hz = pf.xz;
  bool inside = all(lessThan(abs(e - PLINTH_C), PLINTH_B + 0.01));
  if (inside || tb > 0.0) {
    vec3 pb = e + d * max(tb, 0.0);
    if (pb.y > PLINTH_H - 0.02) {
      top = 1.0;
      flatOk = 1.0;
      hz = pb.xz;
    } else flatOk = 0.0;
    wallOk = 0.0;
  }
  return vec4(pw.xy, hz);
}

void main() {
  vec2 g = floor(gl_FragCoord.xy) / ${f(RAYS_N - 1)} * 2.0 - 1.0;
  vec3 u = normalize(cross(uSun, vec3(0.0, 1.0, 0.0)));
  vec3 v = cross(u, uSun);
  vec3 d = -uSun;
  vec3 o = C + uSun * 2.0 + (u * g.x + v * g.y) * uBound;
  float win = window(o);
  float t;
  o0 = o1 = o2 = o3 = vec4(0.0);
  if (win < 1e-3 || !hitShape(o, d, t)) return;
  vec3 p1 = o + d * t;
  vec3 n1 = normal(p1);
  float ci = dot(-d, n1);
  vec4 l[3];
  float pk[3];
  for (int ch = 0; ch < 3; ch++) {
    float ior = uIor[ch];
    float f0 = (ior - 1.0) / (ior + 1.0);
    f0 *= f0;
    vec3 d1 = refract(d, n1, 1.0 / ior);
    vec3 p2 = exitShape(p1 - n1 * 2e-3, d1);
    vec3 n2 = normal(p2);
    float len = length(p2 - p1);
    vec3 d2 = refract(d1, -n2, ior);
    float keep = (1.0 - fresnel(ci, f0)) * (1.0 - fresnel(dot(d2, n2), f0));
    if (dot(d2, d2) < 0.5) {
      vec3 db = reflect(d1, -n2);
      vec3 p3 = exitShape(p2 - n2 * 2e-3, db);
      vec3 n3 = normal(p3);
      len += length(p3 - p2);
      d2 = refract(db, -n3, ior);
      p2 = p3;
      keep = dot(d2, d2) < 0.5 ? 0.0 : (1.0 - fresnel(ci, f0)) * 0.85;
    }
    float w = keep * exp(-uAbsorb[ch] * len) * win * smoothstep(0.0, 0.25, ci);
    float wo;
    float fo;
    float tp;
    l[ch] = land(p2, d2, wo, fo, tp);
    pk[ch] = min(w, 0.999) + 2.0 * wo + 4.0 * fo + 8.0 * tp;
  }
  o0 = l[0];
  o1 = l[1];
  o2 = l[2];
  o3 = vec4(pk[0], pk[1], pk[2], 1.0);
}`;

// CAUSTIC
// one vertex per ray, read from the trace by gl_VertexID, placed on a receiver map. each
// triangle carries the light that fell on its cell of the grid, so where landed triangles
// shrink the light gathers into lines. triangles with a corner that missed, was blocked,
// or landed on the other level of floor and plinth top are dropped, and kept from costing fill
export const CAUSTIC_VS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uPos;
uniform highp sampler2D uPack;
uniform int  uChan;
uniform int  uRecv;   // 0 back wall, 1 floor and plinth top
uniform vec4 uRect;   // the receiver map: min, size, metres
uniform float uCell;  // grid spacing, metres
out vec2 vOld;
out vec2 vNew;
out float vW;
out float vOk;
out float vTop;
void main() {
  ivec2 c = ivec2(gl_VertexID % ${RAYS_N}, gl_VertexID / ${RAYS_N});
  vec4 p = texelFetch(uPos, c, 0);
  float k = texelFetch(uPack, c, 0)[uChan];
  float top = step(8.0, k);
  k -= top * 8.0;
  float flatOk = step(4.0, k);
  k -= flatOk * 4.0;
  float wallOk = step(2.0, k);
  k -= wallOk * 2.0;
  vec2 at = uRecv == 0 ? p.xy : p.zw;
  vOk = uRecv == 0 ? wallOk : flatOk;
  vTop = top;
  vW = k;
  vOld = vec2(c) * uCell;
  vNew = at;
  // a ray that missed, was blocked or lands far off the map is pushed past the far plane:
  // triangles made only of those are clipped away whole, mixed ones shrink to a sliver
  vec2 uv = (at - uRect.xy) / uRect.zw;
  bool off = vOk < 0.5 || any(lessThan(uv, vec2(-0.25))) || any(greaterThan(uv, vec2(1.25)));
  gl_Position = vec4(uv * 2.0 - 1.0, off ? 1e3 : 0.0, 1.0);
}`;

export const CAUSTIC_FS = `#version 300 es
precision highp float;
uniform float uGain;
in vec2 vOld;
in vec2 vNew;
in float vW;
in float vOk;
in float vTop;
out vec4 outColor;
void main() {
  if (vOk < 0.999 || fwidth(vTop) > 1e-3) discard;
  vec2 a = dFdx(vOld);
  vec2 b = dFdy(vOld);
  vec2 c = dFdx(vNew);
  vec2 d = dFdy(vNew);
  float before = abs(a.x * b.y - a.y * b.x);
  float after = abs(c.x * d.y - c.y * d.x);
  float k = min(before / max(after, 1e-14), 160.0);
  outColor = vec4(vec3(k * vW * uGain), 1.0);
}`;

// ROOM
// the whole picture in one pass: a camera ray into the gallery, the sculpture traced
// through with refraction, reflection and absorption, every surface lit by sky, warm
// bounce, the sun through the window, the sculpture's shadow and its caustic
export const ROOM_FS = `#version 300 es
precision highp float;
precision highp int;
${COMMON}
uniform vec3 uIor;
uniform vec3 uAbsorb;
uniform vec3 uEye;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uFwd;
uniform float uFocal;
uniform vec2 uRes;
uniform sampler2D uWall;
uniform sampler2D uFloor;
uniform vec4 uWallRect;
uniform vec4 uFloorRect;
uniform float uGain;
out vec4 outColor;

const vec3 PLASTER = vec3(0.93, 0.915, 0.89);
const float GAP_M = 0.022; // the shadow gap at the foot of both walls
const float GAP_DARK = 0.6;
const vec3 CONCRETE = vec3(0.86, 0.82, 0.76);
const vec3 STONE = vec3(0.93, 0.925, 0.91);
const vec3 SUN = vec3(1.0, 0.77, 0.52) * 3.0; // change for a stronger sun
const vec3 SKY = vec3(0.60, 0.63, 0.70) * 0.52;
const vec3 BOUNCE = vec3(0.80, 0.66, 0.52) * 0.42;
const vec3 GLASS = vec3(1.0, 0.95, 0.88) * 12.0; // the window seen in reflections
const float EXPOSURE = 1.15;
const float GLOSS = 0.55; // how much the floor mirrors, change for a matte floor

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 u = fract(p);
  u = u * u * (3.0 - 2.0 * u);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + 1.0), u.x), u.y);
}

// ids: 0 back wall, 1 floor, 2 plinth, 3 window wall, 4 ceiling, 5 the open room behind
float room(vec3 ro, vec3 rd, out vec3 n, out int id) {
  float t = 1e4;
  id = 5;
  n = -rd;
  if (rd.z < 0.0) { float s = -ro.z / rd.z; if (s > 1e-4 && s < t) { t = s; id = 0; n = vec3(0.0, 0.0, 1.0); } }
  if (rd.y < 0.0) { float s = -ro.y / rd.y; if (s > 1e-4 && s < t) { t = s; id = 1; n = vec3(0.0, 1.0, 0.0); } }
  if (rd.y > 0.0) { float s = (CEIL - ro.y) / rd.y; if (s > 1e-4 && s < t) { t = s; id = 4; n = vec3(0.0, -1.0, 0.0); } }
  if (rd.x < 0.0) { float s = (XW - ro.x) / rd.x; if (s > 1e-4 && s < t) { t = s; id = 3; n = vec3(1.0, 0.0, 0.0); } }
  vec3 bn;
  float s = boxRay(ro, rd, bn);
  if (s > 1e-4 && s < t) { t = s; id = 2; n = bn; }
  return t;
}

// SHADOWS
// the plinth, hard; the sculpture, soft from how close a ray toward the sun passes it
float sunVis(vec3 p) {
  float v = window(p);
  if (v < 1e-3) return 0.0;
  vec3 bn;
  if (boxRay(p, uSun, bn) > 0.0) return 0.0;
  vec2 b = bound(p, uSun);
  if (b.y > 0.0) {
    float t = max(b.x, 0.0);
    for (int i = 0; i < 28; i++) {
      float h = sdf(p + uSun * t);
      v = min(v, 80.0 * h / max(t, 0.05));
      t += clamp(h, 0.006, 0.12);
      if (v < 1e-3 || t > b.y) break;
    }
  }
  return clamp(v, 0.0, 1.0);
}

// CAUSTIC
// the sharp map, plus two blurred levels for the glow round the hot lines
vec3 caustic(sampler2D tex, vec4 rect, vec2 at, float lod) {
  vec2 uv = (at - rect.xy) / rect.zw;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec3(0.0);
  vec3 c = textureLod(tex, uv, lod).rgb;
  c += textureLod(tex, uv, lod + 2.5).rgb * 0.16;
  c += textureLod(tex, uv, lod + 4.5).rgb * 0.14;
  vec2 e = min(uv, 1.0 - uv);
  return c / uGain * smoothstep(0.0, 0.04, min(e.x, e.y));
}

vec3 shade(vec3 p, vec3 n, int id, float lod, bool seen) {
  if (id == 5) return vec3(0.55, 0.52, 0.5);
  vec3 alb = PLASTER;
  float ao = 1.0;
  if (id == 0) {
    alb *= 0.975 + 0.035 * noise(p.xy * 9.0) + 0.02 * noise(p.xy * 1.3);
    ao *= 1.0 - 0.32 * exp(-p.y / 0.22);
    ao *= 1.0 - 0.3 * exp(-(p.x - XW) / 0.3);
    // a shadow gap where the wall meets the floor
    alb *= 1.0 - GAP_DARK * smoothstep(GAP_M, GAP_M * 0.6, p.y);
  } else if (id == 1) {
    float m = noise(p.xz * 1.7) * 0.6 + noise(p.xz * 7.0) * 0.3 + noise(p.xz * 40.0) * 0.1;
    alb = CONCRETE * (0.9 + 0.16 * m);
    // saw-cut joints in the concrete
    vec2 j = abs(fract(p.xz / vec2(1.6, 1.6) + 0.5) - 0.5) * 1.6;
    alb *= 1.0 - 0.18 * smoothstep(0.006, 0.0, min(j.x, j.y));
    ao *= 1.0 - 0.32 * exp(-p.z / 0.24);
    ao *= 1.0 - 0.3 * exp(-(p.x - XW) / 0.3);
    vec2 pq = abs(p.xz - PLINTH_C.xz) - PLINTH_B.xz;
    float pd = length(max(pq, 0.0));
    ao *= 1.0 - 0.55 * exp(-pd / 0.07);
  } else if (id == 2) {
    alb = STONE;
    ao *= 1.0 - 0.3 * exp(-p.y / 0.08);
    if (n.y > 0.5) ao *= 1.0 - 0.5 * exp(-max(length(p.xz - C.xz) - 0.18, 0.0) / 0.06);
  } else if (id == 3) {
    vec2 q = vec2(p.z - uWin.x, p.y - uWin.y);
    float glass = step(abs(q.x), WIN.x) * step(abs(q.y), WIN.y);
    glass *= step(0.035, abs(abs(q.x) - WIN.z)) * step(0.035, abs(q.y - WIN.w));
    if (glass > 0.5 && !seen) return GLASS;
    alb *= 1.0 - GAP_DARK * smoothstep(GAP_M, GAP_M * 0.6, p.y);
    ao *= 1.0 - 0.3 * exp(-p.z / 0.3);
  }
  // sky from the window side and above, warm light thrown up off the sunlit floor
  vec3 amb = mix(BOUNCE, SKY, n.y * 0.35 + 0.5);
  amb *= 0.8 + 0.55 * exp(-(p.x - XW) / 2.0) + 0.25 * max(-dot(n, vec3(1.0, 0.0, 0.0)), 0.0);
  float cs = max(dot(n, uSun), 0.0);
  float vis = cs > 0.0 ? sunVis(p + n * 1e-3) : 0.0;
  vec3 c = vec3(0.0);
  if (id == 0) c = caustic(uWall, uWallRect, p.xy, lod);
  else if (id == 1 || (id == 2 && n.y > 0.5)) c = caustic(uFloor, uFloorRect, p.xz, lod);
  return alb * (amb * ao + SUN * (vis * cs + c));
}

vec3 look(vec3 ro, vec3 rd, float lod) {
  vec3 n;
  int id;
  float t = room(ro, rd, n, id);
  return shade(ro + rd * t, n, id, lod, false);
}

// SCULPTURE
// a reflection of the room, the room bent through the liquid and tinted by how far the
// light travelled in it, the sun's highlight, and the light the shape gathers glowing on
// its far side
vec3 sculpture(vec3 p, vec3 rd) {
  vec3 n = normal(p);
  float ior = uIor.g;
  float f0 = (ior - 1.0) / (ior + 1.0);
  f0 *= f0;
  float fr = fresnel(dot(-rd, n), f0);
  vec3 r = reflect(rd, n);
  vec3 refl = look(p + n * 2e-3, r, 1.0);
  float lit = window(p);
  refl += SUN * lit * (pow(max(dot(r, uSun), 0.0), 900.0) * 140.0 + pow(max(dot(r, uSun), 0.0), 70.0) * 2.0);

  vec3 d1 = refract(rd, n, 1.0 / ior);
  vec3 p2 = exitShape(p - n * 2e-3, d1);
  vec3 n2 = normal(p2);
  float len = length(p2 - p);
  vec3 thru;
  for (int ch = 0; ch < 3; ch++) {
    vec3 d2 = refract(d1, -n2, uIor[ch]);
    if (dot(d2, d2) < 0.5) d2 = reflect(d1, -n2);
    thru[ch] = look(p2 + d2 * 2e-3, d2, 0.0)[ch];
  }
  vec3 tint = exp(-uAbsorb * len);
  // gathered sun: a bright crescent where the light focuses on the shape's shaded side
  float gather = pow(max(dot(n2, -uSun), 0.0), 4.0) * 1.2 + pow(max(dot(n2, -uSun), 0.0), 24.0) * 4.0;
  vec3 glow = SUN * lit * gather * sqrt(tint);
  vec3 col = (thru * tint + glow) * (1.0 - fr) + refl * fr;
  return col;
}

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec2 ndc = gl_FragCoord.xy / uRes * 2.0 - 1.0;
  ndc.x *= uRes.x / uRes.y;
  vec3 rd = normalize(uFwd * uFocal + uRight * ndc.x + uUp * ndc.y);
  vec3 ro = uEye;
  vec3 n;
  int id;
  float t = room(ro, rd, n, id);
  float ts;
  vec3 col;
  if (hitShape(ro, rd, ts) && ts < t) col = sculpture(ro + rd * ts, rd);
  else {
    vec3 p = ro + rd * t;
    col = shade(p, n, id, 0.0, true);
    // FLOOR
    // polished concrete: a soft mirror of the wall, the plinth and the sculpture
    if (id == 1) {
      vec3 r = reflect(rd, n);
      vec3 q = p + n * 1e-3;
      vec3 rn;
      int rid;
      float rt = room(q, r, rn, rid);
      float rs;
      vec3 rc;
      if (hitShape(q, r, rs) && rs < rt) {
        vec3 ps = q + r * rs;
        rc = look(ps, r, 2.0) * exp(-uAbsorb * 0.5) * 0.85;
      } else rc = shade(q + r * rt, rn, rid, 2.0, false);
      float fr = fresnel(dot(-rd, n), 0.03);
      col = mix(col, rc, fr * GLOSS);
    }
  }
  col = aces(col * EXPOSURE);
  col = pow(col, vec3(1.0 / 2.2));
  // a faint vignette and dither against banding
  vec2 uv = gl_FragCoord.xy / uRes - 0.5;
  col *= 1.0 - 0.18 * dot(uv, uv);
  col += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  outColor = vec4(col, 1.0);
}`;
