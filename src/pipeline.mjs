import fs from 'node:fs'
import path from 'node:path'
import { sha256, cropWhiteBg, safeName } from './image.mjs'
import { listModels, visionExtract } from './llm.mjs'
import { normalize, parsePrice, isValidIsbn, rankBooks, decide, decideUnavailable } from './match.mjs'
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
    } else {
      const candidates = rankBooks(products, book)
      const d = decide(candidates, book)
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
    let model = null
    try {
      progress.start('crop', { total: work.length, message: 'loading vision model' })
      model = await listModels()
    } catch (e) {
      console.error(`model discovery failed: ${e.message}`)
    }
    for (let i = 0; i < work.length; i++) {
      const { file, buf, entry } = work[i]
      const label = `[${i + 1}/${work.length}] ${file}`
      progress.start('crop', { total: work.length, message: file })
      if (!model) {
        const error = `ocr: ${'no vision model available'}`
        state.setImage(entry.sha, { status: 'failed', error })
        state.save()
        failed++
        progress.log(`${label} → FAILED ${error}`)
        progress.step({ ok: false })
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
        progress.log(`${label} → FAILED ${error}`)
        progress.step({ ok: false })
        continue
      }
      try {
        fs.mkdirSync(cropsDir, { recursive: true })
        fs.writeFileSync(path.join(cropsDir, `${entry.sha}.jpg`), cropBuf)
        state.setImage(entry.sha, { status: 'cropped', dims: { width, height }, error: null })
        state.save()
        progress.step()
      } catch (e) {
        const error = `crop: ${e.message}`
        state.setImage(entry.sha, { status: 'failed', error })
        state.save()
        failed++
        progress.log(`${label} → FAILED ${error}`)
        progress.step({ ok: false })
        continue
      }
      try {
        progress.start('ocr', { total: work.length, message: `${file} → ${model}` })
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
        progress.log(
          `${label} → cropped ${width}x${height} → ${ocr.position ?? 'unknown'} "${ocr.title}" ${price != null ? `₹${price}` : 'no-price'} ${isbn ? 'isbn-ok' : 'no-isbn'}`,
        )
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
  } else {
    progress.schedule([{ phase: 'match', total: 0 }])
  }

  rebuildBooks(state, files)
  progress.start('match', { total: 0, message: 'grouping books' })
  await matchBooks(state, { dryRun, progress })
  state.save()

  return { processed, failed, books: state.books }
}
