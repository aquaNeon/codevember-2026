const HEAD = `#version 300 es
precision highp float;
precision highp int;
`;

export const LEAF_GU = 96;
export const LEAF_GV = 17;
export const TUBE_SIDES = 8;
export const HEAD_RINGS = 9;
export const HEAD_SIDES = 12;
export const FLORETS = 16;

// SHARED
const PAPER = `
uniform vec2  uRes;
uniform float uFade;
uniform vec3  uSun;
uniform vec3  uEye;
uniform float uMask;
uniform float uWarm;
uniform float uStraw;
uniform vec3  uFocus;
uniform float uNear;

// PAPER
// matches the page background so the canvas has no seam
vec3 paper(vec2 frag) {
  vec2 p = vec2(frag.x, uRes.y - frag.y);
  vec2 c = vec2(0.5, 0.38) * uRes;
  vec2 r = vec2(1.2, 0.9) * uRes;
  float t = clamp(length((p - c) / r) / 0.7, 0.0, 1.0);
  return mix(vec3(0.961, 0.945, 0.918), vec3(0.922, 0.898, 0.855), t);
}

// DEPTH OF FIELD
// soil by distance only; elsewhere what stands in front of the plant blurs sooner
float blurSoil(vec3 p) {
  return smoothstep(0.22, mix(1.4, 0.8, uNear), distance(p.xz, uFocus.xz));
}

float blur(vec3 p) {
  vec2 d = p.xz - uFocus.xz;
  float front = max(dot(d, normalize(uEye.xz - uFocus.xz + 1e-4)) - 0.35, 0.0);
  return smoothstep(0.22, mix(1.4, 0.8, uNear), length(d) + front * 1.2);
}

float far(vec3 p) {
  return smoothstep(2.4, 3.6, distance(p.xz, uFocus.xz));
}

float hash12(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
    mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x),
    u.y
  );
}

// LIGHT
// wrapped sun, cool sky fill, back-lit translucency; uWarm shifts with the season
vec3 paint(vec3 albedo, vec3 N, vec3 V, float trans, float ao) {
  float ndl = dot(N, uSun);
  float lit = smoothstep(0.12, 0.95, ndl * 0.5 + 0.5);
  vec3 sky = mix(vec3(0.58, 0.66, 0.74), vec3(0.62, 0.66, 0.72), uWarm);
  vec3 sun = mix(vec3(1.06, 1.04, 0.97), vec3(1.15, 1.03, 0.85), uWarm);
  vec3 c = mix(albedo * sky, albedo * sun, lit) * ao;
  float toward = clamp(-dot(V, uSun) * 0.5 + 0.5, 0.0, 1.0);
  float back = clamp(-ndl, 0.0, 1.0) * (0.25 + 0.75 * toward * toward);
  c += trans * back * albedo * vec3(1.05, 1.1, 0.45);
  return c;
}

vec4 finish(vec3 c) {
  return vec4(mix(paper(gl_FragCoord.xy), c, uFade), 1.0);
}

vec4 finishSoft(vec3 c, float b, float f) {
  return vec4(mix(c, paper(gl_FragCoord.xy), min(1.0, b * 0.72 + f * 0.28)), 1.0);
}
`;

// BACKDROP
export const BG_VS = `${HEAD}
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 1.0, 1.0);
}`;

export const BG_FS = `${HEAD}
${PAPER}
out vec4 o;
void main() {
  o = vec4(paper(gl_FragCoord.xy), 1.0);
}`;

// GROUND
// fbm soil wash over the paper, darker at the edge
export const GROUND_VS = `${HEAD}
layout(location = 0) in vec2 aXZ;
uniform mat4 uViewProj;
uniform vec3 uFocus;
out vec3 vPos;
void main() {
  vPos = vec3(aXZ.x * 4.5 + uFocus.x, 0.0, aXZ.y * 2.6);
  gl_Position = uViewProj * vec4(vPos, 1.0);
}`;

