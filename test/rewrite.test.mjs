import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMetaPrompt, cleanModelOutput, streamText, rewriteWithLlm, rewriteWithLlmRetry, resolveReasoningEffort, classifyLlmError, REWRITE_DEFAULTS, REASONING_EFFORTS } from '../src/rewrite.mjs';

function mockLlm(texts, chunks = null) {
  const calls = [];
  const llm = {
    calls,
    stream(request) {
      calls.push(request);
      const parts = chunks ?? (Array.isArray(texts) ? texts : [texts]);
      const values = [];
      for (const part of parts) {
        if (typeof part === 'string') values.push({ type: 'text-delta', text: part });
        else values.push(part);
      }
      values.push({ type: 'finish', reason: { kind: 'stop' } });
      return (async function* () { for (const value of values) yield value; })();
    },
  };
  return llm;
}

/** Capability seam shaped like the runtime's LlmRuntime.prepareCall. */
function capableLlm(efforts, { text = '增强后的提示词' } = {}) {
  const llm = mockLlm([text]);
  llm.prepareCall = async (config, signal, configure) => {
    const info = efforts === null
      ? {}
      : { reasoning: { efforts: efforts.map((id) => ({ id })) } };
    if (configure) {
      const controls = configure({}, info) ?? {};
      config = { ...config, ...controls };
    }
    if (efforts !== null && config.reasoningEffort !== undefined && !efforts.includes(config.reasoningEffort)) {
      const error = new Error(`model does not support reasoning effort "${config.reasoningEffort}"`);
      error.code = 'UNSUPPORTED_REASONING_EFFORT';
      throw error;
    }
    return {
      config: { provider: config.provider, model: config.model, reasoningEffort: config.reasoningEffort },
      stream: () => (async function* () {
        yield { type: 'text-delta', text };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })(),
    };
  };
  return llm;
}

test('meta prompt teaches the descriptive-request house style without local-label contamination', () => {
  const meta = buildMetaPrompt({ locale: 'auto' });
  assert.match(meta, /flowing descriptive request/, 'the rewrite must be a descriptive request, not a process brief');
  assert.match(meta, /capabilities and options such a task naturally involves/, 'general-scope expansion is the reference behaviour');
  assert.match(meta, /do NOT pick one, do NOT add disclaimers/);
  assert.match(meta, /明确插件的目标平台与适用范围/, 'the situational-defer example shows the expected phrasing');
  assert.match(meta, /60 to 180 characters/, 'the length budget fights the over-elaboration the bench exposed');
  assert.doesNotMatch(meta, /Add light structure|SUGGESTED CLARIFICATIONS|已表达事实|Already expressed in the draft/, 'no label-injecting evidence block');
  assert.doesNotMatch(meta, /我想做/, 'the raw draft never enters the meta prompt');
});

test('meta prompt locale overrides pin the output language', () => {
  assert.match(buildMetaPrompt({ locale: 'zh' }), /Simplified Chinese/);
  assert.match(buildMetaPrompt({ locale: 'en' }), /in English/);
  assert.doesNotMatch(buildMetaPrompt({ locale: 'auto' }), /OVERRIDE/);
});

test('meta prompt never turns recognized gaps into questions for the user', () => {
  const meta = buildMetaPrompt({ raw: '美化一下dsh界面', locale: 'auto' });
  assert.match(meta, /do NOT ask the user/);
  assert.match(meta, /rewritten prompt only/);
});

test('cleanModelOutput strips fences, quotes, labeled prefixes and leaked markdown', () => {
  assert.equal(cleanModelOutput('```\n目标：写报告\n```'), '目标：写报告');
  assert.equal(cleanModelOutput('```markdown\n目标：写报告\n```'), '目标：写报告');
  assert.equal(cleanModelOutput('增强后的提示词：目标：写报告'), '目标：写报告');
  assert.equal(cleanModelOutput('"目标：写报告"'), '目标：写报告');
  assert.equal(cleanModelOutput('“目标：写报告”'), '目标：写报告');
  assert.equal(cleanModelOutput('  目标：写报告  '), '目标：写报告');
  assert.equal(cleanModelOutput('## 目标\n写**报告**\n- 列点'), '目标\n写报告\n· 列点', 'markdown degrades to plain text');
});

test('streamText collects only text-delta and surfaces error/aborted/max-tokens finishes', async () => {
  const llm = mockLlm(['你', '好', { type: 'reasoning-delta', text: '思考中' }, '世界']);
  assert.equal(await streamText(llm, {}), '你好世界');

  await assert.rejects(streamText(mockLlm(['x', { type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }]), {}), /boom/);
  await assert.rejects(streamText(mockLlm([{ type: 'finish', reason: { kind: 'aborted' } }]), {}), /cancelled/);
  await assert.rejects(streamText(mockLlm([{ type: 'finish', reason: { kind: 'max-tokens' } }]), {}), /output limit/);
  await assert.rejects(streamText({ stream: () => (async function* () { yield { type: 'text-delta', text: 'x' }; })() }, {}), /ended before finishing/);
});

