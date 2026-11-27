import { FELT, MAX_COCOONS, SHELL } from "./scene";

const f = (n: number) => n.toFixed(4);
const N = MAX_COCOONS;

// COMMON
// world y up, z toward the viewer; uCo x, y, depth, scale; uCr cos, sin of tilt, yaw, dim
const COMMON = `
const float PI = 3.14159265;
const float SR = ${f(SHELL.r)};
const float SH = ${f(SHELL.h)};
const float SP = ${f(SHELL.p)};
const int MAXC = ${N};

uniform vec4  uView;
uniform int   uN;
uniform vec4  uCo[${N}];
uniform vec4  uCr[${N}];
// SLOTS
// strands seeded by cocoon id, not depth slot, so turning never reshuffles them
uniform int   uId[${N}];
uniform int   uSlot[${N}];
uniform vec3  uKeyW;
uniform vec4  uTorchW;
uniform vec4  uTorchDW;

uint hash(uint x) {
  x ^= x >> 16; x *= 0x7feb352du;
  x ^= x >> 15; x *= 0x846ca68bu;
  x ^= x >> 16;
  return x;
}
float rnd(inout uint s) {
  s = hash(s);
  return float(s) * (1.0 / 4294967295.0);
}
float h3(ivec3 p) {
  return float(hash(uint(p.x) * 1597334677u ^ uint(p.y) * 3812015801u ^ uint(p.z) * 2798796415u))
    * (1.0 / 4294967295.0);
}
float vnoise(vec3 p) {
  ivec3 i = ivec3(floor(p));
  vec3 u = fract(p);
  u = u * u * (3.0 - 2.0 * u);
  return mix(
    mix(mix(h3(i), h3(i + ivec3(1, 0, 0)), u.x),
        mix(h3(i + ivec3(0, 1, 0)), h3(i + ivec3(1, 1, 0)), u.x), u.y),
    mix(mix(h3(i + ivec3(0, 0, 1)), h3(i + ivec3(1, 0, 1)), u.x),
        mix(h3(i + ivec3(0, 1, 1)), h3(i + ivec3(1, 1, 1)), u.x), u.y), u.z);
}
// CLUMP
// billowed noise for felt density
float clump(vec3 q) {
  float a = abs(vnoise(q * 11.0) * 2.0 - 1.0);
  float b = abs(vnoise(q * 27.0 + 7.1) * 2.0 - 1.0);
  return 1.0 - (0.62 * a + 0.38 * b);
}

float shellR(float y) {
  float k = clamp(abs(y) / SH, 0.0, 1.0);
  float b = SR * pow(max(1.0 - pow(k, SP), 0.0), 1.0 / SP);
  float w = y / (0.32 * SH);
  return b * (1.0 - ${f(SHELL.waist)} * exp(-w * w)) * (1.0 - ${f(SHELL.egg)} * (y / SH));
}
vec3 surf(float phi, float y) {
  float r = shellR(y);
  return vec3(r * sin(phi), y, r * cos(phi));
}
vec3 surfN(float phi, float y) {
  float dr = (shellR(y + 0.002) - shellR(y - 0.002)) / 0.004;
  return normalize(vec3(sin(phi), -dr, cos(phi)));
}
// POLE
// wraps a path past a tip over onto the far side
vec2 pole(float phi, float y) {
  if (y > SH) return vec2(phi + PI, 2.0 * SH - y);
  if (y < -SH) return vec2(phi + PI, -2.0 * SH - y);
  return vec2(phi, y);
}

// THE CURRENT COCOON
int   gI = -1;
int   gId = 0;
vec2  gC = vec2(0.0);
float gZ = 0.0;
float gS = 1.0;
vec2  gTilt = vec2(1.0, 0.0);
float gYaw = 0.0;
float gDim = 1.0;
vec3  gKey;
vec4  gTorch;
vec4  gTorchD;

vec2 rot(vec2 v, vec2 cs) { return vec2(cs.x * v.x - cs.y * v.y, cs.y * v.x + cs.x * v.y); }
vec2 unrot(vec2 v, vec2 cs) { return vec2(cs.x * v.x + cs.y * v.y, -cs.y * v.x + cs.x * v.y); }

void useCocoon(int i) {
  gI = i;
  gId = uId[i];
  vec4 co = uCo[i];
  vec4 cr = uCr[i];
  gC = co.xy;
  gZ = co.z;
  gS = co.w;
  gTilt = cr.xy;
  gYaw = cr.z;
  gDim = cr.w;
  gKey = vec3(unrot(uKeyW.xy, gTilt), uKeyW.z);
  gTorch = vec4(unrot(uTorchW.xy - gC, gTilt) / gS, (uTorchW.z - gZ) / gS, uTorchW.w);
  gTorchD = vec4(unrot(uTorchDW.xy, gTilt), uTorchDW.z, uTorchDW.w);
}
void useWorld() {
  gI = -1;
  gC = vec2(0.0);
  gZ = 0.0;
  gS = 1.0;
  gTilt = vec2(1.0, 0.0);
  gYaw = 0.0;
  gDim = 1.0;
  gKey = uKeyW;
  gTorch = uTorchW;
  gTorchD = uTorchDW;
}
vec2 toWorld(vec2 o) { return gC + rot(o, gTilt) * gS; }
vec2 toObj(vec2 w) { return unrot(w - gC, gTilt) / gS; }

float hiddenBy(vec2 w, float z, int after) {
  float h = 0.0;
  for (int j = 0; j < MAXC; j++) {
    if (j >= uN) break;
    if (j <= after) continue;
    vec4 co = uCo[j];
    vec2 o = unrot(w - co.xy, uCr[j].xy) / co.w;
    if (abs(o.y) >= SH) continue;
    float r = shellR(o.y);
    float zf = co.z + sqrt(max(r * r - o.x * o.x, 0.0)) * co.w;
    h = max(h, smoothstep(0.0, 0.01, r - abs(o.x)) * step(z, zf));
  }
  return h;
}
`;

