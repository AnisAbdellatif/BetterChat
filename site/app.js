(function () {
  'use strict';

  const messagesEl = document.getElementById('messages');
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const KICK_GREEN = '#53fc18';

  const query = new URLSearchParams(location.search);

  // The channel comes from the URL path: /xqc -> "xqc". Static hosts that
  // can't rewrite paths can use /?c=xqc or /#xqc instead.
  const slug = (() => {
    const first = location.pathname.replace(/^\/+|\/+$/g, '').split('/')[0] || '';
    const fromPath = /\.html?$/i.test(first) ? '' : first;
    return decodeURIComponent(fromPath || query.get('c') || location.hash.replace(/^#/, '') || '').trim();
  })();

  // Everything that used to live on the server: Kick's REST API + the
  // Pusher feed (see kick.js). The config is public (same values kick.com
  // ships to every browser).
  const CONFIG = window.BETTERCHAT_CONFIG || {};
  const kick = new BetterChatKick.KickApi({ baseUrl: CONFIG.kickApiBase });

  // OBS overlay mode (?overlay=1): transparent, no controls, fading messages.
  const overlayMode = ['1', 'true', 'on'].includes((query.get('overlay') || '').toLowerCase());

  // Filled in from the join reply: the channel's own subscriber badge
  // images, one per months-tier, sorted by months ascending.
  let subscriberBadges = [];

  // ---------------------------------------------------------------------
  // Settings (per viewer, kept in localStorage; can be overridden by URL)
  // ---------------------------------------------------------------------

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
  const TIMESTAMP_FORMATS = Object.freeze(['hm', 'hms']);

  const DEFAULTS = Object.freeze({
    hiddenBadges: ['level'],
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
    collapseEmotes: true,
    deletedMessages: 'gray',
    showModeration: true,
    showPinned: true,
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
    s.overlayFadeSec = clampInt(raw.overlayFadeSec, 0, 600, DEFAULTS.overlayFadeSec);
    return s;
  }

  function loadStoredSettings() {
    try {
      const stored = localStorage.getItem(SETTINGS_KEY) || localStorage.getItem(LEGACY_SETTINGS_KEY);
      const raw = JSON.parse(stored);
      return raw && typeof raw === 'object' ? raw : {};
    } catch (_e) {
      return {};
    }
  }

  // Settings in the URL: ?fontSize=16&monocolor=1&hiddenBadges=level,event
  // Booleans accept 1/0/true/false/on/off, arrays are comma-separated.
  function settingsFromUrl() {
    const out = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (!query.has(key)) continue;
      const v = query.get(key);
      const kind = Array.isArray(DEFAULTS[key]) ? 'array' : typeof DEFAULTS[key];
      if (kind === 'boolean') out[key] = ['1', 'true', 'on'].includes(v.toLowerCase());
      else if (kind === 'number') out[key] = Number(v);
      else if (kind === 'array') out[key] = v.split(',').map((x) => x.trim()).filter(Boolean);
      else out[key] = v;
    }
    return out;
  }

  const urlSettings = settingsFromUrl();
  const settingsFromUrlOnly = Object.keys(urlSettings).length > 0;

  let settings = sanitize({ ...loadStoredSettings(), ...urlSettings });

  function saveSettings() {
    // A shared link's settings shouldn't silently overwrite the viewer's own.
    if (settingsFromUrlOnly) return;
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (_e) {
      /* private mode / storage disabled - settings just won't persist */
    }
  }

  // Only the settings that differ from the defaults, as URL parameters.
  function settingsAsParams(target) {
    const params = new URLSearchParams();
    for (const key of Object.keys(DEFAULTS)) {
      const value = target[key];
      if (JSON.stringify(value) === JSON.stringify(DEFAULTS[key])) continue;
      if (typeof value === 'boolean') params.set(key, value ? '1' : '0');
      else if (Array.isArray(value)) params.set(key, value.join(','));
      else params.set(key, String(value));
    }
    return params;
  }

  function settingsLink(withOverlay) {
    const params = settingsAsParams(settings);
    if (withOverlay) params.set('overlay', '1');
    const qs = params.toString();
    return `${location.origin}/${encodeURIComponent(slug || 'CHANNEL')}${qs ? '?' + qs : ''}`;
  }

  function historyLimit() {
    if (overlayMode) return PINNED_HISTORY;
    return settings.scrollback ? settings.historyLimit : PINNED_HISTORY;
  }

  function scrollbackEnabled() {
    return settings.scrollback && !overlayMode;
  }

  function usernameColor(kickColor) {
    if (settings.monocolor) return settings.monocolorValue;
    return HEX_COLOR.test(kickColor || '') ? kickColor : KICK_GREEN;
  }

  function fontFamilyCss() {
    if (settings.fontFamily === 'custom') {
      // Fall back to the default stack if the custom name is empty or the
      // font isn't installed (the browser skips unknown families).
      return settings.customFont
        ? `"${settings.customFont}", ${FONT_STACKS.system}`
        : FONT_STACKS.system;
    }
    return FONT_STACKS[settings.fontFamily] || FONT_STACKS.system;
  }

  // Re-applies everything that affects messages already on screen.
  function applySettings() {
    document.documentElement.style.setProperty('--chat-font-size', `${settings.fontSize}px`);
    document.documentElement.style.setProperty('--chat-font-family', fontFamilyCss());
    // Overlay mode keeps a transparent body regardless (body.overlay CSS).
    document.documentElement.style.setProperty('--chat-bg', settings.bgColor);
    document.documentElement.style.setProperty('--chat-gap', `${settings.messageGap}px`);
    document.body.classList.toggle('no-scrollback', !scrollbackEnabled());
    document.body.classList.toggle('show-ts', settings.timestamps);
    document.body.classList.toggle('user-cards', settings.userCards && !overlayMode);
    if (!settings.userCards) closeUserCard();
    trimHistory();
    for (const user of messagesEl.querySelectorAll('.msg > .user')) {
      user.style.color = usernameColor(user.dataset.kickColor);
    }
    for (const badge of messagesEl.querySelectorAll('.badge[data-kind]')) {
      badge.toggleAttribute('hidden', isBadgeHidden(badge.dataset.kind));
    }
    for (const ts of messagesEl.querySelectorAll('.ts[data-time]')) {
      ts.textContent = formatTime(ts.dataset.time);
    }
    for (const row of messagesEl.querySelectorAll('.msg[data-text]')) {
      row.classList.toggle('mentions-me', mentionsMe(row.dataset.text));
    }
    applyPinVisibility();
  }

  // The pin banner changes the list's height, so showing or hiding it has to
  // re-stick the scroll - but nothing about the messages themselves changed,
  // so it must not trigger applySettings' four full-list passes. Pins arrive
  // on every reconnect, and the list can hold thousands of rows.
  function applyPinVisibility() {
    // A live pin the viewer has hidden is not gone: the banner goes away and
    // the button under the gear appears to bring it back.
    const live = settings.showPinned && pinnedActive;
    pinnedEl.hidden = !live || pinHidden;
    showPinBtn.hidden = !live || !pinHidden;
    document.body.classList.toggle('has-pin', !pinnedEl.hidden);
    stickIfFollowing();
  }

  // ---------------------------------------------------------------------
  // Settings panel
  // ---------------------------------------------------------------------

  const overlay = document.getElementById('settingsOverlay');
  const panel = document.getElementById('settingsPanel');
  const settingsBtn = document.getElementById('settingsBtn');
  const actionNote = document.getElementById('actionNote');
  const controls = [...panel.querySelectorAll('[data-setting]')];
  const badgeChecks = [...panel.querySelectorAll('[data-badge]')];

  function syncPanel() {
    for (const el of controls) {
      const value = settings[el.dataset.setting];
      if (el.type === 'checkbox') el.checked = value;
      else el.value = value;
    }
    for (const el of badgeChecks) {
      el.checked = !isBadgeHidden(el.dataset.badge);
    }
    for (const sub of panel.querySelectorAll('[data-sub]')) {
      sub.hidden = !settings[sub.dataset.sub];
    }
    // data-when="key=value": shown only while that setting has that value.
    for (const el of panel.querySelectorAll('[data-when]')) {
      const [key, value] = el.dataset.when.split('=');
      el.hidden = String(settings[key]) !== value;
    }
    document.getElementById('urlNote').hidden = !settingsFromUrlOnly;
  }

  function readControl(el) {
    const key = el.dataset.setting;
    if (el.type === 'checkbox') return el.checked;
    if (key === 'monocolorValue' || key === 'bgColor') {
      const v = el.value.trim();
      return HEX6.test(v) ? v.toLowerCase() : null;
    }
    if (key === 'customFont') return cleanFontName(el.value);
    if (key === 'mentionMe') return cleanUsername(el.value);
    return el.value;
  }

  function replaceSettings(next) {
    settings = sanitize(next);
    saveSettings();
    syncPanel();
    applySettings();
  }

  function onControlChange(e) {
    const el = e.target;

    if (el.dataset.badge) {
      const hidden = badgeChecks.filter((c) => !c.checked).map((c) => c.dataset.badge);
      replaceSettings({ ...settings, hiddenBadges: hidden });
      return;
    }

    if (!el.dataset.setting) return;
    const value = readControl(el);
    if (value === null) return; // e.g. a half-typed hex value - keep the old one
    replaceSettings({ ...settings, [el.dataset.setting]: value });
  }

  panel.addEventListener('change', onControlChange);
  panel.addEventListener('input', (e) => {
    // Live-update from the color picker and the hex field; numbers wait
    // for 'change' so a half-typed value isn't clamped under the cursor.
    const key = e.target.dataset.setting;
    if (key === 'monocolorValue' || key === 'bgColor') onControlChange(e);
  });

  // Tabs: one panel visible at a time.
  const tabButtons = [...panel.querySelectorAll('[data-tab]')];
  const tabPanels = [...panel.querySelectorAll('[data-tab-panel]')];

  function showTab(name) {
    for (const b of tabButtons) b.setAttribute('aria-selected', String(b.dataset.tab === name));
    for (const p of tabPanels) p.hidden = p.dataset.tabPanel !== name;
  }

  for (const b of tabButtons) b.addEventListener('click', () => showTab(b.dataset.tab));

  function note(text, isError) {
    actionNote.textContent = text;
    actionNote.classList.toggle('error', !!isError);
    clearTimeout(note.timer);
    note.timer = setTimeout(() => { actionNote.textContent = ''; }, 4000);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_e) {
      // Clipboard API unavailable (http origin, permissions) - show it instead.
      window.prompt('Copy this link:', text);
      return false;
    }
  }

  document.getElementById('copySettingsLink').addEventListener('click', async () => {
    if (await copyText(settingsLink(false))) note('Settings link copied.');
  });

  document.getElementById('copyOverlayLink').addEventListener('click', async () => {
    if (await copyText(settingsLink(true))) note('Overlay link copied. Add it in OBS as a Browser Source.');
  });

  document.getElementById('exportSettings').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'betterchat-settings.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    note('Settings exported.');
  });

  const importFile = document.getElementById('importFile');
  document.getElementById('importSettings').addEventListener('click', () => {
    importFile.value = '';
    importFile.click();
  });
  importFile.addEventListener('change', async () => {
    const file = importFile.files && importFile.files[0];
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text());
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('not an object');
      replaceSettings(raw);
      note('Settings imported.');
    } catch (_e) {
      note('That file is not a valid settings export.', true);
    }
  });

  document.getElementById('resetSettings').addEventListener('click', () => {
    if (!window.confirm('Reset all chat settings to their defaults?')) return;
    replaceSettings({});
    note('Settings reset.');
  });

  function openSettings() {
    syncPanel();
    overlay.hidden = false;
    document.getElementById('closeSettings').focus();
  }

  function closeSettings() {
    overlay.hidden = true;
    settingsBtn.focus();
  }

  settingsBtn.addEventListener('click', openSettings);
  document.getElementById('closeSettings').addEventListener('click', closeSettings);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeSettings();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !overlay.hidden) closeSettings();
  });

  // ---------------------------------------------------------------------
  // Message list
  // ---------------------------------------------------------------------

  function isNearBottom() {
    return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
  }

  // Whether new messages pull the view down with them. This is a latched
  // intention, not a measurement taken at append time. Re-deriving it from
  // the layout on every flush was self-defeating: one reading that came back
  // false left the view sitting away from the bottom, which made the next
  // reading false as well, so autoscroll stayed off until the viewer
  // scrolled back down by hand. Only the viewer changes it now.
  let stickToBottom = true;

  function stickIfFollowing() {
    if (!scrollbackEnabled() || stickToBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // Our own scrolls land at the bottom, so the event they cause re-asserts
  // the latch rather than breaking it - no guard needed for them here.
  messagesEl.addEventListener('scroll', () => {
    stickToBottom = isNearBottom();
  }, { passive: true });

  // kick.com resizes the frame - theater mode, a collapsed sidebar, the
  // window itself - which changes clientHeight without firing any scroll
  // event. Re-assert rather than silently drifting off the bottom.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(stickIfFollowing).observe(messagesEl);
  }

  function trimHistory() {
    const limit = historyLimit();
    while (messagesEl.childElementCount > limit) {
      messagesEl.removeChild(messagesEl.firstElementChild);
    }
  }

  // Overlay mode: rows fade out and are removed after overlayFadeSec.
  function scheduleFade(row) {
    if (!overlayMode || settings.overlayFadeSec <= 0) return;
    setTimeout(() => {
      row.classList.add('fade');
      setTimeout(() => row.remove(), 500);
    }, settings.overlayFadeSec * 1000);
  }

  // Messages arrive in bursts - a busy channel can land several in a single
  // frame - and appending one at a time cost two forced layouts each:
  // isNearBottom() reads scrollTop/scrollHeight, then the scroll write reads
  // scrollHeight again. Queue instead and flush once per frame through a
  // fragment, so a burst costs one layout however many messages it carries.
  let pendingRows = [];
  let flushFrame = 0;
  let flushTimer = 0;

  function flushRows() {
    if (flushFrame) cancelAnimationFrame(flushFrame);
    if (flushTimer) clearTimeout(flushTimer);
    flushFrame = flushTimer = 0;
    if (!pendingRows.length) return;
    const rows = pendingRows;
    pendingRows = [];
    const frag = document.createDocumentFragment();
    for (const row of rows) frag.appendChild(row);
    messagesEl.appendChild(frag);
    trimHistory();
    for (const row of rows) scheduleFade(row);
    stickIfFollowing();
  }

  function appendRow(row) {
    pendingRows.push(row);
    // Cap the queue at what trimHistory would keep anyway, so a page that
    // isn't being painted can't grow it without bound.
    const cap = historyLimit();
    if (pendingRows.length > cap) pendingRows.splice(0, pendingRows.length - cap);
    if (flushFrame || flushTimer) return;
    flushFrame = requestAnimationFrame(flushRows);
    // A cross-origin iframe that kick.com has scrolled out of view gets no
    // animation frames at all, and nor does a background tab, so rAF on its
    // own can stall the queue indefinitely. Timers are throttled but still
    // fire, so one is always armed underneath as a floor.
    flushTimer = setTimeout(flushRows, 250);
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) flushRows();
  });

  function systemLine(text, isError) {
    const row = document.createElement('div');
    row.className = 'system' + (isError ? ' error' : '');
    row.textContent = text;
    appendRow(row);
  }

  // Sub / gift / host / moderation lines. `parts` is a list of strings and
  // {user: name} objects so usernames can be styled without innerHTML.
  function eventLine(kind, icon, parts) {
    const row = document.createElement('div');
    row.className = `event ${kind}`;
    const ic = document.createElement('span');
    ic.className = 'icon';
    ic.textContent = icon;
    row.appendChild(ic);
    for (const part of parts) {
      if (typeof part === 'string') {
        row.appendChild(document.createTextNode(part));
      } else if (part && part.user) {
        const u = document.createElement('span');
        u.className = 'user';
        u.textContent = part.user;
        row.appendChild(u);
      }
    }
    appendRow(row);
  }

  function formatTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const two = (n) => String(n).padStart(2, '0');
    const base = `${two(d.getHours())}:${two(d.getMinutes())}`;
    return settings.timestampFormat === 'hms' ? `${base}:${two(d.getSeconds())}` : base;
  }

  // ---------------------------------------------------------------------
  // Repeated-message filter (per user)
  //
  // Keyed on user + normalized content (case/whitespace-insensitive, so
  // "Pog Pog" and "pog  pog" count as the same message). A message is
  // hidden once the SAME user has already posted it `dedupeRepeats` times
  // inside the last `dedupeWindowSec` seconds; other users posting the
  // same text are unaffected.
  // ---------------------------------------------------------------------

  const recentMessages = new Map(); // "user\ncontent" -> [timestamps]
  let lastPrune = 0;

  function normalizeContent(content) {
    return content.trim().replace(/\s+/g, ' ').toLowerCase();
  }

  function pruneRecent(now, windowMs) {
    for (const [key, times] of recentMessages) {
      const kept = times.filter((t) => now - t <= windowMs);
      if (kept.length) recentMessages.set(key, kept);
      else recentMessages.delete(key);
    }
  }

  // Returns true when the message should be hidden. Always records the
  // message, so turning the option on mid-stream already has history.
  function isRepeat(username, content) {
    const now = Date.now();
    const windowMs = settings.dedupeWindowSec * 1000;
    if (now - lastPrune > 5000) {
      pruneRecent(now, windowMs);
      lastPrune = now;
    }

    const text = normalizeContent(content);
    if (!text) return false;
    const key = `${(username || '').toLowerCase()}\n${text}`;
    const times = (recentMessages.get(key) || []).filter((t) => now - t <= windowMs);
    const seenBefore = times.length;
    times.push(now);
    recentMessages.set(key, times);

    return settings.dedupe && seenBefore >= settings.dedupeRepeats;
  }

  // ---------------------------------------------------------------------
  // Badges
  //
  // Kick sends two lists per sender (see KickChatRelay.ChatMessage):
  //   badges    - channel-level: subscriber (count = months), sub_gifter
  //               (count = gifts), moderator, vip, og, broadcaster, ...
  //               Only the subscriber badge has an image (channel-specific,
  //               from the join reply); the rest are drawn inline here.
  //   badges_v2 - global badges (chat level, event badges) with a hosted
  //               image_url.
  // Rendered in Kick's order: channel badges first, then global ones.
  // ---------------------------------------------------------------------

  function svgBadge(children, title) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('class', 'badge');
    svg.setAttribute('role', 'img');
    if (title) {
      const t = document.createElementNS(SVG_NS, 'title');
      t.textContent = title;
      svg.appendChild(t);
    }
    for (const [tag, attrs, text] of children) {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      if (text !== undefined) el.textContent = text;
      svg.appendChild(el);
    }
    return svg;
  }

  function imgBadge(src, title) {
    const img = document.createElement('img');
    img.className = 'badge';
    img.src = src;
    img.alt = title;
    img.title = title;
    img.loading = 'lazy';
    return img;
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

  function renderChannelBadge(badge) {
    const count = badge.count || 0;
    const label = badge.text || badge.type;

    switch (badge.type) {
      case 'subscriber': {
        const title = `Subscriber (${count} month${count === 1 ? '' : 's'})`;
        // Highest tier the subscriber has reached, if the channel has custom badges.
        let tier = null;
        for (const b of subscriberBadges) if (b.months <= count) tier = b;
        if (tier) return imgBadge(tier.src, title);
        return svgBadge(
          [['path', { d: 'M8 1.5l2 4.2 4.6.6-3.4 3.2.9 4.6L8 11.8l-4.1 2.3.9-4.6L1.4 6.3 6 5.7z', fill: KICK_GREEN }]],
          title
        );
      }
      case 'sub_gifter': {
        const c = subGifterColor(count);
        return svgBadge(
          [
            ['rect', { x: 2, y: 6, width: 12, height: 8.5, rx: 1.5, fill: c }],
            ['rect', { x: 1, y: 3.5, width: 14, height: 3.5, rx: 1, fill: c }],
            ['rect', { x: 7, y: 3.5, width: 2, height: 11, fill: '#0b0e0f' }],
            ['path', { d: 'M8 3.5C6 3.5 4.5 1 6.5 1 7.5 1 8 2.5 8 3.5zm0 0c2 0 3.5-2.5 1.5-2.5C8.5 1 8 2.5 8 3.5z', fill: c }],
          ],
          `Sub Gifter (${count} gift${count === 1 ? '' : 's'})`
        );
      }
      case 'moderator':
        return svgBadge(
          [
            ['path', { d: 'M13.5 1.5L5.2 9.8l1 1L14.5 2.5z', fill: KICK_GREEN }],
            ['path', { d: 'M4.2 10.8l1-1 1 1-1 1z', fill: KICK_GREEN }],
            ['path', { d: 'M2 14l2.2-3.2 1 1L2 14z', fill: KICK_GREEN }],
            ['path', { d: 'M4.5 8.5l3 3-1.2 1.2-3-3z', fill: '#2cb80f' }],
          ],
          label
        );
      case 'vip':
        return svgBadge(
          [
            ['path', { d: 'M3 2h10l2.5 4L8 14.5 0.5 6z', fill: '#ff4fd8' }],
            ['path', { d: 'M3 2l2 4h6l2-4', fill: '#ffb3ee' }],
            ['path', { d: 'M5 6l3 8.5L11 6z', fill: '#ff85e4' }],
          ],
          label
        );
      case 'og':
        return svgBadge(
          [ROUNDED('#1f2a30'), ['rect', { x: 1, y: 1, width: 14, height: 14, rx: 3, fill: 'none', stroke: KICK_GREEN, 'stroke-width': 1 }], LABEL('OG', KICK_GREEN, 7)],
          label
        );
      case 'broadcaster':
        return svgBadge(
          [
            ROUNDED('#e5484d'),
            ['rect', { x: 3, y: 5, width: 7, height: 6, rx: 1, fill: '#fff' }],
            ['path', { d: 'M10 7l3-1.5v5L10 9z', fill: '#fff' }],
          ],
          label
        );
      case 'verified':
        return svgBadge(
          [
            ['circle', { cx: 8, cy: 8, r: 7, fill: KICK_GREEN }],
            ['path', { d: 'M4.5 8.2l2.3 2.3 4.7-4.7', fill: 'none', stroke: '#0b0e0f', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }],
          ],
          label
        );
      case 'founder':
        return svgBadge([ROUNDED('#f5a524'), LABEL('F', '#0b0e0f', 9)], label);
      case 'staff':
        return svgBadge([ROUNDED(KICK_GREEN), LABEL('K', '#0b0e0f', 9)], label);
      case 'bot':
        return svgBadge([ROUNDED('#3ea6ff'), LABEL('BOT', '#fff', 5.5)], label);
      default:
        return svgBadge([['circle', { cx: 8, cy: 8, r: 6.5, fill: '#4a5058' }]], label);
    }
  }

  function renderGlobalBadge(badge) {
    let title = badge.name;
    if (badge.name === 'level' && badge.level != null) title = `Level ${badge.level}`;
    else title = badge.name.replace(/[_-]+/g, ' ');
    return imgBadge(badge.image_url, title);
  }

  function channelBadgeKind(badge) {
    return BADGE_KINDS.includes(badge.type) && badge.type !== 'level' && badge.type !== 'event'
      ? badge.type
      : 'other';
  }

  function globalBadgeKind(badge) {
    return badge.name === 'level' ? 'level' : 'event';
  }

  function isBadgeHidden(kind) {
    return settings.hiddenBadges.includes(kind);
  }

  // Hidden badges are still rendered (just not displayed) so toggling a
  // kind back on in the settings restores them on existing messages.
  function addBadge(wrap, el, kind) {
    el.dataset.kind = kind;
    el.toggleAttribute('hidden', isBadgeHidden(kind));
    wrap.appendChild(el);
  }

  function renderBadges(msg) {
    const wrap = document.createElement('span');
    wrap.className = 'badges';
    const bySort = (a, b) => (a.sort_order || 0) - (b.sort_order || 0);
    for (const b of (msg.badges || []).slice().sort(bySort)) {
      addBadge(wrap, renderChannelBadge(b), channelBadgeKind(b));
    }
    for (const b of (msg.badges_v2 || []).slice().sort(bySort)) {
      addBadge(wrap, renderGlobalBadge(b), globalBadgeKind(b));
    }
    return wrap;
  }

  // ---------------------------------------------------------------------
  // Message content
  // ---------------------------------------------------------------------

  // Kick's raw message content embeds emotes as "[emote:<id>:<name>]" rather
  // than pre-rendered <img> tags - the kick.com frontend's own JS parses
  // this placeholder syntax before display, and since we're bypassing that
  // frontend entirely, we have to do the same parsing ourselves.
  const EMOTE_PATTERN = /\[emote:(\d+):([^\]]*)\]/g;

  // "[emote:1:a] [emote:1:a][emote:1:a]" -> "[emote:1:a]". Consecutive
  // repeats of the same emote (whitespace between them or not) become one,
  // which covers the "message is just one emote spammed N times" case.
  const REPEATED_EMOTE = /(\[emote:(\d+):[^\]]*\])(?:\s*\[emote:\2:[^\]]*\])+/g;

  function collapseRepeatedEmotes(content) {
    return content.replace(REPEATED_EMOTE, '$1');
  }

  // @mentions: "@name" not glued to a preceding word character.
  const MENTION_PATTERN = /(^|[^\w])@([\w-]{1,30})/g;

  function mentionsMe(text) {
    if (!settings.mentionMe) return false;
    const me = settings.mentionMe.toLowerCase();
    MENTION_PATTERN.lastIndex = 0;
    let m;
    while ((m = MENTION_PATTERN.exec(text)) !== null) {
      if (m[2].toLowerCase() === me) return true;
    }
    return false;
  }

  // Plain text with @mentions wrapped in styled spans.
  function appendTextWithMentions(container, text) {
    MENTION_PATTERN.lastIndex = 0;
    let lastIndex = 0;
    let match;
    while ((match = MENTION_PATTERN.exec(text)) !== null) {
      const start = match.index + match[1].length;
      if (start > lastIndex) {
        container.appendChild(document.createTextNode(text.slice(lastIndex, start)));
      }
      const tag = document.createElement('span');
      tag.className = 'mention';
      tag.textContent = `@${match[2]}`;
      container.appendChild(tag);
      lastIndex = MENTION_PATTERN.lastIndex;
    }
    if (lastIndex < text.length) {
      container.appendChild(document.createTextNode(text.slice(lastIndex)));
    }
  }

  // Builds message content as safe DOM nodes (text nodes + <img> elements)
  // rather than via innerHTML - chat content is untrusted, attacker-
  // controllable input (any Kick user can type it), so it must never be
  // parsed as HTML.
  function appendMessageContent(container, content) {
    EMOTE_PATTERN.lastIndex = 0;
    let lastIndex = 0;
    let match;

    while ((match = EMOTE_PATTERN.exec(content)) !== null) {
      if (match.index > lastIndex) {
        appendTextWithMentions(container, content.slice(lastIndex, match.index));
      }

      const [, emoteId, emoteName] = match;
      const img = document.createElement('img');
      img.className = 'emote';
      img.src = `https://files.kick.com/emotes/${emoteId}/fullsize`;
      img.alt = emoteName;
      img.title = emoteName;
      container.appendChild(img);

      lastIndex = EMOTE_PATTERN.lastIndex;
    }

    if (lastIndex < content.length) {
      appendTextWithMentions(container, content.slice(lastIndex));
    }
  }

  // Only accept a plain hex color from the payload - it ends up in a style
  // attribute, so anything else is dropped rather than trusted.
  const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;

  function renderReply(replyTo) {
    const line = document.createElement('div');
    line.className = 'reply';
    // Full original text for the hover tooltip when the line is truncated.
    line.dataset.full = replyTo.content || '';
    line.dataset.user = replyTo.username || '?';
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '↩';
    line.appendChild(arrow);
    line.append('Replying to ');
    const user = document.createElement('span');
    user.className = 'user';
    user.textContent = `@${replyTo.username || '?'}`;
    line.appendChild(user);
    line.append(': ');
    appendMessageContent(line, replyTo.content || '');
    return line;
  }

  function appendMessage(msg) {
    recordUserHistory(msg);

    // Collapse first so the repeat filter compares what would be displayed:
    // "KEKW KEKW KEKW" and "KEKW KEKW" are the same message once collapsed.
    const content = settings.collapseEmotes ? collapseRepeatedEmotes(msg.content) : msg.content;
    if (isRepeat(msg.username, content)) return;

    const row = document.createElement('div');
    row.className = 'msg';
    row.dataset.id = msg.id;
    row.dataset.user = (msg.username || '').toLowerCase();
    row.dataset.text = content;
    if (mentionsMe(content)) row.classList.add('mentions-me');

    if (msg.reply_to) row.appendChild(renderReply(msg.reply_to));

    const ts = document.createElement('span');
    ts.className = 'ts';
    if (msg.created_at) {
      ts.dataset.time = msg.created_at;
      ts.textContent = formatTime(msg.created_at);
    }
    row.appendChild(ts);

    row.appendChild(renderBadges(msg));

    const user = document.createElement('span');
    user.className = 'user';
    user.textContent = msg.username;
    if (HEX_COLOR.test(msg.color || '')) user.dataset.kickColor = msg.color;
    user.style.color = usernameColor(msg.color);
    row.appendChild(user);

    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = ': ';
    row.appendChild(sep);

    const body = document.createElement('span');
    body.className = 'content';
    appendMessageContent(body, content);
    row.appendChild(body);

    const tag = document.createElement('span');
    tag.className = 'deleted-tag';
    row.appendChild(tag);

    appendRow(row);
  }

  // ---------------------------------------------------------------------
  // Reply tooltip: the "Replying to ..." line is clipped to one line, so
  // hovering a clipped one shows the whole original message.
  // ---------------------------------------------------------------------

  const replyTip = document.getElementById('replyTip');

  function showReplyTip(line) {
    replyTip.replaceChildren();
    const head = document.createElement('div');
    head.className = 'tip-head';
    head.textContent = `@${line.dataset.user}`;
    replyTip.appendChild(head);
    const body = document.createElement('div');
    body.className = 'tip-body';
    appendMessageContent(body, line.dataset.full);
    replyTip.appendChild(body);

    replyTip.hidden = false;
    const r = line.getBoundingClientRect();
    replyTip.style.left = '0px';
    replyTip.style.top = '0px';
    const tip = replyTip.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(r.left, window.innerWidth - tip.width - margin));
    let top = r.bottom + 6;
    if (top + tip.height > window.innerHeight - margin) top = Math.max(margin, r.top - tip.height - 6);
    replyTip.style.left = `${left}px`;
    replyTip.style.top = `${top}px`;
  }

  function hideReplyTip() {
    replyTip.hidden = true;
  }

  messagesEl.addEventListener('mouseover', (e) => {
    const line = e.target.closest('.reply');
    if (!line || !messagesEl.contains(line)) return;
    // Only when the text is actually cut off.
    if (line.scrollWidth > line.clientWidth + 1) showReplyTip(line);
  });

  messagesEl.addEventListener('mouseout', (e) => {
    const line = e.target.closest('.reply');
    if (!line) return;
    if (e.relatedTarget && line.contains(e.relatedTarget)) return;
    hideReplyTip();
  });

  messagesEl.addEventListener('scroll', hideReplyTip, { passive: true });

  // ---------------------------------------------------------------------
  // User card (click a username)
  //
  // Profile / follow / sub data comes straight from Kick's API (kick.js,
  // cached for a few minutes). Message history is what
  // this page has seen since it opened, kept per user regardless of the
  // on-screen history cap or the repeat filter.
  // ---------------------------------------------------------------------

  const userCardEl = document.getElementById('userCard');
  const userHistory = new Map(); // lowercase username -> [{content, created_at}]
  const userCardCache = new Map(); // lowercase username -> {data, fetchedAt}
  const HISTORY_PER_USER = 25;
  // Both maps are keyed by username, so on a big channel they would other-
  // wise grow with every distinct chatter for as long as the tab is open -
  // thousands an hour, none of it ever released. Both are kept in
  // least-recently-used order (re-inserting moves a key to the end) and
  // trimmed from the front.
  const HISTORY_USERS_CAP = 500;
  const USER_CARD_CACHE_CAP = 50;
  const USER_CARD_TTL_MS = 3 * 60 * 1000;
  let userCardRequest = 0;

  function recordUserHistory(msg) {
    const key = (msg.username || '').toLowerCase();
    if (!key) return;
    const list = userHistory.get(key) || [];
    list.push({ content: msg.content, created_at: msg.created_at });
    if (list.length > HISTORY_PER_USER) list.shift();
    userHistory.delete(key);
    userHistory.set(key, list);
    while (userHistory.size > HISTORY_USERS_CAP) {
      userHistory.delete(userHistory.keys().next().value);
    }
  }

  function formatDate(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function timeOnly(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const two = (n) => String(n).padStart(2, '0');
    return `${two(d.getHours())}:${two(d.getMinutes())}`;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function fact(label, value) {
    const f = el('div', 'uc-fact');
    f.appendChild(el('div', 'k', label));
    f.appendChild(el('div', 'v', value));
    return f;
  }

  function placeUserCard(x, y) {
    // Position near the click, then nudge back inside the viewport.
    userCardEl.style.left = '0px';
    userCardEl.style.top = '0px';
    const rect = userCardEl.getBoundingClientRect();
    const margin = 8;
    const left = Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin));
    let top = y + 12;
    if (top + rect.height > window.innerHeight - margin) top = Math.max(margin, y - rect.height - 12);
    userCardEl.style.left = `${left}px`;
    userCardEl.style.top = `${top}px`;
  }

  function closeUserCard() {
    userCardEl.hidden = true;
    userCardEl.replaceChildren();
  }

  function renderUserCard(username, card) {
    userCardEl.replaceChildren();

    const head = el('div', 'uc-head');
    const avatar = document.createElement('img');
    avatar.className = 'uc-avatar';
    avatar.alt = '';
    if (card && card.profile_pic) avatar.src = card.profile_pic;
    head.appendChild(avatar);

    const who = el('div', 'uc-who');
    const name = el('div', 'uc-name');
    const link = document.createElement('a');
    link.href = `https://kick.com/${encodeURIComponent((card && card.slug) || username)}`;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = (card && card.username) || username;
    name.appendChild(link);
    who.appendChild(name);
    if (card && card.followers_count != null) {
      who.appendChild(el('div', 'uc-followers', `${Number(card.followers_count).toLocaleString()} followers`));
    }
    const flags = [];
    if (card && card.is_channel_owner) flags.push('Broadcaster');
    if (card && card.is_moderator) flags.push('Moderator');
    if (card && card.is_staff) flags.push('Kick staff');
    if (card && card.verified) flags.push('Verified');
    if (card && card.banned) flags.push('Banned');
    if (flags.length) who.appendChild(el('div', 'uc-flags', flags.join(' · ')));
    head.appendChild(who);

    const close = el('button', '', '×');
    close.id = 'closeUserCard';
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', closeUserCard);
    head.appendChild(close);
    userCardEl.appendChild(head);

    if (card) {
      const facts = el('div', 'uc-facts');
      const months = card.subscribed_for;
      facts.appendChild(fact('Subscribed for', months ? `${months} month${months === 1 ? '' : 's'}` : 'Not subscribed'));
      facts.appendChild(fact('Followed', card.following_since ? formatDate(card.following_since) : 'Not following'));
      facts.appendChild(fact('Joined on', card.created_at ? formatDate(card.created_at) : '—'));
      facts.appendChild(fact('Messages here', String((userHistory.get(username.toLowerCase()) || []).length)));
      userCardEl.appendChild(facts);

      const badges = renderBadges({ badges: card.badges, badges_v2: card.badges_v2 });
      badges.className = 'uc-badges';
      // The card shows every badge the user has, whatever the chat filter hides.
      for (const b of badges.querySelectorAll('.badge')) b.removeAttribute('hidden');
      userCardEl.appendChild(badges);

      if (card.bio) userCardEl.appendChild(el('div', 'uc-bio', card.bio));
    }

    const history = el('div', 'uc-history');
    history.appendChild(el('div', 'k', 'Recent messages'));
    const lines = (userHistory.get(username.toLowerCase()) || []).slice().reverse();
    if (!lines.length) {
      history.appendChild(el('div', 'none', 'Nothing since this page was opened.'));
    }
    for (const m of lines) {
      const line = el('div', 'line');
      line.appendChild(el('span', 't', timeOnly(m.created_at)));
      const c = el('span', 'c');
      appendMessageContent(c, m.content || '');
      line.appendChild(c);
      history.appendChild(line);
    }
    userCardEl.appendChild(history);
  }

  function showUserCardStatus(username, text, isError) {
    userCardEl.replaceChildren();
    const head = el('div', 'uc-head');
    const who = el('div', 'uc-who');
    who.appendChild(el('div', 'uc-name', username));
    head.appendChild(who);
    const close = el('button', '', '×');
    close.id = 'closeUserCard';
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', closeUserCard);
    head.appendChild(close);
    userCardEl.appendChild(head);
    userCardEl.appendChild(el('div', 'uc-status' + (isError ? ' error' : ''), text));
  }

  async function openUserCard(username, x, y) {
    if (!settings.userCards || overlayMode || !slug) return;
    const key = username.toLowerCase();
    const requestId = ++userCardRequest;

    userCardEl.hidden = false;
    const cached = userCardCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < USER_CARD_TTL_MS) {
      userCardCache.delete(key);
      userCardCache.set(key, cached);
      renderUserCard(username, cached.data);
      placeUserCard(x, y);
      return;
    }
    if (cached) userCardCache.delete(key);

    showUserCardStatus(username, 'Loading...');
    placeUserCard(x, y);

    let card = null;
    let error = null;
    try {
      card = await kick.userCard(slug, username);
    } catch (e) {
      error = e && e.status === 404 ? 'Kick has no record of this user in this chat.' : 'Could not load this user right now.';
    }

    // A newer click (or a close) happened while we were fetching.
    if (requestId !== userCardRequest || userCardEl.hidden) return;

    if (card) {
      userCardCache.set(key, { data: card, fetchedAt: Date.now() });
      while (userCardCache.size > USER_CARD_CACHE_CAP) {
        userCardCache.delete(userCardCache.keys().next().value);
      }
      renderUserCard(username, card);
    } else {
      // Still useful without Kick's data: show what we have locally.
      renderUserCard(username, null);
      userCardEl.insertBefore(el('div', 'uc-status error', error), userCardEl.lastElementChild);
    }
    placeUserCard(x, y);
  }

  // Everywhere a username is shown and is worth a card: the author of a
  // message, an @mention inside one, the user a reply is aimed at, the users
  // named in moderation lines (the one banned and the moderator who did it)
  // and in sub / gift / host lines, and the author of the pinned message.
  const USER_TARGETS =
    '.msg > .user, .mention, .reply > .user, .event > .user, #pinned .user';

  // Mentions and reply lines carry the "@"; the card is looked up by the bare
  // name.
  function usernameFromTarget(el) {
    return (el.textContent || '').trim().replace(/^@+/, '');
  }

  function onUsernameClick(e) {
    const target = e.target.closest(USER_TARGETS);
    if (!target) return;
    const username = usernameFromTarget(target);
    if (!username) return;
    e.preventDefault();
    // A reply line's tooltip would otherwise sit over the card.
    hideReplyTip();
    openUserCard(username, e.clientX, e.clientY);
  }

  messagesEl.addEventListener('click', onUsernameClick);
  // The banner is built further down the file, so it is looked up here rather
  // than through the variable that does not exist yet.
  document.getElementById('pinned').addEventListener('click', onUsernameClick);

  document.addEventListener('mousedown', (e) => {
    if (userCardEl.hidden) return;
    if (userCardEl.contains(e.target) || e.target.closest(USER_TARGETS)) return;
    closeUserCard();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !userCardEl.hidden) closeUserCard();
  });

  // ---------------------------------------------------------------------
  // Moderation
  // ---------------------------------------------------------------------

  function markDeleted(row, reason) {
    const mode = settings.deletedMessages;
    if (mode === 'keep') return;
    if (mode === 'remove') {
      row.remove();
      return;
    }
    row.classList.add('deleted');
    const tag = row.querySelector('.deleted-tag');
    if (tag && reason) tag.textContent = reason;
  }

  function durationText(minutes) {
    if (minutes == null) return '';
    if (minutes >= 1440 && minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? '' : 's'}`;
    if (minutes >= 60 && minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }

  function onMessageDeleted(ev) {
    const row = messagesEl.querySelector(`.msg[data-id="${CSS.escape(String(ev.message_id))}"]`);
    if (row) markDeleted(row, 'deleted');
  }

  function onChatCleared() {
    for (const row of messagesEl.querySelectorAll('.msg')) markDeleted(row, 'chat cleared');
    if (settings.showModeration) eventLine('mod', '🧹', ['Chat was cleared by a moderator']);
  }

  function onUserBanned(ev) {
    const name = (ev.username || '').toLowerCase();
    for (const row of messagesEl.querySelectorAll('.msg')) {
      if (row.dataset.user === name) markDeleted(row, ev.permanent ? 'banned' : 'timed out');
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
    if (!settings.showModeration) return;
    const by = ev.by ? [' by ', { user: ev.by }] : [];
    eventLine('mod', '🔓', [{ user: ev.username }, ev.permanent ? ' was unbanned' : "'s timeout was lifted", ...by]);
  }

  // ---------------------------------------------------------------------
  // Pinned message banner
  // ---------------------------------------------------------------------

  const pinnedEl = document.getElementById('pinned');
  const pinContent = document.getElementById('pinContent');
  const showPinBtn = document.getElementById('showPin');
  let pinnedActive = false;
  // Hidden by the viewer rather than dismissed: the pin is still live and can
  // be brought back. Reset by each new pin, so a fresh one is never missed.
  let pinHidden = false;
  let pinTimer = null;

  function showPin(ev) {
    const msg = ev.message || {};
    pinContent.replaceChildren();
    const user = document.createElement('span');
    user.className = 'user';
    user.textContent = msg.username || '?';
    user.style.color = usernameColor(msg.color);
    pinContent.appendChild(user);
    pinContent.append(': ');
    appendMessageContent(pinContent, msg.content || '');

    pinnedActive = true;
    pinHidden = false;
    clearTimeout(pinTimer);
    // Expiry is an absolute timestamp from the server (Kick's pins default
    // to 20 hours). Cap the timer: browsers clamp very long timeouts.
    const expires = ev.expires_at ? new Date(ev.expires_at).getTime() : NaN;
    if (!Number.isNaN(expires)) {
      const remaining = expires - Date.now();
      if (remaining <= 0) {
        pinnedActive = false;
      } else {
        pinTimer = setTimeout(clearPin, Math.min(remaining, 0x7fffffff));
      }
    }
    applyPinVisibility();
  }

  function clearPin() {
    pinnedActive = false;
    pinHidden = false;
    clearTimeout(pinTimer);
    applyPinVisibility();
  }

  // The banner's own button hides it; the pin stays live either way, so the
  // one under the gear puts it back.
  document.getElementById('closePin').addEventListener('click', () => {
    pinHidden = true;
    applyPinVisibility();
  });

  showPinBtn.addEventListener('click', () => {
    pinHidden = false;
    applyPinVisibility();
  });

  // ---------------------------------------------------------------------
  // Chat events (subs, gifts, hosts)
  // ---------------------------------------------------------------------

  function onSubscription(ev) {
    if (!settings.showSubs) return;
    const months = ev.months || 1;
    eventLine('sub', '★', [
      { user: ev.username },
      months > 1 ? ` subscribed for ${months} months` : ' just subscribed',
    ]);
  }

  function onGiftedSubs(ev) {
    if (!settings.showGifts) return;
    const recipients = ev.recipients || [];
    const parts = [{ user: ev.gifter || 'Someone' }, ` gifted ${recipients.length} sub${recipients.length === 1 ? '' : 's'}`];
    if (recipients.length && recipients.length <= 5) {
      parts.push(' to ');
      recipients.forEach((name, i) => {
        if (i > 0) parts.push(', ');
        parts.push({ user: name });
      });
    }
    eventLine('gift', '🎁', parts);
  }

  function onHost(ev) {
    if (!settings.showHosts) return;
    const parts = [{ user: ev.host_username }, ' is hosting'];
    if (ev.viewers) parts.push(` with ${ev.viewers} viewer${ev.viewers === 1 ? '' : 's'}`);
    if (ev.message) parts.push(`: ${ev.message}`);
    eventLine('host', '📺', parts);
  }

  // ---------------------------------------------------------------------
  // Connection / stream status
  //
  // Three things can make a chat go quiet, and the pill says which:
  //   - the WebSocket to Kick's feed is down (kick.js reconnects with backoff)
  //   - the socket is up but Kick hasn't confirmed the chat subscription
  //   - the channel simply isn't live (Kick's StreamerIsLive / StopStream
  //     events, plus the `live` flag from channel resolution)
  // ---------------------------------------------------------------------

  const statusPill = document.getElementById('statusPill');
  const conn = { browser: false, relay: false, live: null, joinedOnce: false };

  function updateStatus() {
    let text = '';
    let cls = '';
    if (!conn.browser) {
      text = conn.joinedOnce ? 'Connection to Kick lost, reconnecting...' : 'Connecting to Kick...';
      cls = 'warn';
    } else if (!conn.relay) {
      text = 'Waiting for Kick to confirm the chat subscription...';
      cls = 'warn';
    } else if (conn.live === false) {
      text = `${slug} is offline - chat still works`;
      cls = 'offline';
    }
    statusPill.textContent = text;
    statusPill.className = cls;
    statusPill.hidden = !text;
  }

  function onStreamLive(ev) {
    conn.live = true;
    if (!overlayMode) systemLine(`${slug} went live${ev.title ? `: ${ev.title}` : ''}`);
    updateStatus();
  }

  function onStreamOffline() {
    conn.live = false;
    if (!overlayMode) systemLine(`${slug} went offline`);
    updateStatus();
  }

  const EVENT_HANDLERS = {
    stream_live: onStreamLive,
    stream_offline: onStreamOffline,
    message_deleted: onMessageDeleted,
    chat_cleared: onChatCleared,
    user_banned: onUserBanned,
    user_unbanned: onUserUnbanned,
    pin_created: (ev) => showPin(ev),
    pin_deleted: () => clearPin(),
    subscription: onSubscription,
    gifted_subs: onGiftedSubs,
    host: onHost,
  };

  function onEvent(ev) {
    const handler = ev && EVENT_HANDLERS[ev.type];
    if (!handler) return;
    // Deletions and bans look rows up in the DOM, so anything still queued
    // for this frame has to land first or it would be missed.
    flushRows();
    handler(ev);
  }

  // ---------------------------------------------------------------------
  // Connection
  // ---------------------------------------------------------------------

  function showHint() {
    const row = document.createElement('div');
    row.className = 'hint';
    row.append('Add a Kick channel name to the URL, e.g. ');
    const code = document.createElement('code');
    code.textContent = `${location.origin}/xqc`;
    row.appendChild(code);
    appendRow(row);
  }

  // Messages can arrive twice: once from the history backfill and once live
  // (or again after a reconnect replays nothing, but Kick may re-deliver).
  const seenIds = new Set();
  const SEEN_CAP = 5000;

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

  // ---------------------------------------------------------------------
  // This page sends nothing to its own server. The heartbeats that fed the
  // admin board's viewer counts are gone while the extension goes through
  // Chrome Web Store review: with no data leaving the page there is nothing
  // to disclose and no privacy policy to stand behind yet.
  //
  // The server side is untouched - /api/beat, betterchat/stats.py and the
  // board all still exist - so restoring this means putting the sender back
  // and nothing else. It sent a random per-tab id, the channel slug, a
  // message count, and whether the page was embedded (?embed=1).
  // ---------------------------------------------------------------------

  // Refreshes the pin from Kick's history endpoint (used on connect and
  // after a reconnect, when a pin may have come or gone unnoticed).
  async function refreshPinAndHistory(channelId, backfill) {
    try {
      const { pinned, messages } = await kick.pinnedAndHistory(channelId);
      if (backfill) for (const m of messages) if (notSeenBefore(m)) appendMessage(m);
      if (pinned) showPin(pinned);
      else clearPin();
    } catch (_e) {
      /* history is a nice-to-have; live chat works without it */
    }
  }

  async function watch(channelSlug) {
    document.title = `${channelSlug} - BetterChat`;
    if (!overlayMode) systemLine(`joining ${channelSlug}...`);
    updateStatus();

    let info;
    try {
      info = await kick.resolveChannel(channelSlug);
    } catch (e) {
      const notFound = e && e.status === 404;
      systemLine(notFound ? `no such channel: ${channelSlug}` : 'Kick API is unavailable', true);
      statusPill.hidden = true;
      return;
    }

    subscriberBadges = info.subscriber_badges || [];
    conn.live = info.live;
    document.title = `${info.slug} - BetterChat`;

    // Recent messages + current pin, so the page isn't empty on open.
    await refreshPinAndHistory(info.channel_id, true);

    const relay = new BetterChatKick.PusherRelay({
      appKey: CONFIG.pusherAppKey,
      cluster: CONFIG.pusherCluster,
      chatroomId: info.chatroom_id,
      channelId: info.channel_id,
      onMessage: (msg) => {
        if (notSeenBefore(msg)) {
          appendMessage(msg);
        }
      },
      onEvent,
      onSocket: (open) => {
        const was = conn.browser;
        conn.browser = open;
        if (!open && was && !overlayMode) systemLine('lost connection to Kick, reconnecting...', true);
        updateStatus();
      },
      onSubscribed: (ok) => {
        conn.relay = ok;
        if (ok) {
          const rejoin = conn.joinedOnce;
          conn.joinedOnce = true;
          if (!overlayMode) {
            systemLine(rejoin ? `reconnected to ${info.slug}'s chat` : `connected to ${info.slug}'s chat`);
            if (!rejoin && info.live === false) systemLine(`${info.slug} is not live right now - you'll still see chat`);
          }
          // After a drop, a pin may have changed while we weren't listening.
          if (rejoin) refreshPinAndHistory(info.channel_id, false);
        }
        updateStatus();
      },
      onUnknown: (name, data) => {
        if (query.has('debug')) console.debug('unhandled Kick event', name, data);
      },
    });
    relay.connect();
    window.addEventListener('beforeunload', () => relay.close());
  }

  // Service worker: caches the shell and scripts so the page still loads
  // when this origin is down. The chat itself only needs kick.com, so a
  // cached load is a fully working one - see site/sw.js. Allowed on https
  // and on localhost, which is where the API permits it.
  if (
    'serviceWorker' in navigator &&
    (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))
  ) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }

  document.body.classList.toggle('overlay', overlayMode);
  applySettings();
  if (slug) watch(slug);
  else showHint();
})();
