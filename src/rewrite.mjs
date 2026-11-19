/**
 * Model-based prompt rewrite for dsh-prompt-enhancer.
 *
 * All wire behaviour (llm.stream chunk kinds, finish reasons) follows the
 * @deepseek-ai/dsh-llm service contract; see docs/DETAIL.md.
 *
 * Style (v0.3.6): the meta-prompt mirrors the two reference enhancers'
 * instruction sets — short rules, expand with capabilities general to the
 * task kind, defer situational specifics to the agent, and, after a real
 * bench exposed the v0.3.5 failure mode, an explicit descriptive-request
 * shape with a length budget and a ban on step-by-step instructions. Local
 * intent evidence (src/intent.mjs) is no longer injected into the
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
  /** Runaway guard: refuse outputs longer than max(400, this × input length). */
  maxOutputRatio: 2.5,
  maxOutputChars: 3000,
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
 * v0.3.5 aligned the instruction set with the two reference enhancers (AntMan
 * short SYSTEM_PROMPT, saul BASE_RULES) after finding why ours read
 * differently: they never inject locally-extracted labelled evidence, they
 * expand with capabilities general to the task kind, and they defer
 * situational choices to the agent.
 *
 * v0.3.6 fixes what a real-model bench exposed next: the v0.3.5 rules were
 * read as a *process brief*, so the model answered with 200–400 character
 * "请先明确…然后阅读…请找出…" instruction lists — longer and more complex than
 * the reference's descriptive one-paragraph request the user compared against.
 * The rules now name the reference shape explicitly: a flowing descriptive
 * request with colon-led clauses and parenthetical enumeration, with a
 * length budget and an explicit ban on step-by-step instructions.
 * The draft travels as the single user message (see rewriteWithLlm).
 * @param {{locale: 'zh'|'en'|'auto'}} input
 * @returns {string}
 */
