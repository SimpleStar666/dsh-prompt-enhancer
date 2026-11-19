import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  apply,
  ENHANCE_PATH,
  ROUTE_PATH,
  CONFIG_PATH,
} from '../src/plugin.mjs';

/** dsh-llm-shaped mock: stream() with text-delta/finish chunks. */
function mockLlm({ text = '增强后的提示词', fail } = {}) {
  const calls = [];
  const llm = {
    calls,
    stream(options) {
      calls.push(options);
      return (async function* () {
        if (fail) {
          yield { type: 'finish', reason: { kind: 'error', failure: { message: fail } } };
          return;
        }
        if (typeof text === 'string') yield { type: 'text-delta', text };
        for (const part of Array.isArray(text) ? text : []) yield typeof part === 'string' ? { type: 'text-delta', text: part } : part;
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
  return llm;
}

function createHost({ llm, agentDefaultModel, enabled } = {}) {
  const registrations = [];
  const listeners = {};
  const ctx = {
    connection: {
      fetch: {
        register(route) {
          registrations.push(route);
          return () => {};
        },
      },
    },
    ...(llm ? { llm } : {}),
    ...(agentDefaultModel ? { agentDefaultModel } : {}),
    on(event, handler) { listeners[event] = handler; },
  };
  const state = apply(ctx, { enabled: enabled ?? true, locale: 'zh' });
  return { ctx, registrations, listeners, state };
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

const routeOf = (registrations, path) => registrations.find(({ path: p }) => p === path);

test('apply registers enhance, route and config routes through connection.fetch.register', () => {
  const { ctx, registrations } = createHost({ llm: mockLlm() });
  assert.deepEqual(
    registrations.map(({ path }) => path).sort(),
    [CONFIG_PATH, ENHANCE_PATH, ROUTE_PATH].sort(),
  );
  for (const item of registrations) {
    assert.deepEqual(item.methods, ['GET', 'POST']);
    assert.equal(item.requestBody, 'buffered');
    assert.equal(typeof item.fetch, 'function');
  }
  assert.ok(ctx);
});

test('POST enhance rewrites through llm.stream with a valid dsh-llm request', async () => {
  const llm = mockLlm({ text: '写一份给团队看的项目周报，覆盖本周进展、风险与下周计划。' });
  const { registrations } = createHost({
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-chat' }) },
  });
  const route = routeOf(registrations, ENHANCE_PATH);
  const response = await route.fetch(request(ENHANCE_PATH, 'POST', { text: '写个周报' }));
  assert.equal(response.status, 200);
  const result = await responseBody(response);
  assert.equal(result.ok, true);
  assert.equal(result.enhancedPrompt, '写一份给团队看的项目周报，覆盖本周进展、风险与下周计划。');
  assert.equal(result.originalPrompt, '写个周报');
  assert.deepEqual(result.route, { provider: 'deepseek-official', model: 'deepseek-chat' });
  assert.ok(Array.isArray(result.metrics?.warnings), 'rewrite metrics are exposed for observability');
  assert.ok(Array.isArray(result.reviewNotes) && result.reviewNotes.length > 0);
  assert.equal(llm.calls.length, 1);
  const call = llm.calls[0];
  assert.equal(call.provider, 'deepseek-official');
  assert.equal(call.model, 'deepseek-chat');
  assert.equal(call.purpose, 'prompt-enhancer');
  assert.equal(typeof call.system, 'string');
  assert.doesNotMatch(call.system, /写个周报/, 'the draft travels once, as the user message');
  assert.equal(call.messages.length, 1);
  assert.equal(call.messages[0].role, 'user');
  assert.deepEqual(call.messages[0].content, [{ type: 'text', text: '写个周报' }]);
});

test('without an llm service enhance fails honestly with 503 instead of pretending', async () => {
  const { registrations } = createHost();
  const route = routeOf(registrations, ENHANCE_PATH);
  const response = await route.fetch(request(ENHANCE_PATH, 'POST', { text: '写个周报' }));
  assert.equal(response.status, 503);
  const result = await responseBody(response);
  assert.equal(result.ok, false);
  assert.equal(result.enhancedPrompt, '写个周报');
  assert.match(result.error, /模型服务/);
});

test('without any model route enhance fails with 409 and keeps the original', async () => {
  const { registrations } = createHost({ llm: mockLlm() });
  const route = routeOf(registrations, ENHANCE_PATH);
  const response = await route.fetch(request(ENHANCE_PATH, 'POST', { text: '写个周报' }));
  assert.equal(response.status, 409);
  const result = await responseBody(response);
  assert.equal(result.ok, false);
  assert.equal(result.enhancedPrompt, '写个周报');
});

test('a fatal provider limit is reported with retryable=false instead of a misleading retry hint', async () => {
  const quotaError = Object.assign(new Error(
    '429: {"code":"USAGE_LIMIT_EXCEEDED","message":"error: code=429 reason=\"MONTHLY_LIMIT_EXCEEDED\" message=\"monthly usage limit exceeded\" metadata=map[]"}',
  ), { status: 429 });
  const calls = [];
  const throwingLlm = {
    stream(options) {
      calls.push(options);
      return (async function* () { throw quotaError; })();
    },
  };
  const { registrations } = createHost({
    llm: throwingLlm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'loomy', model: 'deepseek-v4-flash-1017' }) },
  });
  const route = routeOf(registrations, ENHANCE_PATH);
  const response = await route.fetch(request(ENHANCE_PATH, 'POST', { text: '写个周报' }));
  assert.equal(response.status, 200);
  const result = await responseBody(response);
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false, 'a monthly-limit 429 must not tell the user to retry');
  assert.equal(result.errorCode, 'quota');
  assert.match(result.error, /额度已用尽/);
  assert.equal(calls.length, 1, 'a fatal provider failure is not retried');
});

test('route precedence: config, request hint, remembered agent route, then shared default', async () => {
  const llm = mockLlm();
  const { registrations, listeners } = createHost({
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'default-prov', model: 'default-model' }) },
  });
  const enhance = routeOf(registrations, ENHANCE_PATH);

  // Remembered agent route from agent/created beats the shared default.
  listeners['agent/created']({ agent: { options: { provider: 'agent-prov', model: 'agent-model' } } });
  let result = await responseBody(await enhance.fetch(request(ENHANCE_PATH, 'POST', { text: 'x' })));
  assert.deepEqual(result.route, { provider: 'agent-prov', model: 'agent-model' });

  // Explicit request hint overrides the remembered route.
  result = await responseBody(await enhance.fetch(request(ENHANCE_PATH, 'POST', { text: 'x', route: { provider: 'hint-prov', model: 'hint-model' } })));
  assert.deepEqual(result.route, { provider: 'hint-prov', model: 'hint-model' });

  // Persisted plugin config overrides everything.
  await routeOf(registrations, CONFIG_PATH).fetch(request(CONFIG_PATH, 'POST', { config: { provider: 'cfg-prov', model: 'cfg-model' } }));
  result = await responseBody(await enhance.fetch(request(ENHANCE_PATH, 'POST', { text: 'x' })));
  assert.deepEqual(result.route, { provider: 'cfg-prov', model: 'cfg-model' });

  // No agent event and no default selection: shared default alone still works.
  const { registrations: freshRegistrations } = createHost({ llm: mockLlm() });
  const empty = routeOf(freshRegistrations, ENHANCE_PATH);
  assert.equal((await empty.fetch(request(ENHANCE_PATH, 'POST', { text: 'x' }))).status, 409);
});

