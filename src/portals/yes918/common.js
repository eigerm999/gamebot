import { randomInt } from 'node:crypto';
import { isZero, nonEmpty } from '../../core/errors.js';

/** yes918 serves several game types; every call here is for 918. */
export const GAME = '918';

const PASSWORD_PREFIXES = ['Aaa', 'Bbb', 'Ccc', 'Ddd', 'Edd', 'Fff', 'Ggg'];

/** Matches the portal's own format: prefix + 100..998. */
export function generatePlayerPassword() {
  return PASSWORD_PREFIXES[randomInt(0, PASSWORD_PREFIXES.length)] + String(randomInt(100, 999));
}

/**
 * The usual yes918 change answer: error 0 -> success, an explicit non-zero
 * error -> rejected (1000 = player disabled), anything else -> unknown.
 */
export function classifyErrorField(json, response) {
  if (response.ok && isZero(json.error)) {
    return { ok: json };
  }
  if (nonEmpty(json.error) && !isZero(json.error)) {
    return { rejected: String(json.error) === '1000' ? 'Player is disabled' : String(json.message ?? json.msg ?? 'Portal rejected the request') };
  }
  return null;
}

/** A page fetch that landed on the login form instead of the requested page. */
export function isLoginPage(response) {
  return response.finalPath.startsWith('/login') || /name=["']?password2?["']?[\s/>]/i.test(response.text);
}
