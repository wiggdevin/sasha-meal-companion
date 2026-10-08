import { BOX, HORIZON, PERSPECTIVE } from "@/components/today/scene/scene-geometry";

/**
 * The pond's water, drawn by one small WebGL program (no three.js). The painted backdrop's lake is
 * the bed; a height field on the lake's ground plane (PondWater.tsx) gives each pixel a normal, which
 * bends the bed (refraction), moves the reflections of the rainbow, the clouds and the key, and lights
 * glints toward the warm horizon. The ground mapping is the one in scene-geometry.ts `groundFromBox`,
 * so a ripple starts exactly where the lure lands. Above the horizon the canvas is clear.
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
uniform sampler2D uBase;
uniform sampler2D uReflect;
uniform sampler2D uNormal;
uniform float uTime;
uniform float uLean;
uniform float uHorizon;
uniform float uD0;
uniform float uZCap;
uniform float uZMin;
void main() {
  float d = (vUv.y - uHorizon) / (1.0 - uHorizon);
  if (d <= 0.0) { gl_FragColor = vec4(0.0); return; }
  float z = 1.0 / (d + uD0);
  float gz = (z - uZMin) / (uZCap - uZMin);
  float gx = 0.5 + (vUv.x - 0.5) * (z / uZCap);
  vec2 ripple = vec2(0.0);
  if (gz >= 0.0 && gz <= 1.0 && gx >= 0.0 && gx <= 1.0) {
    ripple = (texture2D(uNormal, vec2(gx, gz)).xy - 0.5) * 2.0;
  }
  // Toward the horizon one ripple cell is smaller than a pixel and only aliases: fade the ripples out.
  ripple *= smoothstep(0.02, 0.3, d);
  // A gentle breeze that never stops, slow and broad. It only bends the light; it makes no glints,
  // which as fine bright dashes read as a shimmer rather than water (owner, 2026-10-07).
  float zb = min(z, 2.6);
  float wx = gx * uZCap * 5.0;
  float wz = zb * 4.0;
  float calm = clamp(1.6 - z * 0.25, 0.2, 1.0) * smoothstep(0.0, 0.35, d);
  vec2 breeze = vec2(sin(wx * 1.1 + uTime * 0.7) * 0.6 + sin(wx * 1.7 - uTime * 0.5 + wz) * 0.3,
            cos(wz * 1.3 - uTime * 0.6) * 0.6 + sin(wz * 1.9 + wx * 0.4 + uTime * 0.8) * 0.25) * 0.025 * calm;
  vec2 n = ripple + breeze;
  n.x += uLean * 0.22;
  float near = clamp(d * 1.6, 0.18, 1.0);
  vec2 off = vec2(n.x, n.y * 0.6) * 0.013 * near;
  vec3 bed = texture2D(uBase, vUv + off).rgb;
  vec4 refl = texture2D(uReflect, vUv + off * 1.8 + vec2(uLean * 0.004, 0.0));
  float fresnel = mix(0.85, 0.3, clamp(d, 0.0, 1.0));
  vec3 col = bed + refl.rgb * refl.a * fresnel;
  // Soft warm light on the real ripples only (a splash, the lure, a pebble).
  float glint = pow(max(0.0, -ripple.y * 0.9 + ripple.x * 0.25), 2.0) * (1.0 - d * 0.7);
  col += vec3(1.0, 0.82, 0.62) * glint * 0.3;
  gl_FragColor = vec4(col, 1.0);
}`;

export type PondGl = {
  setReflection: (source: HTMLCanvasElement) => void;
  draw: (normals: Uint8Array, cols: number, rows: number, time: number, lean: number) => void;
  dispose: () => void;
};

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : null;
}

function texture(gl: WebGLRenderingContext, unit: number, smooth: boolean): WebGLTexture | null {
  const tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, smooth ? gl.LINEAR : gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, smooth ? gl.LINEAR : gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/** Sets up the program on this canvas with the backdrop as the lake bed; null when WebGL is missing. */
export function createPondGl(canvas: HTMLCanvasElement, bed: HTMLImageElement): PondGl | null {
  const options = { alpha: true, premultipliedAlpha: true, antialias: false };
  const gl = canvas.getContext("webgl", options) as WebGLRenderingContext | null;
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

  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  const bedTex = texture(gl, 0, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bed);
  const reflectTex = texture(gl, 1, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  const normalTex = texture(gl, 2, true);
  let normalSize = { cols: 0, rows: 0 };

  const at = (name: string) => gl.getUniformLocation(program, name);
  gl.uniform1i(at("uBase"), 0);
  gl.uniform1i(at("uReflect"), 1);
  gl.uniform1i(at("uNormal"), 2);
  gl.uniform1f(at("uHorizon"), HORIZON / BOX.h);
  gl.uniform1f(at("uD0"), PERSPECTIVE.d0);
  gl.uniform1f(at("uZCap"), PERSPECTIVE.zCap);
  gl.uniform1f(at("uZMin"), 1 / (1 + PERSPECTIVE.d0));
  const uTime = at("uTime");
  const uLean = at("uLean");

  return {
    setReflection(source) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, reflectTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    },
    draw(normals, cols, rows, time, lean) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, normalTex);
      if (normalSize.cols !== cols || normalSize.rows !== rows) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, normals);
        normalSize = { cols, rows };
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, normals);
      }
      // A bounded clock keeps the breeze smooth on phones whose shaders have little precision. Every
      // breeze term turns at a multiple of 0.1 rad/s, so a 20π-second cycle wraps with no jump.
      gl.uniform1f(uTime, time % (20 * Math.PI));
      gl.uniform1f(uLean, lean);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },
    dispose() {
      for (const tex of [bedTex, reflectTex, normalTex]) gl.deleteTexture(tex);
      gl.deleteBuffer(quad);
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    },
  };
}