// LIGHT
// key high left, dim fill, hover torch as a cone
const LIGHT = `
float spot(vec3 p, out vec3 l) {
  vec3 dl = gTorch.xyz - p;
  l = normalize(dl);
  return gTorch.w * pow(smoothstep(gTorchD.w, 1.0, dot(-l, gTorchD.xyz)), 1.6);
}

// SILK FIBRE
// kajiya-kay glint plus forward scatter when backlit
float glint(vec3 t, vec3 l) {
  vec3 h = normalize(l + vec3(0.0, 0.0, 1.0));
  float th = dot(t, h);
  return pow(sqrt(max(1.0 - th * th, 0.0)), 90.0);
}
float hairLit(vec3 p, vec3 t) {
  float kn = length(gKey);
  vec3 k = gKey / max(kn, 1e-4);
  float tk = dot(t, k);
  float key = kn * (sqrt(max(1.0 - tk * tk, 0.0)) * (0.35 + 0.65 * max(k.z, 0.0)) + 0.9 * glint(t, k));
  vec3 l;
  float sp = spot(p, l);
  float tt = dot(t, l);
  float fwd = pow(max(-l.z, 0.0), 1.5);
  // BACKLIT
  // shell shadows strands over its face; only the outline transmits
  if (gI >= 0) {
    float back = smoothstep(0.0, 0.6, gTorchD.z);
    float open = smoothstep(-0.012, 0.006, abs(p.x) - shellR(p.y)) + step(SH, abs(p.y));
    sp *= mix(1.0, open, back * step(0.0, p.z));
  }
  float torch = sp * (sqrt(max(1.0 - tt * tt, 0.0)) * 0.5 + 2.2 * glint(t, l) + 1.6 * fwd);
  return (0.03 + 0.8 * key + torch) * gDim;
}
`;

// STRANDS
// one strip per fibre from gl_VertexID, degenerate joins; uStart offsets each cocoon run
const STRAND = `
uniform int   uSeg;
uniform float uPx;
uniform float uWide;
uniform float uWeight;
uniform float uTime;
uniform int   uStart[${N + 1}];
uniform float uInstW[${N}];
uniform int   uHero;

out float vT;
out float vR;
out float vAcross;
out float vW;

int fibre;
float t;
float side;
float thick = 1.0;
float weight = 1.0;

void strand() {
  int v = 2 * uSeg + 4;
  int id = gl_VertexID;
  int g = id / v;
  int k = id - g * v;
  int j = clamp(k - 1, 0, 2 * uSeg + 1);
  t = float(j >> 1) / float(uSeg);
  side = (j & 1) == 0 ? -1.0 : 1.0;
  int c = 0;
  for (int i = 1; i <= MAXC; i++) {
    if (i > uN) break;
    if (g >= uStart[i]) c = i;
  }
  c = min(c, uN - 1);
  fibre = g - uStart[c];
  useCocoon(c);
  weight = uWeight * uInstW[c];
  vT = t;
  vR = float(hash(uint(g) + 7u) & 1023u) / 1023.0;
}

void cull() {
  gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
  vAcross = 0.0;
  vW = 0.0;
}

// HAIR STRIP
// sized in device px so it stays one fibre wide
void placeW(vec2 wa, vec2 wb) {
  vec2 d = wb - wa;
  float l = length(d);
  vec2 n = l > 1e-9 ? vec2(-d.y, d.x) / l : vec2(0.0, 1.0);
  vec2 w = wa + n * side * uPx * uWide * thick;
  gl_Position = vec4((w - uView.xy) / uView.zw, 0.0, 1.0);
  vAcross = side;
}
void place(vec3 a, vec3 b) { placeW(toWorld(a.xy), toWorld(b.xy)); }
float occluded(vec3 p) { return hiddenBy(toWorld(p.xy), gZ + p.z * gS, gI); }
`;

