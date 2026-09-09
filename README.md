# BetterChat

A customizable viewer for any Kick channel's chat. Open `/<channel>` (for
example `/xqc`) and the page talks to Kick directly from the browser: it
resolves the channel over Kick's REST API and subscribes to Kick's Pusher
feed itself. A small Python server (FastAPI, run with uv) hands out the
page and carries an admin board. One process, one hostname, published from
a homelab through a Cloudflare Tunnel.

**The page currently sends nothing back.** The heartbeats that fed the
board's viewer counts were taken out of `site/app.js` while the browser
extension goes through Chrome Web Store review - with no data leaving the
page there is nothing to declare and no privacy policy to stand behind yet.
Everything that received them (`POST /api/beat`, `betterchat/stats.py`,
`/admin`) is still here and still tested, so restoring the feature means
putting the sender back and nothing else. The paragraphs below describe it
as it will work again.

This is the successor of the Elixir/Phoenix version (the `betterchat`
repo), which relayed chat through a server. Kick's API answers cross-origin
browser requests and its Pusher feed accepts any origin, so the relay had
nothing left to do; the frontend is the same, and what the relay did now
lives in `site/kick.js`.

## Layout

```
site/          the chat page: index.html, app.js, kick.js, config.js, sw.js,
               privacy.html
betterchat/    the server: main.py (routes), stats.py (heartbeats -> stats), admin.html
tests/         pytest (server) + node --test (kick.js)
pyproject.toml, uv.lock, Dockerfile, docker-compose.yml, .env.example
```

## Features

**Chat rendering**

- Badges before the username in Kick's order: the channel's own subscriber
  badge images, drawn SVGs for moderator / VIP / OG / broadcaster / founder /
  verified / staff / bot, and Kick's hosted images for chat level and event
  badges.
- Username in the sender's Kick identity color, `[emote:id:name]`
  placeholders rendered as images, `@mentions` shown as tags once the name is
  confirmed to be a real user (people write `@everyone` and `@ 8pm` too, so an
  `@word` stays plain text until the name is known: anyone the page has
  already seen counts, anything else is looked up once, one request at a time,
  and both answers are cached), reply threads
  ("Replying to @user: ..." - hover a clipped one for the full text),
  optional timestamps.
- Recent messages are backfilled on open from Kick's history endpoint.
- Moderation: deleted messages and banned / timed-out users' messages are
  grayed out (or removed, or left alone); timeouts, bans, unbans and chat
  clears appear as lines. Pinned message banner, subscription / gifted-sub /
  host lines.
- The pinned banner hides rather than closes: hiding it puts a pin button
  under the gear that brings it back, and a newly pinned message shows again
  on its own. Turn on "start collapsed" and it goes the other way - a pin
  arrives collapsed to that button and only opens when you say so, on
  reconnects included.
- Click any username for a user card: avatar, follower count, joined /
  followed / subscribed-for dates, badges, and the messages seen from them
  this session. Works on the message author, `@mentions` inside a message,
  the user a reply is aimed at, the pinned message's author, and the names in
  moderation and event lines (both the user banned and the moderator who
  banned them).
- Status pill when the connection to Kick is down or reconnecting, when the
  chat subscription is pending, or when the channel is offline (live /
  offline changes arrive in real time).

**Per-viewer settings** (gear button, saved in `localStorage`, tabbed)

- Appearance: font size and family (presets or any installed font),
  background color, message spacing, one color for all usernames, timestamps,
  scroll-back through history with a history size, user cards on/off.
