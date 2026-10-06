import { describe, it, expect } from 'vitest'
import { pickTitleFromLines } from '../src/match.mjs'

describe('pickTitleFromLines', () => {
  it('joins vertically adjacent lines of the same block', () => {
    const lines = [
      { text: 'श्रीमद्', conf: 63, box: [63, 52, 292, 188] },
      { text: 'भागवत पुराण', conf: 76, box: [396, 102, 244, 96] },
    ]
    expect(pickTitleFromLines(lines)).toBe('श्रीमद् भागवत पुराण')
  })

  it('keeps a distant author line out of the title', () => {
    const lines = [
      { text: 'THE GREAT BOOK', conf: 90, box: [100, 200, 400, 80] },
      { text: 'JANE DOE', conf: 90, box: [120, 700, 360, 60] },
    ]
    expect(pickTitleFromLines(lines)).toBe('THE GREAT BOOK')
  })

  it('picks the block with the tallest lines', () => {
    const lines = [
      { text: 'SERIES BADGE', conf: 90, box: [10, 10, 100, 20] },
      { text: 'ACTUAL TITLE', conf: 90, box: [50, 300, 500, 120] },
    ]
    expect(pickTitleFromLines(lines)).toBe('ACTUAL TITLE')
  })

  it('skips low-confidence and too-short lines', () => {
    expect(pickTitleFromLines([{ text: 'HIDDEN', conf: 10, box: [0, 0, 10, 10] }])).toBe('')
    expect(pickTitleFromLines([{ text: 'ab', conf: 90, box: [0, 0, 10, 10] }])).toBe('')
    expect(pickTitleFromLines([])).toBe('')
    expect(pickTitleFromLines(null)).toBe('')
  })

  it('orders joined lines top to bottom', () => {
    const lines = [
      { text: 'SECOND', conf: 90, box: [0, 110, 100, 40] },
      { text: 'FIRST', conf: 90, box: [0, 60, 100, 40] },
    ]
    expect(pickTitleFromLines(lines)).toBe('FIRST SECOND')
  })

  it('prefers the romanised form over Devanagari text', () => {
    const lines = [
      { text: 'श्रीमद्', roman: 'Shrimad', conf: 63, box: [63, 52, 355, 240] },
      { text: 'भागवत पुराण', roman: 'Bhagavat Puran', conf: 76, box: [396, 102, 244, 96] },
    ]
    expect(pickTitleFromLines(lines)).toBe('Shrimad Bhagavat Puran')
  })
})
