import { mkdir, readFile, open } from 'node:fs/promises';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PLAYER = /^[A-Za-z0-9_]{1,50}$/;

/** Durable create identity only: never passwords, tokens or portal bodies. */
export class CreateIdentities {
  constructor(directory) { this.directory = directory; }

  file(operationId) {
    if (!UUID.test(operationId)) throw new Error('Invalid operation ID');
    return path.join(this.directory, operationId + '.json');
  }

  async record(operationId, account, playerId) {
    if (!PLAYER.test(playerId)) throw new Error('Invalid player ID');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    // Exclusive creation prevents a reused operation from replacing its identity.
    const file = await open(this.file(operationId), 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify({ operationId, account, playerId }));
      await file.sync();
    } finally { await file.close(); }
  }

  async read(operationId) {
    try { return JSON.parse(await readFile(this.file(operationId), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
}
