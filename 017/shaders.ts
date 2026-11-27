export const NB = 11;
export const FIELD_S = 64;
export const FIELD_U = 9;
export const SPINE_W = 160;

// UNDERWATER
const VEIL_MIX = 0.16; // change for more water over the frond
const SOFT_MIX = 0.45; // change for a softer frond
const HALATION_MIX = 0.55; // change for more halation
const BOKEH_SHARE = 0.06; // change for more bokeh discs
const BOKEH_GAIN = 0.11; // change for brighter discs
const GRAIN_MIX = 0.034; // change for more grain
const GRAIN_FROND = 0.15; // change for more grain on the frond
const glf = (v: number) => v.toFixed(3);

const HEAD = `#version 300 es
precision highp float;
`;

const NOISE = `
float hash11(float p) { p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 q = fract(vec3(p.xyx) * .1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
vec2 hash22(vec2 p) { vec3 q = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); q += dot(q, q.yzx + 33.33); return fract((q.xx + q.yz) * q.zy); }
float noise1(float x) { float i = floor(x); float f = fract(x); return mix(hash11(i), hash11(i + 1.), f * f * (3. - 2. * f)); }
float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3. - 2. * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + 1.), u.x), u.y);
}
`;

// RAYS
// god rays radiating from uSun, in aspect space
const RAYS = `
float rays(vec2 p, float t) {
  vec2 d = p - uSun;
  float a = atan(d.x, -d.y);
  float r = noise1(a * 17. + t * .06) * .5 + noise1(a * 43. - t * .09 + 3.) * .28 + noise1(a * 6.5 + t * .025 + 9.) * .42;
  r = smoothstep(.52, 1.08, r);
  float len = length(d);
  return r * exp(-len * .42) * (.55 + .45 * noise1(len * 1.2 - t * .12 + a * 23.));
}
`;

const TONE = `
vec3 tone(vec3 c) {
  c = max(c, 0.);
  c = c * (2.51 * c + .03) / (c * (2.43 * c + .59) + .14);
  return pow(c, vec3(1. / 2.2)) + (hash12(gl_FragCoord.xy) - .5) / 255.;
}
float vig(vec2 uv) { vec2 q = (uv - .5) * vec2(.9, 1.); return clamp(1. - dot(q, q) * 1.2, 0., 1.); }
`;

export const FULL_VS = `${HEAD}
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2. - 1., 0., 1.);
}
`;

// BACKGROUND
// half resolution: water gradient, surface, far kelp, bokeh
export const BG_FS = `${HEAD}
uniform vec2  uRes;
uniform float uTime;
uniform float uAspect;
uniform vec2  uSun;
out vec4 o;
${NOISE}
${RAYS}
${TONE}
vec3 stalk(vec3 col, vec2 p, float x0, float lean, float w, float blur, float near, float ph, float t, float shaft) {
  float y = p.y;
  float xc = x0 + lean * (y + 1.) + .13 * sin(y * 1.05 + t * .19 + ph) + .05 * sin(y * 2.6 - t * .31 + ph * 2.);
  float hw = w * (.7 + .3 * sin(y * .8 + ph * 3.)) * (.55 + .45 * smoothstep(-1.2, .4, y));
  float d = abs(p.x - xc) / hw;
  float m = 1. - smoothstep(1. - blur, 1. + blur, d);
  float lit = .3 + .7 * smoothstep(-1.1, 1.2, y);
  vec3 c = vec3(.22, .2, .06) * lit * (.8 + .35 * (1. - d)) * (1. + 2.4 * shaft);
  // HAZE
  c = mix(col * vec3(1.05, 1.2, 1.1), c, near * .9);
  return mix(col, c, m * (.4 + .5 * near));
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = (uv * 2. - 1.) * vec2(uAspect, 1.);
  float t = uTime;
  float y = uv.y;
  // WATER
  vec3 col = mix(vec3(.0, .012, .03), vec3(.0, .07, .1), smoothstep(-.1, .6, y));
  col = mix(col, vec3(.02, .26, .27), smoothstep(.4, 1.1, y) * .9);
  float g = length((p - uSun) * vec2(.75, 1.));
  col += vec3(.2, .5, .42) * exp(-g * 1.1) * .9;
  // SURFACE
  float surf = smoothstep(.95, 1.04, y + (noise1(p.x * 5. + t * .3) - .5) * .03);
  float rip = noise2(vec2(p.x * 7. + t * .2, y * 30. - t * .5));
  col += vec3(.2, .4, .36) * surf * rip * rip;
  float shaft = rays(p, t);
  // FAR KELP
  // back to front, fog and blur falling off with distance
  col = stalk(col, p, -1.25 * uAspect, .16, .1, .6, .1, 1.3, t, shaft);
  col = stalk(col, p, .85 * uAspect, -.12, .13, .55, .18, 4.1, t * .9, shaft);
  col = stalk(col, p, .15 * uAspect, .28, .07, .5, .07, 2.2, t * 1.1, shaft);
  col = stalk(col, p, -.62 * uAspect, -.06, .22, .7, .5, 5.7, t * .8, shaft);
  col = stalk(col, p, 1.05 * uAspect, .1, .28, .8, .38, 3.3, t * .7, shaft);
  col += vec3(.14, .38, .34) * shaft * (.25 + .75 * y);
  // BOKEH
  for (int l = 0; l < 2; l++) {
    float fl = float(l);
    float sc = mix(2.6, 4.8, fl);
    vec2 q = p * sc + vec2(.04, .07) * t * (1. + fl);
    vec2 id = floor(q);
    vec2 f = fract(q) - .5;
    vec2 h = hash22(id + fl * 17.);
    if (h.x > .8) {
      vec2 c = (hash22(id + 31.) - .5) * .3;
      float rad = .14 + .18 * h.y;
      float d = length(f - c);
      float disc = 1. - smoothstep(rad - .08, rad, d);
      float rim = smoothstep(rad - .08, rad - .02, d) * disc;
      col += vec3(.2, .38, .32) * (disc * .032 + rim * .01) * (.3 + y) * (1. + 3. * shaft);
    }
  }
  col *= vig(uv);
  o = vec4(tone(col), 1.);
}
`;

