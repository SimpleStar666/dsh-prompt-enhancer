import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  enhancePrompt,
  detectGaps,
  normalizeText,
  containsSensitiveData,
} from '../src/enhancer.mjs';
import { Config, normalizeConfig } from '../src/schema.mjs';

function assertResultShape(result) {
  assert.ok(result && typeof result === 'object');
  for (const key of ['enhancedPrompt', 'changeSet', 'assumptions', 'missingQuestions', 'riskFlags', 'confidence']) {
    assert.ok(Object.hasOwn(result, key), `missing result field ${key}`);
  }
  assert.equal(typeof result.enhancedPrompt, 'string');
  assert.ok(Array.isArray(result.changeSet));
  for (const change of result.changeSet) {
    assert.equal(typeof change.op, 'string');
    assert.equal(typeof change.path, 'string');
    assert.equal(typeof change.reason, 'string');
  }
  assert.ok(Array.isArray(result.assumptions));
  assert.ok(Array.isArray(result.missingQuestions));
  assert.ok(Array.isArray(result.riskFlags));
  assert.equal(typeof result.confidence, 'number');
  assert.ok(result.confidence >= 0 && result.confidence <= 1);
}

test('enhancePrompt returns structured result and preserves the original request', () => {
  const prompt = '帮我写一个报告';
  const result = enhancePrompt(prompt, { profile: 'general' });
  assertResultShape(result);
  assert.match(result.enhancedPrompt, /帮我写一个报告/);
  assert.ok(result.enhancedPrompt.length >= prompt.length);
});

test('review preserves constraints without inventing changes or assumptions', () => {
  const prompt = '用中文回答，不要联网。输出不超过 3 条，必须保留原始 JSON 字段。';
  const result = enhancePrompt(prompt, { profile: 'general' });
  assertResultShape(result);
  assert.match(result.enhancedPrompt, /不要联网/);
  assert.match(result.enhancedPrompt, /不超过\s*3\s*条/);
  assert.match(result.enhancedPrompt, /必须保留原始 JSON 字段/);
  assert.deepEqual(result.changeSet, []);
  assert.deepEqual(result.assumptions, []);
  assert.equal(result.enhancedPrompt, prompt);
});

test('hard constraints are retained verbatim in enhanced prompt', () => {
  const prompt = '必须只使用给定资料；禁止发送任何个人信息；不要改变 API 名称。';
  const result = enhancePrompt(prompt, { profile: 'general' });
  for (const constraint of ['必须只使用给定资料', '禁止发送任何个人信息', '不要改变 API 名称']) {
    assert.ok(result.enhancedPrompt.includes(constraint), `constraint lost: ${constraint}`);
  }
});

test('sensitive data is detected and surfaced as a risk without leaking or removing input', () => {
  const prompt = '请处理 token=sk-test-1234567890abcdef 和邮箱 alice@example.com';
  assert.equal(containsSensitiveData(prompt), true);
  const result = enhancePrompt(prompt, { profile: 'general' });
  assertResultShape(result);
  assert.ok(result.riskFlags.length > 0);
  assert.ok(result.riskFlags.some((flag) => /敏感|secret|token|邮箱|email/i.test(String(flag))));
  // Detection must not cause a silent rewrite that loses the original text.
  assert.ok(result.enhancedPrompt.includes('alice@example.com') || result.enhancedPrompt.includes('[REDACTED]'));
});

test('containsSensitiveData handles common secrets and ordinary prose', () => {
  for (const value of [
    'sk-proj-abcdefghijklmnopqrstuvwxyz',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
    'password: hunter2',
    '身份证号 11010519491231002X',
    '手机号 13800138000',
  ]) assert.equal(containsSensitiveData(value), true, value);
  for (const value of ['', '今天讨论一个公开的设计方案', 'contact us at example.org']) {
    assert.equal(containsSensitiveData(value), false, value);
  }
});

test('legacy detectGaps distinguishes recognized clues from unknown, never semantic absence', () => {
  const gaps = detectGaps('请帮我看看这个问题');
  assert.ok(Array.isArray(gaps));
  assert.ok(gaps.length > 0);
  assert.ok(gaps.every((gap) => typeof gap === 'object' && typeof gap.key === 'string'));
  assert.ok(gaps.some((gap) => gap.present === false));
  assert.ok(gaps.some((gap) => /target|background|outputFormat|successCriteria/i.test(gap.key)));
});

test('normalizeText extracts text without damaging code or whitespace', () => {
  assert.equal(normalizeText('  foo\r\n\t bar  '), '  foo\r\n\t bar  ');
  assert.equal(normalizeText({ content: [{ text: 'first' }, 'second'] }), 'first\nsecond');
  assert.equal(normalizeText(null), '');
  assert.equal(normalizeText(undefined), '');
});