export const GROUND_FS = `${HEAD}
${PAPER}
uniform sampler2D uShadowTex;
in vec3 vPos;
out vec4 o;

float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + 17.0;
    a *= 0.5;
  }
  return s;
}

void main() {
  vec2 g = vPos.xz;
  float n = fbm(g * 4.0);
  float r = abs(g.y) / 0.5 + (n - 0.5) * 0.24;
  float fw = fwidth(r);
  float m = 1.0 - smoothstep(1.0 - fw, 1.0 + fw, r);
  float gran = vnoise(g * 150.0);
  float clod = smoothstep(0.55, 0.85, vnoise(g * 34.0 + 3.0));
  vec3 soil = mix(vec3(0.74, 0.67, 0.57), vec3(0.56, 0.47, 0.38), clamp(n * 0.6 + clod * 0.3, 0.0, 1.0));
  soil *= 0.94 + 0.09 * gran;
  soil *= 1.0 - 0.18 * smoothstep(0.8, 1.0, r);
  float gone = smoothstep(2.2, 4.1, distance(g, uFocus.xz) + (n - 0.5) * 0.3);
  float a = m * (0.42 + 0.18 * n) * (1.0 - 0.7 * blurSoil(vPos)) * (1.0 - gone);
  vec3 c = mix(paper(gl_FragCoord.xy), soil, a);
  // SHADOWS
  // blurred screen-space mask, tinted cool, kept to the soil
  float sh = texture(uShadowTex, gl_FragCoord.xy / uRes).r * (1.0 - far(vPos)) * (1.0 - 0.5 * blurSoil(vPos));
  sh *= 1.0 - smoothstep(0.7, 0.95, r);
  c *= mix(vec3(1.0), mix(vec3(0.8, 0.79, 0.85), vec3(0.6, 0.59, 0.67), m), sh * 0.9);
  o = vec4(c, 1.0);
}`;

// STEMS
// instanced tubes along a spine texture, one per stem, branch or pedicel
export const TUBE_VS = `${HEAD}
uniform highp sampler2D uSpine;
uniform mat4 uViewProj;
uniform int  uRow0;
uniform int  uRings;

uniform vec3  uSun;
uniform float uCast;
vec3 onSoil(vec3 p) {
  if (uCast < 0.5) return p;
  float k = p.y / max(uSun.y, 0.25);
  return vec3(p.x - uSun.x * k, 0.001, p.z - uSun.z * k);
}
out vec3  vPos;
out vec3  vN;
out float vAng;
out float vAlong;
void main() {
  int ring = gl_VertexID / ${TUBE_SIDES + 1};
  int side = gl_VertexID - ring * ${TUBE_SIDES + 1};
  int row = uRow0 + gl_InstanceID;
  vec4 c = texelFetch(uSpine, ivec2(ring, row), 0);
  vec4 a = texelFetch(uSpine, ivec2(max(ring - 1, 0), row), 0);
  vec4 b = texelFetch(uSpine, ivec2(min(ring + 1, uRings - 1), row), 0);
  vec3 T = b.xyz - a.xyz;
  T = dot(T, T) > 1e-14 ? normalize(T) : vec3(0.0, 1.0, 0.0);
  vec3 ref = abs(T.z) < 0.95 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  vec3 b1 = normalize(cross(T, ref));
  vec3 b2 = cross(T, b1);
  float ang = float(side) / ${TUBE_SIDES}.0 * 6.2831853;
  vec3 n = b1 * cos(ang) + b2 * sin(ang);
  vPos = c.xyz + n * c.w;
  vN = n;
  vAng = ang;
  vAlong = float(ring) / float(uRings - 1);
  gl_Position = c.w > 0.0 ? uViewProj * vec4(onSoil(vPos), 1.0) : vec4(0.0, 0.0, -2.0, 1.0);
}`;

