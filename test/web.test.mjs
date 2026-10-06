import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { startServer } from '../src/web.mjs'
import { resetProgress, startProgress, endProgress } from '../src/progress.mjs'

const SHA = 'a'.repeat(64)
const FAILED_SHA = 'b'.repeat(64)
const CROP_ONLY_SHA = 'd'.repeat(64)
const JPG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
const ORIGINAL_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x20, 0x4f, 0x52, 0x49, 0x47])

function fixtureState() {
  return {
    folder: '/tmp/fake-books',
    dryRun: false,
    updatedAt: '2026-10-04T00:00:00.000Z',
    images: {
      [SHA]: {
        sha: SHA,
        file: 'alpha-front.jpg',
        path: '/tmp/fake-books/alpha-front.jpg',
        status: 'ocr_done',
        error: null,
        dims: { width: 1200, height: 1800 },
        ocr: {
          position: 'front',
          title: 'The Alpha Book',
          author: 'Jane Doe',
          isbn: '9781234567897',
          priceText: '₹499',
          price: 499,
          blurb: 'A fine book.',
        },
      },
      [FAILED_SHA]: {
        sha: FAILED_SHA,
        file: 'beta-back.jpg',
        path: '/tmp/fake-books/beta-back.jpg',
        status: 'failed',
        error: 'ocr_batch.py failed (1): ModuleNotFoundError',
        dims: null,
        ocr: null,
      },
    },
    books: {
      'the alpha book': {
        key: 'the alpha book',
        sortIndex: 0,
        title: 'The Alpha Book',
        author: 'Jane Doe',
        isbn: '9781234567897',
        price: 499,
        blurb: 'A fine book.',
        front: SHA,
        back: null,
        status: 'needs_review',
        dismissed: false,
        score: 96,
        matchReason: 'close but not sure',
        candidates: [
          {
            id: 'prod-1',
            title: 'The Alpha Book',
            author: 'Jane Doe',
            mrp: 499,
            isbn: '9781234567897',
            score: 101,
            titleScore: 100,
            mrpMatch: true,
            authorMatch: true,
          },
        ],
        chosenProductId: null,
        createdProductId: null,
        commitError: null,
        urls: null,
      },
      'omega book': {
        key: 'omega book',
        sortIndex: 1,
        title: 'The Omega Book',
        author: 'No One',
        isbn: '',
        price: 299,
        blurb: '',
        front: FAILED_SHA,
        back: null,
        status: 'unmatched',
        dismissed: false,
        score: 40,
        matchReason: 'no close candidate',
        candidates: [],
        chosenProductId: null,
        createdProductId: null,
        commitError: null,
        urls: null,
      },
      'zeta book': {
        key: 'zeta book',
        sortIndex: 2,
        title: 'The Zeta Book',
        author: 'Zip Z.',
        isbn: '',
        price: 99,
        blurb: '',
        front: SHA,
        back: null,
        status: 'committed',
        dismissed: false,
        score: 150,
        matchReason: 'auto-matched',
        candidates: [],
        chosenProductId: 'prod-9',
        createdProductId: null,
        commitError: null,
        urls: {
          frontDetail: 'https://r2.test/fd.webp',
          frontCard: 'https://r2.test/fc.webp',
          backDetail: null,
          backCard: null,
        },
      },
    },
  }
}

