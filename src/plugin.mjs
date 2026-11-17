/**
 * Host adapter for the prompt-enhancer plugin.
 *
 * Three request paths share one llm service acquired defensively:
 *   - POST /api/prompt-enhancer/enhance   model rewrite of a draft
 *   - POST /api/prompt-enhancer/route     optional route override hint (current session)
 *   - GET/POST /api/prompt-enhancer/config runtime configuration
 *
 * The llm service is probed lazily so a headless DSH profile without a model
 * route still boots; requests then fail with an honest status instead.
 */

import { Config, DEFAULTS, REASONING_EFFORTS, normalizeConfig } from './schema.mjs';
import { enhancePrompt, detectGaps, normalizeText, containsSensitiveData } from './enhancer.mjs';
import { rewriteWithLlm, resolveReasoningEffort, REWRITE_DEFAULTS } from './rewrite.mjs';

export { Config, DEFAULTS, REASONING_EFFORTS, normalizeConfig, enhancePrompt, detectGaps, normalizeText, containsSensitiveData, rewriteWithLlm, resolveReasoningEffort, REWRITE_DEFAULTS };

export const name = 'dsh-prompt-enhancer';
/** `connection` is optional in practice; apply() also works in headless hosts. */
export const inject = ['connection'];

export const ENHANCE_PATH = '/api/prompt-enhancer/enhance';
export const ROUTE_PATH = '/api/prompt-enhancer/route';
export const CONFIG_PATH = '/api/prompt-enhancer/config';

const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
});

function jsonResponse(value, status = 200) {
  const payload = JSON.stringify(value);
  if (typeof Response === 'function') return new Response(payload, { status, headers: JSON_HEADERS });
  return {
    status,
    headers: JSON_HEADERS,
    json: async () => JSON.parse(payload),
    text: async () => payload,
  };
}

function pathnameOf(request) {
  try { return new URL(request?.url ?? '', 'http://localhost').pathname; } catch { return ''; }
}

function methodOf(request) {
  return String(request?.method ?? 'GET').toUpperCase();
}

const INVALID_BODY = Symbol('invalid-json-body');
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

async function readBody(request) {
  if (!request) return INVALID_BODY;
  try {
    if (typeof request.json === 'function') return await request.json();
    const body = request.body;
    if (typeof body === 'string') return JSON.parse(body);
    if (body instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(body));
    if (isRecord(body) && !ArrayBuffer.isView(body)) return body;
  } catch {
    return INVALID_BODY;
  }
  return INVALID_BODY;
}

function fallbackResult(prompt, error) {
  return {
    ok: false,
    enhancedPrompt: typeof prompt === 'string' ? prompt : '',
    changeSet: [],
    assumptions: [],
    missingQuestions: [],
    riskFlags: ['enhancement_failed'],
    confidence: 0,
    recognizedFacts: [],
    clarifications: [],
    reviewNotes: [],
    error: `提示词增强失败：${error?.message ?? String(error)}`,
  };
}

function getService(ctx, key) {
  try {
    if (ctx?.[key] && typeof ctx[key] === 'object') return ctx[key];
  } catch { /* optional service */ }
  try {
    return typeof ctx?.get === 'function' ? ctx.get(key) : null;
  } catch { /* optional service */ }
  return null;
}

function getConnection(ctx) {
  const value = getService(ctx, 'connection');
  if (value?.fetch && typeof value.fetch.register === 'function') return value;
  return null;
}

function getLlm(ctx) {
  const value = getService(ctx, 'llm');
  if (value && typeof value.stream === 'function') return value;
  return null;
}

/**
 * Resolve the model route: explicit config, request hint, remembered session
 * route, then the shared default selection. `null` means "unknown" and the
 * endpoint answers with an honest 409.
 */
function resolveRoute({ config, hint, lastRoute, ctx }) {
  if (config.provider && config.model) return { provider: config.provider, model: config.model };
  if (hint?.provider && hint?.model) return { provider: String(hint.provider), model: String(hint.model) };
  if (lastRoute) return lastRoute;
  const defaults = getService(ctx, 'agentDefaultModel');
  try {
    const selection = defaults?.currentSelection?.();
    if (selection?.provider && selection?.model) return { provider: selection.provider, model: selection.model };
  } catch { /* shared default is optional */ }
  return null;
}

