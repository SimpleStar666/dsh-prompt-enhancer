/**
 * Model-based prompt rewrite for dsh-prompt-enhancer.
 *
 * All wire behaviour (llm.stream chunk kinds, finish reasons) follows the
 * @deepseek-ai/dsh-llm service contract; see docs/DETAIL.md.
 *
 * Style (v0.3.5): the meta-prompt mirrors the two reference enhancers'
 * instruction sets — short rules, expand with capabilities general to the
 * task kind, defer situational specifics to the agent, one flowing paragraph.
 * Local intent evidence (src/intent.mjs) is no longer injected into the
 * rewrite request: labelled evidence lines taught the model to answer with
 * 目标/背景/约束-style label blocks, which is exactly the over-structured
 * output style users compared unfavorably against the references. The local
 * analysis still powers the response metadata (recognizedFacts, riskFlags).
 *
 * Latency design (v0.3.3): the enhancement must not pay the conversation's
 * full reasoning bill. When the caller does not pin a reasoning effort, the
 * rewrite resolves the exact route's advertised efforts through the official
 * capability seam (`llm.prepareCall`) and picks the lowest supported one
 * (`minimal` → `low` → `off`), falling back to the route's own default when
 * nothing is discoverable. The sent effort and the stream timing are recorded
 * for the API response.
 */

export const REWRITE_DEFAULTS = Object.freeze({
  /**
   * A concise rewrite needs a few hundred tokens; on providers whose
   * thinking shares the output ceiling (e.g. the free relay) a smaller
   * budget also trims thinking time. 1024 was more than the house style
   * needs, 2048 clearly oversized.
   */
  maxTokens: 768,
  // DeepSeek reasoning models can spend well over 20s before their first token.
  // Keep this below DSH's default 300s idle timeout while avoiding false cancels.
  timeoutMs: 120000,
  maxInputChars: 12000,
  /** Runaway guard: refuse outputs longer than max(600, this × input length). */
  maxOutputRatio: 3.5,
  maxOutputChars: 4000,
  /**
   * Reasoning effort for the rewrite call. `auto` (default) resolves the
   * exact model's advertised efforts and picks the lowest supported one;
   * an explicit effort id (off/minimal/low/medium/high/xhigh/max) is used
   * verbatim when the model supports it.
   */
  reasoningEffort: 'auto',
});

/** Effort ids the config layer accepts, cheapest first. */
export const REASONING_EFFORTS = Object.freeze([
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
]);

/** Preference order for the auto picker: cheapest real reasoning first. */
const AUTO_EFFORT_ORDER = Object.freeze(['minimal', 'low', 'off', 'medium']);

/**
 * Capability view of one exact route. Any field may be absent on hosts that
 * do not expose the capability seam; the rewrite degrades to plain stream().
 * @typedef {{ effort: string|null, resolve: Function|null, prepare: Function|null,
 *             defaultEffort: string|null, supported: string[], maxTokens: number|null,
 *             warnings: string[] }} RouteCapability
 */

/**
 * Build the rewrite meta-prompt.
 *
 * v0.3.5 aligns the instruction set with the two reference enhancers that the
 * user compared against (AntMan-xtalgh's short SYSTEM_PROMPT and saul-dsh's
 * BASE_RULES) after finding why ours read differently:
 *   1. They never inject locally-extracted labelled evidence — such lines
 *      teach the model to imitate the label format (our 目标/背景/约束 output).
 *   2. Their missing-info policy is "expand with capabilities general to the
 *      task kind; defer situational choices to the agent" — not "invent
 *      defaults with a (默认：…) disclaimer, and never elaborate".
 *   3. Their prompt is one short paragraph of rules, not a long clause list.
 * The draft travels as the single user message (see rewriteWithLlm).
 * @param {{locale: 'zh'|'en'|'auto'}} input
 * @returns {string}
 */
export function buildMetaPrompt({ locale = 'auto' }) {
  const lines = [
    'You rewrite a user\'s rough draft into a better prompt for an AI agent that can read files, run commands and write code. You are rewriting a request, never answering it.',
    '',
    'Rules:',
    '- Preserve the user\'s intent, language and every concrete detail (names, paths, numbers, error text, URLs, options). What the draft already states is settled; do not treat it as missing.',
    '- Fix typos and garbled text; turn fragments into complete sentences; make the goal explicit: what to do, on what, and what done looks like.',
    '- Expand with the capabilities, options and constraints such a task normally involves — what a competent engineer would need decided anyway (adjustable parameters, presets, preview, persistence, error handling, acceptance behaviour). These are general to the kind of task, not invented user requirements.',
    '- For situational specifics the user did not give (target platform, tech stack, exact file names), do NOT pick one, do NOT add disclaimers, and do NOT ask the user: make clarifying or deciding it an explicit step inside the request ("明确插件的目标平台与适用范围"), or phrase it conditionally.',
    '- Output as one flowing paragraph (two at most) in the draft\'s own language. No section headings, no 目标/背景/约束-style labels, no bullet lists unless the draft is clearly multi-part, no markdown of any kind, no preamble, no code fences.',
    '- Reply with the rewritten prompt only. Be concise and specific.',
  ];
  if (locale === 'zh') lines.push('- OVERRIDE: write the rewritten prompt in Simplified Chinese.');
  else if (locale === 'en') lines.push('- OVERRIDE: write the rewritten prompt in English.');
  return lines.join('\n');
}

