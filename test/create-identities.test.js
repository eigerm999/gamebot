import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CreateIdentities } from '../src/core/create-identities.js';
import { playerOperations } from '../src/portals/yes918/players.js';

const operationId = '12345678-1234-4123-8123-123456789abc';

test('create identity survives restart and cannot be overwritten', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'game-bot-identities-'));
  try {
    await new CreateIdentities(directory).record(operationId, 'yes918-0038', 'p1001');
    const restarted = new CreateIdentities(directory);
    assert.deepEqual(await restarted.read(operationId), { operationId, account: 'yes918-0038', playerId: 'p1001' });
    await assert.rejects(restarted.record(operationId, 'wudi-spadik', 'wd1111111111'), { code: 'EEXIST' });
    assert.equal((await restarted.read(operationId)).playerId, 'p1001');
    assert.equal(await restarted.read('12345678-1234-4123-8123-123456789abd'), null);
    assert.equal((await readFile(path.join(directory, operationId + '.json'), 'utf8')).includes('password'), false);
    await assert.rejects(restarted.read('../outside'), /Invalid operation ID/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('918 records generated identity before an uncertain submission', async () => {
  const events = [];
  const session = {
    async pageFetch(requestPath) {
      if (requestPath.startsWith('/playerlist/random')) {
        return { ok: true, status: 200, finalPath: '/playerlist/random', text: JSON.stringify({ error: 0, playerid: 'p1001' }) };
      }
      events.push('send');
      throw new Error('response lost');
    },
  };
  const ctx = {
    config: { fetchTimeoutMs: 1000, submitTimeoutMs: 1000 },
    async recordCreateIdentity(playerId) { events.push('record:' + playerId); },
    assertCanSubmit() { events.push('assert'); },
  };
  const op = playerOperations({ agentUsername: 'agent', playerName: '', playerRemark: '' });
  await assert.rejects(op.createPlayer({ session, params: { amount: '10.00' }, ctx }), (error) => error.outcome === 'unknown');
  assert.deepEqual(events, ['record:p1001', 'assert', 'send']);
});

test('918 never submits if durable identity storage fails', async () => {
  let submits = 0;
  const session = {
    async pageFetch() { return { ok: true, status: 200, finalPath: '/playerlist/random', text: '{"error":0,"playerid":"p1001"}' }; },
  };
  const ctx = {
    config: { fetchTimeoutMs: 1000 },
    async recordCreateIdentity() { throw new Error('disk unavailable'); },
    assertCanSubmit() { submits++; },
  };
  await assert.rejects(playerOperations({ agentUsername: 'agent' }).createPlayer({ session, params: { amount: '0' }, ctx }), /disk unavailable/);
  assert.equal(submits, 0);
});
