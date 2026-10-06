import { runPy } from './py.mjs'

export async function readBarcodes(images) {
  const items = await runPy('read_barcodes.py', images, { timeout: 600000 })
  return new Map(items.map((i) => [i.id, i.barcodes ?? []]))
}