- Badges: choose which badge kinds are shown, and drag them (or use each
  row's arrows) into the order they are drawn in next to usernames. Badges of
  the same kind keep Kick's own order within it.
- Filters: hide messages a user repeats within a timespan (per user), collapse
  an emote spammed back-to-back in one message, highlight messages that
  @mention you.
- Events: what to do with deleted messages, which moderation / pin / sub /
  gift / host events to show, and whether a pinned message starts collapsed.
- Overlay & sharing: fade-out time for the OBS overlay, copy an overlay or
  settings link, export / import settings as JSON, reset.

**Settings in the URL.** Any setting can be a query parameter
(`/xqc?fontSize=16&monocolor=1&hiddenBadges=level,event`). URL settings
override stored ones and are not saved.

**OBS overlay mode.** `/xqc?overlay=1` is a transparent, control-free page
whose messages fade out after the configured number of seconds.

**Admin board.** `/admin`: viewers now, channels watched, messages seen,
joins, watch time, a 24-hour viewers chart, joins per hour, and a
per-channel table. HTTP Basic Auth; a 404 until credentials are set.

## How it works

```
 Kick REST API  <-- fetch --  browser  -- WebSocket -->  Kick's Pusher
 (channel, pin,              (kick.js +                 (chatrooms.<id>.v2,
  history, user)              app.js)                    channel.<id>)
                                 |
              GET /<channel>     |     POST /api/beat  (sender removed for now)
                                 v
                        betterchat server (uv)  -->  GET /admin
```

- `site/kick.js` - the former backend, in the browser:
  - `KickApi`: channel resolution (ids, subscriber badge tiers, live flag),
    pinned message + last messages, user cards; small in-memory TTL cache.
  - `PusherRelay`: one WebSocket to Kick's Pusher feed, subscribed to the
    chatroom channel (chat) and the channel channel (live / offline), with
    ping/pong keepalive from Kick's `activity_timeout` and reconnect with
    exponential backoff.
  - `normalizeMessage` / `normalizeEvent`: Kick's raw payloads into the
    shapes `app.js` renders.
- `site/app.js` - rendering, filters, settings, user cards and overlay
  mode. `site/config.js` - Kick's public Pusher app key
  and cluster (the same values kick.com ships to every browser).
- `betterchat/main.py` - serves `site/` (every unknown path is the chat
  page, real files as-is), takes heartbeats, serves the board, and answers
  `/privacy` with `site/privacy.html`. That route is registered before the
  catch-all on purpose: otherwise `/privacy` would be read as a channel slug
  and the viewer would go looking for a Kick channel by that name.
  `betterchat/stats.py` - live sessions with expiry, per-channel totals,
  a 24h series and joins per hour, persisted to a JSON file every minute
  and on shutdown.

Every viewer holds their own connection to Kick, exactly like a kick.com tab
does. Heartbeats were anonymous: a random per-tab id, the channel slug, a
message count, and whether the page is embedded. "Viewers" means open tabs,
not people; a tab that dies
without a `leave` drops out after 7 minutes. Message counts on the board are
the maximum any viewer of a channel reported per minute, which approximates
the channel's real rate instead of multiplying it by the viewer count.

## Surviving an outage

`site/sw.js` caches the shell and the scripts, so the page loads even when
this server doesn't answer. That is worth more here than for most sites:
the chat is entirely client-side, so a cached load is a fully working one -
`kick.js` reaches kick.com directly for the API and the Pusher feed, and
with the heartbeats gone the page asks this origin for nothing at all once
it has loaded.

Navigations are network-first, so a deploy is picked up straight away and
the cached shell is only used when the origin can't be reached. Scripts are
stale-while-revalidate: instant from cache, refreshed in the background, so
a viewer is one load behind at worst. **Bump the version in `site/sw.js` when
you change a file the worker caches** - the shell, `app.js`, `kick.js`,
`config.js` - since with no build step and no hashed filenames that constant
is the only thing that retires an old cache.

The version is two numbers, `v<MAJOR>.<MINOR>`:

- **`MINOR` is the everyday bump.** Edited `app.js`? Bump `MINOR`, nothing
  else. This is what almost every deploy does.
- **`MAJOR` is for caching itself changing** - a different set of cached
  assets, a different strategy, or a shell that an old cached copy could not
  work with. Bump it and reset `MINOR` to `0`.

The browser only cares that the string differs from the last one, since
`activate` drops every cache that is not the current one; the split is there
to keep the routine bump small and to make a real change to the caching
behaviour stand out in a diff. Editing `sw.js` itself needs no bump:
browsers compare the worker byte for byte and install a changed one on their
own.

`/privacy` is deliberately left to the network. Navigations are cached under
one fixed shell key, so caching the policy would overwrite the chat page an
offline viewer gets served.

## Running it

Needs [uv](https://docs.astral.sh/uv/) (Python 3.12+ is fetched by uv).

```bash
uv sync
cp .env.example .env        # set ADMIN_USER / ADMIN_PASSWORD (loaded automatically)
uv run betterchat
# http://localhost:8010/xqc   and   http://localhost:8010/admin
```

Tests:

```bash
uv run pytest        # server: heartbeats, auth, site serving, persistence
npm test             # kick.js: normalizers, API client (fake fetch), relay framing (Node)
```

| Variable | Purpose |
| --- | --- |
| `ADMIN_USER`, `ADMIN_PASSWORD` | Enable `/admin` (both required). |
| `STATS_PATH` | Persisted stats file (default `data/stats.json`; `/app/data/stats.json` in Docker). |
| `SITE_DIR` | The static site (default: `site/` in the repo). |
| `FRAME_ANCESTORS` | CSP `frame-ancestors` for the site, e.g. `'self' https://kick.com`. Unset sends no header. |
| `HOST`, `PORT` | Listen address (default `0.0.0.0:8010`). |

## Embedding it in kick.com

An extension can drop the chat into kick.com's page in place of the official
one by framing `https://betterchat.tech/<channel>?embed=1`. The extension
still passes `?embed=1`, but nothing reads it while the sender is out; it is
what tagged beats `source: "embed"` so the board could report extension
viewers separately (an "Embedded" column, and the split under "Viewers
now"). When the heartbeats come back no CORS is involved: inside the frame
the page's origin is still this server, so a relative `/api/beat` resolves
here rather than to kick.com.

Two things the embedding side owns:

- **Channel changes.** kick.com is an SPA, so a viewer going from `/xqc` to
  `/clix` never reloads. Point the iframe's `src` at the new channel; the
  tab id lives in `sessionStorage` and survives, and a beat naming a
  different channel already ends the old session and starts a new one.
- **Framing.** kick.com's own CSP decides whether the frame loads at all.
  On this side, set `FRAME_ANCESTORS` to pin who may embed the page.

Per-viewer settings are stored per-origin, so an embed keeps its own
`localStorage` and does not inherit settings from a direct visit.

## Publishing (homelab + Cloudflare Tunnel)

```bash
cp .env.example .env         # ADMIN_USER / ADMIN_PASSWORD
docker compose up -d --build
```

Then set the tunnel's public hostname `betterchat.tech` to
`http://localhost:8010` (or the `HOST_PORT` you set in `.env`; the
container itself always listens on 8010). That one origin serves the chat,
receives the heartbeats, and hosts `/admin`. The image is built from
`ghcr.io/astral-sh/uv:python3.12-bookworm-slim` with no apt-get at all;
stats persist on the `betterchat-data` volume.

`/admin` is Basic Auth over the tunnel's TLS. A Cloudflare Access policy on
`/admin*` in front of it is free and worth adding.

## Deploying on a push

`.github/workflows/deploy.yml` runs the tests on GitHub's runners and, if they
pass, pulls and rebuilds on the VPS. The deploy half runs on a **self-hosted
runner installed on the VPS itself**, which dials out to GitHub for its work,
so there is no inbound port to open, no SSH key to hand to GitHub, and nothing
to change in Oracle's security list. It does what deploying by hand did, in
the clone already on the box, so the `.env` beside it and the compose project
name - and with it the `betterchat-data` volume - are untouched.

Set it up once, as a normal user on the VPS (not root):

```bash
# The runner needs to own the clone and be able to talk to Docker.
sudo chown -R "$USER" /opt/betterchat
sudo usermod -aG docker "$USER"   # log out and back in for this to take

mkdir -p ~/actions-runner && cd ~/actions-runner
# Take the current URL from GitHub: repo -> Settings -> Actions -> Runners
# -> New self-hosted runner (Linux, and pick x64 or ARM64 to match the VPS).
curl -o runner.tar.gz -L <url from that page>
tar xzf runner.tar.gz
./config.sh --url https://github.com/AnisAbdellatif/BetterChat \
            --token <token from that page> --labels betterchat
sudo ./svc.sh install "$USER"     # run it as a service, not in your shell
sudo ./svc.sh start
```

The `betterchat` label is what the workflow asks for, so the name has to
match. If the clone lives somewhere other than `/opt/betterchat`, set a
repository variable `DEPLOY_DIR` to its path rather than editing the
workflow.

After that, a push to `master` deploys. The Actions tab shows each run, the
"Deploy" workflow can be re-run by hand from there, and the job fails loudly
if the container does not come up healthy - it waits on the image's own
`HEALTHCHECK` rather than guessing at timing. Two deploys never overlap: a
push landing mid-build queues behind it instead of cancelling it.

Worth knowing: the pull is `--ff-only`, so if the checkout on the box has been
edited by hand the deploy stops and says so instead of inventing a merge
commit on a server. Old image layers are pruned after every run, which on a
small boot volume matters more than it sounds. The container restarts during
the rebuild, so expect a few seconds of 502 through the tunnel.

## Things to know

- Kick's REST API and Pusher feed are unofficial. If Kick ever restricts
  cross-origin access, `KickApi` takes a `baseUrl`, so the calls can be
  pointed at a small proxy without touching the rest.
- Ban, reply and pinned-message payload shapes were captured live; deletion,
  subscription, gift, host and stream live / offline follow Kick's documented
  payloads. Add `?debug=1` to log events the page doesn't recognize to the
  browser console.
- The site has no build step, so script names never change; the server
  sends `must-revalidate` for files and `no-cache` for the page, and
  Cloudflare honors that. Because the names never change, a long `max-age`
  is not an option - it would pin viewers to stale JS with no way to break
  out. Versioning lives in the service worker instead.

## Trademarks

Kick and the Kick logo are trademarks of their respective owners. BetterChat
is an independent, unofficial project with no affiliation with Kick: it is
not made, endorsed, sponsored or reviewed by them, and it uses their name
only to say which service it works with.
