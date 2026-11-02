import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { OperationError, failed, log, redact, unknown } from './core/errors.js';
import { SerialQueue } from './core/queue.js';
import { BrowserSession } from './core/session.js';
import { OPERATIONS } from './core/operations.js';
import { loadAccounts } from './accounts.js';
import { PORTALS } from './portals/index.js';

/**
 * Loopback-only worker. Exposes exactly:
 *   GET  /health          readiness per account, no secrets
 *   POST /v1/operations   { operationId, account, operation, fingerprint, params } with a bearer secret
 *
 * Logs only operation IDs, outcomes and error codes: never bodies, passwords,
 * cookies, authorization headers, page HTML or screenshots.
 */

const MAX_BODY_BYTES = 8192;
const MAX_REMEMBERED_OPERATIONS = 1000;
const REQUEST_FIELDS = ['account', 'fingerprint', 'operation', 'operationId', 'params'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const SESSION_UNAVAILABLE = ['session_unavailable', 'login_rejected', 'login_form_missing', 'login_step2_missing'];

// account key -> { account, portal, session, queue }. Each account is isolated:
// its own browser profile, login and queue.
const workers = new Map(
  loadAccounts(config.accountsFile, PORTALS).map((account) => {
    const portal = PORTALS[account.portal].createPortal(account);
    return [account.key, { account, portal, session: new BrowserSession(account, portal, config), queue: new SerialQueue(config.maxWaiting) }];
  })
);

// operationId -> { fingerprint, done, status, body }. In memory: a restart forgets
// completed operations, but Laravel never resends an operation ID anyway.
const operations = new Map();

function digest(value) {
  return createHash('sha256').update(String(value)).digest();
}

function authorized(req) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return timingSafeEqual(digest(token), digest(config.secret));
}

function send(res, status, body) {
  if (res.writableEnded) {
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'Cache-Control': 'no-store' });
  res.end(payload);
}

function outcomeBody(operationId, outcome, code, message) {
  return { operationId, outcome, error: { code, message } };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Returns an error code, or null when the request envelope and params are acceptable. */
function validate(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'invalid_request';
  }
  const keys = Object.keys(body).sort();
  if (keys.length !== REQUEST_FIELDS.length || keys.some((key, i) => key !== REQUEST_FIELDS[i])) {
    return 'invalid_fields';
  }
  if (typeof body.operationId !== 'string' || !UUID.test(body.operationId)) {
    return 'invalid_operation_id';
  }
  if (typeof body.fingerprint !== 'string' || !FINGERPRINT.test(body.fingerprint)) {
    return 'invalid_fingerprint';
  }
  const worker = workers.get(body.account);
  if (!worker) {
    return 'unknown_account';
  }
  if (!Object.hasOwn(OPERATIONS, body.operation) || typeof worker.portal.operations[body.operation] !== 'function') {
    return 'unsupported_operation';
  }
  if (!body.params || typeof body.params !== 'object' || Array.isArray(body.params)) {
    return 'invalid_params';
  }
  return OPERATIONS[body.operation].validate(body.params, worker.account.limits);
}

function remember(operationId, entry) {
  operations.set(operationId, entry);
  while (operations.size > MAX_REMEMBERED_OPERATIONS) {
    operations.delete(operations.keys().next().value);
  }
}

function workerFault(error, submitted, request) {
  // First line only: Playwright messages name the failing step; never bodies or credentials.
  log('worker_fault', { operationId: request.operationId, submitted, detail: redact(String(error?.message ?? error).split('\n')[0]) });
  return submitted ? unknown('worker_fault', 'Unexpected worker error after submission') : failed('worker_fault', 'Unexpected worker error before submission');
}

async function runOperation(worker, request, startedAt, clientGone) {
  const operation = worker.portal.operations[request.operation];
  let submitted = false;

  const ctx = {
    config,
    // Never start a portal change that the caller may already have given up on.
    assertCanSubmit() {
      if (clientGone()) {
        throw failed('client_gone', 'Caller disconnected before submission');
      }
      if (Date.now() - startedAt > config.submitDeadlineMs) {
        throw failed('deadline_exceeded', 'Pre-submission steps took too long');
      }
      submitted = true;
      log('submit', { operationId: request.operationId, account: worker.account.key, operation: request.operation });
    },
  };

  // Pre-submission failures marked retryable (e.g. silent session expiry) are retried once.
  for (let attempt = 1; ; attempt++) {
    try {
      await worker.session.ensureSession();
      return await operation({ session: worker.session, params: request.params, ctx });
    } catch (caught) {
      // A bug or unexpected error: before submission nothing changed on the portal.
      const error = caught instanceof OperationError ? caught : workerFault(caught, submitted, request);
      const retryable = error instanceof OperationError && error.outcome === 'failed' && error.retryable && !submitted && attempt === 1;
      if (!retryable) {
        throw error;
      }
      log('pre_submit_retry', { operationId: request.operationId, code: error.code });
    }
  }
}

