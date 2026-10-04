import crypto from 'node:crypto'
import path from 'node:path'
import sharp from 'sharp'
import { normalize } from './match.mjs'

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

export async function cropWhiteBg(buffer) {
  let { data, info } = await sharp(buffer)
    .rotate()
    .trim({ threshold: 12 })
    .jpeg({ quality: 90 })
    .toBuffer({ resolveWithObject: true })
  if (info.width > info.height) {
    const rotated = await sharp(data).rotate(90).jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true })
    return { buffer: rotated.data, width: rotated.info.width, height: rotated.info.height }
  }
  return { buffer: data, width: info.width, height: info.height }
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
