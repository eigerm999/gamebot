import assert from 'node:assert/strict';
import test from 'node:test';
import { OperationError } from '../src/core/errors.js';
import { automaticLoginAllowed, createLogin } from '../src/portals/wudi/login.js';
import { validateSettings } from '../src/portals/wudi/index.js';
import { generatePassword, generateUsername } from '../src/portals/wudi/players.js';
import { mapGameLogRow, mapScoreLogRow } from '../src/portals/wudi/reports.js';
import { classifyWudi } from '../src/portals/wudi/request.js';

test('Wudi settings are normalized and strict', () => {
  assert.deepEqual(validateSettings({}), { homePath: '/user/front', playerPrefix: 'wd', playerRemark: '', scoreRemark: 'maxis6' });
  assert.throws(() => validateSettings({ playerPrefix: 'kfc2' }), /exactly "wd"/);
  assert.throws(() => validateSettings({ playerPrefix: 'UPPER' }), /playerPrefix/);
  assert.throws(() => validateSettings({ playerPrefix: 'x'.repeat(39) }), /playerPrefix/);
  assert.throws(() => validateSettings({ unknown: 'x' }), /unknown setting/);
});

test('automatic login is allowed only when the CAPTCHA response explicitly disables it', () => {
  assert.equal(automaticLoginAllowed({ code: 200, captchaEnabled: false }, { ok: true }), true);
  assert.equal(automaticLoginAllowed({ code: 200, captchaEnabled: false }, { ok: false }), false);
  assert.equal(automaticLoginAllowed({ code: 500, captchaEnabled: false }, { ok: true }), false);
  assert.equal(automaticLoginAllowed({ code: 200, captchaEnabled: true }, { ok: true }), false);
  assert.equal(automaticLoginAllowed(null, { ok: true }), false);
});

test('login never fills or clicks unless CAPTCHA endpoint explicitly succeeds with disabled', async () => {
  const cases = [
    async () => ({ ok: true, text: JSON.stringify({ code: 200, captchaEnabled: true }) }),
    async () => ({ ok: true, text: JSON.stringify({ code: 500, captchaEnabled: false }) }),
    async () => ({ ok: false, text: JSON.stringify({ code: 200, captchaEnabled: false }) }),
    async () => { throw new Error('transport'); },
  ];
  for (const request of cases) {
    let fills = 0;
    let clicks = 0;
    const passwordField = { waitFor: async () => {}, first() { return this; }, fill: async () => { fills++; } };
    const usernameField = { first() { return this; }, fill: async () => { fills++; } };
    const button = { filter() { return this; }, first() { return this; }, click: async () => { clicks++; } };
    const form = {
      first() { return this; },
      locator(selector) { return selector.includes('password') && !selector.includes(':not') ? passwordField : usernameField; },
      getByRole() { return button; },
    };
    const page = {
      url: () => 'https://wdbo.wg365.xyz/login',
      addInitScript: async () => {},
      goto: async () => {},
      locator: () => form,
      waitForLoadState: async () => {},
    };
    await assert.rejects(
      createLogin({ origin: 'https://wdbo.wg365.xyz', credentials: { username: 'u', password: 'p' }, homePath: '/user/front' }, request).ensureLoggedIn(page, { fetchTimeoutMs: 1000 }),
      (error) => error instanceof OperationError && error.code === 'login_challenge'
    );
    assert.equal(fills, 0);
    assert.equal(clicks, 0);
  }
});

test('Wudi login prefers English once per page, only on the Wudi origin', async () => {
  const scripts = [];
  const page = {
    url: () => 'https://wdbo.wg365.xyz/user/front',
    addInitScript: async (fn, arg) => scripts.push([fn, arg]),
  };
  const ok = async () => ({ ok: true, status: 200, text: JSON.stringify({ code: 200 }) }); // already logged in
  const login = createLogin({ origin: 'https://wdbo.wg365.xyz', credentials: { username: 'u', password: 'p' }, homePath: '/user/front' }, ok);
  await login.ensureLoggedIn(page, { fetchTimeoutMs: 1000 });
  await login.ensureLoggedIn(page, { fetchTimeoutMs: 1000 });
  assert.equal(scripts.length, 1);

  const [fn, origin] = scripts[0];
  const run = (pageOrigin, stored) => {
    const store = new Map(stored ? [['language', stored]] : []);
    const saved = globalThis.window;
    globalThis.window = { location: { origin: pageOrigin }, localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) } };
    try { fn(origin); } finally { globalThis.window = saved; }
    return store.get('language') ?? null;
  };
  assert.equal(run('https://wdbo.wg365.xyz', 'zh-CN'), 'en-US');
  assert.equal(run('https://wdbo.wg365.xyz', null), 'en-US');
  assert.equal(run('https://other.example', 'zh-CN'), 'zh-CN'); // never another site
});

