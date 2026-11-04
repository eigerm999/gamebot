import { failed, unknown } from '../../core/errors.js';
import { fromCents, toCents } from '../../core/money.js';
import { submitOnce } from '../../core/submit.js';
import { classifyWudi, wudiRequest } from './request.js';

/** Wudi player wallet deposit (positive) and withdrawal (negative). */
export function scoreOperations(site, fetchPlayer) {
  return {
    async setScore({ session, params, ctx }) {
      const player = await fetchPlayer(session, params.playerId, ctx.config);
      if (!player.enabled) {
        throw failed('player_disabled', 'Wudi player is disabled');
      }

      const before = toCents(player.score);
      const change = toCents(params.amount);
      if (change < 0 && before + change < 0) {
        throw failed('insufficient_balance', `Player balance ${player.score} is below the withdrawal amount`);
      }

      await submitOnce(session, ctx, {
        path: '/user/front/balance',
        method: 'PUT',
        code: 'setscore',
        send: ({ timeoutMs }) =>
          wudiRequest(session, {
            path: '/user/front/balance',
            method: 'PUT',
            timeoutMs,
            encrypt: true,
            data: { userWalletId: player._walletId, balanceMoney: params.amount, remark: site.scoreRemark },
          }),
        classify: (json, response) => classifyWudi(json, response, session),
      });

      // The code-200 response confirms the change. Read the actual balance rather
      // than assuming it, because a player can be gaming at the same time.
      let after;
      try {
        after = await fetchPlayer(session, params.playerId, ctx.config);
      } catch {
        throw unknown('setscore_verify_failed', 'Wudi changed the balance but verification failed');
      }
      return {
        playerId: params.playerId,
        amount: params.amount,
        balanceBefore: fromCents(before),
        balanceAfter: fromCents(toCents(after.score)),
      };
    },
  };
}
