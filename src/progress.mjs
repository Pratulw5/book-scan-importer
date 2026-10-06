import { EventEmitter } from 'node:events'

export const PHASE_LABELS = {
  discover: 'Scanning folder',
  crop: 'Analyzing image',
  ocr: 'Reading text (barcode + OCR)',
  match: 'Matching against catalog',
  commit: 'Committing to database',
}

const MAX_EVENTS = 40

export function phaseLabel(phase) {
  return PHASE_LABELS[phase] ?? String(phase ?? 'Working')
}

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return ''
  const totalSec = Math.max(0, Math.round(ms / 1000))
  if (totalSec < 60) return `${totalSec}s`
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min < 60) return `${min}m ${sec}s`
  const hr = Math.floor(min / 60)
  return `${hr}h ${min % 60}m`
}

export class Progress {
  constructor({ label = '', phase = 'discover', total = 0, now = Date.now } = {}) {
    this.id = ++Progress.seq
    this.label = label
    this.now = now
    this.active = phase
    this.message = ''
    this.plan = [{ phase, total: Math.max(0, Number(total) || 0) }]
    this.totals = { [phase]: Math.max(0, Number(total) || 0) }
    this.completed = { [phase]: 0 }
    this.firstSeen = { [phase]: this.now() }
    this.succeeded = 0
    this.failed = 0
    this.events = []
    this.done = false
    this.summary = null
    this.finishedAt = null
    this.startedAt = this.now()
    this.updatedAt = this.startedAt
    this.emitter = new EventEmitter()
    this.emitter.setMaxListeners(50)
  }

  on(type, fn) {
    this.emitter.on(type, fn)
    return this
  }

  onUpdate(fn) {
    this.emitter.on('update', fn)
    return () => this.emitter.off('update', fn)
  }

  touch() {
    this.updatedAt = this.now()
    this.emitter.emit('update', this.snapshot())
    return this
  }

  schedule(steps) {
    this.plan = steps.map((s) => ({ phase: s.phase, total: Math.max(0, Number(s.total) || 0) }))
    for (const step of this.plan) {
      this.totals[step.phase] = step.total
      if (this.completed[step.phase] == null) this.completed[step.phase] = 0
    }
    return this.touch()
  }

  setPlanTotal(phase, total) {
    const value = Math.max(0, Number(total) || 0)
    const step = this.plan.find((s) => s.phase === phase)
    if (step) step.total = value
    else this.plan.push({ phase, total: value })
    this.totals[phase] = value
    return this.touch()
  }

  start(phase, { total, message = '' } = {}) {
    if (total != null) this.setPlanTotal(phase, total)
    if (!this.plan.some((s) => s.phase === phase)) this.plan.push({ phase, total: this.totals[phase] ?? 0 })
    if (this.completed[phase] == null) this.completed[phase] = 0
    if (this.firstSeen[phase] == null) this.firstSeen[phase] = this.now()
    this.active = phase
    if (message) this.message = message
    return this.touch()
  }

  setMessage(message) {
    this.message = String(message ?? '')
    return this.touch()
  }

  advance() {
    this.completed[this.active] = (this.completed[this.active] ?? 0) + 1
    return this.touch()
  }

  step({ ok = true } = {}) {
    this.completed[this.active] = (this.completed[this.active] ?? 0) + 1
    if (ok) this.succeeded++
    else this.failed++
    return this.touch()
  }

  log(message, { level = 'info' } = {}) {
    const entry = { level, message: String(message), at: this.now() }
    this.events.push(entry)
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS)
    this.touch()
    this.emitter.emit('log', entry)
    return this
  }

  finish(summary = null) {
    if (this.done) return this
    this.done = true
    this.summary = summary
    this.finishedAt = this.now()
    return this.touch()
  }

  snapshot() {
    const end = this.finishedAt ?? this.now()
    const phase = this.active
    const current = this.completed[phase] ?? 0
    const total = this.totals[phase] ?? 0
    const overallTotal = this.plan.reduce((n, s) => n + (this.totals[s.phase] ?? s.total ?? 0), 0)
    const overallDone = this.plan.reduce((n, s) => n + (this.completed[s.phase] ?? 0), 0)
    const phaseElapsed = Math.max(0, end - (this.firstSeen[phase] ?? this.startedAt))
    const rate = current > 0 ? phaseElapsed / current : 0
    const remaining = Math.max(0, total - current)
    return {
      id: this.id,
      label: this.label,
      phase,
      phaseLabel: phaseLabel(phase),
      total,
      current,
      fraction: this.done ? 1 : total > 0 ? Math.min(1, current / total) : null,
      overallFraction: this.done ? 1 : overallTotal > 0 ? Math.min(1, overallDone / overallTotal) : null,
      message: this.message,
      done: this.done,
      succeeded: this.succeeded,
      failed: this.failed,
      elapsedMs: Math.max(0, end - this.startedAt),
      etaMs: this.done || total === 0 || current === 0 || rate === 0 ? null : Math.round(rate * remaining),
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      summary: this.summary,
      events: this.events.slice(),
    }
  }
}

