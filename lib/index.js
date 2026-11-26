/**
 * dsh-vision-bridge — image input compatibility for text-only models.
 *
 * Some providers expose text-only chat models (DeepSeek relays, for example)
 * behind routes that do not declare the `image` input modality. The harness
 * then refuses an image prompt at admission, and the `read_image` tool refuses
 * to hand an image to the model. This plugin makes those routes usable:
 *
 * 1. It reports `image` as an accepted modality for the configured routes, so
 *    prompts and tool results carrying images are admitted instead of refused.
 * 2. It intercepts each model request, describes every image with a vision
 *    backend (another harness route, or an external OpenAI-compatible API) and
 *    replaces the image blocks with that text. The provider only ever receives
 *    text, and the model learns what the image showed.
 *
 * The session log is never rewritten: the image stays durable and visible in
 * the transcript, and the description exists only for the request being sent.
 *
 * @module dsh-vision-bridge
 */

import { VisionBridge } from './bridge.js'
import { normalizeConfig } from './config.js'

export const name = 'vision-bridge'

/** The plugin waits for the model-call service; attachments are optional. */
export const inject = ['llm']

/**
 * Mount the bridge for the profile's lifetime.
 * @param {object} ctx - plugin context.
 * @param {Record<string, unknown> | undefined} config - plugin configuration.
 */
export function apply(ctx, config) {
  let settings
  try {
    settings = normalizeConfig(config)
  } catch (error) {
    ctx.logger?.warn?.('[vision-bridge] disabled:', error instanceof Error ? error.message : error)
    return
  }
  if (!settings.enabled) {
    ctx.logger?.info?.('[vision-bridge] disabled by configuration')
    return
  }
  new VisionBridge(ctx, settings).install()
}

export { DEFAULT_PROMPT, normalizeConfig, routeMatcher } from './config.js'
export { formatCaption, formatFailure, INTERNAL, rewriteMessages, VisionBridge } from './bridge.js'
export { captionViaEndpoint, captionViaRoute, endpointTarget, extractEndpointText } from './captions.js'