export const COPY_FS = `${HEAD}
uniform sampler2D uBg;
uniform vec2 uRes;
out vec4 o;
${NOISE}
void main() {
  o = vec4(texture(uBg, gl_FragCoord.xy / uRes).rgb + (hash12(gl_FragCoord.xy) - .5) / 255., 0.);
}
`;

const LAYER = `
// LAYERS
// per-blade depth slab, younger in front, so blades overlap instead of intersecting
uniform vec2 uDepth;
vec4 layered(vec4 c, float layer) {
  float z = c.z / c.w - uDepth.x;
  c.z = (uDepth.x - layer * uDepth.y + clamp(z * .03, -.4 * uDepth.y, .4 * uDepth.y)) * c.w;
  return c;
}
`;

// SPINE
// three texture rows per spine: position, lateral, normal
const SPINE = `
uniform sampler2D uSpine;
vec3 spine(float i, float last, int row) {
  i = clamp(i, 0., last - .001);
  float i0 = floor(i);
  ivec2 c = ivec2(int(i0), row);
  return mix(texelFetch(uSpine, c, 0).xyz, texelFetch(uSpine, c + ivec2(1, 0), 0).xyz, i - i0);
}
`;

// LIGHT
// transmission (Beer-Lambert), water behind, sheen
const LIGHT = `
const vec3 SIGMA = vec3(.66, 1.22, 2.9);
const vec3 SUN = vec3(1.4, 1.12, .7);
const vec3 L = vec3(-.135, .9, -.42);
// CAUSTICS
// two ridged noise layers sliding past each other, fixed in world space
float caustic(vec3 pos, float t) {
  vec2 p = vec2(pos.x + pos.z * .4, pos.y * .55 - pos.z * .3) * 3.2;
  vec2 w = vec2(noise2(p * .5 + t * .07), noise2(p * .5 - t * .05 + 7.)) * 1.6;
  float a = noise2(p + w + vec2(t * .19, -t * .11));
  float b = noise2(p * 1.37 - w + vec2(-t * .14, t * .16) + 3.);
  float r = 1. - abs(a + b - 1.) * 2.6;
  return pow(clamp(r, 0., 1.), 5.);
}
vec3 through(float tau, vec3 N, vec3 V, vec3 pos, out vec3 bg, out float shaft, out float lightY, out float caus) {
  vec2 frag = gl_FragCoord.xy / uRes;
  vec2 p = (frag * 2. - 1.) * vec2(uAspect, 1.);
  shaft = rays(p, uTime);
  bg = texture(uBg, frag + N.xy * .02).rgb;
  bg *= bg;
  float nv = abs(dot(N, V));
  vec3 Ld = normalize(L);
  lightY = smoothstep(-1.5, 1.4, pos.y);
  caus = caustic(pos, uTime) * (.35 + .65 * lightY);
  float facing = .5 + .5 * abs(dot(N, Ld));
  float fwd = pow(max(dot(-V, Ld), 0.), 5.);
  vec3 Li = SUN * (.12 + .56 * lightY + 2.2 * shaft) * (.74 + 2. * caus) * facing * (1. + 1.3 * fwd) + bg * 2.;
  return exp(-tau / (.28 + .72 * nv) * SIGMA) * Li;
}
vec3 sheen(vec3 N, vec3 V, float shaft, float lightY, float hard) {
  float nv = abs(dot(N, V));
  vec3 R = reflect(-V, N);
  float fr = .04 + .96 * pow(1. - nv, 5.);
  // REFLECTION
  // env: bright overhead, dark below
  vec3 env = mix(vec3(.01, .05, .06), vec3(.55, .8, .72), smoothstep(-.1, .9, R.y)) * (.5 + 1.5 * shaft + lightY);
  float rl = max(dot(R, normalize(L + vec3(0., 0., .9))), 0.);
  vec3 hi = vec3(1., .93, .75) * (pow(rl, hard) * 2. + pow(rl, 12.) * .25) * (.4 + 2. * shaft + lightY);
  float satin = pow(rl, 5.) * .16 + pow(max(R.y, 0.), 3.) * .06;
  return (env * .55 + hi) * fr + hi * .06 + vec3(1., .9, .7) * satin * (.4 + shaft + lightY);
}
// VEIL
// fog toward the background colour, thicker with distance
vec3 veil(vec3 col, vec3 bg, vec3 pos, float shaft, float extra) {
  float dist = length(uCam - pos);
  float k = ${glf(VEIL_MIX)} + clamp((dist - uCam.z + .6) * .17, 0., .34) + clamp(-pos.z * .42, 0., .21) + extra;
  vec3 water = bg * vec3(.78, 1.04, 1.02) + vec3(.004, .016, .016) + vec3(.03, .07, .06) * shaft;
  return mix(col, water, clamp(k, 0., .8));
}
`;

