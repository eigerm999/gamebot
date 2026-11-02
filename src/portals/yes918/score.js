import { failed } from '../../core/errors.js';
import { fromCents, shortAmount, toCents } from '../../core/money.js';
import { submitOnce } from '../../core/submit.js';
import { GAME, classifyErrorField } from './common.js';

/**
 * The portal's "New Score" is a change, not a target balance: +10 deposits,
 * -10 withdraws (confirmed against the portal's operation history).
 */
export function scoreOperations(site, fetchPlayer) {
  return {
    async setScore({ session, params, ctx }) {
      const change = toCents(params.amount);

      // Pre-submission checks, so a predictable rejection is a confirmed failure.
      const player = await fetchPlayer(session, params.playerId, ctx.config);
      if (!player.enabled) {
        throw failed('player_disabled', 'Player is disabled');
      }
      const before = toCents(player.score);
      if (change < 0 && before + change < 0) {
        throw failed('insufficient_balance', `Player balance ${player.score} is below the withdrawal amount`);
      }

      await submitOnce(session, ctx, {
        path: `/playerlist/setscore?game=${GAME}`,
        code: 'setscore',
        form: {
          player_setscore_username: params.playerId,
          player_setscore_newscore: shortAmount(params.amount),
        },
        classify: classifyErrorField,
      });

      // No read-back after submission: it would add time past the caller's deadline.
      // balanceAfter is the expected value; the player may be playing at the same time.
      return {
        playerId: params.playerId,
        amount: params.amount,
        balanceBefore: fromCents(before),
        balanceAfter: fromCents(before + change),
      };
    },
  };
}