export const TUBE_FS = `${HEAD}
${PAPER}
uniform float uDry;
in vec3  vPos;
in vec3  vN;
in float vAng;
in float vAlong;
out vec4 o;
void main() {
  // SHADOW PASS
  if (uMask > 0.5) {
    o = vec4(1.0);
    return;
  }
  vec3 N = normalize(vN);
  vec3 V = normalize(uEye - vPos);
  vec3 col = vec3(0.62, 0.75, 0.43);
  col *= 0.9 + 0.1 * cos(vAng * 6.0);
  col = mix(col, vec3(0.80, 0.72, 0.50), uDry);
  col = mix(col, vec3(0.88, 0.81, 0.62), uStraw);
  vec3 c = paint(col, N, V, 0.12, 1.0);
  float ink = 1.0 - smoothstep(0.08, 0.42, abs(dot(N, V)));
  float b = blur(vPos);
  c = mix(c, mix(vec3(0.20, 0.30, 0.15), vec3(0.42, 0.34, 0.2), uDry), ink * 0.8 * (1.0 - b));
  o = finishSoft(c, b, far(vPos));
}`;

// LEAVES
// one grid per leaf, displaced in the vertex shader
export const LEAF_VS = `${HEAD}
layout(location = 0) in vec3 aBase;
layout(location = 1) in vec3 aFwd;
layout(location = 2) in vec3 aSide;
layout(location = 3) in vec4 aShape;
layout(location = 4) in vec4 aState;
layout(location = 5) in vec4 aMore;
uniform mat4  uViewProj;
uniform float uTime;
uniform float uWind;

uniform vec3  uSun;
uniform float uCast;
vec3 onSoil(vec3 p) {
  if (uCast < 0.5) return p;
  float k = p.y / max(uSun.y, 0.25);
  return vec3(p.x - uSun.x * k, 0.001, p.z - uSun.z * k);
}
out vec3  vPos;
out vec3  vN;
out vec2  vUV;
out float vW;
out vec4  vInfo;
out float vAge;

vec3 leaf(float u, float v, out float w) {
  float L = aShape.x;
  float W = aShape.y;
  float unf = aState.x;
  float ruf = aState.y;
  float kind = aState.z;
  float sd = aState.w;
  float ros = 1.0 - step(0.5, kind);
  float clasp = step(0.5, kind) * (1.0 - step(1.5, kind));
  // OUTLINE
  float up = pow(u, mix(0.8, 1.45, ros));
  float n = mix(1.8, 2.5, ros);
  w = W * pow(max(1.0 - pow(abs(2.0 * up - 1.0), n), 0.0), 1.0 / n);
  w *= mix(1.0, 0.08 + 0.92 * smoothstep(0.1, 0.55, u), ros);
  w += clasp * W * 0.15 * (1.0 - smoothstep(0.0, 0.16, u));
  w *= 1.0 + ruf * 0.035 * sin(u * 23.0 + sd * 17.0);
  float d = v * w;
  // CUP
  // cross-section bent into an arc, tighter while young
  float k = aShape.w + (1.0 - unf) * 2.2 + clasp * 0.6 * (1.0 - smoothstep(0.0, 0.2, u));
  float kk = k / max(w, 1e-4);
  float ad = abs(d);
  float across = kk > 1e-3 ? sin(kk * ad) / kk : ad;
  float lift = kk > 1e-3 ? (1.0 - cos(kk * ad)) / kk : 0.0;
  across *= sign(v);
  // RUFFLES
  float e = pow(smoothstep(0.5, 1.0, abs(v)), 1.6);
  float s = u * L;
  float wave = sin(s * 170.0 + sd * 31.0) * 0.8 + sin(s * 330.0 + sd * 13.0) * 0.2;
  lift += ruf * unf * e * wave * 0.008 * min(1.0, L / 0.12);
  lift += ruf * unf * 0.0012 * sin(s * 130.0 + sd * 9.0) * sin(d * 150.0 + sd * 3.0) * (1.0 - e);
  // DROOP
  // rosette leaves share a sway phase so stacked leaves can't intersect
  float ph = ros > 0.5 ? (aBase.x + aBase.z) * 9.0 : sd * 40.0;
  float droop = aShape.z + uWind * aMore.y * 0.22 * sin(uTime * 6.3 + ph);
  float kb = droop / max(L, 1e-4);
  float th = kb * s;
  vec2 c = abs(kb) > 1e-3 ? vec2(sin(th), cos(th) - 1.0) / kb : vec2(s, 0.0);
  vec2 nl = vec2(sin(th), cos(th));
  vec3 nrm = cross(aFwd, aSide);
  vec3 p = aBase + aFwd * c.x + nrm * c.y + aSide * across + (aFwd * nl.x + nrm * nl.y) * lift;
  p.y = max(p.y, 0.002 + 0.004 * u);
  return p;
}

void main() {
  int i = gl_VertexID % ${LEAF_GU};
  int j = gl_VertexID / ${LEAF_GU};
  float u = float(i) / ${LEAF_GU - 1}.0;
  float t = float(j) / ${LEAF_GV - 1}.0 * 2.0 - 1.0;
  float v = sign(t) * pow(abs(t), 0.7);
  float w;
  float w2;
  vec3 p = leaf(u, v, w);
  vec3 pu = leaf(min(u + 0.012, 1.0), v, w2) - leaf(max(u - 0.012, 0.0), v, w2);
  vec3 pv = leaf(u, min(v + 0.03, 1.0), w2) - leaf(u, max(v - 0.03, -1.0), w2);
  vec3 n = cross(pu, pv);
  vN = dot(n, n) > 1e-16 ? normalize(n) : cross(aFwd, aSide);
  vPos = p;
  vUV = vec2(u, v);
  vW = w;
  vInfo = vec4(aShape.x, aState.z, aState.w, aMore.x);
  vAge = aMore.z;
  gl_Position = uViewProj * vec4(onSoil(p), 1.0);
}`;