test('streamText reports first reasoning and first text timings', async () => {
  const llm = mockLlm([
    { type: 'reasoning-delta', text: '想' },
    { type: 'reasoning-delta', text: '想' },
    '结果',
  ]);
  const timing = {};
  await streamText(llm, {}, {
    onFirstReasoning: (ms) => { timing.reasoningMs = ms; },
    onFirstText: (ms) => { timing.textMs = ms; },
  });
  assert.equal(typeof timing.reasoningMs, 'number');
  assert.equal(typeof timing.textMs, 'number');
  assert.ok(timing.textMs >= timing.reasoningMs, 'text follows reasoning in the stream');
});

test('resolveReasoningEffort picks the cheapest supported effort via prepareCall', async () => {
  const route = { provider: 'p', model: 'm' };
  const capable = capableLlm(['off', 'minimal', 'low', 'medium', 'high']);
  const result = await resolveReasoningEffort(capable, route, 'auto', 1024, undefined);
  assert.equal(result.effort, 'minimal', 'minimal is cheaper than low and beats off');
  assert.equal(typeof result.dispatch, 'function', 'a prepared dispatch must be returned');
  assert.equal(result.warnings.length, 0);
});

test('resolveReasoningEffort degrades to low when minimal is absent', async () => {
  const route = { provider: 'p', model: 'm' };
  const capable = capableLlm(['off', 'low', 'medium', 'high']);
  const result = await resolveReasoningEffort(capable, route, 'auto', 1024, undefined);
  assert.equal(result.effort, 'low');
});

test('resolveReasoningEffort honors an explicit effort and validates it', async () => {
  const route = { provider: 'p', model: 'm' };
  const capable = capableLlm(['low', 'medium', 'high']);
  assert.equal((await resolveReasoningEffort(capable, route, 'low', 1024, undefined)).effort, 'low');

  // Unsupported explicit effort: every candidate is refused → route default.
  const strict = capableLlm(['low', 'medium', 'high']);
  const rejected = await resolveReasoningEffort(strict, route, 'minimal', 1024, undefined);
  assert.equal(rejected.effort, null, 'refused explicit effort degrades to the route default');
  assert.ok(rejected.warnings.some((w) => /minimal/.test(w)));
});

test('resolveReasoningEffort without a capability seam passes explicit through and omits auto', async () => {
  const route = { provider: 'p', model: 'm' };
  const plain = mockLlm('x');
  assert.equal((await resolveReasoningEffort(plain, route, 'low', 1024, undefined)).effort, 'low');
  const auto = await resolveReasoningEffort(plain, route, 'auto', 1024, undefined);
  assert.equal(auto.effort, null, 'auto without capabilities leaves the route default');
  assert.equal(auto.dispatch, null);
});

test('resolveReasoningEffort falls back when no cheap effort is advertised', async () => {
  const route = { provider: 'p', model: 'm' };
  const expensive = capableLlm(['high', 'xhigh', 'max']);
  const result = await resolveReasoningEffort(expensive, route, 'auto', 1024, undefined);
  assert.equal(result.effort, null, 'never gamble on an expensive effort');
  assert.ok(result.warnings.some((w) => /no low-cost/.test(w)));
});

test('rewriteWithLlm builds a valid dsh-llm request and guards runaway output', async () => {
  const llm = mockLlm(['目标：写报告']);
  const route = { provider: 'deepseek-official', model: 'deepseek-chat' };
  const raw = '写个报告';
  const enhanced = await rewriteWithLlm(llm, route, raw, { locale: 'zh' });
  assert.equal(enhanced, '目标：写报告');
  const request = llm.calls[0];
  assert.deepEqual(request.provider, 'deepseek-official');
  assert.deepEqual(request.model, 'deepseek-chat');
  assert.equal(request.maxTokens, REWRITE_DEFAULTS.maxTokens);
  assert.equal(request.purpose, 'prompt-enhancer');
  assert.equal(request.system, buildMetaPrompt({ locale: 'zh' }));
  assert.doesNotMatch(request.system, /<original_prompt>/, 'the draft is not re-embedded as a second system block');
  assert.equal(request.messages.length, 1);
  assert.deepEqual(request.messages[0].content, [{ type: 'text', text: raw }]);
  assert.ok(request.signal instanceof AbortSignal);

  const long = mockLlm('x'.repeat(5000));
  await assert.rejects(rewriteWithLlm(long, route, raw), /grew beyond/);
  await assert.rejects(rewriteWithLlm(mockLlm('   '), route, raw), /empty/);
});