// BLADE
// (s along, u across) grid on each blade's spine, one instance per blade
export const BLADE_VS = `${HEAD}
layout(location = 0) in vec2 aUV;
uniform mat4  uMvp;
uniform sampler2D uField;
uniform float uTime;
uniform vec4  uB0[${NB}];
uniform vec4  uB1[${NB}];
out vec3 vPos;
out vec3 vN;
out vec3 vT;
out vec2 vUV;
out float vW;
flat out vec4 vB;
invariant gl_Position;
${SPINE}
${LAYER}
// WIDTH
// petiole width at the root, then the blade profile
float width(float s, float w, float pet) {
  float wedge = pow(smoothstep(0., .2, s), .7);
  return w * pow(sin(3.14159 * pow(s, .55)), .5) * (1. - .2 * s) * wedge + pet * (1. - smoothstep(0., .12, s));
}
float offs(float s, float u, float w, vec4 b0, float ph, int row) {
  float sg = s * b0.x;
  float e = smoothstep(.55, 1., abs(u));
  float side = sign(u);
  float ruf = sin(sg * 22. - uTime * 1.4 + side * 1.3 + ph) + .4 * sin(sg * 37. - uTime * 2.2 + side * .7 + ph * 2.);
  ruf *= e * e * w * .15;
  float cup = u * u * w * .35;
  vec2 fc = vec2((s * ${(FIELD_S - 1).toFixed(1)} + .5) / ${FIELD_S}., (float(row) * ${FIELD_U}. + (u * .5 + .5) * ${(FIELD_U - 1).toFixed(1)} + .5) / ${(FIELD_U * NB).toFixed(1)});
  float h = texture(uField, fc).r;
  return (ruf + h) * smoothstep(0., .1, s) + cup;
}
vec3 place(float s, float u, vec4 b0, vec4 b1, int row) {
  float i = b0.z + s * b0.x * b0.w;
  int r = 3 + row * 3;
  float w = width(s, b0.y, b1.w);
  return spine(i, b1.x, r) + spine(i, b1.x, r + 1) * (u * w) + spine(i, b1.x, r + 2) * offs(s, u, w, b0, b1.y, row);
}
void main() {
  int row = gl_InstanceID;
  vec4 b0 = uB0[row];
  vec4 b1 = uB1[row];
  float s = aUV.x;
  float u = aUV.y;
  vec3 p = place(s, u, b0, b1, row);
  vec3 ps = place(s + .003, u, b0, b1, row);
  vec3 pu = place(s, u + .04, b0, b1, row);
  vPos = p;
  vT = normalize(ps - p);
  vN = normalize(cross(ps - p, pu - p));
  vUV = aUV;
  vW = width(s, b0.y, b1.w);
  vB = vec4(b0.x, b1.z, float(row), b0.y);
  gl_Position = layered(uMvp * vec4(p, 1.), float(row));
}
`;