export const LEAF_FS = `${HEAD}
${PAPER}
in vec3  vPos;
in vec3  vN;
in vec2  vUV;
in float vW;
in vec4  vInfo;
in float vAge;
out vec4 o;
void main() {
  // SHADOW PASS
  if (uMask > 0.5) {
    o = vec4(1.0);
    return;
  }
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(uEye - vPos);
  float u = vUV.x;
  float av = abs(vUV.y);
  float L = vInfo.x;
  float kind = vInfo.y;
  float sd = vInfo.z;
  float dry = vInfo.w;
  float ros = 1.0 - step(0.5, kind);
  float d = av * vW;
  // VEINS
  // midrib plus laterals arching toward the tip
  float mw = mix(0.0045, 0.001, sqrt(u)) * (L / 0.16) * mix(0.6, 1.0, ros);
  float fd = fwidth(d) + 1e-6;
  float mid = 1.0 - smoothstep(mw - fd, mw + fd, d);
  float q = (u * L - d * 1.15) / (L / 9.0) + sd;
  float dq = abs(fract(q + 0.5) - 0.5);
  float fq = fwidth(q) + 1e-6;
  float lw = 0.05 * (1.0 - av);
  float lat = (1.0 - smoothstep(lw - fq, lw + fq, dq)) * smoothstep(0.03, 0.12, av) * (1.0 - smoothstep(0.65, 0.95, av));
  float vein = max(mid, lat * 0.7);
  // PIGMENT
  vec3 pale = vec3(0.84, 0.88, 0.62);
  vec3 leafc = mix(vec3(0.48, 0.65, 0.36), vec3(0.66, 0.77, 0.44), vAge);
  vec3 deep = mix(vec3(0.30, 0.46, 0.25), vec3(0.42, 0.58, 0.30), vAge);
  vec3 col = mix(pale, leafc, smoothstep(0.0, 0.45, u));
  col = mix(col, deep, smoothstep(0.45, 1.0, av) * 0.6 + 0.15 * smoothstep(0.5, 1.0, u));
  col = mix(col, vec3(0.42, 0.60, 0.34) * (0.95 + 0.12 * u), (1.0 - ros) * 0.6);
  float pig = vnoise(vec2(u * 9.0, vUV.y * 4.0) + sd * 13.0);
  col *= 0.92 + 0.14 * pig;
  col = mix(col, vec3(0.86, 0.92, 0.68), vein * 0.6);
  // AGE
  // yellow then brown, spreading in from the margin
  float yel = smoothstep(0.0, 0.5, dry + (av - 0.5) * 0.35 + (pig - 0.5) * 0.3);
  float brn = smoothstep(0.55, 1.0, dry + (av - 0.6) * 0.3 + (pig - 0.5) * 0.3);
  col = mix(col, vec3(0.86, 0.77, 0.40), yel);
  col = mix(col, vec3(0.64, 0.52, 0.34), brn);
  col = mix(col, vec3(0.86, 0.79, 0.6) * (0.92 + 0.12 * pig), uStraw * 0.85);
  // BLISTERS
  // savoy puckering between veins, bump-mapped from screen-space derivatives
  float bl = sin(3.14159 * fract(q)) * sin(3.14159 * fract(d * 140.0 + q * 0.5)) * (0.6 + 0.4 * vnoise(vec2(q * 3.0, d * 90.0)));
  bl *= smoothstep(0.05, 0.2, av) * (1.0 - vein) * mix(0.35, 1.0, ros);
  vec3 dpx = dFdx(vPos);
  vec3 dpy = dFdy(vPos);
  vec3 r1 = cross(dpy, N);
  vec3 r2 = cross(N, dpx);
  float det = dot(dpx, r1);
  vec3 grad = sign(det) * (dFdx(bl) * r1 + dFdy(bl) * r2);
  N = normalize(abs(det) * N - grad * 0.00022);
  // LIGHT
  float ao = mix(mix(0.84, 1.0, smoothstep(0.0, 0.35, u)), mix(0.52, 1.0, smoothstep(0.0, 0.45, u)), ros);
  vec3 c = paint(col, N, V, 0.85 * (1.0 - vein * 0.5), ao);
  vec3 H = normalize(uSun + V);
  c += pow(max(dot(N, H), 0.0), 40.0) * 0.1 * (1.0 - dry);
  // EDGE
  // margin distance in metres with fwidth AA, crisp at any size
  float m = (1.0 - av) * vW;
  float fm = fwidth(m) + 1e-6;
  float a = smoothstep(-fm, fm, m);
  if (a < 0.02) discard;
  // INK
  // pigment pooling inside the edge, then a thin ink line
  c *= 1.0 - 0.12 * (1.0 - smoothstep(0.0, 0.006, m));
  float ink = 1.0 - smoothstep(0.6, 1.7, m / fm);
  float b = blur(vPos);
  c = mix(c, mix(vec3(0.17, 0.29, 0.13), vec3(0.42, 0.33, 0.2), dry), ink * 0.78 * (1.0 - b));
  o = vec4(finishSoft(c, b, far(vPos)).rgb, a);
}`;

