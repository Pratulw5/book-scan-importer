import fs from 'node:fs'
import path from 'node:path'
import { sha256, cropWhiteBg, toOriginalJpeg, safeName } from './image.mjs'
import { readBarcodes } from './barcode.mjs'
import { runOcr } from './ocr.mjs'
import { resolveShopCode } from './shopcodes.mjs'
import {
  normalize,
  isValidIsbn,
  scoreCandidate,
  rankBooks,
  decide,
  decideUnavailable,
  classifyBarcodes,
  bestTitleMatchLines,
  priceFromLines,
  blurbFromLines,
  pickTitleFromLines,
  matchNorm,
} from './match.mjs'
import { fetchProducts } from './db.mjs'
import { startProgress, endProgress } from './progress.mjs'

const IMAGE_EXT = /\.(jpe?g|png|webp|heic)$/i

export function discoverImages(folder) {
  const files = []

  function walk(dir, prefix = '') {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const rel = path.join(prefix, entry.name)
      const abs = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(abs, rel)
      else if (entry.isFile() && IMAGE_EXT.test(entry.name)) files.push(rel)
    }
  }

  walk(folder)
  return files.sort()
}

function findIsbn(lines) {
  for (const line of lines ?? []) {
    const digits = String(line.text ?? '').replace(/[^0-9Xx]/g, '')
    for (let i = 0; i + 13 <= digits.length; i++) {
      const cand = digits.slice(i, i + 13)
      if (isValidIsbn(cand)) return cand
    }
    if (digits.length === 10 && isValidIsbn(digits)) return digits
  }
  return ''
}

