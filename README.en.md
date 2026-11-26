# dsh-vision-bridge

Image input for **text-only models** in DeepSeek Harness: paste a screenshot as usual and the plugin looks at it with a vision model first, then hands the text-only model a written description.

> The usual case: a relay that only serves DeepSeek text models (`commandcode-deepseek`, `shenwen`, …). Selecting one of those models and attaching an image fails with `Model "deepseek-v4.1-flash" does not support image input.` (`MODEL_DOES_NOT_SUPPORT_IMAGES`), and the `read_image` tool refuses to read images too.

[中文说明](README.md)

---

## The problem

DSH checks a model's declared input modalities before it accepts a prompt:

```js
// dsh-api-session-controller: session/prompt
if (model.inputModalities !== void 0 && !model.inputModalities.includes('image'))
  throw new RemoteError('session/attachment-invalid',
    `Model "${model}" does not support image input.`, { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' })
```

The pi-ai adapter's `defaultInput` is `['text']`, so every route that does not explicitly declare `input: [text, image]` refuses images outright. Even when a request gets through, the runtime degrades the image to one line:

```
[image omitted because this model accepts text only; attachment sha256:1a2b3c4d]
```

For the model, the image might as well not exist.

## Providers verified so far

| Provider route | Model | Plugin needed | Status |
| --- | --- | --- | --- |
| `deepseek-official` / `deepseek-account` (DeepSeek account) | `deepseek-flash` | no — reads images natively | ✅ verified: transcribed a screenshot directly; the plugin steps aside |
| `commandcode-deepseek` | `deepseek-flash` | yes (text-only) | ✅ verified: bridged end to end, using `deepseek-official/deepseek-flash` as the eyes; the model described an Arthas `dashboard` screenshot correctly |
| `shenwen` | `deepseek-v4.1-flash` | yes | ⚠️ same shape as `commandcode-deepseek` (pi-ai + `openai-responses`), but `api.shenwenai.com` was unreachable from the test machine (TLS), so it is untested |
| any `@deepseek-ai/dsh-llm-pi-ai` text route | — | yes | ✅ generic: end-to-end against a stub route that declares only `text` |

Any pi-ai route that does not declare `image` input works: add its provider key to `routes` and point the plugin at a vision backend. The cheapest backend is usually your own account model:

```yaml
- id: vision-bridge
  name: 'dsh-vision-bridge'
  config:
    routes: ['commandcode-deepseek', 'shenwen']
    vision:
      backend: route
      provider: deepseek-account     # the official route key used by your profile
      model: deepseek-flash
```

> Route keys depend on the build: Desktop 0.2.1 calls the official route `deepseek-account`, the CLI 0.2.0 calls it `deepseek-official`.

## What the plugin does

1. **Admits the image** — it wraps `ctx.llm.resolveModelInfo` and adds the `image` modality for the routes you list, so prompt uploads and `read_image` results enter the session normally. This only changes capability reporting; it does not pretend the provider can see.
2. **Turns the image into text** — it wraps `ctx.llm.prepareCall` / `ctx.llm.stream` and, before the request goes out, replaces every `image` block with text:

   ```
   [image "error.png" 1280x720 image/png sha256:1a2b3c4d]
   A Windows terminal screenshot. The running command is `pnpm test`; the last
   six lines read:
   FAIL src/api.test.ts > rejects expired tokens
   AssertionError: expected 401 to be 200
   ...
   ```

   The description comes from a **vision backend**:

   | Backend | What it is |
   | --- | --- |
   | `route` | an already configured vision-capable model route in the same harness (no extra key) |
   | `endpoint` | any OpenAI-compatible vision API (`chat/completions` or `responses`) |

3. **Leaves the session alone** — the log keeps the image, so the transcript still shows the thumbnail; the description only exists inside that request. When the active model really is image capable, the plugin steps aside.

## Install

The package is an ordinary DSH bundle (`dsh.bundle.patch` + `cordis.patch.yml`), so installing it inserts one `vision-bridge` row into the profile.

**Option A — GUI**

1. Web sidebar → **Plugins**;
2. **Install**, then enter `github:<your-name>/dsh-vision-bridge`;
3. Fill in `vision` as described below.

**Option B — CLI**

```bash
# the desktop profile is called "desktop"
dsh plugin --profile desktop add github:<your-name>/dsh-vision-bridge
# local checkout
dsh plugin --profile desktop add file:D:/code/dsh-vision-bridge
```

Then edit `$DSH_HOME/profiles/<profile>/cordis.patch.yml` (`C:\Users\<you>\.dsh\profiles\desktop\cordis.patch.yml` on Windows) and override the inserted row.

## Configuration

### Reuse a vision route already in the harness

