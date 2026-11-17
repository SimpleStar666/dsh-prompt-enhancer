/**
 * Host adapter for the prompt-enhancer plugin.
 *
 * The enhancement algorithm is local and synchronous.  HTTP registration and
 * optional host services are probed defensively so this plugin never prevents a
 * headless DSH profile from starting when `connection` is unavailable.
 */

import { Config, DEFAULTS, normalizeConfig } from './schema.mjs';
import { enhancePrompt, detectGaps, normalizeText, containsSensitiveData } from './enhancer.mjs';

export { Config, DEFAULTS, normalizeConfig, enhancePrompt, detectGaps, normalizeText, containsSensitiveData };

export const name = 'dsh-prompt-enhancer';
/** `connection` is optional in practice; apply() also works in headless hosts. */
export const inject = ['connection'];

export const ENHANCE_PATH = '/api/prompt-enhancer/enhance';
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
    error: `提示词增强失败：${error?.message ?? String(error)}`,
  };
}

function getConnection(ctx) {
  try {
    if (ctx?.connection?.fetch && typeof ctx.connection.fetch.register === 'function') return ctx.connection;
  } catch { /* optional service */ }
  try {
    const value = typeof ctx?.get === 'function' ? ctx.get('connection') : null;
    if (value?.fetch && typeof value.fetch.register === 'function') return value;
  } catch { /* optional service */ }
  return null;
}

/**
 * Register the host routes and return a small diagnostics object.
 * All errors are swallowed by design: prompt enhancement is advisory.
 *
 * @param {any} ctx
 * @param {unknown} rawConfig
 * @returns {{config: object, http: boolean}}
 */
export function apply(ctx, rawConfig) {
  let config = normalizeConfig(rawConfig);
  const state = { config, http: false };

  // Build a request handler once so config changes are visible to enhancement.
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
        // Accept either `{...config}` or `{config:{...}}` to keep clients simple.
        const candidate = Object.hasOwn(body, 'config') ? body.config : body;
        config = normalizeConfig({ ...config, ...candidate });
        state.config = config;
        return jsonResponse({ ok: true, config });
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
        try {
          const result = enhancePrompt(prompt, { ...effectiveConfig, profile: body?.profile });
          return jsonResponse({ ok: true, ...result, config: effectiveConfig });
        } catch (error) {
          // Do not turn an enhancement bug into a blocked user request.
          return jsonResponse({ ...fallbackResult(prompt, error), config: effectiveConfig });
        }
      }
      return jsonResponse({ ok: false, error: '未找到。' }, 404);
    } catch (error) {
      // Host adapters are deliberately fail-open.  Keep the original prompt if possible.
      return jsonResponse(fallbackResult('', error));
    }
  };

  const connection = getConnection(ctx);
  if (connection) {
    try {
      const register = () => {
        const disposers = [];
        for (const path of [ENHANCE_PATH, CONFIG_PATH]) {
          try {
            const dispose = connection.fetch.register({
              path,
              methods: ['GET', 'POST'],
              requestBody: 'buffered',
              fetch: handle,
            });
            if (typeof dispose === 'function') disposers.push(dispose);
          } catch {
            // One route failing should not stop the other route or host boot.
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
