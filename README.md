# BetterChat

A customizable viewer for any Kick channel's chat. Open `/<channel>` (for
example `/xqc`) and the page talks to Kick directly from the browser: it
resolves the channel over Kick's REST API and subscribes to Kick's Pusher
feed itself. A small Python server (FastAPI, run with uv) hands out the
page and carries an admin board. One process, one hostname, published from
a VPS with Kamal (see "Deploying").

**The page sends nothing back unless the viewer agrees to it.** The
heartbeats that feed the board's viewer counts are opt-in: the first visit
asks, in as many words, and until it is answered nothing is sent. Either
answer is remembered with the other settings and can be changed later under
*Overlay & sharing*. A shared settings link or an exported file never carries
it, so consent cannot be handed to anyone else - it is given in the viewer's
own browser or not at all.

This is the successor of the Elixir/Phoenix version (the `betterchat`
repo), which relayed chat through a server. Kick's API answers cross-origin
browser requests and its Pusher feed accepts any origin, so the relay had
nothing left to do; the frontend is the same, and what the relay did now
lives in `site/kick.js`.

## Layout

```
site/          the chat page: index.html, app.js, settings.js, defaults.json, kick.js,
               config.js, sw.js, privacy.html
betterchat/    the server: main.py (routes), stats.py (heartbeats -> stats), admin.html
tests/         pytest (server) + node --test (kick.js, settings.js)
config/        Kamal's deploy config (production and dev destinations)
.kamal/        deploy-kit: the vendored kit, its settings and hook shims
deploy/        the host's Caddy site blocks, the server's env file template
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
- **Moderating, inside the KickPlus extension only.** Hovering a message
  floats a small bar of controls above it - reply, pin, delete, whichever of
  them apply - rather than laying buttons over the text, since hovering a
  message is how you read the thing you are about to act on. A user card gains
  timeout (1m / 5m / 15m / 1h / 1d) and ban, or unban for anyone currently
  banned or timed out. This page has no
  Kick session of its own and never will - that
  is what makes it safe to open anywhere - so it asks the extension, whose
  content script is on kick.com and can act as the signed-in moderator. On
  betterchat.tech or in an overlay nothing answers the handshake and no
  controls appear. Nothing is announced on success: Kick broadcasts the ban
  or deletion and the chat already draws it. A refusal from Kick is shown as
  a line, and a 403 hides the controls for the rest of the session. The bar
  also carries **pin**, which pins for Kick's own default of 20 hours, and the
  banner then carries **Unpin** beside its hide button - unpinning takes it
  off the channel where hiding only takes it off this tab, which is why one
  says a word and the other is a glyph. Neither draws anything itself: Kick
  broadcasts both, and this page has always drawn those events.
- **Replying, inside the KickPlus extension only.** The hover bar's reply
  button arms one, and a bar along the bottom then says what the next message
  will reply to, with Escape or its own button to cancel. This page
  has no message box: Kick's is still there below the frame, and that is what
  the viewer types in. So the button only says *which* message, and the
  extension makes the next message typed into Kick's box a reply to it.
  It is a separate permission from moderating - anyone signed in can reply -
  so the two buttons appear independently of each other. The bar is drawn from
  what the extension reports rather than from the click, so it cannot claim a
  reply that has already gone out or been dropped on a channel switch. If Kick
  refuses the send, the text comes back with the reason and is shown as a
  line, since Kick's box has already been cleared by then.
- Status pill when the connection to Kick is down or reconnecting, when the
  chat subscription is pending, or when the channel is offline (live /
  offline changes arrive in real time).
- A clear button under the gear empties the chat in this tab. It is local
  only - nothing is sent to Kick and nobody else's chat changes - which is why
  it is an eraser rather than a bin, next to per-message delete buttons that
  do act on Kick.

**Per-viewer settings** (gear button, saved in `localStorage`, tabbed)

- Appearance: font size and family (presets or any installed font),
  background color, message spacing, one color for all usernames.
- Behavior: timestamps and their format, scroll-back through history with a
  history size, user cards on/off. Scrolling up holds chat still - nothing
  moves under what you are reading - and a pill shows how many messages have
  arrived below, with a click back down to them.
- Badges: choose which badge kinds are shown, and drag them (or use each
  row's arrows) into the order they are drawn in next to usernames. Badges of
  the same kind keep Kick's own order within it.
- Filters: count a message a user repeats within a timespan (per user) onto
  the copy already on screen as `×2`, `×3`; draw an emote spammed
  back-to-back once, with a combo count beside it (`×12`); highlight messages
  that @mention you.
- Events: what to do with deleted messages, which moderation / pin / sub /
  gift / host events to show, and whether a pinned message starts collapsed.
  The moderation controls themselves are not a setting: they appear when Kick
  says the signed-in account can moderate the channel, and not otherwise.
- Overlay & sharing: fade-out time for the OBS overlay, copy an overlay or
  settings link, export / import settings as JSON, reset, and the switch for
  the anonymous viewer count (the same answer the first-visit banner asks
  for).
- About: which build this tab is running, and whether the server has a newer
  one. Nothing here is a setting - it is what makes a bug report nameable.

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
              GET /<channel>     |     POST /api/beat  (only if opted in)
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
    shapes `app.js` renders. `normalizeMessage` keeps `sender_id` because a
    reply has to name the parent's sender to Kick, and this is the only place
    it comes past.
- `site/settings.js` - the settings model, and the only part of the frontend
  with no DOM in it: which settings exist, what each may hold (`sanitize`),
  and how they survive a round trip through the URL. Split out so it can be
  tested on its own, and loaded the same way as `kick.js`.
- `site/defaults.json` - the starting value of every setting. **Change
  defaults here**, not in code. It is checked against `settings.js` when the
  page loads: a missing setting, a misspelt name, a number out of range or an
  unknown option stops the page with a message naming the setting, and
  `npm test` catches the same mistakes before a push. The one thing it cannot
  set is the viewer-count answer: every viewer is asked first.
- `site/app.js` - rendering, filters, user cards, moderation and overlay mode:
  everything that touches the DOM. `site/config.js` - Kick's public Pusher app
  key and cluster (the same values kick.com ships to every browser).
- `betterchat/main.py` - serves `site/` (every unknown path is the chat
  page, real files as-is), takes heartbeats, serves the board, and answers
  `/privacy` with `site/privacy.html`. That route is registered before the
  catch-all on purpose: otherwise `/privacy` would be read as a channel slug
  and the viewer would go looking for a Kick channel by that name.
  `betterchat/stats.py` - live sessions with expiry, per-channel totals,
  a 24h series and joins per hour, persisted to a JSON file every minute
  and on shutdown.

Every viewer holds their own connection to Kick, exactly like a kick.com tab
does. Heartbeats are anonymous and opt-in: a random per-tab id, the channel
slug, a message count, and whether the page is embedded. No IP is stored with
them. "Viewers" means open tabs,
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
a viewer is one load behind at worst.

There is no version to bump. The server writes a hash of every file under
`site/` into `sw.js` as it serves it, and the worker names its cache after
that hash: change any file and the worker's bytes change, the browser
installs the new worker, and its `activate` drops the old cache. The hash is
only recomputed when a file's size or modification time moves, so in the
image it is worked out once. On install the worker fetches its files past the
HTTP cache (`cache: 'reload'`), so a build's cache holds that build's files.
Served from a plain static host instead, the placeholder stays as written and
the worker simply never retires its cache on its own.

That hash is the only thing identifying a build, so the settings panel's
**About** tab shows it: the one this tab is running, read from the cache the
worker filled, and `/api/build` for what the server is serving now. When they
differ the tab is a deploy behind and says so, which is the difference between
a bug report naming a build and one that cannot. `/api/build` is under `/api/`
so the worker never caches it - cached, it would report the build it was
cached under for good.

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
npm test             # kick.js normalizers / API client / relay framing, and settings.js (Node)
```

