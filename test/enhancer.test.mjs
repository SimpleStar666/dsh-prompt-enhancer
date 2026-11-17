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

test('enhancement adds actionable gaps/change set without inventing hard constraints', () => {
  const prompt = '用中文回答，不要联网。输出不超过 3 条，必须保留原始 JSON 字段。';
  const result = enhancePrompt(prompt, { profile: 'general' });
  assertResultShape(result);
  assert.match(result.enhancedPrompt, /不要联网/);
  assert.match(result.enhancedPrompt, /不超过\s*3\s*条/);
  assert.match(result.enhancedPrompt, /必须保留原始 JSON 字段/);
  assert.ok(result.changeSet.length >= 0);
  assert.ok(!result.assumptions.some((a) => /不要联网|必须保留|不超过/.test(String(a))));
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

test('detectGaps identifies missing objective/output/context signals', () => {
  const gaps = detectGaps('请帮我看看这个问题');
  assert.ok(Array.isArray(gaps));
  assert.ok(gaps.length > 0);
  assert.ok(gaps.every((gap) => typeof gap === 'object' && typeof gap.key === 'string'));
  assert.ok(gaps.some((gap) => gap.present === false));
  assert.ok(gaps.some((gap) => /target|background|outputFormat|successCriteria/i.test(gap.key)));
});

test('normalizeText is deterministic and trims/normalizes whitespace', () => {
  assert.equal(normalizeText('  foo\r\n\t bar  '), 'foo bar');
  assert.equal(normalizeText(null), '');
  assert.equal(normalizeText(undefined), '');
});

test('empty or whitespace input is safe and does not throw', () => {
  for (const input of ['', '   ', null, undefined]) {
    const result = enhancePrompt(input, { profile: 'general' });
    assertResultShape(result);
    assert.equal(result.enhancedPrompt, '');
    assert.ok(result.missingQuestions.length >= 0);
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
