import fs from 'node:fs'
import path from 'node:path'
import { buildVariants, safeName, slugFromTitle } from './image.mjs'
import { putIfMissing, publicUrl } from './r2.mjs'
import { commitBook } from './db.mjs'

async function uploadVariant(kind, slug, name, buf) {
  const key = `optimized/${kind === 'card' ? 'card' : 'detail'}/${slug}/${name}.webp`
  await putIfMissing(key, buf)
  return publicUrl(key)
}

export async function commitConfirmed({ state }) {
  if (state.dryRun) {
    throw new Error('dry-run state cannot commit; re-run without --dry-run')
  }

  const cropsDir = path.join(state.jobDir, 'crops')
  const results = []
  const targets = Object.values(state.books)
    .filter((b) => b.status !== 'committed' && !b.dismissed && (b.chosenProductId || b.createdProductId))
    .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))

  for (const book of targets) {
    try {
      const productId = book.chosenProductId || book.createdProductId
      const frontEntry = state.getImage(book.front)
      if (!frontEntry || !book.front) throw new Error('front image missing from state')
      const frontCrop = path.join(cropsDir, `${frontEntry.sha}.jpg`)
      if (!fs.existsSync(frontCrop)) throw new Error(`front crop file missing: ${frontCrop}`)

      const frontV = await buildVariants(fs.readFileSync(frontCrop))
      const slug = slugFromTitle(book.title, frontEntry.sha)
      const frontName = safeName(frontEntry.file)

      const frontDetail = await uploadVariant('detail', slug, frontName, frontV.detail)
      const frontCard = await uploadVariant('card', slug, frontName, frontV.card)

      let backDetail = null
      let backCard = null
      if (book.back) {
        const backEntry = state.getImage(book.back)
        if (!backEntry) throw new Error('back image missing from state')
        const backCrop = path.join(cropsDir, `${backEntry.sha}.jpg`)
        if (!fs.existsSync(backCrop)) throw new Error(`back crop file missing: ${backCrop}`)
        const backV = await buildVariants(fs.readFileSync(backCrop))
        const backName = safeName(backEntry.file)
        backDetail = await uploadVariant('detail', slug, backName, backV.detail)
        backCard = await uploadVariant('card', slug, backName, backV.card)
      }

      const newImages = [frontDetail, ...(backDetail ? [backDetail] : [])]
      const newThumbnails = [frontCard, ...(backCard ? [backCard] : [])]

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
      console.log(`committed "${book.title}" → ${productId} (front +${backDetail ? ' back' : ''})`)
    } catch (e) {
      state.setBook(book.key, { commitError: e.message })
      state.save()
      results.push({ key: book.key, status: 'failed', error: e.message })
      console.error(`commit failed for "${book.title}": ${e.message}`)
    }
  }

  return results
}