/**
 * Strip common model-output wrappers so the result lands cleanly in the
 * composer. The composer is plain text, so leaked markdown is noise: strip
 * heading marks, bold markers and normalize bullets the way the reference
 * enhancer does (saul-dsh cleanModelOutput) as a last-line guard.
 */
export function cleanModelOutput(value) {
  let out = String(value ?? '').trim();
  const fence = out.match(/^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/);
  if (fence) out = fence[1].trim();
  out = out.replace(/^(?:enhanced prompt|提示词增强|增强后的提示词|改写后(?:的提示词)?)\s*[:：]\s*/i, '');
  const quoted = out.match(/^"([\s\S]*)"$|^“([\s\S]*)”$|^「([\s\S]*)」$/);
  if (quoted) out = (quoted[1] ?? quoted[2] ?? quoted[3]).trim();
  out = out
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^(\s*)[-*]\s+/gm, '$1· ');
  return out.trim();
}

/**
 * Collect text from an llm.stream() call following the dsh-llm chunk contract.
 * `observer` (when given) records first-token and reasoning timings.
 * @param {{stream(options: object): AsyncIterable<object>}|Function} llm —
 *   the llm service, or a prepared call's dispatch function.
 * @param {object} request — {provider, model, messages, maxTokens, signal}
 * @param {{onFirstReasoning?: Function, onFirstText?: Function}|null} observer
 * @returns {Promise<string>}
 */
