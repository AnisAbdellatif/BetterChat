# The chat core protocol

`site/core.js` is BetterChat's chat with nothing to draw it on. It joins a Kick
channel, listens to Kick's feed and decides everything about what is shown -
deduplication, repeat counting, emote combos, badges, which `@words` are real
users, what a deletion or a ban does, which events are shown and what they say,
the pinned message, the connection status, how much history is kept - and says
so as a stream of plain JSON operations. Whoever listens draws them.

Two hosts listen today:

- **The web page** (`site/app.js`), which turns the operations into DOM and
  hands the core the browser's own `fetch`, `WebSocket` and timers.
- **The Viewmux desktop app**, which runs the same file in an embedded QuickJS
  (the `fjs` package) and draws the chat natively.

This document is the contract between the core and a host. It describes
protocol version **1**, which `core.js` exports as `CORE_PROTOCOL_VERSION`.
The golden fixtures in `tests/fixtures/scenarios/*.expected.json` are this
document in executable form: every operation shape below appears there, and
`npm test` fails if the core's output drifts from them.

Conventions used below: `string?` means the field is always present but may be
`null`; a field marked *optional* may be absent altogether. Every object is
plain JSON - no functions, no `undefined`, no class instances, no cycles - with
the one documented exception of `raw` (which is Kick's own JSON, untouched).

## Loading the core

Three files, evaluated in this order as plain scripts. Each is UMD: under Node
it is `require()`-able, otherwise it sets a global on the global object.

| File | Global | What it is |
| --- | --- | --- |
| `site/settings.js` | `BetterChatSettings` | the settings model: which settings exist, `sanitize` |
| `site/kick.js` | `BetterChatKick` | Kick's REST API, the chat feed (`FeedRelay`), payload normalizers |
| `site/core.js` | `BetterChatCore` | the session described here |

None of them uses a module loader, `window`, `document`, `localStorage`,
`location` or `Intl`, and the core does not touch the global `fetch`,
`WebSocket`, `setTimeout` or `clearTimeout` either - those come from the host.
`kick.js` falls back to the globals only when a caller passes nothing, which
the core never does.

`settings.js` normally fetches `/defaults.json` itself. In a host with no
global `fetch` it waits instead: read `site/defaults.json` and pass the parsed
object to `BetterChatSettings.useDefaults(json)` once, before calling
`sanitize`. `BetterChatSettings.ready` resolves at that point.

```js
BetterChatSettings.useDefaults(defaultsJson);
const settings = BetterChatSettings.sanitize(storedOrEmptyObject);
const session = BetterChatCore.createChatSession({ slug, settings, host, onOps, config });
session.start();
```

## `createChatSession(options)`

| Option | Type | Required | Meaning |
| --- | --- | --- | --- |
| `slug` | string | yes (may be `''`) | the channel as the viewer typed it, e.g. `"somechannel"`. An empty slug makes `start()` do nothing. |
| `settings` | object | yes | a settings object returned by `BetterChatSettings.sanitize` (see [Settings](#settings)) |
| `host` | object | yes | `{ fetch, WebSocket, setTimeout, clearTimeout, now }`, see [The host](#the-host) |
| `onOps` | `(ops: Op[]) => void` | yes | receives every batch of operations |
| `config` | object | no | `{ kickApiBase, realtimeUrl }` - the values in `site/config.js`. `kickApiBase` defaults to `https://kick.com/api/v2`. `realtimeUrl` is the chat feed, a BetterChat `/realtime` relay such as `wss://betterchat.tech/realtime` (see `betterchat/relay.py` for its frames); it has no default and is needed to connect. The web page fills it in with its own origin's. |
| `overlay` | boolean | no | OBS overlay mode: no joining / connected / live / connection-lost lines, and the history size is fixed at 100 rows |
| `onUnknown` | `(eventName, data) => void` | no | called for Kick events the core does not recognise (debugging only) |
| `onError` | `(error) => void` | no | receives anything `onOps` throws (see [Batches](#batches)) |

It throws a `TypeError` naming what is missing if `host` lacks a function, or
if `onOps` or `settings` is absent. Creating a session does nothing on the
network; `start()` does.

### The host

The core takes each function once, when the session is created, and only
ever calls it as a plain function - never as a method of `host` - so a
browser can hand over its own `fetch` and `setTimeout` unwrapped. Replacing a
function on `host` afterwards has no effect.

| Function | Contract |
| --- | --- |
| `fetch(url, init)` | Only ever a GET of an absolute `https://` URL to Kick's API. `init` is `{ headers: { accept: 'application/json' } }` and may be ignored. Must return a Promise of a response with `ok` (boolean), `status` (number) and `json()` (Promise of the parsed body). Nothing else on the response is read. A network failure rejects the Promise. |
| `WebSocket` | A constructor: `new WebSocket(url)`. The object has a numeric `readyState` (`1` = open), `send(string)`, `close()`, and the assignable callbacks `onopen()`, `onmessage(event)` where `event.data` is the frame's text, `onclose()` and `onerror()`. `close()` must lead to `onclose` being called, as a browser's does: the core closes a socket that stopped answering pings and reconnects when `onclose` arrives. (When the core is done with a socket for good - `stop()` - it sets `onopen`, `onmessage`, `onerror` and `onclose` to `null` before closing it, and ignores anything the socket still delivers.) |
| `setTimeout(fn, ms)` | Calls `fn()` once after `ms` milliseconds; returns any id. `ms` can be up to `2147483647`. |
| `clearTimeout(id)` | Cancels it. **Must accept `null` and `undefined`** (and ids that have already fired) and do nothing. |
| `now()` | Milliseconds since the Unix epoch, as a number. |

The core's work happens in whatever host callback triggered it: a socket
message, a timer, a fetch settling, or a method call. `onOps` is called
synchronously from inside that callback.

### Session methods

| Method | Returns | What it does |
| --- | --- | --- |
| `start()` | Promise | Joins the channel: resolves it, backfills recent history and the pin, opens the feed. Once per session. |
| `stop()` | - | Closes the feed, lets go of the socket (its callbacks are set to `null`) and cancels every timer. From then on nothing is emitted: answers still in flight are dropped, and later calls to `note`, `clearLocal`, `updateSettings`, `trim` and the rest emit nothing. Final. |
| `updateSettings(settings)` | - | New sanitized settings. Emits `update`s for the rows a change affects and a `trim` if the history size shrank (see [Settings](#settings)). |
| `parts(text)` | `Part[]` | Message text into parts, exactly as a row's text would be parsed now. For text the host draws on its own (a reply's full text in a tooltip, a reply the viewer has armed). May queue mention lookups. |
| `userCard(username)` | Promise of `{ card: Card \| null, error: null \| 'not_found' \| 'unavailable' }` | Kick's data for a user card. Never rejects. `not_found` is Kick answering 404 (no such user in this chat); `unavailable` is anything else, including an empty slug. A successful answer is cached for 3 minutes (50 users). |
| `cachedUserCard(username)` | `Card \| null` | The cached card if one was fetched in the last 3 minutes, synchronously - so a host can draw it at once with no loading state. |
| `userHistory(username)` | `HistoryEntry[]` | The messages seen from this user since the session started, **newest first**, at most 25. Kept regardless of the history size, deduplication or repeat counting. Parsed now. |
| `watchUser(username \| null)` | - | While set, each new message from this user is also sent as a `history` op, for a user card left open. `null` stops. |
| `isBanned(username)` | boolean | Whether this session has seen the user banned, or timed out with the timeout not yet run out, and not since unbanned. A timeout ends at Kick's `expires_at`, or its duration after it arrived; one with neither lasts until an unban. Kick's own user card lags behind a moderator's action by minutes; this does not. At most the last 1000 names are remembered. |
| `note(text, isError)` | - | Appends a system line of the host's own (a refused moderation action, say), so it takes its place among the rows and is trimmed like them. |
| `clearLocal()` | - | Empties the chat for this viewer only (nothing is sent to Kick): emits `clear`, then a system line `chat cleared`. A repeat of a message from before the clear starts a fresh row. |
| `setHeld(held)` | - | `true` while the viewer has scrolled up to read. While held, rows are kept up to **twice** the history size instead of being trimmed from under the reader. Takes effect at the next trim. |
| `trim()` | - | Trims now (emits a `trim` if anything goes). The web page calls it when the viewer jumps back to the newest message. |
| `dropRows(ids)` | - | The host removed these rows by itself (the overlay's fade-out). Emits nothing; the core stops counting them. A repeat of a dropped row's message starts a fresh row. |
| `setIncludeRaw(on)` | - | Whether new message rows carry `raw`, Kick's whole message object (needed only to pin a message, which hands Kick the message back as Kick sent it). Off by default. |
| `liveMessages()` | number | How many live messages (not history, not duplicates) the session has seen. |
| `version` | number | `CORE_PROTOCOL_VERSION`. |

## Batches

`onOps` receives an array of one or more operations. Everything caused by one
thing - one frame from Kick, one settings change, the history backfill, one
method call - is one batch, in the order the operations must be applied. A
batch that adds rows ends with the `trim` (if any) for those rows.

If a host calls a session method that emits from inside `onOps`, that method's
batch is delivered by a nested `onOps` call before the outer one returns. Hosts
should avoid it.

An exception thrown by `onOps` never reaches the core's own code (which may be
in the middle of handling a lost socket): it is passed to `onError` if one was
given, and otherwise rethrown from a fresh `host.setTimeout(fn, 0)` callback,
so it surfaces wherever the host reports uncaught errors. The batch counts as
delivered either way; it is not sent again.

## Rows

The core keeps the list of rows it believes the host is showing, oldest first.
The host keeps that belief true: it draws every `append`, `remove`, `trim` and
`clear`, and reports rows it takes away by itself with `dropRows`. In return
the core only ever refers to rows the host has.

Row ids are strings, unique within a session (`"r1"`, `"r2"`, ... today - do
not parse them). A row is appended once and never appended again; it changes
only through `update` and leaves through `remove`, `trim` or `clear`.

There are three kinds: `message`, `line` and `card`.

### `message`

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | `'message'` | |
| `id` | string | row id |
| `msgId` | string | Kick's message id (a uuid). What deletions, replies and moderation refer to. |
| `type` | string | Kick's type: `'message'`, `'reply'`, or whatever else Kick sends |
| `username` | string | the sender, as Kick spells it |
| `user` | string | the sender, lowercased - what bans match on |
| `senderId` | integer? | the sender's Kick user id; `null` when Kick sent none (then the message cannot be replied to) |
| `text` | string | the raw content, emote placeholders (`[emote:37226:KEKW]`) included. What "copy message" and replying use. |
| `createdAt` | string? | ISO 8601 timestamp from Kick. Formatting it is the host's job. |
| `color` | string | the colour to draw the username in, a CSS hex colour (`#rgb` to `#rrggbbaa`): the viewer's one colour if they chose one, else the sender's Kick colour, else Kick green `#53fc18` |
| `kickColor` | string? | the sender's own Kick colour when it was a valid hex colour, else `null` |
| `badges` | `Badge[]` | in the order to draw them, left to right |
| `parts` | `Part[]` | the content |
| `reply` | `Reply?` | the message this one answers |
| `mentionsMe` | boolean | the message `@mentions` the viewer (the `mentionMe` setting). The web page highlights the whole row. |
| `repeats` | integer | how many copies this row stands for; `1` on append in this version |
| `deleted` | string? | `null` on append in this version; see `update` |
| `raw` | object | *optional*: Kick's message object, only while `setIncludeRaw(true)` |

`Reply`:

| Field | Type | Meaning |
| --- | --- | --- |
| `msgId` | string? | the parent message's id |
| `username` | string? | the parent's sender (the web page shows `?` for `null`) |
| `senderId` | integer? | the parent's sender id |
| `text` | string | the parent's raw content (`''` if Kick sent none) |
| `parts` | `Part[]` | the parent's content |

### `line`

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | `'line'` | |
| `id` | string | row id |
| `style` | `'system' \| 'mod'` | `system`: the page talking (joining, connected, errors, host notes). `mod`: a moderation record (ban, timeout, unban, clear). |
| `error` | boolean | a system line reporting a failure (drawn in red on the web page). Always `false` for `mod`. |
| `icon` | string? | an emoji drawn before the line; `null` for `system`, one of `🔨` (ban) `⏳` (timeout) `🔓` (unban / timeout lifted) `🧹` (chat cleared) for `mod` |
| `segs` | `Seg[]` | the text. A `system` line is always a single `text` segment. |

### `card`

Subs, gifted subs, Kicks, channel-point rewards and hosts: who did what on one
line, the number that matters underneath.

| Field | Type | Meaning |
| --- | --- | --- |
| `kind` | `'card'` | |
| `id` | string | row id |
| `card` | `'sub' \| 'gift' \| 'kicks' \| 'reward' \| 'host'` | which event |
| `icon` | string | `★` sub, `🎁` gift, `⚡` kicks, `🎟️` reward, `📺` host |
| `head` | `Seg[]` | the first line, e.g. `[{user Ann}, " subscribed"]` |
| `detail` | `Seg[]` | the line beneath; may be empty (then draw none) |

What the cards say, so a host does not have to reconstruct it:

| Card | `head` | `detail` |
| --- | --- | --- |
| `sub` | user, `" subscribed"` | `count(months, month)` for a resub, else `"new subscriber"` |
| `gift` | user (gifter, or `"Someone"`), `" gifted subs"` | `count(n, sub)`, then for 1-5 recipients `" to "` and their names as user segments separated by `", "` |
| `kicks` | user, `" sent Kicks"` | `count(amount, Kick)` if any, then the gift's name (prefixed `" - "` after a count), then `": " + message` if any |
| `reward` | user (or `"Someone"`), `" redeemed"` | the reward's title, then the redeemer's input (prefixed `": "` after a title) |
| `host` | user (the hosting channel), `" is hosting"` | `count(viewers, viewer)` if any, then the host's message (prefixed `" - "` after a count) |

## Parts

A message's content, in order. Untrusted text: never interpret it as markup.

| Part | Fields | Meaning |
| --- | --- | --- |
| `{ t: 'text', text }` | `text`: string | plain text, possibly only whitespace |
| `{ t: 'emote', id, name, url, count }` | `id`: string of digits; `name`: string; `url`: string; `count`: integer >= 1 | an emote image. `url` is `https://files.kick.com/emotes/<id>/fullsize`; `name` is its alt text and tooltip. `count` > 1 is a run of the same emote collapsed into one (the `collapseEmotes` setting): draw it once with `×count` beside it. |
| `{ t: 'mention', name, key, verified }` | `name`: string as typed (`[A-Za-z0-9_-]`, 1-30 chars); `key`: `name` lowercased; `verified`: boolean | an `@name`. Draw `"@" + name`. Only a verified mention is styled as a mention (and is clickable for a user card); unverified, it reads as plain text, and may become verified later by a `verify` op. |

The self-mention highlight is a property of the row (`mentionsMe`), not of the
part: a host that wants to mark the viewer's own name in the text compares
`key` with the `mentionMe` setting lowercased.

## Segments

The text of lines and cards.

| Segment | Fields | Meaning |
| --- | --- | --- |
| `{ t: 'text', text }` | `text`: string | plain text |
| `{ t: 'user', name }` | `name`: string | a username Kick named, drawn as a name and clickable for a user card |
| `{ t: 'count', n, unit, units }` | `n`: number; `unit`, `units`: string | a number and what it counts, e.g. `{n: 1204, unit: 'viewer', units: 'viewers'}`. Draw `n` grouped in the viewer's locale, a space, then `unit` if `n === 1` else `units`: "1,204 viewers". Left to the host because the core has no `Intl`. |

## Badges

Drawn before the username, in array order. Every badge the sender has is sent,
hidden ones included, so that showing a kind again in the settings needs no
new data.

| Field | Type | Meaning |
| --- | --- | --- |
| `key` | integer | the badge's place in Kick's own order (0-based); stable for the row's life, unique within the row. Use it to match badges across an `update`. |
| `kind` | string | one of `broadcaster`, `staff`, `moderator`, `verified`, `founder`, `og`, `vip`, `sub_gifter`, `subscriber`, `bot`, `level`, `event`, `other` (`BetterChatSettings.BADGE_KINDS`) |
| `title` | string | tooltip / accessible name, e.g. `Subscriber (8 months)`, `Level 29`. May be empty. |
| `image` | string? | URL of the badge image (a channel's subscriber tier, Kick's hosted global badges) |
| `svg` | string? | a drawn badge: a standalone SVG document, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">` and one level of shapes (`path`, `rect`, `circle`, `text`), attributes double-quoted and XML-escaped. Exactly one of `image` and `svg` is non-null. The title is not inside it. |
| `hidden` | boolean | the viewer has hidden this kind: keep it, do not display it |

The order is the viewer's `badgeOrder` between kinds, and Kick's order within a
kind. Badges in a user `Card` come in the same order with `hidden` always
`false`: a card shows everything.

## Operations

### `append`

```json
{ "op": "append", "row": Row }
```

A new row at the bottom (newest end) of the list.

### `update`

```json
{ "op": "update", "id": "r12", "patch": { ... } }
```

Some fields of an existing row changed; only the fields present in `patch`
did. Ignore an update for an id you do not have. Fields that can appear:

| Field | Type | Applies to | Meaning |
| --- | --- | --- | --- |
| `color` | string | message | the username colour changed (a colour setting changed) |
| `badges` | `Badge[]` | message | the complete new badge list (order or `hidden` changed). Same badges as before, matched by `key`. |
| `mentionsMe` | boolean | message | the `mentionMe` setting changed |
| `repeats` | integer >= 2 | message | another copy of this message arrived and was counted onto the row: show `×repeats` before the badges |
| `deleted` | string | message | the message was deleted or its sender moderated, under the "gray" setting: draw it greyed out and struck through with the reason after it. One of `'deleted'`, `'banned'`, `'timed out'`, `'chat cleared'`. A later update may replace the reason. |

### `remove`

```json
{ "op": "remove", "id": "r12" }
```

The row is gone: a deletion, ban or timeout under the "remove" setting.

### `trim`

```json
{ "op": "trim", "keep": 100, "ids": ["r1", "r2"] }
```

History over the limit: remove the rows in `ids`, which are always the oldest
rows, oldest first. `keep` is how many rows the core has left afterwards; a
host whose list mirrors the core's can equally keep only the last `keep` rows.

The limit is the `historyLimit` setting with `scrollback` on, else 100; always
100 in overlay mode; twice that while `setHeld(true)`. It is applied at the end
of every batch that appended rows, on `updateSettings`, and on `trim()`.

### `clear`

```json
{ "op": "clear" }
```

Remove every row (the viewer's own clear, `clearLocal`). A moderator clearing
the chat is not this: that arrives as `update`s with `deleted: 'chat cleared'`
(or `remove`s) and a `mod` line.

### `verify`

```json
{ "op": "verify", "key": "bob_42" }
```

Every mention part with this `key` - in rows, the pinned message, an open user
card's history, anything the host is drawing - is now verified: style it as a
mention. Sent only when such a part may be on screen (a name nobody typed costs
nothing). Parts created afterwards already carry `verified: true`.

### `pin`

```json
{ "op": "pin", "pin": Pin }
{ "op": "pin", "pin": null }
```

The pinned message, or that there is none (unpinned, expired, or none on
joining). Sent whether or not the viewer shows pins (`showPinned`): showing it,
and whether a new pin starts collapsed (`collapsePinned`), is the host's call.
Every `pin` op is a new pin as far as the host is concerned (the web page
resets its collapsed state on each), and one is sent again after every
reconnect. The core runs the expiry timer and sends `null` when it runs out.

The pin on joining and after a reconnect comes from the same request to Kick
as the history backfill. If that request fails, no `pin` op is sent at all:
on joining the host simply has no pin yet (as if `null`), and after a
reconnect the pin it already has stands. A later pin or unpin event from the
feed is sent as usual.

`Pin`:

| Field | Type | Meaning |
| --- | --- | --- |
| `msgId` | string? | the pinned message's id |
| `username` | string? | its author (the web page shows `?` for `null`) |
| `color` | string | the author's username colour, as for a message, at the time of pinning |
| `text` | string | raw content |
| `parts` | `Part[]` | content |
| `by` | string? | the moderator who pinned it |
| `expiresAt` | string? | ISO 8601, when it runs out |
| `durationMin` | integer? | the pin's duration in minutes, as Kick gave it |

### `status`

```json
{ "op": "status", "status": Status }
```

The connection changed. `Status`:

| Field | Type | Meaning |
| --- | --- | --- |
| `state` | string | `'connecting'` (no socket, and the chat subscription has never been confirmed: the first connection, including a socket lost before that first confirmation), `'reconnecting'` (no socket, after the chat subscription had been confirmed at least once), `'subscribing'` (socket up, chat subscription not confirmed), `'offline'` (connected, channel not live), `'ok'` (connected and live, or liveness unknown), `'failed'` (the channel could not be joined; nothing more will happen) |
| `text` | string | what to tell the viewer, `''` when nothing needs saying (`ok`, `failed` - the reason for a failure is an error line) |
| `level` | `'' \| 'warn' \| 'offline'` | how to style `text` |
| `socket` | boolean | the WebSocket is open |
| `subscribed` | boolean | Kick confirmed the chat subscription |
| `live` | boolean? | the channel is live; `null` until known |
| `joined` | boolean | the chat subscription has been confirmed at least once |

### `channel`

```json
{ "op": "channel", "channel": { "slug": "somechannel", "channelId": 1001, "chatroomId": 1002, "live": false } }
```

The channel was resolved. `slug` is the slug given to `createChatSession`,
trimmed and lowercased (not re-spelled by Kick); `channelId` and `chatroomId`
are Kick's ids (integers); `live` is whether it was live at that moment. Sent
once, before any message.

Two spellings of the channel appear in lines and statuses: `joining <slug>...`,
`no such channel: <slug>`, `<slug> went live` / `went offline` and the offline
status text use the slug exactly as given to `createChatSession`; `connected
to` / `reconnected to <slug>'s chat` and `<slug> is not live right now` use
`channel.slug`.

### `history`

```json
{ "op": "history", "user": "ann", "entry": HistoryEntry, "count": 3 }
```

A message from the user given to `watchUser`, sent before that message's own
`append` (and sent even when the message is a repeat and gets no row). `user`
is lowercase; `count` is how many messages the session now holds for them
(at most 25).

`HistoryEntry`: `{ text: string, createdAt: string?, parts: Part[] }`.

## User cards

`Card`, from `userCard()` and `cachedUserCard()`:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | integer? | Kick user id |
| `username` | string? | as Kick spells it |
| `slug` | string? | their channel slug (for a link to `https://kick.com/<slug>`) |
| `profilePic` | string? | avatar URL |
| `bio` | string? | |
| `followers` | integer? | their own channel's follower count |
| `verified` | boolean | |
| `createdAt` | string? | ISO 8601, account created |
| `followingSince` | string? | ISO 8601, followed this channel; `null` when not following |
| `subscribedFor` | integer? | months subscribed to this channel; `0` or `null` when not subscribed |
| `isModerator`, `isStaff`, `isChannelOwner` | boolean | in this channel / on Kick |
| `banned` | boolean | banned in this channel according to Kick (see also `isBanned`) |
| `badges` | `Badge[]` | all of them, `hidden: false` |

## Settings

The core reads these fields of the sanitized settings object; the rest are the
host's (fonts, timestamps, `userCards`, `showPinned`, `collapsePinned`,
`overlayFadeSec`, `stats`, ...).

| Setting | Effect in the core |
| --- | --- |
| `dedupe`, `dedupeWindowSec`, `dedupeRepeats` | repeat counting: once the same user has posted the same text (case and whitespace ignored) `dedupeRepeats` times within `dedupeWindowSec` seconds, further copies become `update { repeats }` on the last row instead of new rows |
| `collapseEmotes` | runs of one emote become one part with a `count`, and count as the same message for repeats. Affects rows parsed from then on. |
| `mentionMe` | `mentionsMe` on message rows (updated on change) |
| `monocolor`, `monocolorValue` | `color` on message rows and pins (rows updated on change) |
| `badgeOrder`, `hiddenBadges` | badge order and `hidden` (rows updated on change) |
| `deletedMessages` | `'gray'`: `update { deleted }`; `'remove'`: `remove`; `'keep'`: nothing. Read when the deletion arrives. |
| `showModeration` | `mod` lines for bans, timeouts, unbans and chat clears (rows are marked either way) |
| `showSubs`, `showGifts`, `showKicks`, `showRewards`, `showHosts` | whether those cards are appended |
| `scrollback`, `historyLimit` | the history size (see `trim`) |

## What happens when

| Input | Operations |
| --- | --- |
| `start()` | line `joining <slug>...` (not in overlay), `status connecting`; then after resolving: `channel`; then the backfill batch: an `append` per recent message (oldest first, duplicates dropped), `pin` (or `pin null`), `trim` if over the limit - or no backfill batch at all if Kick's history request fails. An unknown channel instead gives an error line `no such channel: <slug>` (or `Kick API is unavailable`) and `status failed`. |
| socket opens | `status subscribing` |
| chat subscription confirmed | line `connected to <slug>'s chat` (and `<slug> is not live right now - you'll still see chat` when offline), `status`; on a later reconnect `reconnected to <slug>'s chat`, `status`, then a `pin` batch from Kick's history |
| socket lost | if the chat was subscribed, `status subscribing`; then, in a second batch, error line `lost connection to Kick, reconnecting...` (if the socket had been open; not in overlay) and `status reconnecting` - or `status connecting` ("Connecting to Kick...") if the chat subscription had never been confirmed yet. The core reconnects with backoff by itself (1 s doubling to 30 s). |
| chat message | in this order: `verify` if the sender is a name someone mentioned before they spoke, `history` if the sender is watched, then either `update { repeats }` for a counted repeat, or `verify` for a replied-to name awaiting one followed by the `append`; nothing at all for a duplicate id |
| message deleted | `update { deleted: 'deleted' }` / `remove` / nothing |
| ban / timeout | per row of that user: `update { deleted: 'banned' \| 'timed out' }` / `remove`; then a `mod` line (`showModeration`) |
| unban | a `mod` line (`showModeration`) |
| chat cleared by a moderator | per message row `update { deleted: 'chat cleared' }` / `remove`; a `mod` line (`showModeration`) |
| pinned / unpinned / pin expires | `pin` / `pin null` / `pin null` |
| sub, gift, Kicks, reward, host | a `card` (if its setting is on) |
| went live / offline | line `<slug> went live: <title>` / `<slug> went offline` (not in overlay), `status` |
| a queued `@name` lookup answers yes | `verify` |

Mention lookups: an `@name` nobody has seen is asked about at
`/channels/<slug>/users/<name>`, strictly one request at a time: the next is
asked 400 ms after the previous one has been answered (or failed), at most 40
wait, and both answers are remembered (a failure is not, so the name can be
asked about again). Anyone who speaks, is moderated, is
replied to, pins, or is named in an event counts as seen.

## Versioning

`CORE_PROTOCOL_VERSION` is `1`. It goes up when an operation, row, part,
segment, badge or object above changes in a way a host built against the
previous version would draw wrongly: a field renamed, removed, retyped or given
a different meaning, or a new value in a closed set (a new `op`, row `kind`,
part `t`, segment `t`, `card`, `style`, `state` or `deleted` reason). Adding an
optional field does not change it; a host must ignore fields and patch keys it
does not know, and should ignore an `op` it does not know.
