import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../../lib/index.js'
import { createContext, createLlm, imageRef, textBlocks, userMessageWithImage } from './helpers.js'

const TEXT_ROUTE = { provider: 'shenwen', model: 'deepseek-v4.1-flash' }
const ACCOUNT_ROUTE = { provider: 'deepseek-account', model: 'deepseek-flash' }

/**
 * Mount the plugin with `backend: auto` over a fake runtime.
 * @param {object} options - mount options.
 * @returns {Promise<object>} the harness.
 */
async function mountAuto(options = {}) {
  const { llm, requests, calls } = createLlm({
    'shenwen/deepseek-v4.1-flash': { image: false },
    'deepseek-account/deepseek-flash': { image: true, caption: 'An account-model caption.' },
    'vision-lite/vl-1': { image: true, caption: 'A vision-lite caption.' },
    ...options.routes,
  })
  const harness = createContext(llm, options.attachments, options.services)
  apply(harness.ctx, {
    routes: ['shenwen'],
    ...(options.vision === undefined ? {} : { vision: options.vision }),
  })
  return { ...harness, llm, requests, calls }
}

/**
 * Send one image-bearing request through the direct stream path.
 * @param {object} harness - mounted harness.
 * @returns {Promise<string>} the text the target route received.
 */
async function send(harness) {
  for await (const _chunk of harness.llm.stream({
    provider: TEXT_ROUTE.provider,
    model: TEXT_ROUTE.model,
    messages: [userMessageWithImage(imageRef(21))],
  })) {
    // drain
  }
  return textBlocks(harness.requests.at(-1).messages).join('\n')
}

test('a configuration without vision defaults to auto discovery', async (t) => {
  const h = await mountAuto()
  t.after(() => h.dispose())
  const text = await send(h)
  assert.match(text, /deepseek-flash|vision-lite|account/i)
})

test('auto prefers the profile default model when it accepts images', async (t) => {
  const h = await mountAuto({
    services: { agentDefaultModel: { currentSelection: () => ({ ...ACCOUNT_ROUTE }) } },
  })
  t.after(() => h.dispose())

  const text = await send(h)
  assert.match(text, /An account-model caption\./)
  assert.equal(h.calls.get(`${ACCOUNT_ROUTE.provider}/${ACCOUNT_ROUTE.model}`), 1)
  assert.equal(h.calls.get('vision-lite/vl-1'), undefined)
})

test('auto falls through a text-only default model to a capable candidate', async (t) => {
  const h = await mountAuto({
    services: { agentDefaultModel: { currentSelection: () => ({ provider: 'shenwen', model: 'deepseek-v4.1-flash' }) } },
  })
  t.after(() => h.dispose())

  const text = await send(h)
  assert.match(text, /An account-model caption\./)
  assert.equal(h.calls.get(`${TEXT_ROUTE.provider}/${TEXT_ROUTE.model}`), 1, 'the target route is called once')
})

test('auto honours vision.prefer before the default model', async (t) => {
  const h = await mountAuto({
    vision: { prefer: ['vision-lite/vl-1'] },
    services: { agentDefaultModel: { currentSelection: () => ({ ...ACCOUNT_ROUTE }) } },
  })
  t.after(() => h.dispose())

  const text = await send(h)
  assert.match(text, /A vision-lite caption\./)
})

test('auto skips a candidate that fails and keeps the next one', async (t) => {
  const h = await mountAuto({
    routes: {
      'deepseek-account/deepseek-flash': { image: true, finish: 'error' },
    },
    services: { agentDefaultModel: { currentSelection: () => ({ ...ACCOUNT_ROUTE }) } },
  })
  t.after(() => h.dispose())

  const text = await send(h)
  assert.match(text, /A vision-lite caption\./)
  assert.equal(h.calls.get(`${ACCOUNT_ROUTE.provider}/${ACCOUNT_ROUTE.model}`), 1)
  assert.equal(h.calls.get('vision-lite/vl-1'), 1)
})

test('auto with no capable route keeps the image and lets the harness fall back', async (t) => {
  const h = await mountAuto({
    routes: {
      'deepseek-account/deepseek-flash': { image: false },
      'vision-lite/vl-1': { image: false },
    },
  })
  t.after(() => h.dispose())

  for await (const _chunk of h.llm.stream({
    provider: TEXT_ROUTE.provider,
    model: TEXT_ROUTE.model,
    messages: [userMessageWithImage(imageRef(22))],
  })) {
    // drain
  }
  const sent = h.requests.at(-1)
  assert.equal(sent.sawImage, true)
  assert.equal(h.calls.get('vision-lite/vl-1'), undefined)
})
