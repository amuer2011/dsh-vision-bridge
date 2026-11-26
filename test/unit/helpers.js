/**
 * Test doubles that mimic the harness seams the bridge touches:
 * - an `llm` service with `resolveModelInfo` / `prepareCall` / `stream`,
 * - an adapter stream that records what actually reached the provider,
 * - a plugin context exposing `get`, `effect` and `logger`.
 *
 * The fake adapter reproduces the one real behaviour the tests depend on:
 * a text-only route would receive `[image omitted …]` placeholders instead of
 * image blocks, so an assertion that the adapter saw caption text proves the
 * bridge ran before the runtime's text-only projection.
 */

export const TEXT_ONLY_PLACEHOLDER = '[image omitted because this model accepts text only'

/**
 * @typedef {object} FakeRoute
 * @property {boolean} image - whether the route accepts image input.
 * @property {string} [caption] - text streamed when the route receives an image.
 * @property {'stop'|'error'} [finish] - terminal outcome for the caption route.
 */

/**
 * Build a fake `llm` service.
 * @param {Record<string, FakeRoute>} routes - capability map keyed `provider/model`.
 * @returns {object} the fake service plus its recorded requests.
 */
export function createLlm(routes) {
  /** @type {{ provider: string, model: string, messages: any[], sawImage: boolean }[]} */
  const requests = []
  /** @type {Map<string, number>} */
  const calls = new Map()

  /**
   * @param {any} options - model request.
   * @returns {AsyncIterable<any>} the chunk stream.
   */
  async function* adapterStream(options) {
    const key = `${options.provider}/${options.model}`
    const route = routes[key] ?? { image: false }
    calls.set(key, (calls.get(key) ?? 0) + 1)
    const sawImage = options.messages.some((message) => message.content.some((block) => block.type === 'image'))
    requests.push({ provider: options.provider, model: options.model, messages: options.messages, sawImage })

    if (sawImage && !route.image) {
      // The real runtime projects images to this placeholder before dispatch for
      // a text-only route, so reproduce that instead of throwing: a bridge bug
      // then shows up as a placeholder in the recorded request.
      yield { type: 'text-delta', index: 0, text: TEXT_ONLY_PLACEHOLDER }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (sawImage) {
      if (route.finish === 'error') {
        yield { type: 'finish', reason: { kind: 'error', failure: { message: 'fake vision failure', code: 'AUTH' } } }
        return
      }
      for (const chunk of String(route.caption ?? 'a described image')) {
        yield { type: 'text-delta', index: 0, text: chunk }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    yield { type: 'text-delta', index: 0, text: 'assistant reply' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  const llm = {
    async resolveModelInfo(provider, model) {
      const route = routes[`${provider}/${model}`]
      if (route === undefined && model.startsWith('unknown-')) throw new Error(`no such model: ${provider}/${model}`)
      return {
        provider,
        model,
        inputModalities: route?.image === true ? ['text', 'image'] : ['text'],
        defaultMaxTokens: 4096,
        contextWindow: 65536,
      }
    },
    listProviders() {
      const providers = [...new Set(Object.keys(routes).map((key) => key.split('/')[0]))]
      return providers.map((id) => ({ id, name: id }))
    },
    async listModels(provider) {
      return Object.keys(routes)
        .filter((key) => key.startsWith(`${provider}/`))
        .map((key) => {
          const model = key.slice(provider.length + 1)
          return {
            provider,
            id: model,
            name: model,
            inputModalities: routes[key].image === true ? ['text', 'image'] : ['text'],
          }
        })
    },
    async prepareCall(config) {
      const modelInfo = await llm.resolveModelInfo(config.provider, config.model)
      return {
        config,
        modelInfo,
        context: { contextWindow: modelInfo.contextWindow },
        adapterDefaults: {},
        stream: (request) => adapterStream(request),
      }
    },
    stream(options) {
      return adapterStream(options)
    },
  }

  return { llm, requests, calls }
}

/**
 * Build a fake plugin context.
 * @param {object} llm - the fake llm service.
 * @param {object} [attachments] - optional fake attachment service.
 * @param {Record<string, object>} [services] - extra services reachable through `ctx.get()`.
 * @returns {object} the context plus lifecycle helpers.
 */
export function createContext(llm, attachments, services = {}) {
  /** @type {(() => void)[]} */
  const disposers = []
  const logs = []
  const ctx = {
    llm,
    logger: {
      info: (...args) => logs.push(['info', args]),
      warn: (...args) => logs.push(['warn', args]),
      debug: () => {},
    },
    get(name) {
      if (name === 'attachments') return attachments
      return services[name]
    },
    effect(factory) {
      disposers.push(factory())
    },
  }
  return {
    ctx,
    logs,
    dispose() {
      for (const disposer of disposers.reverse()) disposer()
      disposers.length = 0
    },
  }
}

/**
 * One durable image attachment reference.
 * @param {number} [seed] - varies the digest so distinct refs stay distinct.
 * @returns {object} the reference.
 */
export function imageRef(seed = 1) {
  return {
    attachmentId: `sha256:${String(seed).padStart(64, '0')}`,
    mediaType: 'image/png',
    width: 1280,
    height: 720,
    bytes: 1024,
  }
}

/**
 * One user message carrying an image and a prompt.
 * @param {object} ref - image attachment reference.
 * @returns {object} the message.
 */
export function userMessageWithImage(ref) {
  return {
    role: 'user',
    content: [
      { type: 'text', text: 'what does this screenshot show?' },
      { type: 'image', attachment: ref },
    ],
  }
}

/**
 * Collect every text block of a request.
 * @param {any[]} messages - request messages.
 * @returns {string[]} text blocks.
 */
export function textBlocks(messages) {
  const out = []
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'text') out.push(block.text)
    }
  }
  return out
}
