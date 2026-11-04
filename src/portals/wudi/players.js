import { randomInt } from 'node:crypto';
import { failed, redact, unknown } from '../../core/errors.js';
import { PORTAL_NUMBER, fromCents, portalToCents } from '../../core/money.js';
import { submitOnce } from '../../core/submit.js';
import { classifyWudi, readWudiJson, wudiRequest } from './request.js';

const ENABLED = '0';
const DISABLED = '1';
const MAX_ID_ATTEMPTS = 5;
const PASSWORD_PREFIXES = ['Aaa', 'Bbb', 'Ccc', 'Ddd', 'Edd', 'Fff', 'Ggg'];

export function generateUsername(prefix) {
  let digits = '';
  for (let i = 0; i < 10; i++) digits += String(randomInt(0, 10));
  return prefix + digits;
}

export function generatePassword() {
  return PASSWORD_PREFIXES[randomInt(0, PASSWORD_PREFIXES.length)] + String(randomInt(100, 999));
}

function integer(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** Exact user-name search. Returns null when optional, otherwise player_not_found. */
export async function findPlayer(session, username, config, { required = true } = {}) {
  const json = await readWudiJson(
    session,
    { path: '/user/front/list', params: { pageNum: 1, pageSize: 10, userName: username } },
    { code: 'player', config }
  );
  const matches = (Array.isArray(json.rows) ? json.rows : []).filter((row) => String(row.userName) === username);
  if (matches.length === 0) {
    if (!required) return null;
    throw failed('player_not_found', 'Wudi player was not found');
  }
  if (matches.length !== 1) {
    throw failed('player_ambiguous', 'Wudi returned more than one exact player');
  }
  const row = matches[0];
  if (integer(row.userId) === null) {
    throw failed('player_malformed', 'Wudi player ID was invalid');
  }
  return row;
}

export function playerOperations(site) {
  async function fetchPlayer(session, username, config) {
    const player = await findPlayer(session, username, config);
    const json = await readWudiJson(
      session,
      { path: '/user/front/getUserWalletByUserId', params: { userId: player.userId } },
      { code: 'info', config }
    );
    const wallet = json.data;
    if (!wallet || integer(wallet.id) === null || integer(wallet.userId) !== Number(player.userId) || !PORTAL_NUMBER.test(String(wallet.goldMoney ?? ''))) {
      throw failed('info_malformed', 'Wudi player wallet response was invalid');
    }
    return {
      playerId: username,
      score: fromCents(portalToCents(String(wallet.goldMoney))),
      enabled: String(player.status) === ENABLED,
      status: String(player.status) === ENABLED ? 'Enable' : 'Disable',
      // Internal fields are consumed by this plugin only and never returned by public operations.
      _userId: Number(player.userId),
      _sysUserId: integer(player.sysUserId),
      _walletId: Number(wallet.id),
    };
  }

  const send = (session, request) => wudiRequest(session, { ...request, encrypt: true });

  return {
    fetchPlayer,

    async createPlayer({ session, params, ctx }) {
      // Shared validation enforces this account's maxInitialScore=0.
      let username = null;
      for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++) {
        const candidate = generateUsername(site.playerPrefix);
        if (!(await findPlayer(session, candidate, ctx.config, { required: false }))) {
          username = candidate;
          break;
        }
      }
      if (!username) {
        throw failed('player_id_collision', 'Could not generate an unused Wudi player ID', { retryable: true });
      }
      const password = generatePassword();
      await ctx.recordCreateIdentity(username);

      await submitOnce(session, ctx, {
        path: '/user/front',
        method: 'POST',
        code: 'create',
        form: null,
        send: ({ timeoutMs }) =>
          send(session, {
            path: '/user/front',
            method: 'POST',
            timeoutMs,
            data: {
              userId: null,
              userName: username,
              nickName: username,
              userType: null,
              email: null,
              phonenumber: null,
              sex: null,
              avatar: null,
              birthdayDate: null,
              realName: null,
              password,
              status: null,
              remark: site.playerRemark || null,
              sysUserId: null,
            },
          }),
        classify: (json, response) => classifyWudi(json, response, session),
      });

      // Any verification error is after a confirmed mutation and therefore can
      // never be reported as a safe-to-retry failure.
      let created;
      try {
        created = await findPlayer(session, username, ctx.config, { required: false });
      } catch {
        throw unknown('create_verify_failed', 'Wudi created the player but verification failed');
      }
      if (!created) {
        throw unknown('create_unconfirmed', 'Wudi confirmed create but the player was not found');
      }
      return { playerId: username, password, score: params.amount };
    },

    async playerInfo({ session, params, ctx }) {
      const { _userId, _sysUserId, _walletId, ...result } = await fetchPlayer(session, params.playerId, ctx.config);
      return result;
    },

    async resetPassword({ session, params, ctx }) {
      const player = await findPlayer(session, params.playerId, ctx.config);
      const password = generatePassword();
      await submitOnce(session, ctx, {
        path: '/user/front/resetPwd',
        method: 'PUT',
        code: 'reset',
        send: ({ timeoutMs }) =>
          send(session, { path: '/user/front/resetPwd', method: 'PUT', timeoutMs, data: { userId: player.userId, password } }),
        classify: (json, response) => classifyWudi(json, response, session),
      });
      return { playerId: params.playerId, password };
    },

    async disablePlayer({ session, params, ctx }) {
      const player = await findPlayer(session, params.playerId, ctx.config);
      const desired = params.enable ? ENABLED : DISABLED;
      if (String(player.status) === desired) {
        return { playerId: params.playerId, enabled: params.enable };
      }
      await submitOnce(session, ctx, {
        path: '/user/front/updateUserStatus',
        method: 'PUT',
        code: params.enable ? 'enable' : 'disable',
        send: ({ timeoutMs }) =>
          send(session, { path: '/user/front/updateUserStatus', method: 'PUT', timeoutMs, data: { userId: player.userId, status: desired } }),
        classify: (json, response) => classifyWudi(json, response, session),
      });
      let changed;
      try {
        changed = await findPlayer(session, params.playerId, ctx.config);
      } catch {
        throw unknown('status_verify_failed', 'Wudi changed the status but verification failed');
      }
      if (String(changed.status) !== desired) {
        throw unknown('status_mismatch', 'Wudi confirmed status change but the player status did not match');
      }
      return { playerId: params.playerId, enabled: params.enable };
    },

    async kickPlayer({ session, params, ctx }) {
      const player = await findPlayer(session, params.playerId, ctx.config);
      await submitOnce(session, ctx, {
        path: '/user/front/logoutUser',
        method: 'POST',
        code: 'kick',
        send: ({ timeoutMs }) => send(session, { path: '/user/front/logoutUser', method: 'POST', timeoutMs, data: { userId: player.userId } }),
        classify: (json, response) => classifyWudi(json, response, session),
      });
      return { playerId: params.playerId };
    },
  };
}
