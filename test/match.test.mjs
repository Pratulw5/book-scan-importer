import { describe, it, expect } from 'vitest'
import {
  normalize,
  levenshtein,
  titleScore,
  parsePrice,
  isValidIsbn,
  scoreCandidate,
  rankBooks,
  decide,
  decideUnavailable,
} from '../src/match.mjs'

describe('normalize', () => {
  it('lowercases, strips punctuation, collapses spaces', () => {
    expect(normalize('The  Great  Book!')).toBe('the great book')
    expect(normalize('A/B: C&d')).toBe('ab cd')
  })
  it('handles null/undefined/numbers', () => {
    expect(normalize(null)).toBe('')
    expect(normalize(undefined)).toBe('')
    expect(normalize(42)).toBe('42')
  })
})

describe('levenshtein', () => {
  it('known cases', () => {
    expect(levenshtein('kitten', 'sitting')).toBe(3)
    expect(levenshtein('flaw', 'lawn')).toBe(2)
    expect(levenshtein('abc', 'abc')).toBe(0)
    expect(levenshtein('', 'abc')).toBe(3)
    expect(levenshtein('abc', '')).toBe(3)
    expect(levenshtein('book', 'book')).toBe(0)
  })
})

describe('titleScore', () => {
  it('identical titles score 100', () => {
    expect(titleScore('The Great Book', 'the great book!')).toBe(100)
  })
  it('bounded 0..100', () => {
    const s = titleScore('alpha', 'zzzzz')
    expect(s).toBeGreaterThanOrEqual(0)
    expect(s).toBeLessThanOrEqual(100)
  })
  it('empty titles score 0', () => {
    expect(titleScore('', 'book')).toBe(0)
    expect(titleScore('book', '')).toBe(0)
  })
  it('closer titles score higher', () => {
    expect(titleScore('the great book', 'the great book')).toBeGreaterThan(
      titleScore('the great book', 'completely different'),
    )
  })
})

describe('parsePrice', () => {
  it('parses rupee symbol', () => {
    expect(parsePrice('₹499')).toBe(499)
    expect(parsePrice('Price: ₹ 1,299 only')).toBe(1299)
  })
  it('parses Rs.', () => {
    expect(parsePrice('Rs. 1,299')).toBe(1299)
    expect(parsePrice('Rs 250')).toBe(250)
  })
  it('parses INR', () => {
    expect(parsePrice('INR 450')).toBe(450)
    expect(parsePrice('inr  99')).toBe(99)
  })
  it('returns null when no price', () => {
    expect(parsePrice('no price')).toBeNull()
    expect(parsePrice('')).toBeNull()
    expect(parsePrice(null)).toBeNull()
  })
})

describe('isValidIsbn', () => {
  it('accepts valid ISBN-13', () => {
    expect(isValidIsbn('9780306406157')).toBe(true)
    expect(isValidIsbn('978-0-306-40615-7')).toBe(true)
  })
  it('accepts valid ISBN-10', () => {
    expect(isValidIsbn('0306406152')).toBe(true)
  })
  it('accepts X check digit', () => {
    expect(isValidIsbn('080442957X')).toBe(true)
  })
  it('rejects bad check digits', () => {
    expect(isValidIsbn('9780306406158')).toBe(false)
    expect(isValidIsbn('0306406153')).toBe(false)
    expect(isValidIsbn('0804429575')).toBe(false)
  })
  it('rejects junk', () => {
    expect(isValidIsbn('12345')).toBe(false)
    expect(isValidIsbn('')).toBe(false)
    expect(isValidIsbn(null)).toBe(false)
    expect(isValidIsbn('978030640615X')).toBe(false)
    expect(isValidIsbn('abcdefghijk123')).toBe(false)
  })
})

