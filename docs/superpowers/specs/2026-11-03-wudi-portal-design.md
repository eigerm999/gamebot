# Wudi portal plugin

**Status:** approved 2026-11-03
**Portal:** https://wdbo.wg365.xyz
**Maxis6 game:** title `WUDI-BOT`, display name `WUDI`
**Worker account:** `wudi-spadik`

## Decisions

- Maxis6 may accept an initial amount. It persists the confirmed Wudi member
  locally at balance 0 first, then performs a separate durable `setScore`
  operation. A failed/unknown/local-ledger result is returned as `partial` with
  the generated credentials still visible; agent credit moves only after the
  remote deposit is confirmed and its local transaction commits. The parent
  create operation stores the requested amount and remains unresolved until
  the score reaches a final state. A new Create ID is blocked while an earlier
  workflow for that agent/game is unresolved, preventing blind duplicate IDs.
  Unknown or remotely-confirmed-but-unpersisted initial deposits reserve the
  requested agent credit and block Set Score for that player until support
  reconciles the operation; confirmed deposit failure releases the reservation.
- Maxis6 holds the agent credit lock for up to 240 seconds; this covers two
  75-second worker calls, an optional 30-second bonus call and DB overhead.
- The worker create operation itself remains zero-only (`maxInitialScore: "0"`)
  so no caller can accidentally combine the two remote mutations.
- Generated usernames are `wd` plus 10 random digits. Passwords use the
  existing `Aaa123`-style generator (valid portal range 5-20).
- Set Score is unlimited per transaction (`null` in Maxis config); Maxis agent
  credit and player withdrawal balance still apply.
- Wudi modifying requests use the portal application's own loaded Axios client.
  The plugin dynamically finds an Axios instance whose base URL is `/prod-api`;
  it does not depend on the current webpack module ID (`b775`) and does not
  reproduce or bypass the portal's AES/RSA request encryption.
- If the request client disappears after a portal frontend update, health and
  operations fail closed. Nothing is sent unencrypted.

## REA evidence

- Member page/scenario: `ev_ce855536114f63f9bae320cc64ea81b41916482acf1438897feba5c8639a4df6`
- Member script export: `ev_f2c23db15a91685f2eeedf978dded0e011650d48ebeb6e68a0dcd7f6cdfc42d5`
- Score history: `ev_f7d0b58cd868c6c5a932f3e78574b1b31af34b2edd6c552c21f1abdde0bd73ab`
- Detailed game records: `ev_e3107661c179a492e9d3a0ec666bc6410bb55f5f9924858c7c27a8ad601730a8`
- Trading history: `ev_303e4f827eb21c3a8b6bec3a2595c1f0d4ce082447b3f7c6a0350cfdd787e85d`
- Online players: `ev_4116101109d6f4842aa90fd8914cd515b414226cd462ea256bb45704628e66ef`
- Login page: `ev_b9b95dfc1ae5bfbae9cebc445d744d1908699bba5b45ec8d672688649b3a72fa`

Static bundle findings establish endpoint code and fields, not successful
execution of modifying calls. Runtime probes only called GET endpoints.

## Operations

| Operation | Portal call |
| --- | --- |
| find player | `GET /prod-api/user/front/list` |
| create | encrypted `POST /prod-api/user/front` (`userName`, `nickName`, `password`) |
| info/balance | `GET /prod-api/user/front/getUserWalletByUserId?userId=` |
| set score | encrypted `PUT /prod-api/user/front/balance` (`userWalletId`, signed `balanceMoney`, `remark`) |
| reset password | encrypted `PUT /prod-api/user/front/resetPwd` (`userId`, `password`) |
| enable/disable | encrypted `PUT /prod-api/user/front/updateUserStatus` (`userId`, `status`; 0 enabled, 1 disabled) |
| kick | encrypted `POST /prod-api/user/front/logoutUser` (`userId`) |
| score log | `GET /prod-api/user/balance_changes/list` (types 1 credit, 2 debit) |
| game log | `GET /prod-api/user/front/gainLossDetail` |
| agent balance | `GET /prod-api/user/front/sysLoginUserWallet` |

A resolved body with `code: 200` confirms success. `submitOnce` captures the raw
network response around the portal Axios call, so explicit non-200 application
codes remain available even though the page's response interceptor rejects them.
Transport loss after submission is `unknown`. For create, set score and status,
a read-back can confirm the resulting state but never triggers a retry.

## Login and session

Login fields are username and password. `GET /prod-api/captchaImage` currently
returns `captchaEnabled: false`. Login submits encrypted `/login` through the
rendered app and stores `Admin-Token` in the persistent browser profile.
If CAPTCHA becomes enabled, automatic login stops with `login_challenge`; an
operator must use visible Chrome to complete the permitted challenge.

## Runtime unknowns before live mutation test

- Exact successful and rejected response bodies for modifying endpoints are
  inferred from the common response interceptor (`code: 200` succeeds).
- The only test member has no completed game record; game-log mapping follows
  the loaded component fields.
- After implementation, use a new zero-balance test member: create at 0,
  deposit 0.10, verify balance/history, withdraw 0.10, reset password,
  disable/enable and kick. Each mutation requires explicit approval.
