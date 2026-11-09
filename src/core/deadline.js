import { failed, log } from './errors.js';

/**
 * A change that has not been sent by deadlineMs (measured from startedAt) is
 * answered at once as failed: nothing was sent, and state.expired makes sure
 * nothing will be (runOperation checks it before every submission). The
 * caller (75 s timeout) therefore gets a definite answer for slow logins and
 * queue waits instead of timing out into "unknown". Once sent, only the real
 * result counts (bounded by SUBMIT_TIMEOUT_MS).
 *
 * state: { submitted, expired } — both flipped synchronously, so exactly one wins.
 */
export function answerByDeadline(task, state, { startedAt, deadlineMs, operationId }) {
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      if (state.submitted) {
        return; // already sent: wait for the real result
      }
      state.expired = true;
      log('deadline_answered', { operationId });
      reject(failed('deadline_exceeded', 'Not sent: the portal was too slow before submission'));
    }, Math.max(0, deadlineMs - (Date.now() - startedAt)));
  });
  task.catch(() => {}); // a result arriving after the deadline answer is ignored
  return Promise.race([task, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Status of a remembered operation for GET /v1/operations/:id. Outcome and
 * error code only, never the result (a create result holds a password).
 * 404 means "not known to this process" (e.g. after a restart): proves nothing.
 */
export function operationStatus(operationId, entry) {
  if (!entry) {
    return [404, { operationId, error: { code: 'operation_not_found' } }];
  }
  if (!entry.done) {
    return [200, { operationId, done: false }];
  }
  return [200, { operationId, done: true, outcome: entry.body?.outcome ?? 'unknown', code: entry.body?.error?.code ?? null }];
}
