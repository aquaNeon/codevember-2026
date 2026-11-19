// HOLLOW
// a fall through the slices of a hollow trunk. each slice is a plane with a hole in it;
// one fullscreen pass walks the planes front to back, so the tunnel costs no geometry.
// a lamp just above the eye lights the end grain and lets each lip shadow the next

const MAX_DPR = 2;
const MAX_DT_S = 1 / 20;
export const SLICE_M = 0.3; // gap between slices, change for a denser stack
const THICK_M = 0.07; // how thick each slice is
const STEPS = 44; // slices one pixel may look through
const EASE_S = 0.22; // how softly the speed follows the input
const COAST_S = 1.1; // how long a push keeps carrying you, change for more inertia
const WHEEL_GAIN = 0.006; // metres per second per wheel pixel
const DRAG_GAIN = 0.012; // metres per second per dragged pixel
const KEY_PUSH = 1.4;
const MAX_SPEED = 12;
const INTRO_SPEED = 2.6; // the page opens already falling, then comes to rest
const REST_SPEED = 0.002;
const PAPER = new URLSearchParams(location.search).get("v") === "b";
// THE JOURNEY
// depth in metres where each layer starts to take over; it is fully there TRANSITION_M later
const LAYER_AT = [15, 32, 48, 70]; // roots, soil, stone, geode
const TRANSITION_M = 8;
const MOTE_GAP_M = 0.5; // planes of dust ahead of the lamp
const MOTES = 7; // dust planes the lamp looks through
export const LAYERS = ["Heartwood", "Roots", "Soil", "Stone", "Geode"];

// the layer the hud names at a depth: whichever is more than half in
export function layerAt(z: number) {
  let n = 0;
  for (const at of LAYER_AT) if (z > at + TRANSITION_M / 2) n++;
  return LAYERS[n];
}

const VS = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
${PAPER ? "#define PAPER" : ""}
uniform vec2  uRes;
uniform float uZ;
uniform float uRoll;
uniform float uSpeed;
// loop counts come in as uniforms so the driver keeps them as loops instead of unrolling,
// which made the first compile take seconds
uniform int   uSteps;
uniform int   uMotes;
uniform int   uOne; // always 1; multiplying a loop count by it keeps the loop a loop
out vec4 outColor;

const float S = ${SLICE_M.toFixed(3)};
const float T = ${THICK_M.toFixed(3)};
const float TAU = 6.2831853;
const vec4  LAYER_AT = vec4(${LAYER_AT.map((n) => n.toFixed(1)).join(", ")});
const float SPAN = ${TRANSITION_M.toFixed(1)};

float hash(float x) { return fract(sin(x * 127.1) * 43758.5453); }
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash2(i);
  float b = hash2(i + vec2(1.0, 0.0));
  float c = hash2(i + vec2(0.0, 1.0));
  float d = hash2(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p) {
  return 0.5 * noise(p) + 0.3 * noise(p * 2.1 + 3.7) + 0.2 * noise(p * 4.3 + 9.1);
}

// how far each deeper layer has taken over at a slice: roots, soil, stone, geode.
// each slice jitters its own depth a little so the change comes in ragged, not as a line
vec4 zones(float k) {
  float z = k * S + (hash(k * 1.31) - 0.5) * 3.0;
  return smoothstep(LAYER_AT, LAYER_AT + SPAN, vec4(z));
}

// the hollow wanders, so the far end drifts off the axis
vec2 path(float z) {
  return vec2(0.55 * sin(z * 0.071) + 0.35 * sin(z * 0.023 + 1.0), 0.45 * cos(z * 0.057));
}

// HOLE
// irregular, rotted out; it narrows and widens slowly down the trunk
float hole(float k, vec2 dir) {
  float base = 1.0 + 0.08 * sin(k * 0.11) + 0.06 * sin(k * 0.037 + 2.0);
  float edge = fbm(dir * 1.3 + vec2(k * 0.035, k * 0.021)) - 0.5;
  float chip = noise(dir * 6.0 + k * 0.7) - 0.5;
  float R = base * (1.0 + 0.32 * edge + 0.04 * chip);
#ifndef PAPER
  // the geode opens wider, its edge lumpy with clusters of crystal
  float g = zones(k).w;
  if (g > 0.0) R *= mix(1.0, 1.32 - 0.12 * noise(dir * 3.0 + k * 0.05), g);
#endif
  return R;
}

mat2 spin(float a) {
  float c = cos(a), s = sin(a);
  return mat2(c, -s, s, c);
}

