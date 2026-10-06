import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { normalize } from './match.mjs'
import { pythonLaunch } from './py.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = path.resolve(__dirname, '..')
const SAM_SCRIPT = path.join(PROJECT_ROOT, 'crop_book.py')
const SAM_MODEL = path.join(PROJECT_ROOT, 'sam_vit_b_01ec64.pth')

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

async function runSamCrop(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const { cmd, pre } = pythonLaunch()
    const proc = spawn(cmd, [...pre, SAM_SCRIPT, inputPath, outputPath, SAM_MODEL], {
      cwd: PROJECT_ROOT,
      timeout: 180000,
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', d => stdout += d)
    proc.stderr.on('data', d => stderr += d)
    proc.on('error', reject)
    proc.on('close', code => {
      if (code === 0) {
        try { resolve(JSON.parse(stdout.trim())) }
        catch { reject(new Error(`SAM parse error: ${stdout}`)) }
      } else {
        reject(new Error(`SAM failed (${code}): ${stderr || stdout}`))
      }
    })
  })
}

export async function cropWhiteBg(buffer) {
  const tmpDir = path.join(PROJECT_ROOT, 'job', 'tmp')
  fs.mkdirSync(tmpDir, { recursive: true })
  const id = `${process.pid}-${crypto.randomUUID()}`
  const inputPath = path.join(tmpDir, `sam-input-${id}.jpg`)
  const outputPath = path.join(tmpDir, `sam-output-${id}.jpg`)

  try {
    await sharp(buffer).rotate().jpeg({ quality: 95 }).toFile(inputPath)

    let croppedData, croppedInfo
    if (process.env.BSI_SKIP_SAM === '1') {
      const result = await sharp(buffer)
        .rotate()
        .trim({ threshold: 150 })
        .jpeg({ quality: 90 })
        .toBuffer({ resolveWithObject: true })
      croppedData = result.data
      croppedInfo = result.info
    } else {
      try {
        await runSamCrop(inputPath, outputPath)
        if (!fs.existsSync(outputPath)) throw new Error('SAM exited without writing an output file')
        croppedData = await sharp(outputPath).jpeg({ quality: 90 }).toBuffer()
        const info = await sharp(outputPath).metadata()
        croppedInfo = { width: info.width, height: info.height }
      } catch (e) {
        console.warn(`SAM crop failed, falling back to trim: ${e.message}`)
        const result = await sharp(buffer)
          .rotate()
          .trim({ threshold: 150 })
          .jpeg({ quality: 90 })
          .toBuffer({ resolveWithObject: true })
        croppedData = result.data
        croppedInfo = result.info
      }
    }

    if (croppedInfo.width > croppedInfo.height) {
      const rotated = await sharp(croppedData).rotate(90).jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true })
      return { buffer: rotated.data, width: rotated.info.width, height: rotated.info.height }
    }
    return { buffer: croppedData, width: croppedInfo.width, height: croppedInfo.height }
  } finally {
    fs.rmSync(inputPath, { force: true })
    fs.rmSync(outputPath, { force: true })
  }
}

export async function toOriginalJpeg(buffer, { maxDimension = 2048, quality = 85 } = {}) {
  return sharp(buffer)
    .rotate()
    .resize({ width: maxDimension, height: maxDimension, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer()
}

export async function buildVariants(buffer) {
  const [card, detail] = await Promise.all([
    sharp(buffer).resize({ width: 400, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer(),
    sharp(buffer).resize({ width: 1000, withoutEnlargement: true }).webp({ quality: 80 }).toBuffer(),
  ])
  return { card, detail }
}

export function safeName(file) {
  const base = path.basename(String(file ?? '')).replace(/\.[^.]+$/, '')
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || 'book'
}

export function slugFromTitle(title, sha = '') {
  const slug = normalize(title)
    .replace(/\s+/g, '-')
    .slice(0, 60)
    .replace(/-+$/g, '')
    .replace(/-+/g, '-')
  if (!slug || !/[a-z0-9]/i.test(slug)) return `book-${(sha || '').slice(0, 8) || 'unknown'}`
  return slug
}
