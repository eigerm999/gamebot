import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationError } from '../src/core/errors.js';
import { playerOperations } from '../src/portals/wudi/players.js';
import { scoreOperations } from '../src/portals/wudi/score.js';

const site = { credentials: { username: 'spadik' }, playerPrefix: 'wd', playerRemark: '', scoreRemark: 'maxis6' };
const config = { fetchTimeoutMs: 1000, submitTimeoutMs: 1000 };

function response(path, method, body, status = 200) {
  return { path: '/prod-api' + path, method, body, status };
}

class FakePage {
  constructor(responses) {
    this.responses = [...responses];
    this.calls = [];
    this.createdUsername = null;
  }
  url() { return 'https://wdbo.wg365.xyz/user/front'; }
  async waitForResponse(predicate) {
    const next = this.responses.shift();
    assert.ok(next, 'unexpected portal request');
    const raw = {
      url: () => 'https://wdbo.wg365.xyz' + next.path,
      request: () => ({ method: () => next.method }),
      status: () => next.status,
      ok: () => next.status >= 200 && next.status < 300,
      text: async () => JSON.stringify(typeof next.body === 'function' ? next.body(this) : next.body),
    };
    assert.equal(predicate(raw), true, `request did not match ${next.method} ${next.path}`);
    return raw;
  }
  async evaluate(_fn, payload) {
    this.calls.push(payload);
    if (payload.method === 'POST' && payload.path === '/user/front') this.createdUsername = payload.data.userName;
    return { started: true, settled: 'resolved' };
  }
}

function session(responses) {
  return { page: new FakePage(responses), markLoggedOut() {} };
}

function ctx() {
  return { config, submitted: 0, async recordCreateIdentity(playerId) { this.playerId = playerId; }, assertCanSubmit() { this.submitted++; } };
}

function list(username = 'testm1', status = '0') {
  return { code: 200, rows: [{ userId: 22710, userName: username, status, sysUserId: 888 }] };
}

function wallet(amount = 0.1) {
  return { code: 200, data: { id: 12552, userId: 22710, userName: 'testm1', goldMoney: amount } };
}

async function thrown(promise) {
  try { await promise; assert.fail('expected operation error'); } catch (error) { assert.ok(error instanceof OperationError); return error; }
}

test('create sends one encrypted mutation and verifies the generated wd ID', async () => {
  const s = session([
    response('/user/front/list', 'GET', { code: 200, rows: [] }),
    response('/user/front', 'POST', { code: 200, msg: 'ok' }),
    response('/user/front/list', 'GET', (page) => list(page.createdUsername)),
  ]);
  const op = playerOperations(site);
  const c = ctx();
  const result = await op.createPlayer({ session: s, params: { amount: '0.00' }, ctx: c });
  assert.match(result.playerId, /^wd\d{10}$/);
  assert.equal(c.playerId, result.playerId);
  assert.equal(result.score, '0.00');
  assert.equal(c.submitted, 1);
  assert.equal(s.page.calls.filter((call) => call.method === 'POST').length, 1);
  assert.equal(s.page.calls.find((call) => call.method === 'POST').encrypt, true);
});

test('create verification failure after success is unknown, never failed', async () => {
  const s = session([
    response('/user/front/list', 'GET', { code: 200, rows: [] }),
    response('/user/front', 'POST', { code: 200 }),
    response('/user/front/list', 'GET', { code: 500, msg: 'read down' }),
  ]);
  const error = await thrown(playerOperations(site).createPlayer({ session: s, params: { amount: '0.00' }, ctx: ctx() }));
  assert.equal(error.outcome, 'unknown');
  assert.equal(error.code, 'create_verify_failed');
  assert.equal(s.page.calls.filter((call) => call.method === 'POST').length, 1);
});

test('setScore sends one encrypted signed balance change and returns rounded read-back', async () => {
  const s = session([
    response('/user/front/list', 'GET', list()), response('/user/front/getUserWalletByUserId', 'GET', wallet('0.1')),
    response('/user/front/balance', 'PUT', { code: 200 }),
    response('/user/front/list', 'GET', list()), response('/user/front/getUserWalletByUserId', 'GET', wallet('1.099999999999994')),
  ]);
  const players = playerOperations(site); const c = ctx();
  const result = await scoreOperations(site, players.fetchPlayer).setScore({ session: s, params: { playerId: 'testm1', amount: '1.00' }, ctx: c });
  assert.deepEqual(result, { playerId: 'testm1', amount: '1.00', balanceBefore: '0.10', balanceAfter: '1.10' });
  const mutation = s.page.calls.find((call) => call.path === '/user/front/balance');
  assert.deepEqual(mutation.data, { userWalletId: 12552, balanceMoney: '1.00', remark: 'maxis6' });
  assert.equal(c.submitted, 1);
});

test('setScore read-back failure after success is unknown and cannot invite a retry', async () => {
  const s = session([
    response('/user/front/list', 'GET', list()), response('/user/front/getUserWalletByUserId', 'GET', wallet('0.1')),
    response('/user/front/balance', 'PUT', { code: 200 }),
    response('/user/front/list', 'GET', { code: 500, msg: 'read down' }),
  ]);
  const players = playerOperations(site);
  const error = await thrown(scoreOperations(site, players.fetchPlayer).setScore({ session: s, params: { playerId: 'testm1', amount: '1.00' }, ctx: ctx() }));
  assert.equal(error.outcome, 'unknown');
  assert.equal(error.code, 'setscore_verify_failed');
  assert.equal(s.page.calls.filter((call) => call.method === 'PUT').length, 1);
});

test('status read-back failure after success is unknown', async () => {
  const s = session([
    response('/user/front/list', 'GET', list('testm1', '0')),
    response('/user/front/updateUserStatus', 'PUT', { code: 200 }),
    response('/user/front/list', 'GET', { code: 500, msg: 'read down' }),
  ]);
  const error = await thrown(playerOperations(site).disablePlayer({ session: s, params: { playerId: 'testm1', enable: false }, ctx: ctx() }));
  assert.equal(error.outcome, 'unknown');
  assert.equal(error.code, 'status_verify_failed');
  assert.equal(s.page.calls.filter((call) => call.method === 'PUT').length, 1);
});

test('withdrawal above the player balance fails before submission', async () => {
  const s = session([response('/user/front/list', 'GET', list()), response('/user/front/getUserWalletByUserId', 'GET', wallet('0.1'))]);
  const players = playerOperations(site); const c = ctx();
  const error = await thrown(scoreOperations(site, players.fetchPlayer).setScore({ session: s, params: { playerId: 'testm1', amount: '-1.00' }, ctx: c }));
  assert.equal(error.outcome, 'failed');
  assert.equal(error.code, 'insufficient_balance');
  assert.equal(c.submitted, 0);
});
