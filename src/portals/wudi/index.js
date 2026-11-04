import { createLogin } from './login.js';
import { playerOperations } from './players.js';
import { reportOperations } from './reports.js';
import { scoreOperations } from './score.js';

/** Wudi Vue/RuoYi agent portal. */
export const credentials = Object.freeze({ required: ['username', 'password'], optional: [] });

const SETTINGS = ['homePath', 'playerPrefix', 'playerRemark', 'scoreRemark'];

export function validateSettings(settings) {
  for (const key of Object.keys(settings)) {
    if (!SETTINGS.includes(key)) {
      throw new Error(`unknown setting "${key}" (allowed: ${SETTINGS.join(', ')})`);
    }
    if (typeof settings[key] !== 'string') {
      throw new Error(`${key} must be a string`);
    }
  }
  const homePath = settings.homePath || '/user/front';
  const playerPrefix = settings.playerPrefix || 'wd';
  if (!homePath.startsWith('/')) throw new Error('homePath must start with "/"');
  if (settings.playerPrefix !== undefined && settings.playerPrefix !== 'wd') throw new Error('playerPrefix must be exactly "wd"');
  return {
    homePath,
    playerPrefix,
    playerRemark: settings.playerRemark ?? '',
    scoreRemark: settings.scoreRemark || 'maxis6',
  };
}

export function createPortal(account) {
  const site = Object.freeze({ origin: account.origin, credentials: account.credentials, ...account.settings });
  const players = playerOperations(site);
  const { fetchPlayer, ...playerOps } = players;
  return {
    ensureLoggedIn: createLogin(site).ensureLoggedIn,
    operations: Object.freeze({ ...playerOps, ...scoreOperations(site, fetchPlayer), ...reportOperations(site) }),
  };
}
