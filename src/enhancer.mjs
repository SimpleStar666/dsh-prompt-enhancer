/**
 * Dependency-free, rule-based prompt enhancement.
 *
 * This is intentionally not an LLM call.  It makes the missing parts of a
 * request explicit and adds neutral placeholders/questions instead of inventing
 * requirements.  Callers can therefore review or discard the result safely.
 */

import { normalizeConfig } from './schema.mjs';

const COMPONENTS = Object.freeze([
  {
    key: 'target',
    zh: '目标',
    en: 'Target',
    cues: [
      /目标|目的|要做什么|任务是|请(?:帮我|你)?(?:写|生成|分析|实现|设计|比较|总结|翻译|解释)/i,
      /\b(?:goal|objective|task|purpose|need to|please)\b/i,
    ],
    question: { zh: '希望最终完成什么具体目标？', en: 'What concrete outcome should be achieved?' },
    placeholder: { zh: '请明确要完成的具体目标，以及不包含的范围。', en: 'State the concrete outcome and what is out of scope.' },
  },
  {
    key: 'background',
    zh: '背景',
    en: 'Background',
    cues: [/背景|上下文|现状|场景|已有|目前|项目是|用户是/i, /\b(?:context|background|situation|currently|existing|scenario)\b/i],
    question: { zh: '有哪些必要的背景、现状或上下文？', en: 'What background, current state, or context is relevant?' },
    placeholder: { zh: '补充必要背景、现状、已有输入或读者信息。', en: 'Add relevant background, current state, existing inputs, or audience.' },
  },
  {
    key: 'constraints',
    zh: '约束',
    en: 'Constraints',
    cues: [/约束|限制|要求|必须|不要|禁止|范围|预算|时间|依赖|兼容/i, /\b(?:constraint|requirement|must|must not|do not|limit|budget|deadline|dependency|compatible)\b/i],
    question: { zh: '有哪些必须遵守的约束、边界或禁止事项？', en: 'What constraints, boundaries, or prohibitions must be followed?' },
    placeholder: { zh: '列出必须遵守的约束、边界、依赖和禁止事项。', en: 'List required constraints, boundaries, dependencies, and prohibitions.' },
  },
  {
    key: 'outputFormat',
    zh: '输出格式',
    en: 'Output format',
    cues: [/输出(?:格式|为)|格式|返回|表格|列表|JSON|Markdown|代码|字数|长度|分点/i, /\b(?:output|format|return|table|list|json|markdown|code|length|bullet)\b/i],
    question: { zh: '期望以什么格式、结构和篇幅输出？', en: 'What format, structure, and length should the output use?' },
    placeholder: { zh: '指定输出格式、结构、语言和篇幅（例如 Markdown 分点或 JSON 字段）。', en: 'Specify output format, structure, language, and length (for example, Markdown bullets or JSON fields).' },
  },
  {
    key: 'successCriteria',
    zh: '成功标准',
    en: 'Success criteria',
    cues: [/成功标准|验收标准|评价标准|判断标准|完成条件|可验证|准确|正确|质量/i, /\b(?:success criteria|acceptance criteria|definition of done|evaluate|measurable|verifiable|quality)\b/i],
    question: { zh: '如何判断结果达标或任务完成？', en: 'How will success or completion be judged?' },
    placeholder: { zh: '给出可验证的成功/验收标准，说明什么结果算完成。', en: 'Give verifiable success or acceptance criteria describing what counts as done.' },
  },
]);

