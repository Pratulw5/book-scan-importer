import fs from 'node:fs'
import path from 'node:path'
import { sha256, cropWhiteBg, safeName } from './image.mjs'
import { listModels, visionExtract } from './llm.mjs'
import { normalize, parsePrice, isValidIsbn, rankBooks, decide, decideUnavailable } from './match.mjs'
import { fetchProducts } from './db.mjs'

const IMAGE_EXT = /\.(jpe?g|png|webp|heic)$/i

export function discoverImages(folder) {
  return fs
    .readdirSync(folder)
    .filter((f) => IMAGE_EXT.test(f) && fs.statSync(path.join(folder, f)).isFile())
    .sort()
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
    const key = entry.ocr?.title ? normalize(entry.ocr.title) : safeName(file)
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
      ...preserved,
      ...(old && (old.status === 'committed' || old.status === 'created') ? { status: old.status } : {}),
    })
    seen.add(key)
  }

  for (const key of Object.keys(state.books)) {
    if (!seen.has(key)) delete state.books[key]
  }
}

export async function matchBooks(state, { dryRun }) {
  let products = null
  if (!dryRun) {
    try {
      products = await fetchProducts()
    } catch (e) {
      products = null
      console.error(`database unavailable, matching disabled: ${e.message}`)
    }
  }
  for (const key of Object.keys(state.books)) {
    const book = state.books[key]
    if (book.status === 'committed' || book.status === 'created') continue
    if (dryRun || products === null) {
      const d = decideUnavailable()
      state.setBook(key, { status: d.status, score: d.score, matchReason: d.reason, candidates: [] })
    } else {
      const candidates = rankBooks(products, book)
      const d = decide(candidates, book)
      state.setBook(key, { status: d.status, score: d.score, matchReason: d.reason, candidates })
    }
  }
}

export async function orchestrate({ folder, dryRun = false, limit = 0, state, retryFailed = false }) {
  if (state.folder && state.folder !== folder) {
    throw new Error('state belongs to another folder; use --force')
  }
  state.folder = folder
  state.dryRun = dryRun

  const files = discoverImages(folder)
  const cropsDir = path.join(state.jobDir, 'crops')

  const work = []
  for (const file of files) {
    const abs = path.join(folder, file)
    const buf = fs.readFileSync(abs)
    const sha = sha256(buf)
    let entry = state.getImage(sha)
    if (!entry || entry.path !== abs) {
      entry = state.addImage(sha, { file, path: abs, status: 'pending' })
    }
    if (entry.status === 'ocr_done' || entry.status === 'committed') continue
    if (entry.status === 'failed') {
      if (!retryFailed) continue
      state.setImage(sha, { status: 'pending', error: null })
    }
    work.push({ file, abs, buf, entry })
  }

  if (limit > 0) work.length = Math.min(work.length, limit)

  let processed = 0
  let failed = 0

  if (work.length > 0) {
    let model = null
    try {
      model = await listModels()
    } catch (e) {
      console.error(`model discovery failed: ${e.message}`)
    }
    for (let i = 0; i < work.length; i++) {
      const { file, buf, entry } = work[i]
      const label = `[${i + 1}/${work.length}] ${file}`
      if (!model) {
        const error = `ocr: ${'no vision model available'}`
        state.setImage(entry.sha, { status: 'failed', error })
        state.save()
        failed++
        console.log(`${label} → FAILED ${error}`)
        continue
      }
      let cropBuf
      let width
      let height
      try {
        const crop = await cropWhiteBg(buf)
        cropBuf = crop.buffer
        width = crop.width
        height = crop.height
      } catch (e) {
        const error = `crop: ${e.message}`
        state.setImage(entry.sha, { status: 'failed', error })
        state.save()
        failed++
        console.log(`${label} → FAILED ${error}`)
        continue
      }
      try {
        fs.mkdirSync(cropsDir, { recursive: true })
        fs.writeFileSync(path.join(cropsDir, `${entry.sha}.jpg`), cropBuf)
        state.setImage(entry.sha, { status: 'cropped', dims: { width, height }, error: null })
        state.save()
      } catch (e) {
        const error = `crop: ${e.message}`
        state.setImage(entry.sha, { status: 'failed', error })
        state.save()
        failed++
        console.log(`${label} → FAILED ${error}`)
        continue
      }
      try {
        const ocr = await visionExtract({ imageBuf: cropBuf, model })
        const isbn = isValidIsbn(ocr.isbn) ? ocr.isbn : ''
        const price = parsePrice(ocr.priceText)
        state.setImage(entry.sha, {
          status: 'ocr_done',
          ocr: { ...ocr, isbn, price },
          error: null,
        })
        state.save()
        processed++
        console.log(
          `${label} → cropped ${width}x${height} → ${ocr.position ?? 'unknown'} "${ocr.title}" ${price != null ? `₹${price}` : 'no-price'} ${isbn ? 'isbn-ok' : 'no-isbn'}`,
        )
      } catch (e) {
        const error = `ocr: ${e.message}`
        state.setImage(entry.sha, { status: 'failed', error })
        state.save()
        failed++
        console.log(`${label} → FAILED ${error}`)
      }
    }
  }

  rebuildBooks(state, files)
  await matchBooks(state, { dryRun })
  state.save()

  return { processed, failed, books: state.books }
}