test('generated Wudi credentials match portal rules', () => {
  const usernames = new Set();
  for (let i = 0; i < 100; i++) {
    const username = generateUsername('wd');
    const password = generatePassword();
    assert.match(username, /^wd\d{10}$/);
    assert.match(username, /^[a-z0-9]{4,50}$/);
    assert.match(password, /^[A-Za-z0-9]{5,20}$/);
    usernames.add(username);
  }
  assert.ok(usernames.size > 95);
});

test('Wudi response classifier accepts only application code 200', () => {
  assert.deepEqual(classifyWudi({ code: 200, msg: 'ok' }, { ok: true }), { ok: { code: 200, msg: 'ok' } });
  assert.equal(classifyWudi({ code: 500, msg: 'unclear' }, { ok: true, status: 200 }), null);
  assert.equal(classifyWudi({ code: null, msg: 'malformed' }, { ok: true, status: 200 }), null);
  const session = { loggedOut: null, markLoggedOut(code) { this.loggedOut = code; } };
  assert.deepEqual(classifyWudi({ code: 401, msg: 'expired' }, { ok: true, status: 200 }, session), { rejected: 'Wudi portal session expired' });
  assert.equal(session.loggedOut, 'session_expired');
  assert.deepEqual(classifyWudi({ code: 403, msg: 'forbidden' }, { ok: false, status: 403 }), { rejected: 'forbidden' });
  assert.equal(classifyWudi({ msg: 'unclear' }, { ok: true, status: 200 }), null);
  assert.equal(classifyWudi({ code: 200 }, { ok: false, status: 500 }), null);
});

test('Wudi score-log mapping includes direct credit/debit only', () => {
  assert.deepEqual(
    mapScoreLogRow({ type: '1', changeAmount: 0.1, afterMoney: 0.1, createTime: '2026-11-04 00:16:01', bwOrderNumber: 'A1' }),
    { time: '2026-11-04 00:16:01', amount: '0.10', balanceAfter: '0.10', reference: 'A1' }
  );
  assert.deepEqual(
    mapScoreLogRow({ type: '2', changeAmount: -20, afterMoney: 5, createTime: '2026-11-04 01:00:00', bwOrderNumber: 'A2' }),
    { time: '2026-11-04 01:00:00', amount: '-20.00', balanceAfter: '5.00', reference: 'A2' }
  );
  assert.equal(mapScoreLogRow({ type: '1', changeAmount: 1, afterMoney: 2, createTime: '' }), null);
  assert.equal(mapScoreLogRow({ type: '1', changeAmount: 1, afterMoney: 2, createTime: 'not-a-date' }), null);
  assert.equal(mapScoreLogRow({ type: '3', changeAmount: 1, afterMoney: 2 }), null);
  assert.equal(mapScoreLogRow({ type: '1', changeAmount: 'bad', afterMoney: 2 }), null);
});

test('Wudi game-log mapping uses net win/loss in the shared win field', () => {
  assert.deepEqual(
    mapGameLogRow({ pfCode: 'bt', game: 'FUMA_17', wagerMoney: 10, changeAmount: -2.5, beforeMoney: 20, afterMoney: 17.5, changeTime: '2026-11-04 02:00:00' }),
    { type: 'game', game: 'FUMA_17', log: null, amount: null, bet: '10.00', win: '-2.50', beginBalance: '20.00', endBalance: '17.50', time: '2026-11-04 02:00:00' }
  );
  assert.deepEqual(
    mapGameLogRow({ game: 'Noise', wagerMoney: '0.099999999999994', changeAmount: '1.005', beforeMoney: '1.005', afterMoney: '-0' , changeTime: '2026-11-04 03:00:00' }),
    { type: 'game', game: 'Noise', log: null, amount: null, bet: '0.10', win: '1.01', beginBalance: '1.01', endBalance: '0.00', time: '2026-11-04 03:00:00' }
  );
});
