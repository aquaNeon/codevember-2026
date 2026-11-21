import { BLAST, DROP, FRONT_UPS, SMOKE, TIP_X } from "./scene";

const f = (n: number) => n.toFixed(5);
const YAW = (DROP.YAW_DEG * Math.PI) / 180;

// LIGHT
// linear radiance in a dark warm studio: one big softbox, one strip behind
export const LIGHT = {
  KEY_E: 2.6, // irradiance from the softbox on a face turned to it
  BOX: 9.0, // the softbox seen in a reflection
  STRIP: 5.0, // the strip light behind, for the rim
  AMB: [0.05, 0.046, 0.04],
  EXPOSURE: 1.15,
};

const COMMON = `
precision highp float;
const float STRETCH = ${f(DROP.STRETCH)};
const float JOIN_X = ${f(DROP.JOIN_X)};
const float TAIL_U = ${f(DROP.TAIL_U)};
const float NECK_R = ${f(DROP.NECK_R)};
const float TIP_R = ${f(DROP.TIP_R)};
const float TAPER = ${f(DROP.TAPER)};
const float CURL = ${f(DROP.CURL)};
const float TIP_X = ${f(TIP_X)};
const vec2 AT = vec2(${f(DROP.AT[0])}, ${f(DROP.AT[2])});
const float YC = ${f(Math.cos(YAW))};
const float YS = ${f(Math.sin(YAW))};
const float KEY_E = ${f(LIGHT.KEY_E)};
const float BOX = ${f(LIGHT.BOX)};
const float STRIP = ${f(LIGHT.STRIP)};
const vec3 AMB = vec3(${LIGHT.AMB.map(f).join(", ")});
const float IOR = 1.52;

uniform vec3  uKey;   // unit, toward the softbox
uniform float uHere;  // 1 the drop is whole glass, 0 it has gone to powder
uniform float uPol;   // 0 the stress fringes faint, 1 seen through crossed polarisers
// always 1: loop bounds that read it cannot be unrolled, which keeps the d3d compile short
uniform int   uOne;
uniform float uSnap;  // local x where it snapped

float hash(vec3 p) {
  p = fract(p * vec3(443.897, 441.423, 437.195));
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

// DROP
// a bulb drawn out into a long tapering tail, in its own frame: bulb centre at the origin
vec3 toLocal(vec3 p) {
  vec3 w = p - vec3(AT.x, 1.0, AT.y);
  return vec3(YC * w.x + YS * w.z, w.y, -YS * w.x + YC * w.z);
}

vec3 dirLocal(vec3 d) {
  return vec3(YC * d.x + YS * d.z, d.y, -YS * d.x + YC * d.z);
}

vec3 dirWorld(vec3 d) {
  return vec3(YC * d.x - YS * d.z, d.y, YS * d.x + YC * d.z);
}

vec3 toWorld(vec3 q) {
  return dirWorld(q) + vec3(AT.x, 1.0, AT.y);
}

// tail radius and centreline (y, z) at u, mirrors tail() in scene.ts
vec3 tailAt(float u) {
  float r = TIP_R + (NECK_R - TIP_R) * exp(-u * TAPER) * pow(1.0 - u, 0.3);
  float droop = smoothstep(0.0, 0.55, u);
  return vec3(r, (r - 1.0) * droop, CURL * sin(u * 2.4) * u);
}

float whole(vec3 q) {
  float b = (length(q / vec3(STRETCH, 1.0, 1.0)) - 1.0) * 0.96;
  float u = clamp((JOIN_X - q.x) / TAIL_U, 0.0, 1.0);
  vec3 t = tailAt(u);
  float d = length(q.yz - t.yz) - t.x;
  if (q.x < TIP_X) d = length(vec3(q.x - TIP_X, q.yz - t.yz)) - TIP_R;
  d = max(d, q.x - JOIN_X - 0.25) * 0.7;
  return smin(b, d, 0.3);
}

// once the drop has gone to powder there is no glass left at all, tip included
float sdf(vec3 q) {
  return uHere <= 0.0 ? 9.0 : whole(q);
}

vec3 normal(vec3 q) {
  // four taps in a loop the compiler keeps rolled: one copy of the shape, not four
  vec3 n = vec3(0.0);
  for (int k = 0; k < 4 * uOne; k++) {
    vec3 e = vec3(float(((k + 3) >> 1) & 1), float((k >> 1) & 1), float(k & 1)) * 2.0 - 1.0;
    n += e * sdf(q + e * 4e-4);
  }
  return normalize(n);
}

// the local radius of the glass round q: the tail's there, easing into the bulb's
float girth(vec3 q) {
  float t = max(tailAt(clamp((JOIN_X - q.x) / TAIL_U, 0.0, 1.0)).x, 0.02);
  return mix(t, 1.0, smoothstep(JOIN_X - 0.35, JOIN_X + 0.75, q.x)); // no step at the neck
}

// a ray against the drop's box, in the local frame: entry and exit, or a miss
vec2 box(vec3 ro, vec3 rd) {
  vec3 lo = vec3(TIP_X - 0.1, -1.03, -1.1);
  vec3 hi = vec3(STRETCH + 0.03, 1.03, 1.1);
  vec3 m = 1.0 / rd;
  vec3 a = (lo - ro) * m;
  vec3 b = (hi - ro) * m;
  vec3 tn = min(a, b);
  vec3 tf = max(a, b);
  return vec2(max(max(tn.x, tn.y), tn.z), min(min(tf.x, tf.y), tf.z));
}

bool hitDrop(vec3 ro, vec3 rd, out float t) {
  vec2 b = box(ro, rd);
  t = max(b.x, 0.0);
  if (b.y < t) return false;
  for (int i = 0; i < 90 * uOne; i++) {
    float d = sdf(ro + rd * t);
    if (d < 0.0012) return true;
    t += d;
    if (t > b.y) return false;
  }
  return false;
}

// STUDIO
// a softbox up and to one side, a strip behind, a warm dark sweep
vec3 frame(vec3 n, out vec3 v) {
  vec3 u = normalize(cross(n, vec3(0.0, 1.0, 0.001)));
  v = cross(u, n);
  return u;
}

float panel(vec3 d, vec3 n, vec2 size, float soft) {
  float w = dot(d, n);
  if (w <= 0.0) return 0.0;
  vec3 v;
  vec3 u = frame(n, v);
  vec2 q = vec2(dot(d, u), dot(d, v)) / w;
  vec2 e = 1.0 - smoothstep(size - soft, size, abs(q));
  return e.x * e.y;
}

vec3 env(vec3 d) {
  // dark round the sides, so grazing light through the glass draws its outline
  vec3 c = mix(vec3(0.02, 0.018, 0.016), vec3(0.12, 0.108, 0.095), smoothstep(-0.1, 0.8, d.y));
  c += vec3(1.0, 0.96, 0.9) * BOX * panel(d, uKey, vec2(0.55, 0.38), 0.12);
  c += vec3(0.92, 0.95, 1.0) * STRIP * panel(d, normalize(vec3(0.72, 0.28, -0.64)), vec2(0.1, 0.9), 0.05);
  return c;
}

// soft shadow of the drop toward the softbox, glass casting a light one
float shade(vec3 p) {
  vec3 ro = toLocal(p);
  vec3 rd = dirLocal(uKey);
  vec2 b = box(ro, rd);
  if (b.y < max(b.x, 0.0)) return 1.0;
  float s = 1.0;
  float t = max(b.x, 0.02);
  for (int i = 0; i < 28 * uOne; i++) {
    float d = whole(ro + rd * t); // the intact shape: the survivors are too small to shade
    s = min(s, 9.0 * d / t);
    t += clamp(d, 0.03, 0.4);
    if (s < 0.0 || t > b.y) break;
  }
  return mix(1.0, 0.45 + 0.55 * clamp(s, 0.0, 1.0), uHere);
}

// the sweep far off, where the floor curves up out of sight
vec3 backdrop(vec3 rd) {
  return vec3(0.3, 0.275, 0.25) * (AMB * 1.5 + KEY_E * uKey.y * 0.42) * (1.0 - 0.55 * smoothstep(0.0, 0.4, rd.y));
}

// the floor's own light, with or without the drop's shadow and caustic in it
vec3 floorLit(vec3 p, float shadow, float t, vec3 far) {
  vec3 alb = vec3(0.3, 0.275, 0.25);
  float pool = 0.3 + 0.7 * exp(-dot(p.xz - vec2(-0.6, -0.3), p.xz - vec2(-0.6, -0.3)) / 14.0);
  float lit = KEY_E * uKey.y * pool * shadow;
  return mix(alb * (AMB * 1.5 + lit), far, smoothstep(9.0, 22.0, t));
}

// seen in the glass, the studio needs no shadow: it would cost the drop's march again
vec3 studioSeen(vec3 ro, vec3 rd) {
  vec3 far = backdrop(rd);
  if (rd.y >= 0.0) return far;
  float t = -ro.y / rd.y;
  return floorLit(ro + rd * t, 1.0, t, far);
}

vec3 studio(vec3 ro, vec3 rd) {
  vec3 alb = vec3(0.3, 0.275, 0.25);
  vec3 far = backdrop(rd);
  if (rd.y >= 0.0) return far;
  float t = -ro.y / rd.y;
  vec3 p = ro + rd * t;
  // the floor: a pool of the softbox's light, the drop's shadow, the bulb's caustic
  float pool = 0.3 + 0.7 * exp(-dot(p.xz - vec2(-0.6, -0.3), p.xz - vec2(-0.6, -0.3)) / 14.0);
  float lit = KEY_E * uKey.y * pool * shade(p);
  vec3 c = vec3(AT.x, 1.0, AT.y);
  vec3 fp = c - uKey * (c.y / uKey.y);
  vec2 dq = p.xz - fp.xz;
  float caustic = (2.2 * exp(-dot(dq, dq) / 0.03) + 0.45 * exp(-dot(dq, dq) / 0.25)) * uHere;
  vec3 q = toLocal(p);
  float ao = mix(1.0, clamp(0.3 + whole(q) * 1.4, 0.3, 1.0), uHere);
  vec3 col = alb * (AMB * 1.5 * ao + lit) + vec3(1.0, 0.97, 0.9) * caustic * KEY_E * 0.3;
  // seamless into the sweep with distance
  return mix(col, far, smoothstep(9.0, 22.0, t));
}

// DISPLAY
vec3 neutral(vec3 c) {
  const float start = 0.76;
  const float desat = 0.12;
  float x = min(c.r, min(c.g, c.b));
  float off = x < 0.08 ? x - 6.25 * x * x : 0.04;
  c -= off;
  float peak = max(c.r, max(c.g, c.b));
  if (peak < start) return c;
  const float d = 1.0 - start;
  float np = 1.0 - d * d / (peak + d - start);
  c *= np / peak;
  float g = 1.0 - 1.0 / (desat * (peak - np) + 1.0);
  return mix(c, vec3(np), g);
}

vec3 display(vec3 l) {
  vec3 c = neutral(max(l, 0.0) * ${f(LIGHT.EXPOSURE)});
  c = pow(c, vec3(1.0 / 2.2));
  return c + (hash(vec3(gl_FragCoord.xy, 1.0)) - 0.5) / 255.0;
}
`;

