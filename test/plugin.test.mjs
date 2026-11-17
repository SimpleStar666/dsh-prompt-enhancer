import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  apply,
  ENHANCE_PATH,
  CONFIG_PATH,
} from '../src/plugin.mjs';

function createHost() {
  const registrations = [];
  const ctx = {
    connection: {
      fetch: {
        register(route) {
          registrations.push(route);
          return () => {};
        },
      },
    },
  };
  return { ctx, registrations };
}

function request(path, method = 'GET', body) {
  return {
    url: `http://localhost${path}`,
    method,
    ...(arguments.length >= 3 ? { json: async () => body } : {}),
  };
}

async function responseBody(response) {
  assert.ok(response && typeof response.json === 'function', 'route should return a JSON response');
  return response.json();
}

test('apply registers enhance and config routes through connection.fetch.register', () => {
  const { ctx, registrations } = createHost();
  const state = apply(ctx, { locale: 'zh' });

  assert.equal(state.http, true);
  assert.deepEqual(
    registrations.map(({ path }) => path).sort(),
    [CONFIG_PATH, ENHANCE_PATH].sort(),
  );
  for (const route of registrations) {
    assert.deepEqual(route.methods, ['GET', 'POST']);
    assert.equal(route.requestBody, 'buffered');
    assert.equal(typeof route.fetch, 'function');
  }
});

test('POST enhance returns a structured result', async () => {
  const { ctx, registrations } = createHost();
  apply(ctx);
  const enhanceRoute = registrations.find(({ path }) => path === ENHANCE_PATH);

  const response = await enhanceRoute.fetch(request(ENHANCE_PATH, 'POST', {
    prompt: '帮我写一个报告',
  }));
  assert.equal(response.status, 200);

  const result = await responseBody(response);
  assert.equal(result.ok, true);
  assert.equal(typeof result.enhancedPrompt, 'string');
  assert.ok(Array.isArray(result.changeSet));
  assert.ok(Array.isArray(result.assumptions));
  assert.ok(Array.isArray(result.missingQuestions));
  assert.ok(Array.isArray(result.riskFlags));
  assert.equal(typeof result.confidence, 'number');
  assert.ok(result.confidence >= 0 && result.confidence <= 1);
  assert.match(result.enhancedPrompt, /帮我写一个报告/);
});

test('GET and POST config routes expose and update normalized configuration', async () => {
  const { ctx, registrations } = createHost();
  apply(ctx, { locale: 'zh' });
  const configRoute = registrations.find(({ path }) => path === CONFIG_PATH);

  const initial = await configRoute.fetch(request(CONFIG_PATH, 'GET'));
  assert.equal(initial.status, 200);
  const initialBody = await responseBody(initial);
  assert.equal(initialBody.ok, true);
  assert.equal(initialBody.config.locale, 'zh');

  const updated = await configRoute.fetch(request(CONFIG_PATH, 'POST', {
    config: { locale: 'en', maxPromptChars: 256 },
  }));
  assert.equal(updated.status, 200);
  const updatedBody = await responseBody(updated);
  assert.equal(updatedBody.ok, true);
  assert.equal(updatedBody.config.locale, 'en');
  assert.equal(updatedBody.config.maxPromptChars, 256);

  const afterUpdate = await configRoute.fetch(request(CONFIG_PATH, 'GET'));
  const afterUpdateBody = await responseBody(afterUpdate);
  assert.deepEqual(afterUpdateBody.config, updatedBody.config);
});

test('apply is safe when the optional connection is unavailable', () => {
  assert.doesNotThrow(() => apply({}));
  assert.equal(apply({}).http, false);
  assert.doesNotThrow(() => apply({ connection: null }));
});

test('invalid enhance input fails open with a structured fallback response', async () => {
  const { ctx, registrations } = createHost();
  apply(ctx);
  const enhanceRoute = registrations.find(({ path }) => path === ENHANCE_PATH);

  const response = await enhanceRoute.fetch({
    url: `http://localhost${ENHANCE_PATH}`,
    method: 'POST',
    body: '{not valid json',
  });
  assert.equal(response.status, 400);

  const fallback = await responseBody(response);
  assert.equal(fallback.ok, false);
  assert.equal(fallback.enhancedPrompt, '');
  assert.deepEqual(fallback.changeSet, []);
  assert.deepEqual(fallback.assumptions, []);
  assert.deepEqual(fallback.missingQuestions, []);
  assert.ok(fallback.riskFlags.includes('enhancement_failed'));
  assert.equal(typeof fallback.error, 'string');
});

