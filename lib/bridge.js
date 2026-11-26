/**
 * The bridge itself: patch the harness `llm` service, rewrite text-only
 * requests, and remember the captions it produced.
 *
 * Why the service is patched instead of a plugin event being used:
 * the agent loop dispatches a prepared call (`preparedCall.stream(request)`),
 * not `ctx.llm.stream(request)`, and the harness offers no request-rewrite
 * event. Wrapping the two public entry points is the smallest seam that sees
 * every model call — agent turns, subagents, compaction summaries, titles and
 * direct `ctx.llm.stream` consumers alike.
 *
 * @module dsh-vision-bridge/bridge
 */

import { captionViaEndpoint, captionViaRoute } from './captions.js'

/** Marks bridge-internal requests so they are never rewritten. */
export const INTERNAL = Symbol.for('dsh-vision-bridge.internal')

/** Cache entries kept before the oldest is dropped. */
const CACHE_LIMIT = 256

/**
 * @param {unknown} content - model content blocks.
 * @returns {boolean} whether the content carries a durable image.
 */
function contentHasImage(content) {
  return Array.isArray(content) && content.some((block) => block !== null && typeof block === 'object' && block.type === 'image')
}

/**
 * @param {unknown} messages - request messages.
 * @returns {boolean} whether any message carries an image.
 */
function messagesHaveImages(messages) {
  return Array.isArray(messages) && messages.some((message) => message !== null && typeof message === 'object' && contentHasImage(message.content))
}

/**
 * Run `worker` over `items` with at most `limit` concurrent operations,
 * preserving input order in the result.
 * @template T, R
 * @param {T[]} items - inputs.
 * @param {number} limit - maximum concurrency.
 * @param {(item: T, index: number) => Promise<R>} worker - async operation.
 * @returns {Promise<R[]>} results in input order.
 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

/**
 * Durable-reference personality for one image, independent of the caption.
 * @param {object} ref - image attachment reference.
 * @returns {string} short identity used in the model-visible text.
 */
function imageIdentity(ref) {
  const digest = String(ref.attachmentId ?? '').replace(/^sha256:/, '').slice(0, 8)
  const name = typeof ref.name === 'string' && ref.name !== '' ? `"${ref.name}" ` : ''
  const size = Number.isFinite(ref.width) && Number.isFinite(ref.height) ? `${ref.width}x${ref.height}` : 'unknown size'
  const media = typeof ref.mediaType === 'string' ? ref.mediaType : 'image'
  return `${name}${size} ${media}${digest === '' ? '' : ` sha256:${digest}`}`
}

/**
 * Model-visible text for one bridged image.
 * @param {object} ref - image attachment reference.
 * @param {string} caption - description produced by the vision backend.
 * @returns {string} the replacement text block content.
 */
export function formatCaption(ref, caption) {
  // The trailing newline matters: protocols that join text blocks without a
  // separator would otherwise glue the caption to the user's own words.
  return `[image ${imageIdentity(ref)}]\n${caption}\n`
}

/**
 * Model-visible text used when a caption could not be produced and
 * `onError: note` is configured.
 * @param {object} ref - image attachment reference.
 * @param {unknown} error - the failure.
 * @returns {string} the replacement text block content.
 */
export function formatFailure(ref, error) {
  const reason = error instanceof Error ? error.message : String(error)
  return [
    `[image ${imageIdentity(ref)}]`,
    'The vision bridge could not describe this image, so it is not visible to you.',
    `Reason: ${reason}`,
    'Tell the user if the image matters; they can paste what it shows as text.',
  ].join('\n')
}

/**
 * Replace image blocks whose attachment has a caption with text blocks.
 * @param {any[]} messages - request messages.
 * @param {Map<string, string>} captions - caption text by attachment id.
 * @returns {any[]} the rewritten messages (unchanged array when nothing matched).
 */
