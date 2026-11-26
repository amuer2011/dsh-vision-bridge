# dsh-vision-bridge

给 DeepSeek Harness 里**不支持视觉的文本模型**补上图片输入：照常贴图，插件先用视觉模型"看一眼"，再把图片转成描述交给文本模型。

> 典型场景：`commandcode-deepseek`、`shenwen` 这类只提供 DeepSeek 文本模型的中转分组。选中它们后贴图发送，会看到 `Model "deepseek-v4.1-flash" does not support image input.`（`MODEL_DOES_NOT_SUPPORT_IMAGES`），`read_image` 工具也会拒绝读图。

[English README](README.en.md)

---

## 问题是什么

DSH 在 prompt 准入阶段按模型声明的输入模态判断：

```js
// dsh-api-session-controller: session/prompt
if (model.inputModalities !== void 0 && !model.inputModalities.includes('image'))
  throw new RemoteError('session/attachment-invalid',
    `Model "${model}" does not support image input.`, { reason: 'MODEL_DOES_NOT_SUPPORT_IMAGES' })
```

pi-ai 适配器的 `defaultInput` 默认是 `['text']`，所以任何没有显式声明 `input: [text, image]` 的路由都会被直接拒收图片。即使绕过准入，运行时会把它降级成一行字：

```
[image omitted because this model accepts text only; attachment sha256:1a2b3c4d]
```

对模型来说，这张图等于不存在。

## 已经兼容的 provider

| Provider 路由 | 模型 | 需要插件吗 | 状态 |
| --- | --- | --- | --- |
| `deepseek-official` / `deepseek-account`（DeepSeek 官方账号） | `deepseek-flash` | 不需要，原生支持读图 | ✅ 实测：直接把截图内容读出来了，插件会自动跳过 |
| `commandcode-deepseek` | `deepseek-flash` | 需要（纯文本模型） | ✅ 实测：桥接生效，用 `deepseek-official/deepseek-flash` 当眼睛，贴图后模型准确描述了 Arthas `dashboard` 截图 |
| `shenwen` | `deepseek-v4.1-flash` | 需要 | ⚠️ 代码路径与 `commandcode-deepseek` 完全相同（pi-ai + `openai-responses`），但本机到 `api.shenwenai.com` TLS 连不通，未实测 |
| 任意 `@deepseek-ai/dsh-llm-pi-ai` 文本路由 | — | 需要 | ✅ 通用：用只声明 `text` 的桩路由跑通了端到端 |

只要路由走 pi-ai 适配器、且没有声明 `image` 输入，把它的 provider key 加进 `routes` 就能用；配一个能看图的视觉后端即可，最省事的就是拿官方账号的 `deepseek-flash` 当眼睛：

```yaml
- id: vision-bridge
  name: 'dsh-vision-bridge'
  config:
    routes: ['commandcode-deepseek', 'shenwen']
    vision:
      backend: route
      provider: deepseek-account     # 你 profile 里官方账号路由的 key
      model: deepseek-flash
```

> 路由 key 以「设置 → 模型」里显示的为准：Desktop 0.2.1 里官方账号路由叫 `deepseek-account`，CLI 0.2.0 里叫 `deepseek-official`。

## 插件做了什么

1. **放开准入**：包装 `ctx.llm.resolveModelInfo`，给命中的路由补上 `image` 输入模态。上传图片、`read_image` 工具结果都能正常进入会话（只影响能力查询，不改变适配器真实收发的内容）。
2. **把图变成文字**：包装 `ctx.llm.prepareCall` / `ctx.llm.stream`，在请求真正发出去之前，把每个 `image` 内容块替换成一段文字：

   ```
   [image "error.png" 1280x720 image/png sha256:1a2b3c4d]
   一张 Windows 终端截图。正在运行的命令是 `pnpm test`，输出最后 6 行：
   FAIL src/api.test.ts > rejects expired tokens
   AssertionError: expected 401 to be 200
   ...
   ```

   描述由**视觉后端**生成，支持两种：

   | 后端 | 说明 |
   | --- | --- |
   | `route` | 直接复用当前 DSH 里已经配置好的、支持视觉的模型路由（不用再配 key） |
   | `endpoint` | 任意 OpenAI 兼容的视觉 API（`chat/completions` 或 `responses`），自己填 baseURL + key |

