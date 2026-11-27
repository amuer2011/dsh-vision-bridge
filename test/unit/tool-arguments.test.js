import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../../lib/index.js'
import { EMPTY_TOOL_ARGUMENTS, isEmptyToolArguments, normalizeEmptyToolArguments } from '../../lib/bridge.js'
import { createContext, createLlm, imageRef, textBlocks, userMessageWithImage } from './helpers.js'

const ROUTE = { provider: 'commandcode-deepseek', model: 'deepseek-flash' }
const VISION = { provider: 'deepseek-account', model: 'deepseek-flash' }

/**
 * Mount the plugin with the tool-argument compat switch.
 * @param {object} [overrides] - config overrides.
 * @returns {object} the harness.
 */
async function mount(overrides = {}) {
  const { llm, requests, calls } = createLlm({
    'commandcode-deepseek/deepseek-flash': { image: false },
    'deepseek-account/deepseek-flash': { image: true, caption: 'a caption' },
  })
  const harness = createContext(llm)
  apply(harness.ctx, {
    routes: ['commandcode-deepseek'],
    vision: { ...VISION },
    compat: { emptyToolArguments: true },
    ...overrides,
  })
  return { ...harness, llm, requests, calls }
}

/**
 * @param {string} name - tool name.
 * @param {string} args - raw arguments.
 * @returns {object} an assistant tool-call message.
 */
function assistantCall(name, args) {
  return {
    role: 'assistant',
    source: { kind: 'model', provider: ROUTE.provider, model: ROUTE.model },
    content: [{ type: 'tool-call', id: 'call_1', name, arguments: args }],
  }
}

test('isEmptyToolArguments recognises every empty spelling', () => {
  for (const value of ['{}', ' {} ', '', 'null', '{ }', undefined, null]) {
    assert.equal(isEmptyToolArguments(value), true, `expected empty: ${String(value)}`)
  }
  for (const value of ['{"a":1}', '[]', 'not json', '{"a":{}}']) {
    assert.equal(isEmptyToolArguments(value), false, `expected non-empty: ${String(value)}`)
  }
})

test('normalizeEmptyToolArguments rewrites only empty calls', () => {
  const messages = [assistantCall('working_directory', '{}'), assistantCall('pwsh', '{"command":"ls"}')]
  const normalized = normalizeEmptyToolArguments(messages)
  assert.equal(normalized[0].content[0].arguments, EMPTY_TOOL_ARGUMENTS)
  assert.equal(normalized[1], messages[1], 'non-empty calls keep their identity')
  assert.equal(normalizeEmptyToolArguments([assistantCall('pwsh', '{"command":"ls"}')]), null)
})

test('an empty-argument history reaches the adapter with a non-empty input', async (t) => {
  const h = await mount()
  t.after(() => h.dispose())

  const messages = [assistantCall('working_directory', '{}'), { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'D:/work' }] }]
  for await (const _chunk of h.llm.stream({ provider: ROUTE.provider, model: ROUTE.model, messages })) {
    // drain
  }
  const sent = h.requests.at(-1)
  const call = sent.messages[0].content.find((block) => block.type === 'tool-call')
  assert.equal(call.arguments, EMPTY_TOOL_ARGUMENTS)
})

test('images and empty tool arguments are fixed in the same request', async (t) => {
  const h = await mount()
  t.after(() => h.dispose())

  const messages = [
    userMessageWithImage(imageRef(31)),
    assistantCall('working_directory', '{}'),
    { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'D:/work' }] },
  ]
  for await (const _chunk of h.llm.stream({ provider: ROUTE.provider, model: ROUTE.model, messages })) {
    // drain
  }
  const sent = h.requests.at(-1)
  assert.equal(sent.sawImage, false, 'the image is still bridged')
  const call = sent.messages[1].content.find((block) => block.type === 'tool-call')
  assert.equal(call.arguments, EMPTY_TOOL_ARGUMENTS)
  assert.match(textBlocks(sent.messages).join('\n'), /a caption/)
})

test('the compat switch is off by default', async (t) => {
  const h = await mount({ compat: {} })
  t.after(() => h.dispose())

  const messages = [assistantCall('working_directory', '{}'), { role: 'tool', toolCallId: 'call_1', content: [{ type: 'text', text: 'D:/work' }] }]
  for await (const _chunk of h.llm.stream({ provider: ROUTE.provider, model: ROUTE.model, messages })) {
    // drain
  }
  const sent = h.requests.at(-1)
  const call = sent.messages[0].content.find((block) => block.type === 'tool-call')
  assert.equal(call.arguments, '{}', 'untouched when the switch is off')
})
