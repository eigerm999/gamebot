# Multi-portal, multi-account game-bot

**Status:** approved 2026-10-31
**Repos:** game-bot (worker), maxis6 (Laravel caller)

## Goal

Run several game portals without an API through one worker, where each portal
type is a plugin and each portal login is an account. Adding a login for an
existing portal type needs config only; adding a portal type needs one plugin
folder. Money-safety rules are shared and cannot be skipped by a plugin.

Expected size: up to about 5 accounts at once, on one VPS, in one process.

## Concepts

| Term | Meaning | Example |
| --- | --- | --- |
| Portal | One kind of agent backend; code in `src/portals/<portal>/` | `yes918` |
| Account | One login on one portal; own browser profile, session and queue | `yes918-0038` |
| Bot game | One maxis6 `games` row mapped to exactly one account | `918bot` -> `yes918-0038` |

Two logins on the same portal are two accounts and two maxis6 games
(for example `918bot` and `918bot2`). Players never move between them.

## game-bot layout

```
src/
  server.js              HTTP: GET /health, POST /v1/operations
  config.js              worker settings + accounts.json loader (fails fast)
  core/
    errors.js            OperationError, failed(), unknown(), redact(), log()
    queue.js             SerialQueue (one per account)
    session.js           BrowserSession (one per account)
    operations.js        operation names + shared param rules
    submit.js            submitOnce(): the only way to send a change
    portal-http.js       parseJson, readJson, readPage (reads; session expiry)
    money.js             cents maths, amount formats
  portals/
    index.js             { yes918: createPortal }
    yes918/
      index.js           createPortal(account) -> { ensureLoggedIn, operations }
      login.js
      players.js         createPlayer, playerInfo, resetPassword, disablePlayer, kickPlayer
      score.js           setScore
      reports.js         agentBalance, gameLog, scoreLog + page extractors
test/                    node --test
accounts.example.json    committed template
accounts.json            gitignored
runtime/profiles/<account>/
```

### accounts.json

Values that are secret are never in this file; `credentials` and `proxy` map a
field to the **name** of an environment variable in `.env`.

```json
{
  "yes918-0038": {
    "portal": "yes918",
    "baseUrl": "https://k1.yes918.com",
    "credentials": { "username": "YES918_USERNAME", "password": "YES918_PASSWORD", "password2": "YES918_PASSWORD2" },
    "limits": { "maxInitialScore": "50", "maxSetScore": "1000" },
    "settings": { "homePath": "/search" },
    "proxy": null
  }
}
```

- Account keys: `^[a-z0-9][a-z0-9-]{0,39}$` (also the profile folder name).
- `limits` are required for every account. The worker enforces them even if
  the caller sends more.
- `settings` are portal-specific and validated by the portal's `createPortal`.
- Each portal declares which credential fields are required and which are optional.

### Operation contract

`core/operations.js` owns the params of every operation, so the caller sends
the same params to every portal:

| Operation | Params | Changes the portal |
| --- | --- | --- |
| `createPlayer` | `amount` (0..maxInitialScore) | yes |
| `setScore` | `playerId`, `amount` (signed, non-zero, abs <= maxSetScore) | yes |
| `resetPassword` | `playerId` | yes |
| `disablePlayer` | `playerId`, `enable` (bool) | yes |
| `kickPlayer` | `playerId` | yes |
| `playerInfo` | `playerId` | no |
| `agentBalance` | none | no |
| `gameLog` | `playerId`, `date`, `page` | no |
| `scoreLog` | `playerId`, `from`, `to`, `page` | no |

A portal exports `operations: { name: async ({ session, params, ctx, account }) => result }`
for the operations it supports; the rest return `unsupported_operation`.

### Safety rules

- Changes are sent only through `submitOnce(session, ctx, { path, method, form, code, classify })`.
  It calls `ctx.assertCanSubmit()`, sends once, and maps:
  transport error or non-JSON -> `unknown`; `classify(json)` returns
  `{ ok: value }`, `{ rejected: message }` -> `failed`, or `null` -> `unknown`.
- Reads (`readJson`, `readPage`) only return `failed`; session expiry is
  `failed` + retryable, and is retried once only before anything was submitted.
- An unexpected worker error before submission is `failed / worker_fault`;
  after submission it stays `unknown / worker_fault`.
- Operation IDs are remembered per worker process. The fingerprint must cover
  the account (maxis6 includes it).

### HTTP

- `POST /v1/operations` with `{ operationId, account, operation, fingerprint, params }`.
  The field `provider` is replaced by `account`; maxis6 and the worker deploy together.
- `GET /health` -> `{ accounts: { <key>: { portal, browser, session, busy, waiting, lastError } } }`,
  200 only when all are ready; `?account=<key>` for one.
- Every log line carries `account`. Bodies, passwords, cookies and HTML are never logged.

### Startup

The worker refuses to start when `accounts.json` is missing or invalid, when it
names an unknown portal, or when a referenced env variable is empty. The error
names the account and field.

## maxis6

- `config/botgames.php`: `worker_url`, `worker_secret`, `connect_timeout`,
  `timeout` (env `BOT_WORKER_*`) and `games` => exact title => `account`,
  `max_initial_score`, `max_set_score`.
- `App\Services\BotWorkerClient`: generic; every call takes the account key.
- `App\Http\Controllers\Games\BotGameController`: one instance per bot game;
  `BotGameController::forGame($selectgames)` returns it or `null`. It is checked
  first in every dispatch in `GameApiController` and `AgentGameApiController`.
- `App\Models\BotOperation` on table `bot_operations` (renamed from
  `bot918_operations`) with a new `account` column; existing rows get `yes918-0038`.
- `BotGameAdapter` for the welcome bonus; `AdapterFactory` checks bot games first.
- `lang/*/botgame.php` replaces `bot918.php`; messages name the game.
- Views read the configured bot titles. `BotGameSeeder` creates a row per title.

Adding a login for yes918: `accounts.json` + `.env` entry, `botgames.games`
line, `php artisan db:seed --class=BotGameSeeder`, assign the game to agents.

## Adding a portal type

1. Inspect the portal read-only (endpoints, form fields, success replies, tables).
2. Add `src/portals/<name>/` with login and the supported operations; changes use `submitOnce`.
3. Write page extractors as pure functions and test them against saved pages
   with no passwords or tokens.
4. Add the account and check `/health`.
5. Live-test reads; test one small deposit and withdrawal only with approval.

## Testing

- game-bot: `npm test` (`node --test`) for operation param rules, cents maths,
  `submitOnce` outcome mapping, accounts loader, and yes918 extractors
  (run in headless Chromium, the same DOMParser the worker uses).
- maxis6: `BotGameControllerTest` with a fake `BotWorkerClient`.

## Rollout

1. Stop the worker; rename `runtime/profiles/yes918` to `runtime/profiles/yes918-0038`.
2. Create `accounts.json`; remove `PROVIDERS` and unused `YES918_*` settings from `.env`.
3. Rename `BOT918_*` env keys to `BOT_WORKER_*` in maxis6 `.env`; `php artisan migrate`.
4. Start the worker; check `/health`; run read operations.

Rollback: `php artisan migrate:rollback`, previous code, rename the profile folder back.
