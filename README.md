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

装好后**通常什么都不用配**：插件默认 `routes: ['*']` + 自动探测视觉后端。想改行为时，编辑 profile 的 patch 文件：

```
C:\Users\<你>\.dsh\profiles\desktop\cordis.patch.yml
```

（就是 DSH 的 profile 补丁文件，一个 YAML 列表；安装插件后它里面本来就有别的行，在末尾追加 `- id: vision-bridge` 那一段即可，保存后 HMR 会自动重载。）

## 配置

### 方案零：零配置（默认）

什么都不写，插件在**第一次遇到图片时**自动挑一个能看图的模型当眼睛。探测顺序：

1. `vision.prefer` 里点名的路由；
2. **当前 profile 的默认模型**（设置 → 模型里选中的那个）；
3. 各 provider 的模型目录里声明了 `image` 输入的模型；
4. 每个 provider 上试 `vision.autoModels`（默认 `['deepseek-flash', 'deepseek-v4.1-flash']`）。

每个候选都会用适配器真实的 `inputModalities` 校验，文本模型会被跳过；某个候选失败会自动换下一个。选中的路由写进日志：`[vision-bridge] auto vision: <provider>/<model>`。

> 你的环境里默认模型是 `deepseek-account/deepseek-flash`（原生支持读图），所以会被直接选中当眼睛——`commandcode-deepseek`、`shenwen` 的会话里贴图就能用。

### 方案一：复用已有的视觉模型路由（想固定用哪个时）

```yaml
- id: vision-bridge
  name: 'dsh-vision-bridge'
  config:
    routes: ['commandcode-deepseek', 'shenwen']
    vision:
      backend: route
      provider: deepseek-account     # 任意已配置、支持图片输入的路由
      model: deepseek-flash
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
| `vision.backend` | `auto` | `auto` / `route` / `endpoint`；填了 `baseURL` 时自动为 `endpoint`，只填 `provider`+`model` 时为 `route` |
| `vision.prefer` | `[]` | `auto` 模式下优先尝试的路由（`provider` 或 `provider/model`） |
| `vision.autoModels` | `['deepseek-flash', 'deepseek-v4.1-flash']` | `auto` 模式下在每个 provider 上试探的模型 id |
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
| `compat.emptyToolArguments` | `false` | 把「无参数工具调用」的空 `{}` 改写成 `{"_":true}` 再发出。某些会转成 Anthropic Messages 的中转（如 sub2api）会丢弃空 `input`，带 `working_directory` / `job_list` / `get_goal` 这类零参数工具的一轮直接 400 |
| `debug` | `false` | 输出调试日志；打开后会额外写到 `$DSH_HOME/vision-bridge-debug.log`（可用 `debugFile` 指定路径），桌面版排障就靠它 |

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
| 自动探测没找到视觉模型（日志 `no image-capable route was found`） | 显式写 `vision.provider` + `vision.model`，或用 `vision.autoModels` 补上你环境里的视觉模型 id |
| 自动探测挑错了模型 | 用 `vision.prefer: ['deepseek-account']` 或直接写死 `provider` + `model` |
| 日志出现 `vision route ... does not accept image input` | `vision.provider/model` 指向的模型本身也不支持图片，换一个真正的视觉模型 |
| 日志出现 `vision endpoint credentials are missing` | `apiKeyEnv` 的环境变量没生效；Desktop 版直接用 `apiKey`，或写系统环境变量后重启 |
| 图片能发出去但模型说看不到 | 看日志有没有 `bridging image input for [...]` 和 `auto vision: p/m`，再确认这次请求用的 provider 在 `routes` 范围内 |
| 描述太啰嗦 / 太简略 | 用 `prompt` 覆盖内置指令 |
| 某轮突然 `400 ... expected nonoptional, received undefined at "…input"`，且这一轮调用过 `working_directory` / `job_list` / `get_goal` 这类零参数工具 | 中转（sub2api 之类）把空的 Anthropic `tool_use.input` 丢了。开 `compat: { emptyToolArguments: true }`（与图片无关，不开也会犯） |

插件的日志前缀是 `[vision-bridge]`。

## 开发

```bash
node --test test/unit/                  # 33 个离线测试：请求改写、缓存、并发、失败回退、endpoint 后端
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





