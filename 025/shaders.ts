// SHADERS

// LAMP
// light-space x, y and depth through four slices
const LAMP = `
uniform vec3 uLX;
uniform vec3 uLY;
uniform vec3 uLZ;
uniform vec4 uLRect;
uniform vec2 uLDepth;
vec3 lampSpace(vec3 p) {
  vec2 q = (vec2(dot(p, uLX), dot(p, uLY)) - uLRect.xy) / uLRect.zw;
  float s = (uLDepth.y - dot(p, uLZ)) / max(uLDepth.y - uLDepth.x, 1e-3);
  return vec3(q, s);
}`;

// SURFACE
// cubic b-spline over the coarse sim grid per fine vertex, so folds curve smoothly
const CLOTH_ATTR = `
layout(location = 0) in vec2 aG;
uniform highp sampler2D uX;
uniform highp sampler2D uN;
uniform vec2 uSize;
vec4 crw(float t) {
  float u = 1.0 - t;
  float t2 = t * t;
  float t3 = t2 * t;
  return vec4(u * u * u, 3.0 * t3 - 6.0 * t2 + 4.0, -3.0 * t3 + 3.0 * t2 + 3.0 * t + 1.0, t3) / 6.0;
}
vec3 surf(sampler2D s, vec2 g) {
  ivec2 hi = textureSize(s, 0) - 1;
  ivec2 b = ivec2(floor(g));
  vec2 f = g - vec2(b);
  vec4 wx = crw(f.x);
  vec4 wy = crw(f.y);
  vec3 r = vec3(0.0);
  for (int j = 0; j < 4; j++) {
    vec3 row = vec3(0.0);
    for (int i = 0; i < 4; i++) {
      ivec2 q = clamp(b + ivec2(i - 1, j - 1), ivec2(0), hi);
      row += texelFetch(s, q, 0).xyz * wx[i];
    }
    r += row * wy[j];
  }
  return r;
}
vec3 aPos;
vec3 aNor;
vec2 aUv;
void cloth() {
  aPos = surf(uX, aG);
  aNor = surf(uN, aG);
  aUv = aG / vec2(textureSize(uX, 0) - 1) * uSize;
}`;

// OPACITY
// each layer adds its optical depth to the slice it sits in, as the lamp sees it
export const OPAC_VS = `#version 300 es
${CLOTH_ATTR}
${LAMP}
out float vS;
out vec3 vNor;
out vec2 vUv;
void main() {
  cloth();
  vec3 l = lampSpace(aPos);
  vS = l.z;
  vNor = aNor;
  vUv = aUv;
  gl_Position = vec4(l.xy, 0.0, 1.0);
}`;

const SHEER = `
uniform float uSheer;
uniform vec2  uSize;
// HEM
// rolled hem, a few mm of doubled cloth
float hem(vec2 uv) {
  float e = min(min(uv.x, uSize.x - uv.x), min(uv.y, uSize.y - uv.y));
  return 1.0 - smoothstep(0.004, 0.008, e);
}
// EDGE
// cut edge faded over about a pixel so the outline never steps
float edge(vec2 uv) {
  float e = min(min(uv.x, uSize.x - uv.x), min(uv.y, uSize.y - uv.y));
  return smoothstep(0.0, 1.5 * fwidth(e), e);
}`;

export const OPAC_FS = `#version 300 es
precision highp float;
${LAMP}
${SHEER}
in float vS;
in vec3 vNor;
in vec2 vUv;
out vec4 o;
void main() {
  float c = max(abs(dot(normalize(vNor), uLZ)), 0.15);
  float a = mix(uSheer, 0.45, hem(vUv));
  float tau = -log(1.0 - a) / c;
  float k = clamp(vS * 4.0 - 0.5, 0.0, 3.0);
  vec4 w = max(1.0 - abs(vec4(0.0, 1.0, 2.0, 3.0) - k), 0.0);
  o = w * tau * 0.125;
}`;

// CLOTH
// backlit sheer: forward scatter, silk sheen, lamp-space shadowing; weighted blended OIT
export const CLOTH_VS = `#version 300 es
${CLOTH_ATTR}
uniform mat4 uVP;
out vec3 vPos;
out vec3 vNor;
out vec2 vUv;
void main() {
  cloth();
  vPos = aPos;
  vNor = aNor;
  vUv = aUv;
  gl_Position = uVP * vec4(aPos, 1.0);
}`;

