// BetterChat - the settings model: what a setting is, what it may hold, and
// how it survives a round trip through the URL.
//
// Split out of app.js because it is the one part with no DOM in it at all:
// constants, validation and serialization, nothing else. That makes it the
// piece worth testing directly, and keeps app.js to what it does with the
// DOM. Same shape as kick.js - a classic <script> in the browser, and
// require()-able from Node for the tests.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BetterChatSettings = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // Kick's own green, the accent this page is built around.
  const KICK_GREEN = '#53fc18';

  const SETTINGS_KEY = 'betterchat.settings';
  // Storage key from before the rename - read once so nobody loses settings.
  const LEGACY_SETTINGS_KEY = 'kick-chat-relay.settings';
  // With scrollback off the list is always pinned to the newest message, so
  // only a screenful or so needs to exist in the DOM.
  const PINNED_HISTORY = 100;

  // Keys are what the <select> in the settings panel offers; values are the
  // CSS font stacks. "custom" is handled separately (free-text font name).
  const FONT_STACKS = Object.freeze({
    system: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif',
    inter: 'Inter, "Segoe UI", Roboto, Arial, sans-serif',
    segoe: '"Segoe UI", Tahoma, Arial, sans-serif',
    roboto: 'Roboto, "Segoe UI", Arial, sans-serif',
    arial: 'Arial, Helvetica, sans-serif',
    verdana: 'Verdana, Geneva, sans-serif',
    tahoma: 'Tahoma, Geneva, sans-serif',
    trebuchet: '"Trebuchet MS", Helvetica, sans-serif',
    georgia: 'Georgia, "Times New Roman", serif',
    times: '"Times New Roman", Times, serif',
    mono: 'Consolas, "Cascadia Mono", "Courier New", monospace',
    comic: '"Comic Sans MS", "Comic Sans", cursive',
  });

  // Every badge is classified into one of these kinds so it can be shown or
  // hidden from the settings panel. Channel badge types map to themselves
  // ("other" for types we don't know); global badges are "level" or
  // "event" (everything else Kick hands out with an image_url).
  const BADGE_KINDS = Object.freeze([
    'broadcaster', 'staff', 'moderator', 'verified', 'founder', 'og', 'vip',
    'sub_gifter', 'subscriber', 'bot', 'level', 'event', 'other',
  ]);

  const DELETED_MODES = Object.freeze(['gray', 'remove', 'keep']);
  // What to do with a message the filter counts as a repeat: drop it, or add
  // it to the copy already on screen as "xN".
  const DEDUPE_MODES = Object.freeze(['hide', 'count']);
  // The anonymous viewer count. "ask" is the state before the viewer has
  // answered the banner, and is why this is not simply a boolean: a decline
  // has to be distinguishable from a question not yet put.
  const STATS_CHOICES = Object.freeze(['ask', 'on', 'off']);
  const TIMESTAMP_FORMATS = Object.freeze(['hm', 'hms']);

  // Shown next to the checkbox for each kind in the settings panel.
  const BADGE_LABELS = Object.freeze({
    broadcaster: 'Broadcaster',
    staff: 'Kick staff',
    moderator: 'Moderator',
    verified: 'Verified',
    founder: 'Founder',
    og: 'OG',
    vip: 'VIP',
    sub_gifter: 'Sub gifter',
    subscriber: 'Subscriber',
    bot: 'Bot',
    level: 'Chat level',
    event: 'Event / other Kick badges',
    other: 'Unknown badge types',
  });

  const DEFAULTS = Object.freeze({
    hiddenBadges: ['level'],
    // The order badges are drawn in, left to right. Not Kick's own order:
    // rank first, then the flavour badges. Must name every kind in
    // BADGE_KINDS - sanitize appends any that are missing.
    badgeOrder: [
      'level', 'broadcaster', 'staff', 'moderator', 'founder', 'og', 'vip',
      'subscriber', 'verified', 'event', 'other', 'sub_gifter', 'bot',
    ],
    fontSize: 20,
    fontFamily: 'mono',
    customFont: '',
    bgColor: '#0b0e0f',
    messageGap: 2,
    userCards: true,
    timestamps: false,
    timestampFormat: 'hm',
    mentionMe: '',
    scrollback: true,
    historyLimit: 1000,
    monocolor: false,
    monocolorValue: KICK_GREEN,
    dedupe: true,
    dedupeWindowSec: 5,
    dedupeRepeats: 1,
    dedupeMode: 'hide',
    stats: 'ask',
    collapseEmotes: true,
    deletedMessages: 'gray',
    showModeration: true,
    // The moderation controls themselves, where they are possible at all.
    modTools: true,
    showPinned: true,
    // Pinned messages arrive collapsed, and only open when the viewer says so.
    collapsePinned: false,
    showSubs: true,
    showGifts: true,
    showHosts: true,
    overlayFadeSec: 0,
  });

  const HEX6 = /^#[0-9a-f]{6}$/i;

  // A font name ends up inside a CSS value, so only plain characters are
  // kept - no quotes, semicolons, braces or url()-style punctuation.
  function cleanFontName(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/[^\w\s-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60);
  }

  function cleanUsername(value) {
    if (typeof value !== 'string') return '';
    return value.replace(/^@/, '').replace(/[^\w-]/g, '').slice(0, 30);
  }

  function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function oneOf(value, allowed, fallback) {
    return allowed.includes(value) ? value : fallback;
  }

  // Never trust what's in storage or the URL blindly - it's validated field
  // by field, and unknown keys are dropped.
  function sanitize(raw) {
    const s = { ...DEFAULTS };
    if (!raw || typeof raw !== 'object') return s;
    for (const key of Object.keys(DEFAULTS)) {
      if (typeof DEFAULTS[key] === 'boolean' && typeof raw[key] === 'boolean') s[key] = raw[key];
    }
    if (Array.isArray(raw.hiddenBadges)) {
      s.hiddenBadges = BADGE_KINDS.filter((kind) => raw.hiddenBadges.includes(kind));
    }
    // A stored order can be stale (a kind added since it was saved), short, or
    // simply junk from a hand-edited URL, so rebuild it as a real permutation
    // of BADGE_KINDS: the kinds it names, in its order, then whatever it left
    // out in the default order. Always a fresh array - DEFAULTS is shared.
    const placed = new Set();
    const order = [];
    const take = (kinds) => {
      for (const kind of kinds) {
        if (BADGE_KINDS.includes(kind) && !placed.has(kind)) {
          placed.add(kind);
          order.push(kind);
        }
      }
    };
    take(Array.isArray(raw.badgeOrder) ? raw.badgeOrder : []);
    take(DEFAULTS.badgeOrder);
    take(BADGE_KINDS); // backstop, in case a kind is missing from the default
    s.badgeOrder = order;
    s.fontSize = clampInt(raw.fontSize, 8, 40, DEFAULTS.fontSize);
    s.messageGap = clampInt(raw.messageGap, 0, 40, DEFAULTS.messageGap);
    if (raw.fontFamily === 'custom' || FONT_STACKS[raw.fontFamily]) s.fontFamily = raw.fontFamily;
    s.customFont = cleanFontName(raw.customFont);
    s.timestampFormat = oneOf(raw.timestampFormat, TIMESTAMP_FORMATS, DEFAULTS.timestampFormat);
    s.mentionMe = cleanUsername(raw.mentionMe);
    s.historyLimit = clampInt(raw.historyLimit, 10, 5000, DEFAULTS.historyLimit);
    s.dedupeWindowSec = clampInt(raw.dedupeWindowSec, 1, 3600, DEFAULTS.dedupeWindowSec);
    s.dedupeRepeats = clampInt(raw.dedupeRepeats, 1, 100, DEFAULTS.dedupeRepeats);
    if (typeof raw.monocolorValue === 'string' && HEX6.test(raw.monocolorValue)) {
      s.monocolorValue = raw.monocolorValue.toLowerCase();
    }
    if (typeof raw.bgColor === 'string' && HEX6.test(raw.bgColor)) {
      s.bgColor = raw.bgColor.toLowerCase();
    }
    s.deletedMessages = oneOf(raw.deletedMessages, DELETED_MODES, DEFAULTS.deletedMessages);
    s.dedupeMode = oneOf(raw.dedupeMode, DEDUPE_MODES, DEFAULTS.dedupeMode);
    s.stats = oneOf(raw.stats, STATS_CHOICES, DEFAULTS.stats);
    s.overlayFadeSec = clampInt(raw.overlayFadeSec, 0, 600, DEFAULTS.overlayFadeSec);
    return s;
  }

  // Consent is not something a link can grant on someone else's behalf, so it
  // stays out of the URL in both directions and out of an exported file. It
  // changes by the banner or its own switch, in the viewer's own browser, or
  // it does not change.
  //
  // Declared here rather than beside settingsAsParams below: settingsFromUrl
  // runs while this file is still being evaluated, so anything it reads has
  // to exist by this line.
  const NOT_SHAREABLE = new Set(['stats']);

  // Settings in the URL: ?fontSize=16&monocolor=1&hiddenBadges=level,event
  // Booleans accept 1/0/true/false/on/off, arrays are comma-separated.
  function settingsFromQuery(query) {
    const out = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (NOT_SHAREABLE.has(key) || !query.has(key)) continue;
      const v = query.get(key);
      const kind = Array.isArray(DEFAULTS[key]) ? 'array' : typeof DEFAULTS[key];
      if (kind === 'boolean') out[key] = ['1', 'true', 'on'].includes(v.toLowerCase());
      else if (kind === 'number') out[key] = Number(v);
      else if (kind === 'array') out[key] = v.split(',').map((x) => x.trim()).filter(Boolean);
      else out[key] = v;
    }
    return out;
  }

  // Only the settings that differ from the defaults, as URL parameters.
  function settingsAsParams(target) {
    const params = new URLSearchParams();
    for (const key of Object.keys(DEFAULTS)) {
      if (NOT_SHAREABLE.has(key)) continue;
      const value = target[key];
      if (JSON.stringify(value) === JSON.stringify(DEFAULTS[key])) continue;
      if (typeof value === 'boolean') params.set(key, value ? '1' : '0');
      else if (Array.isArray(value)) params.set(key, value.join(','));
      else params.set(key, String(value));
    }
    return params;
  }

  function fontFamilyCss(settings) {
    if (settings.fontFamily === 'custom') {
      // Fall back to the default stack if the custom name is empty or the
      // font isn't installed (the browser skips unknown families).
      return settings.customFont
        ? `"${settings.customFont}", ${FONT_STACKS.system}`
        : FONT_STACKS.system;
    }
    return FONT_STACKS[settings.fontFamily] || FONT_STACKS.system;
  }
  return {
    SETTINGS_KEY,
    LEGACY_SETTINGS_KEY,
    PINNED_HISTORY,
    KICK_GREEN,
    FONT_STACKS,
    BADGE_KINDS,
    BADGE_LABELS,
    DELETED_MODES,
    DEDUPE_MODES,
    STATS_CHOICES,
    TIMESTAMP_FORMATS,
    DEFAULTS,
    NOT_SHAREABLE,
    HEX6,
    cleanFontName,
    cleanUsername,
    clampInt,
    oneOf,
    sanitize,
    settingsFromQuery,
    settingsAsParams,
    fontFamilyCss,
  };
});
