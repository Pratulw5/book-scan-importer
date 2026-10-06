import { describe, it, expect } from 'vitest'
import {
  normalize,
  levenshtein,
  titleScore,
  parsePrice,
  matchPrice,
  priceFromLines,
  blurbFromLines,
  classifyBarcodes,
  bestTitleMatch,
  bestTitleMatchLines,
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

  it('matches when the AI swapped title and author', () => {
    const r = scoreCandidate(
      { title: 'Jane Doe', author: 'The Great Book', mrp: 499, isbn: '9780306406157' },
      book,
    )
    expect(r.swapped).toBe(true)
    expect(r.titleScore).toBe(100)
    expect(r.authorMatch).toBe(true)
    expect(r.score).toBe(180)
  })

  it('does not flag a swap when direct fields already match', () => {
    const r = scoreCandidate(
      { title: 'The Great Book', author: 'Jane Doe', mrp: 499, isbn: '9780306406157' },
      book,
    )
    expect(r.swapped).toBe(false)
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
    expect(typeof c.swapped).toBe('boolean')
  })

  it('ranks a swapped-fields product first when AI swapped them', () => {
    const swappedBook = { title: 'Jane Doe', author: 'The Great Book', isbn: '', price: 499 }
    const ranked = rankBooks(products, swappedBook)
    expect(ranked[0].id).toBe('p0')
    expect(ranked[0].swapped).toBe(true)
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

describe('matchPrice', () => {
  it('returns value and the matched text', () => {
    expect(matchPrice('MRP ₹ 200.00')).toEqual({ value: 200, text: '₹ 200.00' })
    expect(matchPrice('no price')).toBeNull()
  })
})

describe('priceFromLines', () => {
  it('takes the first confident in-range price', () => {
    const lines = [
      { text: 'some headline', conf: 90 },
      { text: '₹ 499.00', conf: 88 },
      { text: '₹ 99999', conf: 88 },
    ]
    expect(priceFromLines(lines)).toEqual({ price: 499, priceText: '₹ 499.00' })
  })
  it('skips low-confidence lines', () => {
    expect(priceFromLines([{ text: '₹ 499', conf: 10 }])).toEqual({ price: null, priceText: '' })
  })
  it('rejects out-of-range prices', () => {
    expect(priceFromLines([{ text: '₹ 99999', conf: 90 }])).toEqual({ price: null, priceText: '' })
    expect(priceFromLines([{ text: '₹ 0', conf: 90 }])).toEqual({ price: null, priceText: '' })
  })
  it('empty input gives no price', () => {
    expect(priceFromLines([])).toEqual({ price: null, priceText: '' })
    expect(priceFromLines(null)).toEqual({ price: null, priceText: '' })
  })
})

describe('blurbFromLines', () => {
  it('picks the longest confident long line', () => {
    const lines = [
      { text: 'short', conf: 90 },
      { text: 'x'.repeat(90), conf: 90 },
      { text: 'y'.repeat(200), conf: 90 },
    ]
    expect(blurbFromLines(lines)).toBe('y'.repeat(200))
  })
  it('skips the title line', () => {
    const title = 'A Title That Is Definitely Longer Than Eighty Characters For Testing Purposes'
    expect(blurbFromLines([{ text: title, conf: 90 }], title)).toBe('')
  })
  it('returns empty when nothing long enough', () => {
    expect(blurbFromLines([{ text: 'blurb', conf: 90 }])).toBe('')
  })
})

describe('classifyBarcodes', () => {
  const validIsbn13 = '9780306406157'
  it('valid EAN-13 → isbn, 6 digits → shopCode', () => {
    const r = classifyBarcodes([
      { format: 'EAN_13', text: validIsbn13, valid: true },
      { format: 'Code39', text: '175582', valid: true },
    ])
    expect(r).toEqual({ isbn: validIsbn13, shopCode: '175582' })
  })
  it('accepts the hyphenated format string zxing actually returns', () => {
    const r = classifyBarcodes([
      { format: 'EAN-13', text: validIsbn13, valid: true },
      { format: 'Code 39', text: '175582', valid: true },
    ])
    expect(r).toEqual({ isbn: validIsbn13, shopCode: '175582' })
  })
  it('invalid EAN-13 checksum is not an isbn', () => {
    const r = classifyBarcodes([{ format: 'EAN_13', text: '9780306406158', valid: false }])
    expect(r.isbn).toBe('')
  })
  it('isbn format name also accepted', () => {
    expect(classifyBarcodes([{ format: 'ISBN', text: validIsbn13 }]).isbn).toBe(validIsbn13)
  })
  it('non 6/13 digit codes are ignored', () => {
    expect(classifyBarcodes([{ format: 'QRCode', text: 'hello world' }])).toEqual({ isbn: '', shopCode: '' })
  })
  it('empty input is safe', () => {
    expect(classifyBarcodes(null)).toEqual({ isbn: '', shopCode: '' })
  })
})

describe('bestTitleMatch', () => {
  const products = [
    { id: 'p1', title: 'MUSAFIR CAFE', author: 'DIVYA PRAKASH DUBEY', mrp: 299, isbn: '' },
    { id: 'p2', title: 'THE ART OF FIELDING', author: '', mrp: 500, isbn: '' },
    { id: 'p3', title: 'FILLER TITLE', author: '', mrp: 100, isbn: '' },
  ]

  it('exact normalized match scores 100', () => {
    const m = bestTitleMatch('Musafir Cafe!', products)
    expect(m).toMatchObject({ exact: true, score: 100 })
    expect(m.product.id).toBe('p1')
  })
  it('close OCR line matches fuzzily', () => {
    const m = bestTitleMatch('THE ART OF FIELDNG', products, 90)
    expect(m).not.toBeNull()
    expect(m.product.id).toBe('p2')
  })
  it('unrelated line returns null', () => {
    expect(bestTitleMatch('completely unrelated gibberish text here', products, 95)).toBeNull()
  })
  it('below minScore returns null', () => {
    expect(bestTitleMatch('MUSAFR CAF', products, 99)).toBeNull()
  })
  it('empty or too-short input returns null', () => {
    expect(bestTitleMatch('', products)).toBeNull()
    expect(bestTitleMatch('ab', products)).toBeNull()
    expect(bestTitleMatch('anything', [])).toBeNull()
    expect(bestTitleMatch('anything', null)).toBeNull()
  })
})

describe('bestTitleMatchLines', () => {
  const products = [{ id: 'p1', title: 'MUSAFIR CAFE', author: '', mrp: 299, isbn: '' }]
  it('finds the matching line and reports it', () => {
    const lines = [
      { text: 'some noise', conf: 95 },
      { text: 'MUSAFIR CAFE', conf: 87 },
    ]
    const m = bestTitleMatchLines(lines, products)
    expect(m.product.id).toBe('p1')
    expect(m.line).toBe('MUSAFIR CAFE')
  })
  it('ignores low-confidence lines', () => {
    expect(bestTitleMatchLines([{ text: 'MUSAFIR CAFE', conf: 10 }], products)).toBeNull()
  })
  it('no match → null', () => {
    expect(bestTitleMatchLines([{ text: 'zzz qqq www', conf: 90 }], products)).toBeNull()
  })
  it('matches via the romanised field for Devanagari lines', () => {
    const hit = bestTitleMatchLines(
      [{ text: 'श्रीमद् भागवत पुराण', roman: 'Srimad Bhagavata Purana', conf: 76 }],
      [{ id: 'p7', title: 'SRIMAD BHAGAVATA PURANA', author: '', mrp: 150, isbn: '' }],
    )
    expect(hit).not.toBeNull()
    expect(hit.product.id).toBe('p7')
    expect(hit.line).toBe('Srimad Bhagavata Purana')
  })
  it('matches transliteration spelling variants at the default threshold', () => {
    const lines = [{ text: 'श्रीमद् भागवत पुराण', roman: 'Srimad Bhagavata Purana', conf: 76 }]
    const products = [{ id: 'p8', title: 'SHRIMAD BHAGWAT PURAN', author: '', mrp: 150, isbn: '' }]
    expect(bestTitleMatchLines(lines, products, 95)?.product.id).toBe('p8')
  })
  it('the relaxed tier (85) catches edition-suffix titles the strict tier rejects', () => {
    const lines = [{ text: 'पंख', roman: 'Wings of Fire 2', conf: 80 }]
    const products = [{ id: 'p9', title: 'WINGS OF FIRE', author: '', mrp: 450, isbn: '' }]
    expect(bestTitleMatchLines(lines, products, 95)).toBeNull()
    expect(bestTitleMatchLines(lines, products, 85)?.product.id).toBe('p9')
  })
})
