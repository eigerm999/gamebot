import assert from 'node:assert/strict';
import test from 'node:test';
import { OPERATIONS } from '../src/core/operations.js';

const limits = { maxInitialScoreCents: 5000, maxSetScoreCents: 100000 };
const check = (operation, params) => OPERATIONS[operation].validate(params, limits);

test('createPlayer: amount within the initial limit', () => {
  assert.equal(check('createPlayer', { amount: '0' }), null);
  assert.equal(check('createPlayer', { amount: '50.00' }), null);
  assert.equal(check('createPlayer', { amount: '50.01' }), 'invalid_amount');
  assert.equal(check('createPlayer', { amount: '-1' }), 'invalid_amount');
  assert.equal(check('createPlayer', { amount: 10 }), 'invalid_amount');
  assert.equal(check('createPlayer', {}), 'invalid_params');
  assert.equal(check('createPlayer', { amount: '1', extra: 1 }), 'invalid_params');
});

test('createPlayer and resetPassword accept an optional fixed password', () => {
  assert.equal(check('createPlayer', { amount: '0', password: 'Aa1111' }), null);
  assert.equal(check('resetPassword', { playerId: 'abc123' }), null);
  assert.equal(check('resetPassword', { playerId: 'abc123', password: 'Aa1111' }), null);
  for (const bad of ['', '111111', 'aaaaaa', 'Aa11', 'Aa1111111111x', 'Aa11 11', 'Aa1111;', 1111]) {
    assert.equal(check('createPlayer', { amount: '0', password: bad }), 'invalid_password', String(bad));
    assert.equal(check('resetPassword', { playerId: 'abc123', password: bad }), 'invalid_password', String(bad));
  }
  assert.equal(check('resetPassword', { playerId: 'abc123', password: 'Aa1111', extra: 1 }), 'invalid_params');
});

test('setScore: signed, non-zero, within the set-score limit', () => {
  assert.equal(check('setScore', { playerId: 'abc123', amount: '10.00' }), null);
  assert.equal(check('setScore', { playerId: 'abc123', amount: '-10.50' }), null);
  assert.equal(check('setScore', { playerId: 'abc123', amount: '-1000.00' }), null);
  assert.equal(check('setScore', { playerId: 'abc123', amount: '1000.01' }), 'invalid_amount');
  assert.equal(check('setScore', { playerId: 'abc123', amount: '0.00' }), 'invalid_amount');
  assert.equal(check('setScore', { playerId: 'abc123', amount: '1e3' }), 'invalid_amount');
  assert.equal(check('setScore', { playerId: 'abc123', amount: '1.234' }), 'invalid_amount');
  assert.equal(check('setScore', { playerId: 'abc123' }), 'invalid_params');
});

test('unlimited limits still reject zero and malformed amounts', () => {
  const unlimited = { maxInitialScoreCents: Infinity, maxSetScoreCents: Infinity };
  assert.equal(OPERATIONS.createPlayer.validate({ amount: '999999999.99' }, unlimited), null);
  assert.equal(OPERATIONS.setScore.validate({ playerId: 'p1', amount: '-250000' }, unlimited), null);
  assert.equal(OPERATIONS.setScore.validate({ playerId: 'p1', amount: '0' }, unlimited), 'invalid_amount');
  assert.equal(OPERATIONS.setScore.validate({ playerId: 'p1', amount: '1e9' }, unlimited), 'invalid_amount');
  assert.equal(OPERATIONS.setScore.validate({ playerId: 'p1', amount: '1234567890' }, unlimited), 'invalid_amount'); // over 9 digits
});

test('player IDs are strict because they go into URL paths', () => {
  for (const playerId of ['../x', 'a/b', 'a b', '', 'x'.repeat(51), 42]) {
    assert.equal(check('playerInfo', { playerId }), 'invalid_player_id', String(playerId));
  }
  assert.equal(check('playerInfo', { playerId: 'Ab_09' }), null);
});

test('disablePlayer needs a boolean enable', () => {
  assert.equal(check('disablePlayer', { playerId: 'p1', enable: false }), null);
  assert.equal(check('disablePlayer', { playerId: 'p1', enable: 'true' }), 'invalid_params');
});

test('agentBalance takes no params', () => {
  assert.equal(check('agentBalance', {}), null);
  assert.equal(check('agentBalance', { x: 1 }), 'invalid_params');
});

test('gameLog: real date and page', () => {
  assert.equal(check('gameLog', { playerId: 'p1', date: '2026-10-31', page: 1 }), null);
  assert.equal(check('gameLog', { playerId: 'p1', date: '2026-02-30', page: 1 }), 'invalid_date');
  assert.equal(check('gameLog', { playerId: 'p1', date: '2026-10-31', page: 0 }), 'invalid_page');
  assert.equal(check('gameLog', { playerId: 'p1', date: '2026-10-31', page: '1' }), 'invalid_page');
});

test('scoreLog: ordered range of at most 31 days', () => {
  assert.equal(check('scoreLog', { playerId: 'p1', from: '2026-10-01', to: '2026-10-31', page: 1 }), null);
  assert.equal(check('scoreLog', { playerId: 'p1', from: '2026-10-01', to: '2026-11-02', page: 1 }), 'invalid_date_range');
  assert.equal(check('scoreLog', { playerId: 'p1', from: '2026-10-31', to: '2026-10-01', page: 1 }), 'invalid_date_range');
});

test('changes are flagged so callers know which operations move state', () => {
  const changing = Object.entries(OPERATIONS).filter(([, op]) => op.changes).map(([name]) => name).sort();
  assert.deepEqual(changing, ['createPlayer', 'disablePlayer', 'kickPlayer', 'resetPassword', 'setScore']);
});
