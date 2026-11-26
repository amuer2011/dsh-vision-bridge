/**
 * Integration test against the real `@deepseek-ai/dsh-llm` runtime.
 *
 * It is skipped unless `@deepseek-ai/cordis` and `@deepseek-ai/dsh-llm` are
 * resolvable from this package, for example by installing them as dev
 * dependencies or by running the file from inside an installation that already
 * ships them:
 *
 *   node --test test/real-runtime.test.mjs
 *
 * The test proves the two facts the bridge relies on:
 *   1. a text-only route really does receive the harness's
 *      `[image omitted …]` placeholder instead of the image, and
 *   2. after the plugin patches the service, the same dispatch carries the
 *      caption text and no image block at all.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../lib/index.js'

let runtime = null
try {
  const [{ Context }, llm] = await Promise.all([
    import('@deepseek-ai/cordis'),
    import('@deepseek-ai/dsh-llm'),
  ])
  runtime = { Context, LlmRuntime: llm.default, LlmAdapter: llm.LlmAdapter }
} catch {
  runtime = null
}

const skip = runtime === null
  ? 'install @deepseek-ai/cordis and @deepseek-ai/dsh-llm to run the real-runtime test'
  : false

const TEXT_ROUTE = { provider: 'fake-text', model: 'deepseek-v4.1-flash' }
const VISION_ROUTE = { provider: 'fake-vision', model: 'vision-1' }

const IMAGE_REF = {
  attachmentId: `sha256:${'a'.repeat(64)}`,
  mediaType: 'image/png',
  width: 1280,
  height: 720,
  bytes: 2048,
}

const IMAGE_MESSAGE = {
  role: 'user',
  content: [
    { type: 'text', text: 'what does this screenshot show?' },
    { type: 'image', attachment: IMAGE_REF },
  ],
}

/** Adapter that records every dispatched request and answers with canned text. */
function recordingAdapter(LlmAdapter, records, vision) {
  return new (class extends LlmAdapter {
    async resolveModel(provider, model) {
      return {
        provider,
        id: model,
        name: model,
        inputModalities: vision ? ['text', 'image'] : ['text'],
        contextWindow: 65536,
        maxTokens: 4096,
      }
    }

    async *stream(options) {
      records.push(options)
      const sawImage = options.messages.some((message) => message.content.some((block) => block.type === 'image'))
      if (vision) {
        yield { type: 'text-delta', index: 0, text: sawImage ? 'Screenshot of a failing test: 3 passed, 1 failed.' : '(no image)' }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      yield { type: 'text-delta', index: 0, text: 'assistant answer' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  })()
}

/**
 * Boot the real LLM runtime with two fake routes.
 * @returns {Promise<{ ctx: object, records: object[] }>} the app and its records.
 */
async function boot() {
  const { Context, LlmRuntime, LlmAdapter } = runtime
  const records = []
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter([TEXT_ROUTE.provider], recordingAdapter(LlmAdapter, records, false))
  ctx.llm.registerAdapter([VISION_ROUTE.provider], recordingAdapter(LlmAdapter, records, true))
  return { ctx, records }
}

/**
 * Drain one request through the prepared-call path, like the agent loop does.
 * @param {object} ctx - app context.
 * @param {object} route - provider/model pair.
 * @returns {Promise<void>} settles after the stream finishes.
 */
async function dispatch(ctx, route) {
  const prepared = await ctx.llm.prepareCall({ provider: route.provider, model: route.model })
  for await (const _chunk of prepared.stream({
    provider: route.provider,
    model: route.model,
    messages: [IMAGE_MESSAGE],
  })) {
    // drain
  }
}

/**
 * @param {object[]} messages - request messages.
 * @returns {string[]} their text blocks.
 */
function texts(messages) {
  return messages.flatMap((message) => message.content.filter((block) => block.type === 'text').map((block) => block.text))
}

test('the real runtime hides images from a text-only route', { skip }, async (t) => {
  const { ctx, records } = await boot()
  t.after(() => ctx.fiber.dispose())

  await dispatch(ctx, TEXT_ROUTE)

  const dispatched = records.at(-1)
  assert.equal(dispatched.messages.some((message) => message.content.some((block) => block.type === 'image')), false)
  assert.match(texts(dispatched.messages).join('\n'), /image omitted because this model accepts text only/)
})

test('the plugin advertises image input on the real service', { skip }, async (t) => {
  const { ctx } = await boot()
  t.after(() => ctx.fiber.dispose())
  apply(ctx, { routes: ['fake-text'], vision: { backend: 'route', ...VISION_ROUTE } })

  const info = await ctx.llm.resolveModelInfo(TEXT_ROUTE.provider, TEXT_ROUTE.model)
  assert.deepEqual([...info.inputModalities], ['text', 'image'])
})

test('prepared dispatch carries the caption and never the image', { skip }, async (t) => {
  const { ctx, records } = await boot()
  t.after(() => ctx.fiber.dispose())
  apply(ctx, { routes: ['fake-text'], vision: { backend: 'route', ...VISION_ROUTE } })

  await dispatch(ctx, TEXT_ROUTE)

  const visionCall = records.find((record) => record.provider === VISION_ROUTE.provider)
  assert.ok(visionCall !== undefined, 'the vision route was called')
  assert.equal(visionCall.messages.some((message) => message.content.some((block) => block.type === 'image')), true)

  const dispatched = records.at(-1)
  assert.equal(dispatched.provider, TEXT_ROUTE.provider)
  assert.equal(dispatched.messages.some((message) => message.content.some((block) => block.type === 'image')), false)
  const delivered = texts(dispatched.messages).join('\n')
  assert.match(delivered, /\[image .*1280x720 image\/png sha256:aaaaaaaa\]/)
  assert.match(delivered, /Screenshot of a failing test: 3 passed, 1 failed\./)
})

test('direct stream dispatch is bridged too', { skip }, async (t) => {
  const { ctx, records } = await boot()
  t.after(() => ctx.fiber.dispose())
  apply(ctx, { routes: ['fake-text'], vision: { backend: 'route', ...VISION_ROUTE } })

  for await (const _chunk of ctx.llm.stream({
    provider: TEXT_ROUTE.provider,
    model: TEXT_ROUTE.model,
    messages: [IMAGE_MESSAGE],
  })) {
    // drain
  }
  assert.match(texts(records.at(-1).messages).join('\n'), /Screenshot of a failing test/)
})

test('an image-capable route is left alone', { skip }, async (t) => {
  const { ctx, records } = await boot()
  t.after(() => ctx.fiber.dispose())
  apply(ctx, { routes: ['*'], vision: { backend: 'route', ...VISION_ROUTE } })

  await dispatch(ctx, VISION_ROUTE)

  assert.equal(records.at(-1).messages.some((message) => message.content.some((block) => block.type === 'image')), true)
})
