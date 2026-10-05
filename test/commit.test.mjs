import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { JobState } from '../src/state.mjs'
import { endProgress, getProgress, resetProgress, startProgress } from '../src/progress.mjs'

vi.mock('../src/db.mjs', () => ({
  commitBook: vi.fn(async () => ({ images: ['a'], thumbnails: ['b'] })),
  createProduct: vi.fn(async () => 'new-id'),
}))

vi.mock('../src/r2.mjs', () => ({
  putIfMissing: vi.fn(async () => {}),
  publicUrl: (key) => `https://r2.test/${key}`,
}))

vi.mock('../src/image.mjs', () => ({
  buildVariants: vi.fn(async () => ({ card: Buffer.from('card'), detail: Buffer.from('detail') })),
  safeName: (file) => String(file).replace(/\.[^.]+$/, ''),
  slugFromTitle: (title) => String(title || 'book').toLowerCase().replace(/\s+/g, '-'),
}))

const { commitConfirmed } = await import('../src/commit.mjs')
const { commitBook } = await import('../src/db.mjs')
const { putIfMissing } = await import('../src/r2.mjs')

const FRONT_SHA = 'a'.repeat(64)
const BACK_SHA = 'b'.repeat(64)
const SECOND_FRONT_SHA = 'c'.repeat(64)

async function makeState(jobDir) {
  const cropsDir = path.join(jobDir, 'crops')
  await mkdir(cropsDir, { recursive: true })
  for (const sha of [FRONT_SHA, BACK_SHA, SECOND_FRONT_SHA]) {
    await writeFile(path.join(cropsDir, `${sha}.jpg`), Buffer.from([0xff, 0xd8, 0xff]))
  }
  const state = new JobState(jobDir)
  state.reset('/tmp/books', false)
  state.addImage(FRONT_SHA, { file: 'dune-front.jpg', path: '/tmp/books/dune-front.jpg', status: 'ocr_done' })
  state.addImage(BACK_SHA, { file: 'dune-back.jpg', path: '/tmp/books/dune-back.jpg', status: 'ocr_done' })
  state.addImage(SECOND_FRONT_SHA, { file: 'neuromancer-front.jpg', path: '/tmp/books/neuromancer-front.jpg', status: 'ocr_done' })
  state.setBook('dune', {
    sortIndex: 0,
    title: 'Dune',
    front: FRONT_SHA,
    back: BACK_SHA,
    status: 'matched',
    chosenProductId: 'p-1',
  })
  state.setBook('neuromancer', {
    sortIndex: 1,
    title: 'Neuromancer',
    front: SECOND_FRONT_SHA,
    back: null,
    status: 'matched',
    chosenProductId: 'p-2',
  })
  state.setBook('skipped', { sortIndex: 2, title: 'Skipped', front: FRONT_SHA, status: 'needs_review' })
  return state
}

describe('commit.mjs progress', () => {
  let jobDir
  let log

  beforeEach(async () => {
    jobDir = await mkdtemp(path.join(tmpdir(), 'bsi-commit-test-'))
    resetProgress()
    vi.clearAllMocks()
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(async () => {
    log.mockRestore()
    vi.restoreAllMocks()
    resetProgress()
    await rm(jobDir, { recursive: true, force: true })
  })

  it('reports a commit progress bar that reaches 100% with a summary', async () => {
    const state = await makeState(jobDir)
    const snapshots = []
    const progress = startProgress({ label: 'database', phase: 'commit', total: 2 })
    progress.onUpdate((snap) => snapshots.push(snap))

    const results = await commitConfirmed({ state, progress })
    endProgress(progress, '2/2 committed')

    expect(results).toHaveLength(2)
    expect(results.every((r) => r.status === 'committed')).toBe(true)
    expect(commitBook).toHaveBeenCalledTimes(2)

    const final = getProgress()
    expect(final.phase).toBe('commit')
    expect(final.phaseLabel).toBe('Committing to database')
    expect(final.done).toBe(true)
    expect(final.fraction).toBe(1)
    expect(final.total).toBe(2)
    expect(final.current).toBe(2)
    expect(final.failed).toBe(0)
    expect(final.summary).toBe('2/2 committed')

    const midFlight = snapshots.filter((s) => !s.done)
    expect(midFlight.some((s) => s.current === 1 && s.total === 2)).toBe(true)
    expect(midFlight.some((s) => s.message.includes('Dune'))).toBe(true)
    expect(midFlight.some((s) => s.message.includes('Neuromancer'))).toBe(true)
    expect(midFlight.some((s) => s.message.includes('writing to database'))).toBe(true)
    expect(midFlight.every((s) => s.fraction === s.current / 2)).toBe(true)

    const messages = final.events.map((e) => e.message)
    expect(messages).toEqual([
      'committed "Dune" → p-1 (front + back)',
      'committed "Neuromancer" → p-2 (front +)',
    ])
  })

  it('keeps the bar moving and records errors when a book fails to commit', async () => {
    const state = await makeState(jobDir)
    commitBook.mockImplementationOnce(async () => {
      throw new Error('product p-1 not found')
    })

    const results = await commitConfirmed({ state })
    expect(results[0]).toMatchObject({ key: 'dune', status: 'failed', error: 'product p-1 not found' })
    expect(results[1]).toMatchObject({ key: 'neuromancer', status: 'committed' })

    const final = getProgress()
    expect(final.done).toBe(true)
    expect(final.fraction).toBe(1)
    expect(final.succeeded).toBe(1)
    expect(final.failed).toBe(1)
    expect(final.summary).toBe('1/2 committed')
    expect(final.events.find((e) => e.level === 'error').message).toContain('product p-1 not found')
    expect(putIfMissing).toHaveBeenCalledTimes(6)
  })

  it('refuses to commit a dry-run job without starting progress', async () => {
    const state = await makeState(jobDir)
    state.dryRun = true
    await expect(commitConfirmed({ state })).rejects.toThrow(/dry-run/)
    expect(getProgress()).toBeNull()
  })

  it('does not finish a progress tracker passed in by the caller', async () => {
    const state = await makeState(jobDir)
    const progress = startProgress({ label: 'batch', phase: 'commit', total: 2 })
    await commitConfirmed({ state, progress })
    expect(getProgress().done).toBe(false)
    expect(getProgress().current).toBe(2)
  })
})