import { R_CENTRE, R_OUT } from "./path";

const f = (n: number) => n.toFixed(4);

export const STONES = 6; // four in the garden, two at the gate
export const S_ENCODE = 65000; // arc length steps stored per path
const PIVOT_MAX = "4.0";

// MAP
// the lane strip, rasterised once per resize at half resolution into 16-bit integers:
// arc length (0 = no lane), distance from the lane's middle, distance to the turn's pivot, soft
export const MAP_VS = `#version 300 es
layout(location = 0) in vec4 aVert;
layout(location = 1) in vec2 aPivot; // pivot distance, soft
uniform vec2  uRes;
uniform vec2  uCentre;
uniform float uUnit;
out vec4 vSD;
void main() {
  vSD = vec4(aVert.zw, aPivot);
  vec2 px = aVert.xy * uUnit + uCentre;
  gl_Position = vec4(px / uRes * 2.0 - 1.0, abs(aVert.w) * 2.0 - 1.0, 1.0);
}`;

export const MAP_FS = `#version 300 es
precision highp float;
precision highp int;
uniform float uLen;
in vec4 vSD;
out uvec4 oMap;
void main() {
  oMap = uvec4(
    uint(vSD.x / uLen * ${f(S_ENCODE)} + 1.5),
    uint(clamp(abs(vSD.y), 0.0, 1.0) * 65535.0 + 0.5),
    uint(clamp(vSD.z / ${PIVOT_MAX}, 0.0, 1.0) * 65535.0 + 0.5),
    uint(clamp(vSD.w, 0.0, 1.0) * 65535.0 + 0.5));
}`;

export const FULL_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// RAKE
// sizes in lanes, shared by the height field and the shadow it casts
const RAKE = `
const float BAR_W    = 0.085;
const float BAR_L    = 0.47;
const float BAR_Z    = 0.15;
const float HANDLE_W = 0.05;
const float HANDLE_L = 2.2;
const float HANDLE_A = 0.2;
const float HANDLE_B = 0.78;`;

const NOISE = `
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 u = fract(p);
  u = u * u * (3.0 - 2.0 * u);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}`;