// Profile hints are questions/placeholders, never inferred facts or hard requirements.
const PROFILE_HINTS = Object.freeze({
  general: {},
  writing: {
    background: { zh: '请补充目标读者、使用场景和可用素材。', en: 'Add the intended audience, usage context, and available source material.' },
    outputFormat: { zh: '请说明文体、语气、结构和期望篇幅。', en: 'Specify the genre, tone, structure, and desired length.' },
    successCriteria: { zh: '请说明读者应理解或采取什么行动，以及事实核验要求。', en: 'Describe what readers should understand or do, and any fact-checking criteria.' },
  },
  product: {
    background: { zh: '请补充目标用户、核心问题、现状和已有验证。', en: 'Add the target users, core problem, current situation, and existing validation.' },
    constraints: { zh: '请说明范围、资源、时间和必须遵守的边界。', en: 'Specify scope, resources, timing, and required boundaries.' },
    successCriteria: { zh: '请说明可验证的用户价值、指标或验收条件。', en: 'Specify verifiable user value, metrics, or acceptance criteria.' },
  },
  coding: {
    background: { zh: '请补充技术栈、运行环境、相关代码及当前行为。', en: 'Add the stack, runtime, relevant code, and current behavior.' },
    constraints: { zh: '请说明兼容性、依赖、安全和不可修改的接口约束。', en: 'Specify compatibility, dependencies, security, and interfaces that must not change.' },
    successCriteria: { zh: '请说明预期行为、边界情况和可运行的验收测试。', en: 'Specify expected behavior, edge cases, and runnable acceptance tests.' },
  },
});

const SENSITIVE = /(?:password|passwd|secret|api[_ -]?key|token|bearer\s+[a-z0-9._~+/=-]+|\bsk-[a-z0-9_-]{12,}\b|私钥|密码|身份证|银行卡|[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,10}|(?:\+?\d[\d -]{7,30}\d)|\b(?:id|身份证号)\s*[:：]?\s*[a-z0-9-]{4,}\b)/i;
const CONFLICTS = [
  [/简洁|简短/i, /详细|全面|详尽/i],
  [/不要解释|只给答案/i, /请解释|详细说明/i],
  [/中文/i, /英文|英语/i],
];

/** Extract common host input shapes without changing code, whitespace or newlines. */
export function normalizeText(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  for (const key of ['prompt', 'text', 'input']) {
    if (typeof value[key] === 'string') return value[key];
  }
  if (typeof value.content === 'string') return value.content;
  if (Array.isArray(value.content)) {
    return value.content.map((part) => typeof part === 'string' ? part : part && typeof part.text === 'string' ? part.text : '').join('\n');
  }
  return '';
}

/** Conservative detector for credentials and direct personal identifiers. */
export function containsSensitiveData(value) {
  return SENSITIVE.test(normalizeText(value));
}

function asPrompt(value) {
  return normalizeText(value);
}

function chooseLocale(prompt, config) {
  if (config?.locale === 'zh' || config?.locale === 'en') return config.locale;
  return /[\u3400-\u9fff]/.test(prompt) ? 'zh' : 'en';
}

/** Return which canonical sections are already represented by the prompt. */
export function detectGaps(prompt) {
  const text = asPrompt(prompt);
  return COMPONENTS.map((component) => ({
    key: component.key,
    present: component.cues.some((cue) => cue.test(text)),
  }));
}

function questionFor(component, locale, profile) {
  return PROFILE_HINTS[profile]?.[component.key]?.[locale] ?? component.question[locale];
}

function placeholderFor(component, locale, profile) {
  return PROFILE_HINTS[profile]?.[component.key]?.[locale] ?? component.placeholder[locale];
}

/**
 * Enhance a prompt with neutral, reviewable scaffolding.
 *
 * @param {string|object} input prompt or `{prompt, config}`
 * @param {object} [options] normalized or raw config
 * @returns {{enhancedPrompt:string,changeSet:object[],assumptions:string[],missingQuestions:string[],riskFlags:string[],confidence:number}}
 */