// END GRAIN
// rings around the pith, wandering a little; fine detail fades with pixel size
vec3 grain(vec2 q, float k, float fw) {
  float r = length(q);
  vec2 dir = q / max(r, 1e-4);
  // the pith sits a little off centre, so rings crowd on one side
  vec2 pith = vec2(0.12, -0.05);
  float rr = length(q - pith * smoothstep(0.0, 2.0, r));
  float warp = (fbm(dir * 0.7 + k * 0.004) - 0.5) * 0.12 + (fbm(q * 1.4) - 0.5) * 0.05;
  float u = (rr + warp) * 30.0;
  float ring = fract(u);
  float aa = clamp(fw * 30.0 * 2.0, 0.0, 1.0);
  // earlywood soft and wide, latewood a thin dark band at the end of each year
  float late = smoothstep(0.62, 0.9, ring) * (1.0 - smoothstep(0.9, 1.0, ring));
  late = mix(late, 0.28, aa);
  float year = hash(floor(u));
  float rays = smoothstep(0.82, 1.0, noise(vec2(atan(q.y, q.x) * 90.0, r * 3.0)));
  rays *= 1.0 - clamp(fw * 120.0, 0.0, 1.0);
  float saw = noise(vec2((q * spin(hash(k) * TAU)).y * 70.0, k));
  saw = mix(saw, 0.5, clamp(fw * 70.0, 0.0, 1.0));
#ifdef PAPER
  vec3 early = vec3(0.93, 0.9, 0.84);
  vec3 lateC = vec3(0.16, 0.14, 0.13);
  float line = smoothstep(0.84, 0.9, ring) * (1.0 - smoothstep(0.93, 0.99, ring));
  line = mix(line, 0.12, aa);
  vec3 c = mix(early, lateC, line * (0.45 + 0.35 * year));
  c *= 0.98 + 0.02 * saw;
#else
  vec3 early = mix(vec3(0.74, 0.52, 0.32), vec3(0.66, 0.44, 0.26), year);
  vec3 lateC = vec3(0.34, 0.19, 0.1);
  vec3 c = mix(early, lateC, late * (0.55 + 0.45 * year));
  c = mix(c, vec3(0.86, 0.68, 0.46), rays * 0.35);
  c *= 0.95 + 0.05 * saw;
#endif
  return c;
}

// CHECKS
// drying cracks run out from the hole, wide at the lip and closing further out
float checks(vec2 q, float k, float R, float fw) {
  float r = length(q);
  float a = atan(q.y, q.x);
  float d = 1.0;
  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    if (hash(k * 3.1 + fi) > 0.3) continue;
    float ang = hash(k * 7.3 + fi * 1.9) * TAU;
    float len = 0.25 + 0.55 * hash(k * 1.7 + fi);
    float off = abs(sin(a - ang)) * r;
    float along = (r - R) / len;
    float w = 0.0045 * (1.0 - along) * (1.0 - along) + fw * 0.5;
    float c = smoothstep(w, w * 0.2, off) * step(along, 1.0) * step(0.0, cos(a - ang)) * 0.85;
    d = min(d, 1.0 - c);
  }
  return d;
}

// LAYERS
// each returns a surface colour; glow collects light that does not need the lamp
const vec3 FUNGUS = vec3(0.35, 1.0, 0.72);

