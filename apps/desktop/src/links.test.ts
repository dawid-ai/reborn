import { describe, expect, it } from 'vitest'
import { isExternalLink } from './links'

describe('isExternalLink', () => {
  it('allows https links to GitHub', () => {
    expect(isExternalLink('https://github.com/newsbubbles/ismail')).toBe(true)
  })

  it('rejects other hosts, schemes, and credentials', () => {
    expect(isExternalLink('http://github.com/newsbubbles/ismail')).toBe(false)
    expect(isExternalLink('https://github.com.example.com/')).toBe(false)
    expect(isExternalLink('https://example.com/')).toBe(false)
    expect(isExternalLink('file:///C:/Windows/System32/calc.exe')).toBe(false)
    expect(isExternalLink('https://user:pass@github.com/')).toBe(false)
    expect(isExternalLink('not a url')).toBe(false)
  })
})
