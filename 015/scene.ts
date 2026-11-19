// SCENE
// world units are metres; the ground is a plane CAM_H below the eye, x across, z ahead.
// shared by the shader and the camera framing

export const SCENE = {
  LENS: 0.34, // field of view against the first wide one; smaller is more telephoto
  SKY_LENS: 0.5, // the sky, sun and clouds were drawn for this lens and keep their size
  CAM_H: 1.6, // eye height above the road, m: a driver's eye, low enough to see the mirage
  CAR_Z: 150, // a car far ahead in the lane, always this far off, standing in the water
  LANE_X: 1.25, // centre of our lane, where the car ahead drives
  HEAT_K: 0.65, // how strong the shimmer is, against the first cut
  STEADY_M: 70, // nothing nearer than this is bent by the heat; it ramps in over 60% more
  FLOAT_M: 190, // past this, vehicles sink into the mirage and seem to float
  ROAD_HALF: 2.5, // half the road's width, m
  DASH_M: 12, // centre line repeats every this many metres
  DASH_ON: 0.28, // share of it painted
  POLE_SPACING_M: 34,
  POLE_PHASE_M: 19, // where the first pole stands
  POLE_H: 8.6,
  POLE_W: 0.3,
  ARM_Y: 7.7, // crossarm height
  ARM_HALF: 1.25,
  SAG_M: 0.8, // how far the wires sag between poles
  POST_X: 3.9, // marker posts on both shoulders
  POST_SPACING_M: 30,
  POST_H: 1.05,
  POST_W: 0.13,
  SHADOW_K: 2.3, // shadow length per metre of height; the sun is low
  FOG_PER_M: 0.0045,
  MIRROR_K: 3.2, // the hot air bends rays flat, so reflections of far things stretch this much
  DEVIL_LIFE_S: 48, // a dust devil lives this long before the next turns up elsewhere
  HAWK_CYCLE_S: 80, // the hawk glides off and comes back once in this long
  HAWK_FLAP_S: 7, // and beats its wings once in this long
  LAKE_M: 520, // the sliver of water over the sand lies past this, at the foot of the dunes
};

// PALETTE
// flat paint for the shader
export const COLORS = {
  SKY_TOP: "#86a9c0",
  SKY_MID: "#c9c7c0",
  SKY_LOW: "#efcfae",
  HAZE: "#f7e3c6",
  SUN: "#fffaf0",
  SUN_GLOW: "#ffe6bf",
  CLOUD_LIT: "#fcf2e4",
  CLOUD_SHADE: "#dcbdb6",
  FAR_LIT: "#e9c3aa",
  FAR_SHADE: "#c7a3a9",
  MID_LIT: "#eab084",
  MID_SHADE: "#be7d7f",
  NEAR_LIT: "#e9a46b",
  NEAR_SHADE: "#b4665a",
  SAND_NEAR: "#e0a36c",
  SAND_FAR: "#efc49b",
  SAND_RIPPLE: "#cf8b5e",
  SHADOW: "#9a88a8",
  ASPHALT: "#4a3b47",
  ASPHALT_FAR: "#8d7381",
  PAINT: "#f4e8cf",
  DASH: "#f1b54c",
  POLE_DARK: "#3e2c31",
  TAIL: "#c2402e",
  POLE_LIT: "#b8704f",
  POST_BODY: "#f1e6d6",
  POST_SHADE: "#b99a9b",
  REFLECTOR: "#e8642f",
  WATER: "#a3c3d2",
  SILVER: "#c4d3d8",
  HEAD: "#fff6dc",
  HEAD_GLOW: "#ffd9a0",
  TINT_A: "#ece4d8",
  TINT_B: "#d9a387",
  TINT_C: "#a9bab4",
  TINT_D: "#dcc6a4",
};
