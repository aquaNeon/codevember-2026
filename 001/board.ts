import {
  Color,
  ShaderChunk,
  DataTexture,
  ExtrudeGeometry,
  LinearFilter,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  RedFormat,
  Shape,
  Vector3,
  Vector4,
  type IUniform,
  type WebGLProgramParametersWithUniforms,
} from "three";
import { BENCH } from "./bench";
import {
  BOARD_FS_AO,
  BOARD_FS_COLOR,
  BOARD_FS_ENV,
  BOARD_FS_NORMAL,
  BOARD_FS_PARS,
  BOARD_FS_ROUGH,
  BOARD_KEY,
  BOARD_VS,
  BOARD_VS_PARS,
} from "./shaders";

// BREAD BOARD
// an oiled wooden board on a pale worktop; flour on it is a dusting times a worked map the dough wipes

export const BOARD = { w: 5.9, d: 3.9, h: 0.13, r: 0.3, edge: 0.035 };
const FLOUR_PX = 256;
const FLOUR_SPAN = 7.6; // world units the worked map covers
const SHADE_PX = 256;
const SHADE_SPAN = 7.6;
const BLUR_PASSES = 1;
const COLORS = {
  woodA: "#b48a62",
  woodB: "#dcbf98",
  stoneA: "#f1ede6",
  stoneB: "#e6e0d6",
  flour: "#f6f3ec",
};

type Uniforms = Record<string, IUniform>;

export class Board {
  readonly meshes: Mesh[];
  readonly contact = { value: 1 };
  // half width, half depth, corner radius of the fitted board, for the worktop's contact shadow
  // the bevel grows the outline by its size, so the real edge sits that much further out
  readonly footprint = {
    value: new Vector3(BOARD.w / 2 + BOARD.edge, BOARD.d / 2 + BOARD.edge, BOARD.r + BOARD.edge),
  };
  private flourTex: DataTexture;
  private shadeTex: DataTexture;
  private flourF = new Float32Array(FLOUR_PX * FLOUR_PX).fill(0.5);
  private flourB = new Uint8Array(FLOUR_PX * FLOUR_PX);
  private shadeF = new Float32Array(SHADE_PX * SHADE_PX);
  private shadeT = new Float32Array(SHADE_PX * SHADE_PX);
  private shadeB = new Uint8Array(SHADE_PX * SHADE_PX);
  private flourDirty = true;
  private disposables: { dispose(): void }[] = [];

  readonly field: DataTexture;
  readonly fieldData: Uint8Array;
  readonly fieldBox = { value: new Vector4(0, 0, 1, 1) };

  constructor(win: Uniforms, fieldW: number, fieldH: number) {
    this.fieldData = new Uint8Array(fieldW * fieldH * 4);
    this.field = new DataTexture(this.fieldData, fieldW, fieldH);
    this.field.magFilter = this.field.minFilter = LinearFilter;
    this.field.generateMipmaps = false;
    this.flourTex = map(this.flourB, FLOUR_PX);
    this.shadeTex = map(this.shadeB, SHADE_PX);
    this.flush();

    const shared: Uniforms = {
      uFlourMap: { value: this.flourTex },
      uShade: { value: this.shadeTex },
      uSpan: { value: FLOUR_SPAN },
      uShadeSpan: { value: SHADE_SPAN },
      uBoard: this.footprint,
      uField: { value: this.field },
      uFieldBox: this.fieldBox,
      uContact: this.contact,
      uFlour: { value: new Color(COLORS.flour) },
      uWin: win.uWin,
      uKeyDir: win.uKeyDir,
      uWinColor: win.uWinColor,
    };

    // BOARD
    const { w, d, h, r, edge } = BOARD;
    const s = new Shape();
    const x0 = -w / 2 + r,
      x1 = w / 2 - r,
      y0 = -d / 2 + r,
      y1 = d / 2 - r;
    s.moveTo(x0, -d / 2);
    s.lineTo(x1, -d / 2);
    s.quadraticCurveTo(w / 2, -d / 2, w / 2, y0);
    s.lineTo(w / 2, y1);
    s.quadraticCurveTo(w / 2, d / 2, x1, d / 2);
    s.lineTo(x0, d / 2);
    s.quadraticCurveTo(-w / 2, d / 2, -w / 2, y1);
    s.lineTo(-w / 2, y0);
    s.quadraticCurveTo(-w / 2, -d / 2, x0, -d / 2);
    const boardGeo = new ExtrudeGeometry(s, {
      depth: h,
      bevelEnabled: true,
      bevelThickness: edge,
      bevelSize: edge,
      bevelSegments: 3,
      curveSegments: 8,
    });
    boardGeo.rotateX(-Math.PI / 2);
    // top bevel ends at 0; the bottom bevel sits under the worktop so the side meets it square
    boardGeo.translate(0, -h - edge, 0);
    const boardMat = surface(shared, COLORS.woodA, COLORS.woodB, 0.62, false);
    const board = new Mesh(boardGeo, boardMat);

    // WORKTOP
    const topGeo = new PlaneGeometry(44, 44);
    topGeo.rotateX(-Math.PI / 2);
    topGeo.translate(0, -h, 0);
    const topMat = surface(shared, COLORS.stoneA, COLORS.stoneB, 0.85, true);
    const top = new Mesh(topGeo, topMat);

    board.receiveShadow = top.receiveShadow = true;
    board.castShadow = true;
    this.meshes = [top, board];
    this.disposables.push(
      boardGeo,
      boardMat,
      topGeo,
      topMat,
      this.flourTex,
      this.shadeTex,
      this.field,
    );
  }

