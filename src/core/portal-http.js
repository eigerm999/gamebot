import { failed } from './errors.js';

/**
 * Read helpers for portal plugins. Reads never change the portal, so every
 * failure here is a confirmed failure ('failed'). Transport errors and expired
 * sessions are marked retryable: the server retries once, before anything
 * was submitted.
 */

export function parseJson(text) {
  try {
    const json = JSON.parse(text);
    return json && typeof json === 'object' && !Array.isArray(json) ? json : null;
  } catch {
    return null;
  }
}

function sessionExpired(session) {
  session.markLoggedOut('session_expired');
  return failed('session_expired', 'Portal session expired', { retryable: true });
}

async function get(session, path, config, code) {
  try {
    return await session.pageFetch(path, { timeoutMs: config.fetchTimeoutMs });
  } catch {
    throw failed(`${code}_transport`, 'Portal request failed', { retryable: true });
  }
}

/**
 * GET a JSON endpoint. A non-JSON answer is treated as an expired session:
 * portals answer AJAX calls with their login page when logged out.
 * Returns { json, response }; judging the content is up to the caller.
 */
export async function readJson(session, path, { config, code }) {
  const response = await get(session, path, config, code);
  const json = parseJson(response.text);
  if (!json) {
    throw sessionExpired(session);
  }
  return { json, response };
}

/**
 * GET a server-rendered page. isLoginPage(response) is the portal's own test
 * for "this is the login page"; it must not match ordinary pages.
 */
export async function readPage(session, path, { config, code, isLoginPage }) {
  const response = await get(session, path, config, code);
  if (isLoginPage(response)) {
    throw sessionExpired(session);
  }
  if (!response.ok) {
    throw failed(`${code}_rejected`, `Portal page returned HTTP ${response.status}`);
  }
  return response.text;
}
