# 设计与契约：一键模型改写，证据优先，绝不自动发送

## v0.3 的定位

v0.1 的固定五段模板伪造缺失；v0.2 的本地规则诚实但朴素。v0.3 重构为**输入框一键模型改写**：草稿经 DSH 已配置模型重写后回填输入框，用户审阅后自行发送。本地证据提取不再直接呈现给用户，而是**喂给改写元提示词**，确保模型把已表达事实当作既定、不把用户说过的范围反问回来。

参考同类项目（均以 GitHub 链接为准）：[AntMan-xtalgh/dsh-prompt-enhance](https://github.com/AntMan-xtalgh/dsh-prompt-enhance)、[saul-dsh/dsh-prompt-enhancer](https://github.com/saul-dsh/dsh-prompt-enhancer) 等。借鉴点：`ctx.llm.stream()` 调用协议、`conversation.input.right` 槽位、失败 fail-open、输出失控守卫、撤销快照。拒绝点：自动拦截发送、澄清卡片、第三方免费通道。

## 模型调用（dsh-llm 契约）

宿主端通过 `ctx.llm.stream(options)` 调用 DSH 官方 `@deepseek-ai/dsh-llm` 服务（已由 dsh-base bundle 挂载，本机验证）。请求形状：

```js
{
  provider, model, maxTokens,
  system: buildMetaPrompt(...),   // 改写规则 + 本地证据
  messages: [{ role: 'user', content: [{ type: 'text', text: raw }] }],
  purpose: 'prompt-enhancer',      // 单独计量，不进会话历史
  signal: AbortSignal.timeout(timeoutMs),
}
```

流块协议：`text-delta` 累加；`reasoning-delta` 丢弃；`usage` 忽略；终末 `finish.reason.kind` 为 `stop`/`max-tokens`/`aborted`/`error`。`error`/`aborted`/空文本的 `max-tokens` 抛错；流未结束即断流视为失败。所有失败 fail-open：保留原文、tooltip 说明，绝不阻塞。

改写元提示词（`src/rewrite.mjs`）要求：保留原意/语言/全部具体事实；不发明技术栈/路径/数字；不回答、不反问、不写前言；未知细节用内联默认或条件要求补齐；仅输出改写文本。本地证据（目标、交付物、环境、已列范围、约束、格式、验收）以“已表达，视为既定”列出；本地澄清建议转成“用默认/条件补齐，禁止再问”。

守卫：输出清掉代码围栏/引号/标签前缀；空输出失败；长度超过 `max(600, 输入长 × 3.5)` 且封顶 4000 字符视为失控、弃用并保留原文。

## 模型路由解析（按优先级）

1. 插件配置 `provider` + `model`（显式指定）。
2. 请求体 `route`（客户端/调用方提示）。
3. `agent/created`、`agent/pre-step` 事件记住的会话路由（`session.requestHeader()?.config` / `requestHeader()?.config` / `options`）。
4. `ctx.agentDefaultModel.currentSelection()`（全局默认选择，尽力而为）。

全部缺失时返回 409 及可操作的提示，绝不猜测路由。

## Host 路由

| 路径 | 方法 | 说明 |
| --- | --- | --- |
| `/api/prompt-enhancer/enhance` | POST | 模型改写；成功返回 `{ok, enhancedPrompt, originalPrompt, route, recognizedFacts, reviewNotes, config}`，失败返回原文 + error（200 fail-open；413 超长、409 无路由、503 无 llm） |
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

77 项测试 + 13 项契约检查覆盖：证据提取回归（含真实用户案例与对抗反例）、改写协议、路由优先级、错误码、按钮状态机、真实 pack/解包。**不代表真实模型输出质量或真实页面 E2E**；v0.3 的模型调用尚未在真实 DSH 页面端到端验收。安装与启用状态以插件管理工具结果为准。
