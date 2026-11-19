export const MAX_COLONIES = 32;
export const MAX_AGE_S = 12; // a colony stops spreading at this age
export const TAU_S = 4.5; // spread slows with age on this time scale
const SENT = "64.0"; // empty: never reached
const PAST = "60.0"; // how far back arrival times are kept
const CUP_S = "3.0"; // a spot has to be covered this long before cups rise on it

const DEFS = `
#define MAX ${MAX_AGE_S.toFixed(1)}
#define TAU ${TAU_S.toFixed(2)}
#define SENT ${SENT}
#define NCOL ${MAX_COLONIES}
const vec2 LIGHT = vec2(-0.6, 0.8);
const float PI = 3.14159265;
`;

const HASH = `
uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
float h1(ivec2 i) { return float(pcg(uint(i.x) + pcg(uint(i.y)))) / 4294967295.0; }
vec3 h3(ivec2 i) {
  uint a = pcg(uint(i.x) + pcg(uint(i.y)));
  uint b = pcg(a);
  uint c = pcg(b);
  return vec3(float(a), float(b), float(c)) / 4294967295.0;
}
float vnoise(vec2 p) {
  ivec2 i = ivec2(floor(p));
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = h1(i);
  float b = h1(i + ivec2(1, 0));
  float c = h1(i + ivec2(0, 1));
  float d = h1(i + ivec2(1, 1));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  mat2 m = mat2(1.6, 1.2, -1.2, 1.6);
  for (int i = 0; i < 5; i++) {
    s += a * vnoise(p);
    p = m * p + 3.7;
    a *= 0.5;
  }
  return s / 0.97;
}
// F1, F2, hash of the nearest cell, and the offset to its point
void worley(vec2 p, int salt, out vec3 f, out vec2 off) {
  ivec2 i = ivec2(floor(p));
  vec2 fp = fract(p);
  f = vec3(9.0, 9.0, 0.0);
  off = vec2(0.0);
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      ivec2 c = i + ivec2(x, y);
      vec3 h = h3(c + ivec2(salt * 131, salt * 71));
      vec2 o = vec2(x, y) + 0.1 + 0.8 * h.xy - fp;
      float d = length(o);
      if (d < f.x) {
        f.y = f.x;
        f.x = d;
        f.z = h.z;
        off = -o;
      } else if (d < f.y) f.y = d;
    }
}
`;

// FOLIOSE LOBES
// cells in log-polar space round the seed: they widen with the radius, so lobes come out
// small and crowded in the middle and broad and flat at the rim
const LOBES = `
const float LOBE_N = 30.0; // scallops round the margin
const float FINE_N = 46.0; // small lobes, cells round a ring
const float BROAD_N = 17.0; // broad tongues laid over them
const float LOBE_SQ = 0.85; // under 1: lobes run a little longer along the radius than across
// position across the margin lobe this direction falls in (-1..1), and that lobe's hash
vec2 scallop(vec2 d, float salt) {
  float u = (atan(d.y, d.x) / (2.0 * PI) + 0.5) * LOBE_N;
  float j = mod(floor(u), LOBE_N);
  return vec2(fract(u) * 2.0 - 1.0, h1(ivec2(int(j) + int(salt) * 3, 7)));
}
// soft lobes: each cell is a round pillow of its own size, and neighbours blend with a smooth
// minimum instead of meeting at a hard edge. s: 0 at a lobe's middle, 1 at its rim, more in
// the gaps; g: the soft-weighted way out from the lobe middle, in screen directions, ~0..1;
// out: how much that way points away from the seed; hsh: the nearest lobe's hash;
// crease: the soft valley where two lobes press together
const float SOFT_K = 7.0;
void plates(vec2 d, int salt, float N, out float s, out vec2 g, out float out_, out float hsh,
            out float crease) {
  float r = max(length(d), 0.05);
  vec2 er = d / r;
  vec2 et = vec2(-er.y, er.x);
  float k = N / (2.0 * PI);
  vec2 q = vec2(log(r) * k * LOBE_SQ, (atan(d.y, d.x) / (2.0 * PI) + 0.5) * N);
  // knock the rings out of line; the noise follows the direction, so it wraps cleanly
  q.x += 0.9 * vnoise(er * 2.3 + float(salt)) + 0.5 * vnoise(er * 5.1 - float(salt));
  ivec2 i = ivec2(floor(q));
  vec2 fp = fract(q);
  int n = int(N);
  float sum = 0.0;
  vec2 acc = vec2(0.0);
  float best = 9.0;
  hsh = 0.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      ivec2 c = i + ivec2(x, y);
      vec3 h = h3(ivec2(c.x + salt * 131, ((c.y % n) + n) % n + salt * 71));
      vec2 o = fp - (vec2(x, y) + 0.1 + 0.8 * h.xy);
      float rc = 0.5 + 0.35 * h.z;
      float qi = length(o) / rc;
      float wgt = exp(-SOFT_K * qi);
      sum += wgt;
      acc += wgt * o / rc;
      if (qi < best) {
        best = qi;
        hsh = h.z;
      }
    }
  s = -log(max(sum, 1e-6)) / SOFT_K;
  // where two pillows press together the soft minimum drops below the nearest one
  crease = smoothstep(0.03, 0.12, best - s);
  vec2 a = acc / max(sum, 1e-6);
  g = a.x * er + a.y * et;
  out_ = a.x / max(length(a), 1e-3);
}`;

