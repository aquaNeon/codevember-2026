import { SCENE, SHAFTS, SUN } from "./scene";

const f = (x: number) => x.toFixed(5);
const v3 = (a: readonly number[]) => `vec3(${f(a[0])}, ${f(a[1])}, ${f(a[2])})`;

// window basis around the sun, for the room the crystal reflects
const W = [-SUN[0], -SUN[1], -SUN[2]];
const ul = Math.hypot(W[2], W[0]);
const U = [W[2] / ul, 0, -W[0] / ul];
const V = [W[1] * U[2] - W[2] * U[1], W[2] * U[0] - W[0] * U[2], W[0] * U[1] - W[1] * U[0]];

const sl = Math.hypot(SHAFTS.slope[0], SHAFTS.slope[1]);
const ACROSS = [SHAFTS.slope[1] / sl, -SHAFTS.slope[0] / sl];
const ALONG = [SHAFTS.slope[0] / sl, SHAFTS.slope[1] / sl];

const HEAD = `#version 300 es
precision highp float;`;

export const FULL_VS = `${HEAD}
uniform vec2 uHalf;
out vec2 vWall;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2) * 2.0 - 1.0;
  vWall = p * uHalf;
  gl_Position = vec4(p, 0.0, 1.0);
}`;

// WALL
// drawn once per resize into a texture: warm plaster raked by soft sun shafts, cool in the
// shade. alpha keeps how sunlit each point is, for the shadows drawn over it
const bands = SHAFTS.bands
  .map(([a, b, s, k]) => `lit += ${f(k)} * band(u, ${f(a)}, ${f(b)}, ${f(s)} * pen);`)
  .join("\n  ");
const [ua, ub, us, uk] = SHAFTS.upright;

export const WALL_FS = `${HEAD}
in vec2 vWall;
out vec4 o;
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
    mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    s += a * noise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p;
    a *= 0.5;
  }
  return s;
}
float band(float u, float a, float b, float s) {
  return smoothstep(a - s, a + s, u) * (1.0 - smoothstep(b - s, b + s, u));
}
void main() {
  vec2 p = vWall;
  // a little waver in the edges, the way light reads on an uneven wall
  float wob = (fbm(p * 2.2) - 0.5) * 0.035;
  float u = dot(p, vec2(${f(ACROSS[0])}, ${f(ACROSS[1])})) + wob;
  float v = dot(p, vec2(${f(ALONG[0])}, ${f(ALONG[1])}));
  // penumbra widens further from the window
  float pen = 1.0 + 0.6 * smoothstep(1.5, -2.0, v);
  float lit = 0.0;
  ${bands}
  lit += ${f(uk)} * band(p.x + wob, ${f(ua)}, ${f(ub)}, ${f(us)});
  lit = clamp(lit * (0.92 + 0.08 * smoothstep(-1.5, 1.5, v)), 0.0, 1.0);

  // PLASTER
  float blot = fbm(p * 1.3 + 3.1);
  float skim = fbm(vec2(p.x * 7.0 - p.y * 3.0, p.y * 2.2) + 11.0);
  float grain = noise(p * 260.0) * 0.6 + noise(p * 90.0) * 0.4;
  float tex = (blot - 0.5) * 0.05 + (skim - 0.5) * 0.035 + (grain - 0.5) * 0.03;
  vec3 shade = vec3(0.805, 0.8, 0.795);
  vec3 sun = vec3(0.985, 0.95, 0.885);
  // relief catches the raking light more than the flat shade
  vec3 c = mix(shade, sun, lit) * (1.0 + tex * (1.0 + 1.6 * lit));
  o = vec4(c, lit);
}`;

// BLIT
// the baked wall, straight to the screen
export const BLIT_FS = `${HEAD}
uniform sampler2D uWall;
out vec4 o;
void main() {
  o = vec4(texelFetch(uWall, ivec2(gl_FragCoord.xy), 0).rgb, 1.0);
}`;

// SHADOW
// the crystal flattened onto the wall along the sun. only faces that see the sun survive the
// cull, and on a convex solid they tile the outline exactly once
export const SHADOW_VS = `${HEAD}
const vec3 SUN = ${v3(SUN)};
uniform mat4 uVP;
uniform mat3 uRot;
uniform vec3 uPos;
in vec3 aPos;
void main() {
  vec3 w = uRot * aPos + uPos;
  gl_Position = uVP * vec4(w.xy + SUN.xy * (-w.z / SUN.z), 0.0, 1.0);
}`;

