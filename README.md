# Patchcast Sync

[MIT licensed](LICENSE). The server and its web player are open source; the Patchcast Android app that talks to it is a separate, closed-source project. The sync protocol is documented in [`docs/SYNC_API.md`](docs/SYNC_API.md), so other clients can use it.

A small self-hosted server that keeps Patchcast's subscriptions, listening progress, Up Next and per-podcast settings in
sync between phones, and a web player for listening on a PC. One container, one SQLite file, no other services.
It never downloads or stores audio: browsers stream from the podcast's own host.

## Quick start (home network)
```sh
git clone https://github.com/sp3lllz/patchcast-server && cd patchcast-server
docker compose up -d --build
docker compose logs patchcast        # shows the one-time setup token
```
Open `http://<this machine>:8080`, enter the token and create the administrator. (Or set `ADMIN_USER` and
`ADMIN_PASSWORD` in `.env` before the first start. Remove the password from `.env` afterwards.)

Prebuilt images are published to `ghcr.io/sp3lllz/patchcast-server` by `.github/workflows/server-image.yml` on version tags.
Pull it with `docker pull ghcr.io/sp3lllz/patchcast-server:<version>`, or build from source as above.

### Connect the app
Patchcast → Settings → **Sync with your server** → server address (`192.168.1.10:8080` or `https://pods.example.com`),
username, password (or **Sign in with Pocket ID**, if set up) → choose what wins if both sides differ (Merge is right almost always) → **Sign in and sync**.

## Configuration
Environment variables only; see `.env.example`.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Port inside the container |
| `DATA_DIR` | `/data` | SQLite database, session secret, art cache |
| `BASE_PATH` | empty | Path prefix such as `/podcasts`. The proxy must **not** strip it |
| `PUBLIC_URL` | empty | Public origin, e.g. `https://pods.example.com`. Makes cookies `Secure` and is accepted as `Origin` |
| `TRUST_PROXY` | `false` | Whose `X-Forwarded-*` to believe: `false`, a number of hops, IPs/CIDRs, or `loopback,uniquelocal` |
| `ALLOW_REGISTRATION` | `false` | Let anyone create an account. The first account always needs the setup token |
| `SESSION_SECRET` | generated | 32+ characters. Generated into `DATA_DIR/session-secret` when empty. Changing it signs everybody out |
| `FEED_REFRESH_MINUTES` | `60` | 5–1440 |
| `LOG_LEVEL` | `info` | `trace` … `fatal`, `silent` |
| `TZ` | UTC | Server time zone. Dates in the web client use the browser's |
| `ADMIN_USER`, `ADMIN_PASSWORD` | empty | Create the administrator on first start instead of the setup token |
| `SSRF_ALLOW_HOSTS` | empty | `host[:port],…` on your LAN that may be fetched despite the private-address block |

Compose-only variables: `HTTP_PORT`, `BIND`, `PATCHCAST_IMAGE`, `PATCHCAST_HOST`, `PATCHCAST_RULE`, `TRAEFIK_NETWORK`, `TRAEFIK_CERTRESOLVER`.