// FELT
// figure-eight filaments on the shell; tint only: lit near the face, shade deeper
export const FELT_VS = `#version 300 es
precision highp float;
precision highp int;
${COMMON}
${STRAND}

out float vSurf;

struct Path { float phi, y, len, th, amp, turns, ph, wig, lift, r0; };

vec3 at(Path q, float u) {
  float s = (u - 0.5) * q.len;
  float a = q.turns * 2.0 * PI * u + q.ph;
  float x = s + q.amp * sin(a);
  float y = q.amp * sin(2.0 * a) * 0.5 + q.wig * sin(3.1 * a + q.ph);
  float c = cos(q.th), n = sin(q.th);
  vec2 o = vec2(c * x - n * y, n * x + c * y);
  vec2 g = pole(q.phi + o.x / q.r0 + gYaw, q.y + o.y);
  return surf(g.x, g.y) * (1.0 + q.lift * sin(PI * u));
}

void main() {
  strand();
  vSurf = 0.0;
  uint s = uint(fibre) * 747796405u + 2891336453u + uint(gId) * 2654435761u;
  Path q;
  q.phi = rnd(s) * 2.0 * PI;
  q.y = (rnd(s) * 2.0 - 1.0) * SH * 0.985;
  q.len = mix(${f(FELT.len[0])}, ${f(FELT.len[1])}, rnd(s));
  q.r0 = max(shellR(q.y), 0.025);
  vec3 anchor = surf(q.phi, q.y);
  vec3 seen = surf(q.phi + gYaw, q.y);
  if (seen.z < -0.06) { cull(); return; }
  q.th = rnd(s) * 2.0 * PI;
  q.turns = mix(0.6, 2.2, rnd(s));
  q.amp = q.len * mix(0.06, 0.2, rnd(s));
  q.ph = rnd(s) * 2.0 * PI;
  q.wig = q.len * 0.025 * rnd(s);
  q.lift = 0.006 * rnd(s) * rnd(s);
  float k = rnd(s);
  thick = 0.6 + 1.0 * k * k * k;
  float depth = rnd(s);
  vSurf = (1.0 - depth) * (1.0 - depth);

  float du = 0.35 / float(uSeg);
  vec3 p = at(q, t);
  vec3 b = t > 0.999 ? 2.0 * p - at(q, t - du) : at(q, t + du);
  place(p, b);

  float dense = mix(0.5, 1.5, clump(anchor));
  float area = clamp(q.r0 / SR * 1.3, 0.45, 1.0);
  float face = p.z / max(shellR(p.y), 0.02);
  // TIPS
  // fade strands that would converge into a star
  float tip = 1.0 - smoothstep(SH * 0.8, SH * 0.98, abs(p.y));
  vW = weight * dense * area * tip * smoothstep(-0.02, 0.15, face) * mix(0.5, 1.0, rnd(s));
  vW *= 1.0 - occluded(p);
}
`;

