// BetterChat - the settings model: what a setting is, what it may hold, and
// how it survives a round trip through the URL.
//
// Split out of app.js because it is the one part with no DOM in it at all:
// constants, validation and serialization, nothing else. That makes it the
// piece worth testing directly, and keeps app.js to what it does with the
// DOM. Same shape as kick.js - a classic <script> in the browser, and
// require()-able from Node for the tests.
//
// The starting value of every setting lives in defaults.json, beside this
// file, so defaults can be changed without touching code. This file still
// decides which settings exist and what each may hold; defaults.json is
// checked against that when it loads, and a mistake in it stops the page with
// a message naming the setting rather than letting it half-work.
//
// `ready` resolves once defaults.json is in. In Node it is read on the spot;
// in the browser it has to be fetched, so app.js waits on `ready` to start.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    api.useDefaults(require('./defaults.json'));
    api.ready = Promise.resolve(api);
    module.exports = api;
  } else {
    root.BetterChatSettings = api;
    api.ready = fetch('/defaults.json')
      .then((res) => {
        if (!res.ok) throw new Error(`defaults.json could not be loaded (HTTP ${res.status})`);
        return res.json().catch((err) => {
          throw new Error(`defaults.json is not valid JSON: ${err.message}`);
        });
      })
      .then((json) => {
        api.useDefaults(json);
        return api;
      });
  }
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

  // Which settings exist and what each may hold. sanitize reads these for a
  // viewer's stored or linked settings, and defaultsProblems reads the same
  // tables for defaults.json, so every rule is written down once.
  //
  // Adding a setting: give it a default in defaults.json and an entry here.
  const BOOLEAN_KEYS = Object.freeze([
    'userCards', 'timestamps', 'scrollback', 'monocolor', 'dedupe',
    'collapseEmotes', 'showModeration',
    // The moderation controls themselves, where they are possible at all.
    'modTools',
    'showPinned',
    // Pinned messages arrive collapsed, and only open when the viewer says so.
    'collapsePinned',
    'showSubs', 'showGifts', 'showHosts',
  ]);
  const NUMBER_RANGES = Object.freeze({
    fontSize: [8, 40],
    messageGap: [0, 40],
    historyLimit: [10, 5000],
    dedupeWindowSec: [1, 3600],
    dedupeRepeats: [1, 100],
    overlayFadeSec: [0, 600],
  });
  const CHOICE_KEYS = Object.freeze({
    timestampFormat: TIMESTAMP_FORMATS,
    deletedMessages: DELETED_MODES,
  });
  const COLOR_KEYS = Object.freeze(['bgColor', 'monocolorValue']);
  // Free text: cleaned rather than checked against a list.
  const TEXT_KEYS = Object.freeze({
    customFont: { clean: cleanFontName, what: 'a font name (letters, digits, spaces and -)' },
    mentionMe: { clean: cleanUsername, what: 'a username without the @' },
  });
  // fontFamily, hiddenBadges and badgeOrder have rules of their own, below.
  // badgeOrder is the order badges are drawn in, left to right, and has to
  // name every kind in BADGE_KINDS exactly once.
  const SETTING_KEYS = Object.freeze([
    ...BOOLEAN_KEYS,
    ...Object.keys(NUMBER_RANGES),
    ...Object.keys(CHOICE_KEYS),
    ...COLOR_KEYS,
    ...Object.keys(TEXT_KEYS),
    'fontFamily', 'hiddenBadges', 'badgeOrder',
  ]);

  // The anonymous viewer count is not a preference with a default: it is a
  // question each viewer answers. Everyone starts at "ask" whatever
  // defaults.json says, and defaults.json may not mention it at all -
  // otherwise a single edit could opt every viewer in without asking.
  const CONSENT_DEFAULT = 'ask';

  let DEFAULTS = null;

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

  const isFontKey = (value) =>
    value === 'custom' || Object.prototype.hasOwnProperty.call(FONT_STACKS, value);

  // Never trust what's in storage or the URL blindly - it's validated field
  // by field, and unknown keys are dropped. Arrays always come back as fresh
  // copies: DEFAULTS is frozen and shared.
  function sanitize(raw) {
    const s = {
      ...DEFAULTS,
      hiddenBadges: [...DEFAULTS.hiddenBadges],
      badgeOrder: [...DEFAULTS.badgeOrder],
    };
    if (!raw || typeof raw !== 'object') return s;
    for (const key of BOOLEAN_KEYS) {
      if (typeof raw[key] === 'boolean') s[key] = raw[key];
    }
    if (Array.isArray(raw.hiddenBadges)) {
      s.hiddenBadges = BADGE_KINDS.filter((kind) => raw.hiddenBadges.includes(kind));
    }
    // A stored order can be stale (a kind added since it was saved), short, or
    // simply junk from a hand-edited URL, so rebuild it as a real permutation
    // of BADGE_KINDS: the kinds it names, in its order, then whatever it left
    // out in the default order.
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
    for (const [key, [min, max]] of Object.entries(NUMBER_RANGES)) {
      s[key] = clampInt(raw[key], min, max, DEFAULTS[key]);
    }
    if (isFontKey(raw.fontFamily)) s.fontFamily = raw.fontFamily;
    // Only a string replaces the default, so a viewer with nothing stored
    // gets what defaults.json says rather than an empty string.
    for (const [key, { clean }] of Object.entries(TEXT_KEYS)) {
      if (typeof raw[key] === 'string') s[key] = clean(raw[key]);
    }
    for (const [key, allowed] of Object.entries(CHOICE_KEYS)) {
      s[key] = oneOf(raw[key], allowed, DEFAULTS[key]);
    }
    for (const key of COLOR_KEYS) {
      if (typeof raw[key] === 'string' && HEX6.test(raw[key])) s[key] = raw[key].toLowerCase();
    }
    s.stats = oneOf(raw.stats, STATS_CHOICES, DEFAULTS.stats);
    return s;
  }

  // Everything wrong with a defaults.json, as sentences naming the setting;
  // empty when it is fine. Strict where a viewer's settings are quietly
  // repaired, because the only person who reads these is whoever just edited
  // the file, and a silent repair would hide the mistake from exactly them.
  function defaultsProblems(json) {
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      return ['it must hold a single JSON object, { ... }'];
    }
    const problems = [];
    if ('stats' in json) {
      problems.push('"stats" cannot have a default: every viewer is asked first');
    }
    for (const key of Object.keys(json)) {
      if (key !== 'stats' && !SETTING_KEYS.includes(key)) problems.push(`"${key}" is not a setting`);
    }
    const check = (key, ok, what) => {
      if (!(key in json)) problems.push(`"${key}" is missing`);
      else if (!ok(json[key])) problems.push(`"${key}" must be ${what}`);
    };
    for (const key of BOOLEAN_KEYS) check(key, (v) => typeof v === 'boolean', 'true or false');
    for (const [key, [min, max]] of Object.entries(NUMBER_RANGES)) {
      check(key, (v) => Number.isInteger(v) && v >= min && v <= max, `a whole number from ${min} to ${max}`);
    }
    for (const [key, allowed] of Object.entries(CHOICE_KEYS)) {
      check(key, (v) => allowed.includes(v), `one of ${allowed.map((a) => `"${a}"`).join(', ')}`);
    }
    for (const key of COLOR_KEYS) {
      check(key, (v) => typeof v === 'string' && HEX6.test(v), 'a colour written like "#0b0e0f"');
    }
    for (const [key, { clean, what }] of Object.entries(TEXT_KEYS)) {
      check(key, (v) => typeof v === 'string' && clean(v) === v, what);
    }
    check(
      'fontFamily',
      isFontKey,
      `"custom" or one of ${Object.keys(FONT_STACKS).map((k) => `"${k}"`).join(', ')}`
    );
    check(
      'hiddenBadges',
      (v) => Array.isArray(v) && v.every((kind) => BADGE_KINDS.includes(kind)),
      `a list of badge kinds from: ${BADGE_KINDS.join(', ')}`
    );
    check(
      'badgeOrder',
      (v) =>
        Array.isArray(v) &&
        v.length === BADGE_KINDS.length &&
        new Set(v).size === v.length &&
        v.every((kind) => BADGE_KINDS.includes(kind)),
      `every badge kind exactly once: ${BADGE_KINDS.join(', ')}`
    );
    return problems;
  }

  // Makes a defaults.json the defaults, or throws saying what is wrong with
  // it - in which case the defaults already in place stay.
  function useDefaults(json) {
    const problems = defaultsProblems(json);
    if (problems.length) {
      const which = problems.length === 1 ? 'a problem' : `${problems.length} problems`;
      const err = new Error(`defaults.json has ${which}: ${problems.join('; ')}`);
      err.problems = problems;
      throw err;
    }
    const next = {};
    for (const key of Object.keys(json)) {
      next[key] = Array.isArray(json[key]) ? Object.freeze([...json[key]]) : json[key];
    }
    next.stats = CONSENT_DEFAULT;
    DEFAULTS = Object.freeze(next);
    return DEFAULTS;
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
  const api = {
    SETTINGS_KEY,
    LEGACY_SETTINGS_KEY,
    PINNED_HISTORY,
    KICK_GREEN,
    FONT_STACKS,
    BADGE_KINDS,
    BADGE_LABELS,
    DELETED_MODES,
    STATS_CHOICES,
    TIMESTAMP_FORMATS,
    SETTING_KEYS,
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
    defaultsProblems,
    useDefaults,
  };
  // A getter, not a copy: DEFAULTS only exists once defaults.json is loaded,
  // and whoever reads it after `ready` has to see the loaded object.
  Object.defineProperty(api, 'DEFAULTS', { enumerable: true, get: () => DEFAULTS });
  return api;
});