## Pocket ID setup
Sign in on the web and in the app with [Pocket ID](https://pocket-id.org) (any OpenID Connect provider with discovery works; Pocket ID 2.19 is what was tested).
The examples use `https://auth.example.com` (Pocket ID) and `https://pod.example.com` (this server).

**1. In Pocket ID** → Administration → OIDC Clients → Add:

| Field | Value |
|---|---|
| Name | `Patchcast` |
| Callback URLs | `https://pod.example.com/auth/oidc/callback` (exactly; = `PUBLIC_URL` + `BASE_PATH` + `/auth/oidc/callback`) |
| Logout Callback URLs | `https://pod.example.com/` (only used by "Sign out of Pocket ID too") |
| Public client | off |
| PKCE | on |
| Launch URL (optional) | `https://pod.example.com/` |

Do **not** register `patchcast://…` there: the phone app talks to this server, and only this server talks to Pocket ID.
Copy the client ID and secret. If the client is restricted to user groups, Pocket ID itself turns everyone else away.

**2. Environment**

| Variable | Default | Meaning |
|---|---|---|
| `OIDC_ISSUER`, `OIDC_CLIENT_ID` | empty | Both set = on. Needs `PUBLIC_URL` |
| `OIDC_CLIENT_SECRET` or `OIDC_CLIENT_SECRET_FILE` | empty | Secret, or a file containing it. Without one the client is treated as public (PKCE only) |
| `OIDC_SCOPES` | `openid profile email groups` | `groups` is only needed for the two group settings |
| `OIDC_PROVIDER_NAME` | `Pocket ID` | Text on the buttons |
| `OIDC_AUTO_CREATE` | `true` | The first sign-in creates an ordinary user. `false`: only linked accounts get in |
| `OIDC_ALLOWED_GROUPS` | empty | Comma-separated group *names* (not friendly names); empty = everybody Pocket ID lets through. Admin groups must be listed too |
| `OIDC_ADMIN_GROUPS` | empty | Members become administrators, others stop being one, at each sign-in. The last administrator is never demoted |
| `OIDC_PASSWORD_LOGIN` | `true` | `false` switches password sign-in and registration off. It only takes effect once an administrator is linked to this issuer |

Claims used: `sub`, `preferred_username`, `name`, `email`, `groups` (from the ID token, else userinfo). Local user names come from `preferred_username`,
else the part of the email before `@`, with `-2`, `-3`… if taken.

Compose snippet for a homelab with Traefik on network `proxy` and certificate resolver `letsencrypt` (secrets in `patchcast.env`, not in the repository):
```yaml
  patchcast:
    image: ghcr.io/sp3lllz/patchcast-server:0.7.0
    container_name: patchcast
    restart: unless-stopped
    env_file:
      - path: ./patchcast.env      # OIDC_CLIENT_ID=…  OIDC_CLIENT_SECRET=…
        required: false
    environment:
      PUBLIC_URL: https://pod.example.com
      TRUST_PROXY: uniquelocal
      OIDC_ISSUER: https://auth.example.com
    volumes: [patchcast-data:/data]
    networks: [proxy]
    read_only: true
    tmpfs: [/tmp]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    labels:
      - traefik.enable=true
      - traefik.docker.network=proxy
      - traefik.http.routers.patchcast.rule=Host(`pod.example.com`)
      - traefik.http.routers.patchcast.entrypoints=websecure
      - traefik.http.routers.patchcast.tls.certresolver=letsencrypt
      - traefik.http.services.patchcast.loadbalancer.server.port=8080
# and at the end of the file
volumes:
  patchcast-data:
```

**3. First start**
1. Complete the normal setup (setup token from the log) and create your local administrator.
2. Signed in as that administrator: Settings → Account → **Link Pocket ID**. Do this *before* ever using "Sign in with Pocket ID":
   identities are matched by issuer and `sub` only, never by name or email, so an unlinked sign-in creates a second account.
   (Happened anyway? Delete that second user under Users, then link.)
3. Phone: Settings → Sync → server address → **Sign in with Pocket ID**. The browser opens, and the phone receives a device token that you can revoke in the web client.
4. Optional: `OIDC_PASSWORD_LOGIN=false`.

**Locked out** (Pocket ID gone, passkey lost): `echo 'new password' | docker exec -i patchcast node /app/server.mjs set-password patch`
sets a password and, even with `OIDC_PASSWORD_LOGIN=false`, opens password sign-in for that user for 24 hours.

Good to know
- Removing somebody in Pocket ID stops new sign-ins; their browser sessions (30 days) and phone tokens here stay valid. Revoke those under Devices, or delete the user.
- The container must reach the issuer's URL. For a private CA mount it and set `NODE_EXTRA_CA_CERTS`.
- The issuer may be on a private address. Other hosts named by its discovery document may not (`SSRF_ALLOW_HOSTS`).
- Pocket ID's own *Cancel* button goes to Pocket ID's page rather than back here: just close the tab.
- Testing on one machine: `examples/pocket-id-local.yml` and `examples/oidc-local.yml`.

## Traefik v3
Assumes Traefik runs with the Docker provider, entrypoints `web` (:80) and `websecure` (:443), and a certificate resolver.
1. `cp .env.example .env` and set `PATCHCAST_HOST=pods.example.com`, `TRAEFIK_NETWORK` (the Docker network Traefik is on) and
   `TRAEFIK_CERTRESOLVER` (its name in your Traefik configuration).
2. `docker compose -f docker-compose.traefik.yml up -d --build`
3. `docker compose -f docker-compose.traefik.yml logs patchcast` → setup token → `https://pods.example.com`.

What the labels do: an HTTPS router with your resolver, an HTTP router that redirects to HTTPS, port 8080 with a
`/healthz` check, and no published ports. `TRUST_PROXY=uniquelocal` makes the server believe forwarded headers only from
private addresses (Traefik on the Docker network). Traefik itself discards `X-Forwarded-*` sent by clients unless you
configured `forwardedHeaders` otherwise.

**Below a path** (`https://example.com/podcasts`):
```
PATCHCAST_HOST=example.com
BASE_PATH=/podcasts
PATCHCAST_RULE=Host(`example.com`) && PathPrefix(`/podcasts`)
```
Don't add `StripPrefix`. In the app enter `https://example.com/podcasts`.

**Timeouts.** Event streams and proxied audio are long responses: leave Traefik's `writeTimeout` at 0 (the default), and don't
put `buffering` or `compress` middlewares on this router.

**Try it on one machine** with a self-signed certificate: see the command at the top of `examples/traefik-local.yml`.

## Other reverse proxies
Set `PUBLIC_URL`, `TRUST_PROXY=loopback` (proxy on the host; then also `BIND=127.0.0.1`) or the proxy's address.

Caddy: `pods.example.com { reverse_proxy 127.0.0.1:8080 }`

nginx:
```nginx
location / {
  proxy_pass http://127.0.0.1:8080;
  proxy_http_version 1.1;
  proxy_set_header Host $http_host;
  proxy_set_header X-Forwarded-Host $http_host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-For $remote_addr;
  proxy_buffering off;            # event stream and audio
  proxy_read_timeout 1h;
  client_max_body_size 32m;       # history import
}
```

## Backup, restore, upgrade
```sh
# Backup: stop for a moment so the database file is complete.
docker compose stop && docker run --rm -v patchcast_data:/data -v "$PWD":/out alpine tar czf /out/patchcast-backup.tgz -C /data . && docker compose start
# Restore into an empty volume
docker compose down && docker run --rm -v patchcast_data:/data -v "$PWD":/in alpine sh -c 'cd /data && tar xzf /in/patchcast-backup.tgz && chown -R 1000:1000 .' && docker compose up -d
# Upgrade
git pull && docker compose up -d --build
```
The database migrates itself on start; a newer database refuses to open in an older server. `cache/` inside the volume can be
left out of backups. Using a bind mount instead of the named volume: `chown 1000:1000` the directory first.

Forgotten password: `echo 'new password' | docker compose exec -T patchcast node /app/server.mjs set-password patch`

Seeding from a phone: not needed, signing in uploads everything. Files from **Export history** / **Export OPML** can also be imported in the
web client's Settings, and exported again.

## Security notes
- **Use HTTPS for anything reachable from the internet.** Plain http exposes the password and session to whoever is on the path.
  This is deliberately not enforced in code, because http on a home LAN is a legitimate setup. The app warns about http on public hosts.
- Passwords: argon2id (19 MiB, 2 passes). Sign-in attempts are limited per address + user (5 per 15 min), per address (20) and per user (100).
- Browsers: random session id in an `HttpOnly; SameSite=Strict` cookie (`Secure` over HTTPS), CSRF token on every change,
  `Origin`/`Sec-Fetch-Site` checks, strict CSP, no CORS. Phones: one revocable random token each. Only keyed hashes are stored.
- Device tokens can sync and play, but can't change passwords, manage users or revoke other devices.
- Everything fetched from a URL (feeds, art, chapters, audio) goes through one guarded client: http/https only, every DNS answer and every
  redirect checked against private, loopback, link-local, CGNAT and metadata ranges at connect time, with size and time limits.
- OIDC: Authorization Code with PKCE, `state` bound to a short-lived `HttpOnly` cookie and usable once, ID token fully verified (signature with asymmetric
  algorithms only, `iss`, `aud`, `azp`, `exp`, `iat`, `nonce`, `at_hash`). The app's code is single use, valid 2 minutes, bound to its PKCE challenge, and only sent to
  `patchcast://sync-callback`. Another app on the phone could claim that scheme, but can't redeem the code without the verifier.
- Art URLs are signed, only raster images are served, and show notes are sanitised.
- The audio proxy is only used when a browser can't play a host directly. It streams, stores nothing, and only serves episodes of the user's podcasts.
- Logs contain method, path, status and address: never bodies, headers, query strings, tokens or passwords. The one exception is the one-time setup token.
- The container runs as uid 1000 with a read-only root file system, no capabilities and `no-new-privileges`.

## API and development
[docs/SYNC_API.md](docs/SYNC_API.md). `npm ci --ignore-scripts && npm test && npm run build && DATA_DIR=./data npm start` (Node ≥ 24.7).

## Licence

MIT, see [LICENSE](LICENSE).
