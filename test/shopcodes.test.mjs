import { describe, it, expect } from 'vitest'
import { parseCsv, fetchShopCodes, resolveShopCode } from '../src/shopcodes.mjs'

describe('parseCsv', () => {
  it('parses simple rows', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
  it('handles quoted fields with commas, quotes and newlines', () => {
    const rows = parseCsv('name,code\n"Smith, John","say ""hi"""\n')
    expect(rows[1]).toEqual(['Smith, John', 'say "hi"'])
  })
  it('handles CRLF line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
  it('skips blank lines', () => {
    expect(parseCsv('a,b\n\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
  it('final row without trailing newline is kept', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
})

describe('fetchShopCodes', () => {
  it('loads the real CSV with BOM stripped', () => {
    const codes = fetchShopCodes()
    expect(codes).toBeInstanceOf(Map)
    expect(codes.size).toBeGreaterThan(70000)
    const first = codes.keys().next().value
    expect(first).toMatch(/^\d{6}$/)
    expect(codes.get('100002')).toContain('HUSAIN')
  })
  it('memoises the map', () => {
    expect(fetchShopCodes()).toBe(fetchShopCodes())
  })
})

describe('resolveShopCode', () => {
  const codes = fetchShopCodes()
  const knownCode = '100002'
  const knownName = codes.get(knownCode)

  it('resolves to a product with the same title', () => {
    const products = [
      { id: 'p1', title: knownName, author: '', mrp: 500, isbn: '' },
      { id: 'p2', title: 'OTHER', author: '', mrp: 1, isbn: '' },
    ]
    const hit = resolveShopCode(knownCode, products)
    expect(hit).not.toBeNull()
    expect(hit.product.id).toBe('p1')
    expect(hit.exact).toBe(true)
    expect(hit.score).toBe(100)
  })
  it('returns null when no product matches the name', () => {
    const hit = resolveShopCode(knownCode, [{ id: 'p9', title: 'TOTALLY DIFFERENT', author: '', mrp: 1, isbn: '' }])
    expect(hit).toBeNull()
  })
  it('returns null for an unknown code', () => {
    expect(resolveShopCode('000000', [{ id: 'p1', title: knownName }])).toBeNull()
  })
  it('returns null for a non-numeric code', () => {
    expect(resolveShopCode('ABCDEF', [])).toBeNull()
  })
})