  // a portrait screen sees more depth than width: the board gets deeper and narrower to fill it
  fit(aspect: number) {
    const t = Math.min(1, Math.max(0, (1.2 - aspect) / 0.7));
    const sx = 1 - t * 0.14,
      sz = 1 + t * 0.85;
    this.meshes[1].scale.set(sx, 1, sz);
    BENCH.hw = (BOARD.w / 2) * sx + BOARD.edge;
    BENCH.hd = (BOARD.d / 2) * sz + BOARD.edge;
    BENCH.drop = BOARD.h;
    this.footprint.value.set(BENCH.hw, BENCH.hd, BOARD.r + BOARD.edge);
  }

  // FLOUR MAP
  // soft disk: k > 0 adds flour, k < 0 takes it away but never below floor
  dab(x: number, z: number, r: number, k: number, floor = 0) {
    const f = this.flourF;
    const px = FLOUR_PX / FLOUR_SPAN;
    const cx = (x / FLOUR_SPAN + 0.5) * FLOUR_PX,
      cz = (z / FLOUR_SPAN + 0.5) * FLOUR_PX;
    const rr = r * px;
    const i0 = Math.max(0, Math.floor(cx - rr)),
      i1 = Math.min(FLOUR_PX - 1, Math.ceil(cx + rr));
    const j0 = Math.max(0, Math.floor(cz - rr)),
      j1 = Math.min(FLOUR_PX - 1, Math.ceil(cz + rr));
    const inv = 1 / (rr * rr);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = i + 0.5 - cx,
          dz = j + 0.5 - cz;
        const t = 1 - (dx * dx + dz * dz) * inv;
        if (t <= 0) continue;
        const q = j * FLOUR_PX + i;
        const a = t * t * k;
        if (a > 0) f[q] = Math.min(1, f[q] + a * (1 - f[q]));
        else if (f[q] > floor) f[q] = Math.max(floor, f[q] * (1 + a));
      }
    }
    this.flourDirty = true;
  }

  // finger drag: a run of dabs from a to b
  streak(ax: number, az: number, bx: number, bz: number, r: number, k: number) {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(2, Math.ceil(len / (r * 0.5)));
    for (let s = 0; s <= n; s++) {
      const t = s / n;
      this.dab(ax + (bx - ax) * t, az + (bz - az) * t, r * (1 - t * 0.35), k);
    }
  }

  // flour under a point, 0..1
  flourAt(x: number, z: number) {
    const i = Math.round((x / FLOUR_SPAN + 0.5) * FLOUR_PX - 0.5),
      j = Math.round((z / FLOUR_SPAN + 0.5) * FLOUR_PX - 0.5);
    if (i < 0 || j < 0 || i >= FLOUR_PX || j >= FLOUR_PX) return 0.5;
    return this.flourF[j * FLOUR_PX + i];
  }

  // a new round: the board gets dusted again, old marks fade but do not vanish
  redust() {
    const f = this.flourF;
    for (let q = 0; q < f.length; q++) f[q] += (0.5 - f[q]) * 0.6;
    this.flourDirty = true;
  }

  // SHADE MAP
  // occupancy of whatever sits on the board, blurred into a contact shadow
  clearShade() {
    this.shadeF.fill(0);
  }

  shade(x: number, z: number, r: number, k: number) {
    const f = this.shadeF;
    const cx = (x / SHADE_SPAN + 0.5) * SHADE_PX,
      cz = (z / SHADE_SPAN + 0.5) * SHADE_PX;
    const rr = (r * SHADE_PX) / SHADE_SPAN;
    const i0 = Math.max(0, Math.floor(cx - rr)),
      i1 = Math.min(SHADE_PX - 1, Math.ceil(cx + rr));
    const j0 = Math.max(0, Math.floor(cz - rr)),
      j1 = Math.min(SHADE_PX - 1, Math.ceil(cz + rr));
    const inv = 1 / (rr * rr);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const dx = i + 0.5 - cx,
          dz = j + 0.5 - cz;
        const t = 1 - (dx * dx + dz * dz) * inv;
        if (t <= 0) continue;
        const q = j * SHADE_PX + i;
        const u = Math.min(1, t * 1.6);
        const a = u * u * (3 - 2 * u) * k;
        if (a > f[q]) f[q] = a;
      }
    }
  }

  flush() {
    if (this.flourDirty) {
      const { flourF, flourB } = this;
      for (let q = 0; q < flourF.length; q++) flourB[q] = flourF[q] * 255;
      this.flourTex.needsUpdate = true;
      this.flourDirty = false;
    }
  }

  flushShade() {
    const { shadeF, shadeT, shadeB } = this;
    const n = SHADE_PX;
    for (let p = 0; p < BLUR_PASSES; p++) {
      blur(shadeF, shadeT, n, 1);
      blur(shadeT, shadeF, n, n);
    }
    for (let q = 0; q < shadeF.length; q++) shadeB[q] = Math.min(1, shadeF[q]) * 255;
    this.shadeTex.needsUpdate = true;
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
    this.disposables.length = 0;
  }
}

