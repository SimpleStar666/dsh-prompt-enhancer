import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enhancePrompt, detectGaps } from '../src/enhancer.mjs';

function checkEvidence(prompt, result) {
  for (const fact of result.recognizedFacts) {
    assert.equal(prompt.slice(fact.start, fact.end), fact.evidence, fact.key);
    assert.ok(fact.evidence.trim(), fact.key);
  }
  assert.equal(result.enhancedPrompt, prompt, 'local rules must not pad/reword original intent');
  assert.deepEqual(result.changeSet, []);
  assert.deepEqual(result.assumptions, []);
  assert.equal(result.confidence, 0, 'no fabricated semantic-confidence score');
  assert.ok(result.clarifications.length <= 2);
  assert.deepEqual(result.missingQuestions, result.clarifications.map((question) => question.question));
  assert.ok(!result.riskFlags.some((flag) => flag.startsWith('missing_')));
  assert.ok(!/React|Tailwind|CSS 注入|必须|请明确.*目标|指定输出格式/.test(result.missingQuestions.join(' ')));
}
const fact = (result, key) => result.recognizedFacts.find((item) => item.key === key);

test('user regression: beautifying DSH already expresses goal, plugin deliverable and environment', () => {
  const prompt = '我想做一个美化dsh交互界面的插件';
  const result = enhancePrompt(prompt);
  checkEvidence(prompt, result);
  assert.ok(fact(result, 'target'));
  assert.equal(fact(result, 'deliverable').evidence, '插件');
  assert.equal(fact(result, 'environment').evidence, 'dsh');
  assert.equal(fact(result, 'outputFormat'), undefined, 'deliverable is not text formatting');
  assert.equal(result.clarifications[0].id, 'visual-scope');
  assert.match(result.clarifications[0].question, /交互界面.*哪些部分/);
  assert.doesNotMatch(result.missingQuestions.join(), /目标是什么|格式|约束|验收/);
  const gaps = detectGaps(prompt);
  assert.equal(gaps.find((gap) => gap.key === 'target').status, 'expressed');
  assert.equal(gaps.find((gap) => gap.key === 'outputFormat').status, 'unknown');
});

test('equivalent natural English request is not dependent on please/goal labels', () => {
  const prompt = 'I’d like a plugin that makes DSH’s interface easier on the eyes.';
  const result = enhancePrompt(prompt);
  checkEvidence(prompt, result);
  assert.ok(fact(result, 'target'));
  assert.equal(fact(result, 'deliverable').evidence, 'plugin');
  assert.equal(result.clarifications[0].id, 'visual-scope');
});

test('feasibility analysis is the current deliverable, not an invented implementation request', () => {
  const prompt = 'DSH界面美化插件，先给可行性分析。';
  const result = enhancePrompt(prompt);
  checkEvidence(prompt, result);
  assert.equal(fact(result, 'deliverable').evidence, '可行性分析');
  assert.deepEqual(result.clarifications, []);
});

test('deictic UI task asks for the referenced object, not the already stated objective', () => {
  const prompt = 'Can you help me make this UI less cluttered?';
  const result = enhancePrompt(prompt);
  checkEvidence(prompt, result);
  assert.ok(fact(result, 'target'));
  assert.equal(result.clarifications[0].id, 'reference');
});

test('current pain and intended outcome are separate and do not imply a new plugin', () => {
  const prompt = '现在dsh输入区占得太大，我想让聊天内容多显示一些。';
  const result = enhancePrompt(prompt);
  checkEvidence(prompt, result);
  assert.ok(fact(result, 'target'));
  assert.equal(fact(result, 'background').evidence, '现在dsh输入区占得太大');
  assert.equal(fact(result, 'deliverable'), undefined);
  assert.deepEqual(result.clarifications, []);
});

test('existing plugin mention does not become a request to build a plugin', () => {
  const prompt = 'We already have a DSH plugin; make its toolbar icons easier to distinguish.';
  const result = enhancePrompt(prompt);
  checkEvidence(prompt, result);
  assert.ok(fact(result, 'background'));
  assert.match(fact(result, 'target').evidence, /^make its toolbar/);
  assert.equal(fact(result, 'deliverable'), undefined);
});

test('atomic translation with target language needs no questionnaire', () => {
  const prompt = '把这段话翻译成英文：明早见。';
  const result = enhancePrompt(prompt);
  checkEvidence(prompt, result);
  assert.ok(fact(result, 'target'));
  assert.deepEqual(result.clarifications, []);
});

test('brainstorm request retains quantity and no-code boundary without requiring a chosen style', () => {
  const prompt = '给我三个美化 DSH 界面的方向，暂时不要代码。';
  const result = enhancePrompt(prompt);
  checkEvidence(prompt, result);
  assert.equal(fact(result, 'deliverable').evidence, '方向');
  assert.match(fact(result, 'constraints').evidence, /不要代码/);
  assert.deepEqual(result.clarifications, []);
});

test('opinion is not silently upgraded to a development commission', () => {
  const prompt = 'DSH界面有点丑。';
  const result = enhancePrompt(prompt);
  checkEvidence(prompt, result);
  assert.equal(fact(result, 'target'), undefined);
  assert.equal(fact(result, 'deliverable'), undefined);
  assert.equal(result.clarifications[0].id, 'intent');
  assert.match(result.clarifications[0].reason, /不等于.*没有表达/);
});