Progress.seq = 0

let current = null
let sink = null

export function startProgress(options = {}) {
  const progress = new Progress(options)
  current = progress
  progress.on('log', (entry) => {
    if (sink) sink(entry)
    else if (entry.level === 'error') console.error(entry.message)
    else console.log(entry.message)
  })
  return progress
}

export function endProgress(progress, summary = null) {
  if (!progress) return null
  progress.finish(summary)
  return progress.snapshot()
}

export function getProgress() {
  return current ? current.snapshot() : null
}

export function getActiveProgress() {
  return current
}

export function resetProgress() {
  current = null
}

function buildBar(fraction, width) {
  if (fraction == null) {
    const span = 3
    const head = Math.floor(Date.now() / 140) % (width + span)
    return `${' '.repeat(head)}${'█'.repeat(span)}${' '.repeat(Math.max(0, width + span - head - span))}`.slice(0, width)
  }
  const filled = Math.round(fraction * width)
  return `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`
}

export function attachConsoleRenderer({ stream = process.stderr } = {}) {
  const useColor = Boolean(stream.isTTY) && !process.env.NO_COLOR
  const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text)
  let prevLines = 0
  let lastPlain = ''
  let bound = null
  let boundOff = null

  function clear() {
    if (prevLines === 0) return
    let out = `\x1b[${prevLines}A`
    for (let i = 0; i < prevLines; i++) out += `\x1b[2K${i < prevLines - 1 ? '\n' : ''}`
    stream.write(out)
    prevLines = 0
  }

  function render() {
    const snapshot = getProgress()
    const tracker = getActiveProgress()
    if (tracker !== bound) {
      boundOff?.()
      boundOff = tracker ? tracker.onUpdate(render) : null
      bound = tracker
    }
    if (!snapshot) {
      clear()
      return
    }
    const bar = buildBar(snapshot.fraction, 24)
    const prefix = snapshot.label
      ? paint('90', `${snapshot.label.length > 28 ? `…${snapshot.label.slice(-27)}` : snapshot.label} │ `)
      : ''
    const head = `${prefix}${paint('36', snapshot.phaseLabel.padEnd(24))} ${snapshot.done ? paint('32', bar) : paint('36', bar)}`
    const parts = []
    if (snapshot.fraction != null) parts.push(`${Math.round(snapshot.fraction * 100)}%`)
    if (snapshot.total > 0) parts.push(`${snapshot.current}/${snapshot.total}`)
    if (snapshot.failed > 0) parts.push(`${snapshot.failed} failed`)
    if (snapshot.etaMs != null) parts.push(`eta ${formatDuration(snapshot.etaMs)}`)
    const stats = parts.length ? paint('90', `  ${parts.join('  ')}`) : ''
    const line = head + stats
    const lines = [line]
    if (snapshot.message) lines.push(paint('90', `  ${snapshot.message}`))

    if (!stream.isTTY) {
      const plain = [line, snapshot.message].filter(Boolean).join('\n')
      if (plain !== lastPlain) {
        stream.write(`${plain}\n`)
        lastPlain = plain
      }
      return
    }

    let out = prevLines ? `\x1b[${prevLines}A` : ''
    out += lines.map((l) => `\x1b[2K${l}`).join('\n')
    stream.write(out)
    prevLines = lines.length
  }

  const detach = setSink((entry) => {
    clear()
    if (entry.level === 'error') console.error(entry.message)
    else console.log(entry.message)
    render()
  })
  const timer = setInterval(render, 200)
  timer.unref?.()
  render()

  return () => {
    clearInterval(timer)
    boundOff?.()
    boundOff = null
    bound = null
    detach()
    clear()
    if (stream.isTTY) stream.write('\n')
  }
}

function setSink(fn) {
  sink = fn
  return () => {
    if (sink === fn) sink = null
  }
}