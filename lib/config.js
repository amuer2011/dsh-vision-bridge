/**
 * Configuration normalization for dsh-vision-bridge.
 *
 * Everything here is dependency free on purpose: the plugin runs inside the
 * harness process and must not pull extra packages into the profile.
 *
 * @module dsh-vision-bridge/config
 */

/** Caption instruction used when the user does not supply one. */
export const DEFAULT_PROMPT = [
  'You describe images for a coding assistant that cannot see them.',
  '',
  'Rules:',
  '- If the image shows code, a terminal, an error, a diff, a config file or a',
  '  UI, transcribe the lines that carry meaning (commands, errors, stack',
  '  frames, identifiers, paths, numbers) in their original order.',
  '- Keep the indentation of code and terminal output.',
  '- Do not transcribe long repetitive or decorative runs line by line;',
  '  summarise them and quote the first and last line instead.',
  '- Mention layout, colour and highlighted regions only when they carry',
  '  meaning.',
  '- Never invent content. Say when something is unreadable.',
  '- Answer in the language of the visible text, otherwise in English.',
  '- Stay under roughly 400 words unless the image is one code or config',
  '  listing that has to be exact.',
  '',
  'Return only the description, without preamble.',
].join('\n')

/** Caption backends. `auto` discovers an image-capable route at runtime. */
const BACKENDS = new Set(['route', 'endpoint', 'auto'])

/** Model ids probed on every provider when `auto` has no better candidate. */
const DEFAULT_AUTO_MODELS = ['deepseek-flash', 'deepseek-v4.1-flash']

/**
 * Match one glob-ish pattern against a value. `*` is the only wildcard.
 * @param {string} pattern - pattern such as `shenwen`, `shenwen/*`, `*-deepseek`.
 * @param {string} value - provider or model id.
 * @returns {boolean} whether the pattern matches.
 */