// HEADS
// involucre of bracts: closed in bud, open in flower, reflexed in seed
const HEAD_ATTRS = `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aAxis;
layout(location = 2) in vec4 aP;
layout(location = 3) in vec4 aQ;
uniform mat4 uViewProj;
uniform vec3  uSun;
uniform float uCast;
vec3 onSoil(vec3 p) {
  if (uCast < 0.5) return p;
  float k = p.y / max(uSun.y, 0.25);
  return vec3(p.x - uSun.x * k, 0.001, p.z - uSun.z * k);
}
void frame(vec3 a, out vec3 b1, out vec3 b2) {
  vec3 ref = abs(a.z) < 0.95 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0);
  b1 = normalize(cross(a, ref));
  b2 = cross(a, b1);
}
`;

export const HEAD_VS = `${HEAD}
${HEAD_ATTRS}
out vec3 vPos;
out vec3 vN;
out vec2 vYA;
out vec4 vInfo;
void main() {
  int ring = gl_VertexID / ${HEAD_SIDES + 1};
  int side = gl_VertexID - ring * ${HEAD_SIDES + 1};
  float y = float(ring) / ${HEAD_RINGS - 1}.0;
  float aa = float(side) / ${HEAD_SIDES}.0;
  float ang = aa * 6.2831853 + aQ.x * 6.2831853;
  float sz = aP.x;
  float open = aP.y;
  float mat = aP.z;
  float rfx = aP.w;
  float Lh = 0.026 * sz * (1.0 + 0.25 * mat);
  float R = 0.0078 * sz;
  float rb = R * pow(max(sin(3.14159 * pow(0.1 + 0.9 * y, 0.85)), 0.0), 0.7);
  float ro = R * (0.5 + 0.5 * smoothstep(0.0, 0.55, y));
  float rm = R * 0.8 * pow(max(sin(3.14159 * (0.12 + 0.86 * y)), 0.0), 0.6) * (1.0 - 0.35 * y) + R * 0.15 * y;
  float r = mix(mix(rb, ro, open), rm, mat);
  float h = y * Lh;
  float fl = rfx * smoothstep(0.3, 1.0, y);
  float tl = max(y - 0.3, 0.0) * Lh;
  r = mix(r, R * 0.75 + tl * 1.15, fl);
  h = mix(h, 0.3 * Lh - tl * 0.3, fl);
  vec3 b1;
  vec3 b2;
  frame(aAxis, b1, b2);
  vec3 radial = b1 * cos(ang) + b2 * sin(ang);
  vPos = aPos + aAxis * h + radial * r;
  vN = normalize(mix(radial, aAxis, fl * 0.7));
  vYA = vec2(y, aa);
  vInfo = vec4(open, mat, rfx, aQ.z);
  gl_Position = uViewProj * vec4(onSoil(vPos), 1.0);
}`;

