export type Target = { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number };
export type Pass = {
  prog: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
  shaders: WebGLShader[];
};

export const FULLSCREEN_VS = `#version 300 es
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// starts compiling a program; nothing here waits on the driver
export function pass(gl: WebGL2RenderingContext, fs: string, vs = FULLSCREEN_VS): Pass {
  const prog = gl.createProgram();
  if (!prog) throw new Error("no program");
  const shaders: WebGLShader[] = [];
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const sh = gl.createShader(type);
    if (!sh) throw new Error("no shader");
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    gl.attachShader(prog, sh);
    shaders.push(sh);
  }
  gl.linkProgram(prog);
  return { prog, u: {}, shaders };
}

// COMPLETION_STATUS_KHR, polled so linking never blocks
export const busy = (gl: WebGL2RenderingContext, p: Pass) =>
  !gl.getProgramParameter(p.prog, 0x91b1);

// once linked: check it, free the shaders, look up every uniform it declares
export function finish(gl: WebGL2RenderingContext, p: Pass) {
  if (!gl.getProgramParameter(p.prog, gl.LINK_STATUS)) {
    const log = p.shaders.map((sh) => gl.getShaderInfoLog(sh)).join("\n");
    throw new Error((gl.getProgramInfoLog(p.prog) ?? "link") + log);
  }
  for (const sh of p.shaders) gl.deleteShader(sh);
  p.shaders.length = 0;
  const n = gl.getProgramParameter(p.prog, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p.prog, i);
    if (!info) continue;
    const name = info.name.replace(/\[0\]$/, "");
    p.u[name] = gl.getUniformLocation(p.prog, name);
  }
}

export function target(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
  float: boolean,
  mips = false,
): Target {
  const tex = gl.createTexture();
  const fbo = gl.createFramebuffer();
  if (!tex || !fbo) throw new Error("no target");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(
    gl.TEXTURE_2D,
    gl.TEXTURE_MIN_FILTER,
    mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR,
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  const wrap = mips ? gl.REPEAT : gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fbo, w, h };
}

export function free(gl: WebGL2RenderingContext, t: Target | undefined) {
  if (!t) return;
  gl.deleteTexture(t.tex);
  gl.deleteFramebuffer(t.fbo);
}

export function software(gl: WebGL2RenderingContext) {
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const name = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : "";
  return /swiftshader|llvmpipe|software|basic render/i.test(name);
}

// workers without rAF fall back to a timer
export const raf = (fn: (now: number) => void) =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(fn)
    : (setTimeout(() => fn(performance.now()), 16) as unknown as number);
export const unraf = (id: number) =>
  typeof cancelAnimationFrame === "function" ? cancelAnimationFrame(id) : clearTimeout(id);

export type Opts = { reducedMotion: boolean; forceGl: boolean; hold: boolean };