test('empty or whitespace input is safe and does not throw', () => {
  for (const input of ['', '   ', null, undefined]) {
    const result = enhancePrompt(input, { profile: 'general' });
    assertResultShape(result);
    assert.equal(result.enhancedPrompt, '');
    for (const key of ['changeSet', 'assumptions', 'missingQuestions', 'riskFlags']) {
      assert.deepEqual(result[key], []);
    }
    assert.equal(result.confidence, 0);
  }
});

test('normalization and config are defensive and dependency-free', () => {
  assert.ok(Config && typeof Config === 'object');
  const config = normalizeConfig({ maxPromptChars: 12, order: ['gaps'], unknown: 'ignored' });
  assert.equal(config.maxPromptChars, 12);
  assert.equal(config.order, 950);
  assert.equal(Object.hasOwn(config, 'unknown'), false);
  assert.doesNotThrow(() => normalizeConfig(null));
});

test('numeric config ignores coercible wrong types and clamps only numbers', () => {
  for (const value of [null, '', true, '12', Symbol('bad'), { valueOf() { throw new Error('no coercion'); } }, Infinity, NaN]) {
    assert.equal(normalizeConfig({ maxPromptChars: value, order: value }).maxPromptChars, 12000);
    assert.equal(normalizeConfig({ order: value }).order, 950);
  }
  assert.equal(normalizeConfig({ maxPromptChars: 0 }).maxPromptChars, 1);
  assert.equal(normalizeConfig({ maxPromptChars: 200000 }).maxPromptChars, 100000);
});

test('disabled enhancement returns the exact original with empty metadata', () => {
  const prompt = '  请实现：\n```python\nif True:\n    print("x")\n```\n不要联网。  ';
  const result = enhancePrompt(prompt, { enabled: false });
  assert.equal(result.enhancedPrompt, prompt);
  for (const key of ['changeSet', 'assumptions', 'missingQuestions', 'riskFlags']) assert.deepEqual(result[key], []);
  assert.equal(result.confidence, 0);
});

test('multiline code and spacing are preserved verbatim', () => {
  const prompt = '请解释：\n```python\nif True:\n    print("a  b")\n```\n\t不要改代码。';
  assert.ok(enhancePrompt(prompt).enhancedPrompt.startsWith(prompt));
});

test('over-budget input is retained entirely, explained, and scanned for tail secrets', () => {
  const prompt = '公开材料'.repeat(10) + '\npassword: keep-me\n必须保留尾部约束';
  const result = enhancePrompt(prompt, { maxPromptChars: 12 });
  assert.equal(result.enhancedPrompt, prompt);
  assert.ok(result.riskFlags.includes('input_too_long'));
  assert.ok(result.riskFlags.includes('secret_or_personal_data'));
  assert.equal(result.changeSet[0].op, 'preserve');
  assert.match(result.changeSet[0].reason, /maxPromptChars/);
  assert.deepEqual(result.missingQuestions, []);
  assert.equal(enhancePrompt('ab', { maxPromptChars: 1 }).enhancedPrompt, 'ab');
  assert.ok(enhancePrompt('ab', { maxPromptChars: 1 }).riskFlags.includes('enhancement_skipped'));
});

test('legacy profile is accepted but never invents a stack, audience, or mandatory sections', () => {
  const prompt = '帮我做个东西';
  const general = enhancePrompt(prompt);
  for (const profile of ['general', 'writing', 'product', 'coding', 'unknown', null, 123, [], {}, { toString() { throw new Error('no coercion'); } }]) {
    assert.deepEqual(enhancePrompt(prompt, { profile, unknown: true }), general);
  }
});

test('optional questions never pad to a quota and metadata toggles are respected', () => {
  const prompt = '一个想法';
  assert.equal(enhancePrompt(prompt).missingQuestions.length, 1);
  const result = enhancePrompt(prompt, {
    addSectionLabels: false, includeQuestions: false, includeAssumptions: false, includeRisks: false,
  });
  assert.equal(result.enhancedPrompt, prompt);
  for (const key of ['changeSet', 'assumptions', 'missingQuestions', 'riskFlags']) assert.deepEqual(result[key], []);
});

test('complete requests are not expanded and gap detection is only heuristic', () => {
  const prompt = '目标：给团队写报告。背景：项目回顾。要求：只用资料。输出格式：Markdown。验收标准：可验证。';
  const result = enhancePrompt(prompt);
  assert.equal(result.enhancedPrompt, prompt);
  assert.deepEqual(result.changeSet, []);
  assert.deepEqual(result.missingQuestions, []);
  assert.deepEqual(result, enhancePrompt(prompt));
  assert.doesNotThrow(() => JSON.stringify(result));
});
