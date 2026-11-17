# dsh-prompt-enhancer

**提示词增强 v0.3.0**：DSH 输入框里的一键增强按钮 ✨。点击一次，当前草稿经 DSH 已配置的模型改写后回填输入框，供你审阅后再发送；再点一次撤销，恢复精确原文。**从不自动发送。**

## 为什么是 v0.3

v0.1 的固定五段模板是“睁眼说瞎话”；v0.2 的本地规则只贴原文证据、体验朴素。v0.3 重构为与主流提示词增强一致的一键模型改写（参考 [AntMan-xtalgh/dsh-prompt-enhance](https://github.com/AntMan-xtalgh/dsh-prompt-enhance)、[saul-dsh/dsh-prompt-enhancer](https://github.com/saul-dsh/dsh-prompt-enhancer) 等同类项目），同时保留 v0.2 的证据优先内核：

- **模型改写**：通过 DSH 官方 `ctx.llm.stream()` 服务调用已配置模型（`@deepseek-ai/dsh-llm`），无需自己填 API key，无需额外依赖。
- **本地证据喂给模型**：改写前用本地规则提取原文线索（目标、交付物、环境、已列范围等），作为“已表达事实”写入改写指令，模型不会把你的范围反问回来，也不把已说过的当缺失。
- **一键交互**：输入框 ✨ → 点击 → 转圈 → 增强稿回填 → 审阅 → 发送。再点 ✨ 撤销恢复原文；你在草稿里手动改过后，撤销自动失效，绝不覆盖你的修改。
- **诚实边界**：失败（无模型路由、超时、模型报错、输出失控）一律保留原文并在按钮 tooltip 说明原因，绝不阻塞发送。改写调用带 `purpose` 标记、不进会话历史。
- 不调用第三方免费通道、不读历史、不上传遥测、不持久化输入、不自动回填发送。

## 安装与升级

项目尚未发布到 npm。克隆仓库或解包后在 DSH「插件」→「添加插件」安装项目目录；或提供包文件由 DSH 安装。安装后重载，输入框会多出 ✨ 按钮。旧版已装时用新包/目录重新安装以更新快照。开发源码不自动改变已安装副本。

## 用法与边界

输入 → 点击 ✨ → 审阅改写稿 → 编辑/撤销 → 发送。增强由模型生成，仅保留原意与事实，**不保证没有补充细节**；发送前请审阅。

**模型调用说明**：草稿会随请求发送给 DSH 已配置的模型（`purpose: 'prompt-enhancer'`，单独计量）。默认跟随当前会话的模型路由；可在插件配置中指定 `provider` / `model`，或通过 `/api/prompt-enhancer/route` 传入。本地规则提取（意图/交付物/范围）不调用模型、不联网。

## API 与兼容性

```js
import { rewriteWithLlm, enhancePrompt } from 'dsh-prompt-enhancer';
// rewriteWithLlm(llm, { provider, model }, raw, { locale, maxTokens, timeoutMs })
// enhancePrompt(...) 仍为 v0.2 的本地证据分析，结果喂给改写元提示词
```

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭后停用增强，保留原文 |
| `locale` | `auto` | 改写指令语言与按钮文案 |
| `provider` / `model` | 空 | 改写路由；留空跟随当前会话/agent 路由 |
| `maxTokens` | `2048` | 单次改写输出 token 上限（256–16384） |
| `timeoutMs` | `20000` | 改写超时（1000–120000） |
| `maxPromptChars` | `12000` | 输入超过此长度拒发模型、保留原文 |
| `includeRisks` | `true` | 敏感线索提示 |

保留 v0.2 兼容字段：`enhancePrompt`、`detectGaps`、`recognizedFacts`、`clarifications`、`changeSet`、`assumptions`、`missingQuestions`、`confidence`（恒 0，无假评分）。`addSectionLabels` / `includeAssumptions` / `includeQuestions` 为兼容无操作项。

## 开发与验证

Node.js **>=22.19.0**，无第三方运行时依赖：

```powershell
node --test test/*.test.mjs
node tools/check-plugin-contract.mjs
node --check client.js && node --check index.js
# 或 pnpm run verify / npm run verify
```

测试分层：核心证据提取（含真实用户回归与反例）、模型改写协议（dsh-llm chunk/finish/超时/失控守卫）、Host 路由（模型/路由/配置/错误码）、客户端按钮（一键/撤销/失败/陈旧响应/防重复）、真实 pack 与解包契约。v0.1/v0.2 曾在当前 DSH profile 成功安装并被实际使用；v0.3 的模型调用与真实页面交互尚未端到端验收，安装状态以安装工具结果为准。

更多细节见[设计与契约](./docs/DETAIL.md)。[MIT License](./LICENSE)。
