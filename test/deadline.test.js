import assert from 'node:assert/strict';
import test from 'node:test';
import { answerByDeadline, operationStatus } from '../src/core/deadline.js';

const opts = (deadlineMs) => ({ startedAt: Date.now(), deadlineMs, operationId: 'op-1' });
const later = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

test('a change not sent by the deadline is answered as failed and can no longer be sent', async () => {
  const state = { submitted: false, expired: false };
  let sentLate = false;
  // Simulates a slow login: the submission step would come after the deadline.
  const task = later(80).then(() => {
    if (state.expired) {
      throw new Error('refused'); // what runOperation does via assertCanSubmit
    }
    sentLate = true;
    return 'sent';
  });

  const started = Date.now();
  await assert.rejects(answerByDeadline(task, state, opts(20)), { code: 'deadline_exceeded', outcome: 'failed' });
  assert.ok(Date.now() - started < 70, 'answered at the deadline, not when the task ended');
  assert.equal(state.expired, true);

  await later(100);
  assert.equal(sentLate, false);
});

test('once sent, the deadline no longer answers: the real result counts', async () => {
  const state = { submitted: false, expired: false };
  const task = later(5).then(() => { state.submitted = true; }).then(() => later(60, 'done'));
  assert.equal(await answerByDeadline(task, state, opts(20)), 'done');
  assert.equal(state.expired, false);
});

test('a fast result wins and errors pass through unchanged', async () => {
  assert.equal(await answerByDeadline(later(1, 'ok'), { submitted: false, expired: false }, opts(1000)), 'ok');
  const boom = Object.assign(new Error('x'), { code: 'player_disabled' });
  await assert.rejects(answerByDeadline(Promise.reject(boom), { submitted: false, expired: false }, opts(1000)), { code: 'player_disabled' });
});

test('operation status reports outcome and code only', () => {
  assert.deepEqual(operationStatus('a', undefined), [404, { operationId: 'a', error: { code: 'operation_not_found' } }]);
  assert.deepEqual(operationStatus('a', { done: false }), [200, { operationId: 'a', done: false }]);
  const failedEntry = { done: true, status: 200, body: { operationId: 'a', outcome: 'failed', error: { code: 'deadline_exceeded', message: 'x' } } };
  assert.deepEqual(operationStatus('a', failedEntry), [200, { operationId: 'a', done: true, outcome: 'failed', code: 'deadline_exceeded' }]);
  const created = { done: true, status: 200, body: { operationId: 'a', outcome: 'succeeded', result: { password: 'secret' } } };
  const [, body] = operationStatus('a', created);
  assert.deepEqual(body, { operationId: 'a', done: true, outcome: 'succeeded', code: null });
  assert.ok(!JSON.stringify(body).includes('secret'));
});