export function rewriteMessages(messages, captions) {
  if (captions.size === 0) return messages
  let anyChanged = false
  const next = messages.map((message) => {
    if (message === null || typeof message !== 'object' || !contentHasImage(message.content)) return message
    let changed = false
    const content = []
    for (const block of message.content) {
      if (block?.type !== 'image') {
        content.push(block)
        continue
      }
      const id = block.attachment?.attachmentId
      const text = id === undefined ? undefined : captions.get(String(id))
      if (text === undefined) {
        content.push(block)
        continue
      }
      content.push({ type: 'text', text })
      changed = true
    }
    if (!changed) return message
    anyChanged = true
    return { ...message, content }
  })
  return anyChanged ? next : messages
}

/**
 * The bridge runtime. One instance per plugin mount.
 */
export class VisionBridge {
  /**
   * @param {object} ctx - plugin context.
   * @param {object} settings - normalized settings from `normalizeConfig`.
   */
  constructor(ctx, settings) {
    this.ctx = ctx
    this.settings = settings
    /** @type {Map<string, string>} */
    this.cache = new Map()
    /** @type {Map<string, Promise<string>>} */
    this.inflight = new Map()
    /** @type {Map<string, Promise<boolean>>} */
    this.capabilities = new Map()
    /** @type {(() => void)[]} */
    this.restores = []
    this.installed = false
  }

  /** @returns {{ info: (...args: any[]) => void, warn: (...args: any[]) => void, debug: (...args: any[]) => void }} */
  get logger() {
    const logger = this.ctx.logger
    if (logger === undefined || logger === null) {
      return { info() {}, warn() {}, debug() {} }
    }
    return {
      info: (...args) => logger.info?.('[vision-bridge]', ...args),
      warn: (...args) => logger.warn?.('[vision-bridge]', ...args),
      debug: (...args) => {
        if (this.settings.debug) logger.debug?.('[vision-bridge]', ...args)
      },
    }
  }

  /** @returns {object | undefined} the attachment service, when the profile has one. */
  get attachments() {
    return this.ctx.get?.('attachments') ?? this.ctx.attachments
  }

  /**
   * Patch the `llm` service and register restoration on unload.
   * @returns {boolean} whether the patches were installed.
   */
  install() {
    const llm = this.ctx.llm
    if (llm === undefined || llm === null) {
      this.logger.warn('the llm service is unavailable; nothing to bridge')
      return false
    }
    this.llm = llm
    this.originalResolveModelInfo = llm.resolveModelInfo
    this.originalStream = llm.stream
    this.originalPrepareCall = llm.prepareCall

    this.patchResolveModelInfo()
    this.patchStream()
    this.patchPrepareCall()

    this.ctx.effect(() => () => this.dispose(), 'vision-bridge: restore llm service')
    this.installed = true
    this.logger.info(
      `bridging image input for [${this.settings.routes.join(', ')}] via ${this.describeVision()}`,
    )
    return true
  }

  /** @returns {string} a short description of the configured backend. */
  describeVision() {
    const vision = this.settings.vision
    return vision.backend === 'route' ? `route ${vision.provider}/${vision.model}` : `endpoint ${vision.baseURL} (${vision.model})`
  }

  /** Restore the patched methods. */
  dispose() {
    for (const restore of this.restores.reverse()) {
      try {
        restore()
      } catch (error) {
        this.logger.warn('failed to restore a patched method:', error)
      }
    }
    this.restores = []
    this.cache.clear()
    this.inflight.clear()
    this.installed = false
  }

  /**
   * Report `image` input for bridged routes so client uploads and the
   * `read_image` tool stop refusing them before the request is built.
   */
  patchResolveModelInfo() {
    const llm = this.llm
    const original = this.originalResolveModelInfo
    if (typeof original !== 'function') return
    const bridge = this
    const patched = async function resolveModelInfo(provider, model, signal) {
      const info = await original.call(this, provider, model, signal)
      return bridge.advertise(provider, model, info)
    }
    llm.resolveModelInfo = patched
    this.restores.push(() => {
      if (llm.resolveModelInfo === patched) llm.resolveModelInfo = original
    })
  }

