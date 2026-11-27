import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../../lib/index.js'
import { createContext, createLlm, imageRef, textBlocks, userMessageWithImage } from './helpers.js'

const ROUTE = { provider: 'shenwen', model: 'deepseek-v4.1-flash' }
const VISION = { provider: 'deepseek-account', model: 'deepseek-flash' }

/**
 * A desktop profile can resolve one `llm` instance in the API controller's
 * realm and another inside an agent preset's isolated realm. The plugin must
 * patch both, otherwise admission passes while the agent's dispatch still
 * projects the text-only placeholder.
 */
test('patches the llm instance an agent dispatches through', async (t) => {
  const root = createLlm({
    'shenwen/deepseek-v4.1-flash': { image: false },
    'deepseek-account/deepseek-flash': { image: true, caption: 'an agent-realm caption' },
  })
  const scoped = createLlm({
    'shenwen/deepseek-v4.1-flash': { image: false },
    'deepseek-account/deepseek-flash': { image: true, caption: 'an agent-realm caption' },
  })
  const harness = createContext(root.llm)
  apply(harness.ctx, {
    routes: ['shenwen'],
    vision: { ...VISION },
  })
  t.after(() => harness.dispose())

  // Before any agent exists the scoped instance is untouched.
  for await (const _chunk of scoped.llm.stream({
    provider: ROUTE.provider,
    model: ROUTE.model,
    messages: [userMessageWithImage(imageRef(41))],
  })) {
    // drain
  }
  assert.equal(scoped.requests.at(-1).sawImage, true, 'unpatched instance keeps the image')

  harness.emit('agent/created', { agent: { ctx: { get: (name) => (name === 'llm' ? scoped.llm : undefined) } } })

  for await (const _chunk of scoped.llm.stream({
    provider: ROUTE.provider,
    model: ROUTE.model,
    messages: [userMessageWithImage(imageRef(42))],
  })) {
    // drain
  }
  const sent = scoped.requests.at(-1)
  assert.equal(sent.sawImage, false, 'the patched instance no longer reaches the provider with an image')
  assert.match(textBlocks(sent.messages).join('\n'), /an agent-realm caption/)
})

test('a second instance keeps its own capability answers', async (t) => {
  const root = createLlm({ 'shenwen/deepseek-v4.1-flash': { image: false } })
  const scoped = createLlm({ 'shenwen/deepseek-v4.1-flash': { image: true } })
  const harness = createContext(root.llm)
  apply(harness.ctx, { routes: ['shenwen'], vision: { ...VISION } })
  t.after(() => harness.dispose())

  harness.emit('agent/created', { agent: { ctx: { get: (name) => (name === 'llm' ? scoped.llm : undefined) } } })

  const rootInfo = await root.llm.resolveModelInfo(ROUTE.provider, ROUTE.model)
  const scopedInfo = await scoped.llm.resolveModelInfo(ROUTE.provider, ROUTE.model)
  assert.deepEqual(rootInfo.inputModalities, ['text', 'image'], 'text-only route advertised')
  assert.deepEqual(scopedInfo.inputModalities, ['text', 'image'], 'already capable route unchanged')
})