test('disabled host preserves original and never calls the model; request override cannot enable it', async () => {
  const llm = mockLlm();
  const { registrations } = createHost({
    llm,
    enabled: false,
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  });
  const enhance = routeOf(registrations, ENHANCE_PATH);
  const prompt = '想法\n必须保留';
  const result = await responseBody(await enhance.fetch(request(ENHANCE_PATH, 'POST', { text: prompt, config: { enabled: true } })));
  assert.equal(result.config.enabled, false);
  assert.equal(result.enhancedPrompt, prompt);
  assert.equal(llm.calls.length, 0);
});

test('oversized input is refused with 413 before any model call', async () => {
  const llm = mockLlm();
  const { registrations } = createHost({ llm });
  const route = routeOf(registrations, ENHANCE_PATH);
  const response = await route.fetch(request(ENHANCE_PATH, 'POST', { text: 'x'.repeat(13000) }));
  assert.equal(response.status, 413);
  assert.equal((await responseBody(response)).ok, false);
  assert.equal(llm.calls.length, 0);
});

test('GET and POST config routes expose and update normalized configuration', async () => {
  const { registrations } = createHost({ llm: mockLlm() });
  const configRoute = routeOf(registrations, CONFIG_PATH);

  const initial = await responseBody(await configRoute.fetch(request(CONFIG_PATH)));
  assert.equal(initial.ok, true);
  assert.equal(initial.config.locale, 'zh');
  assert.equal(initial.config.provider, '');
  assert.equal(initial.config.model, '');
  assert.equal(initial.config.maxTokens, 768);
  assert.equal(initial.config.reasoningEffort, 'auto');

  const updated = await responseBody(await configRoute.fetch(request(CONFIG_PATH, 'POST', {
    config: { locale: 'en', maxPromptChars: 256, maxTokens: 1, timeoutMs: 1, reasoningEffort: 'fast' },
  })));
  assert.equal(updated.ok, true);
  assert.equal(updated.config.locale, 'en');
  assert.equal(updated.config.maxPromptChars, 256);
  assert.equal(updated.config.maxTokens, 256, 'maxTokens clamps to its floor');
  assert.equal(updated.config.timeoutMs, 1000, 'timeoutMs clamps to its floor');
  assert.equal(updated.config.reasoningEffort, 'auto', 'unknown effort ids fall back to auto');

  const after = await responseBody(await configRoute.fetch(request(CONFIG_PATH)));
  assert.deepEqual(after.config, updated.config);
});

