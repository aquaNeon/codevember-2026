const NOISE = `
uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
const float INV_U = 1.0 / 4294967295.0;
float h31(ivec3 i) {
  uvec3 u = uvec3(i + 4096);
  return float(pcg(u.x + pcg(u.y + pcg(u.z)))) * INV_U;
}
vec3 h23(ivec2 i) {
  uvec2 u = uvec2(i + 4096);
  uint a = pcg(u.x + pcg(u.y));
  uint b = pcg(a);
  return vec3(float(a), float(b), float(pcg(b))) * INV_U;
}
float h21(ivec2 i) {
  uvec2 u = uvec2(i + 4096);
  return float(pcg(u.x + pcg(u.y))) * INV_U;
}
// value noise; the corners are a loop (uTap.w is 1) so each call site stays one hash long
float vnoise2(vec2 p) {
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float s = 0.0;
  for (int k = 0; k < 4 * uTap.w; k++) {
    ivec2 o = ivec2(k & 1, k >> 1);
    vec2 w = mix(1.0 - f, f, vec2(o));
    s += h21(i + o) * w.x * w.y;
  }
  return s;
}
float vnoise3(vec3 p) {
  ivec3 i = ivec3(floor(p));
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float s = 0.0;
  for (int k = 0; k < 8 * uTap.w; k++) {
    ivec3 o = ivec3(k & 1, (k >> 1) & 1, k >> 2);
    vec3 w = mix(1.0 - f, f, vec3(o));
    s += h31(i + o) * w.x * w.y * w.z;
  }
  return s;
}
float fbm3(vec3 p, int octaves) {
  float s = 0.0;
  float a = 0.5;
  float n = 0.0;
  for (int i = 0; i < octaves; i++) {
    s += a * vnoise3(p);
    n += a;
    p = p * 2.07 + vec3(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s / n;
}
// f1, f2 and the nearest cell's hash
vec3 worley(vec2 p) {
  int r = uTap.w;
  ivec2 ip = ivec2(floor(p));
  vec2 fp = fract(p);
  float f1 = 9.0;
  float f2 = 9.0;
  float id = 0.0;
  for (int y = -r; y <= r; y++)
    for (int x = -r; x <= r; x++) {
      ivec2 g = ivec2(x, y);
      vec3 h = h23(ip + g);
      vec2 o = vec2(g) + 0.15 + 0.7 * h.xy - fp;
      float d = dot(o, o);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        id = h.z;
      } else if (d < f2) f2 = d;
    }
  return vec3(sqrt(f1), sqrt(f2), id);
}
`;

