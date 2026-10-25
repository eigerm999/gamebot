# game-bot

Browser-backed worker that performs player operations on game agent portals
that have no usable API. Maxis6 (Laravel) calls it over HTTP; the worker drives
a real Chrome session per portal account with Playwright.

Only use it with portal accounts you are authorized to automate. It never
bypasses CAPTCHA, MFA or WAF challenges.

## Providers and operations

Every provider exposes the same operation names. Unimplemented ones are
rejected with `unsupported_operation`.

| Operation | yes918 |
| --- | --- |
| `createPlayer` | ✅ |
| `playerInfo` | ✅ (read-only) |
| `setScore` | ⏳ portal meaning of "new score" unconfirmed |
| `resetPassword` | ✅ |
| `disablePlayer` | ✅ (`enable: true` re-enables) |
| `gameLog` | ✗ no portal endpoint found |
| `kickPlayer` | ✅ |

## Setup

```sh
npm ci
npm run browser:install
cp .env.example .env    # fill WORKER_SECRET and the provider's settings
npm start
curl -s http://127.0.0.1:8918/health
```

`/health` returns 200 when every enabled provider has a browser and an
authenticated session, 503 otherwise (`/health?provider=yes918` for one).

- `HEADLESS=false` shows the browser. If a login stops at a challenge, finish
  any permitted manual step in that window.
- Each provider's session lives in `runtime/profiles/<provider>` (gitignored)
  and survives restarts. Delete the folder to force a fresh login.
- `<PROVIDER>_PROXY_SERVER` routes that provider's browser through a proxy.
  Use a **static** IP; rotating IPs break logins and trigger WAF blocks.

## API

`POST /v1/operations` with `Authorization: Bearer <WORKER_SECRET>`:

```json
{
  "operationId": "uuid (one per attempt, from the caller)",
  "provider": "yes918",
  "operation": "createPlayer",
  "fingerprint": "sha256 hex of the caller's request data",
  "params": { "amount": "10.00" }
}
```

Response:

```json
{ "operationId": "…", "outcome": "succeeded", "result": { "playerId": "…", "password": "…", "score": "10.00" } }
{ "operationId": "…", "outcome": "failed",  "error": { "code": "…", "message": "…" } }
{ "operationId": "…", "outcome": "unknown", "error": { "code": "…", "message": "…" } }
```

| Outcome | Meaning |
| --- | --- |
| `succeeded` | Portal confirmed the change |
| `failed` | Nothing changed on the portal; safe to try again |
| `unknown` | The change may have happened: check the portal by hand, never retry blindly |

Unknown fields, providers or operations are rejected. Repeating a finished
`operationId` returns the stored answer instead of acting twice. Each provider
runs one operation at a time; with more than `MAX_WAITING` queued, new requests
get `failed` / `busy` immediately.

## Adding a provider or operation

1. Create `src/providers/<key>/index.js` exporting `createProvider()` that
   returns `{ key, proxy, ensureLoggedIn(page, config), operations }`.
   Read settings from `<KEY>_*` environment variables.
2. Register it in `src/providers/index.js`.
3. Each operation provides:
   - `validate(params)`: return an error code for anything unexpected.
   - `run({ session, params, ctx })`: use `session.pageFetch()` for same-origin
     portal calls. Call `ctx.assertCanSubmit()` immediately before the request
     that changes the portal. Throw `failed(...)` only when the portal certainly
     did not change, and `unknown(...)` for anything after submission that is
     not an explicit rejection.

## Production

Run on a VPS (not shared hosting) under systemd or PM2 with `HEADLESS=true`.
The worker listens on `127.0.0.1` only; expose it to Laravel through an HTTPS
reverse proxy (e.g. Caddy) restricted to the Laravel server's IP.
