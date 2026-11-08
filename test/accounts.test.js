import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadAccounts } from '../src/accounts.js';
import { PORTALS } from '../src/portals/index.js';

const env = { U1: 'agent1', P1: 'secret1', U2: 'agent2', P2: 'secret2', PROXY: 'http://1.2.3.4:8080' };

const base = (overrides = {}) => ({
  portal: 'yes918',
  baseUrl: 'https://portal.example',
  credentials: { username: 'U1', password: 'P1' },
  limits: { maxInitialScore: '50', maxSetScore: '1000' },
  ...overrides,
});

function load(accounts, environment = env) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-')), 'accounts.json');
  fs.writeFileSync(file, typeof accounts === 'string' ? accounts : JSON.stringify(accounts));
  return loadAccounts(file, PORTALS, environment);
}

test('loads a valid account and resolves secrets from env', () => {
  const [account] = load({ 'yes918-0038': base({ settings: { homePath: '/search' }, proxy: { server: 'PROXY' } }) });
  assert.equal(account.key, 'yes918-0038');
  assert.equal(account.origin, 'https://portal.example');
  assert.deepEqual({ ...account.credentials }, { username: 'agent1', password: 'secret1' });
  assert.deepEqual({ ...account.limits }, { maxInitialScoreCents: 5000, maxSetScoreCents: 100000 });
  assert.equal(account.settings.agentUsername, 'agent1'); // defaults to the login
  assert.equal(account.proxy.server, 'http://1.2.3.4:8080');
});

test('PROXY_ACCOUNTS picks which accounts use the shared proxy', () => {
  const two = {
    a: base(),
    b: base({ credentials: { username: 'U2', password: 'P2' } }),
  };
  const shared = { ...env, PROXY_SERVER: 'http://1.2.3.4:5965', PROXY_USERNAME: 'u', PROXY_PASSWORD: 'p' };

  const [a, b] = load(two, { ...shared, PROXY_ACCOUNTS: ' b ' });
  assert.equal(a.proxy, null); // not listed: direct
  assert.deepEqual({ ...b.proxy }, { server: 'http://1.2.3.4:5965', username: 'u', password: 'p' });

  const both = load(two, { ...shared, PROXY_ACCOUNTS: 'a,b' });
  assert.ok(both.every((account) => account.proxy.server === 'http://1.2.3.4:5965'));

  // Empty list = proxy off for everyone; the PROXY_* values may then be empty.
  assert.ok(load(two, { ...env, PROXY_ACCOUNTS: '' }).every((account) => account.proxy === null));
  assert.ok(load(two, env).every((account) => account.proxy === null));
});

test('shared proxy mistakes stop the worker at startup', () => {
  const shared = { ...env, PROXY_SERVER: 'http://1.2.3.4:5965', PROXY_ACCOUNTS: 'a' };
  assert.throws(() => load({ a: base() }, { ...shared, PROXY_ACCOUNTS: 'a,typo' }), /PROXY_ACCOUNTS: unknown account "typo"/);
  assert.throws(() => load({ a: base() }, { ...env, PROXY_ACCOUNTS: 'a' }), /PROXY_SERVER is empty/);
  assert.throws(() => load({ a: base() }, { ...shared, PROXY_USERNAME: 'u' }), /must be set together/);
  for (const bad of ['1.2.3.4:5965', 'ftp://1.2.3.4:21', 'http://u:p@1.2.3.4:5965']) {
    assert.throws(() => load({ a: base() }, { ...shared, PROXY_SERVER: bad }), /PROXY_SERVER must look like http:\/\/host:port/);
  }
  assert.throws(() => load({ a: base({ proxy: { server: 'PROXY' } }) }, shared), /also has its own "proxy"/);
  assert.throws(() => load({ a: base({ proxy: { server: 'PROXY', rotate: 'X' } }) }), /unknown field "proxy.rotate"/);
});

test('null limits mean no per-transaction limit; a missing limit is still an error', () => {
  const [account] = load({ a: base({ limits: { maxInitialScore: null, maxSetScore: null } }) });
  assert.equal(account.limits.maxInitialScoreCents, Infinity);
  assert.equal(account.limits.maxSetScoreCents, Infinity);
  assert.throws(() => load({ a: base({ limits: { maxInitialScore: '50' } }) }), /limits.maxSetScore is required/);
});

test('loads a Wudi account with zero initial score and unlimited set score', () => {
  const [account] = load(
    {
      'wudi-spadik': {
        portal: 'wudi', baseUrl: 'https://wdbo.wg365.xyz',
        credentials: { username: 'U1', password: 'P1' },
        limits: { maxInitialScore: '0', maxSetScore: null },
        settings: { homePath: '/user/front', playerPrefix: 'wd', scoreRemark: 'maxis6' },
        proxy: null,
      },
    }
  );
  assert.equal(account.portal, 'wudi');
  assert.equal(account.limits.maxInitialScoreCents, 0);
  assert.equal(account.limits.maxSetScoreCents, Infinity);
  assert.equal(account.settings.playerPrefix, 'wd');
});

test('two logins on one portal are two accounts', () => {
  const accounts = load({
    'yes918-0038': base(),
    'yes918-0039': base({ credentials: { username: 'U2', password: 'P2' } }),
  });
  assert.deepEqual(accounts.map((a) => a.key), ['yes918-0038', 'yes918-0039']);
});

test('rejects bad files and accounts with the account and field named', () => {
  const cases = [
    ['not json', /cannot read/],
    [{}, /at least one account/],
    [{ 'Bad Key': base() }, /"Bad Key".*lowercase/],
    [{ a: base({ portal: 'nope' }) }, /"a".*unknown portal "nope"/],
    [{ a: base({ baseUrl: 'http://portal.example' }) }, /"a".*https/],
    [{ a: base({ credentials: { username: 'U1' } }) }, /"a".*credentials.password is required/],
    [{ a: base({ credentials: { username: 'U1', password: 'MISSING' } }) }, /"a".*MISSING is empty/],
    [{ a: base({ credentials: { username: 'U1', password: 'secret-inline' } }) }, /"a".*must name an environment variable/],
    [{ a: base({ credentials: { username: 'U1', password: 'P1', pin: 'P1' } }) }, /"a".*credentials.pin is not used/],
    [{ a: base({ limits: { maxInitialScore: 50, maxSetScore: '1000' } }) }, /"a".*limits.maxInitialScore/],
    [{ a: base({ settings: { colour: 'red' } }) }, /"a".*unknown setting "colour"/],
    [{ a: base({ extra: true }) }, /"a".*unknown field "extra"/],
    [{ a: base(), b: base() }, /"b".*same portal login/],
  ];
  for (const [accounts, message] of cases) {
    assert.throws(() => load(accounts), message, JSON.stringify(accounts).slice(0, 80));
  }
});