  /**
   * Wrap `llm.stream` for callers that do not prepare a call first
   * (compaction summaries, title generation, direct plugin calls).
   */
  patchStream() {
    const llm = this.llm
    const original = this.originalStream
    if (typeof original !== 'function') return
    const bridge = this
    const patched = function stream(options) {
      if (!bridge.shouldConsider(options)) return original.call(this, options)
      return (async function* bridged() {
        yield* original.call(llm, await bridge.transform(options))
      })()
    }
    llm.stream = patched
    this.restores.push(() => {
      if (llm.stream === patched) llm.stream = original
    })
  }

  /**
   * Wrap `llm.prepareCall` so the agent loop's prepared dispatch is bridged.
   * The prepared object is copied with only `stream` replaced, keeping the
   * captured adapter generation, config and capability facts intact.
   */
  patchPrepareCall() {
    const llm = this.llm
    const original = this.originalPrepareCall
    if (typeof original !== 'function') return
    const bridge = this
    const patched = async function prepareCall(config, signal, configure) {
      const prepared = await original.call(this, config, signal, configure)
      if (prepared === null || typeof prepared !== 'object' || typeof prepared.stream !== 'function') return prepared
      const stream = prepared.stream.bind(prepared)
      return {
        ...prepared,
        stream(request) {
          if (!bridge.shouldConsider(request)) return stream(request)
          return (async function* bridged() {
            yield* stream(await bridge.transform(request))
          })()
        },
      }
    }
    llm.prepareCall = patched
    this.restores.push(() => {
      if (llm.prepareCall === patched) llm.prepareCall = original
    })
  }

  /**
   * Add the image modality to a bridged route's advertised capabilities.
   * @param {string} provider - provider route key.
   * @param {string} model - model id.
   * @param {object} info - resolved model info from the adapter.
   * @returns {object} the info to publish.
   */
  advertise(provider, model, info) {
    if (!this.settings.advertiseImages) return info
    if (info === null || typeof info !== 'object') return info
    if (!this.settings.matchesRoute(provider, model)) return info
    const modalities = Array.isArray(info.inputModalities) ? info.inputModalities : []
    if (modalities.includes('image')) return info
    return { ...info, inputModalities: [...modalities, 'image'] }
  }

  /**
   * Cheap synchronous filter: does this request carry images at all?
   * @param {any} options - a model request.
   * @returns {boolean} whether the request may need bridging.
   */
  shouldConsider(options) {
    if (!this.installed || options === null || typeof options !== 'object') return false
    if (options[INTERNAL] === true) return false
    if (typeof options.provider !== 'string' || typeof options.model !== 'string') return false
    if (!messagesHaveImages(options.messages)) return false
    return this.settings.matchesRoute(options.provider, options.model)
  }

  /**
   * Whether the route really is text only, according to the adapter rather
   * than to this plugin's own capability advertisement.
   * @param {string} provider - provider route key.
   * @param {string} model - model id.
   * @returns {Promise<boolean>} whether the route needs bridging.
   */
  async needsBridge(provider, model) {
    const key = `${provider}\u0000${model}`
    let pending = this.capabilities.get(key)
    if (pending === undefined) {
      const resolve = this.originalResolveModelInfo
      pending = (async () => {
        try {
          const info = await resolve.call(this.llm, provider, model)
          const modalities = Array.isArray(info?.inputModalities) ? info.inputModalities : []
          return !modalities.includes('image')
        } catch (error) {
          this.logger.debug(`could not resolve ${provider}/${model}:`, error)
          return false
        }
      })()
      this.capabilities.set(key, pending)
    }
    return pending
  }