export const FULL_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// GLASS
// every pixel that meets the drop follows the light through it: a reflection off the skin,
// a refraction in, a march across, a refraction out or a total internal reflection and
// another crossing. along the way it gathers the stress the glass holds and, once the
// front has passed, the crazing it leaves
export const DROP_FS = `#version 300 es
${COMMON}
uniform vec3  uEye;
uniform vec3  uRight;
uniform vec3  uUp;
uniform vec3  uFwd;
uniform vec2  uTan;
uniform vec2  uRes;
uniform vec2  uCross; // the bulb on screen, in pixels: where the polariscope's dark cross meets
uniform float uFront; // how far the front has run from there
uniform float uMilk;  // the whole drop crazed, just before it goes
uniform float uTink;  // a glint from tapping the bulb
out vec4 o;

// the crazing: a network of crack planes, finer in the tail
float cracks(vec3 q, float g) {
  vec3 p = q * (7.0 / clamp(sqrt(g), 0.35, 1.0));
  vec3 i = floor(p);
  vec3 fr = fract(p);
  float d1 = 9.0;
  float d2 = 9.0;
  for (int k = 0; k < 8 * uOne; k++) {
    vec3 c = vec3(float(k & 1), float((k >> 1) & 1), float((k >> 2) & 1));
    vec3 o2 = c + vec3(hash(i + c), hash(i + c + 3.1), hash(i + c + 7.7)) * 0.8 + 0.1 - fr;
    float d = dot(o2, o2);
    if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return 1.0 - smoothstep(0.0, 0.09, sqrt(d2) - sqrt(d1));
}

// POLARISCOPE
// what the crossed polarisers leave of the studio: a calm warm dark, a little lighter
// toward the drop
vec3 polariscope() {
  vec2 d = (gl_FragCoord.xy - uCross) / uRes.y;
  return mix(vec3(0.016, 0.014, 0.012), vec3(0.05, 0.045, 0.04), exp(-dot(d, d) / 0.6));
}

// MICHEL-LEVY
// white light between crossed polarisers through a retardation of r nm: each wavelength
// passes as sin^2(pi r / lambda), summed through rough colour matching curves. black,
// grey, white, yellow, red, purple, blue, green, then ever paler orders
vec3 fringe(float r) {
  vec3 c = vec3(0.0);
  vec3 w = vec3(0.0);
  for (int i = 0; i < 12 * uOne; i++) {
    float l = 405.0 + float(i) * 27.0;
    vec3 m = vec3(exp(-pow((l - 600.0) / 42.0, 2.0)) + 0.3 * exp(-pow((l - 445.0) / 22.0, 2.0)),
                  exp(-pow((l - 550.0) / 45.0, 2.0)),
                  exp(-pow((l - 455.0) / 30.0, 2.0)));
    float t = sin(3.14159 * r / l);
    c += t * t * m;
    w += m;
  }
  return c / w;
}

// the fringe colour softened: averaged over a spread of retardations that widens with
// order, so neighbouring bands blend the way they do in a photograph, and a little
// desaturated toward cream
vec3 softFringe(float r) {
  vec3 c = vec3(0.0);
  for (int i = 0; i < 5 * uOne; i++) {
    c += fringe(r * (1.0 + (float(i) - 2.0) * 0.06) + (float(i) - 2.0) * 12.0);
  }
  c /= 5.0;
  // warmed a touch, the way the photographs' golds and ambers sit
  float l = dot(c, vec3(0.3, 0.5, 0.2));
  return pow(mix(vec3(l), c, 1.05), vec3(1.3)) * vec3(1.16, 0.97, 0.76);
}

// STRESS
// the skin in compression, the core in tension, smooth between; integrated through the
// glass along the first crossing it is the retardation the polariser sees
float retard(vec3 a, vec3 d) {
  // the far side found by even steps then halving: smooth across the glass, where a
  // sphere-traced march would run out of steps unevenly and leave rings
  float t0 = 0.0;
  float t1 = 0.0;
  for (int i = 0; i < 40 * uOne; i++) {
    t1 += 0.06;
    if (whole(a + d * t1) > 0.0) break;
    t0 = t1;
  }
  for (int i = 0; i < 6 * uOne; i++) {
    float m = (t0 + t1) * 0.5;
    if (whole(a + d * m) > 0.0) t1 = m;
    else t0 = m;
  }
  vec3 b = a + d * t0;
  float len = t0;
  float acc = 0.0;
  for (int i = 0; i < 28 * uOne; i++) {
    vec3 x = mix(a, b, (float(i) + 0.5) / 28.0);
    float g = girth(x);
    float rel = clamp(-whole(x) / g, 0.0, 1.0);
    acc += mix(-1.5, 0.75, smoothstep(0.0, 0.6, rel)) / g;
  }
  // a smooth absolute value: the neutral zone is a soft dark band, not a hard black line
  float v = acc * len / 28.0;
  return sqrt(v * v + 0.02);
}

void main() {
  vec2 ndc = gl_FragCoord.xy / uRes * 2.0 - 1.0;
  vec3 rd = normalize(uFwd + ndc.x * uTan.x * uRight + ndc.y * uTan.y * uUp);
  vec3 bg = studio(uEye, rd);
  vec3 ro = toLocal(uEye);
  vec3 rl = dirLocal(rd);
  float t;
  bool hit = uHere > 0.0 && hitDrop(ro, rl, t);
  vec3 q = ro + rl * t;
  if (!hit) {
    o = vec4(display(mix(bg, polariscope(), uPol)), 1.0);
    return;
  }
  vec3 n = normal(q);
  vec3 nw = dirWorld(n);
  float c = max(dot(-rd, nw), 0.0);
  float fr = 0.04 + 0.96 * pow(1.0 - c, 5.0);
  vec3 rr = reflect(rd, nw);
  // the room and the floor in the skin, blended where they meet so no seam shows
  float down = 1.0 - smoothstep(-0.15, 0.0, rr.y);
  vec3 refl = mix(env(rr), studioSeen(uEye + rd * t, rr), down);
  refl += uTink * 30.0 * pow(max(dot(rr, normalize(uKey + vec3(0.15, -0.1, 0.1))), 0.0), 300.0);

  // THROUGH
  vec3 d = refract(rl, n, 1.0 / IOR);
  vec3 d0 = d;
  vec3 p = q - n * 0.003;
  float path = 0.0;
  vec3 first = q - n * 0.003; // where the light enters, for the stress
  float haze = 0.0;
  float lines = 0.0;
  float glow = 0.0;
  vec3 out_ = d;
  for (int bounce = 0; bounce < 2 * uOne; bounce++) {
    float s = 0.0;
    for (int i = 0; i < 40 * uOne; i++) {
      vec3 x = p + d * s;
      float dd = sdf(x);
      if (dd > -0.0008 && s > 0.004) break;
      float step_ = max(-dd, 0.012);
      float g = girth(x);
      // CRAZING
      // behind the front the glass is full of branching cracks and goes milky
      // behind the front the glass is shot through with branching cracks, clear between
      // them; at the front itself a bright running tip, like a fuse
      // the fracture runs both ways from the break; in the bulb's bulk it comes in soft,
      // so its front is not a hard white plane
      float ahead = uFront - abs(x.x - uSnap);
      float bulk = smoothstep(JOIN_X - 0.2, JOIN_X + 0.5, x.x);
      float cz = max(smoothstep(0.0, mix(0.05, 0.7, bulk), ahead), uMilk);
      float sg = sqrt(g);
      if (cz > 0.0) {
        haze += step_ * (cz * 0.04 + uMilk * 0.12) / sg;
        lines += step_ * cz * cracks(x, g) * 2.2;
      }
      // the fuse burns in the tail; in the bulb's bulk it would bloom into a blob
      float fuse = mix(1.0, 0.08, smoothstep(JOIN_X - 0.4, JOIN_X + 0.3, x.x));
      glow += step_ * exp(-ahead * ahead / 0.0036) / sg * fuse * step(1e-4, uFront);
      s += step_;
    }
    path += s;
    p += d * s;
    vec3 ne = normal(p);
    vec3 e = refract(d, -ne, IOR);
    if (dot(e, e) > 0.0) {
      out_ = e;
      break;
    }
    d = reflect(d, -ne);
    p -= ne * 0.003;
    out_ = d;
  }
  vec3 tint = exp(-path * vec3(0.035, 0.014, 0.022));
  vec3 behindL = studioSeen(toWorld(p), dirWorld(out_));
  vec3 col = fr * refl + (1.0 - fr) * behindL * tint;

  // FRINGES
  // the stress frozen in the glass: a faint rainbow normally, vivid under polarised light,
  // the glass's own reflections still riding on top
  // low orders through the bulb, denser only along the thin tail and the neck
  float thin = 1.0 - smoothstep(JOIN_X - 0.6, JOIN_X + 0.4, first.x);
  // compressed toward a ceiling: broad first and second orders, never a stack of pale ones
  // the bulb held in the first order and the start of the second: cream, gold, orange,
  // magenta, a deep blue band; the tail runs a little further
  float rmax = mix(680.0, 1500.0, thin);
  vec3 fc = softFringe(rmax * (1.0 - exp(-retard(first, d0) * mix(3.6, 0.9, thin))));
  col *= mix(vec3(1.0), 0.6 + 0.8 * fc, 0.08);
  // lit evenly from behind: no seams from the refracted layers or the internal bounce
  vec3 polar = fc * 1.55 + fr * refl * 0.9;
  col = mix(col, polar, uPol);

  // CRAZING
  float lit = 0.35 + 0.65 * max(dot(nw, uKey), 0.0);
  vec3 milk = vec3(0.86, 0.86, 0.84) * (AMB * 4.0 + KEY_E * 0.42 * lit) + fr * refl;
  col = mix(col, milk, 1.0 - exp(-haze * 1.4));
  col = mix(col, vec3(1.0) * (AMB * 6.0 + KEY_E * 0.6 * lit), 1.0 - exp(-lines * 0.9));
  col += vec3(1.0, 0.95, 0.85) * glow * 9.0;

  vec3 back = mix(bg, polariscope(), uPol);
  o = vec4(display(mix(back, col, uHere)), 1.0);
}`;