async function handleOperation(req, res) {
  const startedAt = Date.now();
  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  if (!authorized(req)) {
    send(res, 401, { outcome: 'failed', error: { code: 'unauthorized', message: 'Unauthorized' } });
    return;
  }
  if (!(req.headers['content-type'] ?? '').startsWith('application/json')) {
    send(res, 415, { outcome: 'failed', error: { code: 'unsupported_media_type', message: 'JSON required' } });
    return;
  }

  let request;
  try {
    request = JSON.parse(await readBody(req));
  } catch {
    send(res, 400, { outcome: 'failed', error: { code: 'invalid_request', message: 'Invalid JSON body' } });
    return;
  }

  const invalid = validate(request);
  const operationId = typeof request?.operationId === 'string' ? request.operationId : null;
  if (invalid) {
    send(res, 400, outcomeBody(operationId, 'failed', invalid, 'Request rejected'));
    return;
  }

  const existing = operations.get(operationId);
  if (existing) {
    if (existing.fingerprint !== request.fingerprint) {
      send(res, 409, outcomeBody(operationId, 'failed', 'operation_conflict', 'Operation ID reused with different data'));
    } else if (existing.done) {
      log('operation_replay', { operationId });
      send(res, existing.status, existing.body);
    } else {
      send(res, 409, outcomeBody(operationId, 'unknown', 'operation_in_progress', 'Operation is still in progress'));
    }
    return;
  }
  remember(operationId, { fingerprint: request.fingerprint, done: false });

  const worker = workers.get(request.account);
  let status;
  let body;
  try {
    const result = await worker.queue.run(() => runOperation(worker, request, startedAt, () => closed));
    status = 200;
    body = { operationId, outcome: 'succeeded', result };
  } catch (error) {
    if (error instanceof OperationError) {
      status = SESSION_UNAVAILABLE.includes(error.code) || error.code === 'busy' ? 503 : 200;
      body = outcomeBody(operationId, error.outcome, error.code, error.message);
    } else {
      // Unexpected worker fault: we cannot prove nothing was submitted.
      status = 500;
      body = outcomeBody(operationId, 'unknown', 'worker_fault', 'Unexpected worker error');
    }
  }

  log('operation_result', {
    operationId,
    account: request.account,
    operation: request.operation,
    outcome: body.outcome,
    code: body.error?.code ?? null,
    ms: Date.now() - startedAt,
  });

  if (body.error?.code === 'busy') {
    operations.delete(operationId); // nothing happened; the same ID may be sent again
  } else {
    remember(operationId, { fingerprint: request.fingerprint, done: true, status, body });
  }
  send(res, status, body);
}

function handleHealth(res, only) {
  const accounts = {};
  for (const [key, { account, session, queue }] of workers) {
    if (only && key !== only) {
      continue;
    }
    accounts[key] = {
      portal: account.portal,
      browser: session.browserReady,
      session: session.authenticated,
      busy: queue.busy,
      waiting: queue.waiting,
      lastError: session.lastErrorCode,
    };
  }
  if (only && !accounts[only]) {
    send(res, 404, { error: { code: 'unknown_account', message: 'Unknown account' } });
    return;
  }
  const ready = Object.values(accounts).every((a) => a.browser && a.session);
  send(res, ready ? 200 : 503, { process: 'ready', headless: config.headless, accounts });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/health') {
    handleHealth(res, url.searchParams.get('account'));
  } else if (req.method === 'POST' && url.pathname === '/v1/operations') {
    handleOperation(req, res).catch(() => send(res, 500, { outcome: 'unknown', error: { code: 'worker_fault', message: 'Unexpected worker error' } }));
  } else {
    send(res, 404, { error: { code: 'not_found', message: 'Not found' } });
  }
});
server.requestTimeout = 120000;
server.headersTimeout = 10000;

server.listen(config.port, config.host, () => {
  log('listening', { host: config.host, port: config.port, headless: config.headless, accounts: [...workers.keys()] });

  // Login check at startup; failures only mark that account not ready.
  for (const [key, { session, queue }] of workers) {
    queue
      .runInternal(() => session.ensureSession())
      .then(() => log('session_ready', { account: key }))
      .catch((error) => log('session_not_ready', { account: key, code: error.code ?? 'unknown' }));
  }
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) {
    return;
  }
  stopping = true;
  log('shutdown', { signal });
  server.close();
  await Promise.all([...workers.values()].map(({ session }) => session.stop()));
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