// into the shadow mask: red is anything in the sun's way, green only the metal
export const SHADOW_FS = `${HEAD}
out vec4 o;
void main() {
  o = vec4(1.0, 0.0, 0.0, 1.0);
}`;

// SHADE
// the mask, blurred a touch for the penumbra, laid on the sunlit wall as one shadow. the mask
// was drawn with max blending, so chain, ring and stone join with no darker overlaps
export const SHADE_FS = `${HEAD}
uniform sampler2D uWall;
uniform sampler2D uMask;
uniform vec2 uStep; // penumbra tap spacing, in uv
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / vec2(textureSize(uMask, 0));
  float m = texture(uMask, uv).r * 0.25;
  m += (texture(uMask, uv + vec2(uStep.x, 0.0)).r + texture(uMask, uv - vec2(uStep.x, 0.0)).r
    + texture(uMask, uv + vec2(0.0, uStep.y)).r + texture(uMask, uv - vec2(0.0, uStep.y)).r) * 0.125;
  m += (texture(uMask, uv + uStep).r + texture(uMask, uv - uStep).r
    + texture(uMask, uv + vec2(uStep.x, -uStep.y)).r + texture(uMask, uv + vec2(-uStep.x, uStep.y)).r) * 0.0625;
  float sun = texelFetch(uWall, ivec2(gl_FragCoord.xy), 0).a;
  float a = 0.36 * m * sun; // change shadow depth here
  // a little of the light the milky stone scatters fills it evenly
  vec3 fill = vec3(1.0, 0.95, 0.86) * 0.015 * m * sun;
  o = vec4(vec3(0.14, 0.14, 0.15) * a + fill, a);
}`;

// CAUSTICS
// the sun through the stone, face by face: each sunlit face is traced to the face it leaves
// by and moved to where its light lands. faces that bunch up brighten, faces that spread or
// cannot leave stay dark, so the shadow fills with angular patches and a bright streak where
// the point focuses. drawn once per colour, a hair apart, for a faint spectral rim
export const causticVs = (faces: number, height: number) => `${HEAD}
#define FACES ${faces}
const vec3 SUN = ${v3(SUN)};
const float IOR = ${f(SCENE.ior)};
const float SPLIT = ${f(SCENE.spread * 0.25)};
const float BEND = 0.32; // how far the light walks off its own shadow, change for a thinner stone
const vec3 MIDDLE = vec3(0.0, ${f(-height * 0.45)}, 0.0);
uniform mat4 uVP;
uniform mat3 uRot;
uniform vec3 uPos;
uniform vec4 uPlanes[FACES];
uniform int uFaces;
in vec3 aPos;
in vec3 aNormal;
out vec2 vStraight;
out float vGain;
flat out vec3 vTint;
void main() {
  int ch = gl_InstanceID;
  vTint = vec3(ch == 0, ch == 1, ch == 2);
  float ior = IOR + float(ch - 1) * SPLIT;
  vec3 s = transpose(uRot) * SUN;
  vec3 n = aNormal;
  vec3 w0 = uRot * aPos + uPos;
  vec2 straight = w0.xy + SUN.xy * (-w0.z / SUN.z);
  vStraight = straight;
  vec2 land = straight;
  float c = -dot(s, n);
  vGain = 0.0;
  if (c > 0.02) {
    vec3 d = refract(s, n, 1.0 / ior);
    // start a hair inside, so the corner the ray starts on is not its way out
    vec3 p = mix(aPos, MIDDLE, 0.03);
    float tmin = 1e3;
    vec3 m = n;
    for (int j = 0; j < uFaces; j++) {
      vec4 pl = uPlanes[j];
      float dn = dot(d, pl.xyz);
      if (dn > 1e-4) {
        float t = (pl.w - dot(p, pl.xyz)) / dn;
        if (t > 1e-4 && t < tmin) {
          tmin = t;
          m = pl.xyz;
        }
      }
    }
    p += d * tmin;
    vec3 e = refract(d, -m, ior);
    vec3 g = uRot * e;
    if (dot(e, e) > 0.0 && g.z < -0.05) {
      vec3 q = uRot * p + uPos;
      vec2 hit = q.xy + g.xy * (-q.z / g.z);
      land = straight + (hit - straight) * BEND;
      float fr = 0.05 + 0.95 * pow(1.0 - c, 5.0);
      vGain = (1.0 - fr) * smoothstep(0.02, 0.3, c);
    }
  }
  gl_Position = uVP * vec4(land, 0.0, 1.0);
}`;