// POWDER
// every grain's flight in closed form: thrown out when the front reaches it, slowed by
// the air, falling, resting on the floor; a facet that flashes when it faces the light
export const DUST_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aP0;
layout(location = 1) in vec3 aV;
layout(location = 2) in float aLx;
layout(location = 3) in float aTau;
layout(location = 4) in float aSize;
layout(location = 5) in float aSeed;
layout(location = 6) in float aLand;  // seconds after launch it comes to rest height
uniform mat4  uViewProj;
uniform vec3  uEye;
uniform vec3  uKey;
uniform float uT;     // physical seconds since the snap
uniform float uSnap;
uniform float uPx;    // pixels per unit at unit distance
uniform float uHere;
out float vA;
out float vSpark;
out float vLit;

const float G = ${BLAST.g.toFixed(1)};
const float SKID = ${BLAST.skidS.toFixed(3)};

vec3 dir(float s) {
  float z = s * 2.0 - 1.0;
  float a = s * 6283.0;
  float r = sqrt(1.0 - z * z);
  return vec3(cos(a) * r, z, sin(a) * r);
}

void main() {
  // the front reaches a grain both ways from the break
  float launch = abs(aLx - uSnap) / ${f(FRONT_UPS * 1e6)};
  float t = uT - launch;
  float tau = max(t, 0.0);
  float k = aTau;
  float fly = min(tau, aLand);
  float e = 1.0 - exp(-fly / k);
  vec3 p = aP0 + aV * k * e;
  // the outer segment is thrown on outward, away from the break
  p += vec3(${f(Math.cos(YAW))}, 0.0, ${f(Math.sin(YAW))}) * step(aLx, uSnap) * -6.0 * k * e;
  p.y += G * k * k * e - G * k * fly;
  if (tau > aLand) {
    // down: it skids on with what speed it kept, losing some to the impact
    float sk = aSize > 0.015 ? SKID : SKID * 0.3;
    p.xz += aV.xz * exp(-aLand / k) * 0.55 * sk * (1.0 - exp(-(tau - aLand) / sk));
  }
  p.y = max(p.y, aSize * 0.35);
  vec4 clip = uViewProj * vec4(p, 1.0);
  gl_Position = clip;
  float px = aSize * uPx / clip.w;
  gl_PointSize = clamp(px, 1.5, 10.0);
  // a grain the front has only just reached flashes: the sparks running up the fuse
  float fresh = step(0.0, t) * exp(-tau / 2.5e-6) * uHere;
  // a grain the front has not reached yet is not drawn
  vA = max((1.0 - uHere) * clamp(px / 1.5, 0.15, 1.0), fresh * 0.9) * step(0.0, t);
  // a facet tumbling as it flies, stopping when it stops
  vec3 n = dir(fract(aSeed + e * 3.0));
  vec3 v = normalize(uEye - p);
  float s = max(dot(reflect(-v, n), uKey), 0.0);
  vSpark = pow(s, 40.0) * (aSize > 0.02 ? 16.0 : 9.0) + fresh * 14.0 * aSeed;
  // lit on the side toward the softbox, shaded under, so the cloud has body
  vLit = (0.35 + 0.65 * max(dot(n, uKey), 0.0)) * (0.65 + 0.35 * clamp(p.y / 1.4, 0.0, 1.0));
}`;

export const DUST_FS = `#version 300 es
${COMMON}
in float vA;
in float vSpark;
in float vLit;
out vec4 o;