// ROOTS
// roots wrap round the hollow inside each slice: a strand follows the hole at its own
// distance, wandering in and out, thick at one end and tapering to a hair at the other.
// the thick ones carry on through many slices; the fine ones change from slice to slice
vec3 roots(vec3 wood, vec2 q, float k, float R, float fw) {
  vec3 c = mix(wood * 0.4, vec3(0.17, 0.11, 0.07), 0.6);
  float r = length(q);
  float th = atan(q.y, q.x);
  float fine = 1.0 - clamp(fw * 260.0, 0.0, 1.0);
  for (int i = 0; i < 7 * uOne; i++) {
    float fi = float(i);
    bool thick = i < 2;
    // thick roots only drift slowly with depth; fine ones are new on each slice
    float seed = thick ? fi * 13.0 : k * 3.7 + fi * 1.9;
    if (!thick && hash(seed) > 0.7) continue;
    float th0 = hash(seed + 0.3) * TAU + (thick ? k * 0.012 : 0.0);
    float span = thick ? 3.6 : 1.0 + 1.8 * hash(seed + 0.6);
    float t = mod(th - th0, TAU) / span;
    if (t > 1.0) continue;
    // distance out from the lip, wandering, and drifting outward like a branch leaving
    float off = (thick ? 0.12 : 0.05 + 0.3 * hash(seed + 0.9))
      + 0.05 * sin(t * span * 3.0 + seed) + 0.025 * sin(t * span * 11.0 + seed * 2.0)
      + (thick ? 0.0 : 0.22 * t * (hash(seed + 1.4) - 0.3));
    float w = (thick ? 0.04 : 0.012 * (0.4 + hash(seed + 2.1))) * mix(1.0, 0.12, t);
    float d = abs(r - (R + off));
    vec3 tone = thick ? vec3(0.5, 0.35, 0.22) : vec3(0.64, 0.5, 0.36);
    // root hairs: short radial strokes off both sides of the strand
    float hair = step(0.66, noise(vec2(t * span * r * 160.0, seed))) * fine;
    hair *= smoothstep(w + 0.03, w, d) * step(w, d) * 0.5 * (1.0 - t * 0.5);
    c = mix(c, tone * 1.1, hair);
    // the thick end grows out of the slice rather than starting square
    float body = smoothstep(w + fw, max(w - fw, 0.0), d) * smoothstep(0.0, 0.06, t);
    float rnd = sqrt(max(0.0, 1.0 - (d * d) / (w * w)));
    vec3 rc = tone * (0.5 + 0.6 * rnd) * (0.85 + 0.3 * noise(vec2(t * span * 30.0, seed)));
    c = mix(c, rc, body);
  }
  return c;
}

vec3 soil(vec2 q, float k, float fw) {
  float fine = 1.0 - clamp(fw * 40.0, 0.0, 1.0);
  float g = mix(0.5, noise(q * 55.0), fine) * 0.5 + noise(q * 12.0) * 0.5;
  vec3 c = vec3(0.26, 0.18, 0.12) * (0.65 + 0.7 * g);
  float pv = noise(q * 13.0 + k * 0.37);
  float peb = smoothstep(0.72, 0.74 + fw * 6.0, pv);
  vec3 pc = vec3(0.42, 0.39, 0.35) * (0.75 + 0.4 * noise(q * 25.0 + k));
  // a pebble is round, so it darkens toward its rim
  pc *= 0.7 + 0.3 * smoothstep(0.72, 0.8, pv);
  return mix(c, pc, peb);
}

vec3 stone(vec2 q, float k, float fw) {
  // strata: a run of slices shares one rock, then the next layer comes
  float z = k * S;
  float layer = floor(z / 1.6 + noise(vec2(z * 0.4, 1.0)) * 0.7);
  float h = hash(layer * 3.7);
  vec3 pal = h < 0.25 ? vec3(0.62, 0.48, 0.34)
    : h < 0.5 ? vec3(0.3, 0.29, 0.3)
    : h < 0.75 ? vec3(0.7, 0.67, 0.6)
    : vec3(0.58, 0.38, 0.22);
  float fine = 1.0 - clamp(fw * 40.0, 0.0, 1.0);
  vec3 c = pal * (0.82 + 0.3 * fbm(q * 4.0 + layer) + 0.12 * fine * (noise(q * 70.0) - 0.5));
  // quartz veins in some layers
  float vein = abs(fbm(q * 1.7 + layer * 2.3) - 0.5) / (0.006 + fw);
  c = mix(c, vec3(0.86, 0.84, 0.8), (1.0 - smoothstep(0.5, 1.0, vein)) * step(0.55, hash(layer + 0.5)));
  return c;
}

// GEODE
// agate bands that follow the cavity, then a druzy lining of crystal points that grow
// larger toward the open middle. some slices are almost all agate
vec3 druzy(vec2 q, float scale, float k, out float apex, out float h) {
  vec2 g = q * scale;
  vec2 cell = floor(g);
  float best = 9.0;
  vec2 to = vec2(0.0);
  h = 0.0;
  for (int y = -uOne; y <= uOne; y++)
    for (int x = -uOne; x <= uOne; x++) {
      vec2 c = cell + vec2(float(x), float(y));
      vec2 o = vec2(hash2(c + k), hash2(c + k + 17.3));
      vec2 v = c + o - g;
      float dd = dot(v, v);
      if (dd < best) {
        best = dd;
        to = v;
        h = hash2(c * 1.7 + k);
      }
    }
  apex = 1.0 - clamp(sqrt(best) * 1.4, 0.0, 1.0);
  // two faces lit differently make each point read as a pyramid
  float facet = 0.5 + 0.5 * dot(normalize(to + 1e-4), normalize(vec2(-0.6, 0.8)));
  vec3 deep = vec3(0.16, 0.05, 0.26);
  vec3 tipC = h > 0.8 ? vec3(0.86, 0.86, 0.9) : vec3(0.78, 0.66, 0.95);
  return mix(deep, tipC, apex * apex) * (0.45 + 0.7 * facet);
}

