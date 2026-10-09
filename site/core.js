// BetterChat - the chat itself, with nothing to draw it on.
//
// Everything the page decides about the chat before anything is drawn lives
// here: whether a message has been seen before, whether it is a repeat to
// count onto the copy already shown, what its badges are and in which order,
// which "@words" are real users, what a deletion or a ban does to the rows
// already there, which events are shown and what they say, when the pinned
// message runs out, how much history is kept, and whether the connection is
// up. What comes out is a stream of plain JSON operations - append this row,
// update that one, remove, clear, pin, status - and whoever is listening draws
// them.
//
// Two things listen. app.js turns the operations into the web page's DOM. The
// Viewmux desktop app runs this same file in an embedded QuickJS and draws
// them natively. That is why nothing in here touches a browser: no document,
// window, localStorage or Intl, and not even fetch, WebSocket or timers - the
// host hands those over (`host` below), and on the web page that host is the
// browser itself. docs/core-protocol.md is the contract both sides are written
// against, and CORE_PROTOCOL_VERSION moves whenever it does.
//
// Needs kick.js and settings.js loaded before it: as globals in a browser or
// QuickJS, by require() in Node. Same UMD shape as both.
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./kick.js'), require('./settings.js'));
  } else {
    root.BetterChatCore = factory(root.BetterChatKick, root.BetterChatSettings);
  }
})(typeof self !== 'undefined' ? self : this, function (Kick, Settings) {
  'use strict';

  // Bumped whenever an operation, a row, a part or a badge changes shape in a
  // way a host written against the previous one would get wrong. Adding an
  // optional field does not bump it; renaming, removing or changing the
  // meaning of one does.
  const CORE_PROTOCOL_VERSION = 1;

  const { BADGE_KINDS, KICK_GREEN, PINNED_HISTORY } = Settings;

  // Only a plain hex colour from a payload is used: on the web page it ends up
  // in a style attribute, so anything else is dropped rather than trusted.
  const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;

  const emoteUrl = (id) => `https://files.kick.com/emotes/${id}/fullsize`;

  // ---------------------------------------------------------------------
  // Pure helpers: no session, no state. Exported too, for a host that needs
  // the same answer outside a session (app.js colours the reply bar's name
  // with usernameColor).
  // ---------------------------------------------------------------------

  // The colour a username is drawn in: the viewer's one colour for everyone,
  // or the sender's own Kick colour, or Kick green when they sent none.
  function usernameColor(settings, kickColor) {
    if (settings.monocolor) return settings.monocolorValue;
    return HEX_COLOR.test(kickColor || '') ? kickColor : KICK_GREEN;
  }

  function durationText(minutes) {
    if (minutes == null) return '';
    if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'}`;
    if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }

  // Emote placeholders are parsed in kick.js (parseContent), where the syntax
  // is tested. This is only for comparing messages: "[emote:1:a]
  // [emote:1:a][emote:1:a]" -> "[emote:1:a]", so the repeat counter treats a
  // run of one emote as the same message however long the run is.
  const REPEATED_EMOTE = /(\[emote:(\d+):[^\]]*\])(?:\s*\[emote:\2:[^\]]*\])+/g;

  function collapseRepeatedEmotes(content) {
    return content.replace(REPEATED_EMOTE, '$1');
  }

  // Case and whitespace don't make a message different: "Pog Pog" and
  // "pog  pog" are the same message to the repeat counter.
  function normalizeContent(content) {
    return content.trim().replace(/\s+/g, ' ').toLowerCase();
  }

  // @mentions: "@name" not glued to a preceding word character. A fresh
  // RegExp per use, since a /g pattern carries its position between calls.
  const MENTION_SOURCE = '(^|[^\\w])@([\\w-]{1,30})';

  // Whether a message names the viewer. Read off the whole raw text rather
  // than its parts, the way the page always has, so an "@name" written inside
  // an emote's name still counts.
  function mentionsMe(settings, text) {
    if (!settings.mentionMe) return false;
    const me = settings.mentionMe.toLowerCase();
    const pattern = new RegExp(MENTION_SOURCE, 'g');
    let m;
    while ((m = pattern.exec(text)) !== null) {
      if (m[2].toLowerCase() === me) return true;
    }
    return false;
  }

  // ISO 8601 into epoch milliseconds with plain arithmetic, so the answer does
  // not depend on how much of Date.parse a host's engine implements (Kick's
  // pin expiries carry six fractional digits). Anything that is not plainly
  // ISO goes to Date.parse, which is what the page always used.
  const ISO_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})$/;

  function parseTime(value) {
    const m = typeof value === 'string' ? ISO_TIME.exec(value) : null;
    if (!m) return new Date(value).getTime();
    const [year, month, day, hour, minute, second] = m.slice(1, 7).map((v) => Number(v || 0));
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
      return new Date(value).getTime();
    }
    const ms = m[7] ? Number((m[7] + '00').slice(0, 3)) : 0;
    let t = Date.UTC(year, month - 1, day, hour, minute, second, ms);
    if (m[8] !== 'Z') {
      const sign = m[8][0] === '-' ? -1 : 1;
      const digits = m[8].slice(1).replace(':', '');
      t -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60000;
    }
    return t;
  }

  // ---------------------------------------------------------------------
  // Badges
  //
  // Kick sends two lists per sender (see kick.js):
  //   badges    - channel-level: subscriber (count = months), sub_gifter
  //               (count = gifts), moderator, vip, og, broadcaster, ...
  //               Only the subscriber badge has an image (channel-specific,
  //               from channel resolution); the rest are drawn, and come out
  //               of here as a small SVG document.
  //   badges_v2 - global badges (chat level, event badges) with a hosted
  //               image_url.
  // Kick's own order is channel badges first, then global ones, each list by
  // its sort_order. The viewer's badge order then decides between kinds, and
  // within a kind Kick's order stands.
  // ---------------------------------------------------------------------

  const SVG_NS = 'http://www.w3.org/2000/svg';

  function escapeXml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // [tag, attributes, text?] shapes on a 16x16 grid, into a standalone SVG
  // document. The attributes are written in the order they are listed, which
  // is the order the page has always set them in. Nothing a user typed ever
  // reaches this - the badge's title travels beside it, not inside it - but
  // everything is escaped regardless.
  const svgCache = new Map();

  function svgMarkup(cacheKey, build) {
    const hit = svgCache.get(cacheKey);
    if (hit) return hit;
    let out = `<svg xmlns="${SVG_NS}" viewBox="0 0 16 16">`;
    for (const [tag, attrs, text] of build()) {
      out += `<${tag}`;
      for (const name of Object.keys(attrs)) out += ` ${name}="${escapeXml(attrs[name])}"`;
      out += text === undefined ? '/>' : `>${escapeXml(text)}</${tag}>`;
    }
    out += '</svg>';
    svgCache.set(cacheKey, out);
    return out;
  }

  const ROUNDED = (fill) => ['rect', { x: 1, y: 1, width: 14, height: 14, rx: 3, fill }];
  const LABEL = (text, fill, size) => [
    'text',
    {
      x: 8, y: 11.5, 'text-anchor': 'middle', 'font-size': size || 8,
      'font-weight': 700, 'font-family': 'Arial, sans-serif', fill,
    },
    text,
  ];

  function subGifterColor(count) {
    if (count >= 200) return '#ff3b3b';
    if (count >= 100) return '#ff8c00';
    if (count >= 50) return '#c85cff';
    if (count >= 25) return '#3ea6ff';
    return KICK_GREEN;
  }

  // Every badge is filed under one of settings.js's BADGE_KINDS, so it can be
  // hidden or moved from the settings panel.
  function channelBadgeKind(badge) {
    return BADGE_KINDS.includes(badge.type) && badge.type !== 'level' && badge.type !== 'event'
      ? badge.type
      : 'other';
  }

  function globalBadgeKind(badge) {
    return badge.name === 'level' ? 'level' : 'event';
  }

  const drawn = (kind, title, cacheKey, build) => ({ kind, title, image: null, svg: svgMarkup(cacheKey, build) });
  const pictured = (kind, title, image) => ({ kind, title, image, svg: null });

  // `subscriberBadges` is the channel's own subscriber images, one per
  // months-tier, ascending.
  function channelBadge(badge, subscriberBadges) {
    const count = badge.count || 0;
    const label = badge.text || badge.type;
    const kind = channelBadgeKind(badge);

    switch (badge.type) {
      case 'subscriber': {
        const title = `Subscriber (${count} month${count === 1 ? '' : 's'})`;
        // Highest tier the subscriber has reached, if the channel has custom badges.
        let tier = null;
        for (const b of subscriberBadges) if (b.months <= count) tier = b;
        if (tier) return pictured(kind, title, tier.src);
        return drawn(kind, title, 'subscriber', () => [
          ['path', { d: 'M8 1.5l2 4.2 4.6.6-3.4 3.2.9 4.6L8 11.8l-4.1 2.3.9-4.6L1.4 6.3 6 5.7z', fill: KICK_GREEN }],
        ]);
      }
      case 'sub_gifter': {
        const c = subGifterColor(count);
        return drawn(kind, `Sub Gifter (${count} gift${count === 1 ? '' : 's'})`, `sub_gifter:${c}`, () => [
          ['rect', { x: 2, y: 6, width: 12, height: 8.5, rx: 1.5, fill: c }],
          ['rect', { x: 1, y: 3.5, width: 14, height: 3.5, rx: 1, fill: c }],
          ['rect', { x: 7, y: 3.5, width: 2, height: 11, fill: '#0b0e0f' }],
          ['path', { d: 'M8 3.5C6 3.5 4.5 1 6.5 1 7.5 1 8 2.5 8 3.5zm0 0c2 0 3.5-2.5 1.5-2.5C8.5 1 8 2.5 8 3.5z', fill: c }],
        ]);
      }
      case 'moderator':
        return drawn(kind, label, 'moderator', () => [
          ['path', { d: 'M13.5 1.5L5.2 9.8l1 1L14.5 2.5z', fill: KICK_GREEN }],
          ['path', { d: 'M4.2 10.8l1-1 1 1-1 1z', fill: KICK_GREEN }],
          ['path', { d: 'M2 14l2.2-3.2 1 1L2 14z', fill: KICK_GREEN }],
          ['path', { d: 'M4.5 8.5l3 3-1.2 1.2-3-3z', fill: '#2cb80f' }],
        ]);
      case 'vip':
        return drawn(kind, label, 'vip', () => [
          ['path', { d: 'M3 2h10l2.5 4L8 14.5 0.5 6z', fill: '#ff4fd8' }],
          ['path', { d: 'M3 2l2 4h6l2-4', fill: '#ffb3ee' }],
          ['path', { d: 'M5 6l3 8.5L11 6z', fill: '#ff85e4' }],
        ]);
      case 'og':
        return drawn(kind, label, 'og', () => [
          ROUNDED('#1f2a30'),
          ['rect', { x: 1, y: 1, width: 14, height: 14, rx: 3, fill: 'none', stroke: KICK_GREEN, 'stroke-width': 1 }],
          LABEL('OG', KICK_GREEN, 7),
        ]);
      case 'broadcaster':
        return drawn(kind, label, 'broadcaster', () => [
          ROUNDED('#e5484d'),
          ['rect', { x: 3, y: 5, width: 7, height: 6, rx: 1, fill: '#fff' }],
          ['path', { d: 'M10 7l3-1.5v5L10 9z', fill: '#fff' }],
        ]);
      case 'verified':
        return drawn(kind, label, 'verified', () => [
          ['circle', { cx: 8, cy: 8, r: 7, fill: KICK_GREEN }],
          ['path', { d: 'M4.5 8.2l2.3 2.3 4.7-4.7', fill: 'none', stroke: '#0b0e0f', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }],
        ]);
      case 'founder':
        return drawn(kind, label, 'founder', () => [ROUNDED('#f5a524'), LABEL('F', '#0b0e0f', 9)]);
      case 'staff':
        return drawn(kind, label, 'staff', () => [ROUNDED(KICK_GREEN), LABEL('K', '#0b0e0f', 9)]);
      case 'bot':
        return drawn(kind, label, 'bot', () => [ROUNDED('#3ea6ff'), LABEL('BOT', '#fff', 5.5)]);
      default:
        return drawn(kind, label, 'unknown', () => [['circle', { cx: 8, cy: 8, r: 6.5, fill: '#4a5058' }]]);
    }
  }

  function globalBadge(badge) {
    let title = badge.name;
    if (badge.name === 'level' && badge.level != null) title = `Level ${badge.level}`;
    else title = badge.name.replace(/[_-]+/g, ' ');
    return pictured(globalBadgeKind(badge), title, badge.image_url);
  }

  // Both lists in Kick's order, each badge numbered by its place in it. The
  // number is the badge's `key`: stable for as long as the row lives, and what
  // breaks ties between badges of the same kind. Sorted with the index as a
  // tiebreak rather than trusting the engine's sort to be stable.
  function kickOrderBadges(badges, badgesV2, subscriberBadges) {
    const inKickOrder = (list) =>
      (list || [])
        .map((b, at) => ({ b, at }))
        .sort((x, y) => (x.b.sort_order || 0) - (y.b.sort_order || 0) || x.at - y.at)
        .map(({ b }) => b);
    const items = [];
    for (const b of inKickOrder(badges)) items.push(channelBadge(b, subscriberBadges));
    for (const b of inKickOrder(badgesV2)) items.push(globalBadge(b));
    items.forEach((item, key) => {
      item.key = key;
    });
    return items;
  }

  // The badges as a row carries them: in the viewer's order, each marked
  // hidden or not. Hidden badges are still sent, so a kind switched back on
  // in the settings comes back on the messages already there. `showAll` is
  // the user card, which shows every badge whatever the chat hides.
  function orderBadges(settings, items, showAll) {
    const rank = (kind) => {
      const at = settings.badgeOrder.indexOf(kind);
      return at === -1 ? BADGE_KINDS.length : at;
    };
    return items
      .map((item) => ({ item, rank: rank(item.kind) }))
      .sort((a, b) => a.rank - b.rank || a.item.key - b.item.key)
      .map(({ item }) => ({
        key: item.key,
        kind: item.kind,
        title: item.title,
        image: item.image,
        svg: item.svg,
        hidden: showAll ? false : settings.hiddenBadges.includes(item.kind),
      }));
  }

  function sameBadges(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].key !== b[i].key || a[i].hidden !== b[i].hidden) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------
  // A chat session: one channel, from joining it to stopping.
  // ---------------------------------------------------------------------

  // Messages can arrive twice: once from the history backfill and once live
  // (or again after a reconnect, should Kick re-deliver).
  const SEEN_CAP = 5000;

  // Is that "@something" a username? Usually not: people write "@everyone",
  // "@ 8pm", "@ the mods". So an "@word" is a plain part until the name is
  // known to be real. Names already seen for real (anyone who has spoken, been
  // moderated, been replied to, or pinned a message) need no asking; anything
  // else is asked about once, one request at a time, and both answers are
  // remembered so a name typed over and over costs a single lookup.
  const MENTION_CHECK_SPACING_MS = 400;
  const MENTION_QUEUE_CAP = 40;
  const MENTION_STATUS_CAP = 500;
  const KNOWN_USERS_CAP = 5000;

  // The messages seen from each user this session, for their user card. Kept
  // regardless of the on-screen history size or the repeat filter. Both this
  // and the card cache are keyed by username, so on a big channel they would
  // grow with every distinct chatter for as long as the session lasts; both
  // are kept in least-recently-used order (re-inserting moves a key to the
  // end) and trimmed from the front.
  const HISTORY_PER_USER = 25;
  const HISTORY_USERS_CAP = 500;
  const USER_CARD_CACHE_CAP = 50;
  const USER_CARD_TTL_MS = 3 * 60 * 1000;

  const HOST_FUNCTIONS = ['fetch', 'WebSocket', 'setTimeout', 'clearTimeout', 'now'];

  /**
   * @param {object} opts
   * @param {string} opts.slug        the channel, as typed (may be empty: nothing to join)
   * @param {object} opts.settings    a sanitized settings object (settings.js `sanitize`)
   * @param {object} opts.host        { fetch, WebSocket, setTimeout, clearTimeout, now }
   * @param {(ops: object[]) => void} opts.onOps   receives every batch of operations
   * @param {object} [opts.config]    { kickApiBase, pusherAppKey, pusherCluster } (config.js)
   * @param {boolean} [opts.overlay]  OBS overlay: no status lines, a screenful of history
   * @param {(name, data) => void} [opts.onUnknown]  Kick events nothing here recognises
   * @param {(error) => void} [opts.onError]  an exception thrown by onOps
   */
  function createChatSession(opts) {
    const o = opts || {};
    const host = o.host || {};
    const missing = HOST_FUNCTIONS.filter((name) => typeof host[name] !== 'function');
    if (missing.length) throw new TypeError(`createChatSession: host has no ${missing.join(', ')}`);
    if (typeof o.onOps !== 'function') throw new TypeError('createChatSession: onOps is required');
    if (!o.settings || typeof o.settings !== 'object') throw new TypeError('createChatSession: settings are required');

    const slug = typeof o.slug === 'string' ? o.slug : '';
    const overlay = o.overlay === true;
    const config = o.config || {};
    let settings = o.settings;

    // The host's functions, taken once and only ever called as plain
    // functions - never as methods of `host` - so a browser can hand over its
    // own fetch and setTimeout as they are.
    const hostFetch = host.fetch;
    const HostSocket = host.WebSocket;
    const setTimer = host.setTimeout;
    const clearTimer = host.clearTimeout;
    const now = host.now;
    const onOps = o.onOps;
    const onError = typeof o.onError === 'function' ? o.onError : null;

    const kick = new Kick.KickApi({ baseUrl: config.kickApiBase, fetchImpl: hostFetch, now });
    let relay = null;
    let started = false;
    let stopped = false;

    // Filled in from channel resolution: the channel's own subscriber badge
    // images, one per months-tier, sorted by months ascending.
    let subscriberBadges = [];

    // -------------------------------------------------------------------
    // Operations out
    //
    // Everything that happens in one go - a frame from Kick, a settings
    // change, the history backfill - is one batch, handed to onOps once it is
    // complete. History is trimmed at the end of any batch that added rows, so
    // a burst costs one trim however many rows it carried.
    // -------------------------------------------------------------------

    let outbox = null;
    let appended = false;

    function emit(op) {
      if (outbox) outbox.push(op);
      else batch(() => emit(op));
    }

    // After stop() nothing reaches the host, whatever is still in flight.
    //
    // A host that throws from onOps does not get to break the session: the
    // batch is often being sent from inside Kick's socket callbacks, and an
    // exception there would skip the reconnect. It goes to onError when there
    // is one, and is otherwise rethrown on a timer of its own, so it still
    // shows up wherever the host reports uncaught errors.
    function batch(fn) {
      if (outbox) return fn();
      outbox = [];
      appended = false;
      try {
        return fn();
      } finally {
        if (appended) trimRows();
        const ops = outbox;
        outbox = null;
        if (ops.length && !stopped) deliver(ops);
      }
    }

    function deliver(ops) {
      try {
        onOps(ops);
      } catch (error) {
        if (onError) onError(error);
        else setTimer(() => {
          throw error;
        }, 0);
      }
    }

    // -------------------------------------------------------------------
    // Rows: what the host is showing, oldest first, as far as the core knows.
    // The host keeps it right by drawing every operation and reporting the
    // rows it takes away on its own (dropRows).
    // -------------------------------------------------------------------

    const rows = []; // records: {id, kind, ...}
    const rowsById = new Map();
    let rowSeq = 0;
    // Set by the host while the viewer has scrolled up to read: old rows are
    // then kept up to twice the history size instead of being trimmed from
    // under the reader.
    let held = false;
    // Whether message rows carry Kick's whole message (`raw`). Only wanted by
    // a host that pins messages, which has to hand Kick the message back as
    // Kick sent it; everyone else is spared holding on to it.
    let includeRaw = false;

    function nextId() {
      rowSeq += 1;
      return `r${rowSeq}`;
    }

    function appendRow(record, row) {
      rows.push(record);
      rowsById.set(record.id, record);
      appended = true;
      emit({ op: 'append', row });
    }

    function removeRow(record) {
      const at = rows.indexOf(record);
      if (at !== -1) rows.splice(at, 1);
      rowsById.delete(record.id);
      emit({ op: 'remove', id: record.id });
    }

    function historyLimit() {
      if (overlay) return PINNED_HISTORY;
      return settings.scrollback ? settings.historyLimit : PINNED_HISTORY;
    }

    function trimRows() {
      const limit = held ? historyLimit() * 2 : historyLimit();
      if (rows.length <= limit) return;
      const gone = rows.splice(0, rows.length - limit);
      for (const record of gone) rowsById.delete(record.id);
      emit({ op: 'trim', keep: rows.length, ids: gone.map((record) => record.id) });
    }

    // Plain lines: joining, connected, errors. `text` only.
    function systemLine(text, isError) {
      const id = nextId();
      appendRow({ id, kind: 'line' }, {
        kind: 'line', id, style: 'system', error: !!isError, icon: null, segs: [{ t: 'text', text }],
      });
    }

    // Strings, {user} objects and count segments into segments. A username is
    // a segment of its own so it can be styled and clicked, and Kick named
    // this person, so the name is real whatever chat types. A {user} with no
    // name is dropped, as the page always has.
    function segments(list) {
      const out = [];
      for (const part of list) {
        if (typeof part === 'string') {
          out.push({ t: 'text', text: part });
        } else if (part && part.t === 'count') {
          out.push(part);
        } else if (part && part.user) {
          noteUser(part.user);
          out.push({ t: 'user', name: part.user });
        }
      }
      return out;
    }

    // A number with its unit, left for the host to format: the web page groups
    // digits in the viewer's own locale ("1,204 viewers"), which takes Intl.
    const count = (n, unit) => ({ t: 'count', n: Number(n), unit, units: `${unit}s` });

    // Moderation lines. A timeout is a record, not an occasion, so it is a
    // line rather than a card.
    function eventLine(style, icon, parts) {
      const id = nextId();
      appendRow({ id, kind: 'line' }, { kind: 'line', id, style, error: false, icon, segs: segments(parts) });
    }

    // Subs, gifts, Kicks, rewards and hosts are the moments a channel notices,
    // and a line of grey text among five hundred messages is not how they
    // should arrive: they are cards - the icon larger, who did what on the
    // first line, and the number that matters underneath.
    function eventCard(card, icon, head, detail) {
      const id = nextId();
      const headSegs = segments(head);
      const detailSegs = segments(detail || []);
      appendRow({ id, kind: 'card' }, { kind: 'card', id, card, icon, head: headSegs, detail: detailSegs });
    }

    // -------------------------------------------------------------------
    // Mentions
    // -------------------------------------------------------------------

    const knownUsers = new Set(); // lowercase names seen as real users
    const mentionStatus = new Map(); // lowercase name -> true | false
    const mentionQueue = []; // names waiting to be asked about
    const mentionQueued = new Set();
    // Names with an unverified mention part out there. Kept so that a new
    // chatter, the common case by far, costs no operation at all unless
    // someone actually typed their name earlier.
    const awaitingMentions = new Set();
    let mentionTimer = null;
    // Set from the moment a lookup's timer fires until its answer is in, so a
    // name queued meanwhile waits for it: strictly one request at a time.
    let mentionInFlight = false;

    // Every real username the session comes across, from any payload Kick sends.
    function noteUser(name) {
      const key = String(name || '').trim().toLowerCase();
      if (!key || knownUsers.has(key)) return;
      knownUsers.add(key);
      while (knownUsers.size > KNOWN_USERS_CAP) {
        knownUsers.delete(knownUsers.values().next().value);
      }
      // Someone may have been mentioned before they ever showed up.
      markMentionsVerified(key);
    }

    function isKnownUser(key) {
      return knownUsers.has(key) || mentionStatus.get(key) === true;
    }

    function markMentionsVerified(key) {
      if (!awaitingMentions.delete(key)) return;
      emit({ op: 'verify', key });
    }

    function rememberMentionStatus(key, isUser) {
      mentionStatus.set(key, isUser);
      while (mentionStatus.size > MENTION_STATUS_CAP) {
        mentionStatus.delete(mentionStatus.keys().next().value);
      }
      if (isUser) markMentionsVerified(key);
      else awaitingMentions.delete(key); // settled: it stays plain text
    }

    // `name` is what was typed, which is what Kick is asked about; `key` is its
    // lowercase form, which is what everything here is keyed on.
    function queueMentionCheck(key, name) {
      if (!slug || mentionStatus.has(key) || mentionQueued.has(key) || knownUsers.has(key)) return;
      mentionQueued.add(key);
      mentionQueue.push({ key, name });
      // Spam can name a lot of things that are not users; the oldest waiting
      // ones matter least.
      while (mentionQueue.length > MENTION_QUEUE_CAP) {
        mentionQueued.delete(mentionQueue.shift().key);
      }
      pumpMentionQueue();
    }

    // One lookup at a time, spaced out: this runs off whatever chat types, so
    // it must never turn into a burst of requests at Kick.
    function pumpMentionQueue() {
      if (stopped || mentionTimer || mentionInFlight || !mentionQueue.length) return;
      mentionTimer = setTimer(async () => {
        mentionTimer = null;
        if (stopped) return;
        const next = mentionQueue.shift();
        if (next) {
          mentionQueued.delete(next.key);
          mentionInFlight = true;
          try {
            const found = await kick.verifyUser(slug, next.name);
            if (!stopped) batch(() => rememberMentionStatus(next.key, !!found));
          } catch (_e) {
            // Kick unreachable or unhappy: leave the name unresolved rather
            // than remembering a "no" that was never really an answer.
          } finally {
            mentionInFlight = false;
          }
        }
        pumpMentionQueue();
      }, MENTION_CHECK_SPACING_MS);
    }

    // Plain text into text and mention parts. An unverified name is queued for
    // a lookup, unless Kick has already said it is nobody.
    function textParts(text, out) {
      const pattern = new RegExp(MENTION_SOURCE, 'g');
      let lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const start = match.index + match[1].length;
        if (start > lastIndex) out.push({ t: 'text', text: text.slice(lastIndex, start) });
        const name = match[2];
        const key = name.toLowerCase();
        const verified = isKnownUser(key);
        if (!verified && mentionStatus.get(key) !== false) {
          awaitingMentions.add(key);
          while (awaitingMentions.size > MENTION_STATUS_CAP) {
            awaitingMentions.delete(awaitingMentions.values().next().value);
          }
          queueMentionCheck(key, name);
        }
        out.push({ t: 'mention', name, key, verified });
        lastIndex = pattern.lastIndex;
      }
      if (lastIndex < text.length) out.push({ t: 'text', text: text.slice(lastIndex) });
    }

    // Message text into parts: text, emotes (combined into one with a count
    // when the viewer wants spam collapsed), and mentions.
    function contentParts(content) {
      const out = [];
      for (const part of Kick.parseContent(content, { combine: settings.collapseEmotes })) {
        if (part.type === 'text') textParts(part.text, out);
        else out.push({ t: 'emote', id: part.id, name: part.name, url: emoteUrl(part.id), count: part.count });
      }
      return out;
    }

    // -------------------------------------------------------------------
    // Repeated messages (per user)
    //
    // Keyed on user + normalized content. Once the SAME user has posted it
    // `dedupeRepeats` times inside the last `dedupeWindowSec` seconds, a
    // further copy is counted onto the row already there (x2, x3, ...) instead
    // of being sent again; other users posting the same text are unaffected.
    // -------------------------------------------------------------------

    const recentMessages = new Map(); // "user\ncontent" -> [timestamps]
    // The row currently standing for each key, so a repeat can be counted onto
    // it. Kept in step with recentMessages by the prune below, so it cannot
    // outgrow the window either.
    const repeatRows = new Map(); // key -> row id
    let lastPrune = 0;

    function pruneRecent(at, windowMs) {
      for (const [key, times] of recentMessages) {
        const kept = times.filter((t) => at - t <= windowMs);
        if (kept.length) {
          recentMessages.set(key, kept);
        } else {
          recentMessages.delete(key);
          repeatRows.delete(key);
        }
      }
    }

    // Records the message and says whether it counts as a repeat. The key comes
    // back either way, so the row that is sent can be registered as the one a
    // later repeat counts onto. Recording happens even with the filter off, so
    // turning it on mid-stream already has history.
    function repeatState(username, content) {
      const at = now();
      const windowMs = settings.dedupeWindowSec * 1000;
      if (at - lastPrune > 5000) {
        pruneRecent(at, windowMs);
        lastPrune = at;
      }

      const text = normalizeContent(content);
      if (!text) return { key: null, repeat: false };
      const key = `${(username || '').toLowerCase()}\n${text}`;
      const times = (recentMessages.get(key) || []).filter((t) => at - t <= windowMs);
      const seenBefore = times.length;
      times.push(at);
      recentMessages.set(key, times);

      return { key, repeat: settings.dedupe && seenBefore >= settings.dedupeRepeats };
    }

    // Adds this repeat to the row already there. False when there is no such
    // row any more - trimmed, removed, faded out - and the caller should send
    // the message as a row of its own instead.
    function countRepeat(key) {
      const id = key ? repeatRows.get(key) : null;
      const record = id ? rowsById.get(id) : null;
      if (!record) {
        if (key) repeatRows.delete(key);
        return false;
      }
      record.repeats += 1;
      emit({ op: 'update', id, patch: { repeats: record.repeats } });
      return true;
    }

    // -------------------------------------------------------------------
    // Per-user history, for user cards
    // -------------------------------------------------------------------

    const userHistory = new Map(); // lowercase username -> [{content, created_at}]
    const userCardCache = new Map(); // lowercase username -> {data, fetchedAt}
    // The user whose card is open, so their messages can be sent to it as they
    // arrive (a `history` operation) rather than only being there next time.
    let watchedUser = null;

    function historyEntry(m) {
      return { text: m.content || '', createdAt: m.created_at || null, parts: contentParts(m.content || '') };
    }

    function recordUserHistory(msg) {
      const key = (msg.username || '').toLowerCase();
      if (!key) return;
      noteUser(key);
      const list = userHistory.get(key) || [];
      list.push({ content: msg.content, created_at: msg.created_at });
      if (list.length > HISTORY_PER_USER) list.shift();
      userHistory.delete(key);
      userHistory.set(key, list);
      while (userHistory.size > HISTORY_USERS_CAP) {
        userHistory.delete(userHistory.keys().next().value);
      }
      if (key === watchedUser) {
        emit({ op: 'history', user: key, entry: historyEntry(msg), count: list.length });
      }
    }

    // -------------------------------------------------------------------
    // Messages
    // -------------------------------------------------------------------

    const seenIds = new Set();

    function notSeenBefore(msg) {
      if (!msg || !msg.id) return true;
      if (seenIds.has(msg.id)) return false;
      seenIds.add(msg.id);
      if (seenIds.size > SEEN_CAP) {
        // Drop the oldest half; Set iteration is insertion-ordered.
        let i = 0;
        for (const id of seenIds) {
          seenIds.delete(id);
          if (++i >= SEEN_CAP / 2) break;
        }
      }
      return true;
    }

    // The message a reply answers: who, and what they said.
    function replyData(replyTo) {
      noteUser(replyTo.username);
      return {
        msgId: replyTo.id,
        username: replyTo.username || null,
        senderId: replyTo.sender_id,
        text: replyTo.content || '',
        parts: contentParts(replyTo.content || ''),
      };
    }

    function appendMessage(msg) {
      recordUserHistory(msg);

      // With emotes combined, "KEKW KEKW KEKW" and "KEKW KEKW" draw as the same
      // emote with a different count, so they count as the same message too.
      const compared = settings.collapseEmotes ? collapseRepeatedEmotes(msg.content) : msg.content;
      const { key: repeatKey, repeat } = repeatState(msg.username, compared);
      // A repeat is added to the row already there. If that row is gone,
      // countRepeat says so and this one is sent fresh instead.
      if (repeat && countRepeat(repeatKey)) return;
      const content = msg.content;

      // In the order the page has always worked them out, since parsing a
      // mention can queue a lookup: the reply's text, then the message's.
      const me = mentionsMe(settings, content);
      const reply = msg.reply_to ? replyData(msg.reply_to) : null;
      const badgeItems = kickOrderBadges(msg.badges, msg.badges_v2, subscriberBadges);
      const badges = orderBadges(settings, badgeItems, false);
      const kickColor = HEX_COLOR.test(msg.color || '') ? msg.color : null;
      const color = usernameColor(settings, kickColor);
      const parts = contentParts(content);

      const id = nextId();
      const user = (msg.username || '').toLowerCase();
      const record = {
        id, kind: 'message', msgId: msg.id, user, text: content, kickColor, color,
        badgeItems, badges, mentionsMe: me, repeats: 1,
      };
      const row = {
        kind: 'message',
        id,
        msgId: msg.id,
        type: msg.type,
        username: msg.username,
        user,
        senderId: msg.sender_id,
        text: content,
        createdAt: msg.created_at,
        color,
        kickColor,
        badges,
        parts,
        reply,
        mentionsMe: me,
        repeats: 1,
        deleted: null,
      };
      if (includeRaw && msg.raw) row.raw = msg.raw;

      // This row now stands for the key, so a later repeat counts onto it.
      // Registered even with counting off, so turning it on mid-stream works
      // on the messages already there.
      if (repeatKey) repeatRows.set(repeatKey, id);
      appendRow(record, row);
    }

    // -------------------------------------------------------------------
    // Moderation
    // -------------------------------------------------------------------

    // Who is banned or timed out right now, as this session has seen it.
    // Kick's user card is cached for a few minutes on both sides, so straight
    // after a moderator acts this is the only source that is already right.
    // A timeout runs out on its own, so each name keeps when it does
    // (Infinity for a ban, or a timeout Kick gave no end for); an expired one
    // is no longer banned. Kept to a fixed size, oldest first.
    const BANNED_CAP = 1000;
    const bannedNow = new Map(); // lowercase username -> expiry, epoch ms

    function rememberBan(name, ev) {
      let until = Infinity;
      if (!ev.permanent) {
        const end = ev.expires_at ? parseTime(ev.expires_at) : NaN;
        if (!Number.isNaN(end)) until = end;
        else if (ev.duration_min != null) until = now() + ev.duration_min * 60000;
      }
      bannedNow.delete(name);
      bannedNow.set(name, until);
      while (bannedNow.size > BANNED_CAP) bannedNow.delete(bannedNow.keys().next().value);
    }

    function isBanned(username) {
      const name = String(username || '').toLowerCase();
      const until = bannedNow.get(name);
      if (until === undefined) return false;
      if (until > now()) return true;
      bannedNow.delete(name);
      return false;
    }

    function markDeleted(record, reason) {
      const mode = settings.deletedMessages;
      if (mode === 'keep') return;
      if (mode === 'remove') {
        removeRow(record);
        return;
      }
      record.deleted = reason;
      emit({ op: 'update', id: record.id, patch: { deleted: reason } });
    }

    function messageRows() {
      return rows.filter((record) => record.kind === 'message');
    }

    function onMessageDeleted(ev) {
      const id = String(ev.message_id);
      const record = rows.find((r) => r.kind === 'message' && r.msgId === id);
      if (record) markDeleted(record, 'deleted');
    }

    function onChatCleared() {
      for (const record of messageRows()) markDeleted(record, 'chat cleared');
      if (settings.showModeration) eventLine('mod', '🧹', ['Chat was cleared by a moderator']);
    }

    function onUserBanned(ev) {
      const name = (ev.username || '').toLowerCase();
      // Before the showModeration check: whether the line is shown is a display
      // choice, but who is banned decides what a user card offers.
      if (name) rememberBan(name, ev);
      for (const record of messageRows()) {
        if (record.user === name) markDeleted(record, ev.permanent ? 'banned' : 'timed out');
      }
      if (!settings.showModeration) return;
      const by = ev.by ? [' by ', { user: ev.by }] : [];
      if (ev.permanent) {
        eventLine('mod', '🔨', [{ user: ev.username }, ' was banned', ...by]);
      } else {
        eventLine('mod', '⏳', [{ user: ev.username }, ` was timed out for ${durationText(ev.duration_min)}`, ...by]);
      }
    }

    function onUserUnbanned(ev) {
      bannedNow.delete((ev.username || '').toLowerCase());
      if (!settings.showModeration) return;
      const by = ev.by ? [' by ', { user: ev.by }] : [];
      eventLine('mod', '🔓', [{ user: ev.username }, ev.permanent ? ' was unbanned' : "'s timeout was lifted", ...by]);
    }

    // -------------------------------------------------------------------
    // The pinned message. The pin is sent whatever settings.showPinned says;
    // whether it is shown, and whether it starts collapsed, is the host's.
    // -------------------------------------------------------------------

    let pinTimer = null;

    function showPin(ev) {
      const msg = ev.message || {};
      noteUser(msg.username);
      const kickColor = HEX_COLOR.test(msg.color || '') ? msg.color : null;
      const pin = {
        msgId: msg.id != null ? msg.id : null,
        username: msg.username || null,
        color: usernameColor(settings, kickColor),
        text: msg.content || '',
        parts: contentParts(msg.content || ''),
        by: ev.by || null,
        expiresAt: ev.expires_at || null,
        durationMin: ev.duration_min != null ? ev.duration_min : null,
      };
      clearTimer(pinTimer);
      pinTimer = null;
      // Expiry is an absolute timestamp (Kick's pins default to 20 hours).
      // Capped, since hosts clamp very long timeouts.
      const expires = ev.expires_at ? parseTime(ev.expires_at) : NaN;
      if (!Number.isNaN(expires)) {
        const remaining = expires - now();
        if (remaining <= 0) {
          // Already over: nothing to show.
          emit({ op: 'pin', pin: null });
          return;
        }
        pinTimer = setTimer(() => batch(clearPin), Math.min(remaining, 0x7fffffff));
      }
      emit({ op: 'pin', pin });
    }

    function clearPin() {
      clearTimer(pinTimer);
      pinTimer = null;
      emit({ op: 'pin', pin: null });
    }

    // -------------------------------------------------------------------
    // Chat events (subs, gifts, Kicks, rewards, hosts)
    // -------------------------------------------------------------------

    function onSubscription(ev) {
      if (!settings.showSubs) return;
      const months = ev.months || 1;
      eventCard(
        'sub',
        '★',
        [{ user: ev.username }, ' subscribed'],
        // A resub's months are the point of it; a first sub has no number, and
        // saying "1 month" of someone who just arrived reads as a downgrade.
        months > 1 ? [count(months, 'month')] : ['new subscriber']
      );
    }

    function onGiftedSubs(ev) {
      if (!settings.showGifts) return;
      const recipients = ev.recipients || [];
      const detail = [count(recipients.length, 'sub')];
      // Named while the list is short enough to read. Kick sends up to 25 in
      // one event, and twenty-five names is a wall, not information.
      if (recipients.length && recipients.length <= 5) {
        detail.push(' to ');
        recipients.forEach((name, i) => {
          if (i > 0) detail.push(', ');
          detail.push({ user: name });
        });
      }
      eventCard('gift', '🎁', [{ user: ev.gifter || 'Someone' }, ' gifted subs'], detail);
    }

    // Kicks are Kick's paid gifts. The amount is the number of Kicks spent and
    // is the whole point, so it leads; the gift's own name says which one it
    // was. A message only comes with the larger gifts.
    function onKicks(ev) {
      if (!settings.showKicks) return;
      const detail = [];
      if (ev.amount) detail.push(count(ev.amount, 'Kick'));
      if (ev.gift) detail.push(detail.length ? ` - ${ev.gift}` : ev.gift);
      if (ev.message) detail.push(`: ${ev.message}`);
      eventCard('kicks', '⚡', [{ user: ev.username }, ' sent Kicks'], detail);
    }

    // Channel-point redemptions: the reward's name leads, and what the
    // redeemer typed follows where the reward asked for something.
    function onReward(ev) {
      if (!settings.showRewards) return;
      const detail = [];
      if (ev.reward) detail.push(ev.reward);
      if (ev.input) detail.push(detail.length ? `: ${ev.input}` : ev.input);
      eventCard('reward', '🎟️', [{ user: ev.username || 'Someone' }, ' redeemed'], detail);
    }

    function onHost(ev) {
      if (!settings.showHosts) return;
      const detail = [];
      // The viewer count is the hosting channel's own: the viewers brought over.
      if (ev.viewers) detail.push(count(ev.viewers, 'viewer'));
      if (ev.message) detail.push(detail.length ? ` - ${ev.message}` : ev.message);
      eventCard('host', '📺', [{ user: ev.host_username }, ' is hosting'], detail);
    }

    // -------------------------------------------------------------------
    // Connection / stream status
    //
    // Three things can make a chat go quiet, and the status says which:
    //   - the WebSocket to Kick's feed is down (kick.js reconnects with backoff)
    //   - the socket is up but Kick hasn't confirmed the chat subscription
    //   - the channel simply isn't live
    // -------------------------------------------------------------------

    const conn = { socket: false, subscribed: false, live: null, joined: false };

    function statusOf(failed) {
      let state = 'ok';
      let text = '';
      let level = '';
      if (failed) {
        state = 'failed';
      } else if (!conn.socket) {
        state = conn.joined ? 'reconnecting' : 'connecting';
        text = conn.joined ? 'Connection to Kick lost, reconnecting...' : 'Connecting to Kick...';
        level = 'warn';
      } else if (!conn.subscribed) {
        state = 'subscribing';
        text = 'Waiting for Kick to confirm the chat subscription...';
        level = 'warn';
      } else if (conn.live === false) {
        state = 'offline';
        text = `${slug} is offline - chat still works`;
        level = 'offline';
      }
      return { state, text, level, socket: conn.socket, subscribed: conn.subscribed, live: conn.live, joined: conn.joined };
    }

    function updateStatus() {
      emit({ op: 'status', status: statusOf(false) });
    }

    function onStreamLive(ev) {
      conn.live = true;
      if (!overlay) systemLine(`${slug} went live${ev.title ? `: ${ev.title}` : ''}`);
      updateStatus();
    }

    function onStreamOffline() {
      conn.live = false;
      if (!overlay) systemLine(`${slug} went offline`);
      updateStatus();
    }

    const EVENT_HANDLERS = {
      stream_live: onStreamLive,
      stream_offline: onStreamOffline,
      message_deleted: onMessageDeleted,
      chat_cleared: onChatCleared,
      user_banned: onUserBanned,
      user_unbanned: onUserUnbanned,
      pin_created: showPin,
      pin_deleted: clearPin,
      subscription: onSubscription,
      gifted_subs: onGiftedSubs,
      kicks: onKicks,
      reward: onReward,
      host: onHost,
    };

    function onEvent(ev) {
      const handler = ev && EVENT_HANDLERS[ev.type];
      if (handler) handler(ev);
    }

    // -------------------------------------------------------------------
    // Joining
    // -------------------------------------------------------------------

    let liveMessages = 0;

    // The pin and recent messages from Kick's history endpoint: on joining,
    // and after a reconnect, when a pin may have come or gone unnoticed.
    async function refreshPinAndHistory(channelId, backfill) {
      try {
        const { pinned, messages } = await kick.pinnedAndHistory(channelId);
        if (stopped) return;
        batch(() => {
          if (backfill) for (const m of messages) if (notSeenBefore(m)) appendMessage(m);
          if (pinned) showPin(pinned);
          else clearPin();
        });
      } catch (_e) {
        /* history is a nice-to-have; live chat works without it */
      }
    }

    async function start() {
      if (started || stopped) return;
      started = true;
      if (!slug) return;
      batch(() => {
        if (!overlay) systemLine(`joining ${slug}...`);
        updateStatus();
      });

      let info;
      try {
        info = await kick.resolveChannel(slug);
      } catch (e) {
        if (stopped) return;
        const notFound = e && e.status === 404;
        batch(() => {
          systemLine(notFound ? `no such channel: ${slug}` : 'Kick API is unavailable', true);
          emit({ op: 'status', status: statusOf(true) });
        });
        return;
      }
      if (stopped) return;

      batch(() => {
        subscriberBadges = info.subscriber_badges || [];
        conn.live = info.live;
        emit({
          op: 'channel',
          channel: { slug: info.slug, channelId: info.channel_id, chatroomId: info.chatroom_id, live: info.live },
        });
      });

      // Recent messages + current pin, so the chat isn't empty on open.
      await refreshPinAndHistory(info.channel_id, true);
      if (stopped) return;

      relay = new Kick.PusherRelay({
        appKey: config.pusherAppKey,
        cluster: config.pusherCluster,
        chatroomId: info.chatroom_id,
        channelId: info.channel_id,
        WebSocket: HostSocket,
        setTimeout: setTimer,
        clearTimeout: clearTimer,
        now,
        // Each guarded on `stopped` as well as the relay being closed: a
        // callback already running when stop() is called finds out here.
        onMessage: (msg) => batch(() => {
          if (stopped || !notSeenBefore(msg)) return;
          liveMessages += 1;
          appendMessage(msg);
        }),
        onEvent: (ev) => batch(() => {
          if (!stopped) onEvent(ev);
        }),
        onSocket: (open) => batch(() => {
          if (stopped) return;
          const was = conn.socket;
          conn.socket = open;
          if (!open && was && !overlay) systemLine('lost connection to Kick, reconnecting...', true);
          updateStatus();
        }),
        onSubscribed: (ok) => batch(() => {
          if (stopped) return;
          conn.subscribed = ok;
          if (ok) {
            const rejoin = conn.joined;
            conn.joined = true;
            if (!overlay) {
              systemLine(rejoin ? `reconnected to ${info.slug}'s chat` : `connected to ${info.slug}'s chat`);
              if (!rejoin && info.live === false) systemLine(`${info.slug} is not live right now - you'll still see chat`);
            }
            // After a drop, a pin may have changed while nobody was listening.
            if (rejoin) refreshPinAndHistory(info.channel_id, false);
          }
          updateStatus();
        }),
        onUnknown: typeof o.onUnknown === 'function'
          ? (name, data) => {
            const report = o.onUnknown;
            if (!stopped) report(name, data);
          }
          : undefined,
      });
      relay.connect();
    }

    function stop() {
      stopped = true;
      if (relay) relay.close();
      relay = null;
      clearTimer(mentionTimer);
      mentionTimer = null;
      clearTimer(pinTimer);
      pinTimer = null;
    }

    // -------------------------------------------------------------------
    // Settings
    // -------------------------------------------------------------------

    // Everything about the rows already sent that a setting can change: the
    // username colour, the badges' order and visibility, and the mention
    // highlight. Only rows that actually change get an update. The history
    // size is applied straight away too.
    function updateSettings(next) {
      batch(() => {
        const prev = settings;
        settings = next;
        const recolor = prev.monocolor !== next.monocolor || prev.monocolorValue !== next.monocolorValue;
        const rebadge =
          prev.badgeOrder.join(',') !== next.badgeOrder.join(',') ||
          prev.hiddenBadges.join(',') !== next.hiddenBadges.join(',');
        const remention = prev.mentionMe !== next.mentionMe;
        if (recolor || rebadge || remention) {
          for (const record of messageRows()) {
            const patch = {};
            let changed = false;
            if (recolor) {
              const color = usernameColor(next, record.kickColor);
              if (color !== record.color) {
                record.color = patch.color = color;
                changed = true;
              }
            }
            if (rebadge) {
              const badges = orderBadges(next, record.badgeItems, false);
              if (!sameBadges(badges, record.badges)) {
                record.badges = patch.badges = badges;
                changed = true;
              }
            }
            if (remention) {
              const me = mentionsMe(next, record.text);
              if (me !== record.mentionsMe) {
                record.mentionsMe = patch.mentionsMe = me;
                changed = true;
              }
            }
            if (changed) emit({ op: 'update', id: record.id, patch });
          }
        }
        trimRows();
      });
    }

    // -------------------------------------------------------------------
    // User cards
    // -------------------------------------------------------------------

    // Kick's user record as the protocol carries it, its badges resolved like
    // a message's but all of them shown.
    function cardData(data) {
      return {
        id: data.id != null ? data.id : null,
        username: data.username || null,
        slug: data.slug || null,
        profilePic: data.profile_pic || null,
        bio: data.bio || null,
        followers: data.followers_count != null ? data.followers_count : null,
        verified: data.verified === true,
        createdAt: data.created_at || null,
        followingSince: data.following_since || null,
        subscribedFor: data.subscribed_for != null ? data.subscribed_for : null,
        isModerator: data.is_moderator === true,
        isStaff: data.is_staff === true,
        isChannelOwner: data.is_channel_owner === true,
        banned: !!data.banned,
        badges: orderBadges(settings, kickOrderBadges(data.badges, data.badges_v2, subscriberBadges), true),
      };
    }

    function cachedUserCard(username) {
      const key = String(username || '').toLowerCase();
      const cached = userCardCache.get(key);
      if (!cached) return null;
      userCardCache.delete(key);
      if (now() - cached.fetchedAt >= USER_CARD_TTL_MS) return null;
      userCardCache.set(key, cached);
      return cardData(cached.data);
    }

    async function userCard(username) {
      const key = String(username || '').toLowerCase();
      if (!slug || !key) return { card: null, error: 'unavailable' };
      let data;
      try {
        data = await kick.userCard(slug, username);
      } catch (e) {
        return { card: null, error: e && e.status === 404 ? 'not_found' : 'unavailable' };
      }
      userCardCache.delete(key);
      userCardCache.set(key, { data, fetchedAt: now() });
      while (userCardCache.size > USER_CARD_CACHE_CAP) {
        userCardCache.delete(userCardCache.keys().next().value);
      }
      return { card: cardData(data), error: null };
    }

    // The messages seen from a user this session, newest first. Parsed now,
    // so a mention in them is as verified as it is anywhere else.
    function historyOf(username) {
      const list = userHistory.get(String(username || '').toLowerCase()) || [];
      return batch(() => list.slice().reverse().map(historyEntry));
    }

    // -------------------------------------------------------------------
    // The session
    // -------------------------------------------------------------------

    return {
      version: CORE_PROTOCOL_VERSION,
      start,
      stop,
      updateSettings,
      // Message text into parts, the same as a row's, for text the host draws
      // on its own (a reply's full text, an armed reply).
      parts: (text) => batch(() => contentParts(text)),
      userCard,
      cachedUserCard,
      userHistory: historyOf,
      watchUser: (username) => {
        watchedUser = username ? String(username).toLowerCase() : null;
      },
      isBanned,
      // A line of the host's own (a refused moderation action, say), so it
      // takes its place among the rows and is trimmed like them.
      note: (text, isError) => batch(() => systemLine(String(text), isError)),
      // Empties the chat for this viewer only: nothing is sent to Kick.
      clearLocal: () => batch(() => {
        rows.length = 0;
        rowsById.clear();
        // Every row these keys stood for has gone, so a later repeat has
        // nothing to count onto and should start a fresh row.
        repeatRows.clear();
        emit({ op: 'clear' });
        systemLine('chat cleared');
      }),
      setHeld: (value) => {
        held = !!value;
      },
      trim: () => batch(trimRows),
      // Rows the host took away by itself (the overlay's fade-out). Nothing is
      // sent back; the core just stops counting them as there.
      dropRows: (ids) => {
        for (const id of ids || []) {
          const record = rowsById.get(id);
          if (!record) continue;
          rowsById.delete(id);
          const at = rows.indexOf(record);
          if (at !== -1) rows.splice(at, 1);
        }
      },
      setIncludeRaw: (value) => {
        includeRaw = !!value;
      },
      liveMessages: () => liveMessages,
    };
  }

  return {
    CORE_PROTOCOL_VERSION,
    createChatSession,
    usernameColor,
    durationText,
    mentionsMe,
    collapseRepeatedEmotes,
    parseTime,
  };
});
