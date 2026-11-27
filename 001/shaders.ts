// BENCH
// glsl port of benchY in bench.ts
export const BENCH_GLSL = /* glsl */ `
float benchY(vec2 p) {
  vec2 q = abs(p) - (uBench.xy - uBench.z);
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uBench.z;
  float t = clamp((d + 0.03) / 0.14, 0.0, 1.0);
  return -uBench.w * t * t * (3.0 - 2.0 * t);
}
`;

// NOISE
export const NOISE = /* glsl */ `
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
// VALUE NOISE
// analytic gradient in yzw, so bumps shade per pixel, not per 2x2 quad
vec4 noised(vec3 x) {
  vec3 i = floor(x);
  vec3 w = fract(x);
  vec3 u = w * w * (3.0 - 2.0 * w);
  vec3 du = 6.0 * w * (1.0 - w);
  float a = hash13(i);
  float b = hash13(i + vec3(1, 0, 0));
  float c = hash13(i + vec3(0, 1, 0));
  float d = hash13(i + vec3(1, 1, 0));
  float e = hash13(i + vec3(0, 0, 1));
  float f = hash13(i + vec3(1, 0, 1));
  float g = hash13(i + vec3(0, 1, 1));
  float h = hash13(i + vec3(1, 1, 1));
  float k1 = b - a, k2 = c - a, k3 = e - a, k4 = a - b - c + d;
  float k5 = a - c - e + g, k6 = a - b - e + f, k7 = -a + b + c - d + e - f - g + h;
  float v = a + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z;
  vec3 gr = du * vec3(
    k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,
    k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x,
    k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y);
  return vec4(v, gr);
}
float vnoise(vec3 p) {
  return noised(p).x;
}
float fbm3(vec3 p) {
  return vnoise(p) * 0.55 + vnoise(p * 2.03 + 11.7) * 0.3 + vnoise(p * 4.1 + 3.1) * 0.15;
}
vec4 sstep(float a, float b, vec4 n) {
  float t = clamp((n.x - a) / (b - a), 0.0, 1.0);
  return vec4(t * t * (3.0 - 2.0 * t), n.yzw * (6.0 * t * (1.0 - t) / (b - a)));
}
// BUMP
// screen-space height derivative (dHdxy), world-unit height
vec3 bumpN(vec3 pos, vec3 n, vec2 dh, float face) {
  vec3 sx = dFdx(pos);
  vec3 sy = dFdy(pos);
  vec3 r1 = cross(sy, n);
  vec3 r2 = cross(n, sx);
  float det = dot(sx, r1) * face;
  vec3 g = sign(det) * (dh.x * r1 + dh.y * r2);
  return normalize(abs(det) * n - g);
}
`;

// WINDOW
// analytic reflection lobe, the only env map for dough and board
export const WINDOW = /* glsl */ `
vec3 windowSpec(vec3 v, vec3 n, float rough, vec3 f0) {
  vec3 r = reflect(-v, n);
  float lobe = pow(saturate(dot(r, uWin) * 0.5 + 0.5), mix(70.0, 5.0, rough));
  float nv = saturate(dot(n, v));
  vec3 f = f0 + (1.0 - f0) * pow(1.0 - nv, 5.0);
  return uWinColor * lobe * f * mix(2.4, 0.3, rough);
}
`;

// DOUGH
export const DOUGH_VS_PARS = /* glsl */ `
attribute vec3 aRest;
attribute vec4 aMat;
varying vec3 vRest;
varying vec4 vMat;
varying float vLow;
uniform vec4  uBench;
uniform float uSink;
${BENCH_GLSL}
`;

export const DOUGH_VS = /* glsl */ `
vRest = aRest;
vMat = aMat;
vec3 wpos = (modelMatrix * vec4(transformed, 1.0)).xyz;
// SINK
// base pushed into the bench, so the skin meets it at an angle, not a grazing tangent
float hb = wpos.y - benchY(wpos.xz);
transformed.y -= uSink * (1.0 - smoothstep(-0.05, 0.25, hb));
vLow = hb;
`;

export const DOUGH_FS_PARS = /* glsl */ `
varying vec3 vRest;
varying vec4 vMat;
varying float vLow;
uniform vec3  uFlour;
uniform vec3  uTackColor;
uniform vec3  uSss;
uniform vec3  uWin;
uniform vec3  uWinColor;
uniform float uBump;
float gCover;
float gSmooth;
vec3  gSssColor;
${NOISE}
${WINDOW}
`;

