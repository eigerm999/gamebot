import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationError, failed, unknown } from '../src/core/errors.js';
import { readJson, readPage } from '../src/core/portal-http.js';
import { submitOnce } from '../src/core/submit.js';

const config = { fetchTimeoutMs: 1000, submitTimeoutMs: 1000 };

function fakeSession(answer) {
  const calls = [];
  return {
    calls,
    loggedOut: null,
    markLoggedOut(code) {
      this.loggedOut = code;
    },
    async pageFetch(path, options) {
      calls.push({ path, ...options });
      if (answer instanceof Error) {
        throw answer;
      }
      return { status: 200, ok: true, finalPath: '/x', ...answer };
    },
  };
}

function fakeCtx({ refuse = false } = {}) {
  return {
    config,
    asserted: 0,
    assertCanSubmit() {
      if (refuse) {
        throw failed('client_gone', 'gone');
      }
      this.asserted++;
    },
  };
}

const classify = (json) => (json.error === 0 ? { ok: json } : json.error ? { rejected: json.msg } : null);

async function outcome(promise) {
  try {
    return { value: await promise };
  } catch (error) {
    assert.ok(error instanceof OperationError, `expected OperationError, got ${error}`);
    return { outcome: error.outcome, code: error.code };
  }
}

test('submitOnce: confirmed success returns the classified value and sends once', async () => {
  const session = fakeSession({ text: '{"error":0,"id":7}' });
  const ctx = fakeCtx();
  const result = await submitOnce(session, ctx, { path: '/p', form: { a: '1' }, code: 'x', classify });
  assert.deepEqual(result, { error: 0, id: 7 });
  assert.equal(session.calls.length, 1);
  assert.equal(ctx.asserted, 1);
  assert.equal(session.calls[0].method, 'POST');
});

test('submitOnce: explicit rejection is failed', async () => {
  const result = await outcome(submitOnce(fakeSession({ text: '{"error":5,"msg":"no"}' }), fakeCtx(), { path: '/p', code: 'x', classify }));
  assert.deepEqual(result, { outcome: 'failed', code: 'x_rejected' });
});

test('submitOnce: unclear answers are unknown, never failed', async () => {
  const cases = [
    [{ text: '{"something":"else"}' }, 'x_unconfirmed'],
    [{ text: '<html>login</html>' }, 'x_malformed'],
    [new Error('socket hang up'), 'x_transport'],
  ];
  for (const [answer, code] of cases) {
    assert.deepEqual(await outcome(submitOnce(fakeSession(answer), fakeCtx(), { path: '/p', code: 'x', classify })), { outcome: 'unknown', code });
  }
});

test('submitOnce: a classify bug is unknown; its own OperationError passes through', async () => {
  const broken = () => {
    throw new TypeError('bug');
  };
  assert.deepEqual(await outcome(submitOnce(fakeSession({ text: '{}' }), fakeCtx(), { path: '/p', code: 'x', classify: broken })), {
    outcome: 'unknown',
    code: 'x_unconfirmed',
  });
  const mismatch = () => {
    throw unknown('x_mismatch', 'mismatch');
  };
  assert.deepEqual(await outcome(submitOnce(fakeSession({ text: '{}' }), fakeCtx(), { path: '/p', code: 'x', classify: mismatch })), {
    outcome: 'unknown',
    code: 'x_mismatch',
  });
});

test('submitOnce: nothing is sent when the caller may have given up', async () => {
  const session = fakeSession({ text: '{"error":0}' });
  assert.deepEqual(await outcome(submitOnce(session, fakeCtx({ refuse: true }), { path: '/p', code: 'x', classify })), {
    outcome: 'failed',
    code: 'client_gone',
  });
  assert.equal(session.calls.length, 0);
});

test('readJson: HTML answer means the session expired (failed, retryable)', async () => {
  const session = fakeSession({ text: '<html></html>' });
  await assert.rejects(readJson(session, '/r', { config, code: 'r' }), (error) => error.outcome === 'failed' && error.code === 'session_expired' && error.retryable);
  assert.equal(session.loggedOut, 'session_expired');
});

test('readPage: login page and HTTP errors are failed', async () => {
  const isLoginPage = (response) => response.text.includes('LOGIN');
  await assert.rejects(readPage(fakeSession({ text: 'LOGIN' }), '/r', { config, code: 'r', isLoginPage }), (error) => error.code === 'session_expired');
  await assert.rejects(readPage(fakeSession({ text: 'x', ok: false, status: 500 }), '/r', { config, code: 'r', isLoginPage }), (error) => error.outcome === 'failed' && error.code === 'r_rejected');
  await assert.rejects(readPage(fakeSession(new Error('down')), '/r', { config, code: 'r', isLoginPage }), (error) => error.code === 'r_transport' && error.retryable);
  assert.equal(await readPage(fakeSession({ text: 'ok' }), '/r', { config, code: 'r', isLoginPage }), 'ok');
});