3. **不污染会话**：会话日志原样保留图片，历史记录里仍然能看到缩略图；描述只存在于那次请求里。模型切回真正支持视觉的路由时，插件自动跳过，不做任何改写。

## 安装

插件是一个普通的 DSH bundle 包（`dsh.bundle.patch` + `cordis.patch.yml`），装完即在 profile 里插入一行 `vision-bridge`。

**方式 A（推荐，图形界面）**

1. 打开 Web 侧边栏 → **插件 / Plugins**；
2. 点**安装**，填 GitHub 地址：
   `github:<你的用户名>/dsh-vision-bridge`
3. 安装完成后按下面的「配置」补上 `vision`。

**方式 B（命令行）**

```bash
# Desktop 版 profile 名为 desktop
dsh plugin --profile desktop add github:<你的用户名>/dsh-vision-bridge
# 本地开发时可以直接指向目录
dsh plugin --profile desktop add file:D:/code/dsh-vision-bridge
```

装好后编辑 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`（Desktop 默认是 `C:\Users\<你>\.dsh\profiles\desktop\cordis.patch.yml`），把这一行改成你的配置。

## 配置

配置文件位置：`$DSH_HOME/profiles/desktop/cordis.patch.yml`。用 `id: vision-bridge` 覆盖插件自带的默认行。

### 方案一：复用已有的视觉模型路由

```yaml
- id: vision-bridge
  name: 'dsh-vision-bridge'
  config:
    routes: ['commandcode-deepseek', 'shenwen']
    vision:
      backend: route
      provider: openrouter          # 任意已配置、支持图片输入的路由
      model: qwen2.5-vl-72b-instruct
```

`provider` 就是「设置 → 模型」里那个路由的 key；`model` 必须是该路由下真正支持图片的模型。

### 方案二：外部 OpenAI 兼容视觉 API

```yaml
- id: vision-bridge
  name: 'dsh-vision-bridge'
  config:
    routes: ['commandcode-deepseek', 'shenwen']
    vision:
      backend: endpoint
      api: chat-completions          # 或 responses
      baseURL: https://api.example.com/v1
      model: gpt-4o-mini
      apiKeyEnv: VISION_API_KEY      # 也可以直接写 apiKey: sk-...
      # headers:                     # 需要额外请求头时
      #   x-custom: value
