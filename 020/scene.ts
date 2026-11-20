// SHELL
// a cocoon in its own frame, centred on the origin, long axis y. a silkworm cocoon:
// a fat capsule with full ends and a faint waist
export const SHELL = {
  r: 0.215,
  h: 0.34,
  p: 2.1, // end fullness, 2 is an ellipse
  waist: 0.06,
  egg: 0.1, // the lower end a little fuller
};

// half width at height y; mirrors shellR in shaders.ts
export function shellR(y: number) {
  const k = Math.min(1, Math.abs(y) / SHELL.h);
  const b = SHELL.r * Math.pow(Math.max(0, 1 - Math.pow(k, SHELL.p)), 1 / SHELL.p);
  const w = y / (0.32 * SHELL.h);
  return b * (1 - SHELL.waist * Math.exp(-w * w)) * (1 - SHELL.egg * (y / SHELL.h));
}

// CLUSTER
// world units, y up, z toward you. x, y, depth, scale, tilt (rad, top to the left), yaw.
// the first is the one nearest you; the rest hang further back, smaller and dimmer
export const CLUSTER = [
  [0.03, -0.36, 0.0, 0.68, 0.28, 0.7],
  [-0.14, 0.02, -0.3, 0.56, -0.36, 2.1],
  [0.15, 0.13, -0.5, 0.53, 0.42, 4.0],
  [-0.01, 0.42, -0.85, 0.5, -0.12, 1.2],
  [-0.23, -0.28, -0.75, 0.48, 0.85, 5.1],
  [0.24, -0.16, -1.05, 0.46, -0.65, 3.3],
] as const;
export const MAX_COCOONS = 7; // mirrors the uniform arrays in shaders.ts
// where the web gathers into the one thread it all hangs from
export const GATHER = [0.0, 0.86] as const;

// FIBRES
// the hero's budget on a large screen; the others share half as much again, by size.
// small screens draw fewer, each a little stronger
export const FELT = { count: 12000, seg: 24, len: [0.05, 0.13] };
export const FLOSS = { count: 4200, seg: 40 };
export const FUZZ = { count: 14000, seg: 10 };
export const WEB = { count: 110, seg: 40 };
export const REST_SHARE = 0.5;

// BACKDROP
// srgb hex; ?bg=0..2 picks one, the first is the default
export const BACKDROPS = ["#95877a", "#8a7e74", "#9f9183"];

// TURN
// drag to turn the cluster about its vertical axis, a little pitch with it
export const TURN = { yawRad: 1.05, pitchRad: 0.17, radPerPx: 0.006, tauS: 0.12, glideS: 0.7 };

// FRAMING
// half the frame height on wide screens, half the width on tall ones
export const FRAME = { wide: 0.82, tall: 0.5, cx: -0.3, cy: 0.04, tallCy: -0.05 };
