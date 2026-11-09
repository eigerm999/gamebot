import { failed } from '../../core/errors.js';
import { parseJson } from '../../core/portal-http.js';
import { wudiRequest } from './request.js';

export function automaticLoginAllowed(json, response) {
  return response?.ok === true && Number(json?.code) === 200 && json?.captchaEnabled === false;
}

/** Wudi login through its rendered Vue app so the app performs AES/RSA encryption. */
export function createLogin(site, request = wudiRequest) {
  async function authenticated(page, config) {
    if (new URL(page.url()).origin !== site.origin || new URL(page.url()).pathname.startsWith('/login')) {
      return false;
    }
    try {
      const response = await request(page, { path: '/getInfo', method: 'GET', timeoutMs: config.fetchTimeoutMs });
      const json = parseJson(response.text);
      return response.ok && Number(json?.code) === 200;
    } catch {
      return false;
    }
  }

  async function captchaEnabled(page, config) {
    try {
      const response = await request(page, {
        path: '/captchaImage',
        method: 'GET',
        timeoutMs: config.fetchTimeoutMs,
      });
      const json = parseJson(response.text);
      return !automaticLoginAllowed(json, response);
    } catch {
      // If we cannot establish that CAPTCHA is disabled, do not submit credentials.
      return true;
    }
  }

  // Pages that already carry the English preference script.
  const english = new WeakSet();

  /**
   * The Wudi app keeps its UI language in localStorage "language" (en-US for
   * English, as chosen on its login page) and reads it when the app loads.
   * Data is read from JSON fields, so this only makes the portal's own
   * messages (e.g. rejection reasons shown to agents) English.
   */
  async function preferEnglish(page) {
    if (english.has(page)) {
      return;
    }
    await page.addInitScript((origin) => {
      if (window.location.origin === origin && window.localStorage.getItem('language') !== 'en-US') {
        window.localStorage.setItem('language', 'en-US');
      }
    }, site.origin);
    english.add(page);
  }

  return {
    async ensureLoggedIn(page, config) {
      await preferEnglish(page);
      if (await authenticated(page, config)) {
        return;
      }

      await page.goto(site.origin + '/login', { waitUntil: 'domcontentloaded' });
      const form = page.locator('.login-form, form').first();
      try {
        await form.locator('input[type="password"]').waitFor({ state: 'visible' });
      } catch {
        throw failed('login_form_missing', 'Wudi login form not found (possible Cloudflare or portal challenge)');
      }

      await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
      if (await captchaEnabled(page, config)) {
        throw failed('login_challenge', 'Wudi CAPTCHA is enabled; complete it once in a visible browser');
      }

      const username = form.locator('input:not([type="password"]):not([readonly])').first();
      const password = form.locator('input[type="password"]').first();
      await username.fill(site.credentials.username);
      await password.fill(site.credentials.password);

      const navigation = page.waitForURL((url) => !url.pathname.startsWith('/login'), { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs }).catch(() => {});
      await form.getByRole('button').filter({ hasText: /登|Login/i }).first().click();
      await navigation;

      if (!(await authenticated(page, config))) {
        throw failed('login_rejected', 'Wudi login was rejected (username, password or challenge)');
      }
      // Use a stable page after login. The generic Axios module is already loaded,
      // but this also makes manual diagnosis easy in HEADLESS=false mode.
      if (!new URL(page.url()).pathname.startsWith(site.homePath)) {
        await page.goto(site.origin + site.homePath, { waitUntil: 'domcontentloaded' });
      }
    },
  };
}
