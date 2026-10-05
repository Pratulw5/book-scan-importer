import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from './config.mjs'
import { JobState } from './state.mjs'
import { discoverImages, orchestrate } from './pipeline.mjs'
import { closePool } from './db.mjs'
import { attachConsoleRenderer } from './progress.mjs'

function usage() {
  console.error('usage: node src/run.mjs <folder> [--dry-run] [--limit N] [--force] [--web]')
}

function parseArgs(argv) {
  const args = { folder: null, dryRun: false, limit: 0, force: false, web: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--force') args.force = true
    else if (a === '--web') args.web = true
    else if (a === '--limit') {
      const n = parseInt(argv[++i], 10)
      if (!Number.isFinite(n) || n < 1) {
        console.error('--limit requires a positive integer')
        process.exit(1)
      }
      args.limit = n
    } else if (a.startsWith('--limit=')) {
      const n = parseInt(a.slice(8), 10)
      if (!Number.isFinite(n) || n < 1) {
        console.error('--limit requires a positive integer')
        process.exit(1)
      }
      args.limit = n
    } else if (a.startsWith('-') && a !== '-') {
      console.error(`unknown flag: ${a}`)
      usage()
      process.exit(1)
    } else if (args.folder === null) {
      args.folder = a
    } else {
      console.error(`unexpected argument: ${a}`)
      usage()
      process.exit(1)
    }
  }
  return args
}

function printSummary(result, state, folder) {
  const img = state.imageCount()
  console.log('')
  console.log(`Folder: ${folder}`)
  console.log(
    `Images: ${Object.keys(state.images).length} total — ` +
      `ocr_done ${img.ocr_done ?? 0}, committed ${img.committed ?? 0}, pending ${img.pending ?? 0}, cropped ${img.cropped ?? 0}, failed ${img.failed ?? 0}`,
  )
  const bookCounts = state.bookCount()
  console.log(
    `Books: ${Object.keys(state.books).length} total — ` +
      `matched ${bookCounts.matched ?? 0}, needs_review ${bookCounts.needs_review ?? 0}, ` +
      `unmatched ${bookCounts.unmatched ?? 0}, committed ${bookCounts.committed ?? 0}, created ${bookCounts.created ?? 0}`,
  )
  console.log('')
  const books = Object.values(state.books).sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
  if (books.length === 0) {
    console.log('No books yet.')
    return
  }
  const titles = books.map((b) => b.title || '(untitled)')
  const width = Math.max(...titles.map((t) => t.length), 8)
  for (const b of books) {
    const t = (b.title || '(untitled)').slice(0, width)
    const top = b.candidates?.[0]
    const topText = top ? `"${top.title}" (mrp ${top.mrp}, score ${top.score})` : '—'
    console.log(`  ${t.padEnd(width)}  ${b.status.padEnd(12)}  ${topText}`)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.folder) {
    usage()
    process.exit(1)
  }
  const folder = path.resolve(args.folder)
  let st
  try {
    st = fs.statSync(folder)
  } catch {
    console.error(`folder not found: ${folder}`)
    process.exit(1)
  }
  if (!st.isDirectory()) {
    console.error(`not a directory: ${folder}`)
    process.exit(1)
  }
  const images = discoverImages(folder)
  if (images.length === 0) {
    console.error(`no images found in ${folder} (looking for .jpg .jpeg .png .webp .heic)`)
    process.exit(1)
  }

  const { ok, errors, config } = loadConfig({ needLlm: true, needDb: false, needR2: false })
  if (!ok) {
    console.error('Missing required configuration:')
    for (const e of errors) console.error(`  - ${e}`)
    console.error('Copy .env.example to .env and fill in the values.')
    process.exit(1)
  }
  if (!args.dryRun) {
    const r2 = loadConfig({ needR2: true })
    if (!r2.ok) {
      console.error('Warning: R2 credentials incomplete — commit will fail until .env is updated:')
      for (const e of r2.errors) console.error(`  - ${e}`)
    }
  }

  const state = new JobState().load()
  if (state.folder && state.folder !== folder) {
    if (args.force) {
      console.error(`state belongs to ${state.folder}; --force given, re-initialising`)
      state.reset(folder, args.dryRun)
    } else {
      console.error('state belongs to another folder; use --force')
      process.exit(1)
    }
  }

  const detachProgress = attachConsoleRenderer()
  let result
  try {
    result = await orchestrate({
      folder,
      dryRun: args.dryRun,
      limit: args.limit,
      state,
      retryFailed: false,
    })
  } finally {
    detachProgress()
  }

  printSummary(result, state, folder)
  if (args.web) {
    let mod
    try {
      mod = await import('./web.mjs')
    } catch (e) {
      console.error(`cannot start web UI: ${e.message}`)
      process.exit(1)
    }
    await mod.startServer({ port: config.webPort })
    return
  }
  console.log('')
  console.log('Review & commit in the browser: node src/web.mjs')
  await closePool()
}

main().catch((e) => {
  console.error(e.message)
  process.exit(1)
})