// FLOSS AND FUZZ
// floss: contour fibres near the shell; fuzz: curl mat off the wall; mostly faint haze
const HAIR = (fuzz: boolean) => `#version 300 es
precision highp float;
precision highp int;
${COMMON}
${LIGHT}
${STRAND}

out float vLit;

void main() {
  strand();
  vLit = 0.0;
  uint s = uint(fibre) * ${fuzz ? "1103515245u + 12345u" : "2654435761u + 1013904223u"} + uint(gId) * 3266489917u;
  float phi = rnd(s) * 2.0 * PI;
  float y0 = (rnd(s) * 2.0 - 1.0) * SH * 0.97;
  float far = rnd(s);
  bool stray = ${fuzz ? "false" : "gI == uHero && fibre < 2"};
  float lift = ${fuzz ? "mix(0.001, 0.007, far * far)" : "stray ? mix(0.03, 0.05, far) : mix(0.003, 0.022, far * far)"};
  float len = ${fuzz ? "mix(0.006, 0.02, rnd(s))" : "stray ? mix(0.16, 0.22, rnd(s)) : mix(0.04, 0.11, rnd(s))"};
  float turns = ${fuzz ? "mix(0.6, 2.0, rnd(s))" : "stray ? mix(0.8, 1.2, rnd(s)) : mix(0.2, 0.7, rnd(s))"};
  float th = ${fuzz ? "rnd(s) * 2.0 * PI" : "PI * 0.5 + (rnd(s) - 0.5) * 0.9"};
  float ph = rnd(s) * 2.0 * PI;
  float tw = rnd(s) * 2.0 * PI;
  float r0 = max(shellR(y0), 0.03);
  float c = cos(th), n = sin(th);
  float du = 0.35 / float(uSeg);
  thick = mix(0.5, 1.0, rnd(s)) * (stray ? 1.3 : 1.0);
  bool lone = stray || rnd(s) < ${fuzz ? "0.05" : "0.1"};
  // DEFOCUS
  // further off the shell: wider and softer, same energy
  float soft = 1.0 + 2.0 * smoothstep(0.004, 0.03, lift);
  thick *= soft;

  vec3 p, b;
  for (int i = 0; i < 2; i++) {
    float u = i == 0 ? t : t + du;
    float h = lift * sin(PI * mix(0.12, 1.0, u));
    float drift = sin(uTime * (0.21 + 0.03 * ph) + ph) * (stray ? 0.6 : 0.15);
    float a = turns * 2.0 * PI * u + ph + drift * u;
    float curl = len * ${fuzz ? "0.16" : "0.07"} / max(turns, 0.5);
    float crimp = len * (0.01 * sin(u * 11.0 + ph) + 0.004 * sin(u * 23.0 + tw));
    float x = (u - 0.5) * len + curl * sin(a) + crimp;
    float yy = curl * cos(a + tw);
    vec2 o = vec2(c * x - n * yy, n * x + c * yy);
    vec2 g = pole(phi + o.x / r0 + gYaw, y0 + o.y);
    float hh = h + curl * 0.5 * sin(a * 0.7 + tw) + crimp * 0.4 + 0.001;
    vec3 q = surf(g.x, g.y) + surfN(g.x, clamp(g.y, -SH * 0.985, SH * 0.985)) * max(hh, 0.0005);
    if (i == 0) p = q; else b = q;
  }
  place(p, b);

  float hid = smoothstep(0.006, 0.014, shellR(p.y) - abs(p.x)) * (1.0 - smoothstep(-0.006, 0.0, p.z));
  ${
    fuzz
      ? `// edge on, the mat piles up in projection: thin it there so the outline is not a band
  float nz = abs(surfN(phi + gYaw, y0).z);
  float dense = mix(0.2, 1.8, clump(surf(phi, y0) * 1.7)) * mix(0.3, 1.0, smoothstep(0.0, 0.45, nz));`
      : "float dense = 1.0;"
  }
  vW = weight * (1.0 - hid) * dense * mix(0.4, 1.0, rnd(s)) * (stray ? 2.0 : lone ? 1.0 : 0.16) / soft;
  vW *= 1.0 - occluded(p);
  vLit = hairLit(p, normalize(b - p + 1e-6));
}
`;
export const FLOSS_VS = HAIR(false);
export const FUZZ_VS = HAIR(true);