  /**
   * Rewrite one request: caption its images and replace them with text.
   * Returns the input untouched when the route is image capable, when no
   * caption could be produced under `onError: keep`, or on any internal error.
   * @param {any} options - the request about to be dispatched.
   * @returns {Promise<any>} the request to dispatch.
   */
  async transform(options) {
    try {
      if (!(await this.needsBridge(options.provider, options.model))) return options

      const refs = []
      const seen = new Set()
      for (const message of options.messages) {
        for (const block of message.content) {
          if (block?.type !== 'image') continue
          const ref = block.attachment
          if (ref === undefined || ref === null || typeof ref.attachmentId !== 'string') continue
          if (seen.has(ref.attachmentId)) continue
          seen.add(ref.attachmentId)
          refs.push(ref)
        }
      }
      if (refs.length === 0) return options

      const limited = refs.slice(0, this.settings.maxImagesPerRequest)
      if (refs.length > limited.length) {
        this.logger.warn(
          `request carries ${refs.length} images; only the first ${limited.length} are bridged (maxImagesPerRequest)`,
        )
      }

      const captions = await mapLimit(limited, this.settings.concurrency, async (ref) => {
        const text = await this.describeOne(ref, options.signal)
        return [ref.attachmentId, text]
      })

      const map = new Map()
      for (const [id, text] of captions) {
        if (typeof text === 'string') map.set(id, text)
      }
      if (map.size === 0) return options
      const messages = rewriteMessages(options.messages, map)
      if (messages === options.messages) return options
      this.logger.debug(`bridged ${map.size} image(s) for ${options.provider}/${options.model}`)
      return { ...options, messages }
    } catch (error) {
      this.logger.warn('request left untransformed:', error)
      return options
    }
  }

  /**
   * Caption one image, reusing the process-local cache and coalescing
   * concurrent requests for the same attachment.
   * @param {object} ref - image attachment reference.
   * @param {AbortSignal | undefined} signal - request cancellation.
   * @returns {Promise<string | undefined>} caption text, or undefined to keep the image block.
   */
  async describeOne(ref, signal) {
    const key = `${ref.attachmentId}\u0000${this.captionKey()}`
    if (this.settings.cache) {
      const cached = this.cache.get(key)
      if (cached !== undefined) return cached
    }
    let pending = this.inflight.get(key)
    if (pending === undefined) {
      pending = this.caption(ref, signal)
      this.inflight.set(key, pending)
      pending.then(
        () => this.inflight.delete(key),
        () => this.inflight.delete(key),
      )
    }
    try {
      const caption = await pending
      const text = formatCaption(ref, caption)
      this.remember(key, text)
      return text
    } catch (error) {
      if (signal?.aborted) return undefined
      this.logger.warn(`caption failed for ${imageIdentity(ref)}:`, error instanceof Error ? error.message : error)
      return this.settings.onError === 'note' ? formatFailure(ref, error) : undefined
    }
  }

  /**
   * @returns {string} cache namespace covering the backend and instruction.
   */
  captionKey() {
    const vision = this.settings.vision
    const backend = vision.backend === 'route' ? `${vision.provider}/${vision.model}` : `${vision.baseURL}|${vision.model}`
    return `${backend}\u0000${this.settings.prompt.length}\u0000${this.settings.prompt}`
  }

  /**
   * Cache one caption, dropping the oldest entry at the limit.
   * @param {string} key - cache key.
   * @param {string} text - caption.
   */
  remember(key, text) {
    if (!this.settings.cache) return
    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next()
      if (!oldest.done) this.cache.delete(oldest.value)
    }
    this.cache.set(key, text)
  }

  /**
   * Produce one caption through the configured backend.
   * @param {object} ref - image attachment reference.
   * @param {AbortSignal | undefined} signal - request cancellation.
   * @returns {Promise<string>} caption text.
   */
  async caption(ref, signal) {
    const vision = this.settings.vision
    if (vision.backend === 'route') {
      return captionViaRoute({
        llm: this.llm,
        stream: this.originalStream,
        vision,
        ref,
        prompt: this.settings.prompt,
        signal,
        timeoutMs: this.settings.timeoutMs,
      })
    }
    const attachments = this.attachments
    if (attachments === undefined || typeof attachments.readImageRequest !== 'function') {
      throw new Error('the attachment service is unavailable, so stored image bytes cannot be read')
    }
    return captionViaEndpoint({
      attachments,
      vision,
      ref,
      prompt: this.settings.prompt,
      signal,
      timeoutMs: this.settings.timeoutMs,
    })
  }
}
