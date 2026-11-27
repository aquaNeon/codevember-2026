export const INK_VS = `
precision highp float;

in vec3 position;
in vec3 normal;

uniform mat4 modelMatrix;
uniform mat4 viewMatrix;
uniform mat4 projectionMatrix;
uniform mat3 normalMatrix;

out vec3 vObj;
out vec3 vWorld;
out vec3 vWorldN;
out vec3 vViewN;

void main() {
  vObj = position;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  vWorldN = normalize(mat3(modelMatrix) * normal);
  vViewN = normalize(normalMatrix * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

// ENGRAVING
// tone from light, then up to three line families whose width swells with darkness
export const INK_FS = `
precision highp float;

uniform vec3  cameraPosition;
uniform vec3  uLight;
uniform vec3  uAxisA;
uniform vec3  uAxisB;
uniform float uDensity;
uniform float uScale;
uniform float uSpacing;
uniform float uTone;
uniform float uEdge;
uniform float uSolid;
uniform float uPool;
uniform float uTicks;

in vec3 vObj;
in vec3 vWorld;
in vec3 vWorldN;
in vec3 vViewN;

out vec4 fragColor;

float lines(float ph, float w) {
  float aa = fwidth(ph);
  float d = abs(fract(ph) - 0.5);
  float ink = (1.0 - smoothstep(w - aa, w + aa, d)) * clamp(w / aa, 0.0, 1.0);
  // ANTI-MOIRE
  // unresolvable lines fade to their average tone
  return mix(ink, 2.0 * w, smoothstep(0.35, 0.7, aa));
}

float ring(float r, float at, float halfW) {
  float aa = fwidth(r);
  return 1.0 - smoothstep(halfW - aa, halfW + aa, abs(r - at));
}

void main() {
  float face = gl_FrontFacing ? 1.0 : -1.0;
  vec3 n = normalize(vWorldN) * face;
  vec3 v = normalize(cameraPosition - vWorld);
  float nl = dot(n, uLight);
  float spec = pow(max(dot(reflect(-uLight, n), v), 0.0), 28.0);
  float t = uTone * (0.1 + 0.62 * max(nl, 0.0) + 0.28 * (nl * 0.5 + 0.5)) + spec * 0.7;

  // TABLE
  // soft shade pool, nothing beyond
  if (uPool > 0.5) {
    float r = length((vWorld.xz - vec2(0.5, -0.32)) * vec2(1.0, 1.25));
    t = mix(0.34, 1.25, smoothstep(0.35, 1.45, r));
  }

  float w1 = 0.36 * clamp((1.2 - t) / 1.2, 0.0, 1.0);
  float w2 = 0.3 * clamp((0.62 - t) / 0.62, 0.0, 1.0);
  float w3 = 0.28 * clamp((0.3 - t) / 0.3, 0.0, 1.0);

  // BURIN
  // slow width swell along each line
  float wob = 0.06 * sin(dot(vObj, vec3(9.1, 7.3, 8.7)));
  float k = uDensity * uScale;
  float ink = lines(dot(vObj, uAxisA) * k + wob, w1);
  ink = max(ink, lines(dot(vObj, uAxisB) * k, w2));
  ink = max(ink, lines((gl_FragCoord.x - gl_FragCoord.y) / uSpacing, w3));

  // DEGREE RING
  // signs, five degrees, single degrees
  if (uTicks > 0.5 && n.y > 0.5) {
    float r = length(vObj.xz);
    float a = atan(vObj.z, vObj.x) / 6.2831853;
    float signs = lines(a * 12.0, 0.01) * step(1.06, r);
    float five = lines(a * 72.0, 0.05) * step(1.22, r);
    float one = lines(a * 360.0, 0.12) * step(1.29, r);
    float rings = max(ring(r, 1.06, 0.003), max(ring(r, 1.22, 0.0025), ring(r, 1.29, 0.002)));
    ink = max(ink * step(r, 1.06), max(max(signs, five), max(one, rings)));
  }

  ink = mix(ink, 1.0, uSolid);
  vec3 vn = normalize(vViewN) * face;
  fragColor = vec4(ink, vn.xy, uEdge);
}
`;

export const POST_VS = `
precision highp float;

in vec3 position;

out vec2 vUv;

void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// OUTLINES
// ink where depth jumps (silhouettes) or the normal turns sharply (creases)
export const POST_FS = `
precision highp float;

uniform sampler2D uG;
uniform sampler2D uDepth;
uniform vec2      uTexel;
uniform float     uNear;
uniform float     uFar;
uniform float     uReach;
uniform vec3      uInk;

in vec2 vUv;

out vec4 fragColor;

float lin(float z) {
  float nd = z * 2.0 - 1.0;
  return 2.0 * uNear * uFar / (uFar + uNear - nd * (uFar - uNear));
}

float edge(vec2 o, vec4 gc, float dc) {
  vec2 uv = vUv + o * uTexel * uReach;
  vec4 g = texture(uG, uv);
  float d = lin(texture(uDepth, uv).r);
  float de = smoothstep(0.012, 0.035, abs(d - dc) / min(d, dc));
  float ne = smoothstep(0.3, 0.65, length(g.gb - gc.gb));
  return max(gc.a, g.a) * max(de, ne);
}

void main() {
  vec4 gc = texture(uG, vUv);
  float dc = lin(texture(uDepth, vUv).r);
  float e = edge(vec2(1.0, 0.0), gc, dc);
  e = max(e, edge(vec2(-1.0, 0.0), gc, dc));
  e = max(e, edge(vec2(0.0, 1.0), gc, dc));
  e = max(e, edge(vec2(0.0, -1.0), gc, dc));
  e = max(e, 0.7 * edge(vec2(0.7, 0.7), gc, dc));
  e = max(e, 0.7 * edge(vec2(-0.7, 0.7), gc, dc));
  e = max(e, 0.7 * edge(vec2(0.7, -0.7), gc, dc));
  e = max(e, 0.7 * edge(vec2(-0.7, -0.7), gc, dc));
  float a = clamp(max(gc.r, e), 0.0, 1.0);
  fragColor = vec4(uInk * a, a);
}
`;

// ORBITS
// dotted paths after the plate, depth-tested against it
export const ORBIT_FS = `
precision highp float;

uniform sampler2D uDepth;
uniform vec2      uRes;
uniform vec3      uInk;
uniform float     uAlpha;

out vec4 fragColor;

void main() {
  float scene = texture(uDepth, gl_FragCoord.xy / uRes).r;
  if (scene < gl_FragCoord.z - 2e-5) discard;
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float a = uAlpha * (1.0 - smoothstep(0.55, 1.0, r));
  fragColor = vec4(uInk * a, a);
}
`;

// ORBIT DOTS
// round points, constant size along the ellipse
export const ORBIT_VS = `
precision highp float;

in vec3 position;

uniform mat4  modelViewMatrix;
uniform mat4  projectionMatrix;
uniform float uSize;

void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = uSize;
}
`;
