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

export function titleScore(a, b) {
  const na = normalize(a)
  const nb = normalize(b)
  if (!na || !nb) return 0
  const dist = levenshtein(na, nb)
  return Math.max(0, 100 - (100 * dist) / Math.max(na.length, nb.length, 1))
}

export function parsePrice(text) {
  if (text == null) return null
  const s = String(text)
  const toInt = (v) => parseInt(v.replace(/,/g, ''), 10)
  const rupee = s.match(/₹\s*(\d[\d,]*)/)
  if (rupee) return toInt(rupee[1])
  const rs = s.match(/Rs\.?\s*(\d[\d,]*)/)
  if (rs) return toInt(rs[1])
  const inr = s.match(/(INR)\s*(\d+)/i)
  if (inr) return toInt(inr[2])
  return null
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