vec3 geode(vec2 q, float k, float R, float fw, inout vec3 glow) {
  float r = length(q);
  vec2 dir = q / max(r, 1e-4);
  float d = r - R;
  float aa = clamp(fw * 30.0, 0.0, 1.0);

  // AGATE
  float wob = (fbm(dir * 2.0 + k * 0.01) - 0.5) * 0.05;
  float u = (d + wob) * 17.0 + hash(k) * 4.0;
  float id = floor(u);
  float hb = hash(id * 1.37 + 0.5);
  vec3 band = hb < 0.3 ? vec3(0.78, 0.77, 0.8)
    : hb < 0.6 ? vec3(0.36, 0.41, 0.5)
    : hb < 0.85 ? vec3(0.5, 0.45, 0.6)
    : vec3(0.15, 0.15, 0.2);
  float edge = smoothstep(0.0, 0.08, fract(u)) * (1.0 - smoothstep(0.92, 1.0, fract(u)));
  vec3 c = mix(band * mix(0.7, 1.0, edge), vec3(0.42, 0.4, 0.46), aa) * 0.95;
  // the rough crust outside the bands
  c = mix(c, vec3(0.2, 0.19, 0.19) * (0.8 + 0.4 * noise(q * 20.0)), smoothstep(0.45, 0.6, d));

  // DRUZY
  float lining = mix(0.02, 0.17, pow(hash(k * 2.3), 1.6));
  float cluster = smoothstep(0.3, 0.5, noise(q * 3.5 + k * 0.7));
  float inside = (1.0 - smoothstep(lining * 0.6, lining, d)) * mix(0.35, 1.0, cluster);
  if (inside > 0.0) {
    // points grow larger toward the cavity
    float near = 1.0 - smoothstep(0.0, lining, d);
    vec3 cc = vec3(0.0);
    float apex = 0.0;
    float h = 0.0;
    for (int i = 0; i < 2 * uOne; i++) {
      float big = float(i);
      float ap, hh;
      vec3 cd = druzy(q, mix(42.0, 15.0, big), k + 3.0 * big, ap, hh);
      float wgt = big > 0.5 ? near : 1.0 - near;
      cc += cd * wgt;
      apex += ap * wgt;
      if ((big > 0.5) == (near > 0.5)) h = hh;
    }
    cc = mix(cc, vec3(0.3, 0.2, 0.42), aa * 0.8);
    // light comes through the tips
    glow += cc * apex * apex * 0.07 * inside;
    // a few points flash as you pass them
    float glint = step(0.955, h) * pow(apex, 4.0) * pow(fract(h * 31.7 + uZ * 0.7), 16.0);
    glow += vec3(1.0, 0.95, 1.0) * glint * inside * (1.0 - aa) * 1.6;
    c = mix(c, cc, inside);
  }
  return c;
}

// LAMP
// a narrow headlamp: bright ahead, falling away to the sides and with distance
float falloff(vec3 p, vec3 eye, vec3 fwd) {
  vec3 v = p - eye;
  float dist = length(v);
  float cone = smoothstep(0.35, 0.95, dot(v / dist, fwd));
  return (0.3 + 0.7 * cone) / (1.0 + dist * dist * 0.2);
}

// CAMERA
// set once per pixel in main, read by the shading below
vec3 eye;
vec3 dir;
vec3 fwd;
vec3 light;
float spread;
vec3 fogC;

