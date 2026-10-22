import { lastIndex } from './cues'
import type { ResolvedText } from './timeline'

type Context2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

// Kinetic type for instrumentals. Text is drawn with Canvas 2D into a
// transparent frame; the post pass composites it with its own RGB split and
// glitch, so a slam or a word on a snare hits like the picture does.

export interface TextFrame {
  /** True when anything was drawn. */
  drawn: boolean
  /** RGB split in UV units. */
  ca: number
  glitch: number
  /** 1 when any active item uses difference blending. */
  difference: number
}

const hash = (n: number) => {
  const x = Math.sin(n * 127.1) * 43758.5453
  return x - Math.floor(x)
}

function wordsOf(text: string): string[] {
  return (text.includes('|') ? text.split('|') : text.split(/\s+/)).map((w) => w.trim()).filter(Boolean)
}

/** Draws the text items active at t. `scope` provides the kick, snare, and hat pulses. */
export function drawText(ctx: Context2D, texts: readonly ResolvedText[], t: number, scope: Readonly<Record<string, number>>, beatSeconds: number): TextFrame {
  const { width, height } = ctx.canvas
  ctx.clearRect(0, 0, width, height)
  const frame: TextFrame = { drawn: false, ca: 0, glitch: 0, difference: 0 }
  const scale = height / 1080
  for (const { item, t0, t1, events } of texts) {
    if (t < t0 || t >= t1) continue
    const L = t - t0
    let text = item.text
    let alpha = 1
    let grow = 1
    let dx = 0
    switch (item.style) {
      case 'words': {
        const words = wordsOf(item.text)
        const k = lastIndex(events, t)
        if (k < 0 || !words.length) continue
        text = words[k % words.length]
        grow = 1 + 0.25 * Math.exp(-(t - events[k]) * 18)
        break
      }
      case 'type': {
        const shown = Math.floor(L / (beatSeconds / 4)) + 1
        text = item.text.slice(0, shown) + (shown < item.text.length && Math.floor(L / (beatSeconds / 2)) % 2 === 0 ? '_' : '')
        break
      }
      case 'slam':
        grow = 1 + 0.6 * Math.exp(-L * 22)
        break
      case 'flicker':
        alpha = scope.hat > 0.35 || hash(Math.floor(t * 30)) > 0.35 ? 1 : 0.15
        break
      case 'scroll':
        dx = -0.15 * L
        break
    }
    if (!text.trim()) continue
    if (item.fadeIn > 0) alpha *= Math.min(1, L / item.fadeIn)
    if (item.fadeOut > 0) alpha *= Math.min(1, (t1 - t) / item.fadeOut)
    if (item.pulse) grow *= 1 + item.pulse * scope.kick
    const size = Math.max(4, item.size * scale)
    ctx.save()
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha))
    ctx.font = `${item.weight} ${size}px "${item.font}"`
    ctx.letterSpacing = `${item.tracking * size}px`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = `rgb(${item.color.map((c) => Math.round(Math.min(1, c) * 255)).join(',')})`
    ctx.translate((item.pos[0] + dx) * width, item.pos[1] * height)
    ctx.scale(grow, grow)
    const lines = text.split('\n')
    const lineHeight = size * 0.92
    lines.forEach((line, i) => ctx.fillText(line, 0, (i - (lines.length - 1) / 2) * lineHeight))
    ctx.restore()
    frame.drawn = true
    frame.ca = Math.max(frame.ca, item.split * (0.002 + 0.01 * scope.kick + (item.style === 'slam' ? 0.02 * Math.exp(-L * 10) : 0)))
    frame.glitch = Math.max(frame.glitch, item.glitch * Math.max(scope.snare, item.style === 'slam' ? Math.exp(-L * 8) : 0))
    if (item.blend === 'difference') frame.difference = 1
  }
  return frame
}
