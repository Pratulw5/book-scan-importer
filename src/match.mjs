export function normalize(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function levenshtein(a, b) {
  const m = a.length
  const n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = cur
  }
  return prev[n]
}

export function matchNorm(s) {
  return normalize(s)
    .replace(/sh/g, 's')
    .replace(/w/g, 'v')
}

export function titleScore(a, b) {
  const na = matchNorm(a)
  const nb = matchNorm(b)
  if (!na || !nb) return 0
  const dist = levenshtein(na, nb)
  return Math.max(0, 100 - (100 * dist) / Math.max(na.length, nb.length, 1))
}

function titleVariants(n) {
  const out = [n]
  const dropped = n
    .split(' ')
    .map((w) => (w.length >= 4 && w.endsWith('a') ? w.slice(0, -1) : w))
    .join(' ')
  if (dropped !== n) out.push(dropped)
  return out
}

export function pickTitleFromLines(lines) {
  const usable = (lines ?? [])
    .filter((line) => (line.conf ?? 100) >= 50)
    .map((line) => ({
      text: String(line.text ?? '').trim(),
      roman: line.roman ? String(line.roman).trim() : '',
      x: line.box?.[0] ?? 0,
      y: line.box?.[1] ?? 0,
      w: line.box?.[2] ?? 0,
      h: line.box?.[3] ?? 0,
    }))
    .filter((l) => l.text.length >= 3 && l.text.length <= 140)
  if (usable.length === 0) return ''

  const blocks = []
  for (const line of usable.sort((a, b) => a.y - b.y || a.x - b.x)) {
    const y0 = line.y
    const y1 = line.y + line.h
    let block = null
    for (const b of blocks) {
      const gap = Math.max(0, Math.max(b.y0 - y1, y0 - b.y1))
      if (gap <= 0.3 * Math.max(b.maxH, line.h)) {
        block = b
        break
      }
    }
    if (block) {
      block.lines.push(line)
      block.y0 = Math.min(block.y0, y0)
      block.y1 = Math.max(block.y1, y1)
      block.x0 = Math.min(block.x0, line.x)
      block.x1 = Math.max(block.x1, line.x + line.w)
      block.maxH = Math.max(block.maxH, line.h)
    } else {
      blocks.push({ lines: [line], y0, y1, x0: line.x, x1: line.x + line.w, maxH: line.h })
    }
  }

  let best = null
  let bestScore = -1
  for (const b of blocks) {
    const text = b.lines.map((l) => l.roman || l.text).join(' ')
    const score = b.maxH + Math.min(text.length, 60) / 10
    if (score > bestScore) {
      bestScore = score
      best = b
    }
  }
  return best.lines.map((l) => l.roman || l.text).join(' ').slice(0, 140)
}

export function parsePrice(text) {
  const m = matchPrice(text)
  return m ? m.value : null
}

export function matchPrice(text) {
  if (text == null) return null
  const s = String(text)
  const toInt = (v) => parseInt(v.replace(/,/g, ''), 10)
  const rupee = s.match(/₹\s*(\d[\d,]*)(\.\d+)?/)
  if (rupee) return { value: toInt(rupee[1]), text: rupee[0].trim() }
  const rs = s.match(/Rs\.?\s*(\d[\d,]*)(\.\d+)?/)
  if (rs) return { value: toInt(rs[1]), text: rs[0].trim() }
  const inr = s.match(/(INR)\s*(\d+)(\.\d+)?/i)
  if (inr) return { value: toInt(inr[2]), text: inr[0].trim() }
  return null
}

const MIN_PRICE = 1
const MAX_PRICE = 20000

export function priceFromLines(lines) {
  for (const line of lines ?? []) {
    if ((line.conf ?? 100) < 40) continue
    const m = matchPrice(line.text)
    if (m && m.value >= MIN_PRICE && m.value <= MAX_PRICE) return { price: m.value, priceText: m.text }
  }
  return { price: null, priceText: '' }
}

export function blurbFromLines(lines, skip = '') {
  const skipKey = normalize(skip)
  let best = ''
  for (const line of lines ?? []) {
    if ((line.conf ?? 100) < 40) continue
    const text = String(line.text ?? '').trim()
    if (text.length < 80) continue
    if (normalize(text) === skipKey) continue
    if (text.length > best.length) best = text
  }
  return best.slice(0, 320)
}

