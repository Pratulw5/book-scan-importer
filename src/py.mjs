import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const PROJECT_ROOT = path.resolve(__dirname, '..')

export async function runPy(script, items, { timeout = 600000 } = {}) {
  if (!items || items.length === 0) return []
  const tmpDir = path.join(PROJECT_ROOT, 'job', 'tmp')
  fs.mkdirSync(tmpDir, { recursive: true })
  const id = `${process.pid}-${crypto.randomUUID()}`
  const listPath = path.join(tmpDir, `${script}-list-${id}.json`)
  const outPath = path.join(tmpDir, `${script}-out-${id}.json`)

  try {
    fs.writeFileSync(listPath, JSON.stringify({ items }))
    await new Promise((resolve, reject) => {
      const proc = spawn('python3', [path.join(PROJECT_ROOT, script), listPath, outPath], {
        cwd: PROJECT_ROOT,
        timeout,
      })
      let err = ''
      proc.stderr.on('data', (d) => { err += d })
      proc.on('error', reject)
      proc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`${script} failed (${code}): ${err.slice(-600).trim() || 'no output'}`))
      })
    })
    const out = JSON.parse(fs.readFileSync(outPath, 'utf8'))
    return out.items ?? []
  } finally {
    fs.rmSync(listPath, { force: true })
    fs.rmSync(outPath, { force: true })
  }
}