```

`apiKeyEnv` 指向的环境变量要在启动 DSH 的环境里可见（Desktop 版建议直接写 `apiKey`，或写进系统环境变量后重启应用）。

### 完整参数

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `routes` | `['*']` | 要桥接的路由。`provider`、`provider/model`，支持 `*` 通配；`'*'` 表示所有文本模型路由 |
| `vision.backend` | 自动 | `route` 或 `endpoint`；填了 `baseURL` 时自动为 `endpoint` |
| `vision.provider` / `vision.model` | — | `route` 后端必填 |
| `vision.baseURL` / `vision.model` | — | `endpoint` 后端必填 |
| `vision.api` | `chat-completions` | `chat-completions` 或 `responses` |
| `vision.apiKey` / `vision.apiKeyEnv` | — | `endpoint` 后端的鉴权 |
| `vision.headers` | `{}` | 额外请求头 |
| `prompt` | 内置 | 描述图片用的指令。内置要求转写关键行（命令 / 报错 / 栈帧）、压缩重复内容、控制在 400 词内 |
| `timeoutMs` | `120000` | 单张图的描述超时 |
| `concurrency` | `2` | 同时描述几张图 |
| `maxImagesPerRequest` | `12` | 单次请求最多处理几张图，多余的交给内置占位符 |
| `cache` | `true` | 同一张图（同一 `attachmentId`）只描述一次，进程内缓存 |
| `onError` | `keep` | 失败时：`keep` 保留图片块（由 DSH 输出占位符）；`note` 换成一段说明让模型知道有图但没看到 |
| `advertiseImages` | `true` | 是否给命中路由补 `image` 模态；设成 `false` 时只改写请求、不放宽准入 |
| `debug` | `false` | 输出调试日志 |

## 使用效果

配置好之后不需要改变任何操作：

- 贴一张截图 → 发送 → 模型收到 `[image ...]` + 详细描述，可以正常回答、改代码；
- 让模型 `read_image` 某个本地 png → 工具结果里的图片同样被转成描述；
- 历史里图片仍然可见（会话日志没被改写）；
- 切到一个真正支持视觉的模型 → 插件自动不介入。

## 注意事项

- **多一次模型调用**：每张新图会调用一次视觉后端（按进程缓存，同一张图不重复调用）。带图请求会慢几秒，也会产生视觉模型的 token 费用。
- **描述质量取决于视觉后端**：插件只负责"看图 → 文字"，不改变文本模型本身的能力，别指望它做像素级判断。
- **不是 OCR 替代品**：内置 prompt 会要求逐字转写可见文字，但复杂版式仍可能漏字，重要内容建议同时把文字贴出来。
- **依赖内部方法**：插件包装 `resolveModelInfo` / `prepareCall` / `stream` 三个服务方法。DSH 升级若改了这几处，插件会打一条 warning 并退化为"只放行、不改写"或完全不介入，不会让原有功能坏掉。
- **图片仍然不会发给 provider**：全文只发文字，所以中转/网关的图片限制、计费、审核都不受影响。

## 排障

| 现象 | 处理 |
| --- | --- |
| 仍然报 `does not support image input` | `routes` 没匹配上。provider key 是「设置 → 模型」里的那一栏（例如 `commandcode-deepseek`），不是显示名 |
| 日志出现 `vision route ... does not accept image input` | `vision.provider/model` 指向的模型本身也不支持图片，换一个真正的视觉模型 |
| 日志出现 `vision endpoint credentials are missing` | `apiKeyEnv` 的环境变量没生效；Desktop 版直接用 `apiKey`，或写系统环境变量后重启 |
| 图片能发出去但模型说看不到 | 说明插件没插桩成功（看日志有没有 `bridging image input for [...]`），或 `provider`/`model` 与请求实际使用的不一致 |
| 描述太啰嗦 / 太简略 | 用 `prompt` 覆盖内置指令 |

插件的日志前缀是 `[vision-bridge]`。

## 开发

```bash
node --test test/unit/                  # 25 个离线测试：请求改写、缓存、并发、失败回退、endpoint 后端
node --test test/real-runtime.test.mjs  # 5 个针对真实 @deepseek-ai/dsh-llm 的集成测试（装不到依赖时自动跳过）
```

集成测试在一个真实的 DSH profile 里验证过整条链路：pi-ai 适配器 + 只声明 `text` 的路由 + 真实附件服务 + 真实请求投影。
用桩视觉 API 提交一张 1163×3388 的截图后，文本模型实际收到的是

```
[image 1163x3388 image/png sha256:4cecd5af]
A screenshot. Visible text reads exactly: MAGIC-CAPTION-42.
<用户原话>
```

即请求体里没有任何图片数据，只有视觉后端生成的描述。

代码结构：

| 文件 | 职责 |
| --- | --- |
| `lib/index.js` | 插件入口（`apply` / `inject` / `name`） |
| `lib/config.js` | 配置规范化、路由匹配 |
| `lib/bridge.js` | 服务打补丁、请求改写、描述缓存 |
| `lib/captions.js` | 两个视觉后端：DSH 路由 / OpenAI 兼容 endpoint |

## License

MIT