export const HEAD_FS = `${HEAD}
${PAPER}
in vec3 vPos;
in vec3 vN;
in vec2 vYA;
in vec4 vInfo;
out vec4 o;
void main() {
  // SHADOW PASS
  if (uMask > 0.5) {
    o = vec4(1.0);
    return;
  }
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 V = normalize(uEye - vPos);
  float y = vYA.x;
  float ba = fract(vYA.y * 8.0) - 0.5;
  // BRACT TIPS
  // rim cut into points once the head opens or reflexes
  float cut = clamp(vInfo.x * 0.7 + vInfo.z, 0.0, 1.0);
  float half_ = 0.5 - 0.5 * smoothstep(0.6, 1.0, y) * cut;
  float fb = fwidth(ba) + 1e-5;
  float a = 1.0 - smoothstep(half_ - fb, half_ + fb, abs(ba));
  if (a < 0.02) discard;
  vec3 col = vec3(0.47, 0.63, 0.30);
  col = mix(col, vec3(0.80, 0.86, 0.58), smoothstep(0.3, 0.48, abs(ba)) * 0.7);
  col = mix(col, vec3(0.56, 0.38, 0.50), smoothstep(0.72, 1.0, y) * 0.45);
  col = mix(col, vec3(0.84, 0.80, 0.66), vInfo.w);
  col = mix(col, vec3(0.88, 0.82, 0.66), uStraw);
  vec3 c = paint(col, N, V, 0.2, mix(0.8, 1.0, y));
  float ink = 1.0 - smoothstep(0.1, 0.45, abs(dot(N, V)));
  c = mix(c, vec3(0.20, 0.29, 0.15), ink * 0.6 * (1.0 - vInfo.w * 0.5));
  o = vec4(finishSoft(c, blur(vPos), far(vPos)).rgb, a);
}`;

// FLORETS
// ligulate straps with five teeth at the tip
export const FLORET_VS = `${HEAD}
${HEAD_ATTRS}
out vec3 vPos;
out vec3 vN;
out vec2 vUV;
out float vOut;
void main() {
  int f = gl_InstanceID % ${FLORETS};
  int i = gl_VertexID / 2;
  int j = gl_VertexID - i * 2;
  float s = float(i) / 8.0;
  float v = float(j) * 2.0 - 1.0;
  bool outer = f < 10;
  float az = (outer ? float(f) / 10.0 : (float(f - 10) + 0.5) / 6.0) * 6.2831853 + aQ.x * 6.2831853;
  float open = aP.y;
  float sz = aP.x;
  float Lf = 0.024 * sz * (outer ? 1.0 : 0.68) * smoothstep(0.0, 0.3, open);
  float Wf = 0.0033 * sz * (outer ? 1.0 : 0.85);
  float a0 = mix(0.1, outer ? 1.22 : 0.72, open);
  float cu = mix(0.0, outer ? 0.7 : 0.35, open);
  float kb = cu / max(Lf, 1e-5);
  float S = s * Lf;
  vec2 xy = kb > 1e-3
    ? vec2(cos(a0) - cos(a0 + kb * S), sin(a0 + kb * S) - sin(a0)) / kb
    : vec2(sin(a0), cos(a0)) * S;
  float ph = a0 + kb * S;
  vec3 b1;
  vec3 b2;
  frame(aAxis, b1, b2);
  vec3 radial = b1 * cos(az) + b2 * sin(az);
  vec3 tang = cross(aAxis, radial);
  vec3 top = aPos + aAxis * (0.026 * sz * 0.92);
  float wp = 0.4 + 0.6 * smoothstep(0.0, 0.3, s);
  vPos = top + radial * (xy.x + 0.0022 * sz) + aAxis * xy.y + tang * v * Wf * wp;
  vec3 dir = aAxis * cos(ph) + radial * sin(ph);
  vN = normalize(cross(tang, dir));
  vUV = vec2(s, v);
  vOut = outer ? 1.0 : 0.0;
  gl_Position = open > 0.01 ? uViewProj * vec4(onSoil(vPos), 1.0) : vec4(0.0, 0.0, -2.0, 1.0);
}`;