// SHADE
// one hit: a slice face, or the inside wall of its hole. the walk below only finds hits;
// all the material work happens here, for the few that show
vec3 shade(float k, float t0, float t1, float type) {
  float rot = hash(k) * TAU;
  vec4 w = zones(k);
  // face and wall both start from the hole edge where the ray meets the slice
  vec3 p0 = eye + dir * t0;
  vec2 q0 = spin(rot) * (p0.xy - path(k * S));
  float r0 = length(q0);
  float R0 = hole(k, q0 / max(r0, 1e-4));
  if (type < 0.5) {
    float fw0 = spread * t0;
    vec3 glow = vec3(0.0);
#ifdef PAPER
    vec3 c = grain(q0, k, fw0);
#else
    vec3 c = grain(q0, k, fw0);
    float crack = checks(q0, k, R0, fw0);
    if (w.x > 0.0) c = mix(c, roots(c, q0, k, R0, fw0), w.x);
    if (w.y > 0.0) c = mix(c, soil(q0, k, fw0), w.y);
    if (w.z > 0.0) c = mix(c, stone(q0, k, fw0), w.z);
    c *= mix(crack, 1.0, w.y * (1.0 - w.z) + w.w);
    if (w.w > 0.0) {
      vec3 gg = vec3(0.0);
      c = mix(c, geode(q0, k, R0, fw0, gg), w.w);
      glow += gg * w.w;
    }
    // FUNGUS
    // glowing specks in the cracks and along the lip, more of them deeper in the wood
    float life = (1.0 - w.y) * smoothstep(4.0, 14.0, k * S);
    if (life > 0.0) {
      vec2 cell = floor(q0 * 110.0);
      float hv = hash2(cell + k * 0.37);
      float nearLip = 1.0 - smoothstep(0.0, 0.18, r0 - R0);
      float spk = step(0.993, hv) * nearLip + step(0.86, hv) * (1.0 - crack);
      float size = min(1.0, 1.0 / (fw0 * 110.0 + 1e-4));
      spk *= smoothstep(0.5, 0.15, length(fract(q0 * 110.0) - 0.5) - fw0 * 55.0);
      glow += FUNGUS * spk * size * life * 0.7;
    }
#endif
    // shadow: does the lamp see this spot past the lip of the slice before
    float sh = 1.0;
    if (k * S - S > uZ) {
      vec3 tl = light - p0;
      float zb = k * S - S + T;
      vec3 ps = p0 + tl * ((zb - p0.z) / tl.z);
      float kp = k - 1.0;
      vec2 qs = spin(hash(kp) * TAU) * (ps.xy - path(kp * S));
      float rs = length(qs);
      float Rs = hole(kp, qs / max(rs, 1e-4));
      sh = 1.0 - 0.8 * smoothstep(-0.03, 0.05, rs - Rs);
    }
    // a soft bevel along the lip catches the lamp
    float lip = exp(-(r0 - R0) / (0.012 + fw0));
    vec3 l = normalize(light - p0);
    float fall = falloff(p0, eye, fwd);
    float diff = 0.35 + 0.65 * max(0.0, -l.z);
#ifdef PAPER
    vec3 lit = c * (0.5 + 0.6 * diff * mix(1.0, sh, 0.7)) + vec3(0.05) * lip * sh;
    return mix(vec3(0.1, 0.085, 0.075), lit, exp(-max(0.0, t0 - 1.2) * 0.24));
#else
    vec3 lipC = mix(vec3(1.0, 0.72, 0.45), vec3(0.85, 0.75, 1.0), w.w);
    vec3 lit = c * diff * sh * fall * 2.2 + lipC * lip * 0.9 * sh * fall;
    lit = mix(fogC, lit, exp(-max(0.0, t0 - 1.0) * 0.16));
    return lit + glow * exp(-t0 * 0.05);
#endif
  }

  // the inside of the cut, lit at a graze
  vec3 p1 = eye + dir * t1;
  vec2 q1 = spin(rot) * (p1.xy - path(k * S));
  float r1 = length(q1);
  float tw = mix(t0, t1, clamp((R0 - r0) / max(r1 - r0, 1e-4), 0.0, 1.0));
  vec3 pw = eye + dir * tw;
  vec2 qw = spin(rot) * (pw.xy - path(k * S));
  vec2 nrm = -normalize(qw);
  vec3 l = normalize(light - pw);
  float graze = max(0.0, dot(vec3(spin(-rot) * nrm, 0.0), l));
  float fib = noise(vec2(atan(qw.y, qw.x) * 40.0, k));
  float fall = falloff(pw, eye, fwd);
#ifdef PAPER
  vec3 lit = vec3(0.96, 0.94, 0.9) * (0.72 + 0.28 * graze);
  return mix(vec3(0.1, 0.085, 0.075), lit, exp(-max(0.0, tw - 1.2) * 0.24));
#else
  vec3 c = mix(vec3(0.28, 0.16, 0.08), vec3(0.5, 0.32, 0.18), fib);
  c = mix(c, vec3(0.2, 0.14, 0.1) * (0.7 + 0.6 * fib), w.y);
  c = mix(c, vec3(0.36, 0.33, 0.32) * (0.7 + 0.6 * fib), w.z);
  vec3 wglow = vec3(0.0);
  if (w.w > 0.0) {
    // the inner wall is all crystal: deep violet, now and then a spark
    float hc = hash(floor(atan(qw.y, qw.x) * 40.0) + k * 0.71);
    vec3 cc = mix(vec3(0.16, 0.05, 0.26), vec3(0.6, 0.5, 0.8), fib * fib) * (0.6 + 0.5 * hc);
    c = mix(c, cc, w.w);
    float spark = step(0.985, hc) * fib * pow(fract(hc * 23.1 + uZ * 0.6), 20.0);
    wglow = (cc * 0.05 + vec3(1.0, 0.95, 1.0) * spark) * w.w;
  }
  vec3 lit = c * (0.25 + 1.2 * graze) * fall * 1.6;
  lit = mix(fogC, lit, exp(-max(0.0, tw - 1.0) * 0.16));
  return lit + wglow * exp(-tw * 0.05);
#endif
}

