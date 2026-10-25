/**
 * Every operation ends in one of three outcomes:
 *   succeeded  the portal confirmed the change
 *   failed     the portal certainly did not change (safe to try again)
 *   unknown    a change may have happened; a human must check the portal
 *
 * Providers throw OperationError for the last two.
 */
export class OperationError extends Error {
  constructor(outcome, code, message, { retryable = false } = {}) {
    super(message);
    this.outcome = outcome;
    this.code = code;
    // Only meaningful for 'failed' raised before anything was submitted.
    this.retryable = retryable;
  }
}

export const failed = (code, message, options) => new OperationError('failed', code, message, options);
export const unknown = (code, message) => new OperationError('unknown', code, message);

/** Provider messages may echo inputs; keep a short, tag-free, token-free summary. */
export function redact(message) {
  return String(message ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/(PHPSESSID|MINIONPRO_TOKEN|aws-waf-token|token|password\w*|passWd|cookie)\s*[=:]\s*\S+/gi, '$1=[redacted]')
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** "Numerically zero" without treating '', null or false as 0. */
export function isZero(value) {
  return (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number(value) === 0;
}

export function nonEmpty(value) {
  return (typeof value === 'string' && value.trim() !== '') || (typeof value === 'number' && Number.isFinite(value));
}

export function log(event, fields = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}
