# dsh-prompt-enhancer 设计与实现契约

## 目标与边界

插件以本地规则提示任务缺口，让用户在发送前明确目标、背景、约束、输出格式和成功标准。它不是代理执行器，不调用模型、不读取会话历史或文件、不联网、不自动回填聊天输入框、不发送消息。当前已包含 Host HTTP 适配器和 Web 侧栏客户端，不只是纯函数原型。

## 核心增强接口

```js
import { enhancePrompt, detectGaps, normalizeText, containsSensitiveData } from '../index.js';
const result = enhancePrompt(promptText, { profile: 'general', locale: 'auto' });
```

```ts
type EnhancementResult = {
  enhancedPrompt: string;
  changeSet: Array<{
    op: 'add' | 'preserve';
    path: string;
    reason: string;
    description?: string;
  }>;
  assumptions: string[];
  missingQuestions: string[];
  riskFlags: string[];
  confidence: number; // 0..1，启发式分数，不是事实正确率
};
```

- 结果可 JSON 序列化，纯函数确定性执行，无网络、存储或日志副作用。
- 输入接受字符串，或包含 `prompt` / `text` / `input` / `content` 的对象。`content` 文本块以换行连接。
- `normalizeText` 是文本提取器，**不折叠空白、不移除缩进、不改写代码**。空、null 或全空白输入返回空 `enhancedPrompt`、四个完整空数组和 `confidence: 0`。
- 非空输入原文逐字符保留，新增内容只追加在其后；硬约束不会被删除、重写或降级。
- `enabled: false` 原样返回非空输入，元数据为空、置信分数为 0。
- 超出 `maxPromptChars` 时不截断，跳过增强并完整返回原文；`changeSet` 添加 `preserve` 记录，风险含 `input_too_long` / `enhancement_skipped`。仍对完整原文做敏感检测，避免漏掉尾部 secret。此配置是增强预算，不是 HTTP 请求体大小限制。
- `changeSet` 的 `/sections/<key>` 为语义段落标识，**不是可执行 JSON Patch 或字符偏移 diff**。没有实际新增时返回空数组。撤销由 UI 保存本次原文实现。

## 规则流水线

1. 提取文本和规范化配置。数字只接受有限 `number`；未知字段和错误类型忽略。
2. 空输入/停用时安全返回；超预算时保留原文并给出跳过原因。
3. 关键词启发式检查五类信息。`detectGaps` 返回五项 `{key, present}`，不代表语义理解或事实验证。
4. 对缺失项生成中性待补充段落、最多三个澄清项。Profile 为 `general` / `writing` / `product` / `coding`，仅改变提示措辞，不推断需求。
5. 本地检测可能的凭据、个人标识和部分冲突信号。生成变更说明、策略提醒和完整度分数。

`assumptions` 当前仅含“不替用户编造事实”的策略提醒，不会伪造具体假设。`includeAssumptions` / `includeQuestions` / `includeRisks` 控制对应元数据；`addSectionLabels` 独立控制追加段落。自动语言选择根据输入是否含中日韩统一表意文字，在 `zh` / `en` 中选择，可用 `locale` 显式覆盖。

## 安全规则与局限

1. **原文保留**：任何模式都不静默裁剪代码或硬约束，完整原文留在侧栏输入框；增强稿只是追加建议。
2. **默认不外发**：增强器不联网、不写提示词日志、不上传遥测。用户自行复制/粘贴后发送的行为由用户控制。
3. **敏感检测不等于脱敏**：正则对 key、Bearer/token、密码、邮箱、手机号、身份证号等做保守提示，存在误报和漏报；结果保留敏感原文，不承诺清理或阻断用户复制。关闭风险展示也不代表内容安全。
4. **确认不是执行**：确认按钮只更新面板状态，既不调用聊天 composer，也不发送消息。使用前应审阅并填完待补充项。
5. **失败安全**：核心函数不应因正常 JSON 输入或配置类型错误崩溃。Host 异常返回原文（若已成功提取）和 `enhancement_failed`；客户端保留原文、展示错误和重试入口，不自动应用。
6. **没有外部信任分析**：当前不读取检索资料，也没有 prompt-injection 分类器、语义约束锁定或模型正确性评估。关键词检测可能把已有信息误判为缺失，也可能误判冲突。

