/**
 * Model-based prompt rewrite for dsh-prompt-enhancer.
 *
 * Local intent evidence (src/intent.mjs) is shown to the model so it treats
 * already-expressed facts as given and never asks the user about them again.
 * All wire behaviour (llm.stream chunk kinds, finish reasons) follows the
 * @deepseek-ai/dsh-llm service contract; see docs/DETAIL.md.
 */

import { analyzeIntent } from './intent.mjs';

export const REWRITE_DEFAULTS = Object.freeze({
  maxTokens: 2048,
  // DeepSeek reasoning models can spend well over 20s before their first token.
  // Keep this below DSH's default 300s idle timeout while avoiding false cancels.
  timeoutMs: 120000,
  maxInputChars: 12000,
  /** Runaway guard: refuse outputs longer than max(600, this × input length). */
  maxOutputRatio: 3.5,
  maxOutputChars: 4000,
});

/**
 * Build the rewrite meta-prompt from the raw draft plus local evidence.
 * @param {{raw: string, locale: 'zh'|'en'|'auto'}} input
 * @returns {string}
 */
export function buildMetaPrompt({ raw, locale = 'auto' }) {
  const lang = locale === 'zh' || locale === 'en' ? locale : (/[\u3400-\u9fff]/.test(raw) ? 'zh' : 'en');
  const analysis = analyzeIntent(raw, lang, 'general');
  const lines = [
    'You rewrite a user\'s rough draft into a clear, specific, self-contained, executable prompt for an AI agent that can read files, run commands, browse the web and write code.',
    '',
    'CORE RULES:',
    '- Preserve the user\'s original intent, scope and language. You are rewriting a request, not answering it.',
    '- Keep every concrete detail verbatim: names, paths, numbers, error text, URLs, options.',
    '- Never fabricate specifics the user did not provide: no invented tech stack, file paths, versions, or requirements.',
    '- Remove redundancy, fix typos and fragments, and make the ask actionable.',
    '- Do NOT explain how to do the task, answer the question, or add a preamble like "Here is the enhanced prompt".',
    '- Do NOT ask the user any questions and do NOT ask for confirmation. If a detail is genuinely unknown, fill it with an inline default marked "(默认：...)" or "(default: ...)", or phrase it as a conditional requirement ("如果需要登录，则...").',
    '- Add light structure (short labeled lines such as 目标/背景/约束/产出/验收, or Goal/Context/Constraints/Deliverables/Acceptance in English) only when it genuinely helps. Never pad with generic prompt-engineering boilerplate.',
    '- OUTPUT: only the rewritten prompt text. No commentary, no quotes around it, no code fences around the whole output.',
    '',
    'LOCAL EVIDENCE — already expressed in the original draft. Treat these as given; do not treat them as missing and do not ask about them again:',
  ];
  if (analysis.recognizedFacts.length === 0) lines.push('- (none recognized by local rules; the draft alone is your source of truth)');
  else {
    for (const fact of analysis.recognizedFacts) lines.push(`- ${fact.label}：${fact.evidence.replace(/\s*\n\s*/g, ' ')}`);
  }
  if (analysis.clarifications.length > 0) {
    lines.push(
      '',
      'SUGGESTED CLARIFICATIONS from local rules. The user has NOT answered these; never ask them again — fold the gap into the prompt as a default or conditional requirement:',
    );
    for (const item of analysis.clarifications) lines.push(`- ${item.question}`);
  }
  lines.push('', 'Raw draft:', '<original_prompt>', raw, '</original_prompt>');
  return lines.join('\n');
}

/** Strip common model-output wrappers so the result lands cleanly in the composer. */
export function cleanModelOutput(value) {
  let out = String(value ?? '').trim();
  const fence = out.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/);
  if (fence) out = fence[1].trim();
  out = out.replace(/^(?:enhanced prompt|提示词增强|增强后的提示词|改写后(?:的提示词)?)\s*[:：]\s*/i, '');
  const quoted = out.match(/^"([\s\S]*)"$|^“([\s\S]*)”$|^「([\s\S]*)」$/);
  if (quoted) out = (quoted[1] ?? quoted[2] ?? quoted[3]).trim();
  return out;
}

/**
 * Collect text from an llm.stream() call following the dsh-llm chunk contract.
 * @param {{stream(options: object): AsyncIterable<object>}} llm
 * @param {object} request — {provider, model, messages, maxTokens, signal}
 * @returns {Promise<string>}
 */
export async function streamText(llm, request) {
  let text = '';
  let finished = false;
  for await (const chunk of llm.stream(request)) {
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
    else if (chunk.type === 'finish') {
      finished = true;
      const reason = chunk.reason ?? {};
      if (reason.kind === 'error') throw new Error(reason.failure?.message ?? 'the model request failed');
      if (reason.kind === 'aborted') throw new Error('the model request was cancelled');
      if (reason.kind === 'max-tokens' && text.trim() === '') throw new Error('the model hit its output limit before writing any text');
    }
  }
  if (!finished) throw new Error('the model stream ended before finishing');
  return text;
}

/**
 * One guarded rewrite: build meta-prompt, stream, clean, apply runaway limits.
 * @param {{stream(options: object): AsyncIterable<object>}} llm
 * @param {{provider: string, model: string}} route
 * @param {string} raw
 * @param {object} settings — REWRITE_DEFAULTS plus locale and optional caller signal
 * @returns {Promise<string>}
 */
export async function rewriteWithLlm(llm, route, raw, settings = {}) {
  const config = { ...REWRITE_DEFAULTS, ...settings };
  const timeout = Number.isFinite(config.timeoutMs) ? Math.max(1000, Math.min(300000, config.timeoutMs)) : REWRITE_DEFAULTS.timeoutMs;
  const timeoutSignal = AbortSignal.timeout(timeout);
  const callerSignal = config.signal && typeof config.signal.aborted === 'boolean' ? config.signal : null;
  const signal = callerSignal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : (callerSignal ?? timeoutSignal);
  let collected;
  try {
    collected = await streamText(llm, {
    provider: route.provider,
    model: route.model,
    maxTokens: config.maxTokens,
    // Official dsh-llm one-shot shape: rules go in the `system` field, the draft
    // stays the single user message so providers that only read the first
    // system block still receive the instructions.
    system: buildMetaPrompt({ raw, locale: config.locale ?? 'auto' }),
    messages: [
      { role: 'user', content: [{ type: 'text', text: raw }] },
    ],
    // Cost attribution: this call is an enhancement, not a conversation turn.
    purpose: 'prompt-enhancer',
    signal,
  });
  } catch (error) {
    // dsh-llm reports both caller cancellation and our deadline as `aborted`.
    // Preserve the distinction so a slow reasoning model is actionable rather
    // than misleadingly reported as if the user clicked cancel.
    if (timeoutSignal.aborted && !callerSignal?.aborted) {
      throw new Error(`the model request timed out after ${timeout}ms`);
    }
    throw error;
  }
  const cleaned = cleanModelOutput(collected);
  if (!cleaned) throw new Error('the model returned an empty prompt');
  const limit = Math.min(Math.max(Math.round(raw.length * config.maxOutputRatio), 600), config.maxOutputChars);
  if (cleaned.length > limit) throw new Error(`the rewrite grew beyond ${limit} characters and was discarded`);
  return cleaned;
}
