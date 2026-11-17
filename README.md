# dsh-prompt-enhancer

**想法增强**：一个零运行时依赖、规则优先的 DSH 插件，把简短想法整理成便于审阅的任务提示词。保留原文，提示缺口，添加待补充项；**不调用大模型、不读取会话历史、不自动回填、不自动发送**。

## 当前能力

- 检查目标、背景、约束、输出格式、成功标准五类信息。
- 通用 / 写作 / 产品方案 / 编程四种 Profile，提供不同的待补充提示。
- 增强稿可编辑、复制、确认或撤销；原文的换行、缩进和代码保持不变。
- 展示最多三个澄清问题、变更摘要及本地敏感信息/冲突风险提示。
- 全部处理在本地；不持久化输入，不记录提示词日志，不上传遥测。

这是 **规则优先 MVP**，不是语义理解或 AI 改写服务。关键词可能误判；不会替用户回答澄清问题，也不会虚构背景。`confidence` 只是启发式完整度分数，不代表事实准确率。

## 安装

项目尚未发布到 npm。克隆本仓库，或将整个目录下载到本机，再使用 DSH 的本地第三方插件安装入口：

1. 进入「插件」→「添加插件」→「安装第三方插件」，填写项目目录的绝对路径。
2. 按宿主返回的重新加载或重启提示操作。
3. 右侧栏顶部 **+** → **想法增强**，或从右侧栏引导页进入。

若你的 DSH 安装提供 CLI，可参考以下命令（具体选项以该版本的 `dsh plugin --help` 为准）：

```powershell
dsh plugin --profile <profile> add file:C:\path\to\dsh-prompt-enhancer
```

本项目验证了包内容、解包后入口与模拟宿主/客户端契约；**尚未在真实 DSH profile 内做安装及页面端到端验证**。开发源码变化不代表已安装快照自动更新，需重新安装并按宿主提示重载。

## 用法

输入原始想法，选择 Profile，点击「增强」。先查看澄清问题与风险，再编辑待补充项。点击「确认增强稿」仅在当前面板内显示确认；需要自行点击「复制」并粘贴到聊天输入框，最后由你发送。撤销会恢复本次增强前的完整原文。

例如输入“帮我做一个产品发布计划”，插件会保留这句话，并提示你补充用户背景、时间/资源边界、输出格式和验收标准，而不是擅自设定预算或日期。

核心 API：

```js
import { enhancePrompt } from 'dsh-prompt-enhancer';

const result = enhancePrompt('帮我写一个报告', {
  locale: 'zh',
  profile: 'writing',
});
// { enhancedPrompt, changeSet, assumptions,
//   missingQuestions, riskFlags, confidence }
```

## 配置

[配置 schema](./src/schema.mjs) 接受下列字段，忽略未知字段和错误类型：

```yaml
- id: dsh-prompt-enhancer
  name: dsh-prompt-enhancer
  config:
    enabled: true
    locale: auto
    maxPromptChars: 12000
    addSectionLabels: true
    includeAssumptions: true
    includeQuestions: true
    includeRisks: true
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` 时原样返回输入，不生成增强或元数据；管理/增强路由保留 |
| `locale` | `auto` | `auto` / `zh` / `en`，仅控制新增标签和问题语言 |
| `maxPromptChars` | `12000` | 1–100000；按 JS UTF-16 长度计，超限时跳过增强、保留完整原文并给出原因，不截断 |
| `addSectionLabels` | `true` | 在原文后追加缺失信息的待补充小节 |
| `includeAssumptions` | `true` | 返回“不编造事实”的策略提醒，不表示已推断出事实 |
| `includeQuestions` | `true` | 返回最多三个缺口澄清项 |
| `includeRisks` | `true` | 展示启发式风险标记；关闭只隐藏元数据，不意味着风险不存在 |
| `order` | `950` | 预留字段，当前不注入 system prompt，无 UI 排序效果 |

`POST /api/prompt-enhancer/config` 可更新当前插件实例的内存配置，**不会持久化到 profile**。单次增强可以覆盖部分配置，但不能通过请求覆盖重新启用已停用的宿主插件。Profile 是单次请求字段，不是全局配置。

## 开发与验证

要求 Node.js **>=22.19.0**，无第三方运行时依赖。无需先安装依赖即可执行：

```powershell
node --test test/*.test.mjs
node tools/check-plugin-contract.mjs
node --check client.js
node --check index.js
```

有包管理器时也可执行 `npm run verify` / `pnpm run verify`。实际包内容与解包后烟测见[打包测试](./test/package.test.mjs)中的命令说明。

接口、安全边界及剩余限制见[设计与契约](./docs/DETAIL.md)。

## License

[MIT](./LICENSE)
