/**
 * Configuration for dsh-prompt-enhancer.
 *
 * The host can hand a plugin any JSON value.  This module deliberately keeps the
 * normalizer dependency-free and forgiving: invalid values fall back to defaults
 * so a malformed profile cannot prevent DSH from booting.
 */

export const DEFAULTS = Object.freeze({
  enabled: true,
  /** `auto`, `zh` or `en`; only affects labels/questions, never the input. */
  locale: 'auto',
  /** Add explicit section headings and gap markers to the result. */
  addSectionLabels: true,
  /** Include inferred assumptions in the returned metadata. */
  includeAssumptions: true,
  /** Include questions for sections that are absent. */
  includeQuestions: true,
  /** Include safety/ambiguity warnings in the returned metadata. */
  includeRisks: true,
  /** Keep an accidentally huge request from consuming the host process. */
  maxPromptChars: 12000,
  /** Ordering hint for hosts that expose a system-prompt section API. */
  order: 950,
});

const BOOLEAN_KEYS = ['enabled', 'addSectionLabels', 'includeAssumptions', 'includeQuestions', 'includeRisks'];
const NUMBER_KEYS = ['maxPromptChars', 'order'];

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
    const number = Number(source[key]);
    if (Number.isFinite(number)) out[key] = number;
  }
  if (source.locale === 'auto' || source.locale === 'zh' || source.locale === 'en') {
    out.locale = source.locale;
  }

  out.maxPromptChars = Math.max(1, Math.min(100_000, Math.trunc(out.maxPromptChars)));
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
