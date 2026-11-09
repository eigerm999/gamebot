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
  assert.deepEqual(trusted.gotos, ['https://k1.example/lang/eng']); // English once per session
  await login.ensureLoggedIn(trusted, {});
  assert.deepEqual(trusted.gotos, ['https://k1.example/lang/eng']); // trusted again, nothing more

  const verified = homePage();
  await login.ensureLoggedIn(verified, {}, { verify: true });
  assert.deepEqual(verified.gotos, ['https://k1.example/', 'https://k1.example/lang/eng']);
});

test('yes918: English is selected after a fresh login and the session must survive it', async () => {
  const login = createLogin(site);

  // /lang/eng redirects somewhere else: the bot returns to the home page.
  const page = homePage();
  page.goto = async (url) => {
    page.gotos.push(url);
    page.current = url.endsWith('/lang/eng') ? 'https://k1.example/' : 'https://k1.example/search';
  };
  await login.ensureLoggedIn(page, {});
  assert.deepEqual(page.gotos, ['https://k1.example/lang/eng', 'https://k1.example/search']);

  // Switching language lost the session: not ready, never reported as logged in.
  const lost = homePage();
  lost.goto = async (url) => { lost.gotos.push(url); lost.current = 'https://k1.example/login'; };
  await assert.rejects(login.ensureLoggedIn(lost, {}), { code: 'session_unavailable' });
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

  // A read saw the login page: the retry must ask the portal, not trust the open page.
  session.markLoggedOut('session_expired');
  await session.ensureSession();
  assert.deepEqual(calls.at(-1), { verify: true });
  await session.ensureSession(); // logged in again: back to the fast path
  assert.deepEqual(calls.at(-1), { verify: false });
  assert.equal(session.authenticated, true);
  assert.match(session.checkedAt, /^\d{4}-\d\d-\d\dT/);

  portal.ensureLoggedIn = async () => { throw new Error('boom'); };
  await assert.rejects(session.ensureSession({ verify: true }), { code: 'session_unavailable' });
  assert.equal(session.authenticated, false);
  assert.equal(session.lastErrorCode, 'session_unavailable');
});