// HEIGHT
// sand, walls, stones, moss and the rake as one height field in lane units. drawn twice:
// full resolution for the relief, and half resolution (AUX) for materials, freshness and a
// height copy whose mips give the contact darkening
const height = (aux: boolean) => `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
${aux ? "#define AUX" : ""}
uniform usampler2D uMap;
uniform sampler2D  uFresh;
uniform vec2  uCentre;
uniform float uUnit;
uniform float uMapScale;
uniform float uLen;
uniform float uSpiral; // arc length where the centre spiral starts
uniform vec4  uGate;
uniform vec4  uStone[${STONES}];
uniform vec4  uShape[${STONES}];
uniform vec4  uRake;
uniform float uLift;
out vec4 oHeight;

const float R_OUT    = ${f(R_OUT)};
const float R_CENTRE = ${f(R_CENTRE)};
const float BERM     = 0.055;
const float INNER    = 0.7;
const float TINES    = 4.0;
const float PITCH    = 0.175;
const float G_REST   = 0.006;
const float G_FRESH  = 0.040;
const float G_GARDEN = 0.024;
const float SMIN_K   = 0.9;
const float RINGS    = 1.5; // width of the raked band around islands
const float SEAM_CLEAR = 0.32; // straight rake lines in the seam stop this far from a lane
${RAKE}
${NOISE}

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float groove(float x) { return 0.5 - 0.5 * cos(6.28318 * x); }

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

vec2 gFrag; // garden position of this fragment

// LANE MAP
// bilinear by hand over the half-res integer map, weighted by which texels hold a lane
ivec2 mapSize;
bool lit(ivec2 p) { return texelFetch(uMap, clamp(p, ivec2(0), mapSize - 1), 0).r > 0u; }

// share of the four nearest texels that hold a lane, smooth across the edge
float coverage(vec2 mp) {
  vec2 b = floor(mp);
  vec2 fr = mp - b;
  ivec2 i = ivec2(b);
  float c00 = lit(i) ? 1.0 : 0.0;
  float c10 = lit(i + ivec2(1, 0)) ? 1.0 : 0.0;
  float c01 = lit(i + ivec2(0, 1)) ? 1.0 : 0.0;
  float c11 = lit(i + ivec2(1, 1)) ? 1.0 : 0.0;
  return mix(mix(c00, c10, fr.x), mix(c01, c11, fr.x), fr.y);
}

float soft;
vec4 readMap(vec2 mp) {
  vec2 b = floor(mp);
  vec2 fr = mp - b;
  ivec2 i = ivec2(b);
  vec4 acc = vec4(0.0);
  soft = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 o = ivec2(k & 1, k >> 1);
    uvec4 t = texelFetch(uMap, clamp(i + o, ivec2(0), mapSize - 1), 0);
    float w = (o.x == 1 ? fr.x : 1.0 - fr.x) * (o.y == 1 ? fr.y : 1.0 - fr.y);
    if (t.r > 0u) {
      acc += w * vec4(1.0, float(t.r - 1u), float(t.g), float(t.b));
      soft += w * float(t.a);
    }
  }
  if (acc.x < 0.5) return vec4(0.0);
  acc.yzw /= acc.x;
  soft = soft / acc.x / 65535.0;
  return vec4(1.0, acc.y / ${f(S_ENCODE)} * uLen, acc.z / 65535.0, acc.w / 65535.0 * ${PIVOT_MAX});
}

float fresh(float s) { return texture(uFresh, vec2(s / uLen, 0.5)).r; }

float lane(float s, float ad, float pivot, float fr, float sf) {
  // wall ends swell into a round nub where the lane turns about them; the spiral has none
  float wall = max(smoothstep(0.64, 1.0, ad), 1.0 - smoothstep(0.04, 0.3, pivot)) * (1.0 - sf);
  // on the spiral the tines span the whole lane, so the wraps meet groove to groove
  float span = mix(INNER, 1.0, sf);
  float g = groove((ad + span) / (2.0 * span) * TINES);
  g = mix(g, g * g * (1.6 - 0.6 * g), fr);
  // tines that would pivot on the spot at a tight turn leave smooth sand instead
  float inner = (1.0 - smoothstep(span - 0.06, span, ad) * (1.0 - sf)) * smoothstep(0.1, 0.3, pivot);
  float depth = mix(G_REST, G_FRESH, fr);
  // spiral wraps meet at a ridge whose height does not depend on how fresh either side is
  float h = BERM * wall - depth * (g - 0.25 * (1.0 - sf)) * inner;
  // the outer wrap rises into the centre's rim, except where the lane comes in
  float r = length(gFrag);
  h = mix(h, BERM, smoothstep(R_CENTRE - 0.32, R_CENTRE - 0.06, r) * sf * smoothstep(uSpiral + 1.0, uSpiral + 2.0, s));
  return mix(BERM, h, smoothstep(0.0, 0.45, s));
}

void main() {
  mapSize = textureSize(uMap, 0);
  vec2 mp = gl_FragCoord.xy * uMapScale - 0.5;
  vec4 m = readMap(mp);
  vec2 g = (gl_FragCoord.xy - uCentre) / uUnit;
  gFrag = g;
  float r = length(g);
  float grain = (noise(g * 60.0) - 0.5) * 0.004;
  float h;
  float fr = 0.0;

  // ISLANDS
  // ripples follow the distance to everything that sits in the sand
  float field = smin(r - R_OUT, segDist(g, uGate.xy, uGate.zw) - 0.5, 0.5);
  float stoneH = -1.0;
  float stone = 0.0;
  float moss = 0.0;
  float mossH = -1.0;
  for (int i = 0; i < ${STONES}; i++) {
    vec4 st = uStone[i];
    vec4 sh = uShape[i];
    vec2 q = g - st.xy;
    q = vec2(q.x * sh.y + q.y * sh.z, -q.x * sh.z + q.y * sh.y);
    q.x /= sh.x;
    float rho = length(q);
    float a = atan(q.y, q.x);
    float rr = st.z * (1.0 + 0.07 * sin(2.0 * a + st.w) + 0.045 * sin(3.0 * a + 2.0 * st.w) + 0.02 * sin(5.0 * a + 3.0 * st.w));
    float x = rho / rr;
    float dome = sqrt(max(0.0, 1.0 - x * x));
    // weathered granite: broad lumps, ridged facets and a few hairline fissures
    float bumps = noise(q * 2.4 + st.w) * 0.55 + noise(q * 7.0 - st.w) * 0.3 + noise(q * 19.0 + st.w) * 0.15;
    float ridge = 1.0 - abs(noise(q * 4.2 + 3.0 * st.w) * 2.0 - 1.0);
    float fissure = pow(1.0 - abs(noise(q * vec2(2.2, 6.5) + st.w) * 2.0 - 1.0), 14.0);
    float hs = sh.w * st.z * pow(dome, 0.72) * (0.86 + 0.16 * bumps + 0.05 * ridge * ridge) - 0.018 * fissure * dome;
    float mOuter = rr * (1.22 + 0.16 * noise(q / max(rho, 1e-3) * 1.6 + st.w) + 0.08 * noise(q * 4.0));
    float mm = 1.0 - smoothstep(mOuter - 0.12, mOuter, rho);
    if (x < 1.0 && hs > stoneH) stoneH = hs;
    stone = max(stone, 1.0 - smoothstep(0.96, 1.0, x));
    float mh = BERM * 0.7 + 0.03 * noise(q * 14.0 + st.w) * mm;
    moss = max(moss, mm * step(0.96, x));
    if (mm > 0.0) mossH = max(mossH, mh);
    field = smin(field, (rho - mOuter) * sh.x - 0.08, SMIN_K);
  }

  if (m.x > 0.0) {
    fr = fresh(m.y);
    h = lane(m.y, m.z, m.w, fr, soft);
  } else if (r < R_CENTRE) {
    // CENTRE
    // only the gaps the spiral leaves: plain sand that rises into the rim
    h = BERM * smoothstep(R_CENTRE - 0.6, R_CENTRE - 0.1, r);
  } else if (r < R_OUT) {
    // SEAM
    // where the turns gather: straight raked lines, kept clear of the walls around them
    float near = 0.0;
    float reach = SEAM_CLEAR * uUnit * uMapScale;
    for (int k = 0; k < 8; k++) {
      float a = float(k) * 0.7854;
      vec2 o = vec2(cos(a), sin(a));
      near += coverage(mp + o * reach) + coverage(mp + o * reach * 0.5);
    }
    float open = 1.0 - smoothstep(0.0, 3.0, near);
    float lines = smoothstep(R_CENTRE + 0.1, R_CENTRE + 0.5, r) * (1.0 - smoothstep(R_OUT - 0.5, R_OUT - 0.2, r));
    h = BERM - 0.75 * G_GARDEN * groove(g.x / PITCH) * open * lines;
  } else {
    // GARDEN
    float rise = 1.0 - smoothstep(0.0, 0.32, field);
    // a few rings around each island, then plain sand so the type stays clear
    float rings = smoothstep(0.18, 0.4, field) * (1.0 - smoothstep(RINGS - 0.6, RINGS, field));
    h = BERM * rise - G_GARDEN * groove(field / PITCH) * rings;
  }
  h += grain;
  h = max(h, mossH);
  h = max(h, stoneH);

  // RAKE
  vec2 q = g - uRake.xy;
  q = vec2(dot(q, uRake.zw), dot(q, vec2(-uRake.w, uRake.z)));
  float px = 1.0 / uUnit;
  // sand heaped in front of the tines
  if (m.x > 0.0) h += 0.022 * exp(-pow((q.x - 0.13) / 0.07, 2.0)) * (1.0 - smoothstep(0.3, 0.36, abs(q.y))) * max(0.0, 1.0 - uLift * 4.0);
  float bar = (1.0 - smoothstep(BAR_W - px, BAR_W, abs(q.x))) * (1.0 - smoothstep(BAR_L - px, BAR_L, abs(q.y)));
  float barH = uLift + BAR_Z - 0.02 + 0.05 * sqrt(max(0.0, 1.0 - pow(q.x / BAR_W, 2.0)));
  // tines, one over each groove, trailing the bar
  float ty = (fract(q.y / 0.175 + 0.5) - 0.5) * 0.175;
  float tine = (1.0 - smoothstep(0.022 - px, 0.022, length(vec2(q.x + 0.1, ty)))) * step(abs(q.y), 0.35);
  float tineH = uLift + 0.09;
  float hl = clamp(q.x / HANDLE_L, 0.0, 1.0);
  float handle = step(0.0, q.x) * (1.0 - smoothstep(HANDLE_L - px, HANDLE_L, q.x)) * (1.0 - smoothstep(HANDLE_W - px, HANDLE_W, abs(q.y)));
  float handleH = uLift + mix(HANDLE_A, HANDLE_B, hl) - 0.03 + 0.045 * sqrt(max(0.0, 1.0 - pow(q.y / HANDLE_W, 2.0)));

#ifdef AUX
  float wood = max(max(tine, bar), handle);
  // height for the blur, stone, moss above a half and freshness below it, wood
  oHeight = vec4((h + 0.1) / 1.2, stone, 0.5 + 0.5 * moss - 0.5 * fr, wood);
#else
  if (tine > 0.0 && tineH > h) h = mix(h, tineH, tine);
  if (bar > 0.0 && barH > h) h = mix(h, barH, bar);
  if (handle > 0.0 && handleH > h) h = mix(h, handleH, handle);
  oHeight = vec4(h, 0.0, 0.0, 1.0);
#endif
}`;