export function rebuildBooks(state, files) {
  const indexByFile = new Map(files.map((f, i) => [f, i]))
  const entryByFile = new Map()
  for (const entry of Object.values(state.images)) {
    if (entry.file) entryByFile.set(entry.file, entry)
  }

  const groups = new Map()
  for (const file of files) {
    const entry = entryByFile.get(file)
    if (!entry || (entry.status !== 'ocr_done' && entry.status !== 'committed')) continue
    const key = entry.productId
      ? `p:${entry.productId}`
      : `t:${entry.ocr?.title ? normalize(entry.ocr.title) : safeName(file)}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push({ entry, index: indexByFile.get(file) ?? 0 })
  }

  const seen = new Set()
  for (const [key, list] of groups) {
    const front = list.find((x) => x.entry.ocr?.position === 'front') ?? list[0]
    const back = list.find((x) => x.entry.ocr?.position === 'back' && x.entry.sha !== front.entry.sha) ?? null
    const ocrF = front.entry.ocr
    const ocrB = back?.entry.ocr
    const title = ocrF?.title || ocrB?.title || ''
    const shopCode = list.map((x) => x.entry.barcode?.shopCode).find(Boolean) ?? ''
    const productId = front.entry.productId ?? back?.entry.productId ?? null
    const barcodePresent = list.some((x) => (x.entry.barcode?.raw?.length ?? 0) > 0)
    const old = state.getBook(key)
    const preserved = old
      ? {
          chosenProductId: old.chosenProductId ?? null,
          createdProductId: old.createdProductId ?? null,
          dismissed: old.dismissed ?? false,
          commitError: old.commitError ?? null,
          urls: old.urls ?? null,
        }
      : {}
    state.setBook(key, {
      sortIndex: front.index,
      title,
      author: ocrF?.author || ocrB?.author || '',
      isbn: isValidIsbn(ocrF?.isbn) ? ocrF.isbn : isValidIsbn(ocrB?.isbn) ? ocrB.isbn : '',
      price: ocrF?.price ?? ocrB?.price ?? null,
      priceText: ocrF?.priceText || ocrB?.priceText || '',
      blurb: ocrF?.blurb || ocrB?.blurb || '',
      front: front.entry.sha,
      back: back ? back.entry.sha : null,
      productId,
      shopCode,
      matchMethod: front.entry.matchMethod ?? back?.entry.matchMethod ?? null,
      barcodePresent,
      ...preserved,
      ...(old && (old.status === 'committed' || old.status === 'created') ? { status: old.status } : {}),
    })
    seen.add(key)
  }

  for (const key of Object.keys(state.books)) {
    if (!seen.has(key)) delete state.books[key]
  }
}

export async function matchBooks(state, { dryRun, progress = null } = {}) {
  let products = null
  if (!dryRun) {
    if (progress) progress.start('match', { total: 0, message: 'loading catalogue' })
    try {
      products = await fetchProducts()
    } catch (e) {
      products = null
      console.error(`catalogue unavailable, matching disabled: ${e.message}`)
    }
  }
  const keys = Object.keys(state.books).filter(
    (key) => state.books[key].status !== 'committed' && state.books[key].status !== 'created',
  )
  if (progress) progress.start('match', { total: keys.length })
  for (const key of keys) {
    const book = state.books[key]
    if (progress) progress.setMessage(book.title || key)
    if (dryRun || products === null) {
      const d = decideUnavailable()
      state.setBook(key, { status: d.status, score: d.score, matchReason: d.reason, candidates: [] })
    } else if (book.productId) {
      const product = products.find((p) => p.id === book.productId)
      if (!product) {
        state.setBook(key, {
          status: 'needs_review',
          score: 0,
          matchReason: 'resolved product id missing from catalogue snapshot',
          candidates: [],
        })
      } else {
        const r = scoreCandidate(product, book)
        const candidates = [
          {
            id: product.id,
            title: product.title ?? '',
            author: product.author ?? '',
            mrp: product.mrp,
            isbn: product.isbn ?? '',
            score: Math.round(r.score * 100) / 100,
            titleScore: Math.round(r.titleScore * 100) / 100,
            mrpMatch: r.mrpMatch,
            authorMatch: r.authorMatch,
            swapped: r.swapped,
          },
        ]
        let d
        const priceConflict =
          book.price != null && product.mrp != null && Number(product.mrp) !== Number(book.price)
        if (book.matchMethod === 'shopcode' && priceConflict) {
          d = {
            status: 'needs_review',
            score: candidates[0].score,
            reason: `shop code ${book.shopCode} matched but price differs (scan ₹${book.price}, catalogue ₹${product.mrp})`,
          }
        } else if (book.matchMethod === 'shopcode') {
          d = { status: 'matched', score: candidates[0].score, reason: `shop code ${book.shopCode} → catalogue` }
        } else {
          d = decide(candidates, book)
        }
        if (book.barcodePresent && d.status === 'unmatched') {
          d = {
            status: 'needs_review',
            score: d.score,
            reason: 'barcode found but no confident catalogue match',
          }
        }
        if (book.price == null && product.mrp != null && d.status === 'matched') {
          state.setBook(key, { price: Number(product.mrp) })
        }
        state.setBook(key, { status: d.status, score: d.score, matchReason: d.reason, candidates })
      }
    } else {
      const candidates = rankBooks(products, book)
      let d = decide(candidates, book)
      if (book.barcodePresent && d.status === 'unmatched') {
        d = { status: 'needs_review', score: d.score, reason: 'barcode found but no confident catalogue match' }
      }
      state.setBook(key, { status: d.status, score: d.score, matchReason: d.reason, candidates })
    }
    if (progress) progress.advance()
  }
}

export async function orchestrate({ folder, dryRun = false, limit = 0, state, retryFailed = false, progress: given = null }) {
  const progress = given ?? startProgress({ label: folder, phase: 'discover', total: 0 })
  let result = null
  try {
    result = await run({ folder, dryRun, limit, state, retryFailed, progress })
    return result
  } finally {
    if (!given) {
      endProgress(progress, result ? `${result.processed} processed, ${result.failed} failed` : 'stopped')
    }
  }
}

async function run({ folder, dryRun, limit, state, retryFailed, progress }) {
  if (state.folder && state.folder !== folder) {
    throw new Error('state belongs to another folder; use --force')
  }
  state.folder = folder
  state.dryRun = dryRun

  progress.start('discover', { total: 0, message: folder })
  const files = discoverImages(folder)
  const cropsDir = path.join(state.jobDir, 'crops')
  const originalsDir = path.join(state.jobDir, 'originals')

  const work = []
  for (const file of files) {
    const abs = path.join(folder, file)
    const buf = fs.readFileSync(abs)
    const sha = sha256(buf)
    let entry = state.getImage(sha)
    if (!entry || entry.path !== abs) {
      entry = state.addImage(sha, { file, path: abs, status: 'pending' })
    }
    progress.setMessage(file)
    progress.advance()
    if (entry.status === 'ocr_done' || entry.status === 'committed') continue
    if (entry.status === 'failed') {
      if (!retryFailed) continue
      state.setImage(sha, { status: 'pending', error: null })
    }
    work.push({ file, abs, buf, entry })
  }
  progress.start('discover', { total: files.length })

  if (limit > 0) work.length = Math.min(work.length, limit)

  let processed = 0
  let failed = 0

  if (work.length > 0) {
    progress.schedule([
      { phase: 'crop', total: work.length },
      { phase: 'ocr', total: work.length },
      { phase: 'match', total: 0 },
    ])

    const ready = []
    for (let i = 0; i < work.length; i++) {
      const { file, buf, entry } = work[i]
      const label = `[${i + 1}/${work.length}] ${file}`
      progress.start('crop', { total: work.length, message: file })
      const cropPath = path.join(cropsDir, `${entry.sha}.jpg`)
      const originalPath = path.join(originalsDir, `${entry.sha}.jpg`)
      try {
        if (!entry.dims || !fs.existsSync(cropPath)) {
          const crop = await cropWhiteBg(buf)
          fs.mkdirSync(cropsDir, { recursive: true })
          fs.writeFileSync(cropPath, crop.buffer)
          state.setImage(entry.sha, { dims: { width: crop.width, height: crop.height } })
        }
        if (!fs.existsSync(originalPath)) {
          const original = await toOriginalJpeg(buf)
          fs.mkdirSync(originalsDir, { recursive: true })
          fs.writeFileSync(originalPath, original)
        }
        state.setImage(entry.sha, { status: 'cropped', error: null })
        state.save()
        progress.step()
        ready.push({ file, entry, originalPath, label })
      } catch (e) {
        const error = `crop: ${e.message}`
        state.setImage(entry.sha, { status: 'failed', error })
        state.save()
        failed++
        progress.log(`${label} → FAILED ${error}`)
        progress.step({ ok: false })
      }
    }

    if (ready.length > 0) {
      progress.start('ocr', { total: ready.length, message: 'scanning barcodes' })
      const barcodeMap = await readBarcodes(ready.map((r) => ({ id: r.entry.sha, path: r.originalPath })))
      for (const r of ready) {
        const raw = barcodeMap.get(r.entry.sha) ?? []
        const { isbn, shopCode } = classifyBarcodes(raw)
        r.barcode = { isbn, shopCode, raw }
        state.setImage(r.entry.sha, { barcode: r.barcode })
      }
      state.save()

      progress.setMessage('reading text with EasyOCR (hi, en)')
      const linesMap = await runOcr(ready.map((r) => ({ id: r.entry.sha, path: r.originalPath })))
      for (const r of ready) r.lines = linesMap.get(r.entry.sha) ?? []
    }

    let products = null
    try {
      products = await fetchProducts()
    } catch (e) {
      console.error(`catalogue snapshot unavailable: ${e.message}`)
    }
    const authoritative = new Map()

    for (const r of ready) {
      const { entry, barcode, lines, label } = r
      try {
        const position = (barcode?.raw?.length ?? 0) > 0 ? 'back' : 'front'
        const { price, priceText } = priceFromLines(lines)

        let title = ''
        let author = ''
        let productId = null
        let matchMethod = null
        if (products) {
          if (barcode?.shopCode) {
            const hit = resolveShopCode(barcode.shopCode, products)
            if (hit) {
              productId = hit.product.id
              matchMethod = 'shopcode'
              title = hit.product.title ?? ''
              author = hit.product.author ?? ''
              authoritative.set(matchNorm(hit.product.title), hit.product.id)
            }
          }
          if (!productId) {
            let hit = bestTitleMatchLines(lines, products, 95)
            if (!hit && lines.some((l) => l.roman)) {
              hit = bestTitleMatchLines(
                lines.filter((l) => l.roman),
                products,
                85,
              )
            }
            if (hit) {
              productId = hit.product.id
              matchMethod = 'title'
              title = hit.product.title ?? ''
              author = hit.product.author ?? ''
            }
          }
        }
        if (!title) title = pickTitleFromLines(lines)

        const isbn = barcode?.isbn || findIsbn(lines)
        const blurb = position === 'back' ? blurbFromLines(lines, title) : ''

        const ocr = { position, title, author, isbn, priceText, price, blurb }
        state.setImage(entry.sha, { status: 'ocr_done', ocr, productId, matchMethod, error: null })
        state.save()
        processed++
        const bits = [
          position,
          barcode?.shopCode ? `code ${barcode.shopCode}` : null,
          isbn ? `isbn ${isbn}` : null,
          price != null ? `₹${price}` : null,
          productId ? `→ ${productId}` : null,
          `"${title}"`,
        ].filter(Boolean)
        progress.log(`${label} → ${bits.join(' ')}`)
        progress.step()
      } catch (e) {
        const error = `ocr: ${e.message}`
        state.setImage(entry.sha, { status: 'failed', error })
        state.save()
        failed++
        progress.log(`${label} → FAILED ${error}`)
        progress.step({ ok: false })
      }
    }

    if (authoritative.size > 0) {
      for (const r of ready) {
        const img = r.entry
        if (img.matchMethod === 'title' && img.productId && img.ocr?.title) {
          const authId = authoritative.get(matchNorm(img.ocr.title))
          if (authId && authId !== img.productId) {
            state.setImage(img.sha, { productId: authId })
            progress.log(`${img.file} → product id aligned to barcode-resolved ${authId}`)
          }
        }
      }
      state.save()
    }
  } else {
    progress.schedule([{ phase: 'match', total: 0 }])
  }

  rebuildBooks(state, files)
  progress.start('match', { total: 0, message: 'grouping books' })
  await matchBooks(state, { dryRun, progress })
  state.save()

  return { processed, failed, books: state.books }
}
