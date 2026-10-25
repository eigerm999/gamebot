import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function required(name) {
  const value = (process.env[name] ?? '').trim();
  if (value === '') {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}

export function optional(name, fallback) {
  const value = (process.env[name] ?? '').trim();
  return value === '' ? fallback : value;
}

export function positiveInt(name, fallback) {
  const value = Number(optional(name, String(fallback)));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/** Optional proxy for one provider's browser, e.g. a static Webshare IP. */
export function proxyFromEnv(prefix) {
  const server = optional(`${prefix}_PROXY_SERVER`, '');
  if (server === '') {
    return null;
  }
  return {
    server,
    username: optional(`${prefix}_PROXY_USERNAME`, undefined),
    password: optional(`${prefix}_PROXY_PASSWORD`, undefined),
  };
}

function loadConfig() {
  const secret = required('WORKER_SECRET');
  if (secret.length < 32) {
    throw new Error('WORKER_SECRET must be at least 32 characters');
  }

  const providers = optional('PROVIDERS', 'yes918')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);

  return Object.freeze({
    host: '127.0.0.1', // loopback only; expose remotely through an HTTPS reverse proxy
    port: positiveInt('WORKER_PORT', 8918),
    secret,
    providers,

    headless: optional('HEADLESS', 'false').toLowerCase() === 'true',
    profileRoot: path.resolve(ROOT, optional('PROFILE_ROOT', 'runtime/profiles')),

    navTimeoutMs: positiveInt('NAV_TIMEOUT_MS', 60000),
    fetchTimeoutMs: positiveInt('FETCH_TIMEOUT_MS', 15000),
    submitTimeoutMs: positiveInt('SUBMIT_TIMEOUT_MS', 30000),
    submitDeadlineMs: positiveInt('SUBMIT_DEADLINE_MS', 35000),
    maxWaiting: positiveInt('MAX_WAITING', 3),
  });
}

export const config = loadConfig();
