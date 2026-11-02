import fs from 'node:fs';
import { AMOUNT, toCents } from './core/money.js';

/**
 * Loads accounts.json: one entry per portal login.
 *
 *   "<account-key>": {
 *     "portal": "yes918",
 *     "baseUrl": "https://...",
 *     "credentials": { "<field>": "<ENV_VAR_NAME>", ... },
 *     "limits": { "maxInitialScore": "50", "maxSetScore": "1000" },
 *     "settings": { ... portal-specific ... },
 *     "proxy": null | { "server": "<ENV>", "username": "<ENV>", "password": "<ENV>" }
 *   }
 *
 * Secrets are referenced by environment variable name and never stored in the
 * file. Any problem stops the worker at startup with the account and field
 * named, instead of failing later during a money operation.
 */

export const ACCOUNT_KEY = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,99}$/;
const ACCOUNT_FIELDS = ['portal', 'baseUrl', 'credentials', 'limits', 'settings', 'proxy'];

class AccountError extends Error {
  constructor(key, message) {
    super(key ? `accounts.json: account "${key}": ${message}` : `accounts.json: ${message}`);
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function envValue(key, field, name, env, { optional = false } = {}) {
  if (typeof name !== 'string' || !ENV_NAME.test(name)) {
    throw new AccountError(key, `${field} must name an environment variable (UPPER_CASE)`);
  }
  const value = (env[name] ?? '').trim();
  if (value === '' && !optional) {
    throw new AccountError(key, `${field}: environment variable ${name} is empty`);
  }
  return value === '' ? undefined : value;
}

function loadCredentials(key, spec, refs, env) {
  if (!isObject(refs)) {
    throw new AccountError(key, 'credentials must be an object of field -> ENV_VAR_NAME');
  }
  const allowed = [...spec.required, ...spec.optional];
  for (const field of Object.keys(refs)) {
    if (!allowed.includes(field)) {
      throw new AccountError(key, `credentials.${field} is not used by this portal (allowed: ${allowed.join(', ')})`);
    }
  }
  const credentials = {};
  for (const field of spec.required) {
    if (!(field in refs)) {
      throw new AccountError(key, `credentials.${field} is required`);
    }
    credentials[field] = envValue(key, `credentials.${field}`, refs[field], env);
  }
  for (const field of spec.optional) {
    if (field in refs) {
      credentials[field] = envValue(key, `credentials.${field}`, refs[field], env, { optional: true });
    }
  }
  return Object.freeze(credentials);
}

function loadLimits(key, limits) {
  if (!isObject(limits)) {
    throw new AccountError(key, 'limits must be an object');
  }
  const result = {};
  for (const name of ['maxInitialScore', 'maxSetScore']) {
    if (!(name in limits)) {
      throw new AccountError(key, `limits.${name} is required (an amount such as "50", or null for no limit)`);
    }
    // null = no per-transaction limit. Amounts are still capped by the amount
    // format, agent credit (Laravel) and player balance (withdrawals).
    if (limits[name] === null) {
      result[`${name}Cents`] = Number.POSITIVE_INFINITY;
      continue;
    }
    if (typeof limits[name] !== 'string' || !AMOUNT.test(limits[name])) {
      throw new AccountError(key, `limits.${name} must be an amount string such as "50", or null for no limit`);
    }
    result[`${name}Cents`] = toCents(limits[name]);
  }
  return Object.freeze(result);
}

function loadProxy(key, proxy, env) {
  if (proxy === null || proxy === undefined) {
    return null;
  }
  if (!isObject(proxy) || !('server' in proxy)) {
    throw new AccountError(key, 'proxy must be null or { "server": ENV, "username"?: ENV, "password"?: ENV }');
  }
  return Object.freeze({
    server: envValue(key, 'proxy.server', proxy.server, env),
    username: 'username' in proxy ? envValue(key, 'proxy.username', proxy.username, env) : undefined,
    password: 'password' in proxy ? envValue(key, 'proxy.password', proxy.password, env) : undefined,
  });
}

/**
 * @param file     path to accounts.json
 * @param portals  registry { name: { credentials: {required, optional}, validateSettings } }
 * @param env      process.env (injectable for tests)
 * @returns frozen array of accounts
 */
export function loadAccounts(file, portals, env = process.env) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new AccountError(null, `cannot read ${file} (${error.code ?? 'invalid JSON'}); copy accounts.example.json`);
  }
  if (!isObject(raw) || Object.keys(raw).length === 0) {
    throw new AccountError(null, 'must be an object with at least one account');
  }

  const logins = new Set();
  const accounts = Object.entries(raw).map(([key, entry]) => {
    if (!ACCOUNT_KEY.test(key)) {
      throw new AccountError(key, 'key must be lowercase letters, digits and dashes (max 40)');
    }
    if (!isObject(entry)) {
      throw new AccountError(key, 'must be an object');
    }
    for (const field of Object.keys(entry)) {
      if (!ACCOUNT_FIELDS.includes(field)) {
        throw new AccountError(key, `unknown field "${field}"`);
      }
    }

    const portal = portals[entry.portal];
    if (!portal) {
      throw new AccountError(key, `unknown portal "${entry.portal}" (known: ${Object.keys(portals).join(', ')})`);
    }

    let base;
    try {
      base = new URL(entry.baseUrl);
    } catch {
      throw new AccountError(key, 'baseUrl must be a URL');
    }
    if (base.protocol !== 'https:') {
      throw new AccountError(key, 'baseUrl must use https');
    }

    const credentials = loadCredentials(key, portal.credentials, entry.credentials, env);

    // Two accounts on one login would log each other out and share a balance.
    const login = `${entry.portal}|${base.origin}|${credentials.username ?? ''}`;
    if (logins.has(login)) {
      throw new AccountError(key, 'uses the same portal login as another account');
    }
    logins.add(login);

    const settingsInput = entry.settings ?? {};
    if (!isObject(settingsInput)) {
      throw new AccountError(key, 'settings must be an object');
    }
    let settings;
    try {
      settings = portal.validateSettings(settingsInput, credentials);
    } catch (error) {
      throw new AccountError(key, `settings: ${error.message}`);
    }

    return Object.freeze({
      key,
      portal: entry.portal,
      origin: base.origin,
      credentials,
      limits: loadLimits(key, entry.limits),
      settings: Object.freeze(settings),
      proxy: loadProxy(key, entry.proxy, env),
    });
  });

  return Object.freeze(accounts);
}
