import { COLORS, SCENE } from "./scene";

// SHADERS
// the whole desert is one fullscreen pass: sky, dunes, road, poles, traffic and the mirage
// are drawn analytically per pixel, so there is no geometry and nothing to upload but uniforms

export { SCENE };

const hex = (h: string) => {
  const n = parseInt(h.slice(1), 16);
  const c = (s: number) => (((n >> s) & 255) / 255).toFixed(3);
  return `vec3(${c(16)}, ${c(8)}, ${c(0)})`;
};

const f = (n: number) => n.toFixed(4);

const PALETTE = Object.entries(COLORS)
  .map(([name, value]) => `const vec3 ${name} = ${hex(value)};`)
  .join("\n");

export const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const NOISE = `
float hash(float n) { return fract(sin(n * 127.1) * 43758.5453); }
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(float x) {
  float i = floor(x);
  float t = fract(x);
  t = t * t * (3.0 - 2.0 * t);
  return mix(hash(i), hash(i + 1.0), t);
}
float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 t = fract(p);
  t = t * t * (3.0 - 2.0 * t);
  float a = hash2(i);
  float b = hash2(i + vec2(1.0, 0.0));
  float c = hash2(i + vec2(0.0, 1.0));
  float d = hash2(i + vec2(1.0, 1.0));
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}
// a hash without sin for the clouds. sin of large numbers is computed differently by different
// compiles of the same shader, and the driver can switch between them from frame to frame,
// which made the clouds jump between two places; plain arithmetic agrees to the bit
float cloudHash(float n) {
  n = fract(n * 0.1031);
  n *= n + 33.33;
  n *= n + n;
  return fract(n);
}
const float CLOUD_SEED = 19.0; // picks the layout of the streaks
float cloudNoise(float x) {
  float i = floor(x);
  float t = fract(x);
  t = t * t * (3.0 - 2.0 * t);
  return mix(cloudHash(i), cloudHash(i + 1.0), t);
}
float cloudNoise2(vec2 p) {
  vec2 i = floor(p);
  vec2 t = fract(p);
  t = t * t * (3.0 - 2.0 * t);
  float n = i.x + i.y * 57.0;
  return mix(mix(cloudHash(n), cloudHash(n + 1.0), t.x), mix(cloudHash(n + 57.0), cloudHash(n + 58.0), t.x), t.y);
}`;

const S = SCENE;
// the telegraph line, as posts() and shadowOf() take it
const POLES = `uPoleX, ${f(S.POLE_SPACING_M)}, ${f(S.POLE_PHASE_M)}, ${f(S.POLE_H)}, ${f(S.POLE_W)}`;

export const TRAFFIC_N = 3;

