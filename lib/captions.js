/**
 * Caption backends: turn one durable image attachment into text.
 *
 * Two backends exist because the two realistic situations differ:
 * - `route`    a vision-capable provider/model already configured in the same
 *              harness; the bridge reuses it through `ctx.llm.stream(`.
 * - `endpoint` an external OpenAI-compatible vision API; the bridge reads the
 *              stored image bytes itself and posts them as a data URL.
 *
 * @module dsh-vision-bridge/captions
 */

/** Long edge used when the endpoint backend has to re-encode an image. */
const ENDPOINT_LONG_EDGE = 1568
/** Encoded byte target for the endpoint backend's data URL. */
const ENDPOINT_MAX_BYTES = 1_500_000

/**
 * Text the harness itself emits for a text-only route. A caption equal to this
 * means the configured vision route cannot see images either.
 */
const TEXT_ONLY_MARKER = '[image omitted because this model accepts text only'

/**
 * @param {string} text - raw model output.
 * @returns {string} trimmed text with collapsed trailing whitespace.
 */
function tidy(text) {
  return text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim()
}

/**
 * @param {unknown} mediaType - declared media type.
 * @returns {boolean} whether it is an image type the harness can project.
 */
function isImageMediaType(mediaType) {
  return mediaType === 'image/png' || mediaType === 'image/jpeg' || mediaType === 'image/webp' || mediaType === 'image/gif'
}

/**
 * Compute an endpoint-safe request image size: aspect preserved, long edge
 * bounded, never upscaled.
 * @param {number} width - stored width.
 * @param {number} height - stored height.
 * @returns {{ width: number, height: number, maxBytes: number }} request target.
 */
export function endpointTarget(width, height) {
  const safeWidth = Number.isFinite(width) && width > 0 ? Math.floor(width) : ENDPOINT_LONG_EDGE
  const safeHeight = Number.isFinite(height) && height > 0 ? Math.floor(height) : ENDPOINT_LONG_EDGE
  const longEdge = Math.max(safeWidth, safeHeight)
  const scale = longEdge > ENDPOINT_LONG_EDGE ? ENDPOINT_LONG_EDGE / longEdge : 1
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
    maxBytes: ENDPOINT_MAX_BYTES,
  }
}

/**
 * Combine the caller's cancellation with the caption deadline.
 *
 * A manual controller is used instead of `AbortSignal.timeout()` so the timer
 * is cleared as soon as the caption settles; a long deadline must not keep a
 * timer alive for every image a session ever bridged.
 * @param {AbortSignal | undefined} signal - request cancellation.
 * @param {number} timeoutMs - deadline in milliseconds.
 * @returns {{ signal: AbortSignal, cleanup: () => void }} combined signal and its disposer.
 */
