import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Worker-wide settings from the environment. Portal logins live in
 * accounts.json (see src/accounts.js); their secrets stay in .env.
 */

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

export function nonNegativeInt(name, fallback) {
  const value = Number(optional(name, String(fallback)));
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be 0 or a positive integer`);
  }
  return value;
}

function loadConfig() {
  const secret = required('WORKER_SECRET');
  if (secret.length < 32) {
    throw new Error('WORKER_SECRET must be at least 32 characters');
  }

  return Object.freeze({
    host: '127.0.0.1', // loopback only; expose remotely through an HTTPS reverse proxy
    port: positiveInt('WORKER_PORT', 8918),
    secret,

    accountsFile: path.resolve(ROOT, optional('ACCOUNTS_FILE', 'accounts.json')),
    headless: optional('HEADLESS', 'false').toLowerCase() === 'true',
    profileRoot: path.resolve(ROOT, optional('PROFILE_ROOT', 'runtime/profiles')),
    identityRoot: path.resolve(ROOT, optional('IDENTITY_ROOT', 'runtime/create-identities')),

    navTimeoutMs: positiveInt('NAV_TIMEOUT_MS', 60000),
    fetchTimeoutMs: positiveInt('FETCH_TIMEOUT_MS', 15000),
    submitTimeoutMs: positiveInt('SUBMIT_TIMEOUT_MS', 30000),
    submitDeadlineMs: positiveInt('SUBMIT_DEADLINE_MS', 35000),
    maxWaiting: positiveInt('MAX_WAITING', 3),
    // Background login check per account, in minutes; 0 turns it off.
    sessionCheckMinutes: nonNegativeInt('SESSION_CHECK_MINUTES', 10),
  });
}

export const config = loadConfig();