describe('scoreCandidate', () => {
  const book = { title: 'The Great Book', author: 'Jane Doe', isbn: '9780306406157', price: 499 }

  it('mrp exact + title close beats better title with wrong price', () => {
    const good = scoreCandidate(
      { title: 'The Great Book', author: 'Jane Doe', mrp: 499, isbn: '9780306406157' },
      book,
    )
    const wrongPrice = scoreCandidate({ title: 'Great Book', author: '', mrp: 999, isbn: '' }, book)
    expect(good.score).toBeGreaterThan(wrongPrice.score)
    expect(good.mrpMatch).toBe(true)
    expect(good.authorMatch).toBe(true)
    expect(good.isbnMatch).toBe(true)
  })

  it('perfect candidate maxes out', () => {
    const r = scoreCandidate({ title: 'The Great Book', author: 'Jane Doe', mrp: 499, isbn: '9780306406157' }, book)
    expect(r.titleScore).toBe(100)
    expect(r.score).toBe(180)
  })

  it('unknown book price gives neutral mrp score of 8', () => {
    const r = scoreCandidate({ title: 'The Great Book', mrp: 499 }, { title: 'The Great Book', price: null })
    expect(r.mrpMatch).toBe(false)
    expect(r.score).toBe(108)
  })

  it('author match is bidirectional substring', () => {
    expect(
      scoreCandidate({ title: 'T', author: 'Jane Doe Smith', mrp: 1 }, { title: 'T', author: 'Doe', price: null })
        .authorMatch,
    ).toBe(true)
    expect(
      scoreCandidate({ title: 'T', author: '', mrp: 1 }, { title: 'T', author: 'Doe', price: null }).authorMatch,
    ).toBe(false)
  })
})

describe('rankBooks', () => {
  const book = { title: 'The Great Book', author: 'Jane', isbn: '', price: 499 }
  const products = Array.from({ length: 7 }, (_, i) => ({
    id: `p${i}`,
    title: i === 0 ? 'The Great Book' : `Filler Title Number ${i}`,
    author: i === 0 ? 'Jane Doe' : '',
    mrp: i === 0 ? 499 : 999,
    isbn: '',
  }))

  it('sorts by score desc and caps at 5', () => {
    const ranked = rankBooks(products, book)
    expect(ranked).toHaveLength(5)
    expect(ranked[0].id).toBe('p0')
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score)
    }
  })

  it('candidate shape has contract fields', () => {
    const c = rankBooks(products, book)[0]
    expect(c).toMatchObject({ id: 'p0', title: 'The Great Book', author: 'Jane Doe', mrp: 499, isbn: '' })
    expect(typeof c.score).toBe('number')
    expect(typeof c.titleScore).toBe('number')
    expect(typeof c.mrpMatch).toBe('boolean')
    expect(typeof c.authorMatch).toBe('boolean')
  })

  it('empty product list gives empty ranking', () => {
    expect(rankBooks([], book)).toEqual([])
    expect(rankBooks(null, book)).toEqual([])
  })
})

describe('decide', () => {
  const c = (score, extra = {}) => ({
    id: 'x',
    title: 't',
    author: '',
    mrp: 0,
    isbn: '',
    score,
    titleScore: 100,
    mrpMatch: false,
    authorMatch: false,
    ...extra,
  })

  it('auto-match at >= 135 with >= 15 gap', () => {
    expect(decide([c(150), c(130)], {}).status).toBe('matched')
    expect(decide([c(135), c(120)], {}).status).toBe('matched')
    expect(decide([c(140)], {}).status).toBe('matched')
  })

  it('135 with gap < 15 falls to review', () => {
    expect(decide([c(135), c(126)], {}).status).toBe('needs_review')
  })

  it('review band 95..134', () => {
    expect(decide([c(95)], {}).status).toBe('needs_review')
    expect(decide([c(134)], {}).status).toBe('needs_review')
  })

  it('below 95 is unmatched', () => {
    const d = decide([c(94)], {})
    expect(d.status).toBe('unmatched')
    expect(d.score).toBe(94)
  })

  it('no candidates is unmatched', () => {
    const d = decide([], {})
    expect(d.status).toBe('unmatched')
    expect(d.score).toBe(0)
  })

  it('reason strings are human-readable', () => {
    const d = decide([c(148, { titleScore: 96, mrpMatch: true, authorMatch: true })], {})
    expect(d.reason).toContain('score 148')
    expect(d.reason).toContain('mrp exact')
    expect(d.reason).toContain('author match')
  })
})

describe('decideUnavailable', () => {
  it('returns needs_review with the contract reason', () => {
    expect(decideUnavailable()).toEqual({
      status: 'needs_review',
      score: 0,
      reason: 'database unavailable — match manually',
    })
  })
})