test('real Request JSON string and object bodies are accepted without losing newlines', async () => {
  const { ctx, registrations } = createHost();
  apply(ctx);
  const route = registrations[0];
  const prompt = '  请写代码\n    保留缩进\n不要联网';
  for (const body of [prompt, { text: prompt }, { prompt }]) {
    const response = await route.fetch(new Request(`http://localhost${ENHANCE_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    assert.equal(response.status, 200);
    assert.ok((await response.json()).enhancedPrompt.startsWith(prompt));
  }
});

test('invalid primitive, array, missing prompt and malformed JSON requests return 400', async () => {
  const { ctx, registrations } = createHost();
  apply(ctx);
  const route = registrations[0];
  for (const raw of ['null', '123', 'true', '[]', '{}', '{"text":42}', '{"text":"x","config":[]}', '{bad']) {
    const response = await route.fetch(new Request(`http://localhost${ENHANCE_PATH}`, { method: 'POST', body: raw }));
    assert.equal(response.status, 400, raw);
    assert.equal((await response.json()).ok, false);
  }
  for (const body of [null, [], 'config', 1, { config: null }]) {
    assert.equal((await route.fetch(request(CONFIG_PATH, 'POST', body))).status, 400);
  }
});

test('disabled host preserves original; request override cannot enable it; config route can', async () => {
  const { ctx, registrations } = createHost();
  apply(ctx, { enabled: false });
  const route = registrations[0];
  const prompt = '想法\n必须保留';
  const disabled = await responseBody(await route.fetch(request(ENHANCE_PATH, 'POST', {
    text: prompt, config: { enabled: true },
  })));
  assert.equal(disabled.config.enabled, false);
  assert.equal(disabled.enhancedPrompt, prompt);
  for (const key of ['changeSet', 'missingQuestions', 'assumptions', 'riskFlags']) assert.deepEqual(disabled[key], []);
  await route.fetch(request(CONFIG_PATH, 'POST', { enabled: true }));
  const enabled = await responseBody(await route.fetch(request(ENHANCE_PATH, 'POST', { text: prompt })));
  assert.equal(enabled.config.enabled, true);
  assert.equal(enabled.enhancedPrompt, prompt);
  assert.ok(enabled.reviewNotes.length > 0);
  assert.ok(enabled.clarifications.length > 0);
});

test('host forwards profiles and per-request toggles without persisting overrides', async () => {
  const { ctx, registrations } = createHost();
  apply(ctx, { locale: 'zh' });
  const route = registrations[0];
  const coded = await responseBody(await route.fetch(request(ENHANCE_PATH, 'POST', { text: '我想做一个美化dsh交互界面的插件', profile: 'coding' })));
  assert.equal(coded.enhancedPrompt, '我想做一个美化dsh交互界面的插件');
  assert.equal(coded.recognizedFacts.find((fact) => fact.key === 'deliverable').evidence, '插件');
  assert.equal(coded.clarifications[0].id, 'visual-scope');
  assert.doesNotMatch(coded.missingQuestions.join(' '), /技术栈|React|Tailwind/);
  const plain = await responseBody(await route.fetch(request(ENHANCE_PATH, 'POST', {
    text: '做个东西', config: { addSectionLabels: false, includeQuestions: false },
  })));
  assert.equal(plain.enhancedPrompt, '做个东西');
  assert.deepEqual(plain.missingQuestions, []);
  assert.equal((await responseBody(await route.fetch(request(CONFIG_PATH)))).config.addSectionLabels, true);
});

test('method and path errors, no-store headers, and effect disposal are correct', async () => {
  const registrations = [];
  let disposed = 0;
  let cleanup;
  const ctx = {
    connection: { fetch: { register(route) { registrations.push(route); return () => { disposed++; }; } } },
    effect(register) { cleanup = register(); },
  };
  apply(ctx);
  const route = registrations[0];
  assert.equal((await route.fetch(request(ENHANCE_PATH))).status, 405);
  assert.equal((await route.fetch(request(CONFIG_PATH, 'DELETE'))).status, 405);
  assert.equal((await route.fetch(request('/unknown'))).status, 404);
  const result = await route.fetch(request(ENHANCE_PATH, 'POST', 'idea'));
  assert.equal(result.headers.get('cache-control'), 'no-store');
  cleanup();
  assert.equal(disposed, 2);
});