function deadline(signal, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new Error(`the vision request exceeded ${timeoutMs}ms`))
  }, timeoutMs)
  timer.unref?.()
  const onAbort = () => controller.abort(signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

/**
 * Read plain text out of a Responses-style or Chat-Completions-style payload.
 * @param {unknown} payload - parsed JSON response body.
 * @returns {string} extracted text, or an empty string.
 */
export function extractEndpointText(payload) {
  if (payload === null || typeof payload !== 'object') return ''
  const body = /** @type {Record<string, any>} */ (payload)

  if (typeof body.output_text === 'string' && body.output_text.trim() !== '') return body.output_text

  const choice = Array.isArray(body.choices) ? body.choices[0] : undefined
  const message = choice?.message
  if (message !== undefined) {
    if (typeof message.content === 'string') return message.content
    if (Array.isArray(message.content)) {
      const joined = message.content
        .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
        .join('')
      if (joined.trim() !== '') return joined
    }
  }
  if (typeof choice?.text === 'string' && choice.text.trim() !== '') return choice.text

  if (Array.isArray(body.output)) {
    const parts = []
    for (const item of body.output) {
      if (typeof item?.text === 'string') parts.push(item.text)
      if (Array.isArray(item?.content)) {
        for (const part of item.content) {
          if (typeof part?.text === 'string') parts.push(part.text)
        }
      }
    }
    const joined = parts.join('')
    if (joined.trim() !== '') return joined
  }
  return ''
}

/**
 * Ask a configured harness route to describe one image.
 *
 * The call goes through the *unpatched* stream method (see `bridge.js`) so the
 * bridge never captions its own caption requests. The image block is passed as
 * a durable attachment reference and the runtime projects it for the route.
 *
 * @param {object} options - caption request.
 * @param {object} options.llm - the `ctx.llm` service.
 * @param {(options: object) => AsyncIterable<any>} options.stream - pristine `llm.stream`.
 * @param {object} options.vision - normalized route backend.
 * @param {object} options.ref - durable image attachment reference.
 * @param {string} options.prompt - caption instruction.
 * @param {AbortSignal | undefined} options.signal - cancellation.
 * @param {number} options.timeoutMs - caption deadline.
 * @returns {Promise<string>} the caption.
 */
export async function captionViaRoute({ llm, stream, vision, ref, prompt, signal, timeoutMs }) {
  const combined = deadline(signal, timeoutMs)
  const request = {
    provider: vision.provider,
    model: vision.model,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', attachment: ref },
        { type: 'text', text: prompt },
      ],
    }],
    signal: combined.signal,
  }

  let text = ''
  /** @type {any} */
  let failure
  try {
    for await (const chunk of stream.call(llm, request)) {
      if (chunk?.type === 'text-delta') text += chunk.text ?? ''
      else if (chunk?.type === 'finish') {
        if (chunk.reason?.kind === 'error') failure = chunk.reason.failure
        else if (chunk.reason?.kind === 'aborted') failure = { message: combined.signal.aborted ? String(combined.signal.reason?.message ?? 'aborted') : 'the vision request was aborted' }
      }
    }
  } finally {
    combined.cleanup()
  }
  if (failure !== undefined) throw new Error(String(failure.message ?? 'the vision route failed'))
  const caption = tidy(text)
  if (caption === '') throw new Error('the vision route returned no text')
  if (caption.includes(TEXT_ONLY_MARKER)) {
    throw new Error(`vision route "${vision.provider}/${vision.model}" does not accept image input; point vision at an image-capable model`)
  }
  return caption
}

/**
 * Ask an external OpenAI-compatible vision endpoint to describe one image.
 * @param {object} options - caption request.
 * @param {object} options.attachments - the `ctx.attachments` service.
 * @param {object} options.vision - normalized endpoint backend.
 * @param {object} options.ref - durable image attachment reference.
 * @param {string} options.prompt - caption instruction.
 * @param {AbortSignal | undefined} options.signal - cancellation.
 * @param {number} options.timeoutMs - caption deadline.
 * @param {typeof fetch} [options.fetchImpl] - fetch implementation (tests).
 * @returns {Promise<string>} the caption.
 */
export async function captionViaEndpoint({
  attachments,
  vision,
  ref,
  prompt,
  signal,
  timeoutMs,
  fetchImpl = fetch,
}) {
  const mediaType = isImageMediaType(ref.mediaType) ? ref.mediaType : 'image/png'
  const version = await attachments.readImageRequest(ref, endpointTarget(ref.width, ref.height), signal)
  const base64 = Buffer.from(version.data).toString('base64')
  const dataUrl = `data:${version.mediaType ?? mediaType};base64,${base64}`

  const key = vision.apiKey ?? (vision.apiKeyEnv !== undefined ? process.env[vision.apiKeyEnv] : undefined)
  if (key === undefined || key === '') {
    throw new Error(`vision endpoint credentials are missing: set ${vision.apiKeyEnv ?? 'vision.apiKey'}`)
  }

  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${key}`,
    ...vision.headers,
  }

  const body = vision.api === 'responses'
    ? {
      model: vision.model,
      input: [{
        role: 'user',
        content: [
          { type: 'input_image', image_url: dataUrl },
          { type: 'input_text', text: prompt },
        ],
      }],
    }
    : {
      model: vision.model,
      temperature: 0.2,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: prompt },
        ],
      }],
    }

  const path = vision.api === 'responses' ? '/responses' : '/chat/completions'
  const combined = deadline(signal, timeoutMs)
  let response
  try {
    response = await fetchImpl(`${vision.baseURL}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: combined.signal,
    })
  } finally {
    combined.cleanup()
  }

  const raw = await response.text()
  if (!response.ok) {
    throw new Error(`vision endpoint answered ${response.status}: ${raw.slice(0, 400)}`)
  }
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    throw new Error(`vision endpoint returned non-JSON output: ${raw.slice(0, 200)}`)
  }
  const caption = tidy(extractEndpointText(payload))
  if (caption === '') throw new Error('vision endpoint returned no text')
  return caption
}
