import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  Progress,
  attachConsoleRenderer,
  formatDuration,
  getProgress,
  resetProgress,
  startProgress,
  endProgress,
  phaseLabel,
  PHASE_LABELS,
} from '../src/progress.mjs'

function clock(start = 0) {
  let t = start
  return {
    now: () => t,
    advance(ms) {
      t += ms
    },
  }
}

afterEach(() => {
  resetProgress()
})

describe('progress phases', () => {
  it('starts with an indeterminate bar when total is 0', () => {
    const p = new Progress({ phase: 'discover' })
    const snap = p.snapshot()
    expect(snap.phase).toBe('discover')
    expect(snap.phaseLabel).toBe('Scanning folder')
    expect(snap.total).toBe(0)
    expect(snap.current).toBe(0)
    expect(snap.fraction).toBeNull()
    expect(snap.done).toBe(false)
  })

  it('reports fraction for the active phase', () => {
    const p = new Progress({ phase: 'crop', total: 4 })
    p.step()
    p.step()
    expect(p.snapshot().fraction).toBe(0.5)
    p.start('crop', { total: 4 })
    p.step()
    expect(p.snapshot().fraction).toBe(0.75)
  })

  it('keeps separate counters per phase while computing overall progress', () => {
    const p = new Progress()
    p.schedule([
      { phase: 'crop', total: 2 },
      { phase: 'ocr', total: 2 },
      { phase: 'match', total: 1 },
    ])
    p.start('crop', { total: 2 })
    p.step()
    p.step()
    p.start('ocr', { total: 2 })
    p.step()
    const snap = p.snapshot()
    expect(snap.phase).toBe('ocr')
    expect(snap.current).toBe(1)
    expect(snap.total).toBe(2)
    expect(snap.overallFraction).toBeCloseTo(0.6, 5)
  })

  it('counts succeeded and failed units', () => {
    const p = new Progress({ phase: 'ocr', total: 3 })
    p.step()
    p.step({ ok: false })
    const snap = p.snapshot()
    expect(snap.succeeded).toBe(1)
    expect(snap.failed).toBe(1)
    expect(snap.current).toBe(2)
  })

  it('advance() moves the bar without counting success or failure', () => {
    const p = new Progress({ phase: 'match', total: 5 })
    p.advance()
    expect(p.snapshot().current).toBe(1)
    expect(p.snapshot().succeeded).toBe(0)
    expect(p.snapshot().failed).toBe(0)
  })

  it('setPlanTotal grows the overall denominator later in the run', () => {
    const p = new Progress({ phase: 'crop', total: 2 })
    p.step()
    p.step()
    expect(p.snapshot().overallFraction).toBe(1)
    p.setPlanTotal('match', 2)
    expect(p.snapshot().overallFraction).toBe(0.5)
  })
})

describe('progress eta and timing', () => {
  it('estimates remaining time from the observed rate of the active phase', () => {
    const c = clock(1000)
    const p = new Progress({ phase: 'ocr', total: 4, now: c.now })
    p.step()
    expect(p.snapshot().etaMs).toBeNull()
    c.advance(1000)
    p.step()
    const snap = p.snapshot()
    expect(snap.current).toBe(2)
    expect(snap.etaMs).toBe(1000)
    expect(snap.elapsedMs).toBe(1000)
  })

  it('clears the eta and pins the fraction at 1 when finished', () => {
    const c = clock()
    const p = new Progress({ phase: 'crop', total: 10, now: c.now })
    c.advance(500)
    p.step()
    p.finish('2 ok')
    const snap = p.snapshot()
    expect(snap.done).toBe(true)
    expect(snap.fraction).toBe(1)
    expect(snap.overallFraction).toBe(1)
    expect(snap.etaMs).toBeNull()
    expect(snap.summary).toBe('2 ok')
  })

  it('does not re-finish an already finished tracker', () => {
    const p = new Progress({ phase: 'crop', total: 1 })
    p.step()
    p.finish('first')
    p.finish('second')
    expect(p.snapshot().summary).toBe('first')
  })
})

