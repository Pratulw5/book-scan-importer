import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3'
import { loadConfig } from './config.mjs'

let client = null

export function r2Config() {
  const { ok, errors, config } = loadConfig({ needR2: true })
  if (!ok) throw new Error(errors.join('; '))
  return config
}

export function getR2() {
  if (!client) {
    const config = r2Config()
    client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.r2AccountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.r2AccessKeyId,
        secretAccessKey: config.r2SecretAccessKey,
      },
    })
  }
  return client
}

export function r2Bucket() {
  return r2Config().r2Bucket
}

export function publicUrl(key) {
  const { r2PublicUrl } = r2Config()
  if (!r2PublicUrl) throw new Error('R2_PUBLIC_URL is not set')
  return `${r2PublicUrl.replace(/\/$/, '')}/${key}`
}

export async function ensureExists(key) {
  try {
    await getR2().send(new HeadObjectCommand({ Bucket: r2Bucket(), Key: key }))
    return true
  } catch (e) {
    if (e?.name === 'NotFound' || e?.statusCode === 404 || e?.$metadata?.httpStatusCode === 404) {
      return false
    }
    throw e
  }
}

export async function putIfMissing(key, body) {
  if (await ensureExists(key)) return false
  await getR2().send(
    new PutObjectCommand({
      Bucket: r2Bucket(),
      Key: key,
      Body: body,
      ContentType: 'image/webp',
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  )
  return true
}