// WEB
// to the gather point, a few between neighbours, one thread up out of frame
export const WEB_VS = `#version 300 es
precision highp float;
precision highp int;
${COMMON}
${LIGHT}
${STRAND}

uniform vec2 uGather;
out float vLit;

vec3 onCocoon(int i, inout uint s, float lo, float hi) {
  useCocoon(i);
  float phi = rnd(s) * 2.0 * PI;
  float y = SH * mix(lo, hi, rnd(s));
  vec3 p = surf(phi + gYaw, y) * 1.02;
  return vec3(toWorld(p.xy), gZ + p.z * gS);
}

void main() {
  strand();
  int g = gl_VertexID / (2 * uSeg + 4);
  uint s = uint(g) * 3266489917u + 374761393u;
  vec3 gather = vec3(uGather + vec2(0.006 * sin(uTime * 0.23), 0.0), -0.5);
  vec3 a, z;
  float sag;
  if (g < 2) {
    a = gather;
    z = vec3(uGather.x + 0.02 + (rnd(s) - 0.5) * 0.01, 3.2, -0.5);
    sag = 0.0;
    thick = 1.2;
  } else {
    int id = int(rnd(s) * float(uN)) % uN;
    a = onCocoon(uSlot[id], s, -0.2, 0.9);
    if (rnd(s) < 0.3) {
      int other = (id + 1 + int(rnd(s) * float(uN - 1))) % uN;
      z = onCocoon(uSlot[other], s, -0.6, 0.6);
      sag = 0.04;
    } else {
      z = gather + vec3((rnd(s) - 0.5) * 0.04, (rnd(s) - 0.5) * 0.03, (rnd(s) - 0.5) * 0.1);
      sag = mix(0.01, 0.05, rnd(s));
    }
    thick = mix(0.5, 0.9, rnd(s));
  }
  useWorld();
  float f1 = 0.25 + rnd(s) * 0.3;
  float f2 = rnd(s) * 6.0;
  float w1 = rnd(s) * 6.0;
  vec3 p, b;
  for (int i = 0; i < 2; i++) {
    float u = i == 0 ? t : t + 0.4 / float(uSeg);
    float e = g < 2 ? u * u : u;
    vec3 q = mix(a, z, e);
    q.y -= sag * sin(PI * e);
    q.x += 0.004 * sin(uTime * f1 + f2 + e * 3.0) * sin(PI * e) + 0.0015 * sin(e * 37.0 + w1);
    q.z += 0.002 * sin(e * 29.0 + f2);
    if (i == 0) p = q; else b = q;
  }
  placeW(p.xy, b.xy);
  float h = 0.0;
  for (int j = 0; j < MAXC; j++) {
    if (j >= uN) break;
    vec4 co = uCo[j];
    vec2 o = unrot(p.xy - co.xy, uCr[j].xy) / co.w;
    if (abs(o.y) >= SH) continue;
    float r = shellR(o.y);
    float zf = co.z + sqrt(max(r * r - o.x * o.x, 0.0)) * co.w;
    h = max(h, smoothstep(0.0, 0.01, r - abs(o.x)) * step(p.z, zf - 0.02));
  }
  vW = weight * (1.0 - h) * (g < 2 ? 1.4 : mix(0.25, 0.7, rnd(s)));
  vLit = hairLit(p, normalize(b - p + 1e-6));
}
`;

export const FELT_FS = `#version 300 es
precision highp float;
in float vAcross;
in float vW;
in float vSurf;
uniform float uOut;
out vec4 o;
void main() {
  float c = (1.0 - abs(vAcross)) * vW * uOut;
  o = vec4(c, 0.0, 0.0, c * vSurf);
}
`;

export const HAIR_FS = `#version 300 es
precision highp float;
in float vAcross;
in float vW;
in float vLit;
in float vT;
in float vR;
uniform float uOut;
uniform float uSpark;
uniform float uTime;
out vec4 o;
void main() {
  float x = exp(-vAcross * vAcross * 3.0);
  float along = smoothstep(0.0, 0.12, vT) * (1.0 - smoothstep(0.85, 1.0, vT));
  along *= 0.45 + 0.55 * (0.5 + 0.5 * sin(vT * (7.0 + 9.0 * vR) + vR * 40.0));
  float c = x * along * vW * uOut;
  // SPARKLE
  float sp = pow(max(sin(vT * 900.0 + vR * 60.0 + uTime * 0.7) * sin(vT * 370.0 - uTime * 0.4), 0.0), 24.0);
  o = vec4(0.0, c * vLit * (1.0 + uSpark * 7.0 * sp), c, 0.0);
}
`;

export const FULL_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`;

// SILK
// matte felt, satin sheen, wrap light, crevice shadow, backlit transmission
export const SILK_FS = `#version 300 es
precision highp float;
precision highp int;
${COMMON}
${LIGHT}

uniform sampler2D uDens;
uniform vec2  uRes;
uniform float uPx;
uniform float uDensK;
uniform float uSeed;

out vec4 o;

