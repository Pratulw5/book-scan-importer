import 'dotenv/config'
import http from 'node:http'
import { readFile, writeFile, rename, stat, mkdir, readdir } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getProgress } from './progress.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const defaultJobDir = path.resolve(here, '..', 'job')
const webuiPath = path.join(here, 'webui.html')

function isDirectRun() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

function httpError(message, status) {
  const err = new Error(message)
  err.status = status
  return err
}

async function loadState(jobDir) {
  try {
    const raw = await readFile(path.join(jobDir, 'state.json'), 'utf8')
    const state = JSON.parse(raw)
    if (!state.images || typeof state.images !== 'object') state.images = {}
    if (!state.books || typeof state.books !== 'object') state.books = {}
    return state
  } catch (err) {
    if (err.code === 'ENOENT') return { folder: '', dryRun: false, updatedAt: null, images: {}, books: {} }
    throw err
  }
}

async function saveState(jobDir, state) {
  state.updatedAt = new Date().toISOString()
  const file = path.join(jobDir, 'state.json')
  const tmp = `${file}.tmp-${process.pid}`
  await mkdir(jobDir, { recursive: true })
  await writeFile(tmp, JSON.stringify(state, null, 2))
  await rename(tmp, file)
}

function computeCounts(state) {
  const books = Object.values(state.books || {})
  const images = Object.values(state.images || {})
  return {
    matched: books.filter((b) => b.status === 'matched' || b.status === 'created').length,
    review: books.filter((b) => b.status === 'needs_review').length,
    unmatched: books.filter((b) => b.status === 'unmatched').length,
    committed: books.filter((b) => b.status === 'committed').length,
    failedImages: images.filter((i) => i.status === 'failed').length,
  }
}

