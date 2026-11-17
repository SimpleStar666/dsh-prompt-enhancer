# 设计与契约：一键模型改写，证据优先，绝不自动发送

## v0.3 的定位

v0.1 的固定五段模板伪造缺失；v0.2 的本地规则诚实但朴素。v0.3 重构为**输入框一键模型改写**：草稿经 DSH 已配置模型重写后回填输入框，用户审阅后自行发送。本地证据提取不再直接呈现给用户，而是**喂给改写元提示词**，确保模型把已表达事实当作既定、不把用户说过的范围反问回来。

参考同类项目（均以 GitHub 链接为准）：[AntMan-xtalgh/dsh-prompt-enhance](https://github.com/AntMan-xtalgh/dsh-prompt-enhance)、[saul-dsh/dsh-prompt-enhancer](https://github.com/saul-dsh/dsh-prompt-enhancer) 等。借鉴点：`ctx.llm.stream()` 调用协议、`conversation.input.right` 槽位、失败 fail-open、输出失控守卫、撤销快照。拒绝点：自动拦截发送、澄清卡片、第三方免费通道。

## 模型调用（dsh-llm 契约）

宿主端通过 `ctx.llm.stream(options)` 调用 DSH 官方 `@deepseek-ai/dsh-llm` 服务（已由 dsh-base bundle 挂载，本机验证）。请求形状：

```js
{
  provider, model, maxTokens,
  reasoningEffort,                  // v0.3.3：auto 时自动选最低可用档位
  system: buildMetaPrompt(...),     // 改写规则 + 本地证据
  messages: [{ role: 'user', content: [{ type: 'text', text: raw }] }],
  purpose: 'prompt-enhancer',       // 单独计量，不进会话历史
  signal: AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]),
}
```

**推理档位与首 token 延迟（v0.3.3 性能路径）**：v0.3.2 及之前不传 `reasoningEffort`，dsh-llm 会落回 provider/模型自身的默认推理档（运行时证据：`dsh-llm-pi-ai` 的 `options.reasoningEffort ?? profile.reasoning`，推理模型的 `thinking_*` 事件以 `reasoning-delta` 在文本前流式输出）。对话默认档（如 high）下模型先“思考”几十秒才吐文本——这正是「增强要等很久」的根因，与参考插件对比也解释得通。v0.3.3 修复：

- **自动最省档位**：`reasoningEffort: 'auto'`（默认）时，通过官方能力接缝 `llm.prepareCall(config, signal, configure)` 同步捕获精确模型元数据（`reasoning.efforts` 与 `defaultEffort`），按 `minimal → low → off → medium` 顺序选**最低受支持**的档位，并返回绑定该配置的 `stream` 直接派发（`prepareCall` 的 `stream` 会校验最终请求与已解析配置一致）。
- **显式档位**：配置 `off/minimal/low/medium/high/xhigh/max` 时按字面发送；模型不支持则逐个降级，全部被拒则退回路由默认（fail-open，绝不因档位探测阻塞增强）。
- **无接缝回退**：宿主没有 `prepareCall` 时，显式档位透传、`auto` 省略字段由路由默认决定——行为与 v0.3.2 一致。
- **输出预算**：`maxTokens` 默认 2048 → **768**（简洁风格几百 token 足够；对“思考与回答共享输出上限”的免费中继，较小上限也会压低思考量）。
- **请求最小化**：草稿不再同时嵌入 system 与 user 消息；system 只含规则与短证据列表，草稿作为唯一 user 消息发送。
- **可观测**：响应新增 `metrics`（`totalMs`、`textMs`、`reasoningMs`、`reasoningEffort`、`maxTokens`、`warnings`），首文本/首推理耗时一眼可查；tooltip 在超时时同时提示「可尝试降低推理档位」。
- **延迟归因**：若增强路由落在免费共享中继（`dsh-our-free-model` 等），其首 token 排队由上游号池决定（该插件自带公告：34–221 秒首 token 来自上游排队），插件无法缩短；需要秒级响应时应在插件配置里把 `provider`/`model` 指向本地代理或官方 API。

流块协议：`text-delta` 累加；`reasoning-delta` 丢弃（但记录首推理耗时）；`usage` 忽略；终末 `finish.reason.kind` 为 `stop`/`max-tokens`/`aborted`/`error`。`error`/`aborted`/空文本的 `max-tokens` 抛错；流未结束即断流视为失败。插件默认总超时 120 秒，避免推理模型尚未吐出首 token 就被误取消；超时会明确显示 `timed out`，而不是伪装成用户取消。浏览器断开请求时也会把 `request.signal` 传入模型。所有失败 fail-open：保留原文、tooltip 说明，绝不阻塞。

改写元提示词（`src/rewrite.mjs`）v0.3.5 与参考实现对齐（复盘：为什么之前效果不一样）：旧提示词把本地规则提取的「目标：/交付物：」标签证据注入 system，模型会**模仿标签格式**输出小标题结构；同时“缺失细节用 (默认：…) 补齐、禁止展开”的条款抑制了参考实现标志性的**泛化能力补充**（“这类任务通常需要什么”：可调参数、预设、预览、持久化、验收行为）。参考实现的 system 只有一段短规则：保留原意/语言/全部具体事实 → 把“做什么、对什么、什么算完成”说全 → 按任务种类补泛化能力 → situational 具体选择（平台/技术栈/文件名）不替用户拍板、写进请求让执行者明确或条件化 → 一段流畅文字、无小标题无 markdown → 只输出改写文本。语言默认跟随草稿，`locale` 配置可强制覆盖。本地证据分析（intent.mjs）不再进入改写请求，仅用于响应的 `recognizedFacts`/`riskFlags` 元数据。输出兜底 `cleanModelOutput` 会剥掉围栏、引号、前缀与漏网的 markdown（`#`、`**`、`-` 列表符），保证纯文本输入框干净。

守卫：输出清掉代码围栏/引号/标签前缀；空输出失败；长度超过 `max(600, 输入长 × 3.5)` 且封顶 4000 字符视为失控、弃用并保留原文。

## 模型路由解析（按优先级）

1. 插件配置 `provider` + `model`（显式指定）。
2. 请求体 `route`（客户端/调用方提示）。
3. `agent/created` 通知事件记住的会话路由（`session.requestHeader()?.config` / `requestHeader()?.config` / `options`）。
4. `ctx.agentDefaultModel.currentSelection()`（全局默认选择，尽力而为）。

**绝不订阅瀑布流事件**（`agent/pre-step`、`llm/stream` 等需要调用 `next()` 的管道）：不调用 `next()` 的监听器会卡死整个 Agent 循环，表现为每次运行都失败、禁用插件后恢复。

全部缺失时返回 409 及可操作的提示，绝不猜测路由。

## Host 路由

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/api/prompt-enhancer/enhance` | POST | 模型改写；成功返回 `{ok, enhancedPrompt, originalPrompt, route, metrics, recognizedFacts, reviewNotes, config}`，失败返回原文 + error（200 fail-open；413 超长、409 无路由、503 无 llm） |
| `/api/prompt-enhancer/route` | POST | 写入本次会话路由提示 `{route:{provider,model}}` |
| `/api/prompt-enhancer/config` | GET/POST | 运行时配置，仅内存，不持久化 |

`connection` 与 `llm` 均为可选依赖，防御式获取（`ctx.get()` 回退），headless 宿主可安全启动。`cache-control: no-store`；effect 清理全部注册。

## 客户端（输入框按钮）

- 挂载 `conversation.input.right` 槽位（order -10），仅依赖 React；`dsh.client.inject` 指向 `@deepseek-ai/dsh-client-ui-conversation`。
- 读草稿优先用 `useInput` 快照，缺失时读 `[data-composer-input]` DOM 兜底；写回走 `inputActions.setDraft`。没有 `inputActions`/`sessionId` 时按钮不渲染。
- 状态机：idle → busy（转圈）→ success（回填 + 保存原文快照，按钮变撤销）→ 用户手改草稿后撤销失效。失败/空草稿显示 ✕ tooltip，4 秒消退；不覆盖草稿。busy 期间点击忽略；卸载后旧响应不写入。
- 永不自动 `submit()`；不注册发送拦截。

## 兼容性与弃用

v0.2 的 `enhancePrompt` / `detectGaps` / `normalizeText` / `containsSensitiveData` 保留导出。`confidence` 恒 0。`addSectionLabels` / `includeAssumptions` / `includeQuestions` 为无操作兼容项。旧侧栏 tab 已移除（v0.3 只有输入框按钮）。

## 验证边界

88 项测试 + 13 项契约检查覆盖：证据提取回归（含真实用户案例与对抗反例）、改写协议（含推理档位选择、首 token 计时、超时/取消区分）、路由优先级、错误码、按钮状态机、真实 pack/解包。**不代表真实模型输出质量或真实页面 E2E**；v0.3 的模型调用尚未在真实 DSH 页面端到端验收。安装与启用状态以插件管理工具结果为准。
