import { describe, expect, it } from 'vitest'
import { notesToText, stripHtml } from './update-notes'

describe('stripHtml', () => {
  it('turns list items into bullet lines', () => {
    expect(stripHtml('<ul>\n<li>Fix the tempo field</li>\n<li>Add a track menu</li>\n</ul>')).toBe('• Fix the tempo field\n• Add a track menu')
  })

  it('joins hard-wrapped lines and keeps paragraphs apart', () => {
    expect(stripHtml('<p>Typing a tempo<br>\nworks again.</p><p>Second paragraph.</p>')).toBe('Typing a tempo works again.\nSecond paragraph.')
  })

  it('decodes entities once', () => {
    expect(stripHtml('<p>M &amp; S &lt;icons&gt; &quot;on&quot; it&#39;s &amp;lt;</p>')).toBe(`M & S <icons> "on" it's &lt;`)
  })
})

describe('notesToText', () => {
  it('handles empty, string, and per-version notes', () => {
    expect(notesToText(null)).toBe('')
    expect(notesToText('<p>One</p>')).toBe('One')
    expect(notesToText([{ version: '2.0.1', note: '<p>Two</p>' }, { version: '2.0.0', note: null }, { version: '1.9.0', note: '<p>One</p>' }])).toBe('Two\n\nOne')
  })
})
