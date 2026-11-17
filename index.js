/**
 * dsh-prompt-enhancer — host entry.
 *
 * The package exposes both the DSH plugin contract and the pure enhancement
 * functions so they can be tested or embedded without starting the UI.
 */
export {
  apply,
  Config,
  DEFAULTS,
  ENHANCE_PATH,
  ROUTE_PATH,
  CONFIG_PATH,
  detectGaps,
  enhancePrompt,
  normalizeConfig,
  normalizeText,
  containsSensitiveData,
  rewriteWithLlm,
  inject,
  name,
} from './src/plugin.mjs';
