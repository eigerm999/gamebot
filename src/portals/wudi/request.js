import { failed, redact } from '../../core/errors.js';
import { parseJson } from '../../core/portal-http.js';

const API_BASE = '/prod-api';
const SUCCESS = 200;
const UNAUTHORIZED = 401;

/** Error before/around an application request (the caller decides failed vs unknown). */
export class WudiRequestError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Make one request through Wudi's own loaded Axios instance. This preserves its
 * bearer-token, AES body and RSA key handling without reproducing that code.
 *
 * The Axios instance is discovered by behavior (baseURL=/prod-api), not by its
 * current webpack module ID. Playwright observes the raw network response in
 * parallel, before Wudi's response interceptor can turn an application error
 * into a generic rejected promise.
 *
 * Returns the same response shape as session.pageFetch.
 */
export async function wudiRequest(target, { path, method = 'GET', params = null, data = null, encrypt = false, timeoutMs }) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw new WudiRequestError('request_path', 'Invalid Wudi API path');
  }
  const page = target.page ?? target;
  const requestMethod = method.toUpperCase();
  const expectedPath = API_BASE + path;

  const observed = page
    .waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return url.origin === new URL(page.url()).origin && url.pathname === expectedPath && response.request().method() === requestMethod;
      },
      { timeout: timeoutMs }
    )
    .then((response) => ({ response }))
    .catch((error) => ({ error }));

  let invocation;
  try {
    invocation = await page.evaluate(
      async ({ path, method, params, data, encrypt, timeoutMs }) => {
        let webpackRequire;
        try {
          const probe = `game_bot_${Date.now()}_${Math.random().toString(36).slice(2)}`;
          window.webpackJsonp.push([[probe], { [probe]: (module, exports, require) => { webpackRequire = require; } }, [[probe]]]);
        } catch (error) {
          return { started: false, reason: `webpack:${String(error?.message ?? error)}` };
        }

        let client = null;
        for (const module of Object.values(webpackRequire?.c ?? {})) {
          const exports = module?.exports;
          const candidates = [exports, exports?.a, exports?.default];
          client = candidates.find(
            (candidate) =>
              typeof candidate === 'function' &&
              candidate.defaults?.baseURL === '/prod-api' &&
              candidate.interceptors?.request &&
              candidate.interceptors?.response
          );
          if (client) break;
        }
        if (!client) {
          return { started: false, reason: 'axios_not_found' };
        }

        const config = { url: path, method: method.toLowerCase(), timeout: timeoutMs };
        if (params !== null) config.params = params;
        if (data !== null) config.data = data;
        if (encrypt) config.isEncrypt = true;

        try {
          await client(config);
          return { started: true, settled: 'resolved' };
        } catch (error) {
          // Do not return request config, headers or response bodies: they can
          // carry the bearer token and plaintext/encrypted credentials.
          return { started: true, settled: 'rejected', message: String(error?.message ?? error).slice(0, 200) };
        }
      },
      { path, method: requestMethod, params, data, encrypt, timeoutMs }
    );
  } catch (error) {
    throw new WudiRequestError('request_runtime', String(error?.message ?? error).split('\n')[0]);
  }

  if (!invocation?.started) {
    throw new WudiRequestError('request_client_missing', `Wudi request client unavailable (${redact(invocation?.reason ?? 'unknown')})`);
  }

  const event = await observed;
  if (!event.response) {
    throw new WudiRequestError('request_transport', 'Wudi request did not produce a response');
  }

  const response = event.response;
  let text;
  try {
    text = await response.text();
  } catch {
    throw new WudiRequestError('request_body', 'Wudi response body was unavailable');
  }
  const url = new URL(response.url());
  return { status: response.status(), ok: response.ok(), finalPath: url.pathname, text };
}

/** Read-only JSON request. Every failure is confirmed and safe to retry. */
export async function readWudiJson(session, request, { code, config }) {
  let response;
  try {
    response = await wudiRequest(session, { ...request, timeoutMs: config.fetchTimeoutMs });
  } catch (error) {
    const missing = error instanceof WudiRequestError && error.code === 'request_client_missing';
    throw failed(missing ? 'request_client_missing' : `${code}_transport`, missing ? error.message : 'Wudi read request failed', { retryable: !missing });
  }

  const json = parseJson(response.text);
  if (!json) {
    throw failed(`${code}_malformed`, `Wudi read response was not JSON (HTTP ${response.status})`);
  }
  if (Number(json.code) === UNAUTHORIZED) {
    session.markLoggedOut('session_expired');
    throw failed('session_expired', 'Wudi portal session expired', { retryable: true });
  }
  if (!response.ok || Number(json.code) !== SUCCESS) {
    throw failed(`${code}_rejected`, redact(json.msg ?? json.message ?? `Wudi returned code ${json.code ?? response.status}`));
  }
  return json;
}

/** code 200 is the common success contract observed in Wudi's response interceptor. */
export function classifyWudi(json, response, session = null) {
  const code = typeof json.code === 'number' || (typeof json.code === 'string' && /^\d+$/.test(json.code)) ? Number(json.code) : null;
  if (response.ok && code === SUCCESS) {
    return { ok: json };
  }
  // Authentication and HTTP 4xx responses prove the server refused this call.
  // Application 5xx/unknown/malformed codes are not proven no-change outcomes.
  if (code === UNAUTHORIZED) {
    session?.markLoggedOut('session_expired');
    return { rejected: 'Wudi portal session expired' };
  }
  if (response.status >= 400 && response.status < 500) {
    return { rejected: String(json.msg ?? json.message ?? `Wudi returned HTTP ${response.status}`) };
  }
  return null;
}
