import { OperationError, failed, redact, unknown } from './errors.js';
import { parseJson } from './portal-http.js';

/**
 * The only way a portal plugin sends a change. It:
 *   1. calls ctx.assertCanSubmit() (caller still connected, deadline not passed),
 *   2. sends the request exactly once,
 *   3. maps the answer to an outcome.
 *
 * classify(json, response) is the portal's judgement of a JSON answer:
 *   { ok: value }          -> returned to the operation (succeeded)
 *   { rejected: message }  -> failed: the portal explicitly said no
 *   null / anything else   -> unknown: the change may have happened
 * classify may also throw an OperationError (e.g. unknown(...) on a mismatch).
 *
 * After step 1 nothing may be retried; every unclear result is 'unknown'.
 */
export async function submitOnce(session, ctx, { path, method = 'POST', form = null, code, classify }) {
  ctx.assertCanSubmit();

  let response;
  try {
    response = await session.pageFetch(path, { method, form, timeoutMs: ctx.config.submitTimeoutMs });
  } catch {
    throw unknown(`${code}_transport`, 'Request did not complete');
  }

  const json = parseJson(response.text);
  if (!json) {
    throw unknown(`${code}_malformed`, `Response was not JSON (HTTP ${response.status})`);
  }

  let verdict;
  try {
    verdict = classify(json, response);
  } catch (error) {
    if (error instanceof OperationError) {
      throw error;
    }
    throw unknown(`${code}_unconfirmed`, 'Response could not be judged');
  }

  if (verdict && 'ok' in verdict) {
    return verdict.ok;
  }
  if (verdict && typeof verdict.rejected === 'string') {
    throw failed(`${code}_rejected`, redact(verdict.rejected) || 'Portal rejected the request');
  }
  throw unknown(`${code}_unconfirmed`, 'Response did not confirm success');
}
