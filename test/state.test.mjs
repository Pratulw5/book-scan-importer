import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JobState, emptyState } from '../src/state.mjs'

describe('JobState', () => {
  let dir

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsi-state-'))
  })

  it('loads empty state when file missing', () => {
    const s = new JobState(dir).load()
    expect(s.state.folder).toBe('')
    expect(s.state.dryRun).toBe(false)
    expect(s.state.images).toEqual({})
    expect(s.state.books).toEqual({})
    expect(typeof s.state.updatedAt).toBe('string')
  })

  it('addImage / setBook / save / load roundtrip', () => {
    const s = new JobState(dir)
    s.folder = '/tmp/scans'
    s.dryRun = true
    s.addImage('abc123', { file: 'cover.jpg', path: '/tmp/scans/cover.jpg' })
    s.setImage('abc123', {
      status: 'ocr_done',
      dims: { width: 100, height: 200 },
      ocr: { position: 'front', title: 'T', author: '', isbn: '', priceText: '', price: null, blurb: '' },
    })
    s.setBook('t', { title: 'T', sortIndex: 0, front: 'abc123', status: 'matched', score: 140 })

    s.save()

    const s2 = new JobState(dir).load()
    expect(s2.folder).toBe('/tmp/scans')
    expect(s2.dryRun).toBe(true)
    expect(s2.getImage('abc123').status).toBe('ocr_done')
    expect(s2.getImage('abc123').ocr.title).toBe('T')
    expect(s2.getBook('t').score).toBe(140)
    expect(s2.getBook('t').front).toBe('abc123')
  })

  it('preserves folder across save/load (mismatch guard input)', () => {
    const s = new JobState(dir)
    s.folder = '/abs/one'
    s.save()
    expect(new JobState(dir).load().folder).toBe('/abs/one')
  })

  it('atomic write leaves no .tmp behind and writes valid JSON', () => {
    const s = new JobState(dir)
    s.addImage('s', { file: 'a.jpg', path: '/x/a.jpg' })
    const file = s.save()
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.readdirSync(dir)).not.toContain('state.json.tmp')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toHaveProperty('images', expect.anything())
  })

  it('setBook merges into existing book keeping prior fields', () => {
    const s = new JobState(dir)
    s.setBook('k', { status: 'needs_review', chosenProductId: null, dismissed: false })
    s.setBook('k', { status: 'matched', score: 150 })
    const b = s.getBook('k')
    expect(b.status).toBe('matched')
    expect(b.score).toBe(150)
    expect(b.chosenProductId).toBeNull()
    expect(b.dismissed).toBe(false)
    expect(b.key).toBe('k')
  })

  it('addImage keeps ocr_done status on re-add', () => {
    const s = new JobState(dir)
    s.addImage('s', { file: 'a.jpg', path: '/x/a.jpg', status: 'ocr_done' })
    s.addImage('s', { file: 'a.jpg', path: '/x/a.jpg' })
    expect(s.getImage('s').status).toBe('ocr_done')
  })

  it('imageCount / bookCount tally by status', () => {
    const s = new JobState(dir)
    s.addImage('a', { file: 'a.jpg', path: '/x/a.jpg', status: 'ocr_done' })
    s.addImage('b', { file: 'b.jpg', path: '/x/b.jpg', status: 'failed' })
    s.addImage('c', { file: 'c.jpg', path: '/x/c.jpg' })
    expect(s.imageCount('ocr_done')).toBe(1)
    expect(s.imageCount('failed')).toBe(1)
    expect(s.imageCount('pending')).toBe(1)
    expect(s.imageCount()).toEqual({ ocr_done: 1, failed: 1, pending: 1 })

    s.setBook('k1', { status: 'matched' })
    s.setBook('k2', { status: 'needs_review' })
    expect(s.bookCount('matched')).toBe(1)
    expect(s.bookCount('needs_review')).toBe(1)
  })

  it('reset produces a fresh state with folder set', () => {
    const s = new JobState(dir)
    s.addImage('a', { file: 'a.jpg', path: '/x/a.jpg' })
    s.reset('/new/folder', true)
    expect(s.folder).toBe('/new/folder')
    expect(s.dryRun).toBe(true)
    expect(s.images).toEqual({})
    expect(s.books).toEqual({})
  })

  it('corrupt state.json falls back to empty state without throwing', () => {
    fs.writeFileSync(path.join(dir, 'state.json'), '{ not json')
    const s = new JobState(dir).load()
    expect(s.state).toEqual(emptyState())
  })
})