export const HEIGHT_FS = height(false);
export const AUX_FS = height(true);

// SHADE
// low sun across the height field, marched shadows, a blurred level for contact darkening
export const SHADE_FS = `#version 300 es
precision highp float;
uniform sampler2D uHeight;
uniform sampler2D uAux;
uniform vec2  uRes;
uniform float uUnit;
uniform float uAoLod;
uniform vec3  uSun;
uniform vec2  uCentre;
uniform vec4  uRake;
uniform float uLift;
out vec4 oColor;

const int   STEPS    = 22;
const float PENUMBRA = 0.09;
const vec3  SAND     = vec3(0.936, 0.912, 0.868);
const vec3  STONE    = vec3(0.4, 0.39, 0.37);
const vec3  MOSS     = vec3(0.37, 0.43, 0.20);
const vec3  WOOD     = vec3(0.56, 0.41, 0.27);
const vec3  SKY      = vec3(0.86, 0.88, 0.93);
const vec3  SUN      = vec3(1.0, 0.965, 0.91);
${RAKE}
${NOISE}

float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}

// a raised segment's shadow, projected onto the ground along the sun
float rod(vec2 g, float h, vec2 a, float za, vec2 b, float zb, float w, vec2 dir, float tanEl) {
  vec2 sa = a - dir * max(za - h, 0.0) / tanEl;
  vec2 sb = b - dir * max(zb - h, 0.0) / tanEl;
  float pen = PENUMBRA * 0.5 * max(0.5 * (za + zb) - h, 0.0) / tanEl + 0.01;
  return smoothstep(w - pen, w + pen, segDist(g, sa, sb));
}

void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  vec2 uv = gl_FragCoord.xy / uRes;
  float h = texelFetch(uHeight, ip, 0).r;
  vec4 aux = texture(uAux, uv);
  float wood = aux.a;
  float stone = aux.g;
  float moss = max(aux.b - 0.5, 0.0) * 2.0;
  float fr = max(0.5 - aux.b, 0.0) * 2.0;
  float hx = texelFetch(uHeight, ip + ivec2(1, 0), 0).r - texelFetch(uHeight, ip - ivec2(1, 0), 0).r;
  float hy = texelFetch(uHeight, ip + ivec2(0, 1), 0).r - texelFetch(uHeight, ip - ivec2(0, 1), 0).r;
  vec3 n = normalize(vec3(-hx * uUnit * 0.5, -hy * uUnit * 0.5, 1.0));

  // SHADOW
  float sh = 1.0;
  float t = 0.0;
  // dithered start so thin casters leave soft shadows, not bands
  float jit = fract(52.9829 * fract(dot(gl_FragCoord.xy, vec2(0.06711, 0.00584))));
  float stp = 0.012 * uUnit * mix(1.0, 1.24, jit);
  vec2 dir = normalize(uSun.xy);
  float tanEl = uSun.z / length(uSun.xy);
  for (int i = 0; i < STEPS; i++) {
    t += stp;
    stp *= 1.24;
    vec2 sp = gl_FragCoord.xy + dir * t;
    if (sp.x < 0.0 || sp.y < 0.0 || sp.x > uRes.x || sp.y > uRes.y) break;
    float du = t / uUnit;
    float ray = h + du * tanEl;
    // the ground only; the rake is too thin to march and gets its own shadow below
    float hs = texture(uAux, sp / uRes).a > 0.02 ? -1.0 : texture(uHeight, sp / uRes).r;
    sh = min(sh, clamp((ray - hs) / (du * PENUMBRA), 0.0, 1.0));
    if (sh <= 0.0) break;
  }
  sh = sh * sh * (3.0 - 2.0 * sh);

  vec2 g = (gl_FragCoord.xy - uCentre) / uUnit;
  vec2 rd = uRake.zw;
  vec2 rp = vec2(-rd.y, rd.x);
  if (wood < 0.5) {
    sh *= rod(g, h, uRake.xy - rp * BAR_L, uLift + BAR_Z, uRake.xy + rp * BAR_L, uLift + BAR_Z, BAR_W, dir, tanEl);
    sh *= rod(g, h, uRake.xy, uLift + HANDLE_A, uRake.xy + rd * HANDLE_L, uLift + HANDLE_B, HANDLE_W, dir, tanEl);
  }

  float blur = textureLod(uAux, uv, uAoLod).r * 1.2 - 0.1;
  float ao = clamp(1.0 - max(blur - h, 0.0) * 5.0, 0.55, 1.0);

  // ALBEDO
  vec3 alb = SAND * (0.985 + 0.03 * noise(g * 0.6)) * (1.0 + (hash(gl_FragCoord.xy) - 0.5) * 0.045);
  alb *= 1.0 - 0.035 * fr;
  // STONE
  // grey granite: mottled, pale and dark grains, darker in the dips, pale lichen on the tops
  float mott = noise(g * 1.7) * 0.5 + noise(g * 5.0) * 0.3 + noise(g * 13.0) * 0.2;
  vec3 stoneAlb = STONE * (0.72 + 0.5 * mott);
  stoneAlb = mix(stoneAlb, vec3(0.52, 0.5, 0.47), smoothstep(0.72, 0.8, noise(g * 47.0)) * 0.7);
  stoneAlb *= 1.0 - 0.3 * smoothstep(0.76, 0.84, noise(g * 39.0 + 7.3));
  stoneAlb *= mix(0.78, 1.0, smoothstep(0.55, 0.95, ao));
  float lichen = smoothstep(0.6, 0.72, noise(g * 2.1 + 5.0) * 0.7 + noise(g * 9.0) * 0.3) * smoothstep(0.7, 0.95, n.z);
  stoneAlb = mix(stoneAlb, vec3(0.5, 0.52, 0.44) * (0.9 + 0.2 * noise(g * 30.0)), lichen * 0.75);
  vec3 mossAlb = mix(MOSS * 0.7, MOSS * 1.15, noise(g * 11.0)) * (0.8 + 0.4 * noise(g * 31.0));
  vec2 wq = g - uRake.xy;
  vec3 woodAlb = WOOD * (0.9 + 0.15 * noise(vec2(dot(wq, rd) * 3.0, dot(wq, rp) * 60.0)));
  alb = mix(alb, mossAlb, moss);
  alb = mix(alb, stoneAlb, stone);
  alb = mix(alb, woodAlb, wood);

  // LIGHT
  float flatLit = uSun.z;
  float lit = max(dot(n, uSun), 0.0) / flatLit;
  lit = lit / (1.0 + 0.3 * max(lit - 1.0, 0.0));
  vec3 col = alb * (SKY * 0.52 * (0.6 + 0.4 * n.z) * ao + SUN * 0.57 * lit * sh);
  vec3 hv = normalize(uSun + vec3(0.0, 0.0, 1.0));
  col += 0.035 * stone * pow(max(dot(n, hv), 0.0), 18.0) * sh;

  float v = length(uv - 0.5);
  col *= 1.0 - 0.07 * v * v;
  oColor = vec4(col, 1.0);
}`;
