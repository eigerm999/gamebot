import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { BrowserSession } from '../src/core/session.js';
import { isLoginPage } from '../src/portals/yes918/common.js';
import { extractAgentBalance, extractLogTable, gameLogRow, scoreLogRow } from '../src/portals/yes918/reports.js';

/*
 * Synthetic pages with the same structure as the live yes918 pages
 * (captured read-only on 2026-10-31). No real players, passwords or tokens.
 */

const NAV = '<nav class="main-header navbar"><p class="border btn btn-primary text-s p-1 m-0"> Balance: 158,146.9 </p></nav>';

const GAMELOG = `<html><body>${NAV}<section class="content">
<table><tr><th>Game</th><th>Log</th><th>Bet</th><th>Win</th><th>Begin Balance</th><th>End Balance</th><th>Date</th></tr>
<tr><th>No</th><th>Date</th><th>Log Data</th><th>Game</th><th>Bet</th><th>Win</th><th>Begin Balance</th><th>End Balance</th></tr>
<tr><td></td><td>[set score]: -100.0@p1_1793459877446</td><td>-</td><td>-</td><td>100.1</td><td>0.1</td><td>2026-10-31 23:17:57</td></tr>
<tr><td>OceanKing</td><td></td><td>27.4</td><td>37.6</td><td>118</td><td>128.2</td><td>2026-10-31 23:09:01</td></tr>
<tr><td>HighWay</td><td></td><td>0.05</td><td>0</td><td>0.05</td><td>-0</td><td>2026-10-31 23:04:40</td></tr>
</table>
<div class="pagination"><a href="/playerlist/p1/gamelog?page=1">««</a><a href="#" class="active">1</a><a href="/playerlist/p1/gamelog?page=1">»»</a></div>
<script>window.__ran = true;</script>
</section></body></html>`;

const SCORELOG = `<html><body>${NAV}<section class="content">
<table><tr><th>No</th><th>Date</th><th>Set Score</th><th>After Score</th></tr>
<tr><td>1.</td><td>2026-10-31 23:17:57.447</td><td>-100</td><td>0.1</td></tr>
<tr><td>2.</td><td>2026-10-30 17:29:39.92</td><td>30</td><td>30.1</td></tr>
</table>
<table><tr><th>No</th><th>Report Date</th><th>Balance</th><th>Report Amount</th></tr></table>
<div class="pagination"><a href="?page=1">««</a><a href="#" class="active">1</a><a href="/playerlist/p1/scorelog?page=2" class="">2</a><a href="/playerlist/p1/scorelog?page=2">»»</a></div>
</section></body></html>`;

const GAMELOG_ERROR = `<html><body>${NAV}<section class="content"><p>Error Getting Gamelog. Please refresh the page again</p></section></body></html>`;

let browser;
let session;

before(async () => {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  // parseHtml only needs a page; reuse the real implementation.
  session = Object.assign(Object.create(BrowserSession.prototype), { page });
});

after(async () => {
  await browser?.close();
});

test('game log: rows, set-score entries and page count', async () => {
  const table = await session.parseHtml(GAMELOG, extractLogTable, { marker: 'Begin Balance', columns: 7 });
  assert.equal(table.found, true);
  assert.equal(table.portalError, false);
  assert.equal(table.totalPages, 1);
  const rows = table.rows.map(gameLogRow);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    type: 'setScore', game: null, log: '[set score]: -100.0@p1_1793459877446', amount: '-100.0',
    bet: null, win: null, beginBalance: '100.1', endBalance: '0.1', time: '2026-10-31 23:17:57',
  });
  assert.equal(rows[1].type, 'game');
  assert.equal(rows[1].game, 'OceanKing');
  assert.equal(rows[2].endBalance, '0'); // "-0" from the portal
});

test('game log: the portal error page is detected', async () => {
  const table = await session.parseHtml(GAMELOG_ERROR, extractLogTable, { marker: 'Begin Balance', columns: 7 });
  assert.equal(table.portalError, true);
  assert.equal(table.found, false);
});

test('score log: picks the right table and reads the page count from links', async () => {
  const table = await session.parseHtml(SCORELOG, extractLogTable, { marker: 'After Score', columns: 4 });
  assert.equal(table.totalPages, 2);
  assert.deepEqual(table.rows.map(scoreLogRow), [
    { time: '2026-10-31 23:17:57.447', amount: '-100', balanceAfter: '0.1' },
    { time: '2026-10-30 17:29:39.92', amount: '30', balanceAfter: '30.1' },
  ]);
  assert.equal(scoreLogRow(['1.', 'yesterday', '30', '30']), null);
});

test('agent balance from the navigation bar', async () => {
  assert.equal(await session.parseHtml(GAMELOG, extractAgentBalance), '158146.9');
  assert.equal(await session.parseHtml('<html><body><p>nothing</p></body></html>', extractAgentBalance), null);
});

test('parsed pages are inert: their scripts never run', async () => {
  await session.parseHtml(GAMELOG, extractLogTable, { marker: 'Begin Balance', columns: 7 });
  assert.equal(await session.page.evaluate(() => window.__ran === true), false);
});

test('login page detection', () => {
  assert.equal(isLoginPage({ finalPath: '/login', text: '' }), true);
  assert.equal(isLoginPage({ finalPath: '/', text: '<input type="password" name="password2"/>' }), true);
  assert.equal(isLoginPage({ finalPath: '/', text: '<input name="password" type="password">' }), true);
  // Report pages contain other password fields (player modals) and must not match.
  assert.equal(isLoginPage({ finalPath: '/search', text: '<input name="player_password"><input name="player_resetpassword_password">' }), false);
});
