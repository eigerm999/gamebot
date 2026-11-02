import { failed, isZero, nonEmpty, redact, unknown } from '../../core/errors.js';
import { PORTAL_NUMBER, shortAmount } from '../../core/money.js';
import { readJson } from '../../core/portal-http.js';
import { submitOnce } from '../../core/submit.js';
import { GAME, classifyErrorField, generatePlayerPassword } from './common.js';

/** Player account operations: JSON endpoints on /playerlist. */
export function playerOperations(site) {
  const agent = site.agentUsername;
  const id = (playerId) => encodeURIComponent(playerId);

  /** Read-only balance and status lookup. Also used before set score. */
  async function fetchPlayer(session, playerId, config) {
    const path = `/playerlist/${id(playerId)}/balance?username=${encodeURIComponent(agent)}&game=${GAME}`;
    const { json, response } = await readJson(session, path, { config, code: 'info' });
    if (!response.ok || !isZero(json.error) || !PORTAL_NUMBER.test(String(json.score ?? '').trim())) {
      throw failed('info_rejected', redact(json.message ?? json.msg ?? 'Player info was rejected'));
    }
    return {
      playerId,
      score: String(json.score).trim(),
      enabled: String(json.status ?? '').toLowerCase() === 'enable',
      status: redact(json.status ?? ''),
    };
  }

  /** Pre-submission and side-effect free. */
  async function randomPlayerId(session, config) {
    const { json, response } = await readJson(session, `/playerlist/random?game=${GAME}`, { config, code: 'random' });
    if (!response.ok || !isZero(json.error) || !nonEmpty(json.playerid)) {
      throw failed('random_rejected', redact(json.msg ?? json.message ?? 'Random player ID was rejected'));
    }
    return String(json.playerid).trim();
  }

  return {
    fetchPlayer,

    async createPlayer({ session, params, ctx }) {
      const playerId = await randomPlayerId(session, ctx.config);
      const password = generatePlayerPassword();

      const json = await submitOnce(session, ctx, {
        path: `/playerlist/createnew?game=${GAME}`,
        code: 'create',
        form: {
          player_username: playerId,
          player_password: password,
          player_name: site.playerName,
          player_remark: site.playerRemark,
          player_score: shortAmount(params.amount),
          agent_username: agent,
        },
        classify(json, response) {
          if (response.ok && isZero(json.error) && isZero(json.code) && json.success === true && nonEmpty(json.playerid)) {
            return { ok: json };
          }
          // Explicit rejection only when the portal did not also claim success.
          const rejected = json.success !== true && ((nonEmpty(json.error) && !isZero(json.error)) || (nonEmpty(json.code) && !isZero(json.code)));
          return rejected ? { rejected: String(json.msg ?? json.message ?? 'Portal rejected the create request') } : null;
        },
      });

      if (String(json.playerid).trim() !== playerId) {
        throw unknown('create_mismatch', 'Returned player ID does not match the requested ID');
      }
      if (json.passWd !== undefined && String(json.passWd) !== password) {
        throw unknown('create_mismatch', 'Returned password does not match the submitted password');
      }
      return { playerId, password, score: params.amount };
    },

    playerInfo: ({ session, params, ctx }) => fetchPlayer(session, params.playerId, ctx.config),

    async resetPassword({ session, params, ctx }) {
      const password = generatePlayerPassword();
      await submitOnce(session, ctx, {
        path: `/playerlist/resetpassword?game=${GAME}`,
        code: 'reset',
        form: {
          player_resetpassword_username: params.playerId,
          player_resetpassword_password: password,
          player_resetpassword_agent_username: agent,
        },
        classify: classifyErrorField,
      });
      return { playerId: params.playerId, password };
    },

    /** The portal changes status with a GET. */
    async disablePlayer({ session, params, ctx }) {
      const action = params.enable ? 'enable' : 'disable';
      await submitOnce(session, ctx, {
        path: `/playerlist/${id(params.playerId)}/${action}?game=${GAME}`,
        method: 'GET',
        code: action,
        classify: classifyErrorField,
      });
      return { playerId: params.playerId, enabled: params.enable };
    },

    async kickPlayer({ session, params, ctx }) {
      await submitOnce(session, ctx, {
        path: `/playerlist/kick?game=${GAME}`,
        code: 'kick',
        form: { player_kick_username: params.playerId, player_kick_agent_username: agent },
        classify: classifyErrorField,
      });
      return { playerId: params.playerId };
    },
  };
}