| Variable | Purpose |
| --- | --- |
| `ADMIN_USER`, `ADMIN_PASSWORD` | Enable `/admin` (both required). |
| `STATS_PATH` | Persisted stats file (default `data/stats.json`; `/app/data/stats.json` in Docker). |
| `SITE_DIR` | The static site (default: `site/` in the repo). |
| `FRAME_ANCESTORS` | CSP `frame-ancestors` for the site, e.g. `'self' https://kick.com`. Unset sends no header. |
| `BEAT_ORIGINS` | Origins allowed to post heartbeats cross-origin, e.g. `https://dev.betterchat.tech`. Unset means same-origin only. |
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

### The bridge to the extension

Moderating and replying both need a Kick session, which this page does not
have and will not get. They go over `postMessage` to the framing page
instead, which on kick.com is the extension's content script. Every message
carries `channel: 'bck-mod'` and an `id`, and both sides check the other's
origin: this page will only talk to `https://kick.com`, and the extension
only to the BetterChat origin it loaded.

Requests from this page, each answered with the same `id`:

| Type | Answer |
| ---- | ------ |
| `hello` | `available` (a signed-in Kick tab, so moderating is possible), `canReply` (the page has a message box to type in), and any reply already armed |
| `action` | a moderation action - `delete`, `timeout`, `ban`, `unban`, `pin`, `unpin` - answered `ok` or with an `error` and Kick's `status` |
| `reply` + `message: { id, content, sender: { id, username } }` | arms a reply: the next message typed into Kick's box is sent as a reply to this one |
| `reply-cancel` | disarms it |