void main() {
  vec2 frag = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float pixel = 1.0 / uRes.y * 1.25;

  // rides the path, looking a little ahead along it
  eye = vec3(path(uZ), uZ);
  vec3 ahead = vec3(path(uZ + 4.0), uZ + 4.0);
  fwd = normalize(ahead - eye);
  vec3 side = normalize(cross(vec3(0.0, 1.0, 0.0), fwd));
  vec3 up = cross(fwd, side);
  float focal = 1.15 - 0.12 * uSpeed;
  vec2 sp = spin(uRoll) * frag;
  dir = normalize(fwd * focal + side * sp.x + up * sp.y);
  vec3 d = dir;
  spread = pixel / focal;
  light = eye + up * 0.18 - side * 0.08;
  // far away things fade into this; black, except a faint violet down in the geode
  fogC = vec3(0.1, 0.05, 0.17) * zones(floor(uZ / S) + 30.0).w;
#ifdef PAPER
  fogC = vec3(0.1, 0.085, 0.075);
#endif

  // WALK
  // front to back through the slices, keeping the first three hits and how much each shows
  vec4 hits[3]; // k, t0, t1, type
  float hw[3]; // how much of each shows
  int n = 0;
  float trans = 1.0;
  float tHit = 1e4;
  float k = floor((uZ - T) / S) + 1.0;

  for (int i = 0; i < uSteps; i++) {
    float z0 = max(k * S, uZ + 0.001);
    float z1 = k * S + T;
    float t0 = (z0 - eye.z) / d.z;
    float t1 = (z1 - eye.z) / d.z;
    float rot = hash(k) * TAU;
    // front and back of the slice: how far past the hole edge the ray is at each
    float cov[2];
    for (int e = 0; e < 2 * uOne; e++) {
      float te = e == 0 ? t0 : t1;
      vec2 q = spin(rot) * (eye.xy + d.xy * te - path(k * S));
      float r = length(q);
      float fw = spread * te;
      cov[e] = smoothstep(-fw, fw, r - hole(k, q / max(r, 1e-4)));
    }
    float face = cov[0];
    float wall = (1.0 - face) * cov[1];

    if (face > 0.001) {
      hits[n] = vec4(k, t0, t1, 0.0);
      hw[n] = trans * face;
      trans *= 1.0 - face;
      n++;
    }
    if (wall > 0.001 && n < 3) {
      hits[n] = vec4(k, t0, t1, 1.0);
      hw[n] = trans * wall;
      trans *= 1.0 - wall;
      n++;
    }
    if (tHit > 1e3 && trans < 0.5) tHit = t0;
    if (trans < 0.01 || n > 2) break;
    k += 1.0;
  }

  // one call site, so the shading is compiled once
  vec3 col = trans * fogC;
  for (int i = 0; i < n; i++) {
    col += hw[i] * shade(hits[i].x, hits[i].y, hits[i].z, hits[i].w);
  }

#ifndef PAPER
  // MOTES
  // dust hangs in the hollow; the lamp only finds it near the middle of its beam.
  // deeper down it is spores, then crystal grit
  vec4 here = zones(floor(uZ / S));
  vec3 moteC = mix(vec3(1.0, 0.85, 0.62), vec3(0.75, 1.0, 0.8), here.x * (1.0 - here.z));
  moteC = mix(moteC, vec3(0.9, 0.8, 1.0), here.w);
  float base = floor(uZ / ${MOTE_GAP_M.toFixed(2)});
  for (int j = 0; j < uMotes; j++) {
    float zj = (base + 1.0 + float(j)) * ${MOTE_GAP_M.toFixed(2)};
    float t = (zj - eye.z) / d.z;
    if (t > tHit) break;
    vec3 p = eye + d * t;
    vec2 g = (p.xy - path(zj)) / 0.2;
    vec2 cell = floor(g);
    float h = hash2(cell + zj * 1.7);
    if (h < 0.6) continue;
    vec2 o = vec2(hash2(cell + 3.1 + zj), hash2(cell + 7.7 + zj)) * 0.8 + 0.1;
    float dd = length(fract(g) - o) * 0.2;
    float size = 0.0025 * (0.6 + h);
    float fw = spread * t;
    float a = smoothstep(size + fw, 0.0, dd) * (size * size) / ((size + fw) * (size + fw));
    float cone = smoothstep(0.75, 0.99, dot(normalize(p - eye), fwd));
    col += moteC * a * cone * 1.6 / (1.0 + t * t * 0.15);
  }
#endif

  // VIGNETTE + GRAIN
#ifdef PAPER
  float v = 1.0 - 0.18 * dot(frag, frag);
#else
  float v = 1.0 - 0.6 * dot(frag, frag);
  v *= v;
#endif
  col *= v;
  col += (hash2(gl_FragCoord.xy) - 0.5) / 255.0 * 2.0;
  outColor = vec4(pow(col, vec3(1.0 / 1.1)), 1.0);
}`;

type Pass = { prog: WebGLProgram; u: Record<string, WebGLUniformLocation | null> };

export class Hollow {
  private gl: WebGL2RenderingContext;
  private vao: WebGLVertexArrayObject;
  private pass: Pass;
  private shaders: WebGLShader[] = [];
  private linked = false;
  private parallel: boolean;

  private raf = 0;
  private last = 0;
  private visible = false;
  private sized = false;
  private reducedMotion: boolean;
  private cleanups: (() => void)[] = [];

  // MOTION
  // input pushes a target speed that coasts down; the real speed eases after it
  private z = 0;
  private speed = 0;
  private target = INTRO_SPEED;
  private roll = 0;
  private lean = 0;
  private dragY = 0;
  private dragging = -1;

  onDepth: (z: number) => void = () => {};

  constructor(private canvas: HTMLCanvasElement) {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    this.reducedMotion = mq.matches;
    if (this.reducedMotion) this.target = 0;
    const onMotion = () => (this.reducedMotion = mq.matches);
    mq.addEventListener("change", onMotion);

    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("webgl2 unavailable");
    if (!new URLSearchParams(location.search).has("gl") && software(gl)) {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      mq.removeEventListener("change", onMotion);
      throw new Error("software gl");
    }
    this.gl = gl;
    this.parallel = !!gl.getExtension("KHR_parallel_shader_compile");
    this.pass = this.compile(FS);
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("no vao");
    this.vao = vao;

    const ro = new ResizeObserver(() => {
      this.sized = false;
      this.wake();
    });
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => {
      this.visible = e.isIntersecting;
      this.wake();
    });
    io.observe(canvas);
    const onVisibility = () => {
      this.last = 0;
      this.wake();
    };
    document.addEventListener("visibilitychange", onVisibility);
    const opts = { passive: true };
    addEventListener("wheel", this.wheel, opts);
    canvas.addEventListener("pointerdown", this.down, opts);
    canvas.addEventListener("pointermove", this.move, opts);
    canvas.addEventListener("pointerup", this.up, opts);
    canvas.addEventListener("pointercancel", this.up, opts);
    addEventListener("keydown", this.key);
    this.cleanups.push(
      () => mq.removeEventListener("change", onMotion),
      () => ro.disconnect(),
      () => io.disconnect(),
      () => document.removeEventListener("visibilitychange", onVisibility),
      () => removeEventListener("wheel", this.wheel),
      () => canvas.removeEventListener("pointerdown", this.down),
      () => canvas.removeEventListener("pointermove", this.move),
      () => canvas.removeEventListener("pointerup", this.up),
      () => canvas.removeEventListener("pointercancel", this.up),
      () => removeEventListener("keydown", this.key),
    );
  }

  // starts the fall from this deep, settled
  jump(z: number) {
    this.z = Math.max(0, z);
    this.target = this.reducedMotion ? 0 : INTRO_SPEED * 0.5;
    this.wake();
  }

  // INPUT
  push(mps: number) {
    this.target = Math.max(-MAX_SPEED, Math.min(MAX_SPEED, this.target + mps));
    this.wake();
  }

  private wheel = (e: WheelEvent) => {
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    this.push(px * WHEEL_GAIN);
  };

  private down = (e: PointerEvent) => {
    this.dragging = e.pointerId;
    this.dragY = e.clientY;
    this.canvas.setPointerCapture?.(e.pointerId);
  };

  private move = (e: PointerEvent) => {
    if (e.pointerId !== this.dragging) return;
    const dy = this.dragY - e.clientY;
    this.dragY = e.clientY;
    this.push(dy * DRAG_GAIN);
  };

  private up = (e: PointerEvent) => {
    if (e.pointerId === this.dragging) this.dragging = -1;
  };

  private key = (e: KeyboardEvent) => {
    const k = e.key;
    // space still presses a focused link or button
    if (k === " " && e.target instanceof HTMLElement && e.target.closest("a, button")) return;
    if (k === "ArrowDown" || k === "PageDown" || k === " ") this.push(KEY_PUSH);
    else if (k === "ArrowUp" || k === "PageUp") this.push(-KEY_PUSH);
    else return;
    e.preventDefault();
  };

  // LOOP
  private wake() {
    if (!this.raf && this.visible && !document.hidden) this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number) => {
    this.raf = 0;
    if (!this.visible || document.hidden) return;
    const gl = this.gl;
    if (!this.linked) {
      if (this.parallel && !gl.getProgramParameter(this.pass.prog, 0x91b1)) {
        this.wake();
        return;
      }
      this.link();
    }
    const dt = this.last ? Math.min(MAX_DT_S, (now - this.last) / 1000) : 0;
    this.last = now;
    if (!this.sized) this.resize();
    this.step(dt);
    this.draw();
    if (this.moving()) this.wake();
    else this.last = 0;
  };

  private step(dt: number) {
    const coast = this.reducedMotion ? 0.25 : COAST_S;
    this.target *= Math.exp(-dt / coast);
    // never back out above the first slice
    if (this.z < 0.4 && this.target < 0) this.target *= Math.exp(-dt / 0.15);
    this.speed += (this.target - this.speed) * (1 - Math.exp(-dt / EASE_S));
    this.z = Math.max(0, this.z + this.speed * dt);
    if (this.z === 0 && this.speed < 0) this.speed = 0;
    // a slow lean into the fall, never a snap
    this.lean = this.reducedMotion ? 0 : this.speed * 0.025 + this.z * 0.012;
    this.roll += (this.lean - this.roll) * (1 - Math.exp(-dt / 0.8));
    if (Math.abs(this.speed) < REST_SPEED && Math.abs(this.target) < REST_SPEED) {
      this.speed = 0;
      this.target = 0;
    }
    this.onDepth(this.z);
  }

  private moving() {
    return this.speed !== 0 || this.target !== 0 || Math.abs(this.roll - this.lean) > 1e-4;
  }

  private draw() {
    const gl = this.gl;
    const u = this.pass.u;
    gl.useProgram(this.pass.prog);
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(u.uZ, this.z);
    gl.uniform1f(u.uRoll, this.roll);
    gl.uniform1f(u.uSpeed, Math.min(1, Math.abs(this.speed) / MAX_SPEED));
    gl.uniform1i(u.uSteps, STEPS);
    gl.uniform1i(u.uMotes, MOTES);
    gl.uniform1i(u.uOne, 1);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const w = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.gl.viewport(0, 0, w, h);
    }
    this.sized = true;
  }

  // SHADER
  private compile(fs: string): Pass {
    const gl = this.gl;
    const prog = gl.createProgram();
    if (!prog) throw new Error("no program");
    for (const [type, src] of [
      [gl.VERTEX_SHADER, VS],
      [gl.FRAGMENT_SHADER, fs],
    ] as const) {
      const sh = gl.createShader(type);
      if (!sh) throw new Error("no shader");
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      gl.attachShader(prog, sh);
      this.shaders.push(sh);
    }
    gl.linkProgram(prog);
    return { prog, u: {} };
  }

  private link() {
    const gl = this.gl;
    const p = this.pass;
    if (!gl.getProgramParameter(p.prog, gl.LINK_STATUS)) {
      const log = this.shaders.map((sh) => gl.getShaderInfoLog(sh)).join("\n");
      throw new Error((gl.getProgramInfoLog(p.prog) ?? "link") + log);
    }
    for (const sh of this.shaders) gl.deleteShader(sh);
    this.shaders.length = 0;
    for (const name of ["uRes", "uZ", "uRoll", "uSpeed", "uSteps", "uMotes", "uOne"])
      p.u[name] = gl.getUniformLocation(p.prog, name);
    this.linked = true;
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.cleanups.forEach((fn) => fn());
    this.cleanups.length = 0;
    const gl = this.gl;
    gl.deleteProgram(this.pass.prog);
    gl.deleteVertexArray(this.vao);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

function software(gl: WebGL2RenderingContext) {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
  return /swiftshader|llvmpipe|software|basic render/i.test(name);
}