void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float m = 1.0 - smoothstep(0.55, 1.0, dot(c, c));
  // glass dust: mostly clear, a pale haze where it is thick, a flash where a facet meets the light
  // glass scatters what it gets: bright, a little cool, translucent, flashing
  vec3 l = vec3(0.97, 0.99, 1.0) * (AMB * 4.0 + KEY_E * 0.62 * vLit) + vec3(1.0, 0.97, 0.9) * vSpark;
  float a = vA * m * (1.0 - 0.8 * uPol) * (0.8 + 0.2 * min(vSpark, 1.0));
  o = vec4(display(l) * a, a);
}`;

// SMOKE
// the finest dust hanging after the blast: soft billowing puffs and motes glinting in them.
// thrown out, slowed, then carried on a curl-noise drift that is a pure function of time
export const SMOKE_VS = `#version 300 es
precision highp float;
layout(location = 0) in vec3 aP0;
layout(location = 1) in vec3 aV;
layout(location = 2) in float aSeed;
layout(location = 3) in float aSize;
layout(location = 4) in float aKind;
uniform mat4  uViewProj;
uniform vec3  uEye;
uniform vec3  uKey;
uniform float uT;     // seconds since the bulb went
uniform float uPx;
uniform float uPol;
out float vA;
out float vSpark;
out float vKind;

