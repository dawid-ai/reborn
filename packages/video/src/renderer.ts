import commonSource from './glsl/common.glsl?raw'
import feedbackSource from './glsl/feedback.glsl?raw'
import postSource from './glsl/post.glsl?raw'
import { waveRows } from './features'
import type { Look } from './looks'
import { drawText } from './text'
import { type ResolvedParam, type ResolvedScene, type Timeline, evaluatePost } from './timeline'

// WebGL2 renderer for storyboards. Per frame: the scene pass draws the
// scene's look (crossfading from the previous look if asked) plus up to
// three additive layers; the feedback pass blends in a zoomed, rotated,
// hue-shifted copy of the previous frame for trails; the post pass adds
// shake, chromatic aberration, bloom, strobe, whiteout, impact flash, the
// text layer, tone mapping, the master fade, and grain.

type Canvas = HTMLCanvasElement | OffscreenCanvas

const HEADER = '#version 300 es\nprecision highp float;\nprecision highp int;\n'
const VERTEX = `${HEADER}in vec2 pos; out vec2 vUv; void main(){ vUv = pos*.5+.5; gl_Position = vec4(pos,0.,1.); }`
const GLSL_TYPES = ['float', 'float', 'vec2', 'vec3', 'vec4']
/** Frames rendered before a jump in time, so trails look settled. */
const WARM_UP = 15

/** Builds one fragment program holding every look the storyboard uses. */
export function buildSceneSource(looks: readonly Look[]): string {
  const out = [HEADER, 'in vec2 vUv;\nout vec4 frag;\n', commonSource]
  looks.forEach((look, i) => {
    out.push(`\n// ===== look ${i}: ${look.id}`)
    for (const p of look.params) out.push(`uniform ${GLSL_TYPES[p.default.length]} L${i}_${p.name};\n#define P_${p.name} L${i}_${p.name}`)
    out.push(`#define look look_${i}`, look.code, '#undef look', ...look.params.map((p) => `#undef P_${p.name}`))
  })
  out.push('uniform int uLook, uLookB, uLay0, uLay1, uLay2;\nuniform float uMix, uLayAmt0, uLayAmt1, uLayAmt2;')
  out.push('vec3 runLook(int id, vec2 uv){')
  looks.forEach((_, i) => out.push(`  if(id==${i}) return look_${i}(uv);`))
  out.push('  return vec3(0.);\n}')
  out.push(`void main(){
  vec2 uv = (vUv*2.-1.)*vec2(uRes.x/uRes.y,1.);
  vec3 c = runLook(uLook, uv);
  if(uMix>0.) c = mix(c, runLook(uLookB, uv), uMix);
  if(uLay0>=0) c += runLook(uLay0, uv)*uLayAmt0;
  if(uLay1>=0) c += runLook(uLay1, uv)*uLayAmt1;
  if(uLay2>=0) c += runLook(uLay2, uv)*uLayAmt2;
  frag = vec4(max(c,0.),1.);
}`)
  return out.join('\n')
}

interface Program {
  program: WebGLProgram
  locations: Map<string, WebGLUniformLocation | null>
}

interface Target {
  texture: WebGLTexture
  framebuffer: WebGLFramebuffer
}

const hash = (n: number) => {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453
  return x - Math.floor(x)
}

/** Deterministic normal-distributed pair for frame n, so shake is the same in preview and export. */
function gaussian(n: number): [number, number] {
  const u = Math.max(1e-9, hash(n * 2 + 1))
  const v = hash(n * 2 + 2)
  const r = Math.sqrt(-2 * Math.log(u))
  return [r * Math.cos(2 * Math.PI * v), r * Math.sin(2 * Math.PI * v)]
}

export class VideoRenderer {
  readonly gl: WebGL2RenderingContext
  private width = 0
  private height = 0
  private scene: Program | null = null
  private sceneKey = ''
  private readonly feedback: Program
  private readonly post: Program
  private readonly quad: WebGLVertexArrayObject
  private sceneTarget: Target | null = null
  private trails: Target[] = []
  private current = 0
  private readonly wave: WebGLTexture
  private readonly waveData = new Float32Array(1024)
  private readonly textTexture: WebGLTexture
  private readonly textCanvas: OffscreenCanvas
  private readonly textContext: OffscreenCanvasRenderingContext2D
  private readonly floatTargets: boolean
  private timeline: Timeline | null = null
  private lastFrame = -Infinity
  private readonly julia = new Map<number, number>()

