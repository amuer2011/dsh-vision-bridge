import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'

import { apply } from '../../lib/index.js'
import { extractEndpointText, endpointTarget } from '../../lib/captions.js'
import { createContext, createLlm, imageRef, textBlocks, userMessageWithImage } from './helpers.js'

const ROUTE = { provider: 'shenwen', model: 'deepseek-v4.1-flash' }

/**
 * Start a local OpenAI-compatible stub.
 * @param {(body: any) => { status?: number, payload: any }} respond - reply builder.
 * @returns {Promise<{ baseURL: string, requests: any[], close: () => Promise<void> }>} the stub.
 */
async function stubServer(respond) {
  const requests = []
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      requests.push({ url: request.url, headers: request.headers, body })
      const { status = 200, payload } = respond(body)
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/**
 * Mount the bridge with the endpoint backend over a fake runtime.
 * @param {object} options - mount options.
 * @returns {object} the harness.
 */
function mount({ baseURL, api = 'chat-completions', apiKey = 'test-key', onError = 'keep' }) {
  const { llm, requests } = createLlm({
    'shenwen/deepseek-v4.1-flash': { image: false },
  })
  const attachments = {
    async readImageRequest(ref, target) {
      return {
        variantId: 'variant',
        attachment: ref,
        data: Buffer.from('normalized-image-bytes'),
        mediaType: 'image/webp',
        bytes: 22,
        width: target.width,
        height: target.height,
      }
    },
  }
  const harness = createContext(llm, attachments)
  apply(harness.ctx, {
    routes: ['shenwen'],
    onError,
    vision: { backend: 'endpoint', baseURL, model: 'stub-vl', api, apiKey },
  })
  return { ...harness, llm, requests }
}

test('endpoint backend posts a data URL and uses the reply as the caption', async (t) => {
  const server = await stubServer(() => ({
    payload: { choices: [{ message: { role: 'assistant', content: 'A blue login form.' } }] },
  }))
  t.after(() => server.close())
  const h = mount({ baseURL: server.baseURL })
  t.after(() => h.dispose())

  for await (const _chunk of h.llm.stream({
    provider: ROUTE.provider,
    model: ROUTE.model,
    messages: [userMessageWithImage(imageRef(11))],
  })) {
    // drain
  }

  assert.equal(server.requests.length, 1)
  const sent = server.requests[0]
  assert.equal(sent.url, '/v1/chat/completions')
  assert.equal(sent.headers.authorization, 'Bearer test-key')
  assert.equal(sent.body.model, 'stub-vl')
  const imagePart = sent.body.messages[0].content.find((part) => part.type === 'image_url')
  assert.match(imagePart.image_url.url, /^data:image\/webp;base64,/)
  assert.equal(imagePart.image_url.url, 'data:image/webp;base64,bm9ybWFsaXplZC1pbWFnZS1ieXRlcw==')

  const delivered = h.requests.at(-1)
  assert.equal(delivered.sawImage, false)
  assert.match(textBlocks(delivered.messages).join('\n'), /A blue login form\./)
})

test('endpoint backend supports the responses API shape', async (t) => {
  const server = await stubServer(() => ({
    payload: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'A stacked diff.' }] }] },
  }))
  t.after(() => server.close())
  const h = mount({ baseURL: server.baseURL, api: 'responses' })
  t.after(() => h.dispose())

  for await (const _chunk of h.llm.stream({
    provider: ROUTE.provider,
    model: ROUTE.model,
    messages: [userMessageWithImage(imageRef(12))],
  })) {
    // drain
  }

  assert.equal(server.requests[0].url, '/v1/responses')
  assert.equal(server.requests[0].body.input[0].content[0].type, 'input_image')
  assert.match(textBlocks(h.requests.at(-1).messages).join('\n'), /A stacked diff\./)
})

test('endpoint failures keep the image block by default', async (t) => {
  const server = await stubServer(() => ({ status: 401, payload: { error: { message: 'bad key' } } }))
  t.after(() => server.close())
  const h = mount({ baseURL: server.baseURL })
  t.after(() => h.dispose())

  for await (const _chunk of h.llm.stream({
    provider: ROUTE.provider,
    model: ROUTE.model,
    messages: [userMessageWithImage(imageRef(13))],
  })) {
    // drain
  }
  assert.equal(h.requests.at(-1).sawImage, true)
})

test('endpoint failures surface as a note under onError: note', async (t) => {
  const server = await stubServer(() => ({ status: 500, payload: { error: { message: 'boom' } } }))
  t.after(() => server.close())
  const h = mount({ baseURL: server.baseURL, onError: 'note' })
  t.after(() => h.dispose())

  for await (const _chunk of h.llm.stream({
    provider: ROUTE.provider,
    model: ROUTE.model,
    messages: [userMessageWithImage(imageRef(14))],
  })) {
    // drain
  }
  const delivered = h.requests.at(-1)
  assert.equal(delivered.sawImage, false)
  assert.match(textBlocks(delivered.messages).join('\n'), /answered 500/)
})

test('extractEndpointText reads chat, responses and legacy shapes', () => {
  assert.equal(extractEndpointText({ choices: [{ message: { content: 'a' } }] }), 'a')
  assert.equal(extractEndpointText({ choices: [{ message: { content: [{ type: 'text', text: 'b' }] } }] }), 'b')
  assert.equal(extractEndpointText({ output_text: 'c' }), 'c')
  assert.equal(extractEndpointText({ output: [{ content: [{ text: 'd' }] }] }), 'd')
  assert.equal(extractEndpointText(null), '')
  assert.equal(extractEndpointText({}), '')
})

test('endpointTarget bounds the long edge without upscaling', () => {
  assert.deepEqual(endpointTarget(4500, 1000), { width: 1568, height: 348, maxBytes: 1_500_000 })
  assert.deepEqual(endpointTarget(640, 480), { width: 640, height: 480, maxBytes: 1_500_000 })
})
