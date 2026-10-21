import { describe, expect, it } from 'vitest'
import { parseInline, parseMarkdown } from './markdown'

describe('parseInline', () => {
  it('splits bold and code runs', () => {
    expect(parseInline('Set **Cutoff** to `0.55` now')).toEqual([
      { kind: 'text', text: 'Set ' },
      { kind: 'bold', text: 'Cutoff' },
      { kind: 'text', text: ' to ' },
      { kind: 'code', text: '0.55' },
      { kind: 'text', text: ' now' },
    ])
    expect(parseInline('<b>not html</b>')).toEqual([{ kind: 'text', text: '<b>not html</b>' }])
  })
})

describe('parseMarkdown', () => {
  it('reads headings, nested lists, and paragraphs', () => {
    const blocks = parseMarkdown('## Proposals waiting\n\n- **Tempo:** 126 BPM\n  - applies first\n- Drums\n\n1. Accept\n2. Play\n\nThat is all,\nfor now.\n---')
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'list', 'paragraph'])
    const list = blocks[1]
    expect(list.kind === 'list' && list.items.map((i) => `${i.depth}${i.marker}`)).toEqual(['0•', '1•', '0•', '01.', '02.'])
    expect(blocks[2]).toEqual({ kind: 'paragraph', inline: [{ kind: 'text', text: 'That is all, for now.' }] })
  })

  it('keeps numbering across nested bullets', () => {
    const blocks = parseMarkdown('1. Tempo\n2. Drums\n   - Intro\n   - Main\n3. Bass')
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind === 'list' && blocks[0].items.map((i) => i.marker)).toEqual(['1.', '2.', '•', '•', '3.'])
  })

  it('joins a wrapped line onto its list item', () => {
    const blocks = parseMarkdown('- The filter opens\n  across the intro')
    expect(blocks).toEqual([{ kind: 'list', items: [{ depth: 0, marker: '•', inline: [{ kind: 'text', text: 'The filter opens' }, { kind: 'text', text: ' across the intro' }] }] }])
  })
})
