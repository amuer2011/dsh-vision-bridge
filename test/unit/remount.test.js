import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../../lib/index.js'
import { createContext, createLlm, imageRef, textBlocks, userMessageWithImage } from './helpers.js'

const ROUTE = { provider: 'commandcode-deepseek', model: 'deepseek-flash' }
const VISION = { provider: 'deepseek-account', model: 'deepseek-flash' }

/**
 * A profile update re-mounts the plugin. When the previous instance's restore
 * did not run first, the new mount sees already-patched methods; capturing
 * those as "originals" would make every route look image capable and silently
 * disable captioning.
 */
test('a second mount without a dispose still bridges images', async (t) => {
  const { llm, requests } = createLlm({
    'commandcode-deepseek/deepseek-flash': { image: false },
    'deepseek-account/deepseek-flash': { image: true, caption: 'still captioned' },
  })

  const first = createContext(llm)
  apply(first.ctx, { routes: ['commandcode-deepseek'], vision: { ...VISION } })
  t.after(() => first.dispose())

  // Simulate an HMR replace that mounts the new instance before the old one
  // was disposed: the service object is already patched.
  const second = createContext(llm)
  apply(second.ctx, { routes: ['commandcode-deepseek'], vision: { ...VISION } })
  t.after(() => second.dispose())

  for await (const _chunk of llm.stream({
    provider: ROUTE.provider,
    model: ROUTE.model,
    messages: [userMessageWithImage(imageRef(51))],
  })) {
    // drain
  }
  const sent = requests.at(-1)
  assert.equal(sent.sawImage, false, 'the image must still be replaced by its caption')
  assert.match(textBlocks(sent.messages).join('\n'), /still captioned/)
})

test('a disposed mount leaves the service usable', async (t) => {
  const { llm, requests } = createLlm({
    'commandcode-deepseek/deepseek-flash': { image: false },
    'deepseek-account/deepseek-flash': { image: true, caption: 'captioned after dispose' },
  })
  const first = createContext(llm)
  apply(first.ctx, { routes: ['commandcode-deepseek'], vision: { ...VISION } })
  first.dispose()

  const second = createContext(llm)
  apply(second.ctx, { routes: ['commandcode-deepseek'], vision: { ...VISION } })
  t.after(() => second.dispose())

  for await (const _chunk of llm.stream({
    provider: ROUTE.provider,
    model: ROUTE.model,
    messages: [userMessageWithImage(imageRef(52))],
  })) {
    // drain
  }
  assert.match(textBlocks(requests.at(-1).messages).join('\n'), /captioned after dispose/)
})