export const CAUSTIC_FS = `${HEAD}
uniform sampler2D uWall;
uniform sampler2D uMask;
uniform float uPx2; // wall area of one pixel
in vec2 vStraight;
in float vGain;
flat in vec3 vTint;
out vec4 o;
void main() {
  // how much of the face's own shadow got squeezed into this pixel
  vec2 dx = dFdx(vStraight);
  vec2 dy = dFdy(vStraight);
  float squeeze = min(abs(dx.x * dy.y - dx.y * dy.x) / uPx2, 4.0);
  float sun = texelFetch(uWall, ivec2(gl_FragCoord.xy), 0).a;
  // through milky stone only part of the sun goes straight
  // chain and ring still stand in the way of the light that made it through
  float metal = texelFetch(uMask, ivec2(gl_FragCoord.xy), 0).g;
  float l = squeeze * vGain * sun * (1.0 - metal) * 0.1; // change caustic strength here
  o = vec4(vec3(1.0, 0.95, 0.86) * vTint * l, 0.0);
}`;

// GLINTS
// a small hard star where a face mirrors the sun, drawn over the crystal
export const GLINT_VS = `${HEAD}
uniform mat4 uVP;
uniform vec2 uSize; // star half size in clip units
in vec2 aCorner;
in vec4 aGlint;
out vec2 vQ;
flat out float vS;
void main() {
  vec4 c = uVP * vec4(aGlint.xyz, 1.0);
  vQ = aCorner;
  vS = aGlint.w;
  c.xy += aCorner * uSize * c.w * (0.5 + 0.5 * aGlint.w);
  gl_Position = c;
}`;

export const GLINT_FS = `${HEAD}
in vec2 vQ;
flat in float vS;
out vec4 o;
void main() {
  vec2 q = abs(vQ);
  float core = exp(-dot(q, q) * 90.0);
  float rays = exp(-q.x * 60.0) * pow(1.0 - q.y, 3.0) + exp(-q.y * 60.0) * pow(1.0 - q.x, 3.0);
  float l = (core * 2.0 + rays * 0.9) * vS;
  // the long ray breaks into colour toward its tip
  float r = max(q.x, q.y);
  vec3 tint = mix(vec3(1.0, 0.99, 0.96), 0.55 + 0.45 * cos(6.2831 * (r * 2.0 + vec3(0.0, 0.33, 0.67))), smoothstep(0.12, 0.5, r));
  o = vec4(tint * l, clamp(l * 0.5, 0.0, 0.8));
}`;

// FLECKS
// each beam lands as a soft short capsule, red at one end and violet at the other
export const SPOT_VS = `${HEAD}
uniform mat4 uVP;
in vec2 aCorner;
in vec4 aEnds;
in vec3 aLight; // radius, gain, seed
out vec2 vQ; // along, across, in radii from the middle
flat out float vHalf; // half the run, in radii
flat out float vGain;
flat out float vSeed;
void main() {
  vec2 a = aEnds.xy;
  vec2 b = aEnds.zw;
  vec2 ax = b - a;
  float len = length(ax);
  vec2 u = len > 1e-5 ? ax / len : vec2(1.0, 0.0);
  vec2 v = vec2(-u.y, u.x);
  float r = aLight.x;
  float h = 0.5 * len / r;
  vQ = vec2(aCorner.x * (h + 1.0), aCorner.y);
  vHalf = h;
  vGain = aLight.y;
  vSeed = aLight.z;
  vec2 p = (a + b) * 0.5 + u * vQ.x * r + v * vQ.y * r;
  gl_Position = uVP * vec4(p, 0.0, 1.0);
}`;

