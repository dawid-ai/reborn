// A small Markdown reader for agent replies: headings, bullet and numbered
// lists, paragraphs, and inline bold and code. It returns plain data that the
// agent panel turns into elements, so model output never becomes HTML.

export type Inline = { kind: 'text' | 'bold' | 'code'; text: string }

export type Block =
  | { kind: 'heading'; inline: Inline[] }
  | { kind: 'paragraph'; inline: Inline[] }
  | { kind: 'list'; items: { depth: number; marker: string; inline: Inline[] }[] }

/** Splits a line into text, **bold**, and `code` runs. */
export function parseInline(line: string): Inline[] {
  const out: Inline[] = []
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  for (const match of line.matchAll(pattern)) {
    const at = match.index ?? 0
    if (at > last) out.push({ kind: 'text', text: line.slice(last, at) })
    const token = match[0]
    out.push(token.startsWith('**') ? { kind: 'bold', text: token.slice(2, -2) } : { kind: 'code', text: token.slice(1, -1) })
    last = at + token.length
  }
  if (last < line.length) out.push({ kind: 'text', text: line.slice(last) })
  return out
}

const BULLET = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/

/** Reads agent Markdown into blocks. Unknown syntax stays as text. */
export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = []
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length) blocks.push({ kind: 'paragraph', inline: parseInline(paragraph.join(' ')) })
    paragraph = []
  }
  for (const raw of source.replace(/\r/g, '').split('\n')) {
    const line = raw.trimEnd()
    if (!line.trim() || /^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush()
      continue
    }
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      blocks.push({ kind: 'heading', inline: parseInline(heading[1]) })
      continue
    }
    const bullet = BULLET.exec(line)
    if (bullet) {
      flush()
      // Keep the numbers the model wrote, so nested bullets don't restart them.
      const marker = /\d/.test(bullet[2]) ? bullet[2].replace(')', '.') : '•'
      const depth = Math.min(3, Math.floor(bullet[1].replace(/\t/g, '  ').length / 2))
      const previous = blocks.at(-1)
      const item = { depth, marker, inline: parseInline(bullet[3]) }
      if (previous?.kind === 'list') previous.items.push(item)
      else blocks.push({ kind: 'list', items: [item] })
      continue
    }
    // A wrapped line continues the list item above it.
    const previous = blocks.at(-1)
    if (!paragraph.length && previous?.kind === 'list' && /^\s+/.test(raw)) {
      previous.items.at(-1)!.inline.push({ kind: 'text', text: ` ${line.trim()}` })
      continue
    }
    paragraph.push(line.trim())
  }
  flush()
  return blocks
}