test('route hint endpoint updates the remembered route', async () => {
  const llm = mockLlm();
  const { registrations } = createHost({ llm });
  const route = routeOf(registrations, ROUTE_PATH);
  const result = await responseBody(await route.fetch(request(ROUTE_PATH, 'POST', { route: { provider: 'p', model: 'm' } })));
  assert.equal(result.ok, true);
  assert.deepEqual(result.route, { provider: 'p', model: 'm' });
  const enhance = routeOf(registrations, ENHANCE_PATH);
  const enhanced = await responseBody(await enhance.fetch(request(ENHANCE_PATH, 'POST', { text: 'x' })));
  assert.deepEqual(enhanced.route, { provider: 'p', model: 'm' });
});

test('apply is safe when the optional connection is unavailable', () => {
  assert.doesNotThrow(() => apply({}));
  assert.equal(apply({}).http, false);
  assert.doesNotThrow(() => apply({ connection: null }));
  assert.doesNotThrow(() => apply({ llm: mockLlm() }));
});

test('invalid enhance input fails open with a structured fallback response', async () => {
  const { registrations } = createHost({ llm: mockLlm() });
  const enhanceRoute = routeOf(registrations, ENHANCE_PATH);
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

test('real Request JSON string and object bodies reach the model without losing newlines', async () => {
  const llm = mockLlm();
  const { registrations } = createHost({
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  });
  const route = routeOf(registrations, ENHANCE_PATH);
  const prompt = '  请写代码\n    保留缩进\n不要联网';
  for (const body of [prompt, { text: prompt }, { prompt }]) {
    const response = await route.fetch(new Request(`http://localhost${ENHANCE_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    }));
    assert.equal(response.status, 200);
  }
  assert.equal(llm.calls.length, 3);
  assert.equal(llm.calls[0].messages[0].content[0].text, prompt);
});

test('invalid primitive, array, missing prompt and malformed JSON requests return 400', async () => {
  const { registrations } = createHost({ llm: mockLlm() });
  const route = routeOf(registrations, ENHANCE_PATH);
  for (const raw of ['null', '123', 'true', '[]', '{}', '{"text":42}', '{"text":"x","config":[]}', '{bad']) {
    const response = await route.fetch(new Request(`http://localhost${ENHANCE_PATH}`, { method: 'POST', body: raw }));
    assert.equal(response.status, 400, raw);
    assert.equal((await response.json()).ok, false);
  }
  for (const body of [null, [], 'config', 1, { config: null }]) {
    assert.equal((await route.fetch(request(CONFIG_PATH, 'POST', body))).status, 400);
  }
});

test('model failures return the original prompt with the failure explained', async () => {
  const llm = mockLlm({ fail: '配额不足' });
  const { registrations } = createHost({
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  });
  const route = routeOf(registrations, ENHANCE_PATH);
  const response = await route.fetch(request(ENHANCE_PATH, 'POST', { text: '写个周报' }));
  assert.equal(response.status, 200, 'fail-open keeps a usable original');
  const result = await responseBody(response);
  assert.equal(result.ok, false);
  assert.equal(result.enhancedPrompt, '写个周报');
  assert.match(result.error, /额度已用尽/);
  assert.equal(result.errorCode, 'quota');
  assert.equal(result.retryable, false);
});

test('apply never subscribes to waterfall events that require next()', () => {
  const events = [];
  const ctx = {
    connection: { fetch: { register() { return () => {}; } } },
    on(name) { events.push(name); },
  };
  apply(ctx, { locale: 'zh' });
  assert.ok(events.includes('agent/created'), 'route learning uses the notification event');
  assert.ok(!events.includes('agent/pre-step'), 'pre-step is a waterfall: a listener without next() blocks every agent run');
  assert.ok(!events.includes('llm/stream'), 'llm/stream is a waterfall and must not be subscribed');
});

test('hosts without a direct llm property use ctx.inject to acquire the service', async () => {
  const registrations = [];
  const nested = [];
  const ctx = {
    connection: { fetch: { register(route) { registrations.push(route); return () => {}; } } },
    inject(deps, callback) {
      nested.push(deps);
      callback({ llm: mockLlm() });
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  };
  const state = apply(ctx, { locale: 'zh' });
  assert.deepEqual(nested, [['llm']]);
  assert.ok(state.llm, 'the nested inject scope must fill the llm service');
  const enhance = routeOf(registrations, ENHANCE_PATH);
  const response = await enhance.fetch(request(ENHANCE_PATH, 'POST', { text: '写个周报' }));
  assert.equal(response.status, 200);
  assert.equal((await responseBody(response)).ok, true);
});

test('method and path errors, no-store headers, and effect disposal are correct', async () => {
  const registrations = [];
  let disposed = 0;
  let cleanup;
  const ctx = {
    connection: { fetch: { register(route) { registrations.push(route); return () => { disposed++; }; } } },
    effect(register) { cleanup = register(); },
  };
  apply(ctx, { locale: 'zh' });
  const enhanceRoute = routeOf(registrations, ENHANCE_PATH);
  assert.equal((await enhanceRoute.fetch(request(ENHANCE_PATH))).status, 405);
  assert.equal((await routeOf(registrations, CONFIG_PATH).fetch(request(CONFIG_PATH, 'DELETE'))).status, 405);
  assert.equal((await routeOf(registrations, ROUTE_PATH).fetch(request(ROUTE_PATH))).status, 405);
  assert.equal((await enhanceRoute.fetch(request('/unknown'))).status, 404);
  const result = await enhanceRoute.fetch(request(ENHANCE_PATH, 'POST', 'idea'));
  assert.equal(result.headers.get('cache-control'), 'no-store');
  cleanup();
  assert.equal(disposed, 3);
});
