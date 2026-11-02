import { AMOUNT, SIGNED_AMOUNT, toCents } from './money.js';

/**
 * The operation contract shared by every portal. Params are validated here,
 * not in portal code, so the caller sends the same params to every portal and
 * a portal cannot accept looser input than another.
 *
 * validate(params, limits) returns an error code, or null when acceptable.
 * limits are the account's { maxInitialScoreCents, maxSetScoreCents }.
 */

// Interpolated into portal URL paths, so keep it strict.
export const PLAYER_ID = /^[A-Za-z0-9_]{1,50}$/;
export const MAX_PAGE = 500;
export const MAX_SCORELOG_DAYS = 31;

export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const validPage = (value) => Number.isInteger(value) && value >= 1 && value <= MAX_PAGE;

/** Exactly these keys: rejects unknown fields so typos never pass silently. */
function exactKeys(params, keys) {
  const actual = Object.keys(params);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function checkPlayer(params, keys) {
  if (!exactKeys(params, ['playerId', ...keys])) {
    return 'invalid_params';
  }
  return typeof params.playerId === 'string' && PLAYER_ID.test(params.playerId) ? null : 'invalid_player_id';
}

export const OPERATIONS = Object.freeze({
  createPlayer: {
    changes: true,
    validate(params, limits) {
      if (!exactKeys(params, ['amount'])) {
        return 'invalid_params';
      }
      if (typeof params.amount !== 'string' || !AMOUNT.test(params.amount) || toCents(params.amount) > limits.maxInitialScoreCents) {
        return 'invalid_amount';
      }
      return null;
    },
  },

  setScore: {
    changes: true,
    validate(params, limits) {
      const invalid = checkPlayer(params, ['amount']);
      if (invalid) {
        return invalid;
      }
      if (typeof params.amount !== 'string' || !SIGNED_AMOUNT.test(params.amount)) {
        return 'invalid_amount';
      }
      const cents = toCents(params.amount);
      return cents === 0 || Math.abs(cents) > limits.maxSetScoreCents ? 'invalid_amount' : null;
    },
  },

  resetPassword: { changes: true, validate: (params) => checkPlayer(params, []) },

  disablePlayer: {
    changes: true,
    validate(params) {
      return checkPlayer(params, ['enable']) ?? (typeof params.enable === 'boolean' ? null : 'invalid_params');
    },
  },

  kickPlayer: { changes: true, validate: (params) => checkPlayer(params, []) },

  playerInfo: { changes: false, validate: (params) => checkPlayer(params, []) },

  agentBalance: { changes: false, validate: (params) => (exactKeys(params, []) ? null : 'invalid_params') },

  gameLog: {
    changes: false,
    validate(params) {
      const invalid = checkPlayer(params, ['date', 'page']);
      if (invalid) {
        return invalid;
      }
      if (!validDate(params.date)) {
        return 'invalid_date';
      }
      return validPage(params.page) ? null : 'invalid_page';
    },
  },

  scoreLog: {
    changes: false,
    validate(params) {
      const invalid = checkPlayer(params, ['from', 'to', 'page']);
      if (invalid) {
        return invalid;
      }
      if (!validDate(params.from) || !validDate(params.to)) {
        return 'invalid_date';
      }
      const days = (Date.parse(`${params.to}T00:00:00Z`) - Date.parse(`${params.from}T00:00:00Z`)) / 86400000;
      if (days < 0 || days > MAX_SCORELOG_DAYS) {
        return 'invalid_date_range';
      }
      return validPage(params.page) ? null : 'invalid_page';
    },
  },
});

export const OPERATION_NAMES = Object.freeze(Object.keys(OPERATIONS));