```yaml
- id: vision-bridge
  name: 'dsh-vision-bridge'
  config:
    routes: ['commandcode-deepseek', 'shenwen']
    vision:
      backend: route
      provider: openrouter                 # any configured route that accepts images
      model: qwen2.5-vl-72b-instruct
```

`provider` is the route key shown under Settings → Models; `model` must be an image-capable model on that route.

### External OpenAI-compatible vision API

```yaml
- id: vision-bridge
  name: 'dsh-vision-bridge'
  config:
    routes: ['commandcode-deepseek', 'shenwen']
    vision:
      backend: endpoint
      api: chat-completions               # or responses
      baseURL: https://api.example.com/v1
      model: gpt-4o-mini
      apiKeyEnv: VISION_API_KEY           # or apiKey: sk-...
      # headers:                          # optional extra headers
      #   x-custom: value
```

`apiKeyEnv` must be visible to the process that starts DSH. For the desktop app, prefer `apiKey` or a system environment variable plus an app restart.

### All options

| Field | Default | Meaning |
| --- | --- | --- |
| `routes` | `['*']` | Routes to bridge: `provider`, `provider/model`, `*` globs; `'*'` alone means every text-only route |
| `vision.backend` | inferred | `route` or `endpoint`; `baseURL` implies `endpoint` |
| `vision.provider` / `vision.model` | — | required for the `route` backend |
| `vision.baseURL` / `vision.model` | — | required for the `endpoint` backend |
| `vision.api` | `chat-completions` | `chat-completions` or `responses` |
| `vision.apiKey` / `vision.apiKeyEnv` | — | endpoint credentials |
| `vision.headers` | `{}` | extra request headers |
| `prompt` | built in | caption instruction; the built-in one asks for the meaningful lines (commands, errors, stack frames), compresses repetition and stays under ~400 words |
| `timeoutMs` | `120000` | per-image caption deadline |
| `concurrency` | `2` | images captioned in parallel |
| `maxImagesPerRequest` | `12` | images bridged per request; extras fall back to the built-in placeholder |
| `cache` | `true` | one caption per attachment id for the process lifetime |
| `onError` | `keep` | `keep` leaves the image block (harness placeholder); `note` replaces it with an explanation |
| `advertiseImages` | `true` | report `image` for the routes; `false` only rewrites already-admitted requests |
| `debug` | `false` | verbose logging |

## What it looks like in use

No workflow change:

- attach a screenshot → send → the model receives `[image …]` plus a description and can act on it;
- ask the model to `read_image` a local png → the tool result image is described the same way;
- the transcript keeps showing the image (the session log is untouched);
- switching to a genuinely image-capable model makes the plugin a no-op.

## Notes

- **One extra model call per new image.** Cached per process; expect a few seconds of latency and vision-model tokens.
- **Quality is the vision backend's.** The plugin only turns pixels into words; it does not give the text model pixel-level reasoning.
- **Not an OCR replacement.** The built-in prompt asks for verbatim transcription, but dense layouts can still lose characters — paste critical text as text too.
- **It relies on three service methods** (`resolveModelInfo`, `prepareCall`, `stream`). If a future DSH release changes them, the plugin logs a warning and degrades to pass-through instead of breaking the original behaviour.
- **No image ever reaches the provider.** Only text is sent, so gateway image limits, pricing and moderation are unaffected.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| still `does not support image input` | `routes` does not match; use the provider key from Settings → Models (e.g. `commandcode-deepseek`), not the display name |
| log says `vision route … does not accept image input` | `vision.provider/model` is not image capable itself — pick a real vision model |
| log says `vision endpoint credentials are missing` | the `apiKeyEnv` variable is not visible to DSH; use `apiKey` or a system env var plus restart |
| image is accepted but the model cannot see it | check the log for `bridging image input for [...]`; if missing, the plugin is not mounted for that route |
| descriptions are too long or too short | override `prompt` |

Log lines are prefixed with `[vision-bridge]`.

## Development

```bash
node --test test/unit/                  # 25 offline tests
node --test test/real-runtime.test.mjs  # 5 tests against @deepseek-ai/dsh-llm (skipped when unresolvable)
```

The integration test was also run against a real DSH profile — pi-ai adapter, a route declaring only `text`, the real attachment service and the real request projection. With a stub vision API, a 1163x3388 screenshot reached the text-only model as:

```text
[image 1163x3388 image/png sha256:4cecd5af]
A screenshot. Visible text reads exactly: MAGIC-CAPTION-42.
<the user's own words>
```

That request contained no image bytes at all.

| File | Role |
| --- | --- |
| `lib/index.js` | plugin entry (`apply` / `inject` / `name`) |
| `lib/config.js` | configuration normalization and route matching |
| `lib/bridge.js` | service patches, request rewrite, caption cache |
| `lib/captions.js` | the two vision backends |

## License

MIT



