import path from 'node:path';
import { chromium } from 'playwright';
import { OperationError, failed, log, redact } from './errors.js';

/**
 * One persistent browser profile per provider account. The browser keeps the
 * portal's cookies and WAF tokens in its profile; nothing here reads or returns
 * cookie values. Callers serialize use through the provider's SerialQueue.
 */
export class BrowserSession {
  constructor(provider, config) {
    this.provider = provider;
    this.config = config;
    this.profileDir = path.join(config.profileRoot, provider.key);
    this.context = null;
    this.page = null;
    this.authenticated = false;
    this.lastErrorCode = null;
  }

  get browserReady() {
    return this.context !== null && this.page !== null && !this.page.isClosed();
  }

  async start() {
    if (this.browserReady) {
      return;
    }

    this.context = await chromium.launchPersistentContext(this.profileDir, {
      headless: this.config.headless,
      viewport: { width: 1280, height: 800 },
      acceptDownloads: false,
      ...(this.provider.proxy ? { proxy: this.provider.proxy } : {}),
    });
    this.context.setDefaultNavigationTimeout(this.config.navTimeoutMs);
    this.context.setDefaultTimeout(this.config.navTimeoutMs);
    this.context.on('close', () => {
      this.context = null;
      this.page = null;
      this.authenticated = false;
    });

    this.page = this.context.pages()[0] ?? (await this.context.newPage());
  }

  async stop() {
    const context = this.context;
    this.context = null;
    this.page = null;
    this.authenticated = false;
    if (context) {
      await context.close().catch(() => {});
    }
  }

  /** Confirm or restore the provider login. Safe to call before every operation. */
  async ensureSession() {
    try {
      await this.start();
      await this.provider.ensureLoggedIn(this.page, this.config);
      this.authenticated = true;
      this.lastErrorCode = null;
    } catch (error) {
      this.authenticated = false;
      if (!(error instanceof OperationError)) {
        // First line of a Playwright error names the failing step (e.g. a timeout); no credentials.
        log('session_error', { provider: this.provider.key, detail: redact(String(error?.message ?? error).split('\n')[0]) });
      }
      const sessionError = error instanceof OperationError ? error : failed('session_unavailable', 'Portal session could not be established', { retryable: true });
      this.lastErrorCode = sessionError.code;
      throw sessionError;
    }
  }

  markLoggedOut(code) {
    this.authenticated = false;
    this.lastErrorCode = code;
  }

  /**
   * Same-origin fetch from inside the portal page, so the browser supplies its
   * current cookies and WAF state. Returns status and raw text only.
   */
  async pageFetch(urlPath, { method = 'GET', form = null, timeoutMs }) {
    return this.page.evaluate(
      async ({ urlPath, method, form, timeoutMs }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const headers = { 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01' };
          let body;
          if (form) {
            headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
            body = new URLSearchParams(form).toString();
          }
          const response = await fetch(urlPath, { method, headers, body, credentials: 'same-origin', redirect: 'follow', signal: controller.signal });
          return { status: response.status, ok: response.ok, finalPath: new URL(response.url).pathname, text: await response.text() };
        } finally {
          clearTimeout(timer);
        }
      },
      { urlPath, method, form, timeoutMs }
    );
  }
}
