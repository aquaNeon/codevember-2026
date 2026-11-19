export const SLOTS = 4;

// ashima 3d simplex noise
export const NOISE = /* glsl */ `
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 10.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x;
  p1 *= norm.y;
  p2 *= norm.z;
  p3 *= norm.w;
  vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 105.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

// FORM
// a 3d cross: a centre cube with an arm on each face, three bars through the middle,
// every edge on a generous bevel. the skin is the same bars blended with a wide smooth-min,
// so it spans the hollows between the arms instead of following them in
export const ARM = { half: 0.3, reach: 0.9, bevel: 0.11, fillet: 0.06 }; // change the cross here
export const SKIN = { bridge: 0.42, gap: 0.022 };

const FORM = /* glsl */ `
const float ARM_HALF = ${ARM.half.toFixed(3)};
const float ARM_REACH = ${ARM.reach.toFixed(3)};
const float BEVEL = ${ARM.bevel.toFixed(3)};
const float FILLET = ${ARM.fillet.toFixed(3)};
const float BRIDGE = ${SKIN.bridge.toFixed(3)};
const float GAP = ${SKIN.gap.toFixed(3)};

float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float roundBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

float bars(vec3 p, float k) {
  float x = roundBox(p, vec3(ARM_REACH, ARM_HALF, ARM_HALF), BEVEL);
  float y = roundBox(p, vec3(ARM_HALF, ARM_REACH, ARM_HALF), BEVEL);
  float z = roundBox(p, vec3(ARM_HALF, ARM_HALF, ARM_REACH), BEVEL);
  return smin(smin(x, y, k), z, k);
}

// the form gives a little under a press too, so the skin has somewhere to go
float formSd(vec3 p, vec4 dents[${SLOTS}]) {
  float d = bars(p, FILLET);
  vec3 n = normalize(p + 1e-5);
  for (int i = 0; i < ${SLOTS}; i++) {
    float c = 1.0 - dot(n, dents[i].xyz);
    d += 0.18 * max(dents[i].w, 0.0) * exp(-c * 10.0);
  }
  return d;
}

float skinSd(vec3 p, vec4 dents[${SLOTS}]) {
  return smin(bars(p, BRIDGE), formSd(p, dents), 0.02) - GAP;
}

// both shapes are star-shaped round the centre, so a short inward march finds the surface along any direction
float formAt(vec3 n, vec4 dents[${SLOTS}]) {
  float t = 1.3;
  for (int i = 0; i < 22; i++) t -= formSd(n * t, dents);
  return t;
}

float skinAt(vec3 n, vec4 dents[${SLOTS}]) {
  float t = 1.3;
  for (int i = 0; i < 18; i++) t -= skinSd(n * t, dents);
  return t;
}
`;

export const SAC_VS = /* glsl */ `
uniform float uTime;
uniform float uBreath;
uniform vec4  uDent[${SLOTS}];

varying vec3  vNormal;
varying vec3  vView;
varying vec3  vDir;
varying float vDent;
varying float vLift;

${NOISE}
${FORM}

