#!/usr/bin/env node
// Regenerates data/products.json — the committed catalogue snapshot that all
// matching reads from. This is the ONLY script that reads the products table.
// Run it when you want to pick up catalogue changes from Neon:
//
//   node scripts/snapshot-products.mjs
//
// The snapshot holds only the columns matching needs (id, title, author, mrp,
// ISBN). images/thumbnails are deliberately excluded: commitBook reads those
// per row from the database when you press "Commit to database".

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { loadConfig } from '../src/config.mjs'

const OUT = fileURLToPath(new URL('../data/products.json', import.meta.url))

const { ok, errors, config } = loadConfig({ needDb: true })
if (!ok) {
  console.error(`Missing required configuration:\n  - ${errors.join('\n  - ')}`)
  process.exit(1)
}

const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 1 })
try {
  const { rows } = await pool.query(`SELECT id, title, author, mrp, "ISBN" FROM products`)
  const products = rows.map((r) => ({
    id: r.id,
    title: r.title ?? '',
    author: r.author ?? '',
    mrp: r.mrp ?? null,
    isbn: r['ISBN'] ?? '',
  }))
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify({ fetchedAt: new Date().toISOString(), count: products.length, products }))
  console.log(`wrote ${OUT} — ${products.length} products`)
} finally {
  await pool.end()
}