The extension also speaks unasked, with its type as the `id`, since these can
arrive long after any request:

| Type | Meaning |
| ---- | ------- |
| `reply-state` | what is armed now, or nothing; the bottom bar is drawn from this alone |
| `reply-failed` | Kick refused the send, with the reason and the text back, Kick's box having been cleared already |

A request with no answer times out after ten seconds and is treated as a
refusal, so an older extension that does not know a message type leaves the
feature off rather than hanging. `canReply` is what keeps the reply button
away from an extension too old to send one.

## Deploying

The `Dockerfile` builds one image. [Kamal](https://kamal-deploy.org) runs it
on the VPS, and [deploy-kit](https://github.com/AnisAbdellatif/deploy-kit)
(vendored in `.kamal/kit`, version in `.kamal/kit/VERSION`) adds the checks
before a deploy, the smoke tests after it and the rollback. The host's own
Caddy obtains the certificates and forwards both domains to kamal-proxy on
`127.0.0.1:8080`, which routes by domain and swaps the container with no
downtime: it waits for the new one's `/health` before moving traffic, so a
deploy no longer means a few seconds of 502.

```
Internet ─443─► Caddy (host, TLS) ─► 127.0.0.1:8080 kamal-proxy ─► BetterChat
```

CI (`.github/workflows/ci.yml`) tests every push. For pushes to `master` and
`dev` it also builds the image, pushes it as
`ghcr.io/anisabdellatif/betterchat:<commit sha>` and signs a build
attestation. CI deploys nothing and holds no SSH key or secret. A person
deploys:

```bash
git switch dev && .kamal/kit/bin/kit deploy -d dev
git switch master && git pull && .kamal/kit/bin/kit deploy -d production
```

Before anything changes on the server, `kit deploy` checks that deploys
aren't frozen, that the checkout is on the destination's branch, clean and
pushed, and that the image was built and attested by this repository's CI.
Production also needs CI green for that exact commit (it waits up to 15
minutes for a run still going) and asks you to type its name. After the
swap, the smoke tests fetch the public URLs through Caddy, and a failure
rolls back to the previous version. A gate that refuses says how to go past
it once, on purpose (`KIT_SKIP=<step> KIT_SKIP_REASON="…"`).

| Destination | Branch | Kamal config | Admin login on the VPS | Stats volume | Address |
|---|---|---|---|---|---|
| `production` | `master` | `config/deploy.yml` + `config/deploy.production.yml` | `/opt/betterchat/app.env` | `betterchat-data` | betterchat.tech |
| `dev` | `dev` | `config/deploy.yml` + `config/deploy.dev.yml` | `/opt/betterchat-dev/app.env` | `betterchat-dev-data` | dev.betterchat.tech |

The kit's settings are in `.kamal/kit.env`. Kamal runs in the kit's image
(`KIT_RUNNER=docker`), so the machine that deploys needs only bash, git,
Docker and a logged-in `gh`.

One-time setup:

1. On the VPS (the one the other Kamal apps already run on): a deploy user
   in the `docker` group with your SSH key. Create `/opt/betterchat` and
   `/opt/betterchat-dev`, owned by the deploy user, each with a filled-in
   `app.env` (`deploy/app.env.example`; `chmod 600`, no quotes around
   values, a different login for dev). Copy `deploy/betterchat.site` to
   `/etc/caddy/`, add `import betterchat.site` to `/etc/caddy/Caddyfile`
   and reload Caddy.
2. On the machine that deploys: copy `.kamal/kit.local.env.example` to
   `.kamal/kit.local.env` and fill in the server (`BC_HOST`) and a GitHub
   token with only `read:packages` (`KAMAL_REGISTRY_PASSWORD`; the server
   logs in to ghcr.io with it). Then `.kamal/kit/bin/kit doctor -d production`.

Moving from the Oracle box and its Cloudflare Tunnel (once; production
shown, dev is the same with `betterchat-dev` / `betterchat-dev-data`, or
skip it and let dev start with empty stats):

1. On the Oracle box, stop the stack and take the stats out:
   `cd /opt/betterchat && docker compose down` (no `-v`), then
   `docker run --rm -v betterchat_betterchat-data:/d alpine cat /d/stats.json > stats.json`.
2. On the VPS, put them in the volume Kamal will mount, owned by the
   container's user (`nobody`):
   `docker volume create betterchat-data && docker run --rm -i -v betterchat-data:/d alpine sh -c 'cat > /d/stats.json && chown -R 65534:65534 /d' < stats.json`.
3. In Cloudflare: remove the tunnel's public hostname for the domain and
   replace its DNS record with an `A` record to the VPS. Keep it proxied
   (orange): Cloudflare's caching and Access stay, and the privacy policy
   says traffic reaches the server through Cloudflare. Set SSL/TLS to Full
   (strict). If Caddy can't get its certificate through the proxy, switch
   the record to DNS only until it has one.
4. Deploy: `.kamal/kit/bin/kit deploy -d production`. The first deploy
   also starts kamal-proxy, if no other app on the server has yet.
5. When both work, clean up what the old deploy used: on the Oracle box,
   the self-hosted runner (`cd ~/actions-runner && sudo ./svc.sh stop && sudo ./svc.sh uninstall && ./config.sh remove --token <token>`),
   the checkouts and volumes, and `cloudflared` if nothing else uses it;
   on GitHub, the runner (Settings → Actions → Runners) and the
   `DEPLOY_DIR` / `DEPLOY_DIR_DEV` repository variables.

Day to day:

- Rolling back: `.kamal/kit/bin/kit kamal rollback <older commit sha> -d production`.
  Kamal keeps the last few containers on the server.
- Stopping deploys: `.kamal/kit/bin/kit freeze -d production "reason"`,
  then `kit unfreeze -d production`.
- Logs and a shell: `.kamal/kit/bin/kit kamal app logs -d production`,
  `kit kamal app exec -i -d production sh`.
- A changed `app.env` takes effect with the next deploy, or at once with
  `kit kamal app boot -d production`.
- Updating deploy-kit: `.kamal/kit/bin/kit update --from https://github.com/AnisAbdellatif/deploy-kit --ref <tag>`,
  then review and commit the diff in `.kamal/kit`.

`/admin` is Basic Auth over Caddy's TLS. A Cloudflare Access policy on
`/admin*` in front of it is free and worth adding, and one in front of all
of dev.betterchat.tech: a dev build should not be something strangers can
find.

## Two branches, two instances

`master` is stable and is the only thing that reaches `betterchat.tech`. Work
happens on `dev`, which deploys to a **second instance on the same VPS** and
cannot disturb the first one: its own Kamal destination, container, data
volume and admin login. Both run the same kind of image, tagged by commit,
so one can never come up on the other's code.

Dev deploys deliberately don't wait for the tests: dev is where half-finished
work goes to be tried in a real browser, and having to be green first would
defeat the point. The image still has to exist and come up healthy, and the
smoke test still runs, so a build that cannot boot is refused or rolled back
either way.

One thing is deliberately shared: **the admin board**. The dev page posts its
heartbeats to the stable origin rather than to its own instance, tagged
`build: "dev"`, so a single board answers "who is watching" for both and shows
the split. That is `BEAT_ORIGINS=https://dev.betterchat.tech` in
`config/deploy.production.yml`; dev leaves it empty, since nothing reports to
dev. Dev viewers do count toward the shared totals, which is fine when dev is
you testing and worth remembering if it ever gets busier.

To point the extension at the dev instance, change `BCK_BASE_URL` in a local
copy of `defaults.js` and load that copy unpacked. The origin is fixed in the
extension on purpose, so there is no setting for it.

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
