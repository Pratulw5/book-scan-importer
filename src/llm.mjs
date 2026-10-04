const SYSTEM_PROMPT = `You are reading a photo of a book cover (front or back) scanned on white paper.
Respond with ONLY a JSON object, no markdown fences:
{"position":"front"|"back"|"unknown","title":"","author":"","isbn":"","priceText":"","blurb":""}
Rules:
- "front" = cover shows the main title / cover art. Badges like "Bestseller" may appear on front.
- "back" = shows a blurb/description paragraph, barcodes, or an ISBN number strip.
- "title": main book title, "" if not visible. "author": author name, "" if not visible.
- "isbn": digits only (10 or 13, no dashes), "" if not visible.
- "priceText": any printed price EXACTLY as shown (e.g. "₹499"), "" if none.
- "blurb": back-cover description, at most 2 sentences, "" if none.`

export function extractJson(text) {
  if (typeof text !== 'string') throw new Error('LLM response is not a string')
  const start = text.indexOf('{')
  if (start === -1) throw new Error('no JSON object in LLM response')
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        const slice = text.slice(start, i + 1)
        return JSON.parse(slice)
      }
    }
  }
  throw new Error('unbalanced braces in LLM response')
}

function normalizeExtract(obj) {
  const str = (v) => (v == null ? '' : String(v))
  const position = str(obj.position).toLowerCase()
  return {
    position: position === 'front' || position === 'back' ? position : null,
    title: str(obj.title),
    author: str(obj.author),
    isbn: str(obj.isbn),
    priceText: str(obj.priceText),
    blurb: str(obj.blurb),
  }
}

function hasUseful(parsed) {
  return parsed && typeof parsed === 'object' && typeof parsed.title === 'string' && parsed.title.length > 0
}

export async function listModels({ host, model } = {}) {
  const h = (host || process.env.LMSTUDIO_HOST || 'http://127.0.0.1:1234').replace(/\/$/, '')
  const configured = model ?? process.env.LMSTUDIO_MODEL
  if (configured) return configured
  const res = await fetch(`${h}/v1/models`)
  if (!res.ok) throw new Error(`LM Studio /v1/models HTTP ${res.status}`)
  const json = await res.json()
  const first = json.data?.[0]?.id
  if (!first) throw new Error('LM Studio returned no models — load a vision model first')
  return first
}

async function callOnce({ host, model, imageBuf }) {
  const h = (host || process.env.LMSTUDIO_HOST || 'http://127.0.0.1:1234').replace(/\/$/, '')
  const res = await fetch(`${h}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Read this book cover photo and answer with JSON only.' },
            {
              type: 'image_url',
              image_url: { url: `data:image/jpeg;base64,${imageBuf.toString('base64')}` },
            },
          ],
        },
      ],
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`LM Studio /v1/chat/completions HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
  const json = await res.json()
  return json.choices?.[0]?.message?.content ?? ''
}

export async function visionExtract({ imageBuf, model, host } = {}) {
  if (!model) throw new Error('model not specified — call listModels() first')
  let lastError
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await callOnce({ host, model, imageBuf })
      const parsed = extractJson(text)
      if (!hasUseful(parsed)) throw new Error(`LLM returned unusable JSON: ${String(text).slice(0, 200)}`)
      return normalizeExtract(parsed)
    } catch (e) {
      lastError = e
    }
  }
  throw new Error(`vision extraction failed: ${lastError?.message ?? lastError}`)
}
