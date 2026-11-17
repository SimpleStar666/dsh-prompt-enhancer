# 设计与契约：证据优先，不伪装成语义增强

## v0.2 的修正

v0.1 的问题不是“少了几个关键词”，而是把未命中规则当成内容缺失，再用五段待填写模板冒充增强。v0.2 删除该行为：默认草稿始终为完整原文；元数据分为原文线索、可选问题、本地能力边界。没有实际回答时，不自动生成新要求。

## 结果契约

```ts
type Result = {
  enhancedPrompt: string;
  recognizedFacts: Array<{
    key: string; label: string; evidence: string;
    start: number; end: number; // UTF-16 偏移，raw.slice(start,end) === evidence
  }>;
  clarifications: Array<{
    id: string; question: string; reason: string; evidence: string;
  }>;
  reviewNotes: string[];
  changeSet: Array<{op: string; path: string; reason: string}>;
  assumptions: string[];
  missingQuestions: string[]; // 兼容字段：clarifications.map(q => q.question)
  riskFlags: string[];
  confidence: number; // 弃用，固定 0；不是理解/质量/完整度分数
};
```

- `normalizeText` 不折叠空白、不改缩进、不改代码。空或全空白输入返回空草稿；停用返回精确原文，分析数组为空。
- 正常分析 `enhancedPrompt === raw`，`changeSet` / `assumptions` 为空。不会追加未回答问题、占位符或模板。
- 超出 `maxPromptChars` 时保留全文，跳过意图分析，返回 `preserve` 说明及 review note；仍对全文进行敏感线索扫描，包括末尾。
- 本地证据提取屏蔽代码/引述内的动作，保留偏移。每类至多一个线索。优先避免把历史提及、被禁止动作、插件之类交付物误标成回答格式。
- `detectGaps` 仅保留兼容名称：`status:'expressed'` 是命中原文线索，`status:'unknown'` **不是缺失判定**。
- 目标、交付物、环境、背景、约束、回答格式、验收线索、已列范围是可识别类型，**不是强制栏目或提交条件**。用户已枚举美化范围时（如“包括交互界面、产出等”），不再追问“想美化哪些部分”。

## 可选澄清

当前规则按优先级产生 0 或 1 条问题，公共契约限制最多 2 条。仅覆盖有限类型：未识别动作、含糊对象/指代、没有具体方向的美化/优化、缺少具体证据的报错、内容读者/用途、翻译目标语言。已经指定方向、只要建议/可行性、简单完整任务不强行问全背景/格式/约束/验收。

未识别动作的提示明确写“本地规则未识别，不等于你没有表达目标”。它不是阻断门禁。用户可以不回答任何问题，继续编辑和复制。规则不能理解所有自然语言，不声称能做到通用智能追问。

## 客户端状态与回答

使用 `window.__ModuleLoader__.load({ id, factory(require) })` 加载宿主 React、槽位、右侧栏和语言接口；清理注册以支持重载。输入/结果均只存在组件内存。

- 展示原文中可核验的线索、review notes 与可选问题。客户端验证 evidence 必须精确对应原文偏移，空卡片不显示。
- 问题按 ID 收集回答，仅追加非空用户回答到**当前**草稿；保留用户手改。一次应用后不能重复叠加；新分析或恢复原文会重置。
- 草稿可直接编辑；确认只锁定面板状态。撤销恢复原始多行文本，清空回答状态。不会调用 composer 回填或发送接口。
- busy/ref 防同一帧双提交；revision/ref 忽略已经失效的响应与旧回调。修改原文使当前结果失效。
- 复制优先用 Clipboard API，失败时用选区复制兜底；只有操作成功才显示成功。原始换行、空格与代码保留。
- 已移除没有实际差异的 profile 选择器；旧 API profile 仍被接受但不增加模板或技术栈。

## Host 与配置

导出 `name`、`inject`、`Config`、`apply`。`Config['~standard']` 提供校验；manifest 声明 bundle patch、浏览器入口和图标。Host 通过 `ctx.connection.fetch.register()` 注册两个端点，缺少可选 connection 时不崩溃：

- `POST /api/prompt-enhancer/enhance`：严格验证 string `prompt`/`text`，接受宿主解析对象、JSON 字符串和真实 Request；无效输入返回 400 及结构化 fallback。
- `GET/POST /api/prompt-enhancer/config`：归一化配置；仅当前实例内存更新；不回写文件。

所有响应 `Cache-Control: no-store`。管理路由在功能停用时仍保留；单次 enhance 配置不能绕过宿主 `enabled:false`。effect 清理注册。没有历史读取、系统提示词注入、消息监听、模型调用、遥测或提示词持久化。

布尔字段仅接受布尔；数值只接受有限 number，错误类型不强制转换。`maxPromptChars` 为 1–100000；`locale` 为 auto/zh/en。旧 `addSectionLabels`、`includeAssumptions` 是兼容无操作项。`includeQuestions` / `includeRisks` 控制对应元数据。预留 `order` 无现行效果。

## 风险与验证边界

敏感检测保留本地 API key/password/bearer/private-key 线索，仅提示不脱敏；不能保证发现所有秘密。相反语言、简洁与详细可能属于不同部分，不再粗暴标为冲突。没有 missing_* 风险或伪完整度分数。

测试分四层：

1. core/schema：逐字符保留、禁用/超限/数值边界、敏感尾部检测。
2. 真实质量回归：用户实际案例及中英同义、交付物与格式、否定/引用/历史提及、无需追问的原子任务。
3. Host / VM UI：请求解析、端点清理、证据校验、回答合入稿、并发/失效/撤销/复制。
4. 实际 pack：列包、解包、模块导入与路由、client VM smoke、checksum/path 检查。

这些测试不代表任意语言任务有优秀语义理解，也不代表真实页面 E2E。安装工具可验证包启用/应用状态；未经真实页面操作的交互不得宣称已经端到端验证。
