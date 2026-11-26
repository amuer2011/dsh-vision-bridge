import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../../lib/index.js'
import { createContext, createLlm, imageRef, textBlocks, userMessageWithImage } from './helpers.js'

const ROUTE = { provider: 'shenwen', model: 'deepseek-v4.1-flash' }
const VISION = { provider: 'commandcode-deepseek', model: 'vision-model' }

/**
 * @param {object} [overrides] - config overrides.
 * @returns {object} plugin config for the route backend.
 */
function config(overrides = {}) {
  return {
    routes: ['shenwen'],
    vision: { ...VISION },
    ...overrides,
  }
}

/**
 * Mount the plugin over a fake runtime.
 * @param {object} [options] - mount options.
 * @returns {Promise<object>} the mounted harness.
 */
async function mount(options = {}) {
  const { llm, requests, calls } = createLlm({
    'shenwen/deepseek-v4.1-flash': { image: false },
    'commandcode-deepseek/vision-model': { image: true, caption: 'A terminal showing a failing test.' },
    ...options.routes,
  })
  const harness = createContext(llm, options.attachments)
  apply(harness.ctx, options.config ?? config())
  return { ...harness, llm, requests, calls }
}

test('advertises image input for a bridged text-only route', async (t) => {
  const h = await mount()
  t.after(() => h.dispose())

  const info = await h.llm.resolveModelInfo(ROUTE.provider, ROUTE.model)
  assert.deepEqual(info.inputModalities, ['text', 'image'])
})

test('leaves routes outside the configured scope untouched', async (t) => {
  const h = await mount({ config: config({ routes: ['other-provider'] }) })
  t.after(() => h.dispose())

  const info = await h.llm.resolveModelInfo(ROUTE.provider, ROUTE.model)
  assert.deepEqual(info.inputModalities, ['text'])
})

test('advertiseImages: false keeps the honest capability list', async (t) => {
  const h = await mount({ config: config({ advertiseImages: false }) })
  t.after(() => h.dispose())

  const info = await h.llm.resolveModelInfo(ROUTE.provider, ROUTE.model)
  assert.deepEqual(info.inputModalities, ['text'])
})