test('section labels alone are not substantive facts or high confidence', () => {
  const prompt = 'Goal, background, constraints, output format, success criteria.';
  const result = enhancePrompt(prompt);
  checkEvidence(prompt, result);
  assert.deepEqual(result.recognizedFacts, []);
  assert.equal(result.clarifications[0].id, 'intent');
});

test('scoped brevity/detail and bilingual labels are not false conflicts', () => {
  const prompt = '写一份说明：正文简洁，附录详细；用中文说明，英文界面标签保留。';
  const result = enhancePrompt(prompt);
  checkEvidence(prompt, result);
  assert.deepEqual(result.riskFlags, []);
  assert.deepEqual(result.clarifications, []);
});

test('dependency boundaries are explicit, but no framework is guessed', () => {
  const prompt = 'Build a DSH theme plugin. I haven’t chosen a framework; ask before changing dependencies.';
  const result = enhancePrompt(prompt);
  checkEvidence(prompt, result);
  assert.equal(fact(result, 'deliverable').evidence, 'plugin');
  assert.equal(fact(result, 'constraints').evidence, 'ask before changing dependencies');
  assert.deepEqual(result.clarifications, []);
});

test('concrete styling directions suppress repetitive styling questions', () => {
  for (const prompt of ['我想做一个美化dsh交互界面的插件，改成深色配色，侧栏更紧凑。', 'Build a DSH plugin with dark colours and compact spacing.']) {
    const result = enhancePrompt(prompt);
    checkEvidence(prompt, result);
    assert.deepEqual(result.clarifications, []);
  }
});

test('named response format is distinct from plugin deliverable', () => {
  const prompt = '我想做一个DSH插件，先用Markdown给可行性分析。';
  const result = enhancePrompt(prompt);
  checkEvidence(prompt, result);
  assert.equal(fact(result, 'outputFormat').evidence, 'Markdown');
  assert.ok(fact(result, 'deliverable'));
});

test('negative implementation and code samples do not fabricate a task/deliverable', () => {
  for (const prompt of ['不要开发插件，只讨论现状。', '先不要开发插件，只讨论现状。', 'Please do not build a plugin; explain the existing one.', '背景：我们以前开发过一个插件。现在只评估它是否值得维护。', '请分析“我想做一个插件”这句话。', '```js\n// Build a plugin in React\nconst goal = "write report";\n```']) {
    const result = enhancePrompt(prompt);
    checkEvidence(prompt, result);
    assert.equal(fact(result, 'deliverable'), undefined);
  }
});

test('format names in task objects are not automatically response formatting', () => {
  for (const prompt of ['修复 JSON 解析器在空输入上的崩溃。', 'Design a JSON parser.', 'Build an HTML validator.']) {
    const result = enhancePrompt(prompt);
    checkEvidence(prompt, result);
    assert.equal(fact(result, 'outputFormat'), undefined);
  }
});

test('unconstrained artifact repetitions do not fabricate a deliverable', () => {
  const prompt = '插件'.repeat(50000);
  const result = enhancePrompt(prompt, { maxPromptChars: 100000 });
  checkEvidence(prompt, result);
  assert.equal(fact(result, 'deliverable'), undefined);
});

test('enumerated beautify scope is quoted, not asked back as a question', () => {
  const prompt = '我想做一个美化用户与dsh的交互界面的插件，美化部分包括交互界面、产出等';
  const result = enhancePrompt(prompt);
  checkEvidence(prompt, result);
  assert.equal(fact(result, 'scope').evidence, '美化部分包括交互界面、产出等');
  assert.deepEqual(result.clarifications, []);
});

test('a vague action asks for its object rather than padding a complete checklist', () => {
  const result = enhancePrompt('做个东西');
  assert.ok(fact(result, 'target'));
  assert.equal(result.clarifications[0].id, 'object');
});

test('explanation objects and explicitly excluded deliverables are not new artifacts', () => {
  for (const prompt of ['给我解释这段代码：const x = 1;', '交付物：不要代码，只给分析。']) {
    assert.notEqual(fact(enhancePrompt(prompt), 'deliverable')?.evidence, '代码');
  }
});

test('using a parser is not response formatting', () => {
  for (const prompt of ['使用JSON解析器检查输入。', '请用 JSON 解析这段内容并解释错误。']) {
    assert.equal(fact(enhancePrompt(prompt), 'outputFormat'), undefined);
  }
});

test('translated-to variants and writing topics do not trigger irrelevant questions', () => {
  for (const prompt of ['请翻译为英语：明天见。', '请写一篇关于美化DSH界面的文章，面向新用户。']) {
    assert.deepEqual(enhancePrompt(prompt).clarifications, []);
  }
});

test('unclosed opening quotes stay bounded at the maximum supported length', () => {
  for (const char of ['“', '「']) {
    const result = enhancePrompt(char.repeat(100000), { maxPromptChars: 100000 });
    assert.equal(result.enhancedPrompt.length, 100000);
    assert.deepEqual(result.recognizedFacts, []);
  }
});

test('diagnostic question asks for evidence and is suppressed when it is present', () => {
  const result = enhancePrompt('帮我修复DSH插件报错');
  assert.equal(result.clarifications[0].id, 'diagnostic-evidence');
  assert.deepEqual(enhancePrompt('帮我修复DSH插件报错：TypeError，复现：点击按钮。').clarifications, []);
});