uniform vec3 uBg;
uniform vec2 uSweep;
const vec3 SILK = vec3(0.9, 0.89, 0.86);
const vec3 WARM = vec3(1.0, 0.9, 0.76);
const vec3 KEY_C = vec3(1.0, 0.93, 0.82);
const vec3 TORCH_C = vec3(1.0, 0.92, 0.8);
const vec3 FILL_C = vec3(0.7, 0.76, 0.86);
const vec3 WALL_KEY = vec3(1.0, 0.9, 0.76);
const vec3 WALL_FILL = vec3(0.42, 0.44, 0.48);

// CLUMPS
// summed blobs on a jittered grid, merging like cauliflower; returns height and slope
vec3 dome(vec2 p, float freq, float amp, float sharp) {
  p *= freq;
  vec2 i = floor(p);
  vec2 f = p - i;
  vec3 sum = vec3(0.0);
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 g = vec2(float(x), float(y));
      uint h = hash(uint(int(i.x) + x) * 1597334677u ^ uint(int(i.y) + y) * 3812015801u);
      vec2 j = vec2(float(h & 0xffffu), float(h >> 16)) * (1.0 / 65535.0);
      float size = 0.7 + 0.6 * float((h >> 7) & 255u) / 255.0;
      vec2 d = f - g - (0.1 + 0.8 * j);
      float k = sharp / (size * size);
      float e = exp(-dot(d, d) * k) * size;
      sum += vec3(e, -2.0 * k * e * d);
    }
  }
  return vec3(sum.x * amp, sum.yz * freq * amp);
}

float ridge(vec2 p) {
  // ROTATE
  // off the noise grid so cells never align into blocks
  vec2 q = mat2(0.8, -0.6, 0.6, 0.8) * p;
  float a = 1.0 - abs(vnoise(vec3(q, 0.37 * q.x)) * 2.0 - 1.0);
  float b = 1.0 - abs(vnoise(vec3(mat2(0.6, 0.8, -0.8, 0.6) * p * 2.1, 2.0 + 0.29 * p.y)) * 2.0 - 1.0);
  return a * a * 0.7 + b * b * 0.3;
}

vec3 shoulder(vec3 x) {
  // TONEMAP
  // soft shoulder above 0.45 so the brightest felt never clips
  return mix(x, 0.45 + 0.47 * (1.0 - exp(-(x - 0.45) / 0.47)), step(0.45, x));
}