// curl of a smooth vector potential, analytic, so the flow has no sources or sinks
vec3 curl(vec3 p) {
  return vec3(1.05 * cos(p.y * 2.1 + 2.9) - 1.9 * cos(p.z * 1.9 + 2.1),
              1.15 * cos(p.z * 2.3 + 0.7) - 1.5 * cos(p.x * 1.5 + 0.4),
              1.35 * cos(p.x * 2.7 + 1.9) - 1.7 * cos(p.y * 1.7 + 1.3));
}

vec3 dir(float s) {
  float z = s * 2.0 - 1.0;
  float a = s * 6283.0;
  float r = sqrt(1.0 - z * z);
  return vec3(cos(a) * r, z, sin(a) * r);
}

void main() {
  float t = max(uT, 0.0);
  float k = 0.1 + aSeed * 0.12;
  vec3 p = aP0 + aV * k * (1.0 - exp(-t / k));
  p += vec3(0.02, 0.07, -0.05) * t;
  vec3 q = aP0 * 1.2 + vec3(0.0, -t * 0.25, t * 0.12);
  p += curl(q) * 0.16 * (1.0 - exp(-t / 0.7));
  p.y = max(p.y, 0.02);
  vec4 clip = uViewProj * vec4(p, 1.0);
  gl_Position = clip;
  float grow = 1.0 + t * 0.7 * (1.0 - aKind);
  float px = aSize * grow * uPx / clip.w;
  gl_PointSize = clamp(px, 1.5, 120.0);
  float life = step(0.0, uT) * smoothstep(0.0, 0.04, t) *
               (1.0 - smoothstep(${SMOKE.fadeS[0].toFixed(2)}, ${SMOKE.fadeS[1].toFixed(2)}, t + aSeed * 0.4));
  vA = life * (1.0 - 0.85 * uPol) * (aKind > 0.5 ? clamp(px / 1.5, 0.2, 1.0) : 0.055 / grow);
  // a mote is a flake turning slowly: it flashes when it faces the light just so
  vec3 n = dir(fract(aSeed * 7.3 + t * 0.35));
  vec3 v = normalize(uEye - p);
  vSpark = aKind * pow(max(dot(reflect(-v, n), uKey), 0.0), 60.0) * 10.0;
  vKind = aKind;
}`;

export const SMOKE_FS = `#version 300 es
${COMMON}
in float vA;
in float vSpark;
in float vKind;
out vec4 o;

void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r = dot(c, c);
  // puffs are soft gaussian blots, motes small round points
  float m = vKind > 0.5 ? 1.0 - smoothstep(0.5, 1.0, r) : exp(-r * 3.2) * step(r, 1.0);
  vec3 l = vec3(0.97, 0.99, 1.0) * (AMB * 4.0 + KEY_E * (vKind > 0.5 ? 0.5 : 0.45)) +
           vec3(1.0, 0.97, 0.9) * vSpark;
  float a = vA * m * (vKind > 0.5 ? 0.55 + 0.45 * min(vSpark, 1.0) : 1.0);
  o = vec4(display(l) * a, a);
}`;