export const BLADE_FS = `${HEAD}
uniform sampler2D uBg;
uniform vec2  uRes;
uniform float uAspect;
uniform float uTime;
uniform vec2  uSun;
uniform vec3  uCam;
in vec3 vPos;
in vec3 vN;
in vec3 vT;
in vec2 vUV;
in float vW;
flat in vec4 vB;
out vec4 o;
${NOISE}
${RAYS}
${TONE}
${LIGHT}
// CORRUGATION
// warped sine ridges across the blade, gated by noise, plus blisters
float crinkle(vec2 q, float seed) {
  float warp = noise2(vec2(q.x * 9., q.y * 3.5) + seed) * 3.2 + noise2(q * vec2(34., 12.) + seed) * 1.3;
  float ph = q.y * 190. + warp + sin(q.x * 23. + q.y * 7. + seed) * .4;
  float run = noise2(q * vec2(24., 10.) + seed + 4.);
  float ridge = sin(ph) * smoothstep(-.3, .35, run) * (.7 + .3 * noise2(q * vec2(6., 2.) + seed + 9.));
  float blister = noise2(q * vec2(46., 30.) + seed) - .5;
  return ridge + blister * .35;
}
void main() {
  float s = vUV.x;
  float u = vUV.y;
  float sg = s * vB.x;
  float x = u * vW;
  float au = abs(u);
  float age = vB.y;
  // SERRATED MARGIN
  // fine spines along both edges, raked toward the tip
  float tq = sg * 40. + (u > 0. ? 0. : .5) + vB.z * .37;
  float spike = pow(1. - fract(tq), 3.) * smoothstep(.03, .12, s);
  float tw = .011 / max(vW, .02);
  float edge = 1. - tw + tw * spike;
  float fw = fwidth(au) * 1.2;
  float alpha = 1. - smoothstep(edge - fw, edge, au);
  if (alpha < .01) discard;
  vec3 V = normalize(uCam - vPos);
  vec3 N = normalize(vN);
  vec3 B = normalize(cross(N, vT));
  if (dot(N, V) < 0.) N = -N;
  float cw = vW / .16;
  float seed = vB.z * 9.1;
  vec2 cq = vec2(x, sg);
  float h0 = crinkle(cq, seed);
  float hs = (crinkle(cq + vec2(0., .0025), seed) - h0) / .0025;
  float hx = (crinkle(cq + vec2(.0025, 0.), seed) - h0) / .0025;
  float cfade = 1. - smoothstep(.3, .85, fwidth(sg * 190.) / 3.14);
  float cm = smoothstep(1., .55, au) * smoothstep(.04, .2, s) * clamp(cw, .35, 1.) * cfade;
  float ra = x * 260. + noise2(cq * vec2(30., 3.) + seed) * 4.;
  float rfade = 1. - smoothstep(.2, .6, fwidth(x * 260.));
  float rib = sin(ra) * rfade;
  vec3 N0 = N;
  N = normalize(N - (vT * hs + B * hx) * .0027 * cm - B * cos(ra) * rfade * .06 * cm);
  // RETICULATE VEINS
  // a fine cell network, thinner than the tissue so it glows when backlit
  vec2 q = vec2(x * 55., sg * 38.);
  vec2 qi = floor(q);
  vec2 qf = fract(q);
  float f1 = 8.;
  float f2 = 8.;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(i, j);
      vec2 r = g + hash22(qi + g) - qf;
      float d = dot(r, r);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
  float fq = fwidth(q.x);
  float net = (1. - smoothstep(0., .07 + fq, sqrt(f2) - sqrt(f1))) * (1. - smoothstep(.25, .7, fq));
  // EPIPHYTES
  // white bryozoan specks, crowded on the older blades
  vec2 sq = vec2(x, sg) * 60.;
  vec2 si = floor(sq);
  vec2 sh = hash22(si + vB.z * 13.);
  float crowd = smoothstep(.4, .8, noise2(vec2(x * 5., sg * 2.2) + vB.z * 3.));
  float thresh = 1. - age * (.03 + .09 * crowd);
  float speck = 0.;
  if (sh.x > thresh) {
    vec2 c = (hash22(si + 7.) - .5) * .4;
    float rad = .1 + .22 * sh.y;
    vec2 d2 = fract(sq) - .5 - c;
    float d = length(d2 * vec2(1., 1. + sh.y)) + (noise2(d2 * 9. + si) - .5) * .12;
    float aa = fwidth(sq.x);
    speck = 1. - smoothstep(rad - aa, rad + aa, d);
  }
  // THICKNESS
  // corrugation folds hold more tissue, so they darken in transmission
  float e = smoothstep(.55, 1., au);
  float base = 1. - smoothstep(0., .08, s);
  float tau = 1.12 + base * .5 + (1. - au * au) * .3 - e * .42 - net * .1;
  tau += (noise2(vec2(x * 2.2, sg * .7) + vB.z * 5.) - .5) * .6 + age * .38;
  tau += (pow(max(h0, 0.), 3.) * .45 - .06) * cm;
  tau += rib * .03 * cm;
  vec3 bg;
  float shaft;
  float lightY;
  float caus;
  vec3 col = through(tau, N, V, vPos, bg, shaft, lightY, caus);
  col *= 1. + 1.1 * dot(N - N0, normalize(L));
  // COLOUR
  // per-blade noise blot between two browns
  float blot = noise2(vec2(x * 3.1, sg * 1.3) + vB.z * 2.7);
  col *= mix(vec3(1.1, .86, .58), vec3(1.02, .9, .66), blot);
  col += vec3(.012, .04, .04) * (.6 + .4 * N.y);
  // BACKLIGHT
  // view-against-sun transmission, warmer as tissue thins
  float back = pow(max(dot(-V, normalize(L)), 0.), 2.) * (.4 + lightY + 1.6 * shaft);
  col += vec3(.4, .22, .04) * exp(-tau * 2.2) * back * (.5 + 1.5 * caus);
  col = mix(col, vec3(.5, .54, .48) * (.25 + .5 * lightY + 1.3 * shaft), speck * .55);
  col += sheen(N, V, shaft + caus * .4, lightY, 16.) * .55; // change for a wetter blade
  // RIM
  float rim = smoothstep(edge - .14, edge - fw, au);
  col *= 1. + .45 * rim;
  col += vec3(.35, .2, .04) * rim * (.15 + .5 * lightY + shaft) * .3;
  col = veil(col, bg, vPos, shaft, s * s * .14 + e * .06);
  col *= vig(gl_FragCoord.xy / uRes);
  o = vec4(tone(col), alpha);
}
`;