// SCENE
// one raymarched specimen: a bolted steel cube on a turned stone pedestal. only the cube turns;
// the pedestal, the lights and the room stay put. rust is a function of the cube's own frame
// and one age, so it sticks to the steel as it turns; runs go down the cube's y, which is world
// down. loop counts come in as uniforms so the compiler keeps each loop body once instead of
// unrolling it, which keeps the link short
export const SCENE_FS = `#version 300 es
precision highp float;
precision highp int;

uniform vec2  uRes;
uniform vec2  uJitter;
uniform vec2  uFrame;
uniform float uPitch;
uniform vec2  uYaw;
uniform float uAge;
uniform vec4  uKnobs;
uniform vec3  uRustA;
uniform vec3  uRustB;
uniform vec3  uBg;
uniform float uSmear;
uniform ivec4 uLoop;
uniform ivec4 uTap;

out vec4 outColor;

${NOISE}

// GEOMETRY
const vec3  C      = vec3(0.0, 1.08, 0.0);
const float HB     = 0.5;
const float RB     = 0.055;
const float BO     = 0.34;
const float BORE   = 0.082;
const float SINK   = 0.026;
const float HEX    = 0.05;
const float HEAD   = 0.062;
const vec3  TARGET = vec3(0.0, 0.8, 0.0);
const float DIST   = 5.4;
const vec3  BC     = vec3(0.0, 0.8, 0.0);
const float BR     = 1.12;

// LIGHTS
// world space, fixed to the room
const vec3 KEY = vec3(-0.62, 0.62, 0.48);
const vec3 KEY_COL = vec3(3.1, 2.95, 2.75);
const vec3 RIM = vec3(0.78, 0.3, -0.55);
const vec3 RIM_COL = vec3(1.1, 1.25, 1.5);
const vec3 OCHRE = vec3(0.22, 0.13, 0.035); // the second oxide over red rust
const vec3 SIENNA = vec3(0.2, 0.06, 0.022); // and over ochre rust
const vec3 MAGNETITE = vec3(0.02, 0.016, 0.013); // black scale
const vec3 STONE = vec3(0.04, 0.04, 0.043); // the pedestal, a dark honed basalt
const float BRUSH_ROUGH = 0.36; // the cube's brushed steel, change for a duller or brighter finish
const float BRUSH_ANISO = 0.95; // how far the highlights stretch along the grain
const float RUST_ROUGH = 0.9; // loose oxide, matte
const float SCALE_ROUGH = 0.74; // packed scale, a dull sheen; humidity lowers it

vec3 yaw(vec3 v, vec2 cs) {
  return vec3(cs.x * v.x + cs.y * v.z, v.y, -cs.y * v.x + cs.x * v.z);
}
// world to the cube's frame and back
vec3 toCube(vec3 v) {
  return yaw(v, vec2(uYaw.x, -uYaw.y));
}
vec3 fromCube(vec3 v) {
  return yaw(v, uYaw);
}
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
float smax(float a, float b, float k) {
  return -smin(-a, -b, k);
}
float sdRoundBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}
float sdRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float sdHex(vec2 p, float r) {
  const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
  p = abs(p.yx);
  p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
  p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
  return length(p) * sign(p.y);
}

// a cube local point folded onto one face: xy in the face, z along its normal.
// one bolt stands for all four on a face; the bottom face has none
vec3 faceLocal(vec3 c, out float bottom) {
  vec3 a = abs(c);
  bottom = 0.0;
  if (a.x >= a.y && a.x >= a.z) return vec3(a.z, a.y, a.x);
  if (a.y >= a.z) {
    bottom = step(c.y, 0.0);
    return vec3(a.x, a.z, a.y);
  }
  return a;
}

// x: cube body, y: bolt head and washer. c in the cube's frame
vec2 cubeSd(vec3 c) {
  float body = sdRoundBox(c, vec3(HB), RB);
  float bottom;
  vec3 q = faceLocal(c, bottom);
  if (bottom > 0.5) return vec2(body, 9.0);
  vec2 b = q.xy - BO;
  float h = q.z - HB;
  float r = length(b);
  float bore = max(r - BORE, -(h + SINK));
  body = smax(body, -bore, 0.005);
  float top = HEAD - SINK;
  float hex = max(sdHex(b, HEX), h - top);
  hex = max(hex, (h - top) + (r - HEX * 0.98) * 0.75);
  hex = max(hex, -(h + SINK));
  float washer = max(r - HEX * 1.42, abs(h + SINK - 0.004) - 0.005);
  return vec2(body, min(hex, washer));
}

float pedSd(vec3 p) {
  vec2 q = vec2(length(p.xz), p.y);
  float d = sdRect(q - vec2(0.0, 0.04), vec2(0.62, 0.04), 0.014);
  d = min(d, sdRect(q - vec2(0.0, 0.1), vec2(0.47, 0.025), 0.01));
  d = smin(d, sdRect(q - vec2(0.0, 0.33), vec2(0.13, 0.22), 0.0), 0.06);
  d = smin(d, sdRect(q - vec2(0.0, 0.55), vec2(0.4, 0.03), 0.008), 0.035);
  return d;
}

float map(vec3 p) {
  vec2 c = cubeSd(toCube(p - C));
  return min(min(c.x, c.y), pedSd(p));
}

// tetrahedral taps in one loop body
vec3 normal(vec3 p) {
  vec3 n = vec3(0.0);
  for (int i = 0; i < uTap.x; i++) {
    vec3 e = 0.5773 * (2.0 * vec3((((i + 3) >> 1) & 1), ((i >> 1) & 1), (i & 1)) - 1.0);
    n += e * map(p + e * 0.0007);
  }
  return normalize(n);
}

float march(vec3 ro, vec3 rd, float t, float t1) {
  float d = 1.0;
  for (int i = 0; i < uLoop.x; i++) {
    d = map(ro + rd * t);
    if (abs(d) < 0.00035 * t) return t;
    t += d * 0.92;
    if (t > t1) return -1.0;
  }
  // out of steps while still hugging a surface (a grazing ray into a bolt recess): call it a
  // hit rather than let the backdrop show through as a dark speck
  return abs(d) < 0.01 ? t : -1.0;
}

float softShadow(vec3 ro, vec3 rd, float k) {
  float res = 1.0;
  float t = 0.012;
  for (int i = 0; i < uLoop.y; i++) {
    float h = map(ro + rd * t);
    res = min(res, k * h / t);
    t += clamp(h, 0.012, 0.16);
    if (res < 0.002 || t > 2.6) break;
  }
  res = clamp(res, 0.0, 1.0);
  return res * res * (3.0 - 2.0 * res);
}

// x: ambient occlusion, y: cavity, how tucked into a crevice the point is
vec2 occlusion(vec3 p, vec3 n) {
  float o = 0.0;
  float s = 1.0;
  float cav = 0.0;
  for (int i = 0; i < uLoop.z; i++) {
    float h = 0.012 + 0.035 * float(i);
    float d = map(p + n * h);
    o += (h - d) * s;
    s *= 0.72;
    if (i == 1) cav = clamp((h - d) * 18.0, 0.0, 1.0);
  }
  return vec2(clamp(1.0 - 2.4 * o, 0.0, 1.0), cav);
}

vec2 sphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float h = b * b - c;
  if (h < 0.0) return vec2(-1.0);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}

// STUDIO
// soft rectangular boxes in direction space; rougher surfaces see them softer and dimmer
float softbox(vec3 d, vec3 c, vec3 tx, vec2 size, float soft) {
  float z = dot(d, c);
  if (z <= 0.05) return 0.0;
  vec3 ty = cross(c, tx);
  vec2 l = vec2(dot(d, tx), dot(d, ty)) / z;
  vec2 e = abs(l) - size;
  float m = length(max(e, 0.0)) + min(max(e.x, e.y), 0.0);
  return 1.0 - smoothstep(-soft, soft, m);
}

vec3 env(vec3 d, float rough) {
  float s = 0.012 + rough * rough * 1.6;
  float dim = 1.0 / (1.0 + rough * rough * 5.0);
  vec3 col = mix(vec3(0.05, 0.052, 0.056), vec3(0.12, 0.125, 0.13), smoothstep(0.0, 0.8, d.y));
  // the studio floor: lit grey near the horizon, darker straight down
  vec3 floorCol = mix(vec3(0.05, 0.048, 0.046), vec3(0.2, 0.19, 0.18), smoothstep(-0.9, -0.04, d.y));
  col = mix(floorCol, col, smoothstep(-0.06, 0.02, d.y));
  vec3 key = normalize(KEY);
  col += vec3(6.0, 5.75, 5.4) * dim * softbox(d, key, normalize(cross(vec3(0, 1, 0), key)), vec2(0.62, 0.42), s);
  vec3 rim = normalize(RIM);
  col += vec3(4.2, 4.7, 5.6) * dim * softbox(d, rim, normalize(cross(vec3(0, 1, 0), rim)), vec2(0.12, 1.1), s);
  vec3 top = normalize(vec3(0.1, 0.32, -0.95));
  col += vec3(2.2) * dim * softbox(d, top, vec3(1, 0, 0), vec2(1.3, 0.16), s);
  // a bounce card low in front, a soft band across the lower half of the side faces
  vec3 card = normalize(vec3(-0.2, -0.3, 1.0));
  col += vec3(1.3, 1.27, 1.22) * dim * softbox(d, card, normalize(cross(vec3(0, 1, 0), card)), vec2(1.9, 0.3), s * 1.4 + 0.1);
  vec3 fill = normalize(vec3(0.25, 0.18, 1.0));
  col += vec3(1.3, 1.25, 1.2) * dim * softbox(d, fill, normalize(cross(vec3(0, 1, 0), fill)), vec2(1.4, 0.6), s * 1.5 + 0.12);
  return col;
}

// RUST
// everything the relief and the colour share, in the cube's frame
struct Field {
  float m;     // rust cover, crisp at its rim
  float depth; // how long it has been rusting there, 0 to 1
  float rim;   // the newest edge of a patch
  float halo;  // the thin brown film just ahead of a front
  float crust; // thick scale
  float crack; // 0 in the cracks between plates
  float chip;  // a plate that has flaked off
  float bare;  // flaked deep, dark under the scale
  float pit;
  float id;    // plate hash
  float g;     // fine grain
  float h;     // relief
};

vec2 faceUv(vec3 c, vec3 n) {
  vec3 a = abs(n);
  return a.x > a.y && a.x > a.z ? c.zy + sign(n.x) * 7.0 : (a.y > a.z ? c.xz + sign(n.y) * 13.0 : c.xy + sign(n.z) * 19.0);
}

Field field(vec3 c, vec3 n, float cav, float bolt) {
  Field f;
  float age = uAge;
  float hum = uKnobs.x;
  float salt = uKnobs.y;
  float flake = uKnobs.w;
  vec3 a = abs(c);
  float mid = a.x + a.y + a.z - max(a.x, max(a.y, a.z)) - min(a.x, min(a.y, a.z));
  // EXPOSURE
  // rust starts where water sits: edges, bolts, crevices, the foot of the sides, the top
  float edge = smoothstep(HB - 0.09, HB - 0.008, mid);
  float low = smoothstep(0.1, -HB, c.y) * (1.0 - abs(n.y));
  float expo = 0.5 * edge + 0.6 * cav + 0.45 * bolt + 0.22 * low + 0.12 * max(n.y, 0.0);

  // COVER
  // broad warped patches stretched down the sides, ragged at the rim, with a crisp front
  vec3 q = c * vec3(3.0, 1.6, 3.0) + 2.0;
  q.xz += 0.9 * vec2(vnoise3(q * 0.9 + 3.1), vnoise3(q * 0.9 + 7.7)) - 0.45;
  // stretched so the cover grows steadily over the years instead of all at once
  float nz = clamp((fbm3(q, uLoop.w) - 0.5) * 2.1 + 0.5, 0.0, 1.0);
  float seed = nz + 0.55 * expo;
  float p = age * mix(0.78, 1.4, hum);
  float s = seed - (1.58 - 1.85 * p);
  f.m = smoothstep(0.0, 0.02, s) * step(0.05, age);
  f.depth = clamp(s / 0.5, 0.0, 1.0);
  f.rim = f.m * (1.0 - smoothstep(0.015, 0.06, s));
  f.halo = smoothstep(-0.14, 0.0, s) * step(0.04, age);

  // FLASH SPOTS
  // early on, scattered orange specks that grow and run together
  vec2 uv = faceUv(c, n);
  vec3 sp = worley(uv * 24.0);
  f.g = vnoise3(c * 150.0);
  float clump = smoothstep(0.35, 0.85, nz + 0.3 * expo);
  float dens = (0.02 + 0.5 * expo + 0.5 * clump) * (0.6 + 0.6 * salt) * smoothstep(0.04, 0.25, age);
  float sr = (0.12 + 0.34 * smoothstep(0.06, 0.45, age)) * (0.35 + 1.3 * fract(sp.z * 31.0));
  float spot = step(sp.z, dens) * smoothstep(sr, sr * 0.7, sp.x + (f.g - 0.5) * 0.12);
  f.halo = max(f.halo, step(sp.z, dens) * smoothstep(sr * 2.6, sr, sp.x) * 0.7);
  f.m = max(f.m, spot);

  // SCALE
  // plates split by uneven cracks; some curl up at the rim, some have flaked away
  f.crust = smoothstep(0.12, 0.5, f.depth) * smoothstep(0.3, 0.68, age);
  vec2 fu = uv * 13.0 + 3.0;
  fu += (vec2(vnoise2(fu * 0.9), vnoise2(fu * 0.9 + 7.0)) - 0.5) * 1.0;
  vec3 pl = worley(fu);
  float gap = pl.y - pl.x;
  // only the oldest, thickest scale cracks into plates
  float laminar = smoothstep(0.3, 0.7, f.depth) * smoothstep(0.55, 0.75, nz + 0.35 * edge + 0.25 * flake);
  f.crack = mix(1.0, smoothstep(0.01, 0.05 + 0.04 * flake, gap), laminar);
  f.id = pl.z;
  float curl = laminar * step(fract(pl.z * 5.3), 0.2 + 0.6 * flake) * smoothstep(0.32, 0.04, gap);
  f.chip = f.crust * step(0.5, laminar) * step(fract(pl.z * 11.7), (0.06 + 0.3 * flake) * smoothstep(0.5, 0.95, age));
  f.bare = f.chip * step(0.6, fract(pl.z * 3.9)) * (1.0 - edge);

  // PITS
  // salt pits in clusters, never smaller than a few pixels
  vec3 pt = worley(uv * 32.0 + 9.0);
  float cluster = smoothstep(0.3, 0.75, vnoise3(c * 5.0 + 17.0));
  float pr = (0.14 + 0.16 * salt) * (0.7 + 0.6 * fract(pt.z * 37.0));
  f.pit = step(pt.z, (0.03 + salt * 0.45) * cluster) * smoothstep(pr, pr * 0.3, pt.x);
  f.pit *= max(f.m * smoothstep(0.1, 0.4, f.depth + 0.2 * salt), f.chip);

  // blisters: low lumps in the oxide, larger than the grain
  float blister = smoothstep(0.35, 0.85, vnoise3(c * 38.0 + 21.0));
  float plate = f.crust * (0.55 + 0.25 * fract(pl.z * 17.0) + 0.7 * curl * (0.4 + flake)) * f.crack;
  f.h = 0.3 * f.m * smoothstep(0.0, 0.35, f.depth) + plate * (1.0 - f.chip) + f.m * ((f.g - 0.5) * (0.12 + 0.12 * (1.0 - f.crust)) + 0.22 * blister);
  f.h -= f.pit * 0.7 + f.bare * 0.25;
  return f;
}

// runs: water gathers under each bolt head and along the top rim and runs down the sides
float runs(vec3 c, float len) {
  vec3 a = abs(c);
  if (a.y > max(a.x, a.z) - 0.02) return 0.0;
  bool xf = a.x > a.z;
  float u = xf ? c.z : c.x;
  float face = xf ? sign(c.x) : 2.0 + sign(c.z);
  float y = c.y;
  float bu = sign(u) * BO;
  float rivulet = vnoise2(vec2(u * 70.0 + face * 13.0, y * 2.5));
  float s = 0.0;
  for (int i = 0; i < 2; i++) {
    float by = i == 0 ? BO : -BO;
    float dy = by - 0.05 - y;
    float cell = h21(ivec2(int(face * 4.0 + sign(u) * 2.0), i));
    float l = len * (0.55 + 0.8 * cell);
    float wig = (vnoise2(vec2(y * 7.0, face * 5.0 + by * 9.0)) - 0.5) * 0.04;
    float w = 0.012 + 0.04 * clamp(dy, 0.0, 1.0);
    float lat = (u - bu + wig) / w;
    float k = exp(-lat * lat) * exp(-max(dy, 0.0) / max(l, 1e-3));
    s += k * smoothstep(-0.02, 0.03, dy) * step(0.0, len);
  }
  // tea stains: thin streaks off the top rim
  float dyTop = HB - y;
  float tear = vnoise2(vec2(u * 9.0 + face * 7.3, 0.5)) * 0.6 + rivulet * 0.4;
  tear = smoothstep(0.5, 0.85, tear);
  s += tear * exp(-dyTop / max(len * 0.7, 1e-3)) * 0.8;
  return clamp(s * (0.45 + 0.75 * rivulet), 0.0, 1.0);
}

vec3 tonemap(vec3 c) {
  // khronos pbr neutral
  const float start = 0.8 - 0.04;
  const float desat = 0.15;
  float x = min(c.r, min(c.g, c.b));
  float off = x < 0.08 ? x - 6.25 * x * x : 0.04;
  c -= off;
  float peak = max(c.r, max(c.g, c.b));
  if (peak < start) return c;
  float d = 1.0 - start;
  float np = 1.0 - d * d / (peak + d - start);
  c *= np / peak;
  float g = 1.0 - 1.0 / (desat * (peak - np) + 1.0);
  return mix(c, vec3(np), g);
}

vec3 shade(vec3 p, vec3 rd, vec3 n, float sh) {
  vec2 cb = cubeSd(toCube(p - C));
  float ped = pedSd(p);
  float id = ped < min(cb.x, cb.y) ? 2.0 : (cb.y < cb.x ? 1.0 : 0.0);
  vec2 oc = occlusion(p, n);
  float ao = oc.x;

  vec3 albedo = vec3(0.0);
  float metal = 1.0;
  float rough = 0.6;
  float aniso = 0.0;
  vec3 F0 = vec3(0.04);
  vec3 tng = vec3(1.0, 0.0, 0.0);

  if (id < 1.5) {
    vec3 c = toCube(p - C);
    vec3 nl = toCube(n);

    // BRUSHING
    // the cube faces are brushed straight, the grain in the cube's frame
    vec3 an = abs(nl);
    vec3 tl = an.y > max(an.x, an.z) ? vec3(1.0, 0.0, 0.0) : normalize(cross(vec3(0.0, 1.0, 0.0), nl));
    float across = dot(c, normalize(cross(nl, tl)));
    tng = fromCube(tl);
    float lines = vnoise2(vec2(across * 520.0, dot(c, tl) * 3.0)) * 0.6 + vnoise2(vec2(across * 140.0, dot(c, tl) * 9.0)) * 0.4;
    F0 = id > 0.5 ? vec3(0.42, 0.42, 0.43) : vec3(0.64, 0.64, 0.65);
    rough = id > 0.5 ? 0.3 : BRUSH_ROUGH;
    aniso = id > 0.5 ? 0.0 : BRUSH_ANISO;
    float grain = id < 0.5 ? 1.0 : 0.3;
    F0 *= 1.0 + (lines - 0.5) * 0.3 * grain;
    rough += (lines - 0.5) * 0.16 * grain;

    // RELIEF
    // the field at the point and two taps along the surface, in one loop body
    float bolt = id;
    vec3 t1 = normalize(cross(nl, abs(nl.y) > 0.9 ? vec3(1, 0, 0) : vec3(0, 1, 0)));
    vec3 t2 = cross(nl, t1);
    const float E = 0.002;
    Field f = Field(0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.5, 0.0);
    float hx = 0.0;
    float hy = 0.0;
    for (int k = 0; k < uTap.y; k++) {
      vec3 o = k == 1 ? t1 * E : (k == 2 ? t2 * E : vec3(0.0));
      Field fk = field(c + o, nl, oc.y, bolt);
      if (k == 0) f = fk;
      else if (k == 1) hx = fk.h;
      else hy = fk.h;
    }
    float amp = (0.006 + 0.01 * uKnobs.w) * smoothstep(0.0, 0.1, f.m + f.pit);
    nl = normalize(nl - (t1 * (hx - f.h) + t2 * (hy - f.h)) * (amp / E));
    n = fromCube(nl);
    // a steep bump can tip the normal away from the eye, which shades as a black speck
    float nv = dot(n, -rd);
    if (nv < 0.05) n = normalize(n - rd * (0.05 - nv));

    float age = uAge;
    float hum = uKnobs.x;
    float g = f.g;
    float z = vnoise3(c * 2.2 + 5.0);
    float z2 = vnoise3(c * 7.0 + 1.0);
    float z3 = vnoise3(c * vec3(26.0, 14.0, 26.0) + 3.0);

    // TARNISH
    // bare steel dulls and warms before it rusts, with faint tide marks where water dried
    float tarn = smoothstep(0.0, 0.3, age) * (0.6 + 0.4 * z);
    float blot = vnoise3(c * vec3(4.0, 2.5, 4.0) + 40.0);
    float tide = smoothstep(0.52, 0.6, blot) * (0.5 + 0.5 * smoothstep(0.62, 0.56, blot));
    tarn += tide * 0.25 * smoothstep(0.02, 0.12, age);
    F0 *= mix(vec3(1.0), vec3(0.6, 0.53, 0.46), min(tarn, 1.2) * 0.8);
    rough += tarn * 0.2;
    aniso *= 1.0 - 0.6 * min(tarn, 1.0);

    // RUST COLOUR
    // orange where it is new, through sienna to umber where it is old, in broad zones
    vec3 fresh = uRustA;
    vec3 old = uRustB;
    vec3 umber = old * 0.4;
    float d = f.depth + (z - 0.5) * 0.6 + (g - 0.5) * 0.12 + 0.25 * smoothstep(0.5, 1.0, age);
    vec3 rc = mix(fresh, old, smoothstep(-0.15, 0.4, d));
    rc = mix(rc, umber, smoothstep(0.35, 0.9, d) * 0.8);
    // mottling: crisp blotches of darker and brighter oxide at two sizes
    rc *= 0.7 + 0.45 * smoothstep(0.3, 0.7, z2) + 0.25 * smoothstep(0.45, 0.6, z3);
    rc *= 0.82 + 0.36 * g;
    // granules of brighter oxide caught in the brown
    float gran = smoothstep(0.56, 0.74, g) * smoothstep(0.3, 0.55, z3);
    // the newest edge of a patch: a dark tide line
    rc = mix(rc, umber * 0.6, f.rim * 0.55 * step(0.12, age));

    // SCALE
    // packed, near black where damp, cracked dark, rims catching light from the relief
    float damp = smoothstep(0.5, 0.6, z2 + 0.3 * hum - 0.15 + 0.3 * z3 + 0.1 * g);
    vec3 scale = mix(mix(umber, old * 0.75, smoothstep(0.4, 0.7, z3)), MAGNETITE * 1.6, damp) * (0.7 + 0.6 * g);
    float plateOn = f.crust * (1.0 - f.chip);
    rc = mix(rc, scale, plateOn * smoothstep(0.2, 0.7, fract(f.id * 23.0) * 0.5 + 0.5 * z));
    rc *= mix(1.0, 0.18, f.crust * (1.0 - f.crack));
    // under a fallen flake: bright powdery orange, or where it went deep, dark umber; never
    // shiny steel again, rust does not turn back into metal
    rc = mix(rc, mix(fresh, old, 0.35) * (0.8 + 0.4 * g), f.chip * (1.0 - f.bare));
    rc = mix(rc, old * (0.3 + 0.25 * g), f.bare);
    rc = mix(rc, mix(fresh, old, 0.4) * 1.1, gran * 0.55 * f.crust);
    rc = mix(rc, MAGNETITE, f.pit * 0.9);

    // SECOND OXIDE
    // a powdery bloom of the other oxide in tall patches where water ran and dried; matte
    float run = vnoise3(c * vec3(2.6, 0.9, 2.6) + 11.0) * 0.7 + vnoise3(c * vec3(9.0, 3.0, 9.0)) * 0.3;
    float bloom = smoothstep(0.58, 0.76, run) * smoothstep(0.22, 0.6, age) * f.m * (1.0 - plateOn * 0.7);
    bloom *= 0.55 + 0.45 * g;
    vec3 other = uRustA.r - uRustA.g > 0.2 ? OCHRE : SIENNA;
    rc = mix(rc, other * (0.75 + 0.5 * z2), bloom * 0.75);
    // BLACK SCALE
    // late, in other patches: thick dark magnetite, a little glossy
    float black = smoothstep(0.6, 0.66, vnoise3(c * 3.7 + 29.0) + 0.25 * (z3 - 0.5) + 0.1 * g) * smoothstep(0.5, 0.9, age) * plateOn;
    rc = mix(rc, MAGNETITE * (0.7 + 0.6 * g), black * 0.9);

    // STAINS
    // a thin brown film on the steel: ahead of each front and in runs below bolts and the rim
    float len = age * mix(0.18, 0.75, hum);
    float st = max(runs(c, len) * smoothstep(0.0, 0.1, age) * (0.6 + 0.4 * g), f.halo * 0.55);
    st *= 1.0 - f.m;
    vec3 stainCol = mix(old * 1.4, fresh * 0.8, 0.35 + 0.3 * z2);

    // the film browns the steel's own reflection rather than painting over it
    F0 = mix(F0, vec3(0.24, 0.15, 0.1), st);
    float cover = f.m;
    albedo = mix(stainCol, rc, cover);
    metal = 1.0 - max(cover, st * 0.75);
    float dr = mix(RUST_ROUGH, SCALE_ROUGH - 0.15 * hum, plateOn * f.crack);
    dr = mix(dr, 0.97, max(bloom, f.chip * (1.0 - f.bare)));
    dr = mix(dr, 0.85, f.bare);
    dr = mix(dr, 0.5, black);
    dr = mix(dr, 0.55, st * (1.0 - f.m));
    rough = mix(rough, dr, max(cover, st));
    aniso *= 1.0 - max(max(cover, st), f.bare);
    ao *= 1.0 - 0.3 * f.crust * (1.0 - f.crack);
  } else {
    // STONE
    // dark honed basalt with a fine pale speck; stone does not rust, so it stays clean
    float cloud = vnoise3(p * 4.0) * 0.7 + vnoise3(p * 15.0) * 0.3;
    float speck = smoothstep(0.78, 0.9, vnoise3(p * 140.0));
    albedo = STONE * (0.85 + 0.3 * cloud) + vec3(0.02) * speck;
    metal = 0.0;
    rough = 0.6 + 0.08 * cloud;
  }
  rough = clamp(rough, 0.05, 1.0);

  // LIGHT
  vec3 V = -rd;
  float NoV = max(dot(n, V), 1e-3);
  vec3 key = normalize(KEY);
  vec3 amb = mix(vec3(0.03, 0.027, 0.024), vec3(0.075, 0.08, 0.088), n.y * 0.5 + 0.5);
  amb += vec3(0.05) * max(n.z, 0.0);
  vec3 irr = KEY_COL * max(dot(n, key), 0.0) * sh + RIM_COL * max(dot(n, normalize(RIM)), 0.0) * ao + amb * ao;

  // one env loop body: a smear of taps across the grain, or a single tap
  vec3 R = reflect(rd, n);
  vec3 B = normalize(cross(n, tng));
  int taps = aniso > 0.02 ? uTap.z : 1;
  float mid = float(taps - 1) * 0.5;
  vec3 spec = vec3(0.0);
  for (int i = 0; i < taps; i++) {
    float k = (float(i) - mid + uSmear * step(0.5, mid)) * 0.16 * aniso;
    spec += env(normalize(R + B * k), rough);
  }
  spec /= float(taps);
  float specOcc = clamp(ao * ao * 1.2, 0.0, 1.0) * mix(0.55, 1.0, sh);

  vec3 F0m = mix(vec3(0.04), F0, metal);
  float fres = pow(1.0 - NoV, 5.0);
  vec3 F = F0m + (max(vec3(1.0 - rough), F0m) - F0m) * fres;
  return albedo * (1.0 - metal) * irr * (1.0 - F * 0.5) + F * spec * specOcc;
}

void main() {
  vec2 frag = gl_FragCoord.xy + uJitter;
  float mn = min(uRes.x, uRes.y);
  vec2 uv = (frag - uRes * vec2(0.5, uFrame.x)) / mn;
  float cp = cos(uPitch);
  float sp = sin(uPitch);
  vec3 fwd = vec3(0.0, -sp, -cp);
  vec3 up = vec3(0.0, cp, -sp);
  vec3 rd = normalize(fwd * uFrame.y + uv.x * vec3(1.0, 0.0, 0.0) + uv.y * up);
  vec3 ro = TARGET - fwd * DIST;
  vec2 hit = sphere(ro - BC, rd, BR);
  float t = -1.0;
  if (hit.y > 0.0) t = march(ro, rd, max(hit.x, 0.0), hit.y);

  // BACKDROP
  // in display space so it meets the page colour exactly: a pool of light on the floor with
  // the key's soft shadow and a contact darkening at the foot, fading to the page colour
  vec2 hv = uv - vec2(0.0, 0.06);
  float halo = exp(-dot(hv, hv) * 5.0) * 0.12;
  vec3 P = ro + rd * (-ro.y / min(rd.y, -1e-4));
  float r2 = dot(P.xz, P.xz);
  bool floorHit = t <= 0.0 && rd.y < -0.001;
  bool shadowed = t > 0.0 || (floorHit && r2 < 7.0);

  // one shadow call for the specimen or the floor under it
  vec3 n = vec3(0.0, 1.0, 0.0);
  vec3 sp0 = P + vec3(0.0, 0.003, 0.0);
  if (t > 0.0) {
    sp0 = ro + rd * t;
    n = normal(sp0);
    sp0 += n * 0.003;
  }
  float sh = shadowed ? softShadow(sp0, normalize(KEY), t > 0.0 ? 14.0 : 8.0) : 1.0;

  vec3 col;
  if (t > 0.0) {
    col = shade(ro + rd * t, rd, n, sh);
    if (any(isnan(col)) || any(isinf(col))) col = vec3(0.0);
    col = tonemap(col * 1.05);
    col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  } else if (!floorHit) col = uBg * (1.0 + halo);
  else {
    float pool = exp(-r2 * 0.6);
    float lift = 1.0;
    if (r2 < 7.0) {
      float near = map(P + vec3(0.0, 0.06, 0.0));
      // the contact darkening is deep on the shadow side; toward the key, light fills it in
      // and only a thin rim stays
      float lit = dot(normalize(P.xz + 1e-4), normalize(KEY.xz));
      float toward = smoothstep(-0.3, 0.7, lit);
      float ao = clamp(0.35 + near * mix(6.0, 14.0, toward), 0.0, 1.0);
      lift = mix(0.4, 1.0, sh) * mix(1.0, ao, mix(0.85, 0.35, toward));
    }
    col = uBg * (1.0 + pool * 0.9 + halo * 0.5) * mix(1.0, lift, smoothstep(2.6, 0.5, sqrt(r2)));
  }
  outColor = vec4(col, 1.0);
}
`;

export const PRESENT_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2  uRes;
out vec4 outColor;
float hash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
void main() {
  vec3 c = texture(uTex, gl_FragCoord.xy / uRes).rgb;
  c += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  outColor = vec4(c, 1.0);
}
`;
