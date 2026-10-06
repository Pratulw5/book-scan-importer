import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { normalize, bestTitleMatch } from './match.mjs'

const CSV_PATH = fileURLToPath(new URL('../data/products_6digit.csv', import.meta.url))

let codes = null

export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

export function fetchShopCodes() {
  if (codes) return codes
  const raw = fs.readFileSync(CSV_PATH, 'utf8').replace(/^\uFEFF/, '')
  const rows = parseCsv(raw)
  const header = (rows.shift() ?? []).map((h) => h.trim().toLowerCase())
  const nameIdx = header.indexOf('product_name')
  const codeIdx = header.indexOf('product_code')
  if (nameIdx < 0 || codeIdx < 0) {
    throw new Error('products_6digit.csv must have product_name and product_code columns')
  }
  codes = new Map()
  for (const row of rows) {
    const code = (row[codeIdx] ?? '').trim()
    const name = (row[nameIdx] ?? '').trim()
    if (code && name && !codes.has(code)) codes.set(code, name)
  }
  return codes
}

export function resolveShopCode(code, products) {
  const name = fetchShopCodes().get(code)
  if (!name || !normalize(name)) return null
  const best = bestTitleMatch(name, products, 95)
  if (!best) return null
  return { name, product: best.product, score: best.score, exact: best.exact }
}
