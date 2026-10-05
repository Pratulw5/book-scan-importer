const SYSTEM_PROMPT = `You are a book cover OCR JSON API. Output exactly one valid JSON object and nothing else. No markdown. No explanations. Use empty strings for unknown fields. Required keys: position (front|back|unknown), title, author, isbn (digits only), priceText, blurb (max 2 sentences).`

const JSON_FORMATTER_PROMPT = `You convert messy OCR or image descriptions into strict JSON. Output exactly one valid JSON object and nothing else. No markdown. No explanations. Use empty strings for unknown fields. Required keys: position (front|back|unknown), title, author, isbn (digits only), priceText, blurb (max 2 sentences).`

export function extractJson(text) {
  if (typeof text !== 'string') throw new Error('LLM response is not a string')
  const start = text.indexOf('{')
  if (start === -1) throw new Error(`no JSON object in LLM response: ${text.slice(0, 200)}`)
  let depth = 0
  let inString = false
  let escaped = false
  let lastError = null
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
  const repaired = text.slice(start).trim() + '}'.repeat(Math.max(depth, 0))
  try {
    return JSON.parse(repaired)
  } catch (e) {
    lastError = e
  }
  throw new Error(`unbalanced braces in LLM response: ${text.slice(0, 200)}${lastError ? ` (${lastError.message})` : ''}`)
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

function extractFromProse(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  const title =
    s.match(/book cover for\s+["“]([^"”]+)["”]/i)?.[1] ||
    s.match(/cover of\s+["“]([^"”]+)["”]/i)?.[1] ||
    s.match(/titled\s+["“]([^"”]+)["”]/i)?.[1] ||
    s.match(/["“]([^"”]{3,120})["”]\s+by\s+([^.,;]+)/i)?.[1] ||
    ''
  const author =
    s.match(/["“][^"”]+["”]\s+by\s+([^.,;]+)/i)?.[1] ||
    s.match(/author(?: is|:)?\s+([^.,;]+)/i)?.[1] ||
    ''
  const isbn = s.match(/(?:ISBN(?:-1[03])?[:\s-]*)?(97[89][\d\s-]{10,}|[\d\s-]{9}[\dXx])/i)?.[1]
  const priceText = s.match(/(?:₹|Rs\.?|INR)\s*\d+(?:\.\d+)?/i)?.[0] || ''
  return normalizeExtract({
    position: /back cover/i.test(s) ? 'back' : /front cover|book cover/i.test(s) ? 'front' : 'unknown',
    title,
    author,
    isbn: isbn ? isbn.replace(/[\s-]/g, '') : '',
    priceText,
    blurb: s.split(/(?<=[.!?])\s+/).slice(0, 2).join(' '),
  })
}

function hasUseful(parsed) {
  return parsed && typeof parsed === 'object' && typeof parsed.title === 'string' && parsed.title.length > 0
}

function contentToText(content) {
  if (Array.isArray(content)) {
    return content.map(part => typeof part?.text === 'string' ? part.text : '').join('\n')
  }
  return content ?? ''
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

async function callOnce({ host, model, imageBuf, instruction, jsonMode = true }) {
  const h = (host || process.env.LMSTUDIO_HOST || 'http://127.0.0.1:1234').replace(/\/$/, '')
  const payload = {
    model,
    temperature: 0.0,
    max_tokens: 500,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: instruction },
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${imageBuf.toString('base64')}` },
          },
        ],
      },
    ],
  }
  if (jsonMode) payload.response_format = { type: 'json_object' }

  const res = await fetch(`${h}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    if (jsonMode && (res.status === 400 || res.status === 422)) {
      return callOnce({ host, model, imageBuf, instruction, jsonMode: false })
    }
    throw new Error(`LM Studio /v1/chat/completions HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
  const json = await res.json()
  return contentToText(json.choices?.[0]?.message?.content)
}

async function callJsonFormatter({ host, model, text, jsonMode = true }) {
  const h = (host || process.env.LMSTUDIO_HOST || 'http://127.0.0.1:1234').replace(/\/$/, '')
  const payload = {
    model,
    temperature: 0.0,
    max_tokens: 500,
    messages: [
      { role: 'system', content: JSON_FORMATTER_PROMPT },
      {
        role: 'user',
        content: `Convert this OCR/image-description text into the required JSON schema. Return only JSON.\n\nTEXT:\n${text}`,
      },
    ],
  }
  if (jsonMode) payload.response_format = { type: 'json_object' }

  const res = await fetch(`${h}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    if (jsonMode && (res.status === 400 || res.status === 422)) {
      return callJsonFormatter({ host, model, text, jsonMode: false })
    }
    throw new Error(`LM Studio JSON formatter HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
  const json = await res.json()
  return contentToText(json.choices?.[0]?.message?.content)
}

async function extractViaTextModel({ text, host, model }) {
  const formatted = await callJsonFormatter({ host, model, text })
  const parsed = extractJson(formatted)
  if (!hasUseful(parsed)) throw new Error(`JSON formatter returned unusable JSON: ${String(formatted).slice(0, 200)}`)
  return normalizeExtract(parsed)
}

export async function visionExtract({ imageBuf, model, host } = {}) {
  if (!model) throw new Error('model not specified — call listModels() first')
  let lastError
  const textModel = process.env.LMSTUDIO_TEXT_MODEL || model
  const instructions = [
    'Analyze this book cover image. Return ONLY a JSON object like {"position":"front","title":"","author":"","isbn":"","priceText":"","blurb":""}. Do not include any text outside JSON.',
    'Retry. Your previous response was invalid. Return exactly one JSON object and nothing else. If you cannot read a field, use an empty string. Do not apologize or explain.',
  ]
  for (let attempt = 0; attempt < instructions.length; attempt++) {
    try {
      const text = await callOnce({ host, model, imageBuf, instruction: instructions[attempt] })
      let parseError
      try {
        const parsed = extractJson(text)
        if (!hasUseful(parsed)) throw new Error(`LLM returned unusable JSON: ${String(text).slice(0, 200)}`)
        return normalizeExtract(parsed)
      } catch (e) {
        parseError = e
      }
      try {
        return await extractViaTextModel({ text, host, model: textModel })
      } catch (e) {
        parseError = new Error(`${parseError?.message ?? parseError}; JSON formatter failed: ${e.message}`)
      }
      try {
        const prose = extractFromProse(text)
        if (hasUseful(prose)) return prose
      } catch {
        // Fall through to the detailed parse error.
      }
      throw parseError
    } catch (e) {
      lastError = e
    }
  }
  throw new Error(`vision extraction failed: ${lastError?.message ?? lastError}`)
}