// LAYERS
// blades redrawn behind the depth buffer, multiplying into what is in front
export const DIM_FS = `${HEAD}
in vec2 vUV;
in float vW;
flat in vec4 vB;
out vec4 o;
${NOISE}
void main() {
  float s = vUV.x;
  float u = vUV.y;
  float sg = s * vB.x;
  float au = abs(u);
  float tq = sg * 40. + (u > 0. ? 0. : .5) + vB.z * .37;
  float spike = pow(1. - fract(tq), 3.) * smoothstep(.03, .12, s);
  float tw = .011 / max(vW, .02);
  float edge = 1. - tw + tw * spike;
  float fw = fwidth(au) * 1.2;
  float alpha = 1. - smoothstep(edge - fw, edge, au);
  if (alpha < .01) discard;
  float n = noise2(vec2(u * vW * 2.2, sg * .7) + vB.z * 5.);
  vec3 tint = vec3(.58, .46, .22) * (.85 + .3 * n) * (1. - .25 * vB.y);
  tint = mix(tint, tint * 1.25, smoothstep(.6, 1., au));
  o = vec4(mix(vec3(1.), tint, alpha), 1.);
}
`;

// TUBES
// main stipe and every bulb stalk, as surfaces of revolution on their spines
export const TUBE_VS = `${HEAD}
layout(location = 0) in vec2 aRing;
uniform mat4  uMvp;
uniform float uMain;
uniform vec4  uStipe;
uniform vec4  uB0[${NB}];
uniform vec4  uB1[${NB}];
uniform vec4  uB2[${NB}];
out vec3 vPos;
out vec3 vN;
out float vS;
out float vPhi;
out float vBulb;
out float vAlong;
out vec3 vT;
flat out float vAge;
${SPINE}
${LAYER}
float smax(float a, float b, float k) { float h = clamp(.5 + .5 * (a - b) / k, 0., 1.); return mix(b, a, h) + k * h * (1. - h); }
// RADIUS
// stipe width, thin pedicel, egg-shaped bulb, neck into the blade root
float radius(float sg, float P, float R, float k, float rs) {
  float tt = (sg + P) / P;
  float t2 = clamp((tt - .3) / .7, 0., 1.);
  float rb = R * pow(sin(3.14159 * pow(t2, k)), .45);
  float stalk = mix(rs * .92, R * .24, smoothstep(0., .24, tt));
  return smax(stalk, rb, R * .1) * (1. - smoothstep(0., .1, sg));
}
void main() {
  int row = uMain > .5 ? 0 : 3 + gl_InstanceID * 3;
  vec4 b0 = uB0[gl_InstanceID];
  vec4 b1 = uB1[gl_InstanceID];
  vec4 b2 = uB2[gl_InstanceID];
  float sg;
  float i;
  float last;
  float r;
  float dr;
  if (uMain > .5) {
    sg = aRing.x * uStipe.x;
    i = sg * uStipe.z;
    last = uStipe.y;
    r = uStipe.w * (1. - .6 * smoothstep(.6, 1., aRing.x));
    dr = 0.;
    vBulb = 0.;
    vAlong = 1.;
    vAge = 1.;
  } else {
    sg = mix(-b2.x, .1, aRing.x);
    i = b0.z + sg * b0.w;
    last = b1.x;
    r = radius(sg, b2.x, b2.y, b2.z, b2.w);
    dr = (radius(sg + .003, b2.x, b2.y, b2.z, b2.w) - radius(sg - .003, b2.x, b2.y, b2.z, b2.w)) / .006;
    vAlong = clamp((sg + b2.x) / b2.x, 0., 1.);
    vBulb = smoothstep(b2.y * .3, b2.y * .8, r);
    vAge = mix(1., b1.z, smoothstep(0., .3, (sg + b2.x) / b2.x));
  }
  vec3 c = spine(i, last, row);
  vec3 T = normalize(spine(i + .5, last, row) - spine(i - .5, last, row));
  // FRAME
  // re-orthogonalise the lateral against the bent tangent (Gram-Schmidt)
  vec3 la = normalize(spine(i, last, row + 1) - T * dot(spine(i, last, row + 1), T));
  vec3 rad = cos(aRing.y) * la + sin(aRing.y) * cross(T, la);
  vPos = c + rad * r;
  vN = normalize(rad - T * dr);
  vT = T;
  vS = sg + float(gl_InstanceID) * 7.;
  vPhi = aRing.y;
  gl_Position = layered(uMvp * vec4(vPos, 1.), uMain > .5 ? ${NB}.6 : ${NB + 1}.6);
}
`;