// SKIN
// cling film over the form: taut over the corners, a little looser over the faces.
// a press pushes it flat onto the form with a ring of small wrinkles; a pull lifts it into a tent
float radius(vec3 n, out float dent, out float lift, out vec3 slid) {
  float rf = formAt(n, uDent);
  float r = skinAt(n, uDent);
  // breathing: the film over the hollows rises and falls, the parts lying on the form barely move
  float span = smoothstep(0.0, 0.25, r - rf);
  r += (uBreath * 2.5 + 0.006 * snoise(n * 2.2 + vec3(0.0, uTime * 0.05, uTime * 0.04))) * (0.3 + span);
  dent = 0.0;
  lift = 0.0;
  slid = n;
  for (int i = 0; i < ${SLOTS}; i++) {
    vec3 d = uDent[i].xyz;
    float a = uDent[i].w;
    float push = max(a, 0.0);
    float pull = max(-a, 0.0);
    float c = 1.0 - dot(n, d);
    float pit = exp(-c * 11.0);
    vec3 t = normalize(cross(d, abs(d.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
    vec3 b = cross(d, t);
    float ang = atan(dot(n, b), dot(n, t));
    float ring = exp(-c * 7.0) - exp(-c * 18.0);
    r -= push * pit;
    // radial creases only, fading in and out across the ring, so the dimple stays one smooth shape
    r += push * 0.022 * ring * sin(ang * 14.0);
    // a tent: a sharp peak at the grab, sloping skin around it
    float tent = exp(-sqrt(c + 1e-5) * 4.5);
    r += pull * tent;
    dent += push * pit;
    lift += pull * tent;
    // the skin slides in toward a press and out along a pull, so its pattern moves with it
    slid -= d * (push * ring * 0.35 - pull * tent * 0.2);
  }
  // pressed flat onto the form, never through it
  r = max(r, rf + 0.004);
  slid = normalize(slid);
  return r;
}

void main() {
  vec3 n = normalize(position);
  vec3 t1 = normalize(cross(n, abs(n.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
  vec3 t2 = cross(n, t1);
  float dent;
  float lift;
  float skip;
  vec3 slid;
  vec3 junk;
  vec3 p = n * radius(n, dent, lift, slid);
  vec3 n1 = normalize(n + t1 * 0.012);
  vec3 n2 = normalize(n + t2 * 0.012);
  vec3 p1 = n1 * radius(n1, skip, skip, junk);
  vec3 p2 = n2 * radius(n2, skip, skip, junk);
  vNormal = normalize(normalMatrix * normalize(cross(p1 - p, p2 - p)));
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vView = -mv.xyz;
  vDir = slid;
  vDent = dent;
  vLift = lift;
  gl_Position = projectionMatrix * mv;
}
`;

export const SAC_FS = /* glsl */ `
uniform float uTime;
uniform float uPaper;
uniform float uSide;

varying vec3  vNormal;
varying vec3  vView;
varying vec3  vDir;
varying float vDent;
varying float vLift;

${NOISE}

// THIN FILM
// two-beam interference of a soap-like film, thickness in nm
vec3 film(float d, float ct) {
  vec3 ph = 12.566 * 1.33 * d * ct / vec3(650.0, 540.0, 460.0);
  return 0.5 + 0.5 * cos(ph);
}

void main() {
  // three flips the winding for BackSide, so the wall says which one it is
  bool front = uSide > 0.0;
  vec3 N = normalize(vNormal) * uSide;
  vec3 V = normalize(vView);
  float c = clamp(dot(N, V), 0.0, 1.0);
  float ct = sqrt(1.0 - (1.0 - c * c) / 1.769);
  float fres = pow(1.0 - c, 3.0);

  // film drains downward like a bubble: thin at the top, thicker below, slow swirls on top
  float swirl = snoise(vDir * 0.9 + vec3(uTime * 0.012, -uTime * 0.02, 0.0));
  // pressed skin thickens, stretched skin thins and runs to the blues\n  float th = 460.0 - 140.0 * vDir.y + 100.0 * swirl + 260.0 * vDent - 520.0 * vLift;
  vec3 irid = film(th, ct);
  irid = mix(vec3(dot(irid, vec3(0.333))), irid, 0.9);

  // VEINS
  // meridians running pole to pole, wandering a little, like the ribs of a seed pod
  float phi = atan(vDir.z, vDir.x);
  float wob = 0.35 * snoise(vDir * 1.6 + 4.0) + 0.12 * snoise(vDir * 4.0 + 9.0);
  float rib = abs(sin(phi * 4.0 + wob * 2.2));
  float fine = abs(sin(phi * 11.0 + wob * 3.5 + 1.3));
  float pole = 1.0 - abs(vDir.y);
  float vein = (1.0 - smoothstep(0.0, 0.045, rib)) * smoothstep(0.0, 0.5, pole);
  vein += 0.4 * (1.0 - smoothstep(0.0, 0.03, fine)) * smoothstep(0.25, 0.8, pole)
    * smoothstep(-0.1, 0.5, snoise(vDir * 1.3 + 2.0));

  // LIGHT
  // view space, fixed to the camera
  vec3 L = normalize(vec3(-0.5, 0.7, 0.55));
  vec3 H = normalize(L + V);
  float nh = max(dot(N, H), 0.0);
  float spec = pow(nh, 400.0) * 2.2 + pow(nh, 40.0) * 0.05;
  vec3 L2 = normalize(vec3(0.75, -0.45, 0.35));
  spec += pow(max(dot(N, normalize(L2 + V)), 0.0), 60.0) * 0.25;

  float side = front ? 1.0 : 0.5;
  // over the white form the film has to tint, not just glow: a little more body on the face
  float a = (0.06 + 0.85 * fres) * side;
  vec3 rgb = mix(vec3(0.95 - 0.25 * uPaper), irid * (1.15 - 0.45 * uPaper), 0.75 + 0.25 * smoothstep(0.05, 0.6, fres)) * a;
  vec3 veinCol = mix(vec3(0.85, 0.72, 0.78), vec3(0.42, 0.34, 0.4), uPaper);
  float va = vein * (0.1 + 0.3 * fres) * side;
  rgb += veinCol * va;
  // faint film colour across the face, added light only so the middle stays clear
  float band = smoothstep(0.2, 0.9, dot(irid, vec3(0.8, 0.1, 0.6)) * 0.7);
  rgb += irid * irid * (0.02 + 0.05 * band) * (1.0 - fres) * side * (1.0 - uPaper);
  a += va * 0.6;
  rgb += vec3(1.0, 0.98, 0.95) * spec * side;
  a = clamp(a + spec * 0.4 * side, 0.0, 1.0);

  // paper: the film has to darken the page instead of glowing on it
  rgb = mix(rgb, rgb * vec3(0.5, 0.46, 0.56), uPaper * (1.0 - min(spec, 1.0)));
  gl_FragColor = vec4(rgb, a);
}
`;

// the form is ray-marched inside a proxy box, so its bevels and inner corners stay exact at any size
export const SOLID_VS = /* glsl */ `
varying vec3 vObj;

void main() {
  vObj = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const SOLID_FS = /* glsl */ `
uniform vec3 uLit;
uniform vec3 uShade;
uniform vec3 uRim;
uniform vec3 uCam;
uniform vec4 uDent[${SLOTS}];
// three fills these for any program that declares them, fragment stage included
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;

varying vec3 vObj;

${FORM}

vec3 grad(vec3 p) {
  const vec2 k = vec2(1.0, -1.0) * 0.002;
  return normalize(
    k.xyy * formSd(p + k.xyy, uDent) + k.yyx * formSd(p + k.yyx, uDent) +
    k.yxy * formSd(p + k.yxy, uDent) + k.xxx * formSd(p + k.xxx, uDent)
  );
}

// MATTE CLAY
// opaque, soft diffuse only: wrapped key, a cool bounce from below, a little occlusion in the inner corners
void main() {
  vec3 rd = normalize(vObj - uCam);
  vec3 p = vObj;
  float hit = 0.0;
  for (int i = 0; i < 64; i++) {
    float d = formSd(p, uDent);
    if (d < 0.0008) {
      hit = 1.0;
      break;
    }
    p += rd * d * 0.9;
    if (dot(p, p) > 4.0) break;
  }
  if (hit < 0.5) discard;
  vec3 No = grad(p);
  vec3 N = normalize((modelViewMatrix * vec4(No, 0.0)).xyz);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec3 V = normalize(-mv.xyz);
  float key = dot(N, normalize(vec3(-0.5, 0.7, 0.55))) * 0.5 + 0.5;
  float bounce = max(dot(N, normalize(vec3(0.4, -0.8, 0.3))), 0.0);
  float edge = 1.0 - max(dot(N, V), 0.0);
  // cheap occlusion: how far the surface sits inside the bridged hull
  float ao = clamp(1.0 - (bars(p, BRIDGE) - bars(p, FILLET)) * -4.0, 0.55, 1.0);
  vec3 col = mix(uShade, uLit, smoothstep(0.1, 0.95, key)) * ao;
  col += uRim * bounce * 0.12;
  col *= 1.0 - 0.2 * edge * edge;
  gl_FragColor = vec4(col, 1.0);
  vec4 clip = projectionMatrix * mv;
  gl_FragDepth = clip.z / clip.w * 0.5 + 0.5;
}
`;