// 5 tap box along one axis
function blur(src: Float32Array, dst: Float32Array, n: number, step: number) {
  const lim = n * n;
  for (let q = 0; q < lim; q++) {
    const i = step === 1 ? q % n : (q / n) | 0;
    let s = src[q] * 0.3;
    s += (i > 0 ? src[q - step] : src[q]) * 0.22;
    s += (i < n - 1 ? src[q + step] : src[q]) * 0.22;
    s += (i > 1 ? src[q - step * 2] : src[q]) * 0.13;
    s += (i < n - 2 ? src[q + step * 2] : src[q]) * 0.13;
    dst[q] = s;
  }
}

function map(data: Uint8Array, px: number) {
  const t = new DataTexture(data, px, px, RedFormat);
  t.magFilter = t.minFilter = LinearFilter;
  t.generateMipmaps = false;
  return t;
}

// only the key, the one light with a shadow, passes through the window
const KEY_BEGIN = ShaderChunk.lights_fragment_begin.replace(
  "vDirectionalShadowCoord[ i ] ) : 1.0;",
  BOARD_KEY,
);

function surface(shared: Uniforms, a: string, b: string, rough: number, worktop: boolean) {
  const m = new MeshStandardMaterial({ roughness: rough, metalness: 0 });
  if (worktop) m.defines = { WORKTOP: "" };
  const own = { uWoodA: { value: new Color(a) }, uWoodB: { value: new Color(b) } };
  m.onBeforeCompile = (sh: WebGLProgramParametersWithUniforms) => {
    Object.assign(sh.uniforms, shared, own);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", `#include <common>\n${BOARD_VS_PARS}`)
      .replace("#include <worldpos_vertex>", `#include <worldpos_vertex>\n${BOARD_VS}`);
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>\n${BOARD_FS_PARS}`)
      .replace("#include <color_fragment>", `#include <color_fragment>\n${BOARD_FS_COLOR}`)
      .replace("#include <roughnessmap_fragment>", BOARD_FS_ROUGH)
      .replace("#include <normal_fragment_maps>", BOARD_FS_NORMAL)
      .replace("#include <aomap_fragment>", `#include <aomap_fragment>\n${BOARD_FS_AO}`)
      .replace("#include <lights_fragment_begin>", KEY_BEGIN)
      .replace("#include <lights_fragment_end>", `#include <lights_fragment_end>\n${BOARD_FS_ENV}`);
  };
  m.customProgramCacheKey = () => (worktop ? "cv-worktop" : "cv-board");
  return m;
}