未来若接入模型/上下文，必须先实现用户明确授权、默认拒绝外发、secret 阻断或可追溯脱敏、有限重试/超时/取消、结构化响应验证和不含原文的遥测策略。当前 MVP 不声称已经提供这些能力。

## Host HTTP 契约

`index.js` 导出 `name`、`inject`、`Config`、`apply`、核心函数和路径常量。`apply(ctx, config)` 通过 `connection.fetch.register` 注册两个路径，提供 `no-store` JSON 响应：

### POST /api/prompt-enhancer/enhance

接受 JSON 字符串，或 `{prompt: string}` / `{text: string}`，可带 `profile` 与 `config`。不接受 null、数组、数字或缺少文本字段的对象（400）。只支持 POST（其他方法 405）。

成功返回 `{ok: true, ...EnhancementResult, config}`。配置合并顺序为默认值、宿主配置、单次请求覆盖；**请求不能重新启用宿主已关闭的插件**。Profile 为独立请求字段，未知 Profile 回退通用；单次配置覆盖不持久化。

### GET / POST /api/prompt-enhancer/config

GET 返回当前实例配置。POST 接受配置对象或 `{config: object}`，只更新内存配置，重启后恢复宿主所提供的配置。停用时两个路由仍保留，增强路由仅返回原文；可通过配置路由显式重新启用。这不是卸载插件或移除路由。

路由不自行实现认证，依赖宿主路由层的本地访问控制。JSON 请求解析失败返回 400；未知路径 404。适配器使用 `ctx.effect` 清理已注册路由；连接服务不可用时 `apply` 安全返回 `http:false`。注入声明为 `['connection']`，宿主是否允许缺失服务仍由宿主决定，不承诺所有 headless 版本都能加载。

## Web 客户端

浏览器入口使用宿主的 ModuleLoader 和 React，通过 `sidebarRightTabs` / `slots` 注册右侧栏标签。UI 展示 canonical `missingQuestions` / `changeSet` 字段，变更以 description/reason 文字呈现，不执行变更对象。请求期间锁定可能与结果冲突的操作；原文、增强稿、撤销状态均为面板内存，不持久化。

用户流程：输入想法 → 增强 → 审阅澄清项和风险 → 编辑待补充内容 → 确认（面板状态）→ 复制 → 自行粘贴发送。撤销恢复请求前的完整原文。关闭/卸载面板会丢失面板内存数据。

## 包与测试

包采用零运行时依赖 ESM，要求 Node >=22.19.0。清单包含 Host 源码、客户端、patch、语言包、图标、文档、MIT 许可证、测试和工具。

- `test/enhancer.test.mjs`：结构字段、空输入、原文/代码保留、敏感信息、预算、风格、开关和配置类型。
- `test/plugin.test.mjs`：真实 Request JSON 解析、路由、方法、错误输入、配置更新、停用不可绕过、Profile 转发和 cleanup。
- `test/client.test.mjs`：真实 browser bundle 的 VM 契约及 hook 交互回归。
- `test/package.test.mjs`：真实包管理器 pack、tarball 内容核验、解包后入口/增强/模拟 Host 烟测。
- `tools/check-plugin-contract.mjs`：包清单、files 覆盖、本地导入、client 注册/语法和模拟 HTTP 约定。

这些是包和模拟集成验证，**不是在真实用户 profile 的安装或浏览器 E2E**。尚未完成真实 DSH 安装和侧栏点击验证，不宣称当前会话已热加载插件。
