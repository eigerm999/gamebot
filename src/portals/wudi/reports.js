import { failed } from '../../core/errors.js';
import { cleanPortalNumber, fromCents, portalToCents } from '../../core/money.js';
import { readWudiJson } from './request.js';
import { findPlayer } from './players.js';

const PAGE_SIZE = 50;
const DIRECT_CREDIT = '1';
const DIRECT_DEBIT = '2';

function pages(total) {
  return Math.max(1, Math.ceil(Number(total || 0) / PAGE_SIZE));
}

/** Exported for tests. Wudi exposes net win/loss in changeAmount. */
export function mapGameLogRow(row) {
  const money = (value) => (cleanPortalNumber(value) === null ? null : fromCents(portalToCents(String(value))));
  return {
    type: 'game',
    game: String(row.game || row.pfCode || '') || null,
    log: null,
    amount: null,
    bet: money(row.wagerMoney),
    // Wudi has no gross payout field; the Maxis "Win" column shows net win/loss.
    win: money(row.changeAmount),
    beginBalance: money(row.beforeMoney),
    endBalance: money(row.afterMoney),
    time: String(row.changeTime ?? ''),
  };
}

/** Exported for tests. Only direct player credit/debit rows are comparable. */
export function mapScoreLogRow(row) {
  const type = String(row.type);
  if (
    ![DIRECT_CREDIT, DIRECT_DEBIT].includes(type) ||
    cleanPortalNumber(row.changeAmount) === null ||
    cleanPortalNumber(row.afterMoney) === null ||
    typeof row.createTime !== 'string' ||
    !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,3})?$/.test(row.createTime)
  ) {
    return null;
  }
  const cents = Math.abs(portalToCents(String(row.changeAmount)));
  return {
    time: String(row.createTime ?? ''),
    amount: fromCents(type === DIRECT_DEBIT ? -cents : cents),
    balanceAfter: fromCents(portalToCents(String(row.afterMoney))),
    reference: String(row.bwOrderNumber ?? ''),
  };
}

export function reportOperations(site) {
  return {
    async agentBalance({ session, ctx }) {
      const json = await readWudiJson(session, { path: '/user/front/sysLoginUserWallet' }, { code: 'balance', config: ctx.config });
      if (!json.data || cleanPortalNumber(json.data.goldMoney) === null) {
        throw failed('balance_malformed', 'Wudi agent wallet response was invalid');
      }
      return { agent: site.credentials.username, balance: fromCents(portalToCents(String(json.data.goldMoney))) };
    },

    async gameLog({ session, params, ctx }) {
      const player = await findPlayer(session, params.playerId, ctx.config);
      const json = await readWudiJson(
        session,
        {
          path: '/user/front/gainLossDetail',
          params: {
            pageNum: params.page,
            pageSize: PAGE_SIZE,
            sysUserId: player.sysUserId,
            memberName: params.playerId,
            startTime: `${params.date} 00:00:00`,
            endTime: `${params.date} 23:59:59`,
          },
        },
        { code: 'gamelog', config: ctx.config }
      );
      const rows = Array.isArray(json.rows) ? json.rows.map(mapGameLogRow) : [];
      if (rows.some((row) => !row.time || row.bet === null || row.win === null || row.beginBalance === null || row.endBalance === null)) {
        throw failed('gamelog_malformed', 'Wudi game log response contained an invalid row');
      }
      return { playerId: params.playerId, date: params.date, page: params.page, totalPages: pages(json.total), rows };
    },

    async scoreLog({ session, params, ctx }) {
      const player = await findPlayer(session, params.playerId, ctx.config);
      const json = await readWudiJson(
        session,
        {
          path: '/user/balance_changes/list',
          params: {
            pageNum: params.page,
            pageSize: PAGE_SIZE,
            userId: player.userId,
            userName: params.playerId,
            startTime: `${params.from} 00:00:00`,
            endTime: `${params.to} 23:59:59`,
          },
        },
        { code: 'scorelog', config: ctx.config }
      );
      const sourceRows = Array.isArray(json.rows) ? json.rows : [];
      const directRows = sourceRows.filter((row) => [DIRECT_CREDIT, DIRECT_DEBIT].includes(String(row.type)));
      const rows = directRows.map(mapScoreLogRow);
      if (rows.includes(null)) {
        throw failed('scorelog_malformed', 'Wudi score log response contained an invalid direct transaction');
      }
      return { playerId: params.playerId, from: params.from, to: params.to, page: params.page, totalPages: pages(json.total), rows };
    },
  };
}
