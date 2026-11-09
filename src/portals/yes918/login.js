import { failed } from '../../core/errors.js';

/**
 * Login is two pages: username + password, then a second password
 * (password2 -> POST /login2 -> / -> /search). Done through the rendered pages
 * so each page supplies its own hidden token and AWS WAF runs normally.
 */
const LOGIN_PASSWORD2 = 'input[name="password2"]';

export function createLogin(site) {
  const { origin, homePath } = site;
  const { username, password } = site.credentials;
  const password2 = site.credentials.password2 ?? password;

  async function isAuthenticated(page) {
    const url = new URL(page.url());
    if (url.origin !== origin || !url.pathname.startsWith(homePath)) {
      return false;
    }
    return (await page.locator(LOGIN_PASSWORD2).count()) === 0;
  }

  async function fillUsernameIfShown(form) {
    const field = form.locator('input[name="username"]:visible').first();
    if ((await field.count()) > 0 && (await field.isEditable())) {
      await field.fill(username);
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
        await secondPassword.fill(password2);
        await submitForm(page, form);
        break;
      }

      if (step === 2) {
        throw failed('login_step2_missing', 'Second password page did not appear after the first login step');
      }

      const passwordField = anyPassword.first();
      const form = page.locator('form', { has: passwordField }).first();
      await fillUsernameIfShown(form);
      await passwordField.fill(password);
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
      .waitForURL((url) => url.pathname.startsWith(homePath), { waitUntil: 'domcontentloaded', timeout: config.navTimeoutMs })
      .catch(() => {});

    if (!(await isAuthenticated(page))) {
      throw failed('login_rejected', 'Portal login did not reach the authenticated page (second password, CAPTCHA or MFA)');
    }
  }

  // Pages already switched to English in this login session.
  const english = new WeakSet();

  /**
   * Report pages are read by their English labels ("Begin Balance", "After
   * Score"), and the portal language is per session. The portal's own "Eng"
   * link (GET /lang/eng) is a display preference only; it changes no data.
   */
  async function useEnglish(page) {
    if (english.has(page)) {
      return;
    }
    await page.goto(origin + '/lang/eng', { waitUntil: 'domcontentloaded' });
    if (!(await isAuthenticated(page))) {
      await page.goto(origin + homePath, { waitUntil: 'domcontentloaded' });
    }
    if (!(await isAuthenticated(page))) {
      throw failed('session_unavailable', 'Portal session was lost while selecting English');
    }
    english.add(page);
  }

  return {
    /**
     * verify: reload the portal instead of trusting the current page. The
     * page URL alone cannot tell that the portal ended the session.
     */
    async ensureLoggedIn(page, config, { verify = false } = {}) {
      if (!verify && (await isAuthenticated(page))) {
        await useEnglish(page);
        return;
      }
      // Wait for the DOM, not 'load': slow assets (VPN, proxy) can delay 'load' well past the form being usable.
      await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
      await page
        .waitForURL((url) => url.pathname.startsWith(homePath) || url.pathname.startsWith('/login'), { waitUntil: 'domcontentloaded' })
        .catch(() => {});
      if (await isAuthenticated(page)) {
        await useEnglish(page);
        return;
      }
      english.delete(page); // a new login session may start in another language
      await login(page, config);
      await useEnglish(page);
    },
  };
}