export const TUBE_FS = `${HEAD}
uniform sampler2D uBg;
uniform vec2  uRes;
uniform float uAspect;
uniform float uTime;
uniform vec2  uSun;
uniform vec3  uCam;
in vec3 vPos;
in vec3 vN;
in float vS;
in float vPhi;
in float vBulb;
in float vAlong;
in vec3 vT;
flat in float vAge;
out vec4 o;
${NOISE}
${RAYS}
${TONE}
${LIGHT}
void main() {
  vec3 V = normalize(uCam - vPos);
  vec3 N = normalize(vN);
  float nv = abs(dot(N, V));
  // FIBRES
  // stringy noise along stipe and stalks, none on the bulbs
  float fib = noise2(vec2(vPhi * 9., vS * 9.)) * .6 + noise2(vec2(vPhi * 26., vS * 22.)) * .4;
  float rough = 1. - vBulb;
  vec3 tg = normalize(cross(normalize(vT), N));
  N = normalize(N + tg * (fib - .5) * .45 * rough);
  nv = abs(dot(N, V));
  float str = noise2(vec2(vPhi * 6., vS * 40.));
  float root = (1. - smoothstep(.12, .6, vAlong)) * vBulb;
  float blot = noise2(vec2(vS * 2.3, vPhi * .4)) * rough;
  // MOTTLE
  // thickness patches and dark freckles on the float wall
  float mot = noise2(vec2(vPhi * 2.2, vS * 34.)) * .65 + noise2(vec2(vPhi * 6., vS * 90.)) * .35;
  float frk = smoothstep(.72, .86, noise2(vec2(vPhi * 11., vS * 160.)));
  float tau = mix(1.35, 1.05, vBulb) + str * .15 * rough + fib * .3 * rough + blot * .3;
  tau += (1. - nv) * mix(.5, 1., vBulb) * smoothstep(0., .35, vAlong) + vAge * .15 + root * .35;
  tau += ((mot - .5) * .5 + frk * .25) * vBulb;
  vec3 bg;
  float shaft;
  float lightY;
  float caus;
  vec3 col = through(tau, N, V, vPos, bg, shaft, lightY, caus);
  // WAX
  // warm face-on glow through the wall of the gas-filled float
  float lit = .1 + .45 * lightY + shaft + caus * .6;
  col *= 1. + vBulb * .45 * pow(nv, 1.5);
  col += vec3(.5, .26, .05) * vBulb * lit * smoothstep(.15, 1., nv) * (.75 + .5 * mot) * .3;
  col += vec3(.36, .2, .05) * vBulb * lit * pow(1. - nv, 2.) * .12;
  col = mix(col, col * vec3(.7, .74, .42), root);
  col *= .95 + .1 * noise2(vec2(vPhi * 14., vS * 120.)) * rough;
  col += vec3(.015, .04, .036) * (.5 + .5 * N.y);
  // SHEEN
  // broader lobe on the bulbs than on the stipe
  col += sheen(N, V, shaft + caus * .5, lightY, mix(14., 7., vBulb)) * mix(.45, .3, vBulb); // change for wetter floats
  col *= mix(vec3(1.38, 1.04, .34) * (.9 + .2 * blot), vec3(1.3, 1., .42), vBulb);
  col = veil(col, bg, vPos, shaft, 0.);
  col *= vig(gl_FragCoord.xy / uRes);
  o = vec4(tone(col), 1.);
}
`;

