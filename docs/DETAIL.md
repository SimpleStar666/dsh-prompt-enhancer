# dsh-prompt-enhancer 设计与实现细节

## 目标与边界

插件在用户确认前对提示词做本地、可解释的结构化增强：补齐目标、受众、输出格式、上下文和验收标准等缺口，同时保留用户原话与硬约束。它不是代理执行器，不自动调用外部服务、不自动发送消息、不代替用户确认。

实现可先是 `src/enhancer.mjs` 的纯函数，未来再接入 DSH Host/Client 管线。所有路径、字段和失败策略以下列为 **MVP contract**。

## MVP contract

### 核心增强接口

```js
import {
  enhancePrompt,
  detectGaps,
  normalizeText,
  containsSensitiveData,
} from './src/enhancer.mjs';

const result = enhancePrompt(promptText, { profile: 'general' });
```

`enhancePrompt` 必须返回：

```ts
type EnhancementResult = {
  enhancedPrompt: string;
  changeSet: Array<{ op: string; path: string; reason: string }>;
  assumptions: string[];
  missingQuestions: string[];
  riskFlags: string[];
  confidence: number; // 0..1
};
```

增强结果必须是 JSON 可序列化值。未知配置字段不能改变行为；空、null 或全空白输入安全返回空 `enhancedPrompt` 和完整的空数组字段。

### 不可违反的安全规则

1. **原文永不丢失**：增强文本应包含规范化后的原请求；任何裁剪都必须在 `changeSet` 和 `riskFlags` 中可解释。
2. **硬约束优先**：`必须`、`不得`、`禁止`、`不要`、明确的数量/格式/语言/工具限制必须逐字保留，不能被补充内容覆盖或降级为建议。
3. **敏感信息检测**：API key、Bearer/token、密码、邮箱、手机号、身份证号及明显 secret 触发 `containsSensitiveData` 和 `riskFlags`。检测不等于静默删除；若未来有脱敏，必须可追溯并禁止外发。
4. **默认不外发**：增强器本身不联网、不把提示词写入日志或 telemetry；后续 Context/Model adapter 必须默认 deny，含 `secret` 的内容不得发送。
5. **用户确认后应用**：`changeSet` 只描述建议，渲染层应提供 diff/rollback；不得自动回填、发送或执行提示词。
6. **失败安全**：规则或结构化输出失败时返回原文、风险标记和可解释的降级原因（而不是猜测或自动应用）。

### 宿主协作接口（预留）

后续实现可映射到下列 provider，不要求当前纯函数版本实现网络或模型：

- `TriggerProvider.onInvoke(input, signal): Promise<EnhanceJob>`；输入含 `requestId`、`profileId`、`promptText`、选择范围、上下文范围和用户同意。
- `ContextProvider.collect(scope, budget, signal): Promise<ContextPart[]>`；每段带 `trust`、`sensitivity` 和 token 估算。
- `PolicyProvider.authorize(envelope, destination)` / `redact(part)`；默认拒绝，敏感或超预算阻断外发。
- `ModelAdapter.invoke(request, signal): AsyncIterable<ModelChunk>`；Gateway 负责 deadline、取消、幂等、有限重试和路由。
- `Renderer.renderDiff(changeSet)` / `apply(result)` / `rollback()`；只有显式用户确认后才应用。

结构化结果的未来 Schema v1 可追加 `schemaVersion`、`intentSummary`、`constraints`、`citations`、`usage`、`model`、`degradedReason`，但当前公共结果字段必须保持向后兼容。

## 规则流水线

1. **normalize**：`normalizeText` 将换行、制表和重复空白规范化；不改变语义。
2. **constraints**：先扫描并锁定硬约束，再生成任何补充文本。
3. **gaps**：`detectGaps` 只提出问题，不凭空回答；常见缺口包括目标、受众、输出格式、范围、上下文和验收标准。
4. **risks**：本地检测敏感信息、外部不可信内容和过长输入，写入 `riskFlags`。
5. **compose**：将原文、明确约束和可选结构化建议组合，记录每次变更及理由，计算 0–1 置信度。

每一步都应保持确定性、无副作用、无第三方依赖。

## 插件 contract

`index.js` 重新导出：

- `apply(ctx, config?)`：注册 Host 端路由/事件，失败时不阻塞聊天；
- `inject`：注入点列表；
- `name`：`dsh-prompt-enhancer`；
- `Config`：配置 schema。

`src/plugin.mjs` 同样导出 `{ apply, inject, name, Config }`。包清单的 `dsh.bundle.patch`、`dsh.client` 与 patch 中的 bundle `id`/`name` 都必须是 `dsh-prompt-enhancer`。宿主代码只允许 Node 内置模块和本地相对导入，运行依赖为空。运行 `node tools/check-plugin-contract.mjs` 检查这些约束。

## 测试重点

`test/enhancer.test.mjs` 覆盖：

- 结构化结果字段与置信度范围；
- 普通请求增强且原文保留；
- 硬约束逐字保留；
- 常见敏感信息检测与风险提示；
- 缺口识别、空输入和文本规范化；
- 配置 schema 的防御式归一化。

接入模型/上下文后还应增加：无授权不调用模型、secret 不外发、external 内容标记不可信、超预算裁剪可解释、无效结构化响应至多一次 repair、网络超时/5xx 有限重试并可降级、`requestId` 幂等、changeSet 可回滚，以及 telemetry 不含原始提示词或敏感值。
