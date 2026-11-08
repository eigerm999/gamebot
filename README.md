# game-bot

Browser-backed worker that performs player operations on game agent portals
that have no usable API. Maxis6 (Laravel) calls it over HTTP; the worker drives
a real Chrome session per portal account with Playwright.

Only use it with portal accounts you are authorized to automate. It never
bypasses CAPTCHA, MFA or WAF challenges.

## Concepts

| Term | Meaning | Example |
| --- | --- | --- |
| Portal | One kind of agent backend; code in `src/portals/<portal>/` | `yes918` |
| Account | One login on one portal: own browser profile, session and queue | `yes918-0038` |

Two logins on the same portal are two accounts. In Maxis6 each account is its
own game (for example `918Kiss5-BOT` -> `yes918-0038`, `918Kiss6-BOT` -> `yes918-0039`).

## Operations

Params are defined once in `src/core/operations.js` and are the same for every
portal. A portal that does not implement an operation rejects it with
`unsupported_operation`.

| Operation | Params | yes918 | wudi |
| --- | --- | --- | --- |
| `createPlayer` | `amount` | ✅ | ✅ amount must be `0` |
| `setScore` | `playerId`, `amount` (`"10.00"` deposits, `"-10.00"` withdraws) | ✅ | ✅ |
| `resetPassword` | `playerId` | ✅ | ✅ |
| `disablePlayer` | `playerId`, `enable` | ✅ | ✅ |
| `kickPlayer` | `playerId` | ✅ | ✅ |
| `playerInfo` | `playerId` | ✅ read-only | ✅ read-only |
| `agentBalance` | none | ✅ read-only | ✅ read-only |
| `gameLog` | `playerId`, `date`, `page` | ✅ one day per call; the portal refuses old dates | ✅ net win/loss in Win column |
| `scoreLog` | `playerId`, `from`, `to`, `page` | ✅ up to 31 days, 50 rows per page | ✅ direct credit/debit |

Each account's `limits` are per transaction and enforced by the worker even if
the caller sends more: `maxInitialScore` caps one Create ID, `maxSetScore` caps
one deposit or withdrawal. Use `null` for no limit (amounts are still capped by
the 9-digit amount format, agent credit in Laravel, and player balance for
withdrawals). Both keys are required.

## Setup

```sh
npm ci
npm run browser:install
cp .env.example .env                    # WORKER_SECRET + account secrets
cp accounts.example.json accounts.json  # one entry per portal login
npm start
curl -s http://127.0.0.1:8918/health
```

`accounts.json` never holds secrets: `credentials` and `proxy` name environment
variables in `.env`. The worker refuses to start if an account is invalid or a
referenced variable is empty, and names the account and field.

`/health` returns 200 when every account has a browser and an authenticated
session, 503 otherwise (`/health?account=yes918-0038` for one).

- Every `SESSION_CHECK_MINUTES` (default 10, `0` = off) the worker asks each
  portal whether its login is still valid and logs in again if not. Busy
  accounts are skipped that round. `/health` shows `checkedAt`. Do not use a
  bot's portal login by hand: the check will take the session back.
- `HEADLESS=false` shows the browsers. If a login stops at a challenge, finish
  any permitted manual step in that window.
- Each account's session lives in `runtime/profiles/<account>` (gitignored)
  and survives restarts. Delete the folder to force a fresh login.
- A `proxy` must be a **static** IP; rotating IPs break logins and trigger WAF blocks.
- **Shared proxy:** set `PROXY_SERVER` (and `PROXY_USERNAME`/`PROXY_PASSWORD`)
  once in `.env`, then list the accounts that should use it in
  `PROXY_ACCOUNTS`, e.g. `PROXY_ACCOUNTS=yes918-0038,wudi-spadik`. Unlisted
  accounts connect directly; an empty list turns the proxy off. Restart the
  worker after changing. An account in the list must have `"proxy": null`.
  `/health` shows `"proxy": true|false` per account, never the address.

## API