export function enhancePrompt(input, options = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input)
    ? input
    : { prompt: input };
  const settings = {
    ...(source.config && typeof source.config === 'object' ? source.config : {}),
    ...(options && typeof options === 'object' && !Array.isArray(options) ? options : {}),
  };
  const config = normalizeConfig(settings);
  const raw = asPrompt(source);
  const unchanged = (riskFlags = [], changeSet = []) => ({
    enhancedPrompt: raw.trim() ? raw : '',
    changeSet, assumptions: [], missingQuestions: [],
    riskFlags: config.includeRisks ? riskFlags : [], confidence: 0,
  });
  if (!raw.trim() || !config.enabled) return unchanged();
  // Never clip user constraints or code. Oversized inputs fail open unchanged.
  if (raw.length > config.maxPromptChars) {
    const riskFlags = ['input_too_long', 'enhancement_skipped'];
    if (containsSensitiveData(raw)) riskFlags.push('sensitive_data_possible', 'secret_or_personal_data');
    return unchanged(riskFlags, [{
      op: 'preserve', path: '/enhancedPrompt',
      reason: 'Input exceeds maxPromptChars; enhancement was skipped and the full original was retained.',
    }]);
  }
  const prompt = raw;
  const locale = chooseLocale(prompt, config);
  const requestedProfile = settings.profile ?? source.profile;
  const profile = typeof requestedProfile === 'string' && Object.hasOwn(PROFILE_HINTS, requestedProfile) ? requestedProfile : 'general';
  const gaps = detectGaps(prompt);
  const missing = COMPONENTS.filter((component, index) => !gaps[index].present);
  const missingQuestions = config.includeQuestions === false ? [] : missing.slice(0, 3).map((component) => questionFor(component, locale, profile));
  const assumptions = config.includeAssumptions === false
    ? []
    : [locale === 'zh' ? '保留原始意图，不替用户臆造缺失的事实或要求。' : 'The original intent is preserved; missing facts and requirements are not invented.'];
  const riskFlags = [];
  if (containsSensitiveData(prompt)) {
    riskFlags.push('sensitive_data_possible');
    riskFlags.push('secret_or_personal_data');
  }
  for (const [left, right] of CONFLICTS) if (left.test(prompt) && right.test(prompt)) riskFlags.push('conflicting_instructions');
  for (const component of missing) {
    if (component.key === 'target') riskFlags.push('missing_target');
    else if (component.key === 'constraints') riskFlags.push('missing_constraints');
    else if (component.key === 'outputFormat') riskFlags.push('missing_output_format');
    else if (component.key === 'successCriteria') riskFlags.push('missing_success_criteria');
    else riskFlags.push('missing_background');
  }
  const uniqueRisks = [...new Set(riskFlags)];

  const changeSet = [];
  let enhancedPrompt = prompt;
  if (prompt && missing.length && config.addSectionLabels !== false) {
    const title = locale === 'zh' ? '提示词增强（请确认或补充）' : 'Prompt enhancement (review and complete)';
    const lines = [`\n\n## ${title}`];
    for (const component of missing) {
      const label = locale === 'zh' ? component.zh : component.en;
      lines.push(`### ${label}\n${placeholderFor(component, locale, profile)}`);
      changeSet.push({
        op: 'add',
        path: `/sections/${component.key}`,
        description: locale === 'zh' ? `添加${label}待补充项` : `Add a ${label.toLowerCase()} placeholder`,
        reason: locale === 'zh' ? '原提示词未检测到该部分。' : 'This section was not detected in the original prompt.',
      });
    }
    enhancedPrompt += lines.join('\n');
  }

  // A complete, unambiguous prompt is more trustworthy than one with many gaps.
  const completeness = (COMPONENTS.length - missing.length) / COMPONENTS.length;
  let confidence = 0.45 + completeness * 0.5;
  if (uniqueRisks.includes('conflicting_instructions')) confidence -= 0.15;
  confidence = Math.max(0, Math.min(1, Number(confidence.toFixed(2))));

  return {
    enhancedPrompt,
    changeSet,
    assumptions,
    missingQuestions,
    riskFlags: config.includeRisks === false ? [] : uniqueRisks,
    confidence,
  };
}

export { COMPONENTS };