export const DOUGH_FS_COLOR = /* glsl */ `
vec3 rp = vRest;
float crease = vMat.x;
float strain = max(vMat.z, 0.6);
float tack = saturate(vMat.w);
float taut = smoothstep(1.1, 1.5, strain);
gSmooth = max(taut * 0.6, tack * 0.5);
float pix = length(fwidth(rp));
// CRISP
// fade detail where the rest-space mapping is anisotropic
vec3 drx = dFdx(rp), dry = dFdy(rp);
float sx = length(drx) / max(length(dFdx(vViewPosition)), 1e-6);
float sy = length(dry) / max(length(dFdy(vViewPosition)), 1e-6);
float aniso = max(sx, sy) / max(min(sx, sy), 1e-4);
float crisp = 1.0 - smoothstep(1.35, 2.4, aniso);
float fine = (1.0 - smoothstep(0.012, 0.03, pix)) * crisp;

// FLOUR
// density per area, so stretched skin breaks up
float dens = vMat.y;
float clump = mix(0.45, fbm3(rp * 5.0), crisp);
float speck = vnoise(rp * 70.0);
float grit = vnoise(rp * 160.0 + 2.3);
vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
float up = dot(normalize(vNormal), upV);
float finer = (1.0 - smoothstep(0.005, 0.012, pix)) * crisp;
float raw = dens * 0.95 + up * 0.22 - clump * 0.9 + (speck - 0.5) * 0.3 * fine + (grit - 0.5) * 0.25 * finer;
raw *= (1.0 - crease * 0.85) * (1.0 - tack * 0.9);
float cov = smoothstep(0.0, 0.34, raw) * 0.95;
float haze = smoothstep(-0.45, 0.05, raw) * 0.35;
gCover = max(cov, haze);

// DOUGH
vec3 dough = diffuseColor.rgb * (0.95 + 0.1 * clump);
dough = mix(dough, uTackColor, tack * 0.75);
dough *= mix(vec3(1.0), vec3(0.74, 0.62, 0.5), crease * 0.85);
// CONTACT
// no flour and darker where the skin meets the bench
float seat = smoothstep(-0.02, 0.09, vLow);
gCover *= seat;
diffuseColor.rgb = mix(dough, uFlour * (0.95 + 0.04 * speck + 0.04 * grit * finer), gCover);
diffuseColor.rgb *= 0.82 + 0.18 * seat;
float low = smoothstep(0.0, 0.38, vLow);
gSssColor = uSss * (1.0 - gCover * 0.8) * (1.0 - crease * 0.5) * low;
`;

export const DOUGH_FS_ROUGH = /* glsl */ `
float roughnessFactor = mix(roughness, 0.58, gSmooth);
roughnessFactor = mix(roughnessFactor, 0.97, gCover);
`;

// PORES
export const DOUGH_FS_NORMAL = /* glsl */ `
{
  float relief = 1.0 - gSmooth * 0.9;
  vec4 h = noised(rp * 5.0) * vec4(1.0, vec3(5.0)) * 0.8;
  h += noised(rp * 16.0 + 4.0) * vec4(1.0, vec3(16.0)) * 0.22;
  // BUBBLES
  // rotated lattice, so thresholded noise never comes out square
  mat3 turn = mat3(0.8, -0.36, 0.48, 0.6, 0.48, -0.64, 0.0, 0.8, 0.6);
  vec3 rq = turn * rp;
  vec4 bub = sstep(0.66, 0.95, noised(rq * 13.0 + 3.7));
  bub.yzw = transpose(turn) * bub.yzw * 13.0;
  vec4 pore = sstep(0.64, 0.92, noised(rq * 34.0 + 7.1));
  pore.yzw = transpose(turn) * pore.yzw * 34.0;
  float open = smoothstep(-0.1, 0.6, up);
  h += bub * 0.3 * open;
  h -= pore * 0.12 * fine * open * (1.0 - gCover * 0.7);
  h *= relief * mix(0.25, 1.0, crisp);
  vec2 dh = vec2(dot(h.yzw, dFdx(rp)), dot(h.yzw, dFdy(rp))) * uBump;
  normal = bumpN(-vViewPosition, normal, dh, faceDirection);
}
`;

// SSS
// wrap lighting past the terminator
export const DOUGH_SSS = /* glsl */ `
reflectedLight.directDiffuse += irradiance * diffuseBRDF * ( 1.0 - F );
{
  float wrapNL = saturate((dot(geometryNormal, directLight.direction) + 0.45) / 1.45);
  reflectedLight.directDiffuse += directLight.color * max(wrapNL - dotNL, 0.0) * gSssColor * RECIPROCAL_PI;
}
`;

export const DOUGH_FS_LIGHT = /* glsl */ `
material.specularColor *= 1.0 - gCover * 0.85;
material.sheenColor *= (0.15 + gCover * 0.85) * seat * seat;
`;

