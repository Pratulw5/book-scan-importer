import { runPy } from './py.mjs'

export async function runOcr(images) {
  const items = await runPy('ocr_batch.py', images, { timeout: 7200000 })
  return new Map(items.map((i) => [i.id, i.lines ?? []]))
}
