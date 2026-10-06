import fs from 'node:fs'
import path from 'node:path'
import { buildVariants, safeName, slugFromTitle } from './image.mjs'
import { putIfMissing, publicUrl } from './r2.mjs'
import { commitBook } from './db.mjs'
import { startProgress, endProgress } from './progress.mjs'

async function uploadVariant(kind, slug, name, buf) {
  const key = `optimized/${kind === 'card' ? 'card' : 'detail'}/${slug}/${name}.webp`
  await putIfMissing(key, buf)
  return publicUrl(key)
}

export async function commitConfirmed({ state, progress: given = null }) {
  if (state.dryRun) {
    throw new Error('dry-run state cannot commit; re-run without --dry-run')
  }

  const cropsDir = path.join(state.jobDir, 'crops')
  const originalsDir = path.join(state.jobDir, 'originals')

  function sourceFile(entry) {
    const dir = entry.useOriginal ? originalsDir : cropsDir
    const file = path.join(dir, `${entry.sha}.jpg`)
    if (!fs.existsSync(file)) {
      const fallback = path.join(entry.useOriginal ? cropsDir : originalsDir, `${entry.sha}.jpg`)
      if (fs.existsSync(fallback)) return fallback
      throw new Error(`${entry.useOriginal ? 'original' : 'crop'} file missing: ${file}`)
    }
    return file
  }

  const results = []
  const targets = Object.values(state.books)
    .filter((b) => b.status !== 'committed' && !b.dismissed && (b.chosenProductId || b.createdProductId))
    .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))

  const progress = given ?? startProgress({ label: 'database', phase: 'commit', total: targets.length })
  try {
    for (const book of targets) {
      progress.start('commit', { total: targets.length, message: book.title || book.key })
      try {
        const productId = book.chosenProductId || book.createdProductId
        const frontEntry = state.getImage(book.front)
        if (!frontEntry || !book.front) throw new Error('front image missing from state')

        progress.setMessage(`${book.title || book.key} — building variants`)
        const frontV = await buildVariants(fs.readFileSync(sourceFile(frontEntry)))
        const slug = slugFromTitle(book.title, frontEntry.sha)
        const frontName = safeName(frontEntry.file)

        progress.setMessage(`${book.title || book.key} — uploading front`)
        const frontDetail = await uploadVariant('detail', slug, frontName, frontV.detail)
        const frontCard = await uploadVariant('card', slug, frontName, frontV.card)

        let backDetail = null
        let backCard = null
        if (book.back) {
          const backEntry = state.getImage(book.back)
          if (!backEntry) throw new Error('back image missing from state')
          progress.setMessage(`${book.title || book.key} — uploading back`)
          const backV = await buildVariants(fs.readFileSync(sourceFile(backEntry)))
          const backName = safeName(backEntry.file)
          backDetail = await uploadVariant('detail', slug, backName, backV.detail)
          backCard = await uploadVariant('card', slug, backName, backV.card)
        }

        const newImages = [frontDetail, ...(backDetail ? [backDetail] : [])]
        const newThumbnails = [frontCard, ...(backCard ? [backCard] : [])]

        progress.setMessage(`${book.title || book.key} — writing to database`)
        await commitBook({
          productId,
          newImages,
          newThumbnails,
          isbn: book.isbn || null,
          orientation: 'portrait',
        })

        state.setBook(book.key, {
          status: 'committed',
          commitError: null,
          urls: { frontDetail, frontCard, backDetail, backCard },
        })
        state.save()
        results.push({ key: book.key, status: 'committed', error: null })
        progress.log(`committed "${book.title}" → ${productId} (front +${backDetail ? ' back' : ''})`)
        progress.step()
      } catch (e) {
        state.setBook(book.key, { commitError: e.message })
        state.save()
        results.push({ key: book.key, status: 'failed', error: e.message })
        progress.log(`commit failed for "${book.title}": ${e.message}`, { level: 'error' })
        progress.step({ ok: false })
      }
    }
  } finally {
    if (!given) {
      const ok = results.filter((r) => r.status === 'committed').length
      endProgress(progress, `${ok}/${results.length} committed`)
    }
  }

  return results
}
