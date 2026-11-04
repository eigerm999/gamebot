/**
 * Money as integer cents, so limits and balance maths never depend on
 * floating point. Amounts cross the HTTP boundary as decimal strings.
 */

/** Non-negative, at most 2 decimals: "10", "10.5", "10.50". */
export const AMOUNT = /^\d{1,9}(\.\d{1,2})?$/;

/** Signed version of AMOUNT: positive deposits, negative withdrawals. */
export const SIGNED_AMOUNT = /^-?\d{1,9}(\.\d{1,2})?$/;

/** Any plain decimal a portal may report, e.g. "0.099999999999994" or "-0". */
export const PORTAL_NUMBER = /^-?\d+(\.\d+)?$/;

/** "-10.5" -> -1050. Extra decimals are cut, not rounded; callers validate format first. */
export function toCents(value) {
  const text = String(value).trim();
  if (!PORTAL_NUMBER.test(text)) {
    throw new Error(`Not a decimal amount: ${text}`);
  }
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace(/^-/, '').split('.');
  const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  return negative && cents !== 0 ? -cents : cents;
}

/** -1050 -> "-10.50" */
export function fromCents(cents) {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** "10.00" -> "10", "10.50" -> "10.5": the short form portal forms usually send. */
export function shortAmount(amount) {
  return amount.includes('.') ? amount.replace(/0+$/, '').replace(/\.$/, '') : amount;
}

export function portalToCents(value) {
  const text = String(value).trim();
  if (!PORTAL_NUMBER.test(text)) throw new Error(`Not a portal amount: ${text}`);
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace(/^-/, '').split('.');
  const padded = fraction + '000';
  let cents = Number(whole) * 100 + Number(padded.slice(0, 2));
  if (Number(padded[2]) >= 5) cents++;
  return negative && cents !== 0 ? -cents : cents;
}

/** A portal-reported number as a clean string, or null. "-0" becomes "0". */
export function cleanPortalNumber(value) {
  const text = String(value ?? '').trim();
  if (!PORTAL_NUMBER.test(text)) {
    return null;
  }
  return /^-0(\.0+)?$/.test(text) ? '0' : text;
}
