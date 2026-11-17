# dsh-prompt-enhancer

**提示词增强 v0.3.5**：DSH 输入框里的一键增强按钮 ✨。点击一次，当前草稿经 DSH 已配置的模型改写后回填输入框，供你审阅后再发送；再点一次撤销，恢复精确原文。**从不自动发送。**

## 为什么是 v0.3

v0.1 的固定五段模板是“睁眼说瞎话”；v0.2 的本地规则只贴原文证据、体验朴素。v0.3 重构为与主流提示词增强一致的一键模型改写（参考 [AntMan-xtalgh/dsh-prompt-enhance](https://github.com/AntMan-xtalgh/dsh-prompt-enhance)、[saul-dsh/dsh-prompt-enhancer](https://github.com/saul-dsh/dsh-prompt-enhancer) 等同类项目）。v0.3.5 把**改写风格**也对齐了参考实现，差异点复盘：

- **为什么之前“效果不一样”**：旧元提示词把本地规则提取的「目标：… 交付物：…」标签证据注入 system，并强制“缺失细节用 (默认：…) 补齐、禁止展开”——模型既模仿了标签格式（输出小标题结构），又不敢像参考实现那样按“这类任务通常需要什么能力”做泛化补充。参考实现的 system 只有一段短规则：保留原意与具体事实、把目标说全、按任务种类补泛化能力（可调参数/预设/预览/持久化/验收）， situational 的具体选择（平台/技术栈）留给执行者明确而不是编造。v0.3.5 照此重写。
- **输出兜底**：模型偶尔漏出 markdown（`##`、`**`），输入框是纯文本——统一剥成纯文本（对齐 saul 的 cleanModelOutput）。
- **模型改写**：通过 DSH 官方 `ctx.llm.stream()` 服务调用已配置模型（`@deepseek-ai/dsh-llm`），无需自己填 API key，无需额外依赖。草稿只发送一次（单条 user 消息）。
- **快而不贵（v0.3.3+）**：增强默认走该模型**最低受支持的推理档位**（`auto` → 按 `minimal → low → off` 探测，经 `llm.prepareCall` 能力接缝精确解析），输出预算 768 token。可在配置里用 `reasoningEffort` 显式指定档位。
- **延迟的大头在模型提供方**：如果增强路由指向免费中继（如 `loomy` 等共享号池），其首 token 排队可达几十秒到数分钟——这是上行池排队，不是插件逻辑。需要秒级响应时，请在插件配置里把 `provider`/`model` 指向你自己可用的快模型（本地代理或官方 API）。
- **一键交互**：输入框 ✨ → 点击 → 转圈 → 增强稿回填 → 审阅 → 发送。再点 ✨ 撤销恢复原文；你在草稿里手动改过后，撤销自动失效，绝不覆盖你的修改。
- **诚实边界**：失败（无模型路由、超时、模型报错、输出失控）一律保留原文并在按钮 tooltip 说明原因，绝不阻塞发送。改写调用带 `purpose` 标记、不进会话历史；响应带 `metrics`（总耗时/首 token 耗时/实际档位）。
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
| `reasoningEffort` | `auto` | 改写推理档位；`auto` 自动选最低受支持档（minimal→low→off），或显式 `off/minimal/low/medium/high/xhigh/max` |
| `maxTokens` | `768` | 单次改写输出 token 上限（256–16384） |
| `timeoutMs` | `120000` | 改写超时（1000–300000）；DeepSeek-V4-Pro 等推理模型可能需要较长首 token 时间 |
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
