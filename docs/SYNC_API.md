# Patchcast Sync API, version 1

Base: `<server><BASE_PATH>/api/v1`. JSON, UTF-8, times in epoch **milliseconds**. Errors: `{"error": "code", "message": "text"}`.
`GET /status` (no auth) → `{name:"Patchcast Sync", version, api:1, setupRequired:false, registrationOpen:false, passwordLogin:false, oidc: {enabled:true, providerName}}`;
`GET /server-info` answers the same (404 before 0.7). Since 0.8 the three flags are always `false` and `oidc.enabled` is always `true`; they stay in the answer for
installed apps (`passwordLogin: false` = hide the password form). Incompatible changes get a new `/api/vN`.

## Authentication
Signing in only works through the server's OpenID Connect provider (0.8: there are no passwords). The provider decides who may sign in; the server
creates an account at a person's first sign-in (unless `OIDC_AUTO_CREATE=false`). Identity is the provider's issuer + `sub`.

| | |
|---|---|
| Apps | Browser flow below → `POST /auth/oidc/exchange` → `{token, deviceId, user, version}`. Then `Authorization: Bearer pct_…`. 401 = revoked: sign in again |
| Browsers | Navigate to `<server>/auth/oidc/login?returnTo=/path`; returns with an `HttpOnly` session cookie. `GET /me` → `{user, deviceId, csrf, …}`; send `X-CSRF-Token` on every non-GET |
| Both | `GET /me`, `POST /auth/logout` (revokes the calling device), `GET /devices`, `PATCH /devices/:id {name}`, `DELETE /devices/:id` (an app may only delete itself) |
| Browser only | `GET /me/account` → `{username, displayName, isAdmin, sessionVia, oidc:{providerName, issuer}, identity:{username, email, linkedAt, lastLoginAt}}`. `POST /auth/logout {provider: true}` → `{endSessionUrl}` |
| Admin, browser only | `GET /users` → `{autoCreate, providerName, users:[{id, username, displayName, isAdmin, oidc, email, lastLoginAt, podcasts, createdAt}]}` (`oidc: false` = account from 0.7 without an identity, can't sign in), `DELETE /users/:id` |

Removed in 0.8 (404): `POST /auth/login`, `POST /auth/device`, `POST /auth/setup`, `POST /auth/register`, `POST /me/password`, `POST /users` (creating a user with a password), `POST`/`DELETE /me/oidc/link`.

### App sign-in
Open in a browser (Custom Tab / `ASWebAuthenticationSession`)
`<server>/auth/oidc/app?device_name=…&code_challenge=<S256>&code_challenge_method=S256&state=<8-128 chars>&redirect_uri=patchcast://sync-callback`.
It ends at `patchcast://sync-callback?code=…&state=…` or `?error=access_denied|not_allowed|no_account|setup_first|expired|provider_unreachable|failed&state=…`
(`setup_first`: the server has no administrator yet and this person may not be the first, see the README's "First administrator").
Then `POST /auth/oidc/exchange {code, code_verifier}` → `{token, deviceId, user, version}`. The code lives 2 minutes and works once; a wrong verifier destroys it.
Ignore links whose `state` isn't yours.

429 responses carry `Retry-After`. Non-GET requests from another origin are refused.

## Identity
- **Feed**: URL without scheme, `www.`, host case and trailing slash.
- **Episode**: feed + GUID. If the server doesn't know that GUID but knows the enclosure URL (exactly, or uniquely ignoring scheme and query string), the matching
  episode's GUID is used. Without a GUID the enclosure URL is the GUID. Clients should match pulled records the same way.

## Revisions
Each user has a counter that increases with every stored change; each record carries the `rev` of its last change. A client remembers one number.

### `GET /sync?since=<rev>[&limit=1000][&feed=<url>]`
```json
{ "rev": 124, "hasMore": false, "serverTime": 1795557833945, "deviceId": "you",
  "subscriptions": [{"feedUrl","title","settings":{"speed":1.2,"priority":3,"autoQueue":null,"exclude":false},"deleted":false,"addedAt","rev","updatedAt","deviceId"}],
  "episodes": [{"feedUrl","guid","enclosureUrl","title","pubDate","played","positionMs","positionAt","durationMs","lastPlayedAt","completedAt","rev","updatedAt","deviceId","deviceName"}],
  "queue": [{"feedUrl","guid","enclosureUrl","title","auto","addedAt"}] ,
  "latest": { "…the most recently played unfinished episode, on any device…" } }
```
- Continue with `since = rev` until `hasMore` is false, and only store `rev` after applying the page.
- `queue` is the whole ordered list when any of it changed since `since`, else `null`.
- Unsubscribed podcasts come as tombstones (`deleted: true`). Records you pushed yourself also come back: ignore those with unpushed local changes.
- `feed=` limits the answer to one podcast (after subscribing to it). Don't store that `rev`.

### `POST /sync`
```json
{ "pushId": "uuid", "clientTime": 1795557833000, "mode": "merge",
  "episodes": [{"feedUrl","guid","enclosureUrl","title","pubDate","durationMs",
                "played": true, "explicitUnplayed": false, "playedChangedAt": 0, "completedAt": 0,
                "positionMs": 0, "positionChangedAt": 0, "lastPlayedAt": 0}],
  "subscriptions": [{"feedUrl","title","deleted": false,"changedAt": 0,"settings": {},"settingsChangedAt": 0}],
  "queue": {"base": [{"feedUrl","guid"}], "items": [{"feedUrl","guid","enclosureUrl","title","auto","addedAt"}], "replace": false},
  "live": {"feedUrl","guid","enclosureUrl","title","positionMs","durationMs","playing": true} }
```
Everything is optional. → `{rev, serverTime, episodes, subscriptions, queue, skipped, duplicate?}` (counts of applied and unchanged records).
A push is one transaction: if any record is invalid, nothing is stored (400).
Limits: 5000 episodes, 2000 subscriptions, 8 MB.

- **Idempotent.** Merging the same record twice changes nothing. A repeated `pushId` (kept 14 days) returns the first answer without applying anything. Persist
  the request before sending and repeat it verbatim after a lost response.
- **Clocks.** Times of change are the client's clock. The server adds `now − clientTime`, so a wrong clock doesn't matter, and caps them at its own now.
  Time 0 or 1 means "long ago" and loses to anything.
- **`mode: "force"`**: every change counts as made now ("this device wins").

### Merge rules
| | |
|---|---|
| Played | `played: true` is sticky. It is only undone by `played: false` with `explicitUnplayed` **and** a strictly newer `playedChangedAt`. After such an unplay, an older played event stays ignored |
| Position | Newest `positionChangedAt` wins, backwards too. Equal times: the larger position |
| Skew guard | A backwards move of < 15 s from a *different* device within 60 s of the stored time is ignored (it's noise, not a rewind) |
| Finishing | Resets the position to 0. Progress from before the finish can't undo it. Progress after it is a replay and leaves `played` set |
| Subscription | Newest `changedAt` wins between subscribed and deleted; a tie keeps the subscription. Pushes without `deleted` never resurrect one |
| Settings | Newest `settingsChangedAt` wins; only the keys sent are changed |
| Queue | Three-way: the difference between `base` (the list as you last synced it) and `items` is applied to the server's current list, so concurrent adds, removals and moves combine. Items finished elsewhere aren't re-added automatically. Finishing an episode or unsubscribing removes it. Removed items stay as tombstones on the server. Leave items you can't show out of `base`: the server keeps them |

### `GET /events` (server-sent events)
`hello {rev,deviceId}` on connect · `change {rev,deviceId}` something was stored (pull, unless it was you) · `progress {deviceId,deviceName,episodeId,feedUrl,guid,enclosureUrl,title,positionMs,durationMs,playing,at}`
someone is listening · `feed {feedId}` new episodes · `devices {}`. A comment every 20 s keeps it open. Offer to continue; never start playback by yourself.

## Client guidance
Push while playing every 15–30 s, and on pause, seek, stop and episode change. Push first, then pull. Don't re-save an unchanged position: it would look newer than
progress made elsewhere. Back off exponentially on errors; keep changes until a 2xx.

## Web client API (same authentication)
`GET /library`, `/podcasts/:id`, `/episodes/:id`, `/episodes/:id/chapters`, `/new?days=14`, `/queue`, `/latest`, `/search?q=` · `PUT /queue {base:[id],items:[id],auto:[id]}` ·
`POST /episodes/played {ids,played}`, `/episodes/:id/progress {positionMs,durationMs,playing,finished,changedAt,clientTime}`, `/subscriptions {url}`, `/refresh {podcastId?}` ·
`PATCH/DELETE /subscriptions/:id` · `GET /export/opml|history`, `POST /import/opml|history` (the app's formats, see `HISTORY_FORMAT.md`) ·
`GET /art/:signature/:url`, `/chapter-art/:file`, `/audio/:episodeId` (range proxy). Chapters come from Podcasting 2.0 JSON, else PSC, else the MP3's ID3 tag read with HTTP Range.