export const CLOTH_FS = `#version 300 es
precision highp float;
${LAMP}
${SHEER}
uniform sampler2D uOpac;
uniform vec3  uEye;
uniform vec3  uLight;
uniform vec3  uLightC;
uniform vec3  uFill;
uniform vec3  uTint;
uniform float uFreq;
in vec3 vPos;
in vec3 vNor;
in vec2 vUv;
layout(location = 0) out vec4 oAccum;
layout(location = 1) out vec4 oWeight;
float h11(float x) { return fract(sin(x * 127.1) * 43758.5453); }
float threads(float g, float fw, float w) {
  float d = abs(fract(g + 0.5) - 0.5);
  float aa = max(fw, 1e-4) * 0.7;
  float t = 1.0 - smoothstep(w * 0.5 - aa, w * 0.5 + aa, d);
  return mix(t, w, smoothstep(0.18, 0.45, fw));
}
void main() {
  vec3 V = normalize(uEye - vPos);
  vec3 n = normalize(vNor);
  vec3 nv = dot(n, V) < 0.0 ? -n : n;
  float c = max(dot(nv, V), 0.0);

  // WEAVE
  // a fine plain weave; past a pixel it averages out, close up it shimmers faintly
  vec2 g = vUv * uFreq;
  vec2 fw = fwidth(g);
  float wx = 0.42 + 0.12 * h11(floor(g.x));
  float wy = 0.40 + 0.12 * h11(floor(g.y) + 31.0);
  float cover = 1.0 - (1.0 - threads(g.x, fw.x, wx)) * (1.0 - threads(g.y, fw.y, wy));
  float weave = mix(0.85, 1.1, cover);
  // STREAKS
  // warp lines: smooth stripe, faded by its screen-space rate before it aliases
  float sx = vUv.x * 64.0 + 1.6 * sin(vUv.y * 2.3 + vUv.x * 7.0) + 0.8 * sin(vUv.y * 5.1);
  float sfw = fwidth(sx);
  float st = 0.5 + 0.25 * sin(sx * 6.2832) * sin(sx * 0.37 + 1.1) + 0.25 * sin(sx * 2.618 * 6.2832 + 1.3) * sin(sx * 0.23);
  weave *= mix(1.0, mix(0.72, 1.28, st), (1.0 - smoothstep(0.12, 0.35, sfw)) * 0.6);
  float sl = 0.5 + 0.5 * sin(vUv.x * 9.0 + 2.0 * sin(vUv.y * 1.3));
  weave *= mix(0.8, 1.2, sl);

  float hm = hem(vUv);
  float a0 = mix(uSheer * weave, 0.45, hm);
  float a = (1.0 - pow(1.0 - a0, 1.0 / max(c, 0.1))) * edge(vUv);

  // SHADE
  // cloth between this layer and the lamp
  vec3 l = lampSpace(vPos);
  vec4 tau = texture(uOpac, l.xy * 0.5 + 0.5) * 8.0;
  float k = l.z * 4.0 - 0.5;
  vec4 before = clamp(vec4(k) - vec4(0.0, 1.0, 2.0, 3.0) - 0.6, 0.0, 1.0);
  float shade = exp(-dot(tau, before) * 0.22);

  // LIGHT
  vec3 L = uLight;
  float ndl = dot(nv, L);
  // THROUGH
  // forward scatter from the far side
  float fwd = pow(max(dot(-V, L), 0.0), 3.0);
  vec3 through = uLightC * (0.22 + 0.78 * max(-ndl, 0.0)) * (0.55 + 1.6 * fwd) * shade;
  // NEAR SIDE
  // soft diffuse and silk sheen along warp and weft
  vec3 dpdx = dFdx(vPos);
  vec3 dpdy = dFdy(vPos);
  vec2 dudx = dFdx(vUv);
  vec2 dudy = dFdy(vUv);
  vec3 tu = normalize(dpdx * dudy.y - dpdy * dudx.y + 1e-6);
  vec3 tv = normalize(cross(nv, tu));
  vec3 H = normalize(L + V);
  float su = pow(sqrt(max(1.0 - pow(dot(tu, H), 2.0), 0.0)), 90.0);
  float sv = pow(sqrt(max(1.0 - pow(dot(tv, H), 2.0), 0.0)), 90.0);
  vec3 near = uLightC * max(ndl, 0.0) * (0.12 + 0.9 * (su * 0.7 + sv * 0.3)) * shade;
  // FILL
  float fd = dot(nv, uFill);
  vec3 Hf = normalize(uFill + V);
  float sf = pow(sqrt(max(1.0 - pow(dot(tu, Hf), 2.0), 0.0)), 60.0);
  vec3 fill = vec3(0.55, 0.5, 0.48) * (max(fd, 0.0) * 0.05 + sf * 0.05);
  // RIM
  // grazing layers carry more cloth in the line of sight
  vec3 rim = uLightC * pow(1.0 - c, 4.0) * 0.35 * shade * (0.4 + 0.6 * fwd);

  vec3 col = through * mix(uTint, vec3(1.0), 0.25) + near * mix(uTint, vec3(1.0), 0.6) + fill + rim;
  col *= 1.0 + hm * 0.4;

  // WEIGHTED BLENDED
  float z = gl_FragCoord.z / gl_FragCoord.w;
  float w = a * clamp(0.03 / (1e-5 + pow(z / 20.0, 4.0)), 1e-2, 3e3);
  oAccum = vec4(col * a * w, a);
  oWeight = vec4(a * w, 0.0, 0.0, 1.0);
}`;

// COMPOSITE
// warm dark ground with lamp falloff, cloth over it, soft shoulder and gamma
export const COMP_FS = `#version 300 es
precision highp float;
uniform sampler2D uAccum;
uniform sampler2D uWeight;
uniform vec2 uRes;
uniform vec2 uGlow;
uniform float uAspect;
out vec4 o;
float h21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec3 tone(vec3 c) {
  vec3 x = c * 1.1;
  x = x / (1.0 + x * 0.55);
  return pow(x, vec3(1.0 / 2.2));
}
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 d = (uv - uGlow) * vec2(uAspect, 1.0);
  float r = length(d);
  vec3 bg = mix(vec3(0.0045, 0.0030, 0.0022), vec3(0.036, 0.021, 0.012), exp(-r * r * 1.3));
  vec4 acc = texture(uAccum, uv);
  float sw = texture(uWeight, uv).r;
  float reveal = acc.a;
  vec3 cloth = acc.rgb / max(sw, 1e-5);
  vec3 c = bg * reveal + cloth * (1.0 - reveal);
  c = tone(c);
  c += (h21(gl_FragCoord.xy) - 0.5) / 255.0;
  o = vec4(c, 1.0);
}`;
