import { randomInt } from 'node:crypto';
import { optional, proxyFromEnv, required } from '../../config.js';
import { failed, isZero, nonEmpty, redact, unknown } from '../../core/errors.js';

/**
 * yes918 agent portal (918 game).
 *
 * Login is two pages: username + password, then a second password
 * (password2 -> POST /login2 -> / -> /search). Done through the rendered pages
 * so each page supplies its own hidden token and AWS WAF runs normally.
 *
 * Implemented: createPlayer, playerInfo, resetPassword, disablePlayer, kickPlayer.
 * Not yet: setScore (semantics of player_setscore_newscore unconfirmed), gameLog (no portal endpoint found).
 */

const LOGIN_PASSWORD2 = 'input[name="password2"]';
const PASSWORD_PREFIXES = ['Aaa', 'Bbb', 'Ccc', 'Ddd', 'Edd', 'Fff', 'Ggg'];
const AMOUNT = /^\d{1,9}(\.\d{1,2})?$/;
const PLAYER_ID = /^[A-Za-z0-9_]{1,50}$/;

function loadSettings() {
  const base = new URL(required('YES918_BASE_URL'));
  if (base.protocol !== 'https:') {
    throw new Error('YES918_BASE_URL must use https');
  }

  const maxInitialScore = Number(optional('YES918_MAX_INITIAL_SCORE', '50'));
  if (!Number.isFinite(maxInitialScore) || maxInitialScore < 0) {
    throw new Error('YES918_MAX_INITIAL_SCORE must be a non-negative number');
  }

  const username = required('YES918_USERNAME');
  const password = required('YES918_PASSWORD');

  return Object.freeze({
    origin: base.origin,
    username,
    password,
    // Defaults to the first password when the portal reuses it.
    password2: optional('YES918_PASSWORD2', password),
    agentUsername: optional('YES918_AGENT_USERNAME', username),
    homePath: optional('YES918_HOME_PATH', '/search'),
    playerName: optional('YES918_PLAYER_NAME', ''),
    playerRemark: optional('YES918_PLAYER_REMARK', ''),
    maxInitialScore,
  });
}

/** Matches the portal's own format: prefix + 100..998. */
export function generatePlayerPassword() {
  return PASSWORD_PREFIXES[randomInt(0, PASSWORD_PREFIXES.length)] + String(randomInt(100, 999));
}

/** "10.00" -> "10", "10.50" -> "10.5": the format the portal form would send. */
function portalScore(amount) {
  return amount.includes('.') ? amount.replace(/0+$/, '').replace(/\.$/, '') : amount;
}

function parseJson(text) {
  try {
    const json = JSON.parse(text);
    return json && typeof json === 'object' ? json : null;
  } catch {
    return null;
  }
}