function routeFromAgent(agent) {
  try {
    // The session's request/epoch header carries the current route config.
    const config =
      agent?.session?.requestHeader?.()?.config ??
      agent?.requestHeader?.()?.config ??
      agent?.options;
    if (config?.provider && config?.model) return { provider: config.provider, model: config.model };
  } catch { /* host shape varies */ }
  return null;
}

/**
 * Register the host routes and return a small diagnostics object.
 *
 * @param {any} ctx
 * @param {unknown} rawConfig
 * @returns {{config: object, http: boolean}}
 */
export function apply(ctx, rawConfig) {
  let config = normalizeConfig(rawConfig);
  const state = { config, http: false, llm: null };
  let llm = getLlm(ctx);
  if (llm) state.llm = llm;
  else if (typeof ctx?.inject === 'function') {
    // Cordis gates service access on declared inject paths: `ctx.llm` may throw
    // when the service is not statically injected. A nested inject scope starts
    // only when the llm service exists, so headless hosts still boot and the
    // state is filled as soon as the service is ready.
    try {
      ctx.inject(['llm'], (scoped) => {
        if (scoped?.llm && typeof scoped.llm.stream === 'function') state.llm = scoped.llm;
      });
    } catch { /* optional service discovery */ }
  }

  // Remember the last seen agent route so the composer button works on a fresh
  // session before any message has been sent.
  let lastRoute = null;
  try {
    if (typeof ctx?.on === 'function') {
      // `agent/created` is a plain notification event: reading the route here
      // lets the composer button work before the first message is sent.
      // Deliberately NOT subscribing to waterfall events (`agent/pre-step`,
      // `llm/stream`): a listener that ignores `next()` blocks the entire agent
      // loop and breaks every run until the plugin is disabled.
      ctx.on('agent/created', (payload) => {
        const agent = payload?.agent ?? payload;
        const route = routeFromAgent(agent);
        if (route) lastRoute = route;
      });
    }
  } catch { /* events are optional */ }

  // Build a request handler once so config changes are visible to the routes.
  const handle = async (request) => {
    const path = pathnameOf(request);
    const method = methodOf(request);
    try {
      if (path === CONFIG_PATH) {
        if (method === 'GET') return jsonResponse({ ok: true, config });
        if (method !== 'POST') return jsonResponse({ ok: false, error: '方法不允许。' }, 405);
        const body = await readBody(request);
        if (!isRecord(body) || (Object.hasOwn(body, 'config') && !isRecord(body.config))) {
          return jsonResponse({ ok: false, error: '配置请求必须是 JSON 对象。', config }, 400);
        }
        const candidate = Object.hasOwn(body, 'config') ? body.config : body;
        config = normalizeConfig({ ...config, ...candidate });
        state.config = config;
        return jsonResponse({ ok: true, config });
      }

      if (path === ROUTE_PATH) {
        if (method !== 'POST') return jsonResponse({ ok: false, error: '方法不允许。' }, 405);
        const body = await readBody(request);
        if (!isRecord(body) || (Object.hasOwn(body, 'route') && !isRecord(body.route))) {
          return jsonResponse({ ok: false, error: '路由请求必须是 JSON 对象。' }, 400);
        }
        const route = body.route;
        const next = { provider: route.provider, model: route.model };
        if (typeof next.provider === 'string' && typeof next.model === 'string' && next.provider.trim() && next.model.trim()) {
          lastRoute = { provider: next.provider.trim(), model: next.model.trim() };
        }
        return jsonResponse({ ok: true, route: lastRoute });
      }

      if (path === ENHANCE_PATH) {
        if (method !== 'POST') return jsonResponse({ ok: false, error: '方法不允许。' }, 405);
        const body = await readBody(request);
        const prompt = typeof body === 'string' ? body : body?.prompt ?? body?.text;
        if (typeof prompt !== 'string' || (typeof body !== 'string' && !isRecord(body)) ||
            (isRecord(body) && Object.hasOwn(body, 'config') && !isRecord(body.config))) {
          return jsonResponse({ ...fallbackResult('', new Error('请求必须是 JSON 字符串，或包含 prompt/text 字符串的对象。')), config }, 400);
        }
        const effectiveConfig = normalizeConfig({ ...config, ...(isRecord(body?.config) ? body.config : {}) });
        // A request cannot silently re-enable a disabled host plugin.
        effectiveConfig.enabled = config.enabled && effectiveConfig.enabled;
        if (!effectiveConfig.enabled) return jsonResponse({ ok: true, ...enhancePrompt(prompt, effectiveConfig), config: effectiveConfig });
        if (!state.llm || typeof state.llm.stream !== 'function') {
          return jsonResponse({ ...fallbackResult(prompt, new Error('本宿主没有可用的模型服务，无法改写。')), config: effectiveConfig }, 503);
        }
        if (prompt.length > effectiveConfig.maxPromptChars) {
          return jsonResponse({ ...fallbackResult(prompt, new Error(`输入超过 ${effectiveConfig.maxPromptChars} 字符，未发送给模型。`)), config: effectiveConfig }, 413);
        }
        const route = resolveRoute({ config: effectiveConfig, hint: body?.route, lastRoute, ctx });
        if (!route) {
          return jsonResponse({ ...fallbackResult(prompt, new Error('没有可用的模型路由；请发送一条消息后再试，或在插件配置里指定 provider/model。')), config: effectiveConfig }, 409);
        }
        try {
          const metrics = {};
          const enhanced = await rewriteWithLlm(state.llm, route, prompt, {
            locale: effectiveConfig.locale,
            maxTokens: effectiveConfig.maxTokens,
            timeoutMs: effectiveConfig.timeoutMs,
            reasoningEffort: effectiveConfig.reasoningEffort,
            metrics,
            signal: request?.signal,
          });
          if (route === lastRoute || (!config.provider && !config.model)) lastRoute = route;
          const local = enhancePrompt(prompt, effectiveConfig);
          return jsonResponse({
            ok: true,
            enhancedPrompt: enhanced,
            originalPrompt: prompt,
            route,
            metrics: {
              totalMs: metrics.totalMs ?? null,
              ...(metrics.reasoningMs === undefined ? {} : { reasoningMs: metrics.reasoningMs }),
              ...(metrics.textMs === undefined ? {} : { textMs: metrics.textMs }),
              reasoningEffort: metrics.reasoningEffort ?? null,
              maxTokens: metrics.maxTokens ?? effectiveConfig.maxTokens,
              warnings: metrics.warnings ?? [],
            },
            changeSet: [],
            assumptions: [],
            missingQuestions: [],
            ...(effectiveConfig.includeRisks ? { riskFlags: local.riskFlags } : { riskFlags: [] }),
            confidence: 0,
            recognizedFacts: local.recognizedFacts,
            clarifications: [],
            reviewNotes: [effectiveConfig.locale === 'zh'
              ? '由模型重写生成，仅保留你的原意与事实，不保证没有补充细节；发送前请审阅并修改。'
              : 'Rewritten by a model. Original intent and facts are preserved, but added details are not guaranteed; review and edit before sending.'],
            config: effectiveConfig,
          });
        } catch (error) {
          return jsonResponse({ ...fallbackResult(prompt, error), config: effectiveConfig });
        }
      }
      return jsonResponse({ ok: false, error: '未找到。' }, 404);
    } catch (error) {
      return jsonResponse(fallbackResult('', error));
    }
  };

  const connection = getConnection(ctx);
  if (connection) {
    try {
      const register = () => {
        const disposers = [];
        for (const path of [ENHANCE_PATH, ROUTE_PATH, CONFIG_PATH]) {
          try {
            const dispose = connection.fetch.register({
              path,
              methods: ['GET', 'POST'],
              requestBody: 'buffered',
              fetch: handle,
            });
            if (typeof dispose === 'function') disposers.push(dispose);
          } catch {
            // One route failing should not stop the other routes or host boot.
          }
        }
        state.http = disposers.length > 0;
        return () => { for (const dispose of disposers) { try { dispose(); } catch { /* noop */ } } };
      };
      if (typeof ctx?.effect === 'function') ctx.effect(register, `${name}:http`);
      else register();
    } catch {
      // Optional connection service and fetch router are both host-version dependent.
    }
  }

  return state;
}