export function classifyBarcodes(barcodes) {
  let isbn = ''
  let shopCode = ''
  for (const bar of barcodes ?? []) {
    const text = String(bar.text ?? '').replace(/[^0-9Xx]/g, '')
    if (!shopCode && /^\d{6}$/.test(text)) {
      shopCode = text
      continue
    }
    const format = String(bar.format ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
    if (!isbn && text.length === 13 && (format.includes('EAN13') || format.includes('ISBN'))) {
      if (isValidIsbn(text)) isbn = text
    }
  }
  return { isbn, shopCode }
}

const indexCache = new WeakMap()

function tokens(s) {
  return [...new Set(String(s).split(' ').filter((t) => t.length >= 3))]
}

export function titleIndex(products) {
  let idx = indexCache.get(products)
  if (idx) return idx
  const byNorm = new Map()
  const byToken = new Map()
  products.forEach((p, i) => {
    const n = matchNorm(p?.title)
    if (n && !byNorm.has(n)) byNorm.set(n, i)
    for (const t of tokens(n)) {
      let arr = byToken.get(t)
      if (!arr) byToken.set(t, (arr = []))
      arr.push(i)
    }
  })
  idx = { byNorm, byToken }
  indexCache.set(products, idx)
  return idx
}

export function bestTitleMatch(line, products, minScore = 95) {
  const base = matchNorm(line)
  if (base.length < 4 || !Array.isArray(products) || products.length === 0) return null
  const idx = titleIndex(products)
  let best = null
  for (const n of titleVariants(base)) {
    const exact = idx.byNorm.get(n)
    if (exact !== undefined) return { product: products[exact], score: 100, exact: true }
    const toks = tokens(n)
    if (toks.length === 0) continue
    const counts = new Map()
    for (const t of toks) {
      const arr = idx.byToken.get(t)
      if (!arr) continue
      for (const i of arr) counts.set(i, (counts.get(i) ?? 0) + 1)
    }
    const need = Math.max(1, Math.ceil(toks.length / 2))
    for (const [i, c] of counts) {
      if (c < need) continue
      const s = titleScore(n, products[i].title)
      if (!best || s > best.score) best = { product: products[i], score: Math.round(s * 100) / 100, exact: false }
    }
  }
  return best && best.score >= minScore ? best : null
}

export function bestTitleMatchLines(lines, products, minScore = 95) {
  let best = null
  const candidates = [pickTitleFromLines(lines)]
  for (const line of lines ?? []) {
    if ((line.conf ?? 100) < 40) continue
    candidates.push(String(line.text ?? ''), String(line.roman ?? ''))
  }
  for (const raw of candidates) {
    const candidate = String(raw ?? '').trim()
    if (!candidate) continue
    const m = bestTitleMatch(candidate, products, minScore)
    if (m && (!best || m.score > best.score)) best = { ...m, line: candidate }
  }
  return best
}

export function isValidIsbn(isbn) {
  if (typeof isbn !== 'string') return false
  const s = isbn.replace(/-/g, '').trim()
  if (/^\d{9}[\dXx]$/.test(s)) {
    let sum = 0
    for (let i = 0; i < 9; i++) sum += parseInt(s[i], 10) * (10 - i)
    const check = (11 - (sum % 11)) % 11
    return s[9].toUpperCase() === (check === 10 ? 'X' : String(check))
  }
  if (/^\d{13}$/.test(s)) {
    let sum = 0
    for (let i = 0; i < 13; i++) sum += parseInt(s[i], 10) * (i % 2 === 0 ? 1 : 3)
    return sum % 10 === 0
  }
  return false
}

function scoreFields(product, book, swap) {
  const productTitle = swap ? product.author : product.title
  const productAuthor = swap ? product.title : product.author
  const ts = titleScore(productTitle, book.title)
  const bookPrice = book.price
  const mrpMatch = bookPrice != null && Number(product.mrp) === bookPrice
  const mrpScore = bookPrice == null ? 8 : mrpMatch ? 40 : 0
  const na = normalize(productAuthor)
  const nb = normalize(book.author)
  const authorMatch = na.length > 0 && nb.length > 0 && (na.includes(nb) || nb.includes(na))
  const authorScore = authorMatch ? 15 : 0
  const pa = String(product.isbn ?? '').replace(/[^0-9x]/gi, '')
  const ba = String(book.isbn ?? '').replace(/[^0-9x]/gi, '')
  const isbnMatch = pa.length > 0 && ba.length > 0 && pa.toLowerCase() === ba.toLowerCase()
  const isbnBonus = isbnMatch ? 25 : 0
  return {
    titleScore: ts,
    mrpMatch,
    authorMatch,
    isbnMatch,
    score: ts + mrpScore + authorScore + isbnBonus,
  }
}

export function scoreCandidate(product, book) {
  const direct = scoreFields(product, book, false)
  const swapped = scoreFields(product, book, true)
  const useSwap = swapped.score > direct.score
  return { ...(useSwap ? swapped : direct), swapped: useSwap }
}

export function rankBooks(products, book) {
  return (products ?? [])
    .map((p) => {
      const r = scoreCandidate(p, book)
      return {
        id: p.id,
        title: p.title ?? '',
        author: p.author ?? '',
        mrp: p.mrp,
        isbn: p.isbn ?? '',
        score: Math.round(r.score * 100) / 100,
        titleScore: Math.round(r.titleScore * 100) / 100,
        mrpMatch: r.mrpMatch,
        authorMatch: r.authorMatch,
        swapped: r.swapped,
      }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
}

function describe(best) {
  const parts = [`score ${best.score}: title ${Math.round(best.titleScore)}`]
  if (best.swapped) parts.push('title/author appear swapped')
  if (best.mrpMatch) parts.push('mrp exact')
  if (best.authorMatch) parts.push('author match')
  return parts.join(' + ')
}

export function decide(candidates, book) {
  if (!candidates || candidates.length === 0) {
    return { status: 'unmatched', score: 0, reason: 'no matching products found' }
  }
  const best = candidates[0]
  const second = candidates[1]
  const gap = best.score - (second ? second.score : 0)
  if (best.score >= 135 && gap >= 15) {
    return { status: 'matched', score: best.score, reason: describe(best) }
  }
  if (best.score >= 95) {
    return { status: 'needs_review', score: best.score, reason: describe(best) }
  }
  return { status: 'unmatched', score: best.score, reason: `no confident match (best score ${best.score}, need 95+)` }
}

export function decideUnavailable() {
  return {
    status: 'needs_review',
    score: 0,
    reason: 'database unavailable — match manually',
  }
}