// SPECKS
// old dead fragments and grit on the stone; living colonies creep round them, then over
const SPECKS = `
vec2 speck(vec2 pu) {
  vec3 f;
  vec2 o;
  worley(pu / 2.4, 9, f, o);
  float r = 0.07 + 0.09 * fract(f.z * 7.0);
  float m = step(f.z, 0.3) * smoothstep(r, r * 0.6, f.x * (0.8 + 0.4 * vnoise(pu * 5.0)));
  return vec2(m, fract(f.z * 13.0));
}`;

// SPREAD
// state: r seconds until this texel is covered (negative once it is), g colony age on
// arrival, b colony slot (-1 empty), a where two colonies meet.
// a texel takes the earliest arrival any neighbour offers; colonies cannot overgrow each other
export const GROW_FS = `#version 300 es
precision highp float;
precision highp int;
${DEFS}
uniform sampler2D uPrev;
uniform vec4  uSeeds[NCOL]; // sim px xy, species, size
uniform vec4  uNew;         // sim px xy, slot, 1 while planting
uniform float uShift;       // seconds passed since the last pass
uniform float uSpeed;       // young spread speed, sim px per second
uniform float uUnit;        // sim px per unit
uniform float uClear;
uniform vec4  uAvoid[2];    // sim px boxes kept mostly clear: the title and the hud
out vec4 outColor;
${HASH}
${LOBES}
${SPECKS}
// king and knight moves, so fronts come out round instead of octagonal
const ivec2 OFFS[16] = ivec2[16](ivec2(1, 0), ivec2(-1, 0), ivec2(0, 1), ivec2(0, -1),
  ivec2(1, 1), ivec2(-1, 1), ivec2(1, -1), ivec2(-1, -1),
  ivec2(2, 1), ivec2(1, 2), ivec2(-1, 2), ivec2(-2, 1),
  ivec2(-2, -1), ivec2(-1, -2), ivec2(1, -2), ivec2(2, -1));

// how fast colony id creeps into p, before slowing with age: lobes are fast radial lanes,
// and they fork as the rosette widens
float reach(vec2 p, int id) {
  vec4 s = uSeeds[id];
  vec2 d = (p - s.xy) / uUnit;
  vec2 dir = normalize(d + 1e-4);
  float salt = float(id) * 17.3;
  vec2 pu = p / uUnit;
  // a few broad bulges, then a patchy stone, so fronts come out ragged
  float bulge = 1.0 + 0.7 * (vnoise(dir * 1.3 + salt) - 0.5) + 0.4 * (vnoise(dir * 3.1 - salt) - 0.5);
  float ground = 0.4 + 1.2 * fbm(pu * 0.45 + salt);
  float grit = 1.0 - 0.88 * speck(pu).x;
  float lane = 0.66;
  // foliose lobes push ahead at their middles, so the margin scallops
  if (s.z < 1.5) {
    vec2 L = scallop(d, salt);
    lane = (0.6 + 0.5 * sqrt(1.0 - abs(L.x))) * (0.82 + 0.36 * L.y);
  }
  float keep = 1.0;
  for (int i = 0; i < 2; i++) {
    vec4 b = uAvoid[i];
    vec2 q = max(b.xy - p, p - b.zw);
    keep = min(keep, mix(0.12, 1.0, smoothstep(0.0, 3.0 * uUnit, length(max(q, 0.0)))));
  }
  return uSpeed * s.w * bulge * ground * grit * lane * keep;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 pc = vec2(p) + 0.5;
  ivec2 size = textureSize(uPrev, 0);
  vec4 c = texelFetch(uPrev, p, 0);
  bool own = c.b >= 0.0;
  float R0 = own ? max(c.r - uShift, -${PAST}) : SENT;
  float a0 = own ? c.g : SENT;
  float R = R0;
  float a = a0;
  float id = c.b;
  // an empty or spent texel can be taken by anyone still spreading
  float cmp = (own && a0 < MAX) ? R0 : 2.0 * SENT;
  float border = 0.0;
  // the speed field only depends on the colony, so it is worked out once for each of the
  // (at most) two colonies round this texel; keeps the unrolled loop small
  vec4 ns[16];
  float idA = -1.0;
  float idB = -1.0;
  for (int k = 0; k < 16; k++) {
    vec4 n = texelFetch(uPrev, clamp(p + OFFS[k], ivec2(0), size - 1), 0);
    ns[k] = n;
    if (n.b < 0.0 || n.g >= MAX) continue;
    if (idA < 0.0) idA = n.b;
    else if (n.b != idA && idB < 0.0) idB = n.b;
  }
  float vA = idA >= 0.0 ? reach(pc, int(idA)) : 1.0;
  float vB = idB >= 0.0 ? reach(pc, int(idB)) : vA;
  for (int k = 0; k < 16; k++) {
    vec4 n = ns[k];
    if (n.b < 0.0) continue;
    float nR = max(n.r - uShift, -${PAST});
    if (k < 8 && own && n.b != c.b && nR < 0.0 && R0 < 0.0 && n.g < MAX && a0 < MAX) border = 1.0;
    if (n.g >= MAX) continue;
    float v = n.b == idA ? vA : vB;
    float dt = length(vec2(OFFS[k])) / (v * exp(-n.g / TAU));
    float cR = nR + dt;
    if (cR < cmp) {
      cmp = cR;
      R = cR;
      a = n.g + dt;
      id = n.b;
    }
  }
  // PLANT
  bool covered = own && a0 < MAX && R0 < 0.0;
  if (uNew.w > 0.0 && !covered && length(vec2(p) + 0.5 - uNew.xy) < 1.6) {
    R = 0.0;
    a = 0.0;
    id = uNew.z;
  }
  if (id < 0.0 || uClear > 0.0) outColor = vec4(SENT, SENT, -1.0, 0.0);
  else outColor = vec4(R, a, id, border);
}`;