test('rewriteWithLlm runs on the cheapest supported effort and reports metrics', async () => {
  const capable = capableLlm(['off', 'minimal', 'low', 'medium', 'high'], { text: '目标：写报告' });
  const route = { provider: 'p', model: 'm' };
  const metrics = {};
  const enhanced = await rewriteWithLlm(capable, route, '写个报告', { locale: 'zh', metrics });
  assert.equal(enhanced, '目标：写报告');
  assert.equal(metrics.reasoningEffort, 'minimal', 'the prepared call must carry the cheapest effort');
  assert.equal(metrics.maxTokens, REWRITE_DEFAULTS.maxTokens);
  assert.equal(typeof metrics.totalMs, 'number');
  assert.equal(typeof metrics.textMs, 'number', 'first text delta is always timed');
  assert.equal(metrics.reasoningMs, undefined, 'no reasoning deltas in this stream');
});

test('rewrite distinguishes its deadline from a caller cancellation', async () => {
  const route = { provider: 'p', model: 'm' };
  const slow = { stream(request) {
    return (async function* () {
      await new Promise((resolve) => setTimeout(resolve, 1100));
      if (request.signal.aborted) yield { type: 'finish', reason: { kind: 'aborted' } };
      else { yield { type: 'text-delta', text: 'ok' }; yield { type: 'finish', reason: { kind: 'stop' } }; }
    })();
  } };
  await assert.rejects(rewriteWithLlm(slow, route, 'x', { timeoutMs: 5 }), /timed out after 1000ms/);
  const caller = new AbortController();
  caller.abort();
  await assert.rejects(rewriteWithLlm(slow, route, 'x', { timeoutMs: 1000, signal: caller.signal }), /cancelled/);
});

test('rewrite defaults are bounded and reproducible', () => {
  assert.ok(REWRITE_DEFAULTS.maxTokens > 0);
  assert.ok(REWRITE_DEFAULTS.timeoutMs > 0);
  assert.ok(REWRITE_DEFAULTS.maxOutputChars > 0);
  assert.ok(REWRITE_DEFAULTS.maxOutputRatio > 1);
  assert.equal(REWRITE_DEFAULTS.maxTokens, 768, 'v0.3.4 trims the output budget for the concise style');
  assert.equal(REWRITE_DEFAULTS.maxOutputRatio, 2.5, 'v0.3.6 tightens the runaway guard for the descriptive style');
  assert.deepEqual(REASONING_EFFORTS, ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
});

test('classifyLlmError separates fatal provider limits from retryable failures', () => {
  const quota = classifyLlmError(new Error('429: {"code":"USAGE_LIMIT_EXCEEDED","message":"error: code=429 reason=\"MONTHLY_LIMIT_EXCEEDED\" message=\"monthly usage limit exceeded\" metadata=map[]"}'));
  assert.equal(quota.code, 'quota');
  assert.equal(quota.retryable, false, 'a monthly-limit 429 must not tell the user to retry');
  assert.match(quota.message, /额度已用尽/);
  assert.equal(quota.detail, 'USAGE_LIMIT_EXCEEDED');

  const rate = classifyLlmError({ status: 429, message: '429 Too Many Requests' });
  assert.equal(rate.code, 'rate');
  assert.equal(rate.retryable, true);

  assert.equal(classifyLlmError({ status: 401, message: 'invalid api key' }).code, 'auth');
  assert.equal(classifyLlmError({ status: 503, message: 'overloaded' }).retryable, true);
  assert.equal(classifyLlmError(new Error('the model request timed out after 120000ms')).retryable, true);
  assert.equal(classifyLlmError(new Error('boom')).code, 'unknown');
});

test('rewriteWithLlmRetry retries transient failures but not fatal ones', async () => {
  const route = { provider: 'p', model: 'm' };
  const transient = mockLlm();
  transient.stream = (request) => {
    transient.calls.push(request);
    if (transient.calls.length === 1) {
      const error = new Error('503 overloaded');
      error.status = 503;
      throw error;
    }
    return (async function* () { yield { type: 'text-delta', text: '结果' }; yield { type: 'finish', reason: { kind: 'stop' } }; })();
  };
  const ok = await rewriteWithLlmRetry(transient, route, '草稿', { retryDelayMs: 1 }, { attempts: 2 });
  assert.equal(ok, '结果');
  assert.equal(transient.calls.length, 2, 'a transient failure is retried once');

  const fatal = mockLlm();
  fatal.stream = (request) => {
    fatal.calls.push(request);
    const error = new Error('429: {"code":"USAGE_LIMIT_EXCEEDED"}');
    error.status = 429;
    throw error;
  };
  await assert.rejects(
    rewriteWithLlmRetry(fatal, route, '草稿', { retryDelayMs: 1 }, { attempts: 3 }),
    /USAGE_LIMIT_EXCEEDED/,
  );
  assert.equal(fatal.calls.length, 1, 'a quota failure is never retried');
});
