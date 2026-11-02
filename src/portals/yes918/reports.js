import { failed } from '../../core/errors.js';
import { PORTAL_NUMBER, cleanPortalNumber } from '../../core/money.js';
import { readPage } from '../../core/portal-http.js';
import { GAME, isLoginPage } from './common.js';

/*
 * Read-only report pages. They are server-rendered HTML, parsed with the
 * browser's DOMParser (session.parseHtml) so page scripts never run.
 *
 * The extract* functions run inside the browser and must be self-contained:
 * no imports, no closures over this module.
 */

/** Rows of the first table whose header row contains `marker`, plus the page count. */
export function extractLogTable(doc, { marker, columns }) {
  const clean = (node) => (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const table = [...doc.querySelectorAll('table')].find((t) => clean(t.querySelector('tr')).includes(marker));
  const rows = [];
  if (table) {
    for (const tr of table.querySelectorAll('tr')) {
      const cells = [...tr.querySelectorAll('td')].map(clean);
      if (cells.length === columns) {
        rows.push(cells);
      }
    }
  }
  let totalPages = 1;
  for (const a of doc.querySelectorAll('.pagination a')) {
    const fromText = /^\d+$/.test(clean(a)) ? Number(clean(a)) : 0;
    const fromHref = Number((a.getAttribute('href') ?? '').match(/[?&]page=(\d+)/)?.[1] ?? 0);
    totalPages = Math.max(totalPages, fromText, fromHref);
  }
  return { found: Boolean(table), rows, totalPages, portalError: /Error Getting Gamelog/i.test(clean(doc.body)) };
}

/** "Balance: 158146.9" in the navigation bar of every logged-in page. */
export function extractAgentBalance(doc) {
  for (const node of doc.querySelectorAll('nav p, nav span, nav a, p')) {
    const match = (node.textContent ?? '').replace(/\s+/g, ' ').match(/Balance:\s*(-?[\d,]+(?:\.\d+)?)/);
    if (match) {
      return match[1].replace(/,/g, '');
    }
  }
  return null;
}

/** One game-log row -> API shape. Exported for tests. */
export function gameLogRow([game, log, bet, win, beginBalance, endBalance, time]) {
  const setScore = log.match(/^\[set score\]:\s*(-?[\d.]+)@/i);
  return {
    type: setScore ? 'setScore' : 'game',
    game: game || null,
    log: log || null,
    amount: setScore ? cleanPortalNumber(setScore[1]) : null,
    bet: cleanPortalNumber(bet),
    win: cleanPortalNumber(win),
    beginBalance: cleanPortalNumber(beginBalance),
    endBalance: cleanPortalNumber(endBalance),
    time,
  };
}

/** One score-log row -> API shape, or null when the row is not what we expect. Exported for tests. */
export function scoreLogRow([, time, amount, after]) {
  if (cleanPortalNumber(amount) === null || cleanPortalNumber(after) === null || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(time)) {
    return null;
  }
  return { time, amount: cleanPortalNumber(amount), balanceAfter: cleanPortalNumber(after) };
}

export function reportOperations(site) {
  const page = (session, path, config, code) => readPage(session, path, { config, code, isLoginPage });
  const query = (params) => new URLSearchParams({ username: site.agentUsername, ...params, game: GAME }).toString();
  const id = (playerId) => encodeURIComponent(playerId);

  return {
    async agentBalance({ session, ctx }) {
      const html = await page(session, '/operationhistory', ctx.config, 'balance');
      const balance = await session.parseHtml(html, extractAgentBalance);
      if (balance === null || !PORTAL_NUMBER.test(balance)) {
        throw failed('balance_unparsed', 'Agent balance was not found on the portal page');
      }
      return { agent: site.agentUsername, balance };
    },

    /** One day of game rounds and set-score entries, newest first, one portal page at a time. */
    async gameLog({ session, params, ctx }) {
      const path =
        `/playerlist/${id(params.playerId)}/gamelog?` +
        query({ datestart: params.date, dateend: params.date, page: String(params.page), timestart: '00:00:00', timeend: '23:59:59' });
      const html = await page(session, path, ctx.config, 'gamelog');
      const table = await session.parseHtml(html, extractLogTable, { marker: 'Begin Balance', columns: 7 });
      if (table.portalError) {
        throw failed('gamelog_unavailable', 'Portal could not load the game log for this date');
      }
      if (!table.found) {
        throw failed('gamelog_unparsed', 'Game log table was not found on the portal page');
      }
      return { playerId: params.playerId, date: params.date, page: params.page, totalPages: table.totalPages, rows: table.rows.map(gameLogRow) };
    },

    /** Deposits and withdrawals the portal recorded, newest first, 50 per page. */
    async scoreLog({ session, params, ctx }) {
      const path =
        `/playerlist/${id(params.playerId)}/scorelog?` +
        query({ datestart: params.from, dateend: params.to, page: String(params.page), timestart: '00:00:00', timeend: '23:59:59' });
      const html = await page(session, path, ctx.config, 'scorelog');
      const table = await session.parseHtml(html, extractLogTable, { marker: 'After Score', columns: 4 });
      if (!table.found) {
        throw failed('scorelog_unparsed', 'Score log table was not found on the portal page');
      }
      const rows = table.rows.map(scoreLogRow);
      if (rows.includes(null)) {
        throw failed('scorelog_unparsed', 'Unexpected score log row');
      }
      return { playerId: params.playerId, from: params.from, to: params.to, page: params.page, totalPages: table.totalPages, rows };
    },
  };
}