// carries the state over to a new size
export const COPY_FS = `#version 300 es
precision highp float;
uniform sampler2D uPrev;
uniform vec2  uRatio;
out vec4 outColor;
void main() {
  outColor = texelFetch(uPrev, ivec2(gl_FragCoord.xy * uRatio), 0);
}`;

// STONE
// drawn once per size: weathered limestone with its own light
export const STONE_FS = `#version 300 es
precision highp float;
precision highp int;
${DEFS}
uniform vec2  uRes;
uniform float uUnit; // canvas px per unit
out vec4 outColor;
${HASH}
${SPECKS}
float height(vec2 p) {
  return fbm(p * 0.35) * 0.45 + vnoise(p * 3.0) * 0.2 + vnoise(p * 9.0) * 0.1 + vnoise(p * 24.0) * 0.05;
}
void main() {
  vec2 p = gl_FragCoord.xy / uUnit;
  float h = height(p);
  float e = 0.03;
  vec3 n = normalize(vec3(
    (h - height(p + vec2(e, 0.0))) / e * 0.12,
    (h - height(p + vec2(0.0, e))) / e * 0.12,
    1.0));
  float diff = dot(n, normalize(vec3(LIGHT, 1.0)));

#ifdef SLATE
  vec3 lo = vec3(0.27, 0.29, 0.3);
  vec3 hi = vec3(0.34, 0.36, 0.37);
#else
  vec3 lo = vec3(0.71, 0.69, 0.65);
  vec3 hi = vec3(0.8, 0.78, 0.74);
#endif
  vec3 col = mix(lo, hi, smoothstep(0.25, 0.75, fbm(p * 0.12 + 3.0)));
  // old grey weathering, faint
  col *= 1.0 - 0.07 * smoothstep(0.55, 0.8, fbm(p * 0.25 + 11.0));

  // pores with a shadowed upper lip
  vec3 w;
  vec2 o;
  worley(p * 1.4, 3, w, o);
  float pit = smoothstep(0.16, 0.04, w.x) * step(w.z, 0.22);
  float lip = clamp(dot(normalize(o + 1e-4), LIGHT), -1.0, 1.0);
  col *= 1.0 - pit * (0.16 + 0.12 * lip);

  // DEAD LICHEN
  // grey-black and chalky fragments, and pin dots of old fruit
  vec2 sk = speck(p);
  vec3 dead = sk.y < 0.55 ? vec3(0.34, 0.33, 0.31) : vec3(0.88, 0.87, 0.83);
  col = mix(col, dead * (0.8 + 0.4 * vnoise(p * 14.0)), sk.x * 0.85);
  vec3 dt = h3(ivec2(floor(p * 2.5)) + ivec2(40, 9));
  float dotR = 0.02 + 0.03 * dt.z;
  float pin = step(dt.z, 0.08) * smoothstep(dotR, dotR * 0.5, length(fract(p * 2.5) - 0.2 - 0.6 * dt.xy) / 2.5);
  col = mix(col, vec3(0.18, 0.17, 0.16), pin * 0.8);

  // mineral flecks
  float g = h1(ivec2(floor(p * 11.0)));
  col *= g > 0.988 ? 0.78 : (g < 0.01 ? 1.08 : 1.0);
  col *= 0.86 + 0.28 * diff;
  outColor = vec4(col, 1.0);
}`;