export const FLORET_FS = `${HEAD}
${PAPER}
in vec3 vPos;
in vec3 vN;
in vec2 vUV;
in float vOut;
out vec4 o;
void main() {
  // SHADOW PASS
  if (uMask > 0.5) {
    o = vec4(1.0);
    return;
  }
  float s = vUV.x;
  float v = vUV.y;
  float t = fract((v * 0.5 + 0.5) * 5.0);
  float lim = 0.9 + 0.1 * (1.0 - abs(t - 0.5) * 2.0);
  float fs = fwidth(s) + 1e-5;
  float a = 1.0 - smoothstep(lim - fs, lim + fs, s);
  if (a < 0.02) discard;
  vec3 N = normalize(vN);
  bool back = !gl_FrontFacing;
  if (back) N = -N;
  vec3 col = mix(vec3(0.93, 0.76, 0.24), vec3(0.98, 0.92, 0.56), smoothstep(0.0, 0.55, s));
  col *= 1.0 - 0.05 * cos(v * 3.14159 * 3.0);
  if (back) col = mix(col, vec3(0.74, 0.64, 0.80), (1.0 - smoothstep(0.0, 0.45, abs(v))) * 0.55 * vOut);
  vec3 c = paint(col, N, normalize(uEye - vPos), 0.7, mix(0.72, 1.0, s));
  c *= 1.0 - 0.12 * smoothstep(0.75, 1.0, abs(v));
  o = vec4(finishSoft(c, blur(vPos), far(vPos)).rgb, a);
}`;

// SEEDS
// billboards; pappus, beak and achene drawn in the fragment shader
export const SEED_VS = `${HEAD}
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aDir;
layout(location = 2) in vec4 aS;
uniform mat4  uViewProj;
uniform vec2  uRes;
uniform float uFocal;
uniform vec3  uSun;
uniform vec3  uEye;
out float vBack;
out vec2  vQ;
out float vR;
out float vB;
out float vF;
out float vA;
out float vH;
void main() {
  vec2 cn = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec3 p1 = aPos + aDir * aS.x;
  vBack = clamp(-dot(normalize(uEye - p1), uSun) * 0.5 + 0.5, 0.0, 1.0);
  vec4 c0 = uViewProj * vec4(aPos, 1.0);
  vec4 c1 = uViewProj * vec4(p1, 1.0);
  if (c0.w < 0.02 || c1.w < 0.02) {
    gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
    return;
  }
  vec2 h = 0.5 * uRes;
  vec2 s0 = c0.xy / c0.w * h;
  vec2 s1 = c1.xy / c1.w * h;
  float rpx = max(aS.y * uFocal / c1.w, 1.4);
  float bpx = aS.x * uFocal / c1.w;
  vec2 ax = s1 - s0;
  float al = length(ax);
  vec2 dir = al > 0.01 ? ax / al : vec2(0.0, 1.0);
  vec2 perp = vec2(-dir.y, dir.x);
  float along = mix(-al - rpx * 0.45 - 1.0, rpx * 1.1 + 1.0, cn.x);
  float across = (cn.y * 2.0 - 1.0) * (rpx * 1.1 + 1.0);
  vec2 sp = s1 + dir * along + perp * across;
  gl_Position = vec4(sp / h * c1.w, c1.z, c1.w);
  vQ = vec2(along, across);
  vR = rpx;
  vB = al;
  vF = clamp(al / max(bpx, 1e-3), 0.0, 1.0);
  vA = aS.z;
  vH = aS.w;
}`;