// SHELL
// one cocoon's colour and pixel coverage
vec4 shell(vec2 w, vec4 dens) {
  vec2 ob = toObj(w);
  if (abs(ob.y) > SH + 0.02 || abs(ob.x) > SR + 0.02) return vec4(0.0);
  float px = uPx / gS;
  float r = shellR(ob.y);
  float zf = sqrt(max(r * r - ob.x * ob.x, 0.0));
  vec3 p = vec3(ob, zf);
  float cy = cos(gYaw), sy = sin(gYaw);
  vec3 q = vec3(cy * p.x - sy * p.z, p.y, sy * p.x + cy * p.z);
  float cl = clump(q);

  vec2 uv = vec2(atan(q.x, q.z) * SR, q.y);
  vec3 huge = dome(uv - 1.7, 11.0, 0.0035, 3.0);
  vec3 big = dome(uv, 36.0, 0.0018 * (0.7 + 0.6 * cl), 3.2);

  float edge = 0.004 * (cl - 0.5) + huge.x + 1.6 * big.x - 0.004;
  float inside = abs(ob.y) < SH ? r - abs(ob.x) + edge : -1.0;
  float fray = 0.004 * (1.0 - exp(-dens.r * 0.9)) - 0.003;
  float a = clamp((inside + fray) / px + 0.5, 0.0, 1.0) * smoothstep(-0.001, 0.0035, inside + fray * 0.5);
  if (a <= 0.0) return vec4(0.0);

  float dr = (shellR(ob.y + 0.002) - shellR(ob.y - 0.002)) / 0.004;
  vec3 n = normalize(vec3(ob.x, -r * dr, max(zf, 1e-4)));

  // CRINKLES
  // ridged warped noise, faded before it is fine enough to alias
  vec2 rw = uv * 52.0 + 0.6 * vec2(vnoise(vec3(uv * 18.0, 1.3)), vnoise(vec3(uv * 18.0, 4.1)));
  float r0 = ridge(rw);
  float e = 0.04;
  float fine = 1.0 - smoothstep(0.004, 0.009, px);
  vec2 rg = vec2(ridge(rw + vec2(e, 0.0)) - r0, ridge(rw + vec2(0.0, e)) - r0) / e * 52.0 * 0.0007 * fine;
  vec2 slope = huge.yz * 0.3 + big.yz * 0.8 + rg;
  vec3 tu = normalize(vec3(p.z, 0.0, -p.x) + vec3(1e-5, 0.0, 0.0));
  vec3 tv = normalize(cross(n, tu));
  float grazing = smoothstep(0.08, 0.45, n.z);
  vec3 nb = normalize(n - (tu * slope.x + tv * slope.y) * grazing);
  float ao = mix(0.9, 1.0, clamp(huge.x / 0.0035, 0.0, 1.0)) * mix(0.86, 1.0, clamp(big.x / 0.0018, 0.0, 1.0));
  ao *= mix(0.9, 1.0, cl);

  // KEY
  // dims while the torch is on: whole lobe, wrap included
  float kn = length(gKey);
  float nk = dot(nb, gKey / max(kn, 1e-4));
  float wrap = max((nk + 0.75) / 1.75, 0.0) * kn;
  float lam = max(nk, 0.0) * 1.12 * kn;
  vec3 sss = WARM * (wrap - lam) * 0.55;
  vec3 key = KEY_C * (lam * 0.55 + wrap * 0.65 + sss * 0.4) * 1.38;

  // FILL
  vec3 fill = FILL_C * (0.16 + 0.06 * nb.y + 0.06 * nb.z);

  // TORCH
  vec3 l;
  float fall = spot(p, l);
  vec3 nr = normalize(n - (tu * slope.x + tv * slope.y) * grazing * 2.2);
  float nt = dot(nr, l);
  vec3 torch = TORCH_C * fall * (max(nt, 0.0) + WARM * (max((nt + 0.35) / 1.35, 0.0) - max(nt, 0.0)) * 0.5);

  // SHEEN
  // velvet rim, faded before the outline
  float rim = pow(1.0 - max(nb.z, 0.0), 3.0) * smoothstep(0.08, 0.35, n.z);
  vec3 sheen = KEY_C * rim * 0.18 * max(nk + 0.3, 0.0) * kn;

  // STRANDS
  float face = 1.0 - exp(-dens.a * 0.8);
  float deep = 1.0 - exp(-max(dens.r - dens.a, 0.0) * 0.35);
  float strands = 1.0 + 0.25 * face - 0.15 * deep;

  vec3 albedo = SILK * mix(vec3(1.0), WARM, 0.12 * (1.0 - ao));

  // THROUGH
  // backlit: only the thin outer felt transmits, fading inward
  float back = smoothstep(0.0, 0.6, gTorchD.z);
  float thick = 0.2 + 3.2 * n.z + 2.2 * cl * cl + 0.8 * (1.0 - ao) + 0.5 * deep;
  float lip = smoothstep(0.0, 0.12, n.z);
  vec3 through = WARM * fall * back * 3.2 * exp(-thick * 1.5) * lip;

  // SATIN
  vec3 hk = normalize(gKey + vec3(0.0, 0.0, max(kn, 1e-3)));
  float satin = pow(max(dot(nb, hk), 0.0), 8.0) * 0.06 * kn;

  vec3 lit = albedo * (key + fill + torch) * ao * strands + (sheen + KEY_C * satin) * ao + through;
  lit = mix(uBg * 0.8, lit, gDim);
  return vec4(lit, a);
}

// WALL
// plaster wall behind the cluster: key and torch pools, soft cast shadows
const float WALL_Z = -0.85;

// SHADOW SHAPE
// smooth egg proxy for the shell: continuous distance, no seam at the tips
float shadowDist(vec2 o) {
  float rx = SR * (1.0 - ${f(SHELL.egg)} * o.y / SH);
  return (1.0 - length(vec2(o.x / rx, o.y / SH))) * SR;
}

// CAST
// only cocoons between wall and light shade it, never through the lamp
float castBy(vec3 W, vec3 dir, float soft, float lightZ) {
  float s = 0.0;
  for (int j = 0; j < MAXC; j++) {
    if (j >= uN) break;
    vec4 co = uCo[j];
    if (co.z <= W.z + 0.01 || co.z >= lightZ - 0.01) continue;
    float d = (co.z - W.z) / max(dir.z, 0.05);
    vec2 P = W.xy + dir.xy * d;
    vec2 o = unrot(P - co.xy, uCr[j].xy) / co.w;
    float sd = shadowDist(o);
    float pen = max(0.006 + soft * d, 0.006) / co.w;
    s = max(s, smoothstep(-pen, pen * 0.6, sd));
  }
  // GRAZING
  // fade very long shadows instead of a hard edge
  return s * smoothstep(0.04, 0.35, dir.z);
}

