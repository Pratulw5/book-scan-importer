import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractJson, visionExtract } from '../src/llm.mjs'

const oldFetch = global.fetch
const oldTextModel = process.env.LMSTUDIO_TEXT_MODEL

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data },
    async text() { return JSON.stringify(data) },
  }
}

afterEach(() => {
  global.fetch = oldFetch
  if (oldTextModel === undefined) delete process.env.LMSTUDIO_TEXT_MODEL
  else process.env.LMSTUDIO_TEXT_MODEL = oldTextModel
})

describe('extractJson', () => {
  it('repairs a missing closing brace', () => {
    expect(extractJson('{"title":"A Book"')).toEqual({ title: 'A Book' })
  })
})

describe('visionExtract', () => {
  it('converts prose vision output through a text model', async () => {
    process.env.LMSTUDIO_TEXT_MODEL = 'text-model'
    global.fetch = vi.fn(async (_url, opts) => {
      const body = JSON.parse(opts.body)
      if (body.messages[1].content instanceof Array) {
        return jsonResponse({
          choices: [{
            message: {
              content: 'The image is of the book cover for "Biswaimit Dwidedy" by Sonia Roy.',
            },
          }],
        })
      }
      return jsonResponse({
        choices: [{
          message: {
            content: '{"position":"front","title":"Biswaimit Dwidedy","author":"Sonia Roy","isbn":"","priceText":"","blurb":""}',
          },
        }],
      })
    })

    const result = await visionExtract({ imageBuf: Buffer.from('image'), model: 'vision-model' })

    expect(result.title).toBe('Biswaimit Dwidedy')
    expect(result.author).toBe('Sonia Roy')
    expect(global.fetch).toHaveBeenCalledTimes(2)
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).model).toBe('vision-model')
    expect(JSON.parse(global.fetch.mock.calls[1][1].body).model).toBe('text-model')
  })
})