export const DOUGH_FS_ENV = /* glsl */ `
// CONTACT
// occlude indirect light toward the bench seam
reflectedLight.indirectDiffuse *= mix(0.3, 1.0, seat) * mix(0.5, 1.0, low);
reflectedLight.directDiffuse *= mix(0.72, 1.0, low);
reflectedLight.indirectSpecular *= seat * low;
reflectedLight.directSpecular *= seat * low;
reflectedLight.indirectSpecular += windowSpec(geometryViewDir, geometryNormal, material.roughness, material.specularColor) * (1.0 - gCover) * 0.3;
`;

// BOARD
export const BOARD_VS_PARS = /* glsl */ `
varying vec3 vWorld;
`;

export const BOARD_VS = /* glsl */ `
vWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;

export const BOARD_FS_PARS = /* glsl */ `
varying vec3 vWorld;
uniform sampler2D uFlourMap;
uniform sampler2D uShade;
uniform float uSpan;
uniform float uShadeSpan;
uniform float uContact;
uniform vec3  uBoard;
uniform sampler2D uField;
uniform vec4  uFieldBox;
uniform vec3  uFlour;
uniform vec3  uWoodA;
uniform vec3  uWoodB;
uniform vec3  uKeyDir;
uniform vec3  uWin;
uniform vec3  uWinColor;
float gCover;
vec4  gH;
${NOISE}
${WINDOW}
// WINDOW POOL
// key light masked by a window rect projected along the light onto the bench
float windowPool(vec3 wp) {
  vec2 p = wp.xz - uKeyDir.xz / uKeyDir.y * wp.y;
  vec2 a = normalize(uKeyDir.xz);
  vec2 b = vec2(-a.y, a.x);
  float u = dot(p, a), v = dot(p, b);
  float pool = smoothstep(-6.5, -5.0, u) * smoothstep(9.6, 6.6, u) * smoothstep(-8.5, -7.0, v) * smoothstep(5.6, 4.0, v);
  float bar = 1.0 - (1.0 - smoothstep(0.1, 0.55, abs(u - 5.2))) * 0.7;
  return mix(0.4, 1.0, pool * bar);
}
`;

export const BOARD_KEY = /* glsl */ `vDirectionalShadowCoord[ i ] ) : 1.0;
		directLight.color *= windowPool(vWorld);`;

// BOARD COLOR
export const BOARD_FS_COLOR = /* glsl */ `
vec3 wp = vWorld;
float pix = length(fwidth(wp));
float fine = 1.0 - smoothstep(0.006, 0.02, pix);
float worked = texture2D(uFlourMap, wp.xz / uSpan + 0.5).r * 2.0;
#ifdef WORKTOP
  float mott = fbm3(vec3(wp.xz * 0.9, 2.0));
  vec3 base = mix(uWoodA, uWoodB, mott);
  base *= 0.985 + 0.03 * vnoise(vec3(wp.xz * 30.0, 5.0));
  gH = vec4(0.0);
  float dust = smoothstep(0.66, 0.92, fbm3(vec3(wp.xz * 1.8, 7.0))) * 0.35;
  dust *= 1.0 - smoothstep(3.5, 6.0, length(wp.xz));
#else
  // GRAIN
  // y folded into the grain coord so side faces show grain too
  vec3 gp = vec3(wp.x * 0.5, (wp.z + wp.y * 0.6) * 1.0, 1.0);
  float warp = fbm3(gp * vec3(1.0, 2.2, 1.0)) * 3.2 + vnoise(gp * vec3(0.4, 0.8, 1.0)) * 2.0;
  float ring = sin((gp.y * 5.0 + warp) * 3.14159) * 0.5 + 0.5;
  ring = smoothstep(0.15, 1.0, ring) * (0.5 + 0.5 * vnoise(gp * vec3(0.8, 1.5, 1.0) + 2.0));
  float fibre = vnoise(vec3(wp.x * 1.6, (wp.z + wp.y * 0.6) * 120.0, 3.0));
  float fleck = smoothstep(0.75, 0.95, vnoise(vec3(wp.x * 5.0, (wp.z + wp.y * 0.6) * 40.0, 9.0)));
  vec3 base = mix(uWoodB, uWoodA, ring * 0.45 + fibre * 0.3 * fine + fleck * 0.25);
  base *= 0.94 + 0.12 * fbm3(vec3(wp.x * 0.6, wp.z * 0.6, 9.0));
  vec4 gn = noised(vec3(wp.x * 1.6, (wp.z + wp.y * 0.6) * 120.0, 3.0));
  gH = vec4(gn.x, gn.y * 1.6, gn.z * 72.0, gn.z * 120.0) * 0.08 * fine;
  // DUSTING
  float zone = 1.0 - smoothstep(1.0, 2.6, length(wp.xz * vec2(0.8, 1.1) + vec2(0.15, -0.05)));
  float drift = fbm3(vec3(wp.xz * 1.4, 4.0));
  float sweep = smoothstep(0.66, 0.9, vnoise(vec3(wp.x * 0.5 + wp.z * 0.3, wp.z * 2.2 - wp.x * 1.1, 6.0)));
  float dust = zone * (0.15 + drift * 0.75) + sweep * 0.22 * (0.2 + zone);
  dust *= smoothstep(-0.03, -0.008, wp.y);
