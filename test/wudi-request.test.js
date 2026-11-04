import assert from 'node:assert/strict';
import test from 'node:test';
import { readWudiJson, WudiRequestError, wudiRequest } from '../src/portals/wudi/request.js';

function pageFor({ path = '/prod-api/user/front/list', method = 'GET', status = 200, text = '{"code":200,"rows":[]}', invocation = { started: true, settled: 'resolved' } } = {}) {
  let evaluated = null;
  const response = {
    url: () => 'https://wdbo.wg365.xyz' + path,
    request: () => ({ method: () => method }),
    status: () => status,
    ok: () => status >= 200 && status < 300,
    text: async () => text,
  };
  return {
    get evaluated() { return evaluated; },
    url: () => 'https://wdbo.wg365.xyz/user/front',
    waitForResponse: async (predicate) => {
      assert.equal(predicate(response), true);
      return response;
    },
    evaluate: async (_fn, payload) => { evaluated = payload; return invocation; },
  };
}

test('wudiRequest returns a raw observed response and passes encrypted request config', async () => {
  const page = pageFor({ path: '/prod-api/user/front/balance', method: 'PUT', text: '{"code":200}' });
  const response = await wudiRequest(page, { path: '/user/front/balance', method: 'PUT', data: { balanceMoney: '1.00' }, encrypt: true, timeoutMs: 1000 });
  assert.deepEqual(response, { status: 200, ok: true, finalPath: '/prod-api/user/front/balance', text: '{"code":200}' });
  assert.deepEqual(page.evaluated, { path: '/user/front/balance', method: 'PUT', params: null, data: { balanceMoney: '1.00' }, encrypt: true, timeoutMs: 1000 });
});

test('wudiRequest fails closed if the portal Axios client cannot be found', async () => {
  const page = pageFor({ invocation: { started: false, reason: 'axios_not_found' } });
  await assert.rejects(
    wudiRequest(page, { path: '/user/front/list', timeoutMs: 1000 }),
    (error) => error instanceof WudiRequestError && error.code === 'request_client_missing'
  );
});

test('readWudiJson marks code 401 as an expired retryable session', async () => {
  const page = pageFor({ status: 200, text: '{"code":401,"msg":"expired"}' });
  const session = { page, loggedOut: null, markLoggedOut(code) { this.loggedOut = code; } };
  await assert.rejects(
    readWudiJson(session, { path: '/user/front/list' }, { code: 'player', config: { fetchTimeoutMs: 1000 } }),
    (error) => error.code === 'session_expired' && error.outcome === 'failed' && error.retryable
  );
  assert.equal(session.loggedOut, 'session_expired');
});

test('readWudiJson treats an explicit application error as failed', async () => {
  const page = pageFor({ text: '{"code":500,"msg":"not allowed"}' });
  const session = { page, markLoggedOut() {} };
  await assert.rejects(
    readWudiJson(session, { path: '/user/front/list' }, { code: 'player', config: { fetchTimeoutMs: 1000 } }),
    (error) => error.code === 'player_rejected' && error.outcome === 'failed' && error.message === 'not allowed'
  );
});
