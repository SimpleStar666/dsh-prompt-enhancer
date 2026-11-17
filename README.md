# dsh-prompt-enhancer

`dsh-prompt-enhancer` 是一个零依赖、规则优先的 DSH 插件：在发送前把简短或含糊的请求整理成更可执行的提示词，并明确列出假设、缺失问题、变更和风险。它**不会自动发送或替用户确认**；原文始终保留，用户可以审阅增强结果后再继续。

## 安装

本插件使用本地目录安装：

```powershell
dsh plugin --profile <profile> add file:C:\path\to\dsh-prompt-enhancer
```

也可在 DSH 的「插件 → 添加插件 → 安装第三方插件」中选择目录。插件不包含网络服务、遥测上传或第三方运行时依赖。

## 用法

聊天中输入普通请求即可由 Host 侧规则处理。核心 API：

```js
import { enhancePrompt } from 'dsh-prompt-enhancer';

const result = enhancePrompt('帮我写一个报告', { profile: 'general' });
// {
//   enhancedPrompt, changeSet, assumptions,
//   missingQuestions, riskFlags, confidence
// }
```

`enhancedPrompt` 是可供用户审阅的建议文本。`changeSet` 解释每一个补充或整理；`assumptions` 与 `missingQuestions` 让不确定性可见；`riskFlags` 提示敏感信息、外部内容或不可执行约束；`confidence` 为 0–1 的规则置信度。空输入返回同样的结构化结果但不制造内容。

## 配置

`src/schema.mjs` 导出 `Config` 和 `normalizeConfig`。配置会采用安全默认值，并忽略未知字段：

```yaml
- id: dsh-prompt-enhancer
  name: dsh-prompt-enhancer
  config:
    enabled: true
    locale: zh-CN
    maxPromptChars: 12000
    order: [normalize, constraints, gaps, risks]
```

## 开发与验证

项目只使用 Node.js 内置模块，要求 Node 22+：

```powershell
node --test test/*.test.mjs
node tools/check-plugin-contract.mjs
node --check index.js
```

实现增强逻辑时必须遵守 `docs/DETAIL.md` 中的 MVP contract：原文不可丢失、硬约束不可弱化、敏感内容默认阻断外发、失败安全且不自动应用。

## License

MIT
