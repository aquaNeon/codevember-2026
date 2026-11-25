export type Pass = {
  prog: WebGLProgram;
  u: Record<string, WebGLUniformLocation | null>;
  shaders: WebGLShader[];
};

// starts compiling a program; nothing here waits on the driver
export function pass(gl: WebGL2RenderingContext, fs: string, vs: string): Pass {
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

export type Opts = { reducedMotion: boolean; forceGl: boolean; hold: boolean; at: number };
