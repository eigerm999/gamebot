import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogin } from '../src/portals/yes918/login.js';
import { BrowserSession } from '../src/core/session.js';

const site = { origin: 'https://k1.example', homePath: '/search', credentials: { username: 'u', password: 'p' } };

/** A page that is already on the logged-in home page. */
function homePage() {
  const page = {
    gotos: [],
    current: 'https://k1.example/search',
    url: () => page.current,
    locator: () => ({ count: async () => 0 }), // no second-password field: logged in
    goto: async (url) => { page.gotos.push(url); page.current = 'https://k1.example/search'; },
    waitForURL: async () => {},
  };
  return page;
}

test('yes918: a normal check trusts the current page; verify asks the portal', async () => {
  const login = createLogin(site);

  const trusted = homePage();
  await login.ensureLoggedIn(trusted, {});
  assert.deepEqual(trusted.gotos, []);

  const verified = homePage();
  await login.ensureLoggedIn(verified, {}, { verify: true });
  assert.deepEqual(verified.gotos, ['https://k1.example/']);
});

test('session check passes verify to the portal and records the check time', async () => {
  const calls = [];
  const portal = { ensureLoggedIn: async (page, config, options) => calls.push(options) };
  const session = new BrowserSession({ key: 'a', proxy: null }, portal, { profileRoot: '/tmp' });
  session.start = async () => {}; // no real browser

  assert.equal(session.checkedAt, null);
  await session.ensureSession({ verify: true });
  await session.ensureSession();
  assert.deepEqual(calls, [{ verify: true }, { verify: false }]);
  assert.equal(session.authenticated, true);
  assert.match(session.checkedAt, /^\d{4}-\d\d-\d\dT/);

  portal.ensureLoggedIn = async () => { throw new Error('boom'); };
  await assert.rejects(session.ensureSession({ verify: true }), { code: 'session_unavailable' });
  assert.equal(session.authenticated, false);
  assert.equal(session.lastErrorCode, 'session_unavailable');
});
