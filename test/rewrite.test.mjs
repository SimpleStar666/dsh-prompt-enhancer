import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMetaPrompt, cleanModelOutput, streamText, rewriteWithLlm, REWRITE_DEFAULTS } from '../src/rewrite.mjs';

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

test('meta prompt embeds the raw draft and never invents facts from local evidence', () => {
  const prompt = '我想做一个美化dsh交互界面的插件';
  const meta = buildMetaPrompt({ raw: prompt, locale: 'auto' });
  assert.ok(meta.includes('<original_prompt>\n我想做一个美化dsh交互界面的插件\n</original_prompt>'));
  assert.ok(meta.includes('插件'), 'evidence should quote the recognized deliverable');
  assert.ok(meta.includes('dsh'));
  assert.match(meta, /OUTPUT: only the rewritten prompt text/);
  assert.doesNotMatch(meta, /React|Tailwind|CSS 注入/, 'no invented tech stack');
});

test('meta prompt quotes the user-enumerated scope instead of asking it back', () => {
  const prompt = '我想做一个美化用户与dsh的交互界面的插件，美化部分包括交互界面、产出等';
  const meta = buildMetaPrompt({ raw: prompt, locale: 'auto' });
  assert.ok(meta.includes('美化部分包括交互界面、产出等'));
  assert.doesNotMatch(meta, /你最想美化/, 'an enumerated scope must not become a question');
});

test('meta prompt uses local clarifications as conditional guidance, not questions', () => {
  const meta = buildMetaPrompt({ raw: '美化一下dsh界面', locale: 'auto' });
  assert.ok(meta.includes('SUGGESTED CLARIFICATIONS'));
  assert.ok(meta.includes('never ask them again — fold the gap'), 'clarifications are guidance for the rewrite, not questions');
  assert.ok(meta.includes('Goal/task') === false, 'auto locale detects CJK and uses Chinese labels');
});

test('cleanModelOutput strips fences, quotes and labeled prefixes', () => {
  assert.equal(cleanModelOutput('```\n目标：写报告\n```'), '目标：写报告');
  assert.equal(cleanModelOutput('```markdown\n目标：写报告\n```'), '目标：写报告');
  assert.equal(cleanModelOutput('增强后的提示词：目标：写报告'), '目标：写报告');
  assert.equal(cleanModelOutput('"目标：写报告"'), '目标：写报告');
  assert.equal(cleanModelOutput('“目标：写报告”'), '目标：写报告');
  assert.equal(cleanModelOutput('  目标：写报告  '), '目标：写报告');
});

test('streamText collects only text-delta and surfaces error/aborted/max-tokens finishes', async () => {
  const llm = mockLlm(['你', '好', { type: 'reasoning-delta', text: '思考中' }, '世界']);
  assert.equal(await streamText(llm, {}), '你好世界');

  await assert.rejects(streamText(mockLlm(['x', { type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }]), {}), /boom/);
  await assert.rejects(streamText(mockLlm([{ type: 'finish', reason: { kind: 'aborted' } }]), {}), /cancelled/);
  await assert.rejects(streamText(mockLlm([{ type: 'finish', reason: { kind: 'max-tokens' } }]), {}), /output limit/);
  await assert.rejects(streamText({ stream: () => (async function* () { yield { type: 'text-delta', text: 'x' }; })() }, {}), /ended before finishing/);
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
  assert.equal(request.system, buildMetaPrompt({ raw, locale: 'zh' }));
  assert.equal(request.messages.length, 1);
  assert.deepEqual(request.messages[0].content, [{ type: 'text', text: raw }]);
  assert.ok(request.signal instanceof AbortSignal);

  const long = mockLlm('x'.repeat(5000));
  await assert.rejects(rewriteWithLlm(long, route, raw), /grew beyond/);
  await assert.rejects(rewriteWithLlm(mockLlm('   '), route, raw), /empty/);
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
});