export function buildMetaPrompt({ locale = 'auto' }) {
  const lines = [
    'You rewrite a user\'s rough draft into a better prompt for an AI coding agent that can read files, run commands and write code. You rewrite a request: you do not answer it and you do not plan steps for the agent.',
    '',
    'Rules:',
    '- Keep the user\'s intent, language and every concrete detail (names, paths, numbers, error text, URLs, options). What the draft already states is settled; never drop it or re-ask for it.',
    '- Fix typos and fragments. Make the goal explicit in one phrase: what to build or do, and what the result should be.',
    '- Expand with the capabilities and options such a task naturally involves, using short comma-led or parenthetical clauses (for example 可调节的参数、预设、预览、持久化、错误处理、验收行为). These are general to the kind of task, not invented user requirements.',
    '- For specifics the user did not give (target platform, tech stack, exact file names), do NOT pick one, do NOT add disclaimers, and do NOT ask the user: name them as a scope the agent must confirm or decide inside the request (for example "明确插件的目标平台与适用范围").',
    '- Write it as a flowing descriptive request: one sentence, or one short paragraph in the draft\'s language, listing what to produce with colon-led clauses and parenthetical enumeration — like "开发一个美化界面的插件工具：明确目标平台与适用范围，定义可调节的美化能力，说明如何选择预设或自定义参数，支持实时预览，以及保存、切换与恢复默认的机制。确保简洁易用、性能良好。" Never a step-by-step process for the agent (no 请先…然后…请找出…请运行…), never a checklist, never acceptance instructions.',
    '- Keep it concise: roughly 1.5 to 3 times the draft\'s length, around 60 to 180 characters for a short draft. No markdown, no headings, no 目标/背景/约束-style labels, no preamble.',
    '- Reply with the rewritten prompt only.',
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

/**
 * Classify a provider failure into an actionable Chinese message.
 *
 * Provider-side failures share a status code plus a JSON body; the raw text
 * is noise for the user. Two distinctions matter more than the rest:
 * retryable (rate limit, overloaded, network) vs fatal (quota exhausted, bad
 * credentials, unknown model), and — the bug users hit — a 429 that says
 * MONTHLY_LIMIT_EXCEEDED is NOT retryable: retrying burns another queue slot
 * and fails again the same way.
 *
 * @param {any} error
 * @returns {{code: string, retryable: boolean, message: string, detail: string}}
 */
export function classifyLlmError(error) {
  const message = String(error?.message ?? error ?? '')
  const status = Number(error?.status ?? error?.statusCode ?? 0)
  const statusText = `${message.trim().slice(0, 200)}`

  const patterns = {
    quota: /(USAGE_LIMIT_EXCEEDED|MONTHLY_LIMIT_EXCEEDED|DAILY_LIMIT_EXCEEDED|insufficient_quota|quota|billing|balance|额度|配额)/i,
    rate: /(RATE_LIMIT_EXCEEDED|too many requests|rate.?limit)/i,
    auth: /(invalid api key|unauthorized|authentication|permission)/i,
    context: /(context.?length|maximum context|too many tokens|prompt.?too.?long)/i,
    model: /(model.?not.?found|does not exist|no such model|not supported)/i,
    network: /(fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|network|timed out)/i,
    timeout: /timed out after|the model request timed out/i,
    aborted: /aborted/i,
  }
  let code = 'unknown';
  if (status === 401 || status === 403) {
    code = 'auth';
  } else if (patterns.quota.test(message)) {
    code = 'quota';
  } else if (patterns.rate.test(message)) {
    code = 'rate';
  } else if (patterns.auth.test(message)) {
    code = 'auth';
  } else if (patterns.context.test(message)) {
    code = 'context';
  } else if (patterns.model.test(message)) {
    code = 'model';
  } else if (patterns.timeout.test(message)) {
    code = 'timeout';
  } else if (patterns.network.test(message)) {
    code = 'network';
  } else if (patterns.aborted.test(message)) {
    code = 'aborted';
  }
  if (code === 'unknown') {
    if (status === 429) code = 'rate';
    else if (status === 413) code = 'too_long';
    else if (status === 400 || status === 404) code = 'bad_request';
    else if (status >= 500) code = 'network';
  }

  const detail = (message.match(/"code"\s*:\s*"([^"]+)"|reason="([^"]+)"/)?.[1]
    ?? message.match(/"code"\s*:\s*"([^"]+)"|reason="([^"]+)"/)?.[2]
    ?? message.trim())
    .slice(0, 80);

  const messages = {
    quota: '当前模型的本月用量额度已用尽（429 限额），再重试也是同样结果。请在插件设置或输入框的模型选择里换一个可用模型，额度恢复后即可使用。',
    rate: '模型服务当前限流（429），已自动重试仍未成功，请稍后再点一次。',
    auth: '模型路由鉴权失败（401/403）。请重新登录账号，或检查插件设置里的 provider/model 配置。',
    context: '草稿与指令超过了模型的上下文长度。请先精简草稿再增强。',
    model: '找不到该模型路由。请在插件设置里选择当前可用的 provider/model。',
    too_long: '输入过长，未发送给模型。请精简草稿或调大 maxPromptChars 配置。',
    bad_request: '模型拒绝了这次请求（请求格式或参数问题）。可换一个模型试试，或调整插件配置。',
    network: '模型服务连接失败或暂时不可用。这是临时问题，可直接重试。',
    timeout: '模型请求超时。免费中继排队时较慢，可多等一会儿，或在插件设置里换更快的模型。',
    aborted: '已取消本次增强。',
    unknown: '提示词增强失败，请重试或换一个模型。',
  };
  const retryable = ['rate', 'network', 'timeout', 'aborted'].includes(code) || (status >= 500 && code !== 'quota');

  return { code, retryable, message: messages[code] ?? messages.unknown, detail };
}

/**
 * rewriteWithLlm with bounded automatic retries for transient failures.
 * Fatal classifications (quota, auth, model, context) are never retried —
 * retrying them only wastes time and, on the free relay, a queue slot.
 *
 * @param {object} llm
 * @param {{provider: string, model: string}} route
 * @param {string} raw
 * @param {object} settings
 * @param {{attempts?: number, retryDelayMs?: number}} [options]
 * @returns {Promise<string>}
 */
export async function rewriteWithLlmRetry(llm, route, raw, settings, options = {}) {
  const attempts = Math.max(1, Math.min(3, Number(options.attempts ?? 2)));
  const retryDelayMs = Number(options.retryDelayMs ?? 400);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const enhanced = await rewriteWithLlm(llm, route, raw, settings);
      if (settings?.metrics) { try { settings.metrics.attempts = attempt; } catch { /* metrics are optional */ } }
      return enhanced;
    } catch (error) {
      lastError = error;
      const info = classifyLlmError(error);
      if (!info.retryable || attempt === attempts || (settings?.signal?.aborted)) {
        error.code = info.code;
        error.retryable = info.retryable;
        throw error;
      }
      const wait = retryDelayMs * attempt;
      if (settings?.signal?.aborted) { error.code = info.code; throw error; }
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, wait);
        settings?.signal?.addEventListener?.('abort', () => {
          clearTimeout(timer);
          const aborted = new Error('aborted');
          aborted.code = info.code;
          reject(aborted);
        }, { once: true });
      });
    }
  }
  throw lastError;
}