export const SEED_FS = `${HEAD}
uniform float uFade;
in float vBack;
in vec2  vQ;
in float vR;
in float vB;
in float vF;
in float vA;
in float vH;
out vec4 o;

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

void main() {
  float r = length(vQ);
  float ang = atan(vQ.y, vQ.x);
  float hs = fract(vH);
  // HAIRS
  // pappus: a full star end-on, a fan from the side
  float spread = mix(3.1416, 2.1, vF);
  float N = 22.0;
  float st = 2.0 * spread / N;
  float idx = clamp(floor((ang + spread) / st), 0.0, N - 1.0);
  float ha = -spread + (idx + 0.5 + (hash11(idx + hs * 91.0) - 0.5) * 0.6) * st;
  float dist = abs(sin(ang - ha)) * r;
  float hl = vR * (0.72 + 0.28 * hash11(idx * 1.7 + hs * 37.0));
  float len = 1.0 - smoothstep(hl * 0.8, hl, r);
  float hair = (1.0 - smoothstep(0.4, 1.1, dist)) * len;
  float lit = (1.0 - smoothstep(0.3, 0.8, dist)) * len;
  hair *= (1.0 - smoothstep(spread, spread + 0.25, abs(ang))) * step(0.0, cos(ang - ha));
  float core = (1.0 - smoothstep(0.0, max(vR * 0.22, 1.0), r)) * 0.7;
  // BEAK AND ACHENE
  float on = step(-vB, vQ.x) * step(vQ.x, 0.0);
  float beak = (1.0 - smoothstep(0.2, 0.6, abs(vQ.y))) * on * 0.6;
  float fly = step(1.5, vH);
  vec2 aq = vec2((vQ.x + vB) / max(vR * 0.3, 1.0), vQ.y / 0.7);
  float ach = (1.0 - smoothstep(0.7, 1.0, length(aq))) * fly;
  float a = max(max(hair * 0.92, core), max(beak, ach * 0.85)) * vA * uFade;
  if (a < 0.004) discard;
  vec3 col = mix(vec3(0.74, 0.68, 0.6), vec3(1.0, 0.997, 0.985), clamp(lit / max(hair, 1e-3), 0.0, 1.0));
  col = mix(vec3(0.84, 0.81, 0.76), col, smoothstep(0.05, 0.4, r / max(vR, 1.0)));
  col *= 0.95 + 0.05 * hash11(hs * 13.0 + idx);
  col = mix(col, vec3(0.74, 0.70, 0.60), beak * (1.0 - hair));
  col = mix(col, vec3(0.52, 0.42, 0.30), ach);
  col = mix(col, vec3(1.0, 0.9, 0.66), vBack * vBack * smoothstep(0.5, 1.0, r / max(vR, 1.0)) * hair * 0.7);
  o = vec4(col * a, a);
}`;

// SOFTEN
// separable 9-tap blur of the quarter-size shadow mask
export const SOFT_FS = `${HEAD}
uniform sampler2D uTex;
uniform vec2 uStep;
uniform vec2 uRes;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  float s = texture(uTex, uv).r * 0.2;
  s += (texture(uTex, uv + uStep).r + texture(uTex, uv - uStep).r) * 0.17;
  s += (texture(uTex, uv + uStep * 2.0).r + texture(uTex, uv - uStep * 2.0).r) * 0.12;
  s += (texture(uTex, uv + uStep * 3.0).r + texture(uTex, uv - uStep * 3.0).r) * 0.07;
  s += (texture(uTex, uv + uStep * 4.0).r + texture(uTex, uv - uStep * 4.0).r) * 0.04;
  o = vec4(vec3(s), 1.0);
}`;
