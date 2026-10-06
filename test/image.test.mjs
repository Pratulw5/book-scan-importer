import { describe, it, expect } from 'vitest'
import sharp from 'sharp'

process.env.BSI_SKIP_SAM = '1'

const { cropWhiteBg, buildVariants, safeName, slugFromTitle } = await import('../src/image.mjs')

async function makeScan(width, height, rect) {
  const white = sharp({
    create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
  const rectBuf = await sharp({
    create: { width: rect.w, height: rect.h, channels: 3, background: { r: 40, g: 40, b: 40 } },
  })
    .png()
    .toBuffer()
  return white.composite([{ input: rectBuf, top: rect.top, left: rect.left }]).jpeg({ quality: 95 }).toBuffer()
}

describe('cropWhiteBg', () => {
  it('trims white borders and stays portrait for a portrait scan', async () => {
    const buf = await makeScan(800, 1200, { w: 600, h: 900, top: 150, left: 100 })
    const { buffer, width, height } = await cropWhiteBg(buf)
    expect(width).toBeGreaterThanOrEqual(580)
    expect(width).toBeLessThanOrEqual(620)
    expect(height).toBeGreaterThanOrEqual(880)
    expect(height).toBeLessThanOrEqual(920)
    expect(height).toBeGreaterThanOrEqual(width)
    const meta = await sharp(buffer).metadata()
    expect(meta.format).toBe('jpeg')
  })

  it('rotates a landscape scan into portrait', async () => {
    const buf = await makeScan(1200, 800, { w: 900, h: 600, top: 100, left: 150 })
    const { width, height } = await cropWhiteBg(buf)
    expect(height).toBeGreaterThan(width)
    expect(width).toBeGreaterThanOrEqual(575)
    expect(width).toBeLessThanOrEqual(625)
    expect(height).toBeGreaterThanOrEqual(875)
    expect(height).toBeLessThanOrEqual(925)
  })

  it('applies EXIF orientation before trimming', async () => {
    const upright = await makeScan(600, 900, { w: 400, h: 600, top: 150, left: 100 })
    const withExif = await sharp(upright)
      .rotate(90, { angle: 90 })
      .withMetadata({ orient: 6 })
      .jpeg({ quality: 95 })
      .toBuffer()
    const { width, height } = await cropWhiteBg(withExif)
    expect(height).toBeGreaterThan(width)
  })
})

describe('buildVariants', () => {
  it('returns 400px card and 1000px detail webp buffers', async () => {
    const buf = await makeScan(1400, 2000, { w: 1200, h: 1600, top: 200, left: 100 })
    const { buffer } = await cropWhiteBg(buf)
    const { card, detail } = await buildVariants(buffer)
    const cardMeta = await sharp(card).metadata()
    const detailMeta = await sharp(detail).metadata()
    expect(cardMeta.format).toBe('webp')
    expect(cardMeta.width).toBe(400)
    expect(detailMeta.format).toBe('webp')
    expect(detailMeta.width).toBe(1000)
  })

  it('does not enlarge small inputs', async () => {
    const buf = await makeScan(300, 400, { w: 200, h: 300, top: 50, left: 50 })
    const { buffer } = await cropWhiteBg(buf)
    const { card, detail } = await buildVariants(buffer)
    const cardMeta = await sharp(card).metadata()
    const detailMeta = await sharp(detail).metadata()
    expect(cardMeta.width).toBeLessThanOrEqual(200)
    expect(detailMeta.width).toBeLessThanOrEqual(200)
  })
})

describe('safeName', () => {
  it('strips extension and replaces unsafe characters', () => {
    expect(safeName('my book (2nd ed).jpg')).toBe('my-book-2nd-ed')
    expect(safeName('/x/y/Hello World (1).JPG')).toBe('Hello-World-1')
    expect(safeName('plain')).toBe('plain')
  })
  it('falls back for empty results', () => {
    expect(safeName('///.jpg')).toBe('book')
    expect(safeName('!!!')).toBe('book')
  })
})

describe('slugFromTitle', () => {
  it('lowercases and dashes spaces', () => {
    expect(slugFromTitle('The Great Book')).toBe('the-great-book')
  })
  it('truncates to 60 chars without trailing dash', () => {
    const long = 'a '.repeat(40).trim() + 'title'
    const slug = slugFromTitle(long)
    expect(slug.length).toBeLessThanOrEqual(60)
    expect(slug.endsWith('-')).toBe(false)
  })
  it('falls back to book-<sha8> for empty titles', () => {
    expect(slugFromTitle('', 'abcdef1234567890')).toBe('book-abcdef12')
    expect(slugFromTitle('!!!')).toBe('book-unknown')
  })
})
