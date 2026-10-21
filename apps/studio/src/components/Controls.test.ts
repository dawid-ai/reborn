import { describe, expect, it } from 'vitest'
import { readNumber } from './Controls'

describe('readNumber', () => {
  it('accepts in-range numbers as typed', () => {
    expect(readNumber('135', 40, 240)).toBe(135)
    expect(readNumber('92.5', 40, 240)).toBe(92.5)
  })

  it('ignores intermediate text while typing', () => {
    expect(readNumber('', 40, 240)).toBeNull()
    expect(readNumber('13', 40, 240)).toBeNull()
    expect(readNumber('-', 40, 240)).toBeNull()
  })

  it('clamps out-of-range numbers on commit', () => {
    expect(readNumber('13', 40, 240, true)).toBe(40)
    expect(readNumber('999', 40, 240, true)).toBe(240)
    expect(readNumber('', 40, 240, true)).toBeNull()
  })
})