// MOTES
// marine snow and dust as points; near ones become bokeh discs
export const MOTE_VS = `${HEAD}
layout(location = 0) in vec4 aSeed;
uniform mat4  uProj;
uniform float uTime;
uniform float uTan;
uniform float uAspect;
uniform float uCamZ;
uniform float uDpr;
uniform vec4  uFlow;
uniform vec2  uSun;
out float vA;
out float vSoft;
out float vSnow;
flat out float vSeed;
${NOISE}
${RAYS}
void main() {
  float snow = step(.86, fract(aSeed.w * 13.7 + aSeed.x * 3.1));
  // LENS
  // a few points right at the lens, large and faint
  float lens = step(${glf(1 - BOKEH_SHARE)}, fract(aSeed.w * 7.3 + aSeed.y * 1.7)) * (1. - snow);
  float z = mix(mix(-3.2, 2.35, aSeed.z), mix(2.6, 3.05, aSeed.z), lens);
  float dist = uCamZ - z;
  float hh = dist * uTan;
  float sp = .6 + aSeed.w;
  vec2 drift = vec2(.018 + .01 * sin(uTime * .21 + aSeed.w * 6.), mix(.028, -.012, snow)) * uTime * sp;
  drift += vec2(sin(uTime * .37 + aSeed.w * 9.), cos(uTime * .29 + aSeed.w * 5.)) * .012;
  vec2 q = fract(aSeed.xy + drift / (hh * 2.)) * 2.2 - 1.1;
  vec2 d = (q - uFlow.xy) * vec2(uAspect, 1.);
  q += uFlow.zw * .07 * exp(-dot(d, d) * 9.) * (1.5 - aSeed.z);
  vec3 v = vec3(q.x * hh * uAspect, q.y * hh, -dist);
  gl_Position = uProj * vec4(v, 1.);
  float coc = abs(z - .25) * .55;
  float size = mix(.5 + aSeed.w * .9, 2.2 + aSeed.w * 2.4, snow) * (2.4 / dist) + coc * coc * 26.;
  size = mix(size, 70. + 90. * aSeed.w, lens);
  gl_PointSize = clamp(size * uDpr, 1., 400.);
  vSoft = clamp(coc * .9, mix(.1, .45, snow), mix(.95, .7, lens));
  vSnow = snow * (1. - smoothstep(.3, .7, coc));
  vSeed = aSeed.w * 37.;
  float sh = rays(q * vec2(uAspect, 1.), uTime);
  // GLINT
  // dust flashes inside sun shafts
  float glint = 1. + 2.5 * sh * pow(noise1(uTime * 1.3 + aSeed.x * 91.), 6.) * (1. - snow);
  vA = (.25 + 2.6 * sh) * (.4 + .6 * (q.y * .5 + .5)) / (1. + coc * coc * 9.) * (.6 + .4 * aSeed.w) * mix(1., .55, snow) * glint;
  vA = mix(vA, (${glf(BOKEH_GAIN)} + .6 * sh) * (.5 + .5 * (q.y * .5 + .5)) * (.6 + .4 * aSeed.x), lens);
}
`;

