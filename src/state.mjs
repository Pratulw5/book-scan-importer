import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROGRAM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_JOB_DIR = path.join(PROGRAM_ROOT, 'job')

export function emptyState() {
  return { folder: '', dryRun: false, updatedAt: new Date().toISOString(), images: {}, books: {} }
}

export class JobState {
  constructor(jobDir = DEFAULT_JOB_DIR) {
    this.jobDir = jobDir
    this.state = emptyState()
  }

  get stateFile() {
    return path.join(this.jobDir, 'state.json')
  }

  get folder() {
    return this.state.folder
  }

  set folder(v) {
    this.state.folder = v
  }

  get dryRun() {
    return this.state.dryRun
  }

  set dryRun(v) {
    this.state.dryRun = !!v
  }

  get stateData() {
    return this.state
  }

  get images() {
    return this.state.images
  }

  get books() {
    return this.state.books
  }

  load() {
    if (fs.existsSync(this.stateFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
        this.state = {
          ...emptyState(),
          ...raw,
          images: raw.images && typeof raw.images === 'object' ? raw.images : {},
          books: raw.books && typeof raw.books === 'object' ? raw.books : {},
        }
      } catch (e) {
        console.error(`state.json is corrupt (${e.message}); starting fresh`)
        this.state = emptyState()
      }
    } else {
      this.state = emptyState()
    }
    return this
  }

  save() {
    fs.mkdirSync(this.jobDir, { recursive: true })
    this.state.updatedAt = new Date().toISOString()
    const tmp = `${this.stateFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2))
    fs.renameSync(tmp, this.stateFile)
    return this.stateFile
  }

  reset(folder = '', dryRun = false) {
    this.state = emptyState()
    this.state.folder = folder
    this.state.dryRun = !!dryRun
    return this
  }

  getImage(sha) {
    return this.state.images[sha] ?? null
  }

  addImage(sha, fields = {}) {
    const existing = this.state.images[sha]
    this.state.images[sha] = {
      sha,
      file: '',
      path: '',
      status: 'pending',
      error: null,
      dims: null,
      barcode: null,
      ocr: null,
      productId: null,
      matchMethod: null,
      useOriginal: false,
      ...(existing ?? {}),
      ...fields,
    }
    return this.state.images[sha]
  }

  setImage(sha, fields = {}) {
    if (!this.state.images[sha]) this.addImage(sha, { file: fields.file ?? '', path: fields.path ?? '' })
    Object.assign(this.state.images[sha], fields)
    return this.state.images[sha]
  }

  getBook(key) {
    return this.state.books[key] ?? null
  }

  setBook(key, fields = {}) {
    const defaults = {
      key,
      sortIndex: 0,
      title: '',
      author: '',
      isbn: '',
      price: null,
      priceText: '',
      blurb: '',
      front: null,
      back: null,
      productId: null,
      shopCode: '',
      matchMethod: null,
      barcodePresent: false,
      status: 'needs_review',
      dismissed: false,
      score: 0,
      matchReason: '',
      candidates: [],
      chosenProductId: null,
      createdProductId: null,
      commitError: null,
      urls: null,
    }
    this.state.books[key] = { ...defaults, ...(this.state.books[key] ?? {}), ...fields }
    return this.state.books[key]
  }

  imageCount(byStatus) {
    const counts = {}
    for (const img of Object.values(this.state.images)) {
      counts[img.status] = (counts[img.status] ?? 0) + 1
    }
    return byStatus ? counts[byStatus] ?? 0 : counts
  }

  bookCount(byStatus) {
    const counts = {}
    for (const book of Object.values(this.state.books)) {
      counts[book.status] = (counts[book.status] ?? 0) + 1
    }
    return byStatus ? counts[byStatus] ?? 0 : counts
  }
}