#endif
float speck = vnoise(vec3(wp.xz * 90.0, 1.0));
float grains = smoothstep(0.86, 0.98, vnoise(vec3(wp.xz * 44.0, 8.0))) * fine;
// CREVICE
// metaball field above this texel, from the contact map
vec3 fd = texture2D(uField, (wp.xz - uFieldBox.xy) / uFieldBox.zw).rgb * 2.0;
float crev = max(max(fd.r, fd.g * 0.85), fd.b * 0.6);
float amount = dust * worked * (1.0 - 0.75 * smoothstep(0.01, 0.3, crev));
float cov = smoothstep(0.12, 0.62, amount + (speck - 0.5) * 0.25 * fine);
cov = max(cov * 0.94, grains * min(amount * 2.5, 0.55));
gCover = saturate(cov);
diffuseColor.rgb = mix(base, uFlour * (0.93 + 0.07 * speck), gCover);
`;

export const BOARD_FS_ROUGH = /* glsl */ `
float roughnessFactor = mix(roughness, 0.97, gCover);
`;

export const BOARD_FS_NORMAL = /* glsl */ `
{
  vec2 dh = vec2(dot(gH.yzw, dFdx(wp)), dot(gH.yzw, dFdy(wp))) * 0.004 * (1.0 - gCover);
  normal = bumpN(-vViewPosition, normal, dh, faceDirection);
}
`;

// CONTACT AO
// blurred occupancy map, mostly attenuates indirect light
export const BOARD_FS_AO = /* glsl */ `
{
  float occ = texture2D(uShade, wp.xz / uShadeSpan + 0.5).r * uContact;
  #ifdef WORKTOP
    // CONTACT
    // analytic from the board sdf, so shadow-map bias cannot open a lit gap
    vec2 q = abs(wp.xz) - (uBoard.xy - uBoard.z);
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uBoard.z;
    occ = max(occ, exp(-max(d, 0.0) / 0.045) + exp(-max(d, 0.0) / 0.18) * 0.25);
    occ = min(occ, 1.0);
  #endif
  float cav = smoothstep(0.12, 1.0, crev);
  occ = max(occ, cav);
  reflectedLight.indirectDiffuse *= 1.0 - occ * 0.85;
  reflectedLight.directDiffuse *= 1.0 - occ * 0.25 - smoothstep(0.6, 1.0, crev) * 0.65;
  reflectedLight.indirectSpecular *= 1.0 - occ;
}
`;

export const BOARD_FS_ENV = /* glsl */ `
reflectedLight.indirectSpecular += windowSpec(geometryViewDir, geometryNormal, material.roughness, material.specularColor) * (1.0 - gCover) * 0.5;
`;

// PUFF
// forward scattering toward the window
export const PUFF_VS = /* glsl */ `
attribute float aLife;
attribute float aSize;
attribute float aAlpha;
uniform float uDpr;
uniform vec3  uWin;
varying float vAlpha;
varying float vGlow;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float t = clamp(aLife, 0.0, 1.0);
  // SUB-PIXEL
  // clamp size to 1px and trade the rest for alpha, so dust never shimmers
  float px = aSize * uDpr;
  float cover = min(1.0, px * px);
  vAlpha = smoothstep(0.0, 0.05, t) * (1.0 - smoothstep(0.6, 1.0, t)) * step(0.0, aLife) * aAlpha * cover;
  float back = max(dot(normalize(mv.xyz), uWin), 0.0);
  vGlow = 0.8 + 0.9 * pow(back, 3.0);
  gl_PointSize = max(px, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

export const PUFF_FS = /* glsl */ `
uniform vec3 uColor;
varying float vAlpha;
varying float vGlow;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float o = smoothstep(0.5, 0.2, length(d)) * vAlpha;
  if (o < 0.003) discard;
  gl_FragColor = vec4(uColor * vGlow * o, o);
}
`;