function globMatch(pattern, value) {
  if (pattern === '*') return true
  if (!pattern.includes('*')) return pattern === value
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`).test(value)
}

/**
 * Build the route predicate for `routes`.
 *
 * Accepted entries:
 * - `*`            every route
 * - `shenwen`      every model served by provider `shenwen`
 * - `shenwen/*`    same thing, explicit
 * - `shenwen/deepseek-*` one provider with a model pattern
 * - `* /deepseek-*` (without the space) every provider whose model matches
 *
 * @param {string[]} patterns - configured route patterns.
 * @returns {(provider: string, model: string) => boolean} the predicate.
 */
export function routeMatcher(patterns) {
  const compiled = []
  for (const raw of patterns) {
    if (typeof raw !== 'string' || raw.trim() === '') continue
    const pattern = raw.trim()
    if (pattern === '*') return () => true
    const slash = pattern.indexOf('/')
    if (slash === -1) {
      compiled.push((provider) => globMatch(pattern, provider))
      continue
    }
    const providerPattern = pattern.slice(0, slash) || '*'
    const modelPattern = pattern.slice(slash + 1) || '*'
    compiled.push((provider, model) => globMatch(providerPattern, provider) && globMatch(modelPattern, model))
  }
  if (compiled.length === 0) return () => false
  return (provider, model) => compiled.some((test) => test(provider, model))
}

/** @param {unknown} value @returns {boolean} whether a finite positive number */
function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Validate one caption backend description.
 *
 * `auto` needs no route: the bridge discovers an image-capable route at the
 * first image (`vision.prefer` biases the order, `vision.autoModels` lists the
 * model ids probed on every provider). Any `vision` block that names neither a
 * provider nor a baseURL becomes `auto`.
 * @param {Record<string, unknown>} vision - raw `vision` config.
 * @returns {{ backend: 'route'|'endpoint'|'auto', provider?: string, model?: string, baseURL?: string, api?: string, apiKey?: string, apiKeyEnv?: string, headers?: Record<string,string>, prefer?: string[], autoModels?: string[] }} normalized backend.
 */
function normalizeVision(vision) {
  const provider = typeof vision.provider === 'string' ? vision.provider.trim() : ''
  const model = typeof vision.model === 'string' ? vision.model.trim() : ''
  const baseURL = typeof vision.baseURL === 'string' ? vision.baseURL.trim() : ''
  const configured = typeof vision.backend === 'string' ? vision.backend.trim() : ''
  const backend = BACKENDS.has(configured) ? configured : baseURL !== '' ? 'endpoint' : provider !== '' ? 'route' : 'auto'

  if (backend === 'auto') {
    return {
      backend,
      prefer: Array.isArray(vision.prefer) ? vision.prefer.filter((entry) => typeof entry === 'string' && entry.trim() !== '') : [],
      autoModels: Array.isArray(vision.autoModels)
        ? vision.autoModels.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
        : [...DEFAULT_AUTO_MODELS],
    }
  }

  if (backend === 'route') {
    if (provider === '' || model === '') {
      throw new Error(
        'vision-bridge: vision.backend "route" needs vision.provider and vision.model, '
        + 'for example { provider: commandcode-deepseek, model: some-vision-model }',
      )
    }
    return { backend, provider, model }
  }
  if (baseURL === '') throw new Error('vision-bridge: vision.backend "endpoint" needs vision.baseURL')
  if (model === '') throw new Error('vision-bridge: vision.backend "endpoint" needs vision.model')
  const api = typeof vision.api === 'string' && vision.api.trim() !== '' ? vision.api.trim() : 'chat-completions'
  if (api !== 'chat-completions' && api !== 'responses') {
    throw new Error(`vision-bridge: vision.api "${api}" is not supported (use chat-completions or responses)`)
  }
  const headers = {}
  if (vision.headers !== undefined && vision.headers !== null && typeof vision.headers === 'object') {
    for (const [key, value] of Object.entries(vision.headers)) {
      if (typeof value === 'string') headers[key] = value
    }
  }
  return {
    backend,
    baseURL: baseURL.replace(/\/+$/, ''),
    model,
    api,
    ...(typeof vision.apiKey === 'string' && vision.apiKey !== '' ? { apiKey: vision.apiKey } : {}),
    ...(typeof vision.apiKeyEnv === 'string' && vision.apiKeyEnv !== '' ? { apiKeyEnv: vision.apiKeyEnv } : {}),
    headers,
  }
}

/**
 * Normalize user configuration into the shape the bridge consumes.
 * @param {Record<string, unknown> | undefined} raw - plugin config from `cordis.patch.yml`.
 * @returns {object} normalized settings.
 */
export function normalizeConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const routes = Array.isArray(config.routes)
    ? config.routes.filter((entry) => typeof entry === 'string')
    : typeof config.routes === 'string' ? [config.routes] : ['*']

  const vision = config.vision !== null && typeof config.vision === 'object' ? config.vision : {}
  const backend = normalizeVision(vision)

  const prompt = typeof config.prompt === 'string' && config.prompt.trim() !== '' ? config.prompt : DEFAULT_PROMPT
  const timeoutMs = isPositiveNumber(config.timeoutMs) ? config.timeoutMs : 120_000
  const concurrency = isPositiveNumber(config.concurrency) ? Math.max(1, Math.min(8, Math.floor(config.concurrency))) : 2
  const maxImagesPerRequest = isPositiveNumber(config.maxImagesPerRequest) ? Math.floor(config.maxImagesPerRequest) : 12
  const onError = config.onError === 'note' ? 'note' : 'keep'
  const compat = config.compat !== null && typeof config.compat === 'object' ? config.compat : {}

  return {
    enabled: config.enabled === false ? false : true,
    routes,
    matchesRoute: routeMatcher(routes),
    advertiseImages: config.advertiseImages === false ? false : true,
    vision: backend,
    prompt,
    timeoutMs,
    concurrency,
    maxImagesPerRequest,
    cache: config.cache === false ? false : true,
    onError,
    compatEmptyToolArguments: compat.emptyToolArguments === true,
    debug: config.debug === true,
  }
}

