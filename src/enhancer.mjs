/** Evidence-first local prompt review. No model, inferred facts, or mandatory checklist. */
import { normalizeConfig } from './schema.mjs';
import { analyzeIntent } from './intent.mjs';

// Kept for API compatibility; lack of a recognized clue is unknown, not a missing requirement.
const COMPONENTS = Object.freeze(['target', 'background', 'constraints', 'outputFormat', 'successCriteria'].map((key) => ({ key })));
const SENSITIVE = /(?:password|passwd|secret|api[_ -]?key|token|bearer\s+[a-z0-9._~+/=-]+|\bsk-[a-z0-9_-]{12,}\b|私钥|密码|身份证|银行卡|[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,10}|(?:\+?\d[\d -]{7,30}\d)|\b(?:id|身份证号)\s*[:：]?\s*[a-z0-9-]{4,}\b)/i;

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
export function containsSensitiveData(value) { return SENSITIVE.test(normalizeText(value)); }
function chooseLocale(prompt, config) {
  if (config?.locale === 'zh' || config?.locale === 'en') return config.locale;
  return /[\u3400-\u9fff]/.test(prompt) ? 'zh' : 'en';
}

/** Legacy API: present=false means unrecognized, NEVER a claim of semantic absence. */
export function detectGaps(prompt) {
  const text = normalizeText(prompt);
  const { recognizedFacts } = analyzeIntent(text, chooseLocale(text));
  return COMPONENTS.map(({ key }) => {
    const fact = recognizedFacts.find((item) => item.key === key);
    return { key, present: Boolean(fact), status: fact ? 'expressed' : 'unknown', evidence: fact?.evidence ?? '' };
  });
}

export function enhancePrompt(input, options = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : { prompt: input };
  const settings = {
    ...(source.config && typeof source.config === 'object' ? source.config : {}),
    ...(options && typeof options === 'object' && !Array.isArray(options) ? options : {}),
  };
  const config = normalizeConfig(settings);
  const raw = normalizeText(source);
  const unchanged = (riskFlags = [], changeSet = [], reviewNotes = []) => ({
    enhancedPrompt: raw.trim() ? raw : '', changeSet, assumptions: [], missingQuestions: [],
    riskFlags: config.includeRisks ? riskFlags : [], confidence: 0,
    recognizedFacts: [], clarifications: [], reviewNotes,
  });
  if (!raw.trim() || !config.enabled) return unchanged();
  const locale = chooseLocale(raw, config);
  const zh = locale === 'zh';
  if (raw.length > config.maxPromptChars) {
    const risks = ['input_too_long', 'enhancement_skipped'];
    if (containsSensitiveData(raw)) risks.push('sensitive_data_possible', 'secret_or_personal_data');
    return unchanged(risks, [{ op: 'preserve', path: '/enhancedPrompt', reason: 'Input exceeds maxPromptChars; review was skipped and the full original was retained.' }],
      [zh ? '输入超出分析长度，已保留完整原文，未做内容判断。' : 'The review limit was exceeded. The full original is retained without content judgments.']);
  }
  const requestedProfile = settings.profile ?? source.profile;
  const profile = typeof requestedProfile === 'string' && ['general', 'writing', 'product', 'coding'].includes(requestedProfile) ? requestedProfile : 'general';
  const analysis = analyzeIntent(raw, locale, profile);
  const clarifications = config.includeQuestions ? analysis.clarifications : [];
  const riskFlags = containsSensitiveData(raw) ? ['sensitive_data_possible', 'secret_or_personal_data'] : [];
  return {
    // No safe rewording is guaranteed by local patterns. Do not inflate the draft with a form.
    enhancedPrompt: raw,
    changeSet: [],
    assumptions: [],
    missingQuestions: clarifications.map((item) => item.question),
    riskFlags: config.includeRisks ? riskFlags : [],
    // Deprecated compatibility field: no semantic-confidence score is available.
    confidence: 0,
    recognizedFacts: analysis.recognizedFacts,
    clarifications,
    reviewNotes: [zh
      ? '以下仅是本地规则识别的原文线索，不是完整语义理解；未识别不等于缺失。'
      : 'These are original-text clues recognized by local rules, not full semantic understanding. Unrecognized does not mean missing.',
    zh ? '原文已保留；不追加固定模板。可选问题不代表必须补充，填写后可将你的回答加入草稿。'
      : 'The original is retained without a fixed template. Questions are optional; your answers can be added to the draft.'],
  };
}

export { COMPONENTS };