  constructor(readonly canvas: Canvas, options: { preserveDrawingBuffer?: boolean } = {}) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: options.preserveDrawingBuffer ?? false }) as WebGL2RenderingContext | null
    if (!gl) throw new Error('WebGL2 is not available.')
    this.gl = gl
    this.floatTargets = Boolean(gl.getExtension('EXT_color_buffer_float'))
    this.feedback = this.link(feedbackSource)
    this.post = this.link(postSource)
    const quad = gl.createVertexArray()!
    gl.bindVertexArray(quad)
    const buffer = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    this.quad = quad
    this.wave = this.texture(gl.R16F, 512, 2, gl.RED, gl.FLOAT, gl.LINEAR)
    this.textTexture = this.texture(gl.RGBA8, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR)
    this.textCanvas = new OffscreenCanvas(1, 1)
    this.textContext = this.textCanvas.getContext('2d')!
  }

  /** Sets the output size in pixels. */
  setSize(width: number, height: number): void {
    if (width === this.width && height === this.height) return
    const { gl } = this
    this.width = width
    this.height = height
    this.canvas.width = width
    this.canvas.height = height
    this.textCanvas.width = width
    this.textCanvas.height = height
    for (const target of [this.sceneTarget, ...this.trails]) {
      if (!target) continue
      gl.deleteTexture(target.texture)
      gl.deleteFramebuffer(target.framebuffer)
    }
    this.sceneTarget = this.target(false)
    this.trails = [this.target(true), this.target(true)]
    this.lastFrame = -Infinity
  }

  /** Uses a new timeline. The scene program is rebuilt only when the set of looks changes. */
  setTimeline(timeline: Timeline): void {
    this.timeline = timeline
    const key = timeline.looks.map((look) => `${look.id}:${look.code.length}`).join('|')
    if (key !== this.sceneKey || !this.scene) {
      if (this.scene) this.gl.deleteProgram(this.scene.program)
      this.scene = this.link(buildSceneSource(timeline.looks))
      this.sceneKey = key
    }
    this.lastFrame = -Infinity
  }

  /**
   * Renders the frame at time t. Consecutive frames continue the trails; a
   * jump renders a short warm-up first. `force` redraws the same frame after
   * an edit.
   */
  render(t: number, force = false): void {
    const timeline = this.timeline
    if (!timeline || !this.width) return
    const frame = Math.max(0, Math.floor(t * timeline.fps + 1e-6))
    if (frame === this.lastFrame && !force) return
    if (frame !== this.lastFrame + 1 || force) {
      this.clearTrails()
      this.julia.clear()
      for (let f = Math.max(0, frame - WARM_UP); f < frame; f += 1) this.drawFrame(timeline, f)
    }
    this.drawFrame(timeline, frame)
    this.lastFrame = frame
  }

  /** Frees GPU resources. The context stays usable, so a new renderer can take over the canvas. */
  dispose(): void {
    const { gl } = this
    for (const program of [this.scene, this.feedback, this.post]) if (program) gl.deleteProgram(program.program)
    for (const target of [this.sceneTarget, ...this.trails]) {
      if (!target) continue
      gl.deleteTexture(target.texture)
      gl.deleteFramebuffer(target.framebuffer)
    }
    gl.deleteTexture(this.wave)
    gl.deleteTexture(this.textTexture)
    gl.deleteVertexArray(this.quad)
    this.scene = null
    this.sceneTarget = null
    this.trails = []
    this.timeline = null
  }

  // ---------------------------------------------------------------------------

  private drawFrame(timeline: Timeline, frame: number): void {
    const { gl } = this
    const t = frame / timeline.fps
    const scene = timeline.sceneAt(t)
    const scope = timeline.scope(t, scene)
    const program = this.scene!
    const looks = timeline.looks
    const index = (look: Look | null) => (look ? looks.indexOf(look) : -1)

    gl.bindVertexArray(this.quad)
    gl.useProgram(program.program)
    waveRows(timeline.features, t, this.waveData)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.wave)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 512, 2, gl.RED, gl.FLOAT, this.waveData)
    this.int(program, 'uWave', 0)
    const set = (name: string, value: number) => this.float(program, name, value)
    set('uT', t)
    set('uL', scope.L)
    set('uLen', scope.len)
    set('uX', scope.x)
    set('uBeat', scope.beat)
    set('uBar', scope.bar)
    set('uSub', scope.sub)
    set('uBass', scope.bass)
    set('uMid', scope.mid)
    set('uAir', scope.air)
    set('uRms', scope.rms)
    set('uHat', scope.hatEnv)
    set('uKick', scope.kick)
    set('uSnare', scope.snare)
    set('uHatP', scope.hat)
    set('uKT', scope.kt)
    set('uCutT', scope.cutT)
    set('uRise', scope.rise)
    set('uPush', timeline.pushAt(t))
    this.int(program, 'uCut', scope.cut)
    gl.uniform2f(this.location(program, 'uRes'), this.width, this.height)

    let mix = 0
    let lookB = -1
    if (scene?.look) {
      this.setParams(program, index(scene.look), scene, scene.params, scope, true)
      const previous = scene.index > 0 ? timeline.scenes[scene.index - 1] : null
      if (scene.scene.xfade > 0 && scope.L < scene.scene.xfade && previous?.look && previous.look !== scene.look) {
        const prevScope = { ...timeline.scope(t, previous), x: 1 }
        this.setParams(program, index(previous.look), previous, previous.params, prevScope, true)
        lookB = index(previous.look)
        mix = 1 - scope.L / scene.scene.xfade
      }
    }
    this.int(program, 'uLook', index(scene?.look ?? null))
    this.int(program, 'uLookB', lookB)
    set('uMix', mix)
    for (let i = 0; i < 3; i += 1) {
      const layer = scene?.layers[i]
      if (layer) {
        this.setParams(program, index(layer.look), null, layer.params, scope, false)
        this.int(program, `uLay${i}`, index(layer.look))
        set(`uLayAmt${i}`, layer.amount(scope))
      } else this.int(program, `uLay${i}`, -1)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneTarget!.framebuffer)
    gl.viewport(0, 0, this.width, this.height)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)

    // Post values: scene settings plus the impact flash, aberration, and shake.
    const post = evaluatePost(scene, scope)
    const since = scope.sinceImpact
    const flash = timeline.impact.flash * Math.exp(-since * 14)
    const ca = post.ca + timeline.impact.ca * Math.exp(-since * 4)
    const shake = post.shake + timeline.impact.shake * Math.exp(-since * 3)
    // A hard cut starts clean, without trails from the old scene.
    const trails = scene && scope.L < 1.5 / timeline.fps && scene.scene.xfade === 0 ? 0 : post.fb
    const [sx, sy] = gaussian(frame)
    const fade = timeline.fade(scope)

    const next = 1 - this.current
    gl.useProgram(this.feedback.program)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.trails[next].framebuffer)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTarget!.texture)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.trails[this.current].texture)
    this.int(this.feedback, 'uScene', 0)
    this.int(this.feedback, 'uPrev', 1)
    this.float(this.feedback, 'uFb', trails)
    this.float(this.feedback, 'uFbZoom', post.fbZoom || 1)
    this.float(this.feedback, 'uFbRot', post.fbRot)
    this.float(this.feedback, 'uFbHue', post.fbHue)
    this.float(this.feedback, 'uAsp', this.width / this.height)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.bindTexture(gl.TEXTURE_2D, this.trails[next].texture)
    gl.generateMipmap(gl.TEXTURE_2D)
    this.current = next

    const text = drawText(this.textContext, timeline.texts, t, scope, timeline.cues.beatSeconds)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, this.textTexture)
    if (text.drawn) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, this.textCanvas)

    const p = this.post
    gl.useProgram(p.program)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, this.width, this.height)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.trails[this.current].texture)
    this.int(p, 'uImg', 0)
    this.int(p, 'uText', 2)
    this.float(p, 'uCA', ca)
    this.float(p, 'uBloom', post.bloom)
    this.float(p, 'uGrain', post.grain)
    this.float(p, 'uFlash', flash)
    this.float(p, 'uFade', fade)
    this.float(p, 'uStrobe', post.strobe)
    this.float(p, 'uWhite', post.white)
    this.float(p, 'uVig', post.vig)
    this.float(p, 'uT', t)
    this.float(p, 'uTextCA', text.ca)
    this.float(p, 'uTextGlitch', text.glitch)
    this.float(p, 'uTextOn', text.drawn ? 1 : 0)
    this.float(p, 'uTextBlend', text.difference)
    gl.uniform2f(this.location(p, 'uShake'), sx * shake, sy * shake)
    gl.uniform2f(this.location(p, 'uRes'), this.width, this.height)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  private setParams(program: Program, lookIndex: number, scene: ResolvedScene | null, params: readonly ResolvedParam[], scope: Readonly<Record<string, number>>, hook: boolean): void {
    if (lookIndex < 0) return
    const { gl } = this
    const values = new Map(params.map((param) => [param.name, param.fn(scope)]))
    if (hook && scene?.look?.id === 'julia-drift' && scene.scene.params.off === undefined) values.set('off', [this.juliaOffset(scene, values)])
    for (const param of params) {
      const location = this.location(program, `L${lookIndex}_${param.name}`)
      if (!location) continue
      const v = values.get(param.name)!
      const at = (i: number) => v[i] ?? v[v.length - 1] ?? 0
      if (param.size === 1) gl.uniform1f(location, at(0))
      else if (param.size === 2) gl.uniform2f(location, at(0), at(1))
      else if (param.size === 3) gl.uniform3f(location, at(0), at(1), at(2))
      else gl.uniform4f(location, at(0), at(1), at(2), at(3))
    }
  }

  /**
   * Keeps a zooming Julia set evenly bright: the iteration offset is the 15th
   * percentile escape count of a coarse grid of the view, smoothed over frames.
   */
  private juliaOffset(scene: ResolvedScene, values: Map<string, number[]>): number {
    const angle = values.get('cAngle')?.[0] ?? 2.25
    const cr = 0.7885 * Math.cos(angle)
    const ci = 0.7885 * Math.sin(angle)
    const [cx, cy] = values.get('center') ?? [0, 0]
    const zoom = values.get('zoom')?.[0] ?? 1.6
    const rot = values.get('rot')?.[0] ?? 0
    const iters = Math.min(500, Math.max(1, Math.round(values.get('iters')?.[0] ?? 140)))
    const aspect = this.width / this.height
    const escaped: number[] = []
    const cos = Math.cos(rot)
    const sin = Math.sin(rot)
    for (let gy = 0; gy < 36; gy += 1) {
      for (let gx = 0; gx < 64; gx += 1) {
        const px = (-1 + (2 * gx) / 63) * aspect * zoom
        const py = (-1 + (2 * gy) / 35) * zoom
        let zr = cx + cos * px - sin * py
        let zi = cy + sin * px + cos * py
        let n = 0
        for (; n < iters; n += 1) {
          const r = zr * zr - zi * zi + cr
          zi = 2 * zr * zi + ci
          zr = r
          if (zr * zr + zi * zi >= 1024) break
        }
        if (n < iters) escaped.push(n)
      }
    }
    escaped.sort((a, z) => a - z)
    const target = escaped.length > 20 ? Math.max(escaped[Math.floor(escaped.length * 0.15)] - 4, 0) : 0
    const previous = this.julia.get(scene.index)
    const value = previous === undefined ? target : previous + (target - previous) * 0.25
    this.julia.set(scene.index, value)
    return value
  }

  private clearTrails(): void {
    const { gl } = this
    for (const target of this.trails) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer)
      gl.clearColor(0, 0, 0, 1)
      gl.clear(gl.COLOR_BUFFER_BIT)
    }
  }

  private texture(internal: number, width: number, height: number, format: number, type: number, filter: number): WebGLTexture {
    const { gl } = this
    const texture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, width, height, 0, format, type, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return texture
  }

  private target(mipmaps: boolean): Target {
    const { gl } = this
    const texture = this.floatTargets
      ? this.texture(gl.RGBA16F, this.width, this.height, gl.RGBA, gl.HALF_FLOAT, mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
      : this.texture(gl.RGBA8, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR)
    if (mipmaps) gl.generateMipmap(gl.TEXTURE_2D)
    const framebuffer = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0)
    gl.clearColor(0, 0, 0, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
    return { texture, framebuffer }
  }

  private link(fragment: string): Program {
    const { gl } = this
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type)!
      gl.shaderSource(shader, source.startsWith('#version') ? source : HEADER + source)
      gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader) ?? ''
        gl.deleteShader(shader)
        throw new Error(`Shader failed to compile: ${log}`)
      }
      return shader
    }
    const program = gl.createProgram()!
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX))
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment))
    gl.bindAttribLocation(program, 0, 'pos')
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`Shader failed to link: ${gl.getProgramInfoLog(program) ?? ''}`)
    return { program, locations: new Map() }
  }

  private location(program: Program, name: string): WebGLUniformLocation | null {
    let location = program.locations.get(name)
    if (location === undefined) {
      location = this.gl.getUniformLocation(program.program, name)
      program.locations.set(name, location)
    }
    return location
  }

  private float(program: Program, name: string, value: number): void {
    const location = this.location(program, name)
    if (location) this.gl.uniform1f(location, Number.isFinite(value) ? value : 0)
  }

  private int(program: Program, name: string, value: number): void {
    const location = this.location(program, name)
    if (location) this.gl.uniform1i(location, value)
  }
}
