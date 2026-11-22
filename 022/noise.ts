// NOISE
// integer-hashed value noise, cheap enough to sample a few hundred thousand points

function hash(x: number, y: number, z: number) {
  let n = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177)) | 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

const fade = (t: number) => t * t * (3 - 2 * t);

export function noise3(x: number, y: number, z: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = fade(x - ix);
  const fy = fade(y - iy);
  const fz = fade(z - iz);
  const a = hash(ix, iy, iz) + (hash(ix + 1, iy, iz) - hash(ix, iy, iz)) * fx;
  const b = hash(ix, iy + 1, iz) + (hash(ix + 1, iy + 1, iz) - hash(ix, iy + 1, iz)) * fx;
  const c = hash(ix, iy, iz + 1) + (hash(ix + 1, iy, iz + 1) - hash(ix, iy, iz + 1)) * fx;
  const d =
    hash(ix, iy + 1, iz + 1) + (hash(ix + 1, iy + 1, iz + 1) - hash(ix, iy + 1, iz + 1)) * fx;
  const e = a + (b - a) * fy;
  const f = c + (d - c) * fy;
  return e + (f - e) * fz;
}

// -0.5..0.5, three octaves
export function fbm3(x: number, y: number, z: number) {
  return (
    noise3(x, y, z) * 0.57 +
    noise3(x * 2.03 + 11, y * 2.03, z * 2.03) * 0.29 +
    noise3(x * 4.1, y * 4.1 + 7, z * 4.1) * 0.14 -
    0.5
  );
}

// 0..1 along one axis
export function noise1(x: number, seed = 0) {
  const i = Math.floor(x);
  const f = fade(x - i);
  return hash(i, seed, 7) + (hash(i + 1, seed, 7) - hash(i, seed, 7)) * f;
}

// seeded random, so a chunk comes back the same every time it is built
export function rng(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