describe('web.mjs', () => {
  let server
  let base
  let jobDir
  const stateFile = () => path.join(jobDir, 'state.json')

  beforeAll(async () => {
    jobDir = await mkdtemp(path.join(tmpdir(), 'bsi-web-test-'))
    await mkdir(path.join(jobDir, 'crops'), { recursive: true })
    await mkdir(path.join(jobDir, 'originals'), { recursive: true })
    await writeFile(path.join(jobDir, 'crops', `${SHA}.jpg`), JPG_BYTES)
    await writeFile(path.join(jobDir, 'crops', `${CROP_ONLY_SHA}.jpg`), JPG_BYTES)
    await writeFile(path.join(jobDir, 'originals', `${SHA}.jpg`), ORIGINAL_BYTES)
    await writeFile(stateFile(), JSON.stringify(fixtureState(), null, 2))

    server = await startServer({
      port: 0,
      jobDir,
      checks: {
        ocr: async () => ({ ok: true }),
        db: async () => ({ ok: true }),
        r2: () => ({ ok: true }),
      },
    })
    base = `http://127.0.0.1:${server.address().port}`
  })

  afterAll(async () => {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
    await rm(jobDir, { recursive: true, force: true })
  })

  it('GET /health → { ok: true }', async () => {
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('GET / serves webui.html with text/html', async () => {
    const res = await fetch(`${base}/`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/html/)
    const html = await res.text()
    expect(html).toContain('Book Scan Importer')
    expect(html).toContain('/api/state')
  })

  it('GET /api/state returns the contract shape with injected checks', async () => {
    const res = await fetch(`${base}/api/state`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.folder).toBe('/tmp/fake-books')
    expect(body.dryRun).toBe(false)
    expect(body.ocr).toEqual({ ok: true })
    expect(body.db).toEqual({ ok: true })
    expect(body.r2).toEqual({ ok: true })
    expect(body.counts).toEqual({ matched: 0, review: 1, unmatched: 1, failedImages: 1, committed: 1 })
    expect(body.books).toHaveLength(3)
    expect(body.books.map((b) => b.key)).toEqual(['the alpha book', 'omega book', 'zeta book'])
    expect(body.images).toHaveLength(2)
  })

  it('GET /img/:sha streams the crop as image/jpeg', async () => {
    const res = await fetch(`${base}/img/${SHA}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(Buffer.from(await res.arrayBuffer()).equals(JPG_BYTES)).toBe(true)
  })

  it('GET /img/:sha → 404 JSON when the file is missing', async () => {
    const res = await fetch(`${base}/img/${FAILED_SHA}`)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBeTruthy()
  })

  it('GET /img/:sha → 404 for non-hex / wrong-length shas', async () => {
    for (const bad of ['xyz', 'a'.repeat(63), 'a'.repeat(65), 'a'.repeat(32) + 'g'.repeat(32)]) {
      const res = await fetch(`${base}/img/${bad}`)
      expect(res.status).toBe(404)
      await res.json()
    }
  })

  it('GET /img/:sha?src=orig streams the original, falling back to the crop', async () => {
    const res = await fetch(`${base}/img/${SHA}?src=orig`)
    expect(res.status).toBe(200)
    expect(Buffer.from(await res.arrayBuffer()).equals(ORIGINAL_BYTES)).toBe(true)

    const fallback = await fetch(`${base}/img/${CROP_ONLY_SHA}?src=orig`)
    expect(fallback.status).toBe(200)
    expect(Buffer.from(await fallback.arrayBuffer()).equals(JPG_BYTES)).toBe(true)
  })

  it('unknown route → 404 JSON', async () => {
    const res = await fetch(`${base}/definitely-not-a-route`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
  })

  it('POST /api/book/:key/confirm sets chosenProductId + status matched on disk', async () => {
    const res = await fetch(`${base}/api/book/${encodeURIComponent('the alpha book')}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: 'prod-1' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.book.chosenProductId).toBe('prod-1')
    expect(body.book.status).toBe('matched')

    const onDisk = JSON.parse(await readFile(stateFile(), 'utf8'))
    expect(onDisk.books['the alpha book'].chosenProductId).toBe('prod-1')
    expect(onDisk.books['the alpha book'].status).toBe('matched')
  })

  it('POST /api/book/:key/confirm without productId → 400', async () => {
    const res = await fetch(`${base}/api/book/${encodeURIComponent('omega book')}/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBeTruthy()
  })

  it('POST /api/book/:key/confirm for unknown book → 404', async () => {
    const res = await fetch(`${base}/api/book/nope/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: 'x' }),
    })
    expect(res.status).toBe(404)
  })

  it('POST /api/book/:key/dismiss toggles dismissed, { undo: true } reverts', async () => {
    const res1 = await fetch(`${base}/api/book/${encodeURIComponent('omega book')}/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res1.status).toBe(200)
    expect((await res1.json()).book.dismissed).toBe(true)

    const res2 = await fetch(`${base}/api/book/${encodeURIComponent('omega book')}/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ undo: true }),
    })
    expect(res2.status).toBe(200)
    expect((await res2.json()).book.dismissed).toBe(false)
  })

  it('POST /api/book/:key/dismiss on committed book → 409', async () => {
    const res = await fetch(`${base}/api/book/${encodeURIComponent('zeta book')}/dismiss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(409)
  })

  describe('progress reporting', () => {
    afterEach(() => {
      resetProgress()
    })

    it('GET /api/progress → { progress: null } when nothing has run', async () => {
      const res = await fetch(`${base}/api/progress`)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ progress: null })
    })

    it('GET /api/progress exposes the running phase for the UI progress bar', async () => {
      const progress = startProgress({ label: '/tmp/fake-books', phase: 'crop', total: 2 })
      progress.step()

      const res = await fetch(`${base}/api/progress`)
      const body = await res.json()
      expect(body.progress.phase).toBe('crop')
      expect(body.progress.phaseLabel).toBe('Analyzing image')
      expect(body.progress.total).toBe(2)
      expect(body.progress.current).toBe(1)
      expect(body.progress.fraction).toBe(0.5)
      expect(body.progress.done).toBe(false)
    })

    it('GET /api/state carries the same progress snapshot', async () => {
      const progress = startProgress({ label: '/tmp/fake-books', phase: 'commit', total: 1 })
      progress.log('committed "The Alpha Book" → prod-1')
      endProgress(progress, '1/1 committed')

      const res = await fetch(`${base}/api/state`)
      const body = await res.json()
      expect(body.progress.phase).toBe('commit')
      expect(body.progress.done).toBe(true)
      expect(body.progress.fraction).toBe(1)
      expect(body.progress.summary).toBe('1/1 committed')
      expect(body.progress.events).toHaveLength(1)
    })
  })

  describe('image source toggle', () => {
    it('POST /api/image/:sha/source { original } persists useOriginal, { crop } reverts', async () => {
      const res = await fetch(`${base}/api/image/${SHA}/source`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'original' }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, sha: SHA, source: 'original' })
      expect(JSON.parse(await readFile(stateFile(), 'utf8')).images[SHA].useOriginal).toBe(true)

      const back = await fetch(`${base}/api/image/${SHA}/source`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'crop' }),
      })
      expect((await back.json()).source).toBe('crop')
      expect(JSON.parse(await readFile(stateFile(), 'utf8')).images[SHA].useOriginal).toBe(false)
    })

    it('POST /api/image/:sha/source for unknown sha → 404', async () => {
      const res = await fetch(`${base}/api/image/${'c'.repeat(64)}/source`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'original' }),
      })
      expect(res.status).toBe(404)
    })
  })
})
