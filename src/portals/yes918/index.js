import { createLogin } from './login.js';
import { playerOperations } from './players.js';
import { reportOperations } from './reports.js';
import { scoreOperations } from './score.js';

/**
 * yes918 agent portal (918 game).
 *
 * Changes (JSON endpoints): createPlayer, setScore, resetPassword, disablePlayer, kickPlayer.
 * Reads: playerInfo (JSON); agentBalance, gameLog, scoreLog (server-rendered pages).
 */

export const credentials = Object.freeze({
  required: ['username', 'password'],
  // Second-step password; defaults to `password` when the portal reuses it.
  optional: ['password2'],
});

const SETTINGS = ['homePath', 'agentUsername', 'playerName', 'playerRemark'];

/** Throws Error(message) on a bad value; returns normalized settings. */
export function validateSettings(settings, creds) {
  for (const key of Object.keys(settings)) {
    if (!SETTINGS.includes(key)) {
      throw new Error(`unknown setting "${key}" (allowed: ${SETTINGS.join(', ')})`);
    }
    if (typeof settings[key] !== 'string') {
      throw new Error(`${key} must be a string`);
    }
  }
  const homePath = settings.homePath ?? '/search';
  if (!homePath.startsWith('/')) {
    throw new Error('homePath must start with "/"');
  }
  return {
    homePath,
    // Agent that owns new players. Defaults to the login username.
    agentUsername: settings.agentUsername || creds.username,
    playerName: settings.playerName ?? '',
    playerRemark: settings.playerRemark ?? '',
  };
}

export function createPortal(account) {
  const site = Object.freeze({ origin: account.origin, credentials: account.credentials, ...account.settings });
  const players = playerOperations(site);
  const { fetchPlayer, ...playerOps } = players;

  return {
    ensureLoggedIn: createLogin(site).ensureLoggedIn,
    operations: Object.freeze({
      ...playerOps,
      ...scoreOperations(site, fetchPlayer),
      ...reportOperations(site),
    }),
  };
}