async function browseDir(dir) {
  try {
    const resolved = path.resolve(dir)
    const entries = await readdir(resolved, { withFileTypes: true })
    const dirs = entries
      .filter(e => e.isDirectory())
      .map(e => ({ name: e.name, path: path.join(resolved, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const hasImages = await dirHasImages(resolved)
    return { dir: resolved, dirs, hasImages }
  } catch {
    return { dir: path.resolve(dir), dirs: [], hasImages: false }
  }
}

async function dirHasImages(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const abs = path.join(dir, entry.name)
    if (entry.isFile() && IMAGE_EXT.test(entry.name)) return true
    if (entry.isDirectory() && await dirHasImages(abs)) return true
  }
  return false
}

const IMAGE_EXT = /\.(jpe?g|png|webp|heic)$/i

function defaultChecks() {
  return {
    lms: async () => {
      const host = process.env.LMSTUDIO_HOST || 'http://127.0.0.1:1234'
      if (process.env.LMSTUDIO_MODEL) return { ok: true, model: process.env.LMSTUDIO_MODEL, host }
      try {
        const { listModels } = await import('./llm.mjs')
        const model = await withTimeout(listModels(), 1000)
        if (!model) throw new Error('no models reported')
        return { ok: true, model, host }
      } catch {
        return { ok: false, model: null, host }
      }
    },
    db: async () => {
      const configured = Boolean(process.env.DATABASE_URL)
      try {
        const { fetchProducts, catalogueStatus } = await import('./db.mjs')
        const products = await fetchProducts()
        return { ok: configured && products.length > 0, configured, catalogue: catalogueStatus() }
      } catch (e) {
        return { ok: false, configured, error: e.message }
      }
    },
    r2: () => {
      const required = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_URL']
      return { ok: required.every((name) => process.env[name]) }
    },
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

async function readJsonBody(req, limit = 1_000_000) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw httpError('payload too large', 413)
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw httpError('invalid JSON body', 400)
  }
}

async function serveImage(res, jobDir, sha) {
  const cropsDir = path.join(jobDir, 'crops')
  const file = path.join(cropsDir, `${sha}.jpg`)
  if (path.dirname(file) !== cropsDir) throw httpError('invalid image path', 400)
  let info
  try {
    info = await stat(file)
  } catch {
    throw httpError('image not found', 404)
  }
  res.writeHead(200, {
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'no-cache',
    'Content-Length': info.size,
  })
  const stream = createReadStream(file)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

async function handleBookAction(req, res, ctx, key, action) {
  const state = await loadState(ctx.jobDir)
  const book = state.books[key]
  if (!book) throw httpError(`book not found: ${key}`, 404)
  const body = await readJsonBody(req)

  if (action === 'confirm') {
    const productId = typeof body.productId === 'string' ? body.productId.trim() : ''
    if (!productId) throw httpError('productId (string) is required', 400)
    book.chosenProductId = productId
    book.status = 'matched'
    book.dismissed = false
    await saveState(ctx.jobDir, state)
    return sendJson(res, 200, { ok: true, book })
  }

  if (action === 'dismiss') {
    if (book.status === 'committed') throw httpError('book is already committed', 409)
    book.dismissed = body.undo === true ? false : true
    await saveState(ctx.jobDir, state)
    return sendJson(res, 200, { ok: true, book })
  }

  const title = typeof body.title === 'string' ? body.title.trim() : ''
  const author = typeof body.author === 'string' ? body.author.trim() : ''
  const isbn = typeof body.isbn === 'string' ? body.isbn.replace(/[\s-]/g, '') : ''
  let mrp = null
  if (body.mrp !== undefined && body.mrp !== null && String(body.mrp).trim() !== '') {
    mrp = Number(body.mrp)
    if (!Number.isFinite(mrp) || mrp <= 0) throw httpError('mrp must be a positive number', 400)
  }
  if (!title) throw httpError('title is required', 400)

  let id
  try {
    const { createProduct } = await import('./db.mjs')
    const created = await createProduct({ title, author, mrp, isbn, images: [], thumbnails: [] })
    id = typeof created === 'string' ? created : created?.id ?? created
  } catch (err) {
    throw httpError(`createProduct failed: ${err.message}`, 502)
  }
  if (!id) throw httpError('createProduct returned no id', 502)
  book.createdProductId = String(id)
  book.status = 'created'
  await saveState(ctx.jobDir, state)
  return sendJson(res, 200, { ok: true, book })
}

async function handle(req, res, ctx) {
  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname

  if (req.method === 'GET' && p === '/') {
    let html
    try {
      html = await readFile(webuiPath, 'utf8')
    } catch {
      throw httpError('webui.html not found', 404)
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' })
    return res.end(html)
  }

  if (req.method === 'GET' && p === '/health') return sendJson(res, 200, { ok: true })

  if (req.method === 'GET' && p === '/api/progress') {
    return sendJson(res, 200, { progress: getProgress() })
  }

  let m
  if (req.method === 'GET' && (m = p.match(/^\/img\/([a-f0-9]{64})$/i))) {
    return serveImage(res, ctx.jobDir, m[1].toLowerCase())
  }

  if (req.method === 'GET' && p === '/api/state') {
    const state = await loadState(ctx.jobDir)
    const [lms, db, r2] = await Promise.all([ctx.checks.lms(), ctx.checks.db(), ctx.checks.r2()])
    const books = Object.values(state.books).sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0))
    return sendJson(res, 200, {
      folder: state.folder ?? null,
      dryRun: Boolean(state.dryRun),
      lms,
      db,
      r2,
      counts: computeCounts(state),
      progress: getProgress(),
      books,
      images: Object.values(state.images),
    })
  }

  if (req.method === 'POST' && (m = p.match(/^\/api\/book\/([^/]+)\/(confirm|dismiss|create)$/))) {
    return handleBookAction(req, res, ctx, decodeURIComponent(m[1]), m[2])
  }

  if (req.method === 'POST' && p === '/api/commit') {
    const loaded = await loadState(ctx.jobDir)
    const { JobState } = await import('./state.mjs')
    const { commitConfirmed } = await import('./commit.mjs')
    const jobState = new JobState(ctx.jobDir)
    jobState.state = loaded
    const results = await commitConfirmed({ state: jobState })
    await saveState(ctx.jobDir, jobState.stateData)
    return sendJson(res, 200, { results })
  }

  if (req.method === 'POST' && p === '/api/retry') {
    const state = await loadState(ctx.jobDir)
    if (!state.folder) throw httpError('no folder selected yet', 400)
    const { JobState } = await import('./state.mjs')
    const pipeline = await import('./pipeline.mjs')
    const jobState = new JobState(ctx.jobDir).load()
    let retried
    if (typeof pipeline.retryFailed === 'function') {
      retried = await pipeline.retryFailed(jobState)
    } else {
      retried = await pipeline.orchestrate({
        folder: jobState.folder,
        dryRun: jobState.dryRun,
        limit: 0,
        state: jobState,
        retryFailed: true,
      })
    }
    await saveState(ctx.jobDir, jobState.stateData)
    return sendJson(res, 200, { ok: true, retried })
  }

  if (req.method === 'GET' && p === '/api/browse') {
    const url = new URL(req.url, 'http://localhost')
    const dir = url.searchParams.get('path') || process.cwd()
    const result = await browseDir(dir)
    return sendJson(res, 200, result)
  }

  if (req.method === 'POST' && p === '/api/start-job') {
    const body = await readJsonBody(req)
    const requested = typeof body.folder === 'string' ? body.folder.trim() : ''
    if (!requested) throw httpError('folder is required', 400)
    const folder = path.resolve(requested)
    let st
    try {
      st = await stat(folder)
    } catch {
      throw httpError('folder not found', 404)
    }
    if (!st.isDirectory()) throw httpError('not a directory', 400)

    const { loadConfig } = await import('./config.mjs')
    const { discoverImages, orchestrate } = await import('./pipeline.mjs')
    const { JobState } = await import('./state.mjs')

    const images = discoverImages(folder)
    if (images.length === 0) throw httpError('no images found in folder', 400)

    const { ok, errors } = loadConfig({ needLlm: true, needDb: false, needR2: false })
    if (!ok) throw httpError('Missing config: ' + errors.join(', '), 500)

    const state = new JobState(ctx.jobDir)
    state.reset(folder, false)

    try {
      await orchestrate({
        folder,
        dryRun: false,
        limit: 0,
        state,
        retryFailed: false,
      })
    } catch (err) {
      console.error('orchestrate error:', err)
      throw err
    }

    return sendJson(res, 200, { ok: true, folder, imageCount: images.length })
  }

  throw httpError('not found', 404)
}

export function startServer({ port, jobDir = defaultJobDir, checks = {} } = {}) {
  const listenPort = port ?? (Number(process.env.WEB_PORT || 4173) || 4173)
  const ctx = { jobDir, checks: { ...defaultChecks(), ...checks } }
  const server = http.createServer((req, res) => {
    handle(req, res, ctx).catch((err) => {
      if (!res.headersSent) sendJson(res, err.status || 500, { error: err.message || String(err) })
      else res.end()
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', (err) => {
      console.error(`web: listen failed: ${err.message}`)
      if (isDirectRun()) process.exit(1)
      reject(err)
    })
    server.listen(listenPort, () => {
      const actual = server.address()?.port ?? listenPort
      console.log(`Book Scan Importer UI: http://localhost:${actual}`)
      resolve(server)
    })
  })
}

if (isDirectRun()) {
  const args = process.argv.slice(2)
  let port
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') port = Number(args[i + 1])
    else if (args[i].startsWith('--port=')) port = Number(args[i].slice(7))
  }
  startServer(port !== undefined && Number.isFinite(port) ? { port } : {}).catch((err) => {
    console.error(err.message || err)
    process.exit(1)
  })
}