describe('progress events', () => {
  it('keeps an event log and emits log events', () => {
    const p = new Progress({ phase: 'commit', total: 1 })
    const seen = []
    p.on('log', (entry) => seen.push(entry))
    p.log('committed "Dune" → p1')
    p.log('commit failed for "X": timeout', { level: 'error' })
    expect(seen.map((e) => e.level)).toEqual(['info', 'error'])
    expect(p.snapshot().events).toHaveLength(2)
  })

  it('caps the event log at 40 entries', () => {
    const p = new Progress({ phase: 'commit', total: 100 })
    for (let i = 0; i < 60; i++) p.log(`event ${i}`)
    const events = p.snapshot().events
    expect(events).toHaveLength(40)
    expect(events[events.length - 1].message).toBe('event 59')
  })
})

describe('singleton progress state', () => {
  it('exposes the active snapshot through getProgress and ends on demand', () => {
    expect(getProgress()).toBeNull()
    const p = startProgress({ phase: 'commit', total: 2 })
    expect(getProgress().phase).toBe('commit')
    expect(getProgress().done).toBe(false)
    endProgress(p, '2/2 committed')
    expect(getProgress().done).toBe(true)
    expect(getProgress().summary).toBe('2/2 committed')
  })

  it('keeps the finished snapshot until a new run replaces it', () => {
    const first = startProgress({ phase: 'commit', total: 1 })
    endProgress(first, '1/1 committed')
    const second = startProgress({ phase: 'crop', total: 3 })
    const snap = getProgress()
    expect(snap.id).toBe(second.id)
    expect(snap.phase).toBe('crop')
  })

  it('falls back to the console for log lines when no renderer is attached', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const p = startProgress({ phase: 'commit', total: 1 })
      p.log('committed "Dune" → p1')
      p.log('boom', { level: 'error' })
      expect(log).toHaveBeenCalledWith('committed "Dune" → p1')
      expect(err).toHaveBeenCalledWith('boom')
    } finally {
      log.mockRestore()
      err.mockRestore()
    }
  })
})

describe('console renderer', () => {
  function fakeStream(isTTY) {
    const chunks = []
    return { isTTY, write: (s) => chunks.push(s), text: () => chunks.join('') }
  }

  it('writes plain progress lines when the stream is not a TTY', () => {
    const stream = fakeStream(false)
    const p = startProgress({ phase: 'ocr', total: 4 })
    const detach = attachConsoleRenderer({ stream })
    try {
      p.step()
      p.step()
      const out = stream.text()
      expect(out).toContain('Reading cover with LLM')
      expect(out).toContain('2/4')
      expect(out).toContain('50%')
      expect(out).not.toContain('\x1b')
    } finally {
      detach()
    }
  })

  it('uses cursor movement and block characters on a TTY', () => {
    const stream = fakeStream(true)
    const p = startProgress({ phase: 'crop', total: 2, label: 'scans' })
    const detach = attachConsoleRenderer({ stream })
    try {
      p.setMessage('alpha-front.jpg')
      p.step()
      const out = stream.text()
      expect(out).toContain('\x1b[')
      expect(out).toContain('█')
      expect(out).toContain('alpha-front.jpg')
      expect(out).toContain('scans')
    } finally {
      detach()
    }
  })

  it('lets log lines through the renderer without leaving the bar on screen', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const stream = fakeStream(true)
    const p = startProgress({ phase: 'commit', total: 1 })
    const detach = attachConsoleRenderer({ stream })
    try {
      p.step()
      p.log('committed "Dune" → p1')
      expect(log).toHaveBeenCalledWith('committed "Dune" → p1')
      expect(stream.text()).toContain('\x1b[1A')
    } finally {
      detach()
      log.mockRestore()
    }
  })
})

describe('labels and formatting', () => {
  it('labels the known phases and passes unknown ones through', () => {
    expect(phaseLabel('ocr')).toBe(PHASE_LABELS.ocr)
    expect(phaseLabel('commit')).toBe('Committing to database')
    expect(phaseLabel('something-else')).toBe('something-else')
  })

  it('formats durations for the stats line', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(45_000)).toBe('45s')
    expect(formatDuration(130_000)).toBe('2m 10s')
    expect(formatDuration(3_720_000)).toBe('1h 2m')
    expect(formatDuration(null)).toBe('')
  })
})