export async function streamText(llm, request, observer = null) {
  const source = typeof llm === 'function' ? llm : llm.stream.bind(llm);
  const started = Date.now();
  let text = '';
  let finished = false;
  for await (const chunk of source(request)) {
    if (chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
      if (observer?.onFirstReasoning && text === '' && !observer._seenReasoning) {
        observer._seenReasoning = true;
        observer.onFirstReasoning(Date.now() - started);
      }
    } else if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      if (observer?.onFirstText && text === '' && !observer._seenText) {
        observer._seenText = true;
        observer.onFirstText(Date.now() - started);
      }
      text += chunk.text;
    } else if (chunk.type === 'finish') {
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
 * Resolve the reasoning effort for one rewrite call and, when the host exposes
 * `llm.prepareCall`, return a dispatch bound to the resolved configuration.
 *
 * The runtime's `prepareCall(config, signal, configure)` is the official seam:
 * `configure(controls, modelInfo)` receives the exact-model metadata (the
 * advertised reasoning efforts and default) synchronously, and the returned
 * handle's `stream` validates that the final request matches the resolved
 * config. `resolveCallConfig` alone cannot serve here — the runtime strips the
 * model info from its result.
 *
 * Explicit config: validate against the advertised efforts; when the seam is
 * unavailable the id is passed through and the adapter owns rejection.
 * `auto`: pick the lowest supported effort (`minimal` → `low` → `off`), or
 * the route default when the advertised list contains none of them. A route
 * whose capability lookup fails degrades to a plain `llm.stream` call — the
 * rewrite must never be blocked by the probe itself.
 *
 * `effort` is the concrete effort to send: `null` means "omit the field and
 * let the route default apply" (only safe with a plain `llm.stream` dispatch).
 * @returns {Promise<{effort: string|null, dispatch: Function|null, warnings: string[]}>}
 */
export async function resolveReasoningEffort(llm, route, preference, maxTokens, signal) {
  const warnings = [];
  const valid = (value) => typeof value === 'string' && REASONING_EFFORTS.includes(value);
  const explicit = valid(preference) && preference !== 'auto' ? preference : null;

  if (typeof llm.prepareCall !== 'function') {
    // No capability seam: pass an explicit effort through; auto means the
    // route's own default (omit the field entirely).
    return { effort: explicit, dispatch: null, warnings };
  }

  // Capture the exact-model metadata through the official configure hook.
  let captured = null;
  let baseline = null;
  try {
    baseline = await llm.prepareCall(
      { provider: route.provider, model: route.model, maxTokens },
      signal,
      (controls, info) => { captured = info; return controls; },
    );
  } catch (error) {
    warnings.push(`capability lookup failed for ${route.provider}/${route.model}: ${error?.message ?? String(error)}; using the route default effort`);
    return { effort: explicit, dispatch: null, warnings };
  }

  const effortIds = (captured?.reasoning?.efforts ?? [])
    .map((item) => (typeof item === 'string' ? item : item?.id))
    .filter((id) => typeof id === 'string');
  const defaultEffort = typeof captured?.reasoning?.defaultEffort === 'string'
    ? captured.reasoning.defaultEffort
    : null;
  const preparedEffort = typeof baseline?.config?.reasoningEffort === 'string'
    ? baseline.config.reasoningEffort
    : null;
  const preparedStream = typeof baseline?.stream === 'function' ? baseline.stream : null;

  let candidates;
  if (explicit !== null) {
    candidates = [explicit];
  } else if (effortIds.length === 0) {
    // No reasoning metadata advertised: the route default is the only option.
    return { effort: preparedEffort, dispatch: preparedStream, warnings };
  } else {
    candidates = AUTO_EFFORT_ORDER.filter((id) => effortIds.includes(id));
    if (candidates.length === 0) {
      warnings.push(
        `no low-cost reasoning effort available on ${route.provider}/${route.model} `
        + `(advertised: ${effortIds.join(', ')}); using the route default (${preparedEffort ?? defaultEffort ?? 'provider default'})`,
      );
      return { effort: preparedEffort, dispatch: preparedStream, warnings };
    }
  }

  for (const candidate of candidates) {
    if (effortIds.length > 0 && !effortIds.includes(candidate)) {
      warnings.push(`reasoning effort "${candidate}" is not supported by ${route.provider}/${route.model}`);
      continue;
    }
    let prepared;
    try {
      prepared = await llm.prepareCall(
        { provider: route.provider, model: route.model, reasoningEffort: candidate, maxTokens },
        signal,
      );
    } catch (error) {
      if (String(error?.code ?? '').includes('REASONING') || /reasoning/i.test(String(error?.message ?? ''))) {
        warnings.push(`reasoning effort "${candidate}" rejected for ${route.provider}/${route.model}: ${error?.message ?? String(error)}`);
        continue;
      }
      throw error;
    }
    const effective = typeof prepared?.config?.reasoningEffort === 'string'
      ? prepared.config.reasoningEffort
      : candidate;
    if (effective !== candidate) {
      warnings.push(`reasoning effort "${candidate}" mapped to "${effective}" by ${route.provider}/${route.model}`);
    }
    return {
      effort: effective,
      dispatch: typeof prepared?.stream === 'function' ? prepared.stream : null,
      warnings,
    };
  }

  // Every candidate was refused by the adapter: degrade to the route default.
  warnings.push('no supported reasoning effort accepted; using the route default');
  return { effort: preparedEffort, dispatch: preparedStream, warnings };
}

/**
 * One guarded rewrite: build meta-prompt, resolve the cheapest viable
 * reasoning effort, stream, clean, apply runaway limits.
 *
 * @param {{stream(options: object): AsyncIterable<object>}} llm
 * @param {{provider: string, model: string}} route
 * @param {string} raw
 * @param {object} settings — REWRITE_DEFAULTS plus locale, reasoningEffort,
 *   optional caller signal, and an optional `metrics` object to fill.
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

  const metrics = config.metrics && typeof config.metrics === 'object' ? config.metrics : null;
  const started = Date.now();
  const resolution = await resolveReasoningEffort(
    llm, route, config.reasoningEffort ?? 'auto', config.maxTokens, signal,
  );
  const stream = resolution.dispatch ?? llm;
  const request = {
    provider: route.provider,
    model: route.model,
    maxTokens: config.maxTokens,
    // Official dsh-llm one-shot shape: the short rules go in the `system`
    // field and the draft travels once, as the single user message — the
    // reference request shapes (AntMan SYSTEM_PROMPT, saul buildMetaPrompt).
    system: buildMetaPrompt({ locale: config.locale ?? 'auto' }),
    messages: [
      { role: 'user', content: [{ type: 'text', text: raw }] },
    ],
    // Cost attribution: this call is an enhancement, not a conversation turn.
    purpose: 'prompt-enhancer',
    ...resolution.effort === null ? {} : { reasoningEffort: resolution.effort },
    signal,
  };

  const timing = {};
  let collected;
  try {
    collected = await streamText(stream, request, {
      onFirstReasoning: (ms) => { timing.reasoningMs = ms; },
      onFirstText: (ms) => { timing.textMs = ms; },
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

  if (metrics) {
    metrics.totalMs = Date.now() - started;
    if (timing.reasoningMs !== undefined) metrics.reasoningMs = timing.reasoningMs;
    if (timing.textMs !== undefined) metrics.textMs = timing.textMs;
    metrics.reasoningEffort = resolution.effort;
    metrics.maxTokens = config.maxTokens;
    metrics.warnings = resolution.warnings;
  }

  const cleaned = cleanModelOutput(collected);
  if (!cleaned) throw new Error('the model returned an empty prompt');
  const limit = Math.min(Math.max(Math.round(raw.length * config.maxOutputRatio), 600), config.maxOutputChars);
  if (cleaned.length > limit) throw new Error(`the rewrite grew beyond ${limit} characters and was discarded`);
  return cleaned;
}