export const SCENE_FS = `#version 300 es
precision highp float;

uniform vec2      uRes;
uniform float     uAspect;
uniform float     uZoom;
uniform float     uHor;
uniform float     uVp;
uniform float     uTime;
uniform float     uTravel;
uniform float     uPuddle;
uniform float     uCam;
uniform float     uShimmer;
uniform vec2      uSun;
uniform float     uTop;
uniform float     uPoleX;
uniform vec4      uTraffic[${TRAFFIC_N + 1}];
// loop counts come in as uniforms so the compiler keeps one copy of each loop body instead of
// unrolling it, which keeps the link short: (triples, traffic and wheels, rows, passes)
uniform ivec4     uLoop;
uniform float     uReveal;
uniform vec4      uView;
// the zoom the view is framed with, and half its width: a larger render such as the still
// plate passes the view's, so clouds and the water sheet come out the same
uniform vec2      uFrame;

out vec4 outColor;

${PALETTE}
${NOISE}

const float CAM_H = ${f(S.CAM_H)};
const float ROAD_HALF = ${f(S.ROAD_HALF)};
const float PX_FLOOR = 1e-4;
// the long lens magnifies the road; the sky keeps its size and the dunes meet them halfway
const float SKY_K = ${f(S.LENS / S.SKY_LENS)};
const float DUNE_K = ${f(Math.sqrt(S.LENS / S.SKY_LENS))};

float px;
// the view before the heat bends it: anything near is drawn from this, steady
vec2 p0;
// where the clouds are drawn from, in sky units: the unshimmered view, so heat never moves them
vec2 cloudP;

// how much of the shimmer reaches something z metres off
float steady(float z) {
  return smoothstep(${f(S.STEADY_M)}, ${f(S.STEADY_M * 1.6)}, z);
}

// coverage of a band |d| < hw, kept honest when it is thinner than a pixel
float band(float d, float hw, float aa) {
  float w = max(hw, aa * 0.5);
  return clamp((w - abs(d)) / aa + 0.5, 0.0, 1.0) * (hw / w);
}

float fogAt(float z) {
  return 1.0 - exp(-z * ${f(S.FOG_PER_M)});
}

// SKY
vec3 sky(vec2 p) {
  float h = max(p.y, 0.0);
  vec3 c = mix(HAZE, SKY_LOW, smoothstep(0.0, 0.1, h));
  c = mix(c, SKY_MID, smoothstep(0.08, 0.34, h));
  c = mix(c, SKY_TOP, smoothstep(0.26, 0.7, h));

  // the sun: a flat disc in flat rings of glow, printed rather than blown out
  float d = length(p - uSun);
  c = mix(c, SUN_GLOW, 0.45 * exp(-d * 5.0));
  c = mix(c, SUN, 0.12 * smoothstep(0.15 + px, 0.15 - px, d));
  c = mix(c, SUN, 0.2 * smoothstep(0.095 + px, 0.095 - px, d));
  c = mix(c, SUN, smoothstep(0.052 + px, 0.052 - px, d));

  // CLOUDS
  // a few long flat streaks, lit on top and shaded under, drifting very slowly
  for (int i = 0; i < uLoop.x; i++) {
    float fi = float(i);
    float y0 = uTop * (0.34 + 0.17 * fi) + 0.02 * cloudHash(fi * 3.1 + 0.5);
    float x = cloudP.x * (1.2 + 0.4 * fi) + uTime * 0.006 * (1.0 + fi) + fi * 13.7 + CLOUD_SEED;
    float n = 0.65 * cloudNoise(x * 2.1) + 0.35 * cloudNoise(x * 5.3 + 2.0);
    float thick = 0.017 * sqrt(uFrame.x) * (1.0 - 0.3 * fi) * smoothstep(0.52, 0.85, n);
    float y = cloudP.y - y0 - (n - 0.5) * 0.02;
    float inside = smoothstep(px, -px, abs(y) - thick) * smoothstep(0.0, 2.0 * px, thick);
    float lit = smoothstep(-0.25 * thick - px, -0.25 * thick + px, y);
    c = mix(c, mix(CLOUD_SHADE, CLOUD_LIT, lit), inside * 0.92);
  }
  return c;
}

// DUNES
// rows of dunes on the horizon: a steep slip face in shadow, a long lit back.
// each row is two ridges of uneven spacing and height laid over each other, so no two
// dunes match; the line between light and shade bends down from the crest

// one ridge at x: height, place across its cell, crest position, crest height
vec4 ridge(float x, float amp, float seed, out float cell) {
  x += 0.8 * noise(x * 0.29 + seed);
  cell = floor(x);
  float s = fract(x);
  float k = 0.18 + 0.5 * hash(cell + seed);
  float a = amp * (0.3 + 0.7 * hash(cell * 1.7 + seed));
  // now and then a dune is only a low swell
  a *= hash(cell * 3.1 + seed) < 0.22 ? 0.35 : 1.0;
  float backPow = 1.0 + 1.1 * hash(cell * 5.3 + seed);
  float prof = s < k ? 1.0 - pow(1.0 - s / k, 1.7) : 1.0 - pow((s - k) / (1.0 - k), backPow);
  return vec4(a * prof, s, k, a);
}

vec3 dunes(vec2 p, vec3 c) {
  for (int i = 0; i < uLoop.x; i++) {
    float fi = float(i);
    float freq = 1.5 + 1.6 * fi;
    float amp = (0.105 - 0.03 * fi) * (1.0 - 0.15 * fi);
    float x = p.x * freq + fi * 31.7 + uCam * (0.002 + 0.004 * fi);
    float swell = amp * 0.35 * noise(x * 0.37 + fi);
    if (p.y > amp + swell + px) continue;
    float cellA;
    float cellB;
    vec4 ra = ridge(x, amp, fi * 7.0, cellA);
    vec4 rb = ridge(x * 1.63 + 0.5, amp * 0.62, fi * 7.0 + 3.0, cellB);
    bool front = rb.x > ra.x;
    vec4 r = front ? rb : ra;
    float cell = front ? cellB + 101.0 : cellA;
    float h = r.x + swell;
    if (p.y > h + px) continue;
    float cover = smoothstep(h + px, h - px, p.y);

    // where the slip face ends, a soft brushed edge
    float v = clamp(p.y / max(r.w + swell, 1e-3), 0.0, 1.0);
    float wob = 0.03 * (noise(p.y * 60.0 + cell * 5.0) - 0.5);
    float bend = 0.45 + 0.4 * hash(cell * 2.3);
    float term = r.z * (0.25 + 0.75 * pow(v, bend)) + wob;
    float lit = smoothstep(term - 0.018, term + 0.018, r.y);
    vec3 litC = i == 0 ? FAR_LIT : i == 1 ? MID_LIT : NEAR_LIT;
    vec3 shadeC = i == 0 ? FAR_SHADE : i == 1 ? MID_SHADE : NEAR_SHADE;
    // a third flat tone where the back turns away again, toward the next trough
    float back = smoothstep(0.76, 0.82, r.y + 0.35 * (1.0 - v) + wob);
    vec3 col = mix(shadeC, mix(litC, mix(litC, shadeC, 0.4), back), lit);
    // lighter toward the crest on the lit back
    col = mix(col, HAZE, lit * 0.18 * v);
    // the clouds' shadows slide across them, large and faint
    float cs = smoothstep(0.42, 0.82, cloudNoise2(vec2(p.x * 1.4 + uTime * 0.008 + fi * 5.0, fi * 3.0)));
    col = mix(col, col * SHADOW, 0.55 * cs);
    // the far rows fade into the heat
    col = mix(col, HAZE, (0.42 - 0.14 * fi) + 0.3 * (1.0 - smoothstep(0.0, 0.03, p.y)));
    c = mix(c, col, cover);
  }
  return c;
}

vec3 above(vec2 p) {
  float px0 = px;
  px = px0 / SKY_K;
  vec3 c = sky(p / SKY_K);
  px = px0 / DUNE_K;
  c = dunes(p / DUNE_K, c);
  px = px0;
  return c;
}

// POSTS
// one row of posts, poles or markers, at x metres from the centre line. only the post
// whose depth matches this column and its neighbours can cover the pixel. eye and sq place
// heights on screen: the mirror draws the same row from an eye below the road, stretched
void posts(vec2 p, float eye, float sq, float xw, float spacing, float phase, float h, float w, bool pole, inout vec3 c) {
  float ax = xw - uCam;
  if (p.x * ax <= 0.0) return;
  float za = ax / p.x;
  float kc = floor((za + uTravel - phase) / spacing);
  for (int jj = 0; jj < uLoop.x; jj++) {
    float zk = (kc + float(1 - jj)) * spacing + phase - uTravel;
    if (zk < 1.5) continue;
    float inv = 1.0 / zk;
    vec2 q = eye > 0.0 ? mix(p0, p, steady(zk)) : p;
    float base = -eye * inv;
    float top = (sq * h - eye) * inv;
    if (q.y < base - px || q.y > top + 0.4 * inv + px) continue;
    float dx = q.x - ax * inv;
    float up = clamp((q.y - base) / (top - base), 0.0, 1.0);
    float hw = 0.5 * w * inv * (pole ? 1.0 - 0.3 * up : 1.0);
    float cov = band(dx, hw, px) * band(q.y - 0.5 * (top + base), 0.5 * (top - base), px);
    float lit = smoothstep(0.2, 0.7, dx / max(hw, px));
    vec3 col;
    if (pole) {
      col = mix(POLE_DARK, POLE_LIT, lit * 0.8);
      // crossarm and insulators
      float ay = (sq * ${f(S.ARM_Y)} - eye) * inv;
      float vi = sq * inv;
      float arm = band(dx, ${f(S.ARM_HALF)} * inv, px) * band(q.y - ay, 0.09 * vi, px);
      float ix = abs(abs(dx) - 0.82 * ${f(S.ARM_HALF)} * inv);
      float ins = band(ix, 0.07 * inv, px) * band(q.y - ay - 0.2 * vi, 0.12 * vi, px);
      float ix2 = abs(abs(dx) - 0.32 * ${f(S.ARM_HALF)} * inv);
      ins = max(ins, band(ix2, 0.07 * inv, px) * band(q.y - ay - 0.2 * vi, 0.12 * vi, px));
      float extra = max(arm, ins);
      col = mix(col, POLE_DARK, extra * (1.0 - cov));
      cov = max(cov, extra);
    } else {
      col = mix(POST_SHADE, POST_BODY, lit);
      col = mix(col, REFLECTOR, step(0.8, up) * step(up, 0.92));
    }
    col = mix(col, HAZE, fogAt(zk) * 0.9);
    c = mix(c, col, cov);
  }
}

// DUST DEVIL
// a thin spinning column far out on the plain, lit on the sun side and leaning with the wind
// over a dusty skirt. each one lives a while, fades, and turns up somewhere else. it is far
// enough out that the heat bends it, and the water band shows it upside down
const float DEVIL_LIFE_S = ${f(S.DEVIL_LIFE_S)};

void devil(vec2 p, float eye, float sq, inout vec3 c) {
  // two take turns, half a life apart, so one is always forming as the other fades
  for (int slot = 0; slot < uLoop.w; slot++) {
    float sl = float(slot);
    float life = uTime / DEVIL_LIFE_S + 0.45 + 0.5 * sl;
    float k = floor(life) * 2.0 + sl;
    float f = fract(life);
    float alive = smoothstep(0.0, 0.2, f) * smoothstep(1.0, 0.75, f);
    if (alive <= 0.0) continue;
    float z = 460.0 + 180.0 * cloudHash(k * 2.3 + 1.0);
    float wander = (cloudHash(k * 4.1 + 9.0) - 0.5) * 50.0;
    // both out on the left half of the plain, between the title and the road, each keeping
    // to a share of its distance so it sits the same way across the view
    float side = -z * mix(sl > 0.5 ? 0.045 : 0.068, sl > 0.5 ? 0.062 : 0.09, cloudHash(k * 1.7 + 3.0));
    float xw = side + (f - 0.5) * wander * 0.25;
    float hgt = 24.0 + 10.0 * cloudHash(k * 3.1 + 5.0);
    float h = (p.y * z + eye) / sq;
    if (h < -1.0 || h > hgt + 1.0) continue;
    float xm = p.x * z - (xw - uCam);
    if (abs(xm) > 22.0) continue;
    float u = clamp(h / hgt, 0.0, 1.0);
    // it leans downwind and snakes as it turns
    float axis = 6.0 * u * u + 1.0 * sin(h * 0.2 - uTime * 0.9 + sl * 2.0);
    float r = mix(1.1, 4.6, pow(u, 1.4));
    float d = (xm - axis) / r;
    float body = smoothstep(1.0, 0.55, abs(d)) * smoothstep(hgt, hgt * 0.6, h) * smoothstep(-0.3, 0.8, h);
    // bands of dust winding round it
    float wind = 0.5 + 0.5 * sin(h * 0.8 - uTime * 4.0 + d * 1.6);
    float lit = smoothstep(-0.4, 0.6, d);
    vec3 col = mix(mix(SAND_RIPPLE, SHADOW, 0.45), mix(SAND_FAR, SUN, 0.45), lit);
    float skirt = smoothstep(1.0, 0.25, length(vec2((xm - sin(-uTime * 0.9)) / 9.0, (h - 0.8) / 3.0)));
    float a = max(body * (0.65 + 0.3 * wind), skirt * 0.7) * alive;
    col = mix(col, HAZE, fogAt(z) * 0.2);
    c = mix(c, col, a * 0.9);
  }
}

// HAWK
// a small dark bird circling high on the left, banking into its turns. now and then it glides
// off and comes back. the sky holds still, so it never wavers
void hawk(vec2 p, inout vec3 c) {
  float top = uTop * SKY_K;
  float t = uTime;
  float cyc = fract(t / ${f(S.HAWK_CYCLE_S)});
  float away = smoothstep(0.55, 0.72, cyc) * smoothstep(0.98, 0.82, cyc);
  float a = t * 0.24;
  // the loop breathes: wider and narrower, higher and lower
  float rx = 0.06 * (0.8 + 0.3 * sin(t * 0.053));
  float ry = rx * (0.22 + 0.08 * sin(t * 0.071));
  vec2 ctr = vec2(-0.13 + 0.03 * sin(t * 0.031), top * (0.5 + 0.06 * sin(t * 0.029)));
  ctr += away * vec2(-0.5, 0.05);
  vec2 q = p - ctr - vec2(rx * cos(a), ry * sin(a));
  float span = 0.011;
  if (dot(q, q) > span * span) return;
  // across the view the whole span shows; turning toward or away from us it foreshortens
  float across = abs(sin(a));
  // it banks into the turn, harder on some laps than others
  float bank = (0.2 + 0.35 * (0.5 + 0.5 * sin(t * 0.11))) * cos(a);
  q = mat2(cos(bank), -sin(bank), sin(bank), cos(bank)) * q / span;
  q.x /= mix(0.45, 1.0, across);
  // FLAPS
  // every few seconds two or three beats, then a long glide
  float beatT = mod(t, ${f(S.HAWK_FLAP_S)});
  float burst = smoothstep(0.0, 0.1, beatT) * smoothstep(1.3, 1.1, beatT);
  float flap = burst * sin(beatT * 6.2832 * 2.2);
  vec2 w = vec2(abs(q.x), q.y);
  // each wing: an inner arm up to the wrist, then the hand to the tip
  vec2 b0 = vec2(0.22, 0.07 + 0.16 * flap);
  vec2 b1 = vec2(0.5 - 0.08 * abs(flap), 0.32 * flap);
  float s0 = clamp(dot(w, b0) / dot(b0, b0), 0.0, 1.0);
  float d0 = length(w - b0 * s0) - mix(0.06, 0.035, s0);
  vec2 e = b1 - b0;
  float s1 = clamp(dot(w - b0, e) / dot(e, e), 0.0, 1.0);
  float d1 = length(w - b0 - e * s1) - mix(0.035, 0.012, s1);
  float body = length(vec2(q.x / 0.05, (q.y + 0.03) / 0.11)) - 1.0;
  float d = min(min(d0, d1), body * 0.05);
  float aa = px / span;
  float cov = smoothstep(aa, -aa, d);
  c = mix(c, mix(POLE_DARK, SKY_MID, 0.3), cov * 0.9);
}

// VEHICLES
// small low-poly cars cast through the same camera: a bevelled body, a cab with a raked
// screen, a box on the truck, and four wheels. each face is shaded flat by the way it turns:
// the tops lighter, the sides a shade darker than the ends. kind 0 a sedan from behind, 1 a
// sedan, 2 a pickup, 3 a small box truck coming at us. far off the heat drowns their wheels
// in the mirage, so they float over their reflection
const float SINK_PER_M = 0.007;
const float R2 = 0.70710678;

vec3 tint(float t) {
  return t < 0.5 ? TINT_A : t < 1.5 ? TINT_B : t < 2.5 ? TINT_C : TINT_D;
}

float sinkAt(float z) {
  return max(0.0, z - ${f(S.FLOAT_M)}) * SINK_PER_M;
}

// HULLS
// a ray against a few flat faces: clip it to the inside of each, n.x <= w. nn is the face it
// enters through, span.xy the stretch inside and span.z the slope of the face it leaves by,
// which gives how far inside the outline the entry lies
void clip(vec3 o, vec3 d, vec3 n, float w, inout vec3 span, inout vec3 nn) {
  float dn = dot(n, d);
  float s = w - dot(n, o);
  if (dn < -1e-6) {
    float t = s / dn;
    if (t > span.x) {
      span.x = t;
      nn = n;
    }
  } else if (dn > 1e-6) {
    float t = s / dn;
    if (t < span.y) span.yz = vec2(t, dn);
  } else if (s < 0.0) span.y = -1.0;
}

// a block from lo to hi with its top edges and upright corners bevelled by ch: where the ray
// enters, and how far that point lies inside the outline
vec2 blockHit(vec3 o, vec3 d, vec3 lo, vec3 hi, float ch, out vec3 nn) {
  vec3 span = vec3(0.0, 1e9, 1.0);
  nn = vec3(0.0, 0.0, -1.0);
  vec3 n6 = vec3(R2, R2, 0.0);
  vec3 n7 = vec3(-R2, R2, 0.0);
  vec3 n8 = vec3(0.0, R2, R2);
  vec3 n9 = vec3(0.0, R2, -R2);
  vec3 n10 = vec3(R2, 0.0, R2);
  vec3 n11 = vec3(-R2, 0.0, R2);
  vec3 n12 = vec3(R2, 0.0, -R2);
  vec3 n13 = vec3(-R2, 0.0, -R2);
  float w6 = R2 * (hi.x + hi.y - ch);
  float w7 = R2 * (-lo.x + hi.y - ch);
  float w8 = R2 * (hi.y + hi.z - ch);
  float w9 = R2 * (hi.y - lo.z - ch);
  float w10 = R2 * (hi.x + hi.z - ch);
  float w11 = R2 * (-lo.x + hi.z - ch);
  float w12 = R2 * (hi.x - lo.z - ch);
  float w13 = R2 * (-lo.x - lo.z - ch);
  clip(o, d, vec3(1.0, 0.0, 0.0), hi.x, span, nn);
  clip(o, d, vec3(-1.0, 0.0, 0.0), -lo.x, span, nn);
  clip(o, d, vec3(0.0, 1.0, 0.0), hi.y, span, nn);
  clip(o, d, vec3(0.0, -1.0, 0.0), -lo.y, span, nn);
  clip(o, d, vec3(0.0, 0.0, 1.0), hi.z, span, nn);
  clip(o, d, vec3(0.0, 0.0, -1.0), -lo.z, span, nn);
  clip(o, d, n6, w6, span, nn);
  clip(o, d, n7, w7, span, nn);
  clip(o, d, n8, w8, span, nn);
  clip(o, d, n9, w9, span, nn);
  clip(o, d, n10, w10, span, nn);
  clip(o, d, n11, w11, span, nn);
  clip(o, d, n12, w12, span, nn);
  clip(o, d, n13, w13, span, nn);
  if (span.x >= span.y || span.x <= 0.0) return vec2(1e9, 0.0);
  // the entry point lies this far inside the face it would leave by
  return vec2(span.x, span.z * (span.y - span.x));
}

// a cab from y0 to y1: its screen leans back r0 from c0, its rear window forward r1 from
// c1, and its sides lean in from wb to wt
vec2 cabHit(vec3 o, vec3 d, float y0, float y1, float c0, float r0, float c1, float r1, float wb, float wt, out vec3 nn) {
  float hgt = y1 - y0;
  vec3 nf = normalize(vec3(0.0, r0, -hgt));
  vec3 nb = normalize(vec3(0.0, r1, hgt));
  vec3 ns = normalize(vec3(hgt, wb - wt, 0.0));
  vec3 nt = normalize(vec3(-hgt, wb - wt, 0.0));
  float wf = dot(nf, vec3(0.0, y0, c0));
  float wbk = dot(nb, vec3(0.0, y0, c1));
  float ws = dot(ns, vec3(wb, y0, 0.0));
  float wt2 = dot(nt, vec3(-wb, y0, 0.0));
  vec3 span = vec3(0.0, 1e9, 1.0);
  nn = vec3(0.0, 0.0, -1.0);
  clip(o, d, vec3(0.0, 1.0, 0.0), y1, span, nn);
  clip(o, d, vec3(0.0, -1.0, 0.0), -y0, span, nn);
  clip(o, d, nf, wf, span, nn);
  clip(o, d, nb, wbk, span, nn);
  clip(o, d, ns, ws, span, nn);
  clip(o, d, nt, wt2, span, nn);
  if (span.x >= span.y || span.x <= 0.0) return vec2(1e9, 0.0);
  // the entry point lies this far inside the face it would leave by
  return vec2(span.x, span.z * (span.y - span.x));
}

// flat paint by the way a face turns
vec3 tone(vec3 paint, vec3 n) {
  vec3 col = mix(paint, SHADOW, 0.2 * n.z * n.z + 0.38 * n.x * n.x);
  return mix(col, SUN, 0.28 * max(n.y, 0.0));
}

void vehicle(vec2 p, float eye, float sq, vec4 v, inout vec3 c) {
  float z = v.x;
  if (z < 1.2) return;
  if (eye > 0.0) p = mix(p0, p, steady(z));
  float k = v.z;
  bool head = k > 0.5;
  bool truck = k > 2.5;
  bool pickup = k > 1.5 && !truck;
  float rel = v.y - uCam;
  float hw = truck ? 1.0 : pickup ? 0.88 : 0.84;
  float len = truck ? 6.2 : pickup ? 5.1 : 4.4;
  // across, at the nose and at the tail: skip the columns it cannot reach
  float x0 = (p.x - rel / z) * z;
  float x1 = (p.x - rel / (z + len)) * (z + len);
  float wide = (truck ? 1.1 : hw) + 0.3 + 8.0 * px * z;
  if (min(abs(x0), abs(x1)) > wide && x0 * x1 > 0.0) return;
  float h0 = (p.y * z + eye) / sq;
  if (h0 > (truck ? 4.0 : 2.8) || h0 < -1.6 * max(eye, 0.0) / z - 0.05) return;

  float sink = sinkAt(z);
  vec3 paint = tint(v.w);
  vec3 dark = mix(POLE_DARK, SHADOW, 0.3);
  vec3 glassLo = mix(POLE_DARK, SKY_MID, 0.4);
  vec3 glassHi = mix(POLE_DARK, SKY_MID, 0.65);
  float sill = truck ? 0.34 : pickup ? 0.3 : 0.24;
  float belt = truck ? 2.2 : pickup ? 1.0 : 0.8;
  float roof = pickup ? 1.72 : 1.38;
  float wr = truck ? 0.38 : 0.31;

  // CONTACT SHADOW
  // a soft pool under it, reaching a little toward us and left, away from the sun
  if (eye > 0.0 && sink == 0.0) {
    float d = abs(p.y) > 1e-6 ? -eye / p.y : -1.0;
    if (d > z - 2.0 && d < z + len) {
      vec2 g = vec2(p.x * d - rel, d);
      float sh = smoothstep(1.0, 0.6, length(vec2((g.x + 0.35) / (hw * 1.2), (g.y - z - 0.5 * len + 0.6) / (0.5 * len + 0.6))));
      c = mix(c, c * SHADOW, 0.6 * sh * (1.0 - fogAt(z)));
    }
  }

  // the ray in the vehicle's own frame: across from its middle, up from the road, back from
  // its nose. the mirror stretches heights, so its ray climbs slower
  vec3 o = vec3(-rel, eye / sq, -z);
  vec3 d = vec3(p.x, p.y / sq, 1.0);
  float nearT = 1e9;

  // BODY, BOX, CAB
  for (int part = 0; part < uLoop.x; part++) {
    if (part == 1 && !truck) continue;
    if (part == 2 && truck) continue;
    vec3 nn;
    vec2 hh;
    if (part < 2) {
      bool box = part == 1;
      hh = blockHit(
        o, d,
        box ? vec3(-1.08, 0.85, 2.0) : vec3(-hw, 0.06, 0.0),
        box ? vec3(1.08, 3.0, len) : vec3(hw, belt, truck ? 1.9 : len),
        box ? 0.06 : truck ? 0.16 : 0.14,
        nn
      );
    } else {
      hh = cabHit(
        o, d, belt - 0.02, roof,
        pickup ? 1.4 : 1.2, pickup ? 0.3 : 0.6,
        pickup ? 2.85 : 3.6, pickup ? 0.06 : 0.5,
        hw * 0.92, pickup ? hw * 0.8 : hw * 0.68,
        nn
      );
    }
    if (hh.x >= nearT) continue;
    vec3 hp = o + d * hh.x;
    float cov = clamp(hh.y / (px * hh.x) + 0.5, 0.0, 1.0);
    vec3 col = part == 1 ? tone(PAINT, nn) : tone(paint, nn);
    // below the sill the body is a dark skirt: the tyres and the shade under the car
    if (part == 0) col = mix(col, dark, step(hp.y, sill));
    // GLASS
    // windows on every face of the cab but its roof, and on the truck's cab
    if (part == 2 && nn.y < 0.95) {
      float u = clamp((hp.y - belt) / (roof - belt), 0.0, 1.0);
      float inY = step(belt + 0.07, hp.y) * step(hp.y, roof - 0.06);
      float win;
      if (abs(nn.z) > abs(nn.x)) {
        float hx = mix(hw * 0.92, pickup ? hw * 0.8 : hw * 0.68, u) - 0.08;
        win = inY * step(abs(hp.x), hx);
      } else {
        float f0 = (pickup ? 1.4 + 0.3 * u : 1.2 + 0.6 * u) + 0.1;
        float f1 = (pickup ? 2.85 - 0.06 * u : 3.6 - 0.5 * u) - 0.1;
        win = inY * step(f0, hp.z) * step(hp.z, f1) * (1.0 - step(abs(hp.z - 0.5 * (f0 + f1)), 0.05));
      }
      col = mix(col, mix(glassLo, glassHi, u), win);
    }
    if (part == 0 && truck && nn.y < 0.95) {
      float inY = step(1.45, hp.y) * step(hp.y, 2.05);
      float win = abs(nn.z) > abs(nn.x) ? inY * step(abs(hp.x), hw - 0.14) : inY * step(0.15, hp.z) * step(hp.z, 1.3);
      col = mix(col, mix(glassLo, glassHi, (hp.y - 1.45) / 0.6), win);
    }
    // LAMPS
    // on the end facing us: two warm headlamps and a grille, or red tail lamps
    if (part == 0 && nn.z < -0.7) {
      float ly = sill + 0.2;
      vec2 lq = vec2(abs(hp.x) - hw * 0.68, hp.y - ly);
      if (head) {
        col = mix(col, dark, step(abs(hp.x), 0.42) * step(abs(hp.y - sill - 0.1), 0.07) * 0.6);
        col = mix(col, HEAD, smoothstep(0.09, 0.07, length(lq)));
      } else col = mix(col, TAIL, step(abs(lq.x), 0.12) * step(abs(lq.y - 0.08), 0.05));
    }
    cov *= smoothstep(sink - 0.02, sink + 0.02, hp.y);
    col = mix(col, HAZE, fogAt(hh.x) * 0.85);
    c = mix(c, col, cov);
    if (cov > 0.5) nearT = hh.x;
  }

  // WHEELS
  // on the side we see, a dark disc with a lighter hub over the dark skirt
  float side = rel < 0.0 ? 1.0 : -1.0;
  float xo = side * (hw + 0.02);
  float tcap = (xo - o.x) / d.x;
  if (tcap > 0.0 && tcap < nearT + 0.3 && d.x * side < 0.0) {
    for (int i = 0; i < uLoop.w; i++) {
      float wz = i == 0 ? (truck ? 1.0 : 0.85) : len - (truck ? 1.3 : 0.9);
      vec2 q = o.yz + d.yz * tcap - vec2(wr, wz);
      float rq = length(q);
      float cov = clamp((wr - rq) / (px * tcap) + 0.5, 0.0, 1.0);
      vec3 col = mix(dark, mix(paint, SHADOW, 0.35), smoothstep(0.5 * wr, 0.4 * wr, rq));
      cov *= smoothstep(sink - 0.02, sink + 0.02, o.y + d.y * tcap);
      c = mix(c, mix(col, HAZE, fogAt(tcap) * 0.85), cov);
    }
  }

  // HEADLIGHTS
  // a faint warm flare that carries over the water
  if (head) {
    float am = px * z;
    float glowR = max(0.05, 2.0 * am);
    float xm = p.x * z - rel;
    float ly = sill + 0.2;
    if (ly > sink) {
      float dl = length(vec2(abs(xm) - hw * 0.68, (h0 - ly) * sq));
      c += HEAD_GLOW * 0.16 * exp(-dl / glowR) * (eye > 0.0 ? 1.0 : 0.6);
    }
  }
}

// WIRES
// the wires hang between the arms; their depth comes straight from the column
void wires(vec2 p, inout vec3 c) {
  if (p.x <= 0.0) return;
  for (int i = 0; i < uLoop.z; i++) {
    float off = i == 0 ? -0.82 : i == 1 ? 0.32 : 0.82;
    float ax = uPoleX + off * ${f(S.ARM_HALF)} - uCam;
    float z = ax / p.x;
    if (z < 1.5) continue;
    vec2 q = mix(p0, p, steady(z));
    z = ax / q.x;
    float u = fract((z + uTravel - ${f(S.POLE_PHASE_M)}) / ${f(S.POLE_SPACING_M)});
    float sag = ${f(S.SAG_M)} * 4.0 * u * (1.0 - u);
    float y = (${f(S.ARM_Y)} + 0.32 - sag - CAM_H) / z;
    // a falling wire crosses more rows per column, so widen it by its slope
    float slope = abs(y / q.x);
    float cov = band(q.y - y, 0.022 / z, px * (1.0 + slope));
    c = mix(c, mix(POLE_DARK, HAZE, fogAt(z) * 0.85), cov * 0.85);
  }
}

// SHADOWS
// a post's shadow on the ground runs back toward the viewer and left, away from the sun
const vec2 SUN_DIR = vec2(-0.8, -0.6);

float shadowOf(vec2 g, float xw, float spacing, float phase, float h, float w, vec2 aa) {
  float len = h * ${f(S.SHADOW_K)};
  float k = ceil((g.y - phase) / spacing);
  float zk = k * spacing + phase;
  vec2 a = vec2(xw, zk);
  vec2 b = a + SUN_DIR * len;
  vec2 ab = b - a;
  float t = clamp(dot(g - a, ab) / dot(ab, ab), 0.0, 1.0);
  vec2 d = g - (a + ab * t);
  // project the miss distance on the across axis, the pixel footprint differs per axis
  vec2 nrm = vec2(-ab.y, ab.x) / len;
  float across = abs(dot(d, nrm));
  float foot = length(abs(nrm) * aa);
  return band(across, 0.5 * w * (1.0 - 0.3 * t), foot) * step(dot(g - a, ab), dot(ab, ab));
}

// the crossarm, its insulators and the wires cast too: a point y up lands SUN_DIR * y * K
// along the ground from its foot
float rigShadow(vec2 g, vec2 aa) {
  vec2 lean = SUN_DIR * ${f(S.SHADOW_K)};
  float sp = ${f(S.POLE_SPACING_M)};
  float ph = ${f(S.POLE_PHASE_M)};
  float armY = ${f(S.ARM_Y)};
  float armHalf = ${f(S.ARM_HALF)};
  vec2 arm = lean * armY;
  float k = floor((g.y - arm.y - ph) / sp + 0.5);
  vec2 d = g - vec2(uPoleX, k * sp + ph) - arm;
  float s = band(d.x, armHalf, aa.x) * band(d.y, 0.14, aa.y);
  if (k * sp + ph - uTravel < 1.5) s = 0.0;
  // insulators, short stubs along the sun
  vec2 ab = lean * 0.24;
  float foot = 0.7 * length(aa);
  for (int i = 0; i < uLoop.y; i++) {
    float xo = (i < 2 ? 0.82 : 0.32) * (i % 2 == 0 ? 1.0 : -1.0) * armHalf;
    vec2 q = d - vec2(xo, 0.0) - lean * 0.08;
    float t = clamp(dot(q, ab) / dot(ab, ab), 0.0, 1.0);
    s = max(s, band(length(q - ab * t), 0.06, foot));
  }
  // WIRE SHADOWS
  // faint straight lines on the sand only, gone near the eye where they would read as tracks
  float far = smoothstep(30.0, 70.0, g.y - uTravel) * smoothstep(${f(S.ROAD_HALF + 0.6)}, ${f(S.ROAD_HALF + 1.6)}, abs(g.x));
  for (int i = 0; i < uLoop.z; i++) {
    float off = i == 0 ? -0.82 : i == 1 ? 0.32 : 0.82;
    float xs = uPoleX + off * armHalf + lean.x * (armY + 0.32 - ${f(S.SAG_M * 0.5)});
    s = max(s, 0.25 * far * band(g.x - xs, 0.025, aa.x));
  }
  return s;
}

// GROUND
vec3 ground(vec2 p) {
  float z = CAM_H / max(-p.y, PX_FLOOR);
  float x = p.x * z + uCam;
  float wz = z + uTravel;
  // how many metres one pixel spans across and along at this depth
  vec2 aa = vec2(px * z, px * z * z / CAM_H);

  // SAND
  vec3 c = mix(SAND_NEAR, SAND_FAR, smoothstep(6.0, 140.0, z));
  float tone = noise2(vec2(x * 0.04, wz * 0.015));
  c = mix(c, SAND_FAR, 0.25 * smoothstep(0.4, 0.8, tone));
  float warp = noise2(vec2(x * 0.18, wz * 0.06)) * 5.0;
  float ripple = sin(wz * 1.1 + warp + x * 0.15);
  float rippleFade = 1.0 - smoothstep(0.25, 0.9, aa.y * 1.1);
  c = mix(c, SAND_RIPPLE, smoothstep(0.55, 0.75, ripple) * rippleFade * 0.3);

  // ROAD
  float ax = abs(x);
  float shoulder = band(ax - ROAD_HALF - 0.5, 0.5, aa.x);
  c = mix(c, c * 0.94, shoulder);
  float road = band(x, ROAD_HALF, aa.x);
  vec3 tar = mix(ASPHALT, ASPHALT_FAR, smoothstep(8.0, 110.0, z));
  tar *= 0.96 + 0.08 * noise2(vec2(x * 1.7, wz * 0.4));
  float edge = band(ax - ROAD_HALF + 0.32, 0.08, aa.x);
  tar = mix(tar, PAINT, edge * 0.9);
  float dashAlong = fract(wz / ${f(S.DASH_M)});
  float dashFoot = aa.y / ${f(S.DASH_M)};
  float on = smoothstep(${f(S.DASH_ON)} + dashFoot, ${f(S.DASH_ON)} - dashFoot, dashAlong)
    * smoothstep(-dashFoot, dashFoot, dashAlong);
  // too far to resolve single dashes: show their average
  on = mix(on, ${f(S.DASH_ON)}, smoothstep(0.15, 0.5, dashFoot));
  tar = mix(tar, DASH, band(x, 0.075, aa.x) * on * 0.95);
  c = mix(c, tar, road);

  // CLOUD SHADOWS
  // big soft patches drifting with the clouds, fading out with the haze
  float cs = smoothstep(0.42, 0.8, cloudNoise2(vec2(x * 0.005 + uTime * 0.012, wz * 0.0035)));
  c = mix(c, c * SHADOW, 0.55 * cs * (1.0 - fogAt(z) * 0.7));

  // CAST SHADOWS
  vec2 g = vec2(x, wz);
  float sh = max(shadowOf(g, ${POLES}, aa), rigShadow(g, aa));
  for (int side = 0; side < uLoop.w; side++) {
    float xs = side == 0 ? ${f(S.POST_X)} : -${f(S.POST_X)};
    sh = max(sh, shadowOf(g, xs, ${f(S.POST_SPACING_M)}, 13.0, ${f(S.POST_H)}, ${f(S.POST_W)}, aa));
  }
  c = mix(c, c * SHADOW, 0.85 * sh * (1.0 - fogAt(z)));

  return mix(c, HAZE, fogAt(z) * (1.0 - 0.3 * road));
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (uv - vec2(uVp, uHor)) * vec2(uAspect, 1.0) * uZoom;
  px = uZoom / uRes.y;
  p0 = p;

  // HEAT SHIMMER
  // rising, wavering air that is strongest just over the hot ground at the horizon
  float heat = exp(-abs(p.y + 0.01 * SKY_K) / (0.055 * SKY_K)) * uShimmer;
  // it stays down among the dunes; the sky and its clouds hold still
  heat *= 1.0 - smoothstep(0.03, 0.07, p.y);
  vec2 q = vec2(p.x * 34.0, p.y * 70.0 - uTime * 2.4);
  float n1 = noise2(q) - 0.5;
  float n2 = noise2(q * 2.1 + 9.7) - 0.5;
  p += vec2(n1 + 0.5 * n2, 0.35 * n2) * ${f(0.0055 * S.HEAT_K)} * SKY_K * heat;
  // and over the far tarmac, a lower boil that reaches further down the road
  if (p.y < 0.0) {
    float zr = CAM_H / max(-p.y, PX_FLOOR);
    float onTar = 1.0 - smoothstep(ROAD_HALF - 0.3, ROAD_HALF + 0.6, abs(p.x * zr + uCam));
    float boil = exp(-abs(p.y) / (0.11 * SKY_K)) * onTar * uShimmer;
    vec2 qr = vec2(p.x * 22.0, p.y * 120.0 - uTime * 1.7);
    p.x += (noise2(qr) - 0.5) * ${f(0.0045 * S.HEAT_K)} * SKY_K * boil;
  }

  bool sky = p.y >= 0.0;
  vec3 c = vec3(0.0);
  float m = 0.0;
  float z = 0.0;
  float tarR = 0.0;
  vec2 r = p;
  if (!sky) {
    // the ground near us holds still; the heat only bends it far out
    vec2 pg = mix(p0, p, steady(CAM_H / max(-p0.y, PX_FLOOR)));
    c = ground(pg);

    // MIRAGE
    // past a certain distance the ground shows the sky instead, bent up off the hot layer
    z = CAM_H / max(-pg.y, PX_FLOOR);
    float x = pg.x * z + uCam;
    float zn = z / uPuddle;
    // over the sand only a thin sliver at the foot of the dunes, thinner toward the sides
    float side = p.x / uFrame.y;
    float lip = ((noise(p.x * 55.0 + uTime * 0.9) - 0.5) * 0.12
      + (noise(p.x * 13.0 - uTime * 0.3) - 0.5) * 0.2) * ${f(S.HEAT_K)};
    float reach = ${f(S.LAKE_M)} * (1.0 + 1.6 * side * side) * (1.0 + lip);
    m = smoothstep(reach * 0.985, reach * 1.015, z);

    // ROAD BANDS
    // the road is not flat: each crest of its rise and fall catches the sky as one thin band
    // across it, with dry tarmac between. they are fixed to the road, so as you drive they
    // re-space, thicken and merge into the pool at the horizon
    float ex = px * z;
    tarR = 1.0 - smoothstep(ROAD_HALF - ex, ROAD_HALF + ex, abs(x));
    float wzr = z + uTravel;
    float u = 0.55 * noise(wzr * 0.11) + 0.45 * noise(wzr * 0.29 + 4.0);
    // the nearest bands break up across the road, the far ones run whole; all of them waver
    float brk = mix(0.24, 0.05, smoothstep(1.0, 3.0, zn));
    u += brk * (noise2(vec2(x * 0.6, wzr * 0.22)) - 0.5) + 0.03 * (noise2(vec2(x * 1.9, wzr * 0.8)) - 0.5);
    u += ${f(0.025 * S.HEAT_K)} * (noise2(vec2(x * 0.9 + uTime * 0.8, wzr * 0.6 - uTime * 0.5)) - 0.5);
    float thr = 0.64 - 0.14 * smoothstep(1.0, 3.2, zn) - 0.6 * smoothstep(3.2, 5.5, zn);
    thr += 1.0 - smoothstep(1.3, 1.6, zn); // no band nearer than this share of the way
    float uw = max(fwidth(u), 1e-3);
    float mr = smoothstep(thr - uw, thr + uw, u);
    // damp, darker tarmac just around each band
    float wet = smoothstep(thr - 0.1, thr - 0.015, u) * (1.0 - mr) * tarR;
    c *= 1.0 - 0.22 * wet;
    m = mix(m, mr, tarR);
    // the bent rays leave the road almost level, so every band shows the low far scene:
    // the same view from an eye as far below the road, stretched down
    float ripple = noise2(vec2(p.x * 14.0, p.y * 420.0 - uTime * 1.3)) - 0.5;
    r = vec2(p.x + ripple * ${f(0.0025 * S.HEAT_K)}, -p.y);
  }

  // SKY
  // above the horizon, or the low sky the water shows
  vec3 refl = vec3(0.0);
  if (sky || m > 0.0) {
    vec2 at = sky ? p : vec2(r.x, r.y / ${f(S.MIRROR_K)});
    cloudP = (sky ? p0 : at) / SKY_K;
    vec3 s = above(at);
    if (sky) c = s;
    else refl = s;
  }

  // PASSES
  // the mirror first, then the scene itself: poles, posts, wires and traffic stand in front
  // of the water behind them, so nothing near is ever drowned in it
  for (int pass = 0; pass < uLoop.w; pass++) {
    bool mirror = pass == 0;
    if (mirror && (sky || m <= 0.0)) continue;
    vec2 qp = mirror ? r : p;
    float eye = mirror ? -CAM_H : CAM_H;
    float sq = mirror ? ${f(S.MIRROR_K)} : 1.0;
    vec3 t = mirror ? refl : c;
    // far behind everything else that stands
    devil(qp, eye, sq, t);
    for (int row = 0; row < uLoop.z; row++) {
      if (mirror && row > 0) break;
      bool pole = row == 0;
      posts(
        qp, eye, sq,
        pole ? uPoleX : row == 1 ? ${f(S.POST_X)} : -${f(S.POST_X)},
        pole ? ${f(S.POLE_SPACING_M)} : ${f(S.POST_SPACING_M)},
        pole ? ${f(S.POLE_PHASE_M)} : 13.0,
        pole ? ${f(S.POLE_H)} : ${f(S.POST_H)},
        pole ? ${f(S.POLE_W)} : ${f(S.POST_W)},
        pole, t
      );
    }
    if (!mirror && sky) {
      wires(qp, t);
      hawk(p0, t);
    }
    // the quick first program leaves the traffic out; the full one swaps in when it is linked
#ifndef LITE
    // and fades in once it has, so nothing pops
    vec3 bare = t;
    for (int i = 0; i < uLoop.y; i++) vehicle(qp, eye, sq, uTraffic[i], t);
    t = mix(bare, t, uReveal);
#endif
    if (mirror) {
      // silvery on the tarmac, bluer over the sand
      t = mix(t, mix(WATER, mix(SILVER, SKY_TOP, 0.35), tarR), mix(0.3, 0.42, tarR));
      // thin streaks that run sideways along the surface
      float streak = noise2(vec2(p.x * 7.0 + uTime * 0.2, p.y * 700.0));
      t *= 0.97 + 0.07 * smoothstep(0.35, 0.9, streak);
      t = mix(t, HAZE, fogAt(z) * 0.3);
      c = mix(c, t, m);
    } else c = t;
  }

  // GRADE
  // the vignette belongs to the view; uView maps a larger render, like the still, onto it
  vec2 v = (uv - uView.xy) / uView.zw - 0.5;
  c *= 1.0 - 0.18 * dot(v, v);
  c += (hash2(gl_FragCoord.xy) - 0.5) / 255.0;
  outColor = vec4(c, 1.0);
}`;
