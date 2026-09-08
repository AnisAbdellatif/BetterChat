# BetterChat

A customizable viewer for any Kick channel's chat. Open `/<channel>` (for
example `/xqc`) and the page talks to Kick directly from the browser: it
resolves the channel over Kick's REST API and subscribes to Kick's Pusher
feed itself. A small Python server (FastAPI, run with uv) hands out the
page, counts viewers from anonymous heartbeats, and shows an admin board.
One process, one hostname, published from a homelab through a Cloudflare
Tunnel.

This is the successor of the Elixir/Phoenix version (the `betterchat`
repo), which relayed chat through a server. Kick's API answers cross-origin
browser requests and its Pusher feed accepts any origin, so the relay had
nothing left to do; the frontend is the same, and what the relay did now
lives in `site/kick.js`.

## Layout

```
site/          the chat page: index.html, app.js, kick.js, config.js
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
  placeholders rendered as images, `@mentions` shown as tags, reply threads
  ("Replying to @user: ..." - hover a clipped one for the full text),
  optional timestamps.
- Recent messages are backfilled on open from Kick's history endpoint.
- Moderation: deleted messages and banned / timed-out users' messages are
  grayed out (or removed, or left alone); timeouts, bans, unbans and chat
  clears appear as lines. Pinned message banner, subscription / gifted-sub /
  host lines.
- Click a username for a user card: avatar, follower count, joined / followed
  / subscribed-for dates, badges, and the messages seen from them this
  session.
- Status pill when the connection to Kick is down or reconnecting, when the
  chat subscription is pending, or when the channel is offline (live /
  offline changes arrive in real time).

**Per-viewer settings** (gear button, saved in `localStorage`, tabbed)

- Appearance: font size and family (presets or any installed font),
  background color, message spacing, one color for all usernames, timestamps,
  scroll-back through history with a history size, user cards on/off.
- Badges: choose which badge kinds are shown.
- Filters: hide messages a user repeats within a timespan (per user), collapse
  an emote spammed back-to-back in one message, highlight messages that
  @mention you.
- Events: what to do with deleted messages, and which moderation / pin /
  sub / gift / host events to show.
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
              GET /<channel>     |     POST /api/beat (join / every 5 min / leave)
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
- `site/app.js` - rendering, filters, settings, user cards, overlay mode,
  and the heartbeat sender. `site/config.js` - Kick's public Pusher app key
  and cluster (the same values kick.com ships to every browser).
- `betterchat/main.py` - serves `site/` (every unknown path is the chat
  page, real files as-is), takes heartbeats, serves the board.
  `betterchat/stats.py` - live sessions with expiry, per-channel totals,
  a 24h series and joins per hour, persisted to a JSON file every minute
  and on shutdown.

Every viewer holds their own connection to Kick, exactly like a kick.com tab
does. Heartbeats are anonymous: a random per-tab id, the channel slug, and a
message count. "Viewers" means open tabs, not people; a tab that dies
without a `leave` drops out after 7 minutes. Message counts on the board are
the maximum any viewer of a channel reported per minute, which approximates
the channel's real rate instead of multiplying it by the viewer count.

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
| `HOST`, `PORT` | Listen address (default `0.0.0.0:8010`). |

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
  Cloudflare honors that.