export const SPOT_FS = `${HEAD}
in vec2 vQ;
flat in float vHalf;
flat in float vGain;
flat in float vSeed;
out vec4 o;
const vec3 WARM = vec3(1.0, 0.95, 0.86);
// red to violet as three soft bumps, so the colours run into each other with no stripes
vec3 hue(float x) {
  vec3 d = (x - vec3(0.16, 0.47, 0.8)) / vec3(0.27, 0.22, 0.22);
  vec3 c = exp(-d * d);
  c.r += 0.45 * exp(-pow((x - 0.98) / 0.1, 2.0));
  return c * vec3(1.05, 0.95, 1.1);
}
void main() {
  // soft across, and dimming toward the red and violet ends the way a real spectrum does
  if (vSeed < -0.5) {
    // GLINT
    // plain warm light bounced off the stone or the chain
    float g = exp(-dot(vQ, vQ) * 4.0) * vGain;
    o = vec4(WARM * g, g * 0.1);
    return;
  }
  // FLECK
  // an irregular soft blot of sunlight, frayed at the edge, with a hint of colour at one end
  float x = clamp(vQ.x, -vHalf, vHalf);
  float d = length(vec2(vQ.x - x, vQ.y));
  float ang = atan(vQ.y, vQ.x / (vHalf + 1.0));
  float k = vSeed * 6.2832;
  float wob = 1.0 + 0.2 * sin(3.0 * ang + k) + 0.12 * sin(5.0 * ang + k * 2.7) + 0.07 * sin(8.0 * ang + k * 5.1);
  float m = 1.0 - smoothstep(0.0, 1.0, d / wob);
  m *= m * (0.75 + 0.25 * sin(vQ.x * 2.3 + k * 1.7) * sin(vQ.y * 3.1 + k * 3.3));
  float s = clamp((vQ.x + vHalf + 1.0) / (2.0 * vHalf + 2.0), 0.0, 1.0);
  // only the brighter flecks show their colour, and only at one edge
  float hint = smoothstep(0.55, 0.95, s) * 0.3 * smoothstep(0.1, 0.5, vGain); // change how much colour shows here
  vec3 c = mix(WARM, hue(0.15 + 0.8 * (s - 0.55) / 0.45), hint);
  float a = clamp(m * vGain, 0.0, 0.4); // change fleck strength here
  o = vec4(c * a, a * 0.2);
}`;

// LINES
// chain, its shadow and the bail, as quads a few pixels wide with a soft edge
export const LINE_VS = `${HEAD}
uniform mat4 uVP;
in vec3 aPos;
in vec3 aLine; // side, half width px, kind: 0 metal, 1 chain shadow, 2 chain, 3 shadow
in vec4 aColor;
in float aAlong;
out vec3 vLine;
out vec4 vColor;
out float vAlong;
void main() {
  vLine = aLine;
  vColor = aColor;
  vAlong = aAlong;
  gl_Position = uVP * vec4(aPos, 1.0);
}`;

export const LINE_FS = `${HEAD}
uniform float uLink; // link length, metres
in vec3 vLine;
in vec4 vColor;
in float vAlong;
out vec4 o;
void main() {
  float hw = max(vLine.y, 0.5);
  float d = abs(vLine.x) * (hw + 1.0);
  vec4 c = vColor;
  if (vLine.z > 0.5 && vLine.z < 2.5) {
    // CHAIN
    // links alternate face on and edge on: a wide bright loop, then a thin dark one
    float t = fract(vAlong / uLink);
    float face = step(0.5, fract(vAlong / uLink * 0.5));
    float w = mix(hw * 0.55, hw, face) * (0.75 + 0.25 * sin(t * 3.1416));
    float shine = mix(0.75, 1.25, face) * (0.85 + 0.3 * sin(t * 6.2832));
    float cov = clamp(w + 0.5 - d, 0.0, 1.0);
    // shadows go to the mask, as coverage
    o = vLine.z > 1.5 ? c * shine * cov : vec4(cov, cov, 0.0, 1.0);
    return;
  }
  float cov = clamp(hw + 0.5 - d, 0.0, 1.0) * min(1.0, vLine.y * 2.0);
  o = vLine.z > 2.5 ? vec4(cov, cov, 0.0, 1.0) : c * cov;
}`;

// CRYSTAL
// the view ray refracts in, bounces off the inside of the real faces until it can leave,
// then leaves once per colour channel at a slightly different angle. what it finds outside
// is the baked wall behind, or the bright room behind you with the window and the sun in it
export const CRYSTAL_VS = `${HEAD}
uniform mat4 uVP;
uniform mat3 uRot;
uniform vec3 uPos;
in vec3 aPos;
in vec3 aNormal;
in float aEdge;
out vec3 vLocal;
flat out vec3 vNormal;
out float vEdge;
void main() {
  vLocal = aPos;
  vNormal = aNormal;
  vEdge = aEdge;
  gl_Position = uVP * vec4(uRot * aPos + uPos, 1.0);
}`;