// STRAND SHADOW
// strand coverage sampled toward the light from the wall point, blurred
float strandShade(vec2 w, vec3 dir) {
  vec2 off = dir.xy * (-0.42 - WALL_Z) / max(dir.z, 0.05);
  vec2 px = (w + off - uView.xy) / uView.zw * 0.5 + 0.5;
  ivec2 c = ivec2(px * uRes);
  ivec2 m = ivec2(uRes) - 1;
  ivec2 r = ivec2(max(2.0, uRes.y * 0.006));
  float b = texelFetch(uDens, clamp(c, ivec2(0), m), 0).b + texelFetch(uDens, clamp(c + ivec2(r.x, r.x / 3), ivec2(0), m), 0).b
    + texelFetch(uDens, clamp(c + ivec2(-r.x / 3, r.x), ivec2(0), m), 0).b + texelFetch(uDens, clamp(c - r, ivec2(0), m), 0).b;
  return 1.0 - exp(-b * uDensK * 0.07);
}

void main() {
  vec2 sc = gl_FragCoord.xy / uRes * 2.0 - 1.0;
  vec2 w = uView.xy + sc * uView.zw;
  vec4 dens = texelFetch(uDens, ivec2(gl_FragCoord.xy), 0) * uDensK;

  // WALL
  useWorld();
  vec3 W = vec3(w, WALL_Z);
  float kn = length(uKeyW);
  vec3 kd = uKeyW / max(kn, 1e-4);
  vec2 pd = (w - uSweep - kd.xy * 0.35) / (uView.w * 1.3);
  float pool = exp(-dot(pd, pd));
  float plaster = (vnoise(vec3(w * 140.0, 0.0)) - 0.5) * 0.035 + (vnoise(vec3(w * 22.0, 3.0)) - 0.5) * 0.04;
  float keyShade = castBy(W, kd, 0.09, 1e3) * 0.55 + strandShade(w, kd) * 0.25;
  vec3 keyWall = WALL_KEY * kn * (0.75 + 0.45 * pool) * (0.45 + 0.55 * max(kd.z, 0.0) / 0.72) * (1.0 - keyShade);
  vec3 l;
  float tw = spot(W, l) * max(l.z, 0.0);
  float torchShade = castBy(W, l, 0.05, uTorchW.z) * 0.7;
  vec3 torchWall = TORCH_C * tw * 1.2 * (1.0 - torchShade);
  // BACKLIGHT
  // torch held behind grazes the wall; cocoons silhouette against it
  float behind = smoothstep(0.0, 0.6, uTorchDW.z);
  // FALLOFF
  // soft inverse square
  vec3 tv = uTorchW.xyz - W;
  float r2 = dot(tv.xy, tv.xy) / 0.16;
  float glowB = 1.0 / (1.0 + r2 * (1.0 + 0.4 * r2));
  torchWall += TORCH_C * uTorchW.w * behind * 0.9 * glowB * (1.0 - castBy(W, normalize(tv), 0.06, uTorchW.z) * 0.6);
  vec3 col = uBg * (1.0 + plaster) * (WALL_FILL + keyWall + torchWall);

  float under = 0.0;
  for (int i = 0; i < MAXC; i++) {
    if (i >= uN) break;
    useCocoon(i);
    // CONTACT SHADOW
    // onto the cocoons already drawn behind this one
    vec2 so = toObj(w - kd.xy * 0.06);
    float sr = shadowDist(so);
    float shade = smoothstep(-0.05, 0.03, sr) * under;
    col *= 1.0 - 0.22 * shade;
    vec4 s = shell(w, dens);
    col = mix(col, s.rgb, s.a);
    under = max(under, s.a);
  }

  // FLOSS AND WEB
  // strands veil what is behind: darker than the wall in shade, brighter where lit
  float cov = 1.0 - exp(-dens.b * 0.35);
  col = col * (1.0 - cov * 0.55) + SILK * KEY_C * (dens.g * 0.45);

  col = shoulder(col);
  col = pow(max(col, 0.0), vec3(1.0 / 2.2));
  float dith = float(hash(uint(gl_FragCoord.x) * 1973u + uint(gl_FragCoord.y) * 9277u + uint(uSeed) * 26699u))
    * (1.0 / 4294967295.0);
  o = vec4(col + (dith - 0.5) / 255.0, 1.0);
}
`;
