# dsh-prompt-enhancer

**想法增强 v0.2.0**：DSH 右侧栏中的本地线索整理工具。先展示原文已经表达的信息，再提出少量可选澄清；只有你填写的回答才会进入草稿。**不是大模型改写器，不再用固定五项模板冒充增强。**

## 为什么重做

v0.1 把“关键词未命中”当成“用户没有写”，会对“我想做一个美化dsh交互界面的插件”错误地要求重填目标和格式。v0.2 删除这种缺口清单与完整度评分：

- **原文中已表达**：用原文引用及位置展示目标/任务、交付物、使用环境等线索，不把推断写成事实。
- **交付物不等于排版格式**：“插件”是交付物；Markdown/JSON 是回答格式，没有指定后者不构成缺陷。
- **可选澄清**：只针对已识别任务的具体不确定性，例如“美化哪些界面部分，有没有风格参考”；不凑背景/约束/验收五件套。当前规则最多一条，客户端接受最多两条。
- **可操作的补充**：填写回答后点击“将回答加入草稿”，仅追加非空用户回答；应用后可直接编辑稿子，不反复自动覆盖。
- **原文已保留**：本地规则不保证有价值的语义改写，所以默认草稿逐字符等于原文，不为了显得有用而加长。可选问题不会自动塞入草稿。
- 不调用模型、不读取历史或文件、不上传遥测、不记录提示词日志、不持久化输入、不自动回填或发送。

### 实际例子

输入：

> 我想做一个美化dsh交互界面的插件

识别线索：

| 类型 | 原文引用 |
| --- | --- |
| 目标/任务 | 我想做一个美化dsh交互界面的插件 |
| 交付物 | 插件 |
| 使用环境 | dsh |

可选澄清：

> 你最想美化“交互界面”的哪些部分？有没有喜欢的风格或参考图？

若回答“先把侧栏改得紧凑一些，保留现有功能”，可将这条真实补充加入草稿。不会凭空指定 React、Tailwind、CSS 注入等技术路线，也不会把未回答问题或示例当成你的要求。

## 安装与升级

项目尚未发布到 npm。克隆仓库，或解包插件包后，在 DSH「插件」→「添加插件」→「安装第三方插件」中填写项目目录绝对路径；安装后按宿主提示重载，再打开右侧栏 **+ → 想法增强**。已安装旧版时用新版包/目录重新安装以更新快照。开发源码不自动改变已安装副本。

若提供 CLI，可参考（选项以当前版本 `dsh plugin --help` 为准）：

```powershell
dsh plugin --profile <profile> add file:C:\path\to\dsh-prompt-enhancer
```

## 用法与边界

输入 → 分析想法 → 审阅已表达线索与可选问题 → 可选填写回答并加入稿子 → 编辑/确认 → 复制并自行粘贴发送。确认只改变面板状态。撤销恢复完整原文。

**诚实边界**：这仍然是有限的本地表达模式识别，不是完整语义理解；可能漏认或误认。未识别不等于缺失，原文引用也不代表事实经过验证。没有模型生成的新措辞，没有通用任意任务的智能追问能力。风险检测只是本地线索，不保证脱敏或安全。不要把测试通过等同于普遍增强质量合格。

## API 与兼容性

```js
import { enhancePrompt } from 'dsh-prompt-enhancer';
const result = enhancePrompt('我想做一个美化dsh交互界面的插件', { locale: 'zh' });
// enhancedPrompt === 原文
// recognizedFacts: [{key, label, evidence, start, end}]
// clarifications: [{id, question, reason, evidence}]
// reviewNotes: string[]
```

保留旧结果字段以避免破坏调用方：`missingQuestions` 是可选问题字符串；`changeSet` / `assumptions` 通常为空；超预算仅有 `preserve` 说明；`confidence` 已弃用，固定为 0，**不表示质量或理解概率**。`detectGaps` 仅为兼容 API，`present:false,status:'unknown'` 表示没有识别线索，不表示内容缺失。

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关闭时保留原文，清空分析元数据；管理路由保留 |
| `locale` | `auto` | `auto` / `zh` / `en`；控制标签、问题语言 |
| `maxPromptChars` | `12000` | 1–100000，UTF-16 长度；超限保留全文并跳过分析，不截断 |
| `includeQuestions` | `true` | 是否返回可选澄清 |
| `includeRisks` | `true` | 是否返回敏感风险标记 |
| `addSectionLabels` / `includeAssumptions` | `true` | 已弃用，只保留配置兼容，不再生成模板或策略假设 |
| `order` | `950` | 预留，无 UI 排序或 system prompt 注入效果 |

旧 `profile` 请求字段被接受但不再改变输出；界面移除没有实际作用的风格选择。HTTP 配置更新只作用于当前实例内存，不持久化。单次请求不能重新启用停用的宿主插件。

## 开发与验证

Node.js **>=22.19.0**，无第三方运行时依赖：

```powershell
node --test test/*.test.mjs
node tools/check-plugin-contract.mjs
node --check client.js
node --check index.js
# 或 pnpm run verify / npm run verify
```

[质量回归](./test/quality.test.mjs)覆盖真实反馈、中英自然表达、交付物/格式区分、原子任务不凑问卷、否定/代码不当任务、已有信息不重复追问等。另有 Host、客户端交互及真实 pack/解包测试。v0.1 曾在当前 DSH profile 成功安装且被用户实际使用；v0.2 的真实安装状态以安装工具结果为准，不将 VM/mock 检查冒充页面 E2E。

更多细节见[设计与契约](./docs/DETAIL.md)。[MIT License](./LICENSE)。