export function createProvider() {
  const s = loadSettings();

  async function isAuthenticated(page) {
    const url = new URL(page.url());
    if (url.origin !== s.origin || !url.pathname.startsWith(s.homePath)) {
      return false;
    }
    return (await page.locator(LOGIN_PASSWORD2).count()) === 0;
  }

  async function fillUsernameIfShown(form) {
    const field = form.locator('input[name="username"]:visible').first();
    if ((await field.count()) > 0 && (await field.isEditable())) {
      await field.fill(s.username);
    }
  }

  async function submitForm(page, form) {
    const navigation = page.waitForNavigation({ waitUntil: 'domcontentloaded' }).catch(() => {});
    const submit = form.locator('button[type="submit"], input[type="submit"], button:not([type])').first();
    if ((await submit.count()) > 0) {
      await submit.click();
    } else {
      await form.evaluate((element) => element.requestSubmit());
    }
    await navigation;
  }

  async function login(page, config) {
    const secondPassword = page.locator(LOGIN_PASSWORD2);
    const anyPassword = page.locator('input[type="password"]');

    try {
      await anyPassword.first().waitFor({ state: 'visible' });
    } catch {
      throw failed('login_form_missing', 'Login form not found (possible WAF or CAPTCHA challenge)');
    }

    for (let step = 1; step <= 2; step++) {
      // Give AWS WAF's challenge script a chance to settle before submitting.
      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

      if ((await secondPassword.count()) > 0) {
        const form = page.locator('form', { has: secondPassword }).first();
        await fillUsernameIfShown(form);
        await secondPassword.fill(s.password2);
        await submitForm(page, form);
        break;
      }

      if (step === 2) {
        throw failed('login_step2_missing', 'Second password page did not appear after the first login step');
      }

      const passwordField = anyPassword.first();
      const form = page.locator('form', { has: passwordField }).first();
      await fillUsernameIfShown(form);
      await passwordField.fill(s.password);
      await submitForm(page, form);

      if (await isAuthenticated(page)) {
        return; // portal skipped the second step
      }
      try {
        await secondPassword.waitFor({ state: 'visible' });
      } catch {
        throw failed('login_rejected', 'First login step was rejected (username or password)');
      }
    }

    await page
      .waitForURL((url) => url.pathname.startsWith(s.homePath), { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs })
      .catch(() => {});

    if (!(await isAuthenticated(page))) {
      throw failed('login_rejected', 'Portal login did not reach the authenticated page (second password, CAPTCHA or MFA)');
    }
  }

  async function ensureLoggedIn(page, config) {
    if (await isAuthenticated(page)) {
      return;
    }
    // Wait for the DOM, not 'load': slow assets (e.g. over a VPN or proxy) can delay 'load' well past the form being usable.
    await page.goto(s.origin + '/', { waitUntil: 'domcontentloaded' });
    await page
      .waitForURL((url) => url.pathname.startsWith(s.homePath) || url.pathname.startsWith('/login'), { waitUntil: 'domcontentloaded' })
      .catch(() => {});
    if (await isAuthenticated(page)) {
      return;
    }
    await login(page, config);
  }

  /** Pre-submission and side-effect free: any failure is a confirmed failure. */
  async function randomPlayerId(session, config) {
    let response;
    try {
      response = await session.pageFetch('/playerlist/random?game=918', { timeoutMs: config.fetchTimeoutMs });
    } catch {
      throw failed('random_transport', 'Random player ID request failed', { retryable: true });
    }

    const json = parseJson(response.text);
    if (!json) {
      // An HTML answer (usually the login page) means the session expired.
      session.markLoggedOut('session_expired');
      throw failed('session_expired', 'Portal session expired', { retryable: true });
    }
    if (!response.ok || !isZero(json.error) || !nonEmpty(json.playerid)) {
      throw failed('random_rejected', redact(json.msg ?? json.message ?? 'Random player ID was rejected'));
    }
    return String(json.playerid).trim();
  }

  const createPlayer = {
    validate(params) {
      const keys = Object.keys(params);
      if (keys.length !== 1 || keys[0] !== 'amount') {
        return 'invalid_params';
      }
      if (typeof params.amount !== 'string' || !AMOUNT.test(params.amount) || Number(params.amount) > s.maxInitialScore) {
        return 'invalid_amount';
      }
      return null;
    },

    /** Submits the create request exactly once; after that, anything but an explicit rejection is 'unknown'. */
    async run({ session, params, ctx }) {
      const playerId = await randomPlayerId(session, ctx.config);
      const password = generatePlayerPassword();
      const score = portalScore(params.amount);

      ctx.assertCanSubmit();

      let response;
      try {
        response = await session.pageFetch('/playerlist/createnew?game=918', {
          method: 'POST',
          timeoutMs: ctx.config.submitTimeoutMs,
          form: {
            player_username: playerId,
            player_password: password,
            player_name: s.playerName,
            player_remark: s.playerRemark,
            player_score: score,
            agent_username: s.agentUsername,
          },
        });
      } catch {
        throw unknown('create_transport', 'Create request did not complete');
      }

      const json = parseJson(response.text);
      if (!json) {
        throw unknown('create_malformed', `Create response was not JSON (HTTP ${response.status})`);
      }

      const confirmed = response.ok && isZero(json.error) && isZero(json.code) && json.success === true && nonEmpty(json.playerid);
      if (!confirmed) {
        // Explicit rejection: the portal said no and did not claim success.
        const rejected = json.success !== true && ((nonEmpty(json.error) && !isZero(json.error)) || (nonEmpty(json.code) && !isZero(json.code)));
        if (rejected) {
          throw failed('create_rejected', redact(json.msg ?? json.message ?? 'Portal rejected the create request'));
        }
        throw unknown('create_unconfirmed', 'Create response did not confirm success');
      }

      if (String(json.playerid).trim() !== playerId) {
        throw unknown('create_mismatch', 'Returned player ID does not match the requested ID');
      }
      if (json.passWd !== undefined && String(json.passWd) !== password) {
        throw unknown('create_mismatch', 'Returned password does not match the submitted password');
      }

      return { playerId, password, score: params.amount };
    },
  };

  /** {playerId} only; the ID is interpolated into portal URL paths, so keep it strict. */
  function validatePlayerOnly(params, extra = {}) {
    const allowed = ['playerId', ...Object.keys(extra)];
    const keys = Object.keys(params);
    if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) {
      return 'invalid_params';
    }
    if (typeof params.playerId !== 'string' || !PLAYER_ID.test(params.playerId)) {
      return 'invalid_player_id';
    }
    for (const [key, check] of Object.entries(extra)) {
      if (!check(params[key])) {
        return 'invalid_params';
      }
    }
    return null;
  }

  /**
   * Shared tail of every portal change: submit once, then
   * error 0 -> succeeded, explicit non-zero error -> failed, anything else -> unknown.
   */
  async function submitChange(session, ctx, urlPath, { method = 'POST', form = null, code }) {
    ctx.assertCanSubmit();

    let response;
    try {
      response = await session.pageFetch(urlPath, { method, form, timeoutMs: ctx.config.submitTimeoutMs });
    } catch {
      throw unknown(`${code}_transport`, 'Request did not complete');
    }

    const json = parseJson(response.text);
    if (!json) {
      throw unknown(`${code}_malformed`, `Response was not JSON (HTTP ${response.status})`);
    }
    if (response.ok && isZero(json.error)) {
      return json;
    }
    if (nonEmpty(json.error) && !isZero(json.error)) {
      const message = String(json.error) === '1000' ? 'Player is disabled' : json.message ?? json.msg ?? 'Portal rejected the request';
      throw failed(`${code}_rejected`, redact(message));
    }
    throw unknown(`${code}_unconfirmed`, 'Response did not confirm success');
  }

  const playerInfo = {
    validate: (params) => validatePlayerOnly(params),

    /** Read-only: every failure is a confirmed failure. */
    async run({ session, params, ctx }) {
      const path = `/playerlist/${encodeURIComponent(params.playerId)}/balance?username=${encodeURIComponent(s.agentUsername)}&game=918`;
      let response;
      try {
        response = await session.pageFetch(path, { timeoutMs: ctx.config.fetchTimeoutMs });
      } catch {
        throw failed('info_transport', 'Player info request failed', { retryable: true });
      }

      const json = parseJson(response.text);
      if (!json) {
        session.markLoggedOut('session_expired');
        throw failed('session_expired', 'Portal session expired', { retryable: true });
      }
      if (!response.ok || !isZero(json.error) || !Number.isFinite(Number(json.score))) {
        throw failed('info_rejected', redact(json.message ?? json.msg ?? 'Player info was rejected'));
      }

      return {
        playerId: params.playerId,
        score: String(json.score),
        enabled: String(json.status ?? '').toLowerCase() === 'enable',
        status: redact(json.status ?? ''),
      };
    },
  };

  const resetPassword = {
    validate: (params) => validatePlayerOnly(params),

    async run({ session, params, ctx }) {
      const password = generatePlayerPassword();
      await submitChange(session, ctx, '/playerlist/resetpassword?game=918', {
        code: 'reset',
        form: {
          player_resetpassword_username: params.playerId,
          player_resetpassword_password: password,
          player_resetpassword_agent_username: s.agentUsername,
        },
      });
      return { playerId: params.playerId, password };
    },
  };

  const disablePlayer = {
    validate: (params) => validatePlayerOnly(params, { enable: (value) => typeof value === 'boolean' }),

    /** The portal changes status with a GET. */
    async run({ session, params, ctx }) {
      const action = params.enable ? 'enable' : 'disable';
      await submitChange(session, ctx, `/playerlist/${encodeURIComponent(params.playerId)}/${action}?game=918`, { method: 'GET', code: action });
      return { playerId: params.playerId, enabled: params.enable };
    },
  };

  const kickPlayer = {
    validate: (params) => validatePlayerOnly(params),

    async run({ session, params, ctx }) {
      await submitChange(session, ctx, '/playerlist/kick?game=918', {
        code: 'kick',
        form: {
          player_kick_username: params.playerId,
          player_kick_agent_username: s.agentUsername,
        },
      });
      return { playerId: params.playerId };
    },
  };

  return {
    key: 'yes918',
    proxy: proxyFromEnv('YES918'),
    ensureLoggedIn,
    operations: {
      createPlayer,
      playerInfo,
      resetPassword,
      disablePlayer,
      kickPlayer,
    },
  };
}
