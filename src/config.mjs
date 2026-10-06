import 'dotenv/config'

export function loadConfig({ needDb = false, needR2 = false } = {}) {
  const errors = []

  const config = {
    databaseUrl: process.env.DATABASE_URL || '',
    r2AccountId: process.env.R2_ACCOUNT_ID || '',
    r2AccessKeyId: process.env.R2_ACCESS_KEY_ID || '',
    r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    r2Bucket: process.env.R2_BUCKET || 'products',
    r2PublicUrl: process.env.R2_PUBLIC_URL || '',
    webPort: parseInt(process.env.WEB_PORT, 10) || 4173,
  }

  if (needDb && !config.databaseUrl) {
    errors.push('DATABASE_URL is required (set it in .env, see .env.example)')
  }
  if (needR2) {
    if (!config.r2AccountId) errors.push('R2_ACCOUNT_ID is required')
    if (!config.r2AccessKeyId) errors.push('R2_ACCESS_KEY_ID is required')
    if (!config.r2SecretAccessKey) errors.push('R2_SECRET_ACCESS_KEY is required')
    if (!config.r2PublicUrl) errors.push('R2_PUBLIC_URL is required')
  }
  return { ok: errors.length === 0, errors, config }
}