test('replaces image blocks with the caption on the prepared-call path', async (t) => {
  const h = await mount()
  t.after(() => h.dispose())

  const prepared = await h.llm.prepareCall({
    provider: ROUTE.provider,
    model: ROUTE.model,
    messages: [userMessageWithImage(imageRef(1))],
  })
  const chunks = []
  for await (const chunk of prepared.stream({
    provider: ROUTE.provider,
    model: ROUTE.model,
    messages: [userMessageWithImage(imageRef(1))],
  })) chunks.push(chunk)

  const sent = h.requests.at(-1)
  assert.equal(sent.model, ROUTE.model)
  assert.equal(sent.sawImage, false, 'the text-only route must never receive an image block')
  const text = textBlocks(sent.messages).join('\n')
  assert.match(text, /A terminal showing a failing test\./)
  assert.match(text, /\[image .*1280x720 image\/png sha256:/)
  assert.equal(chunks.at(-1).type, 'finish')
})

test('replaces image blocks on the direct stream path', async (t) => {
  const h = await mount()
  t.after(() => h.dispose())

  for await (const _chunk of h.llm.stream({
    provider: ROUTE.provider,
    model: ROUTE.model,
    messages: [userMessageWithImage(imageRef(2))],
  })) {
    // drain
  }
  const sent = h.requests.at(-1)
  assert.equal(sent.sawImage, false)
  assert.match(textBlocks(sent.messages).join('\n'), /A terminal showing a failing test\./)
})

test('captions each image once and reuses the cache', async (t) => {
  const h = await mount()
  t.after(() => h.dispose())

  const ref = imageRef(3)
  const request = () => ({
    provider: ROUTE.provider,
    model: ROUTE.model,
    messages: [userMessageWithImage(ref)],
  })
  for (let index = 0; index < 3; index += 1) {
    for await (const _chunk of h.llm.stream(request())) {
      // drain
    }
  }
  assert.equal(h.calls.get(`${VISION.provider}/${VISION.model}`), 1, 'the vision route is called once')
  assert.equal(h.calls.get(`${ROUTE.provider}/${ROUTE.model}`), 3)
})

test('concurrent requests for the same image share one caption call', async (t) => {
  const h = await mount()
  t.after(() => h.dispose())

  const ref = imageRef(4)
  const request = () => ({
    provider: ROUTE.provider,
    model: ROUTE.model,
    messages: [userMessageWithImage(ref)],
  })
  await Promise.all([
    (async () => { for await (const _c of h.llm.stream(request())) {} })(),
    (async () => { for await (const _c of h.llm.stream(request())) {} })(),
  ])
  assert.equal(h.calls.get(`${VISION.provider}/${VISION.model}`), 1)
})

test('image-capable routes are never rewritten', async (t) => {
  const h = await mount({
    routes: { 'shenwen/deepseek-v4.1-flash': { image: true } },
  })
  t.after(() => h.dispose())

  for await (const _chunk of h.llm.stream({
    provider: ROUTE.provider,
    model: ROUTE.model,
    messages: [userMessageWithImage(imageRef(5))],
  })) {
    // drain
  }
  const sent = h.requests.at(-1)
  assert.equal(sent.sawImage, true, 'an image-capable route keeps its image blocks')
})

test('a failing caption keeps the image block under onError: keep', async (t) => {
  const h = await mount({
    routes: { 'commandcode-deepseek/vision-model': { image: true, finish: 'error' } },
  })
  t.after(() => h.dispose())

  for await (const _chunk of h.llm.stream({
    provider: ROUTE.provider,
    model: ROUTE.model,
    messages: [userMessageWithImage(imageRef(6))],
  })) {
    // drain
  }
  const sent = h.requests.at(-1)
  assert.equal(sent.sawImage, true, 'the harness fallback (placeholder text) stays in charge')
})

test('a failing caption produces an explanatory note under onError: note', async (t) => {
  const h = await mount({
    routes: { 'commandcode-deepseek/vision-model': { image: true, finish: 'error' } },
    config: config({ onError: 'note' }),
  })
  t.after(() => h.dispose())

  for await (const _chunk of h.llm.stream({
    provider: ROUTE.provider,
    model: ROUTE.model,
    messages: [userMessageWithImage(imageRef(7))],
  })) {
    // drain
  }
  const sent = h.requests.at(-1)
  assert.equal(sent.sawImage, false)
  const text = textBlocks(sent.messages).join('\n')
  assert.match(text, /could not describe this image/)
  assert.match(text, /fake vision failure/)
})

test('restores the patched service on unload', async (t) => {
  const h = await mount()
  const patched = h.llm.stream
  h.dispose()
  assert.notEqual(h.llm.stream, patched)
  const info = await h.llm.resolveModelInfo(ROUTE.provider, ROUTE.model)
  assert.deepEqual(info.inputModalities, ['text'])
})

test('bridges images that arrive inside tool results', async (t) => {
  const h = await mount()
  t.after(() => h.dispose())

  const toolMessage = {
    role: 'tool',
    toolCallId: 'call-1',
    content: [
      { type: 'text', text: 'read_image result' },
      { type: 'image', attachment: imageRef(8) },
    ],
  }
  for await (const _chunk of h.llm.stream({
    provider: ROUTE.provider,
    model: ROUTE.model,
    messages: [toolMessage],
  })) {
    // drain
  }
  const sent = h.requests.at(-1)
  assert.equal(sent.sawImage, false)
  assert.match(textBlocks(sent.messages).join('\n'), /A terminal showing a failing test\./)
})

test('leaves requests without images completely untouched', async (t) => {
  const h = await mount()
  t.after(() => h.dispose())

  const plain = { role: 'user', content: [{ type: 'text', text: 'no image here' }] }
  for await (const _chunk of h.llm.stream({
    provider: ROUTE.provider,
    model: ROUTE.model,
    messages: [plain],
  })) {
    // drain
  }
  assert.equal(h.calls.get(`${VISION.provider}/${VISION.model}`), undefined, 'the vision route is never called')
})

test('rejects an incomplete vision configuration instead of crashing', () => {
  const { llm } = createLlm({})
  const { ctx, logs } = createContext(llm)
  apply(ctx, { vision: { backend: 'route' } })
  assert.ok(logs.some(([level, args]) => level === 'warn' && String(args[1]).includes('needs vision.provider')))
})
