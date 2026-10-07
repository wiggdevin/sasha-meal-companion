/**
 * The water view's water, drawn by one small WebGL program (owner, 2026-10-07: "real WebGL water").
 * The basin's own surface simulation (water-surface.ts) and dye flow (water-dye.ts) stay on the CPU and
 * arrive as two tiny textures each frame: the surface heights (one row) and the dyes. The shader draws
 * the body below the surface: clear water that darkens a little with depth, soft shafts of light
 * swaying down through it, a bright wet meniscus, and the two inks as real ink: each its own colour,
 * mixed where they meet, full and opaque at the core, pale and see-through at the wisps, shaded where
 * ink lies under ink. The water itself is clear: the dark glass behind shows through. Above the
 * surface it draws nothing. Colours are premultiplied (`col` already carries its alpha).
 */

const VERTEX = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAGMENT = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUv;
uniform sampler2D uHeights;
uniform sampler2D uDye;
uniform vec2 uSize;
uniform float uBase;
uniform float uTime;
uniform float uDyeOn;
uniform vec3 uTop;
uniform vec3 uDeep;
uniform vec3 uLight;
uniform vec3 uOrange;
uniform vec3 uPlum;
uniform vec3 uOrangeEnd;
uniform vec3 uPlumEnd;
void main() {
  vec2 p = vUv * uSize;
  float h = texture2D(uHeights, vec2(vUv.x, 0.5)).r * 32.0 - 16.0;
  float surface = uBase + h;
  float below = p.y - surface;
  if (below < -1.0) { gl_FragColor = vec4(0.0); return; }
  float depth = clamp(below / max(1.0, uSize.y - surface), 0.0, 1.0);
  // Clear water in dark glass: barely tinted, so what lies behind shows through; a little deeper
  // colour toward the bottom, the way a glass of water darkens with depth.
  vec3 col = mix(uTop, uDeep, depth) * 0.22;
  float alpha = mix(0.10, 0.30, depth);
  // Light through the moving surface: broad soft shafts that sway down from it and fade with depth,
  // and a faint wandering shimmer just under the surface. Soft and wide, never thin lines (thin
  // bright lines read as scratches on the glass, not light in the water).
  float sway = sin(p.x * 0.011 + uTime * 0.3) * 1.8 + uTime * 0.2;
  float shaft = pow(0.5 + 0.5 * sin(p.x * 0.05 + p.y * 0.012 + sway), 5.0) * (1.0 - depth) * (1.0 - depth);
  vec2 q = p / 40.0;
  float c = sin(q.x * 1.3 + sin(q.y * 1.7 + uTime * 0.9) * 1.4 + uTime * 0.6)
          * sin(q.y * 1.1 + sin(q.x * 1.2 - uTime * 0.7) * 1.2 - uTime * 0.4);
  float shimmer = pow(abs(c), 3.0) * (1.0 - smoothstep(0.0, 0.5, depth));
  float lit = shaft * 0.22 + shimmer * 0.1;
  col += uLight * lit * 0.35;
  alpha += lit * 0.2;
  // The inks: real ink in clear water, not light. Each one's colour, mixed by how much of each is
  // there; how opaque it is follows its density (thin wisps are see-through, the core is solid).
  if (uDyeOn > 0.5) {
    float wobble = sin(p.y * 0.07 + uTime * 1.3) * 0.003;
    vec2 dv = vec2(vUv.x + wobble, clamp((p.y - uBase) / max(1.0, uSize.y - uBase), 0.0, 1.0));
    vec4 d = texture2D(uDye, dv);
    float a = d.r * 1.6;
    float b = d.g * 1.6;
    float ink = a + b;
    if (ink > 0.001) {
      float cover = 1.0 - exp(-ink * 2.4);
      // Thin wisps are the pale end of each colour, the dense core its full colour; mixed by share.
      vec3 hue = (mix(uOrangeEnd, uOrange, cover) * a + mix(uPlumEnd, uPlum, cover) * b) / ink;
      // Light comes from above: ink lying under more ink sits in its shade, which gives it volume.
      vec4 up1 = texture2D(uDye, dv - vec2(0.0, 0.04));
      vec4 up2 = texture2D(uDye, dv - vec2(0.0, 0.09));
      float above = (up1.r + up1.g + up2.r + up2.g) * 0.8;
      hue *= (0.55 + 0.6 * exp(-above * 0.7)) * (1.05 - depth * 0.2);
      // Over the water: the ink covers what is behind it in proportion to its density.
      cover *= 0.95;
      col = col * (1.0 - cover) + hue * cover;
      alpha = alpha * (1.0 - cover) + cover;
    }
  }
  // The meniscus: one bright wet line on the surface, and a soft light just under it.
  float edge = 1.0 - smoothstep(0.0, 1.8, abs(below));
  col += uLight * edge * 0.8;
  alpha = max(alpha, edge * 0.8);
  float under = (1.0 - smoothstep(0.0, 10.0, below)) * 0.15;
  col += uLight * under * 0.5;
  alpha = max(alpha, under);
  // The glass walls: a thin cool highlight where the water meets each side.
  float wall = 1.0 - smoothstep(0.0, 3.0, min(p.x, uSize.x - p.x));
  col += uTop * wall * 0.25;
  alpha = max(alpha, wall * 0.3);
  gl_FragColor = vec4(col, alpha);
}`;

export type WaterColours = { top: number[]; deep: number[]; light: number[]; orange: number[]; plum: number[];
  /** Each ink's pale end, for its thin wisps. */
  orangeEnd: number[]; plumEnd: number[] };

export type WaterGl = {
  draw: (frame: { heights: Uint8Array; columns: number; dye: Uint8Array | null; dyeSize: [number, number];
    base: number; size: [number, number]; time: number; colours: WaterColours }) => void;
  dispose: () => void;
};

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

function texture(gl: WebGLRenderingContext, unit: number): WebGLTexture | null {
  const tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/** A design token's colour as 0..1 RGB, read on an element (hex or rgb() as the browser reports it). */
export function tokenColour(el: Element, name: string, fallback: number[]): number[] {
  const value = getComputedStyle(el).getPropertyValue(name).trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(value);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16) / 255);
  const rgb = /rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/i.exec(value);
  return rgb ? [rgb[1], rgb[2], rgb[3]].map((n) => Number(n) / 255) : fallback;
}

/** Sets up the program on this canvas; null when WebGL is missing (the SVG water stands in). */
export function createWaterGl(canvas: HTMLCanvasElement): WaterGl | null {
  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: false }) as WebGLRenderingContext | null;
  if (!gl) return null;
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  if (!vs || !fs || !program) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
  gl.useProgram(program);
  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(program, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  const heightTex = texture(gl, 0);
  const dyeTex = texture(gl, 1);
  const sizes = { heights: 0, dye: [0, 0] };
  const at = (name: string) => gl.getUniformLocation(program, name);
  gl.uniform1i(at("uHeights"), 0);
  gl.uniform1i(at("uDye"), 1);
  const u = { size: at("uSize"), base: at("uBase"), time: at("uTime"), dyeOn: at("uDyeOn"), top: at("uTop"), deep: at("uDeep"),
    light: at("uLight"), orange: at("uOrange"), plum: at("uPlum"), orangeEnd: at("uOrangeEnd"), plumEnd: at("uPlumEnd") };

  return {
    draw({ heights, columns, dye, dyeSize, base, size, time, colours }) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, heightTex);
      if (sizes.heights !== columns) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, columns, 1, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, heights);
        sizes.heights = columns;
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, columns, 1, gl.LUMINANCE, gl.UNSIGNED_BYTE, heights);
      }
      if (dye) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, dyeTex);
        if (sizes.dye[0] !== dyeSize[0] || sizes.dye[1] !== dyeSize[1]) {
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, dyeSize[0], dyeSize[1], 0, gl.RGBA, gl.UNSIGNED_BYTE, dye);
          sizes.dye = [...dyeSize];
        } else {
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, dyeSize[0], dyeSize[1], gl.RGBA, gl.UNSIGNED_BYTE, dye);
        }
      }
      gl.uniform2f(u.size, size[0], size[1]);
      gl.uniform1f(u.base, base);
      // Every light term turns at a multiple of 0.1 rad/s: a 20π-second cycle wraps with no jump.
      gl.uniform1f(u.time, time % (20 * Math.PI));
      gl.uniform1f(u.dyeOn, dye ? 1 : 0);
      gl.uniform3fv(u.top, colours.top);
      gl.uniform3fv(u.deep, colours.deep);
      gl.uniform3fv(u.light, colours.light);
      gl.uniform3fv(u.orange, colours.orange);
      gl.uniform3fv(u.plum, colours.plum);
      gl.uniform3fv(u.orangeEnd, colours.orangeEnd);
      gl.uniform3fv(u.plumEnd, colours.plumEnd);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    dispose() {
      for (const tex of [heightTex, dyeTex]) gl.deleteTexture(tex);
      gl.deleteBuffer(quad);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    },
  };
}