export const crystalFs = (faces: number, height: number) => `${HEAD}
#define FACES ${faces}
const float HEIGHT = ${f(height)};
const vec3 SUN = ${v3(SUN)};
const float IOR = ${f(SCENE.ior)};
const float SPREAD = ${f(SCENE.spread * 0.15)};
const int MILK_STEPS = 6;
const vec3 WIN_W = ${v3(W)};
const vec3 WIN_U = ${v3(U)};
const vec3 WIN_V = ${v3(V)};
uniform sampler2D uWall;
uniform vec2 uHalf;
uniform vec4 uPlanes[FACES];
uniform mat3 uRot;
uniform vec3 uPos;
uniform vec3 uEye; // camera, in the crystal's frame
// loop bounds from uniforms, so the d3d compiler keeps the loops instead of unrolling them
uniform int uFaces;
uniform int uBounces;
in vec3 vLocal;
flat in vec3 vNormal;
in float vEdge;
out vec4 o;

float box(float x, float a, float b, float s) {
  return smoothstep(a - s, a + s, x) * (1.0 - smoothstep(b - s, b + s, x));
}

// the room behind you: pale walls, a darker floor, the window and the sun in it
vec3 room(vec3 d) {
  vec3 c = mix(vec3(0.33, 0.325, 0.32), vec3(0.86, 0.84, 0.8), smoothstep(-0.45, 0.45, d.y));
  // a dark doorway and a bright far wall, so turning faces always have something to find
  c *= 1.0 - 0.55 * box(d.x, -0.75, -0.5, 0.01) * step(d.y, 0.35);
  c += vec3(0.25, 0.24, 0.22) * smoothstep(0.3, 0.9, d.x);
  float a = dot(d, WIN_W);
  if (a > 0.05) {
    vec2 uv = vec2(dot(d, WIN_U), dot(d, WIN_V)) / a;
    float w = box(uv.x, -0.42, 0.42, 0.02) * box(uv.y, -0.55, 0.75, 0.02);
    w *= 1.0 - box(uv.x, 0.0, 0.05, 0.01) * 0.85;
    c = mix(c, vec3(1.45, 1.4, 1.3), w);
    float r2 = dot(uv, uv);
    c += vec3(1.0, 0.95, 0.85) * (exp(-r2 * 1400.0) * 22.0 + exp(-r2 * 60.0) * 0.5);
  }
  return c;
}

// the wall behind the crystal, frosted to a blur, blended into the room across its far edge
vec3 env(vec3 p, vec3 d, float blur) {
  vec3 r = room(d);
  if (d.z > 0.1) return r;
  vec2 w = p.xy + d.xy * (-p.z / min(d.z, -1e-3));
  vec3 wall = textureLod(uWall, w / uHalf * 0.5 + 0.5, blur).rgb;
  return mix(wall, r, smoothstep(-0.1, 0.1, d.z));
}

// MILK
// natural quartz: clouds of tiny inclusions and thin fracture veils, thick toward the top
// and in patches, thinning out to a clear tip
float hash3(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float noise3(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x),
      mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x),
      mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
// density and how much of it is bright fracture
float sheet(vec3 p, vec3 dir, float k, float w) {
  // a crack: a thin warped plane, broken up so it only runs part way through
  float x = dot(p, dir) * k + (noise3(p * 18.0) - 0.5) * 1.6;
  float l = 1.0 - smoothstep(0.0, w, abs(fract(x) - 0.5));
  return l * smoothstep(0.45, 0.7, noise3(p * 11.0 + dir * 5.0));
}
vec2 milk(vec3 p) {
  float h = clamp(-p.y / HEIGHT, 0.0, 1.0);
  float grain = noise3(p * 140.0) * 0.5 + noise3(p * 60.0 + 4.0) * 0.5;
  float cloud = smoothstep(0.45, 0.75, noise3(p * 20.0) * 0.6 + grain * 0.4);
  // feathery veils: wide soft cracks frayed by the grain
  float veil = sheet(p, vec3(0.6, 0.55, 0.58), 9.0, 0.17) + sheet(p, vec3(-0.7, 0.3, 0.65), 7.0, 0.14);
  veil *= 0.35 + grain;
  float patchy = smoothstep(0.3, 0.75, noise3(p * 7.0 + 2.0));
  float body = max(1.0 - smoothstep(0.05, 0.45, h), patchy * 0.8);
  body *= 1.0 - 0.9 * smoothstep(0.6, 0.95, h); // the tip runs clear
  return vec2((cloud * 0.9 + veil * 2.2) * body, min(veil, 1.0) * body);
}

void main() {
  vec3 n = normalize(vNormal);
  vec3 i = normalize(vLocal - uEye);
  float c = clamp(-dot(i, n), 0.0, 1.0);
  float fr = 0.045 + 0.955 * pow(1.0 - c, 5.0);
  vec3 pw = uRot * vLocal + uPos;
  vec3 col = env(pw, uRot * reflect(i, n), 0.0) * fr;

  // INSIDE
  // the view ray refracts in and crosses the stone once through the milk, then leaves for the
  // frosted wall, or bounces once more where it cannot
  float near = 1.0 - smoothstep(0.0, 0.45, vEdge);
  vec3 IORS = IOR + vec3(-1.0, 0.0, 1.0) * SPREAD * (1.0 + near);
  vec3 d = refract(i, n, 1.0 / IOR);
  vec3 p = vLocal;
  vec3 through = vec3(0.0);
  float tau = 0.0;
  float glow = 0.0;
  for (int b = 0; b < uBounces; b++) {
    float tmin = 1e3;
    vec3 m = n;
    for (int j = 0; j < uFaces; j++) {
      vec4 pl = uPlanes[j];
      float dn = dot(d, pl.xyz);
      if (dn > 1e-4) {
        float t = (pl.w - dot(p, pl.xyz)) / dn;
        if (t < tmin) {
          tmin = t;
          m = pl.xyz;
        }
      }
    }
    tmin = max(tmin, 0.0);
    if (b == 0) {
      // march the first crossing through the milk, light scattered toward you as you go
      float dt = tmin / float(MILK_STEPS);
      for (int k = 0; k < MILK_STEPS; k++) {
        vec2 mk = milk(p + d * dt * (float(k) + 0.5));
        float dens = mk.x * dt * 22.0; // change how cloudy here
        glow += exp(-tau) * (1.0 - exp(-dens)) * (0.9 + 0.6 * mk.y);
        tau += dens;
      }
    }
    p += d * tmin;
    float ci = dot(d, m);
    float k = 1.0 - IOR * IOR * (1.0 - ci * ci);
    if (k > 0.0 || b == uBounces - 1) {
      vec3 q = uRot * p + uPos;
      float blur = 0.8 + 3.0 * min(tau, 1.0);
      vec3 r = refract(d, -m, IORS.r);
      vec3 g = refract(d, -m, IORS.g);
      vec3 bl = refract(d, -m, IORS.b);
      vec3 back = env(q, uRot * reflect(d, -m), blur) * 0.6;
      through.r = dot(r, r) > 0.0 ? env(q, uRot * r, blur).r : back.r;
      through.g = dot(g, g) > 0.0 ? env(q, uRot * g, blur).g : back.g;
      through.b = dot(bl, bl) > 0.0 ? env(q, uRot * bl, blur).b : back.b;
      break;
    }
    d = reflect(d, m);
  }
  // the clear stone shows the wall bent and a shade darker, never brighter than the milk
  through = mix(through, vec3(dot(through, vec3(0.3, 0.5, 0.2))), 0.3) * 0.72;
  // the milk is lit by the sun from inside: brighter on the faces that see it
  float sunny = 0.8 + 0.35 * max(dot(uRot * n, -SUN), 0.0);
  vec3 milkC = vec3(1.04, 1.03, 1.01) * sunny;
  float h = fract(sin(dot(n, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  vec3 inner = through * exp(-tau) * mix(0.88, 1.04, h) + milkC * glow;
  col += inner * (1.0 - fr);

  // a polished bright line where two faces meet
  float e = 1.0 - smoothstep(0.0, fwidth(vEdge) * 0.9, vEdge);
  col += e * (0.1 + 0.45 * fr);
  // photo contrast without crushing: mids stay clear, highlights roll off
  vec3 cc = clamp(col, 0.0, 1.0);
  col = mix(col, cc * cc * (3.0 - 2.0 * cc), 0.55);
  col = col / (1.0 + 0.18 * max(col - 0.85, 0.0));
  o = vec4(col, 1.0);
}`;
