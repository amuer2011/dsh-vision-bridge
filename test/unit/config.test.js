import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeConfig, routeMatcher, DEFAULT_PROMPT } from '../../lib/config.js'

test('routeMatcher understands provider, model and glob entries', () => {
  assert.equal(routeMatcher(['*'])('anything', 'at-all'), true)
  assert.equal(routeMatcher(['shenwen'])('shenwen', 'deepseek-v4.1-flash'), true)
  assert.equal(routeMatcher(['shenwen'])('commandcode-deepseek', 'deepseek-flash'), false)
  assert.equal(routeMatcher(['shenwen/*'])('shenwen', 'anything'), true)
  assert.equal(routeMatcher(['shenwen/deepseek-*'])('shenwen', 'deepseek-v4.1-flash'), true)
  assert.equal(routeMatcher(['shenwen/deepseek-*'])('shenwen', 'glm-4v'), false)
  assert.equal(routeMatcher(['*/deepseek-*'])('anything', 'deepseek-flash'), true)
  assert.equal(routeMatcher([])('shenwen', 'x'), false)
})

test('normalizeConfig applies documented defaults', () => {
  const settings = normalizeConfig({
    vision: { backend: 'route', provider: 'p', model: 'm' },
  })
  assert.equal(settings.enabled, true)
  assert.equal(settings.advertiseImages, true)
  assert.equal(settings.cache, true)
  assert.equal(settings.onError, 'keep')
  assert.equal(settings.timeoutMs, 120_000)
  assert.equal(settings.concurrency, 2)
  assert.equal(settings.maxImagesPerRequest, 12)
  assert.equal(settings.prompt, DEFAULT_PROMPT)
  assert.deepEqual(settings.routes, ['*'])
  assert.equal(settings.matchesRoute('any', 'model'), true)
})

test('endpoint backend is inferred from baseURL and normalizes the URL', () => {
  const settings = normalizeConfig({
    vision: { baseURL: 'https://api.example.com/v1/', model: 'vl', apiKeyEnv: 'KEY' },
  })
  assert.equal(settings.vision.backend, 'endpoint')
  assert.equal(settings.vision.baseURL, 'https://api.example.com/v1')
  assert.equal(settings.vision.api, 'chat-completions')
  assert.equal(settings.vision.apiKeyEnv, 'KEY')
})

test('an omitted vision block means auto discovery', () => {
  const settings = normalizeConfig({})
  assert.equal(settings.vision.backend, 'auto')
  assert.deepEqual(settings.vision.prefer, [])
  assert.deepEqual(settings.vision.autoModels, ['deepseek-flash', 'deepseek-v4.1-flash'])
})

test('auto discovery accepts prefer and custom probe ids', () => {
  const settings = normalizeConfig({
    vision: { backend: 'auto', prefer: ['deepseek-account', ''], autoModels: ['qwen-vl-max'] },
  })
  assert.equal(settings.vision.backend, 'auto')
  assert.deepEqual(settings.vision.prefer, ['deepseek-account'])
  assert.deepEqual(settings.vision.autoModels, ['qwen-vl-max'])
})

test('an incomplete vision backend is rejected with a readable message', () => {
  assert.throws(
    () => normalizeConfig({ vision: { backend: 'route', provider: 'p' } }),
    /needs vision\.provider and vision\.model/,
  )
  assert.throws(
    () => normalizeConfig({ vision: { backend: 'endpoint', baseURL: 'https://x/v1' } }),
    /needs vision\.model/,
  )
  assert.throws(
    () => normalizeConfig({ vision: { backend: 'endpoint', baseURL: 'https://x/v1', model: 'm', api: 'nope' } }),
    /is not supported/,
  )
})

test('enabled: false disables the plugin without touching configuration', () => {
  const settings = normalizeConfig({ enabled: false, vision: { backend: 'route', provider: 'p', model: 'm' } })
  assert.equal(settings.enabled, false)
})