`POST /v1/operations` with `Authorization: Bearer <WORKER_SECRET>`:

```json
{
  "operationId": "uuid (one per attempt, from the caller)",
  "account": "yes918-0038",
  "operation": "setScore",
  "fingerprint": "sha256 hex of the caller's request data, including the account",
  "params": { "playerId": "01000048805", "amount": "10.00" }
}
```

Response:

```json
{ "operationId": "…", "outcome": "succeeded", "result": { … } }
{ "operationId": "…", "outcome": "failed",  "error": { "code": "…", "message": "…" } }
{ "operationId": "…", "outcome": "unknown", "error": { "code": "…", "message": "…" } }
```

| Outcome | Meaning |
| --- | --- |
| `succeeded` | Portal confirmed the change |
| `failed` | Nothing changed on the portal; safe to try again |
| `unknown` | The change may have happened: check the portal by hand, never retry blindly |

Unknown fields, accounts or operations are rejected. Repeating a finished
`operationId` returns the stored answer instead of acting twice. Each account
runs one operation at a time; with more than `MAX_WAITING` queued, new requests
get `failed` / `busy` immediately.

## Adding a login for an existing portal

1. Add the secrets to `.env` and an entry to `accounts.json`.
2. Restart the worker and check `/health?account=<key>`.
3. In Maxis6, add the game to `config/botgames.php` and run
   `php artisan db:seed --class=BotGameSeeder`.

## Adding a portal

1. **Inspect the portal read-only first.** List the endpoints, form fields,
   success answers and report tables. Never click anything that changes data.
2. **Create `src/portals/<name>/`** with an `index.js` exporting:
   - `credentials`: `{ required: [...], optional: [...] }` credential field names
   - `validateSettings(settings, credentials)`: normalized settings; throw `Error` on bad input
   - `createPortal(account)`: `{ ensureLoggedIn(page, config), operations }`
   Register it in `src/portals/index.js`.
3. **Operations** are `async ({ session, params, ctx }) => result`, keyed by
   names from `src/core/operations.js`. Params arrive validated.
   - Reads use `readJson` / `readPage` from `src/core/portal-http.js`. They
     only ever throw `failed(...)`.
   - Changes use `submitOnce` from `src/core/submit.js` with a `classify`
     function: `{ ok: value }` for confirmed success, `{ rejected: message }`
     only when the portal explicitly refused, `null` for anything unclear.
     Never send a change any other way, and never retry after it.
   - Do checks that can fail predictably (player disabled, balance too low)
     *before* `submitOnce`, so they are confirmed failures.
4. **Parse report pages** with `session.parseHtml(html, extractor, arg)`.
   Extractors are self-contained functions (no imports or closures) that run
   in the browser. Test them in `test/` against saved pages that contain no
   passwords or tokens.
5. Add an account, check `/health`, run the reads, and test one small deposit
   and withdrawal only with approval.

## Tests

```sh
npm test
```

Covers operation params, cents maths, `submitOnce` outcomes, the accounts
loader and the yes918 page extractors (run in headless Chromium).

## Production

Run on a VPS (not shared hosting) under systemd or PM2 with `HEADLESS=true`.
The worker listens on `127.0.0.1` only; expose it to Laravel through an HTTPS
reverse proxy (e.g. Caddy) restricted to the Laravel server's IP.

## Wudi note

Wudi modifying calls are encrypted by its frontend. The plugin dynamically uses
the loaded portal Axios client; it never copies or bypasses the encryption. If
Wudi enables CAPTCHA, use `HEADLESS=false` to complete it manually once.
Create ID accepts amount 0 only; use Set Score for the first deposit.

Create identities are saved before submission in `runtime/create-identities`
(or `IDENTITY_ROOT`). Keep this directory across worker restarts. The authenticated
`GET /v1/operations/{operationId}/identity` endpoint returns only the account and
generated player ID for reconciliation; it never stores or returns passwords.
An existing identity prevents a create operation from being submitted again after
a restart. A saved identity alone does not prove that creation succeeded.