export const MOTE_FS = `${HEAD}
in float vA;
in float vSoft;
in float vSnow;
flat in float vSeed;
out vec4 o;
${NOISE}
void main() {
  vec2 c = gl_PointCoord - .5;
  float rag = (noise2(c * 5. + vSeed) - .5) * .7 * vSnow;
  float d = length(c) * 2. + rag;
  float disc = 1. - smoothstep(1. - vSoft, 1., d);
  float rim = smoothstep(.6, .95, d) * disc * step(.4, vSoft) * (1. - vSnow);
  o = vec4(mix(vec3(.6, .8, .72), vec3(.82, .86, .78), vSnow) * vA * (disc * .5 + rim * .12), 0.);
}
`;

// SOFT
// half-resolution box blur; alpha carries frond coverage
export const SOFT_FS = `${HEAD}
uniform sampler2D uScene;
uniform vec2 uRes;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 k = .5 / uRes;
  o = (texture(uScene, uv + k) + texture(uScene, uv - k) + texture(uScene, uv + vec2(k.x, -k.y)) + texture(uScene, uv - vec2(k.x, -k.y))) * .25;
}
`;

// POST
// ripple, edge fringe, soft focus, scatter, red absorption, grain
export const POST_FS = `${HEAD}
uniform sampler2D uScene;
uniform sampler2D uBg;
uniform sampler2D uSoft;
uniform vec2  uRes;
uniform float uTime;
uniform float uRipple;
uniform float uFringe;
uniform float uGrain;
uniform float uBlur;
out vec4 o;
${NOISE}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float t = uTime;
  // RIPPLE
  vec2 w = vec2(
    sin(uv.y * 7. + t * .55 + sin(uv.x * 5. - t * .35) * 1.6),
    cos(uv.x * 6. - t * .45 + sin(uv.y * 4. + t * .4) * 1.6)
  );
  uv += w * uRipple / uRes;
  // FRINGE
  vec2 c = uv - .5;
  float edge = dot(c, c);
  vec2 ca = c * edge * uFringe * 5.6 / uRes;
  vec4 sc = texture(uScene, uv);
  vec3 col = sc.rgb;
  if (edge > .07) col.rb = vec2(texture(uScene, uv + ca).r, texture(uScene, uv - ca).b);
  // SOFT FOCUS
  // 4-tap blur from the soft target, plus halation off bright blades
  vec2 k = uBlur / uRes;
  vec4 sf = texture(uSoft, uv + k * vec2(1., .4)) + texture(uSoft, uv - k * vec2(1., .4)) + texture(uSoft, uv + k * vec2(-.4, 1.)) + texture(uSoft, uv - k * vec2(-.4, 1.));
  sf *= .25;
  vec2 k2 = k * 2.8;
  vec4 hl = texture(uSoft, uv + k2 * vec2(.7, .7)) + texture(uSoft, uv - k2 * vec2(.7, .7)) + texture(uSoft, uv + k2 * vec2(-.95, .3)) + texture(uSoft, uv - k2 * vec2(-.95, .3));
  hl *= .25;
  float m = max(sc.a, sf.a);
  col = mix(col, sf.rgb, .15 + ${glf(SOFT_MIX)} * m);
  col += max(hl.rgb - .48, 0.) * vec3(1., .84, .58) * (.25 + .75 * hl.a) * ${glf(HALATION_MIX)};
  // SCATTER
  // bright background shafts bleed into the frame
  vec2 r = vec2(uRes.y / uRes.x, 1.) * .022;
  vec3 b = texture(uBg, uv + r * vec2(.8, .6)).rgb + texture(uBg, uv - r * vec2(.8, .6)).rgb;
  b = max(b * .5 - .42, 0.);
  col += b * vec3(.55, .9, .8) * .35; // change scatter strength here
  // ABSORPTION
  // reds drop with depth and toward the edges
  float lum = dot(col, vec3(.3, .59, .11));
  float deep = clamp((1. - uv.y) * .55 + edge * 1.2, 0., 1.);
  col.r = mix(col.r, lum * .8, deep * .28);
  col = mix(col, col * vec3(.88, 1., .9) + vec3(.006, .013, .003), deep * .5);
  // VIGNETTE
  col *= 1. - edge * .32;
  // GRAIN
  // value-noise clumps plus per-pixel hash speckle
  float g = (noise2(gl_FragCoord.xy / uGrain + fract(t * 7.31) * 613.) - .5) * 1.7 + (hash12(gl_FragCoord.xy + fract(t * 3.17) * 271.) - .5) * .5;
  col += g * ${glf(GRAIN_MIX)} * (.35 + lum) * (1. + ${glf(GRAIN_FROND)} * m);
  o = vec4(col, 1.);
}
`;
