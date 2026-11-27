// MATRICES
// column-major, written into preallocated arrays so nothing here allocates once running

export type V3 = Float32Array;

export const v3 = (x = 0, y = 0, z = 0) => new Float32Array([x, y, z]);

export function norm3(o: V3, x: number, y: number, z: number) {
  const l = Math.hypot(x, y, z) || 1;
  o[0] = x / l;
  o[1] = y / l;
  o[2] = z / l;
  return o;
}

export function cross3(o: V3, a: V3, b: V3) {
  const x = a[1] * b[2] - a[2] * b[1];
  const y = a[2] * b[0] - a[0] * b[2];
  const z = a[0] * b[1] - a[1] * b[0];
  return norm3(o, x, y, z);
}

export function ident(o: Float32Array, at = 0) {
  for (let i = 0; i < 16; i++) o[at + i] = i % 5 === 0 ? 1 : 0;
  return o;
}

// MUL
// o = a * b, 4x4; o must not alias a or b
export function mul(o: Float32Array, a: Float32Array, b: Float32Array, at = 0, bt = 0) {
  for (let c = 0; c < 4; c++) {
    const b0 = b[bt + c * 4];
    const b1 = b[bt + c * 4 + 1];
    const b2 = b[bt + c * 4 + 2];
    const b3 = b[bt + c * 4 + 3];
    for (let r = 0; r < 4; r++) {
      o[at + c * 4 + r] = a[r] * b0 + a[4 + r] * b1 + a[8 + r] * b2 + a[12 + r] * b3;
    }
  }
  return o;
}

export function view(o: Float32Array, eye: V3, right: V3, up: V3, fwd: V3) {
  o[0] = right[0];
  o[4] = right[1];
  o[8] = right[2];
  o[1] = up[0];
  o[5] = up[1];
  o[9] = up[2];
  o[2] = -fwd[0];
  o[6] = -fwd[1];
  o[10] = -fwd[2];
  o[3] = 0;
  o[7] = 0;
  o[11] = 0;
  o[12] = -(right[0] * eye[0] + right[1] * eye[1] + right[2] * eye[2]);
  o[13] = -(up[0] * eye[0] + up[1] * eye[1] + up[2] * eye[2]);
  o[14] = fwd[0] * eye[0] + fwd[1] * eye[1] + fwd[2] * eye[2];
  o[15] = 1;
  return o;
}

// PERSPECTIVE
// lens shift in NDC: subject off centre without tilting the camera
export function persp(
  o: Float32Array,
  tanHalf: number,
  aspect: number,
  near: number,
  far: number,
  sx: number,
  sy: number,
) {
  o.fill(0);
  o[0] = 1 / (tanHalf * aspect);
  o[5] = 1 / tanHalf;
  o[8] = -sx;
  o[9] = -sy;
  o[10] = -(far + near) / (far - near);
  o[11] = -1;
  o[14] = (-2 * far * near) / (far - near);
  return o;
}

export function ortho(o: Float32Array, r: number, near: number, far: number) {
  o.fill(0);
  o[0] = 1 / r;
  o[5] = 1 / r;
  o[10] = -2 / (far - near);
  o[14] = -(far + near) / (far - near);
  o[15] = 1;
  return o;
}

export function spin(
  o: Float32Array,
  at: number,
  ax: number,
  ay: number,
  az: number,
  a: number,
  px: number,
  py: number,
  pz: number,
) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  const t = 1 - c;
  const m00 = t * ax * ax + c;
  const m01 = t * ax * ay - s * az;
  const m02 = t * ax * az + s * ay;
  const m10 = t * ax * ay + s * az;
  const m11 = t * ay * ay + c;
  const m12 = t * ay * az - s * ax;
  const m20 = t * ax * az - s * ay;
  const m21 = t * ay * az + s * ax;
  const m22 = t * az * az + c;
  o[at] = m00;
  o[at + 1] = m10;
  o[at + 2] = m20;
  o[at + 3] = 0;
  o[at + 4] = m01;
  o[at + 5] = m11;
  o[at + 6] = m21;
  o[at + 7] = 0;
  o[at + 8] = m02;
  o[at + 9] = m12;
  o[at + 10] = m22;
  o[at + 11] = 0;
  o[at + 12] = px - (m00 * px + m01 * py + m02 * pz);
  o[at + 13] = py - (m10 * px + m11 * py + m12 * pz);
  o[at + 14] = pz - (m20 * px + m21 * py + m22 * pz);
  o[at + 15] = 1;
  return o;
}

export function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
