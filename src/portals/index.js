import * as yes918 from './yes918/index.js';

/**
 * Portal types by name (the "portal" field in accounts.json). Each module exports:
 *
 *   credentials        { required: [...], optional: [...] } credential field names
 *   validateSettings   (settings, credentials) -> normalized settings; throws Error on bad input
 *   createPortal       (account) -> { ensureLoggedIn(page, config), operations }
 *
 * operations maps names from core/operations.js to
 *   async ({ session, params, ctx }) => result
 * Params arrive already validated. Changes must go through core/submit.js.
 */
export const PORTALS = Object.freeze({
  yes918,
});
