import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { loadConfig } from './config.mjs'

const CATALOGUE_PATH = fileURLToPath(new URL('../data/products.json', import.meta.url))

let pool = null
let catalogue = null

export function getPool() {
  if (!pool) {
    const { ok, errors, config } = loadConfig({ needDb: true })
    if (!ok) throw new Error(errors.join('; '))
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 2,
      idleTimeoutMillis: 30000,
    })
  }
  return pool
}

export async function closePool() {
  if (pool) {
    await pool.end()
    pool = null
  }
}

/**
 * Matching reads the committed catalogue snapshot in data/products.json and
 * never touches the database. The pool is only opened by the commit write
 * path (commitBook / createProduct).
 */
export function catalogueStatus() {
  if (!catalogue) return null
  return {
    rows: catalogue.rows.length,
    fetchedAt: catalogue.fetchedAt,
    source: 'snapshot',
    path: CATALOGUE_PATH,
  }
}

export async function fetchProducts() {
  if (catalogue) return catalogue.rows
  if (!fs.existsSync(CATALOGUE_PATH)) {
    throw new Error(
      `catalogue snapshot missing at ${CATALOGUE_PATH} — run scripts/snapshot-products.mjs to generate it`,
    )
  }
  let raw
  try {
    raw = JSON.parse(fs.readFileSync(CATALOGUE_PATH, 'utf8'))
  } catch (e) {
    throw new Error(`catalogue snapshot is unreadable at ${CATALOGUE_PATH}: ${e.message}`)
  }
  if (!Array.isArray(raw?.products)) {
    throw new Error(`catalogue snapshot has no "products" array at ${CATALOGUE_PATH}`)
  }
  catalogue = { rows: raw.products, fetchedAt: raw.fetchedAt ?? null }
  return catalogue.rows
}

function mergePairs(newImages, newThumbnails, oldImages, oldThumbnails) {
  const pairs = [
    ...newImages.map((img, i) => [img, newThumbnails?.[i]]),
    ...oldImages.map((img, i) => [img, oldThumbnails?.[i]]),
  ]
  const seen = new Set()
  const images = []
  const thumbnails = []
  for (const [img, thumb] of pairs) {
    if (img == null || seen.has(img)) continue
    seen.add(img)
    images.push(img)
    if (thumb != null && !thumbnails.includes(thumb)) thumbnails.push(thumb)
  }
  return { images, thumbnails }
}

export async function commitBook({ productId, newImages, newThumbnails, isbn, orientation = 'portrait' }) {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT images, thumbnails FROM products WHERE id = $1 FOR UPDATE`,
      [productId],
    )
    if (rows.length === 0) throw new Error(`product ${productId} not found`)
    const merged = mergePairs(newImages ?? [], newThumbnails ?? [], rows[0].images ?? [], rows[0].thumbnails ?? [])
    await client.query(
      `UPDATE products SET images = $1, thumbnails = $2, "ISBN" = COALESCE("ISBN", $3) WHERE id = $4`,
      [merged.images, merged.thumbnails, isbn ?? null, productId],
    )
    await client.query('COMMIT')
    return { images: merged.images, thumbnails: merged.thumbnails }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

export async function createProduct({ title, author, mrp, isbn, images, thumbnails }) {
  const { rows } = await getPool().query(
    `INSERT INTO products (title, author, mrp, "ISBN", images, thumbnails, stock, "isActive", genre)
     VALUES ($1, $2, $3, $4, $5, $6, 0, true, '{}') RETURNING id`,
    [title, author ?? null, mrp, isbn ?? null, images ?? [], thumbnails ?? []],
  )
  return rows[0].id
}
