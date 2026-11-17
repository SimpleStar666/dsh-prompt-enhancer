/**
 * Configuration for dsh-prompt-enhancer.
 *
 * The host can hand a plugin any JSON value.  This module deliberately keeps the
 * normalizer dependency-free and forgiving: invalid values fall back to defaults
 * so a malformed profile cannot prevent DSH from booting.
 */

export const DEFAULTS = Object.freeze({
  enabled: true,
  /** `auto`, `zh` or `en`; affects labels and the rewrite language. */
  locale: 'auto',
  /** Model route used for the rewrite; empty = follow the session/agent route. */
  provider: '',
  /** Model id used for the rewrite; empty = follow the session/agent route. */
  model: '',
  /** Max output tokens for the rewrite call. */
  maxTokens: 1024,
  /** Rewrite timeout in milliseconds; reasoning models may need a long first-token window. */
  timeoutMs: 120000,
  /** Reasoning effort for the rewrite: `auto` picks the cheapest supported effort. */
  reasoningEffort: 'auto',
  /** Inputs longer than this are refused by the rewrite endpoint (still shown locally). */
  maxPromptChars: 12000,
  /** Include safety/ambiguity warnings in the returned metadata. */
  includeRisks: true,
  /** Reserved ordering hint; kept for compatibility. */
  order: 950,
  /** Deprecated v0.2 compatibility switches; no longer drive any behaviour. */
  addSectionLabels: true,
  includeAssumptions: true,
  includeQuestions: true,
});

const BOOLEAN_KEYS = ['enabled', 'includeRisks', 'addSectionLabels', 'includeAssumptions', 'includeQuestions'];
const NUMBER_KEYS = ['maxPromptChars', 'maxTokens', 'timeoutMs', 'order'];
const STRING_KEYS = ['provider', 'model', 'reasoningEffort'];

export const REASONING_EFFORTS = Object.freeze([
  'auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
]);

/**
 * Normalize untrusted plugin configuration.
 * Unknown fields are dropped and values of the wrong type are ignored.
 *
 * @param {unknown} raw
 * @returns {typeof DEFAULTS}
 */
export function normalizeConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = { ...DEFAULTS };

  for (const key of BOOLEAN_KEYS) {
    if (typeof source[key] === 'boolean') out[key] = source[key];
  }
  for (const key of NUMBER_KEYS) {
    const number = source[key];
    if (typeof number === 'number' && Number.isFinite(number)) out[key] = number;
  }
  for (const key of STRING_KEYS) {
    if (typeof source[key] === 'string') out[key] = source[key].trim();
  }
  if (source.locale === 'auto' || source.locale === 'zh' || source.locale === 'en') {
    out.locale = source.locale;
  }
  if (REASONING_EFFORTS.includes(out.reasoningEffort) === false) {
    out.reasoningEffort = DEFAULTS.reasoningEffort;
  }

  out.maxPromptChars = Math.max(1, Math.min(100_000, Math.trunc(out.maxPromptChars)));
  out.maxTokens = Math.max(256, Math.min(16_384, Math.trunc(out.maxTokens)));
  out.timeoutMs = Math.max(1_000, Math.min(300_000, Math.trunc(out.timeoutMs)));
  out.order = Math.max(0, Math.min(10_000, Math.trunc(out.order)));
  return out;
}

/** Standard Schema contract understood by Cordis/DSH. */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-prompt-enhancer',
    validate(value) {
      try {
        return { value: normalizeConfig(value) };
      } catch (error) {
        return { issues: [{ message: `配置无效：${error?.message ?? String(error)}`, path: [] }] };
      }
    },
  },
};