// LICHEN
// colours: foliose orange (Xanthoria), foliose sage (Flavoparmelia),
// crustose chartreuse on black (map lichen), crustose grey (Lecanora)
export const SHOW_FS = `#version 300 es
precision highp float;
precision highp int;
${DEFS}
uniform sampler2D uState;
uniform sampler2D uStone;
uniform vec2  uRes;
uniform vec2  uSim;
uniform vec4  uSeeds[NCOL];
uniform float uSpeed;
uniform float uUnit; // sim px per unit
out vec4 outColor;
${HASH}
${LOBES}
const vec3 BASE[4] = vec3[4](vec3(0.9, 0.56, 0.15), vec3(0.6, 0.67, 0.5), vec3(0.8, 0.85, 0.22), vec3(0.8, 0.8, 0.74));
const vec3 RIM[4] = vec3[4](vec3(0.99, 0.8, 0.38), vec3(0.8, 0.85, 0.7), vec3(0.1, 0.1, 0.09), vec3(0.93, 0.93, 0.89));
const vec3 CORE[4] = vec3[4](vec3(0.74, 0.36, 0.09), vec3(0.42, 0.48, 0.36), vec3(0.62, 0.7, 0.15), vec3(0.65, 0.66, 0.6));
const vec3 GROOVE[4] = vec3[4](vec3(0.42, 0.18, 0.05), vec3(0.22, 0.25, 0.18), vec3(0.07, 0.07, 0.06), vec3(0.42, 0.42, 0.38));
const vec3 DISC[4] = vec3[4](vec3(0.86, 0.4, 0.06), vec3(0.46, 0.27, 0.14), vec3(0.06, 0.06, 0.05), vec3(0.78, 0.52, 0.26));
const vec3 LIP[4] = vec3[4](vec3(1.0, 0.72, 0.3), vec3(0.7, 0.75, 0.6), vec3(0.14, 0.14, 0.12), vec3(0.94, 0.93, 0.88));
const float CUPS[4] = float[4](0.55, 0.2, 0.14, 0.35);

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 stone = texture(uStone, uv).rgb;
  vec2 sp = uv * uSim;
  vec4 s = texture(uState, uv);

  // CAST SHADOW
  // lichen sits a hair proud of the stone
  vec4 sh = texture(uState, uv + LIGHT * (0.22 * uUnit) / uSim);
  float shade = smoothstep(0.6, -0.6, sh.r) * smoothstep(MAX + 0.4, MAX - 0.4, sh.g) * step(0.0, sh.b);

  // nearest live texel decides which colony this is
  ivec2 ip = ivec2(floor(sp - 0.5));
  ivec2 top = ivec2(uSim) - 1;
  float id = -1.0;
  float best = 9.0;
  for (int k = 0; k < 4; k++) {
    ivec2 q = clamp(ip + ivec2(k & 1, k >> 1), ivec2(0), top);
    vec4 t = texelFetch(uState, q, 0);
    float dq = length(vec2(q) + 0.5 - sp);
    if (t.b >= 0.0 && t.g < MAX && dq < best) {
      best = dq;
      id = t.b;
    }
  }
  vec3 bare = stone * (1.0 - 0.28 * shade);
  if (id < 0.0) {
    outColor = vec4(bare, 1.0);
    return;
  }

  // COVERAGE
  // crisp, slightly ragged edge at the arrival front
  float R = s.r;
  float a = s.g;
  float jit = vnoise(sp / uUnit * 9.0) - 0.5;
  float cov = clamp(-R / max(fwidth(R), 1e-4) + jit * 2.5 + 0.5, 0.0, 1.0)
            * clamp((MAX - a) / max(fwidth(a), 1e-4) + jit * 2.5 + 0.5, 0.0, 1.0);

  vec4 seed = uSeeds[int(id)];
  int k = int(seed.z);
  int salt = int(id) * 7919 + 13;
  vec2 d = (sp - seed.xy) / uUnit;
  vec2 pu = sp / uUnit;

  // how far inside the growing front, in units, and how far out from the centre (0..1)
  float A = min(a - R, MAX);
  float e1 = exp(-a / TAU);
  float front = uSpeed * seed.w * TAU * max(e1 - exp(-A / TAU), 0.0) / uUnit;
  float rn = clamp((1.0 - e1) / (1.0 - exp(-MAX / TAU)), 0.0, 1.0);
  float rim = 1.0 - smoothstep(0.0, 1.0, front);

  vec3 col = mix(CORE[k], BASE[k], smoothstep(0.0, 0.8, rn));
  vec3 grain = vec3(0.0);
  if (k < 2) {
    float r = length(d);
    vec2 er = d / max(r, 1e-3);
    float wob = 0.1 * (vnoise(pu * 9.0) - 0.5) + 0.06 * (vnoise(pu * 21.0) - 0.5);
    float crinkle = vnoise(pu * 7.0 + float(id)) - 0.5;
    col = mix(col, RIM[k], rim * 0.8);

    // FINE LOBES
    // small pillowy tongues blended softly into each other; each its own height and tone
    float sf;
    vec2 gf;
    float of;
    float hf;
    float cf;
    plates(d, salt, FINE_N, sf, gf, of, hf, cf);
    float cell = r / (FINE_N / (2.0 * PI));
    // near the seed the cells get too small to read as lobes; there it is plain crust
    float big = smoothstep(0.3, 0.6, cell);
    float swf = sf + wob;
    float body = mix(1.0, smoothstep(1.08, 0.92, swf), big);
    float pillow = clamp(1.0 - swf * swf, 0.0, 1.0);
    float lift = 0.6 + 0.8 * fract(hf * 3.7);
    float slope = clamp(dot(gf, LIGHT) * 1.3, -1.0, 1.0);
    float lip = smoothstep(0.72, 0.95, swf) * body * big;
    vec3 fine = col * (0.86 + 0.2 * fract(hf * 11.0));
    fine *= 0.82 + (0.16 * pillow + 0.22 * lift * slope) * body * big + 0.16 * crinkle;
    fine = mix(fine, RIM[k], lip * smoothstep(-0.2, 0.8, of) * 0.4);
    fine = mix(fine, GROOVE[k], (1.0 - body) * 0.5 + cf * big * 0.3);

    // BROAD TONGUES
    // in patches, big soft lobes lie over the fine ones, curl at the edge and cast a shadow
    float sb;
    vec2 gb;
    float ob;
    float hb;
    float cb;
    plates(d, salt + 7, BROAD_N, sb, gb, ob, hb, cb);
    float zone = smoothstep(0.42, 0.58, vnoise(pu * 0.28 + float(id) * 3.1)) * smoothstep(0.3, 0.55, rn);
    float swb = sb + 0.14 * (vnoise(pu * 3.5 + float(id)) - 0.5);
    float bodyB = smoothstep(1.0, 0.9, swb) * zone;
    float castB = smoothstep(1.3, 1.0, swb - 0.12 * dot(normalize(gb + 1e-4), LIGHT)) * zone * (1.0 - bodyB);
    float pillowB = clamp(1.0 - swb * swb, 0.0, 1.0);
    float slopeB = clamp(dot(gb, LIGHT) * 1.3, -1.0, 1.0);
    float lipB = smoothstep(0.7, 0.97, swb) * bodyB;
    vec3 broad = col * (0.92 + 0.2 * fract(hb * 11.0));
    broad *= 0.84 + 0.18 * pillowB + 0.3 * slopeB + 0.12 * crinkle + 0.1 * (vnoise(pu * 3.0) - 0.5);
    broad = mix(broad, RIM[k], lipB * smoothstep(-0.2, 0.8, ob) * 0.55);
    broad = mix(broad, GROOVE[k], cb * 0.3);
    col = mix(fine * (1.0 - 0.4 * castB), broad, bodyB);

    // the old middle crumbles into granules
    vec3 g;
    vec2 go;
    worley(pu / 0.16, salt + 2, g, go);
    float gran = smoothstep(0.45, 0.2, rn) * step(g.z, 0.8) * smoothstep(0.45, 0.2, g.x);
    col = mix(col, CORE[k] * (0.85 + 0.4 * clamp(dot(-go / 0.3, LIGHT), -1.0, 1.0)), gran * 0.85);
  } else {
    vec3 w;
    vec2 o;
    // warped cells, so areoles come out as irregular plates, not a honeycomb
    vec2 q = pu / (k == 2 ? 0.55 : 0.6) + 0.6 * vec2(vnoise(pu * 1.3), vnoise(pu * 1.3 + 9.0));
    worley(q, salt, w, o);
    // areoles break up into the prothallus toward the margin, smaller and further apart
    float keep = smoothstep(0.1, 1.4, front + w.z * 0.9 - 0.25);
    bool map = k == 2;
    float gap = (map ? mix(0.24, 0.07, keep) : mix(0.14, 0.03, keep)) + 0.05 * vnoise(pu * 3.0);
    float plate = smoothstep(gap, gap + 0.06, w.y - w.x);
    float dome = clamp(dot(o, LIGHT) / 0.5, -1.0, 1.0);
    // every areole its own shade: map lichen runs yellow to lime to sea green,
    // the grey crust from chalk to blue grey to cream
    float hue = fract(w.z * 7.3);
    vec3 tintA = map ? vec3(0.9, 0.84, 0.3) : vec3(0.88, 0.88, 0.84);
    vec3 tintB = map ? vec3(0.62, 0.78, 0.24) : vec3(0.68, 0.72, 0.74);
    vec3 tintC = map ? vec3(0.5, 0.66, 0.34) : vec3(0.84, 0.8, 0.68);
    vec3 tint = hue < 0.4 ? tintA : (hue < 0.75 ? tintB : tintC);
    col = mix(col, tint * (0.85 + 0.3 * rn), map ? 0.55 : 0.45);
    col *= 1.0 + (map ? 0.24 : 0.12) * (fract(w.z * 13.7) - 0.5);
    col *= 1.0 + 0.1 * (fbm(pu * 0.8 + float(id)) - 0.5);
    col *= 1.0 + (map ? 0.3 : 0.14) * (dome * smoothstep(0.0, 0.25, w.y - w.x) - 0.45);
    col = mix(mix(RIM[k], GROOVE[k], keep), col, plate * step(0.08, keep + w.z * 0.2));
  }

  // CUPS
  // apothecia rise in the older parts once the thallus has filled in
  vec3 w;
  vec2 o;
  bool crowd = k == 0;
  float cs = crowd ? 0.85 : 1.1;
  worley(pu / cs, salt + 5, w, o);
  float reach = crowd ? 1.0 - smoothstep(0.35, 0.7, rn) : 1.0 - smoothstep(0.7, 0.9, rn);
  float present = step(w.z, CUPS[k] * (2.0 - 1.8 * rn)) * smoothstep(0.9, 2.2, front) * reach;
  float rc = (crowd ? 0.3 + 0.2 * fract(w.z * 37.0) : 0.24 + 0.16 * fract(w.z * 37.0)) * present
           * smoothstep(${CUP_S}, ${CUP_S} + 2.5, -R);
  if (rc > 0.01) {
    float q = w.x / rc;
    vec2 n = o / max(w.x, 1e-4);
    float lit = dot(n, LIGHT);
    // shadow beside the cup, then the lip, then the dished disc
    col *= 1.0 - 0.35 * smoothstep(1.35, 1.0, q) * step(1.0, q) * clamp(-lit, 0.0, 1.0);
    vec3 lip = LIP[k] * (0.92 + 0.25 * lit * smoothstep(0.6, 1.0, q));
    vec3 disc = DISC[k] * (0.9 - 0.25 * lit * (1.0 - q));
    vec3 cup = mix(disc, lip, smoothstep(0.62, 0.7, q));
    col = mix(col, cup, 1.0 - smoothstep(0.95, 1.02, q));
  }

  col *= 0.93 + 0.14 * vnoise(pu * 16.0);

  // where colonies meet they draw a dark line
  float line = smoothstep(0.12, 0.5, s.a);
  col = mix(col, GROOVE[k] * 0.55, line * 0.9);

  outColor = vec4(mix(bare, col, cov), 1.0);
}`;
