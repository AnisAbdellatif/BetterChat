// The page starts once defaults.json has arrived (settings.js fetches it):
// every setting's starting value comes from there. If it cannot be had, the
// handler at the very bottom says so on the page.
BetterChatSettings.ready.then(function () {
  'use strict';

  const messagesEl = document.getElementById('messages');
  const replyBarEl = document.getElementById('replyBar');
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const query = new URLSearchParams(location.search);

  // The channel comes from the URL path: /xqc -> "xqc". Static hosts that
  // can't rewrite paths can use /?c=xqc or /#xqc instead.
  const slug = (() => {
    const first = location.pathname.replace(/^\/+|\/+$/g, '').split('/')[0] || '';
    const fromPath = /\.html?$/i.test(first) ? '' : first;
    return decodeURIComponent(fromPath || query.get('c') || location.hash.replace(/^#/, '') || '').trim();
  })();

  // Kick's API base and the chat feed's address (config.js). The chat
  // session (core.js) is what uses them; this file draws what it sends. The
  // feed is this origin's own /realtime relay unless config.js names another.
  const CONFIG = Object.assign({}, window.BETTERCHAT_CONFIG);
  if (!CONFIG.realtimeUrl) {
    CONFIG.realtimeUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/realtime`;
  }

  // OBS overlay mode (?overlay=1): transparent, no controls, fading messages.
  const overlayMode = ['1', 'true', 'on'].includes((query.get('overlay') || '').toLowerCase());

  // Embedded mode (?embed=1): this page is in an iframe on someone else's
  // site - kick.com, in place of the official chat - rather than opened
  // directly. Only the viewer count cares: it tells the board which viewers
  // arrived through an embed.
  const embedMode = ['1', 'true', 'on'].includes((query.get('embed') || '').toLowerCase());

  // ---------------------------------------------------------------------
  // Settings (per viewer, kept in localStorage; can be overridden by URL)
  // ---------------------------------------------------------------------

  // The settings model lives in settings.js (no DOM, so it can be tested on
  // its own). Pulled into scope here so the rest of this file reads the same
  // as when it was all one.
  const {
    SETTINGS_KEY, LEGACY_SETTINGS_KEY, PINNED_HISTORY, KICK_GREEN, FONT_STACKS,
    BADGE_KINDS, BADGE_LABELS, DELETED_MODES, STATS_CHOICES,
    TIMESTAMP_FORMATS, DEFAULTS, NOT_SHAREABLE, HEX6,
    cleanFontName, cleanUsername, clampInt, oneOf, sanitize,
    settingsFromQuery, settingsAsParams, fontFamilyCss,
  } = BetterChatSettings;

  function loadStoredSettings() {
    try {
      const stored = localStorage.getItem(SETTINGS_KEY) || localStorage.getItem(LEGACY_SETTINGS_KEY);
      const raw = JSON.parse(stored);
      return raw && typeof raw === 'object' ? raw : {};
    } catch (_e) {
      return {};
    }
  }

  const urlSettings = settingsFromQuery(query);
  const settingsFromUrlOnly = Object.keys(urlSettings).length > 0;

  let settings = sanitize({ ...loadStoredSettings(), ...urlSettings });

  // Where the settings are kept. localStorage everywhere, except inside the
  // KickPlus extension, where the parent tab holds them instead.
  //
  // This page is third-party storage in that iframe, and a browser may treat
  // third-party storage as disposable. Brave does: it deletes an embedded
  // origin's storage thirty seconds after the last kick.com tab closes, so
  // everything saved here quietly evaporates between sessions - the counting
  // question comes back, and so do the default font and badges. The extension
  // has storage of its own that no shield partitions, so when it offers to
  // hold them, it holds them. Set once the handshake answers; until then, and
  // everywhere else, this stays null and nothing about saving changes.
  let settingsHeldByParent = false;

  function saveSettings() {
    // A shared link's settings shouldn't silently overwrite the viewer's own.
    if (settingsFromUrlOnly) return;
    if (settingsHeldByParent) {
      // Nothing waits on the answer: a save that failed leaves the settings
      // applied and the next one tries again, which is what localStorage does
      // when it throws.
      askParent({ type: 'settings', settings });
      return;
    }
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch (_e) {
      /* private mode / storage disabled - settings just won't persist */
    }
  }

  function settingsLink(withOverlay) {
    const params = settingsAsParams(settings);
    if (withOverlay) params.set('overlay', '1');
    const qs = params.toString();
    return `${location.origin}/${encodeURIComponent(slug || 'CHANNEL')}${qs ? '?' + qs : ''}`;
  }

  function scrollbackEnabled() {
    return settings.scrollback && !overlayMode;
  }

  function usernameColor(kickColor) {
    return BetterChatCore.usernameColor(settings, kickColor);
  }

  // Re-applies everything that affects messages already on screen.
  function applySettings() {
    // Font, spacing and timestamps all change row heights, so a viewer who
    // has scrolled up keeps their place through a change made while reading.
    keepingView(applySettingsNow);
  }

  function applySettingsNow() {
    document.documentElement.style.setProperty('--chat-font-size', `${settings.fontSize}px`);
    document.documentElement.style.setProperty('--chat-font-family', fontFamilyCss(settings));
    // Overlay mode keeps a transparent body regardless (body.overlay CSS).
    document.documentElement.style.setProperty('--chat-bg', settings.bgColor);
    document.documentElement.style.setProperty('--chat-gap', `${settings.messageGap}px`);
    document.body.classList.toggle('no-scrollback', !scrollbackEnabled());
    document.body.classList.toggle('show-ts', settings.timestamps);
    document.body.classList.toggle('user-cards', settings.userCards && !overlayMode);
    if (!settings.userCards) closeUserCard();
    // The session restyles the rows a setting changes (name colours, badges,
    // the mention highlight) and trims to the history size; turning
    // scrollback off may have just let go of the view, so it hears that
    // first.
    syncHeld();
    session.updateSettings(settings);
    restyleRows();
    applyPinVisibility();
    applyBeats();
    showConsentIfUnanswered();
    updateJumpPill(); // scrollback may have just been turned off
  }

  // What a setting changes on an existing message that is this page's own
  // business rather than the session's, in one walk of the list: the
  // timestamp's format, and the action bar. Name colours, badges and the
  // mention highlight arrive from the session as updates to the rows that
  // actually change.
  function restyleRows() {
    for (const row of messagesEl.querySelectorAll('.msg')) {
      const ts = row.querySelector('.ts[data-time]');
      if (ts) ts.textContent = formatTime(ts.dataset.time);

      // Rows drawn before the handshake landed, or before the controls were
      // switched on, have no bar yet or an incomplete one.
      fitActions(row);
    }
  }

  // The pin banner changes the list's height, so showing or hiding it has to
  // re-stick the scroll - but nothing about the messages themselves changed,
  // so it must not go through applySettings and walk the list. Pins arrive on
  // every reconnect, and the list can hold thousands of rows.
  function applyPinVisibility() {
    // The banner pads the top of the list, so a viewer scrolled up keeps
    // their place when it comes or goes.
    keepingView(() => {
      // A live pin the viewer has hidden is not gone: the banner goes away and
      // the button under the gear appears to bring it back.
      const live = settings.showPinned && pinnedActive;
      pinnedEl.hidden = !live || pinHidden;
      showPinBtn.hidden = !live || !pinHidden;
      document.body.classList.toggle('has-pin', !pinnedEl.hidden);
    });
  }

  // ---------------------------------------------------------------------
  // Settings panel
  // ---------------------------------------------------------------------

  const overlay = document.getElementById('settingsOverlay');
  const panel = document.getElementById('settingsPanel');
  const settingsBtn = document.getElementById('settingsBtn');
  const actionNote = document.getElementById('actionNote');
  const controls = [...panel.querySelectorAll('[data-setting]')];
  // ---------------------------------------------------------------------
  // Badge list: which kinds are shown, and the order they are drawn in.
  //
  // One list does both jobs - the checkbox shows or hides a kind, the row's
  // position is its place next to usernames. Rows are built from
  // settings.badgeOrder rather than written out in the HTML, so the order is
  // the single source of truth and there is nothing to keep in sync by hand.
  // ---------------------------------------------------------------------

  const badgeList = document.getElementById('badgeList');

  function badgeChecks() {
    return [...badgeList.querySelectorAll('[data-badge]')];
  }

  function badgeLabel(kind) {
    return BADGE_LABELS[kind] || kind;
  }

  // Rebuilding replaces the row the viewer was using, so where the keyboard
  // was is noted first and put back afterwards.
  function currentBadgeFocus() {
    const active = document.activeElement;
    const row = active && active.closest ? active.closest('.badge-row') : null;
    if (!row) return null;
    if (active.dataset.move) return { kind: row.dataset.kind, move: active.dataset.move };
    if (active.dataset.badge) return { kind: row.dataset.kind, check: true };
    return null;
  }

  function restoreBadgeFocus(target) {
    if (!target) return;
    const row = badgeList.querySelector(`.badge-row[data-kind="${target.kind}"]`);
    if (!row) return;
    if (target.check) {
      const check = row.querySelector('[data-badge]');
      if (check) check.focus();
      return;
    }
    const same = row.querySelector(`[data-move="${target.move}"]`);
    if (same && !same.disabled) {
      same.focus();
      return;
    }
    // The row reached an end and that arrow is disabled now; the other one is
    // where the keyboard should land.
    const other = row.querySelector('[data-move]:not(:disabled)');
    if (other) other.focus();
  }

  function moveButton(kind, delta, glyph, name, disabled) {
    const btn = el('button', 'badge-move', glyph);
    btn.type = 'button';
    btn.dataset.move = name;
    btn.disabled = disabled;
    btn.setAttribute('aria-label', `Move ${badgeLabel(kind)} ${name}`);
    btn.addEventListener('click', () => moveBadge(kind, delta));
    return btn;
  }

  function buildBadgeList() {
    const focus = currentBadgeFocus();
    const last = settings.badgeOrder.length - 1;
    badgeList.replaceChildren();

    settings.badgeOrder.forEach((kind, at) => {
      const row = el('div', 'badge-row');
      row.dataset.kind = kind;
      row.draggable = true;

      const grip = el('span', 'badge-grip', '⠿');
      grip.setAttribute('aria-hidden', 'true');
      row.appendChild(grip);

      const label = document.createElement('label');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.dataset.badge = kind;
      check.checked = !isBadgeHidden(kind);
      label.appendChild(check);
      label.append(badgeLabel(kind));
      row.appendChild(label);

      row.appendChild(moveButton(kind, -1, '↑', 'up', at === 0));
      row.appendChild(moveButton(kind, 1, '↓', 'down', at === last));

      badgeList.appendChild(row);
    });

    restoreBadgeFocus(focus);
  }

  function moveBadge(kind, delta) {
    const order = [...settings.badgeOrder];
    const from = order.indexOf(kind);
    const to = from + delta;
    if (from === -1 || to < 0 || to >= order.length) return;
    order[from] = order[to];
    order[to] = kind;
    replaceSettings({ ...settings, badgeOrder: order });
  }

  function dropBadge(kind, onto, after) {
    if (!kind || kind === onto) return;
    const order = settings.badgeOrder.filter((k) => k !== kind);
    let at = order.indexOf(onto);
    if (at === -1) return;
    if (after) at += 1;
    order.splice(at, 0, kind);
    replaceSettings({ ...settings, badgeOrder: order });
  }

  // Drag and drop. Listeners sit on the list, not the rows, so they survive
  // every rebuild.
  let draggingKind = null;

  function clearDropHints() {
    for (const row of badgeList.querySelectorAll('.badge-row')) {
      row.classList.remove('drop-before', 'drop-after');
    }
  }

  function dropsAfter(row, event) {
    const box = row.getBoundingClientRect();
    return event.clientY > box.top + box.height / 2;
  }

  badgeList.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.badge-row');
    if (!row) return;
    draggingKind = row.dataset.kind;
    row.classList.add('dragging');
    if (!e.dataTransfer) return;
    e.dataTransfer.effectAllowed = 'move';
    // Firefox will not start a drag with an empty transfer.
    try {
      e.dataTransfer.setData('text/plain', draggingKind);
    } catch (_e) {
      /* not fatal - the kind is held in draggingKind anyway */
    }
  });

  badgeList.addEventListener('dragover', (e) => {
    if (!draggingKind) return;
    const row = e.target.closest('.badge-row');
    if (!row) return;
    e.preventDefault(); // without this the drop is refused
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    clearDropHints();
    if (row.dataset.kind === draggingKind) return;
    row.classList.add(dropsAfter(row, e) ? 'drop-after' : 'drop-before');
  });

  badgeList.addEventListener('drop', (e) => {
    if (!draggingKind) return;
    e.preventDefault();
    const row = e.target.closest('.badge-row');
    const kind = draggingKind;
    draggingKind = null;
    clearDropHints();
    if (row) dropBadge(kind, row.dataset.kind, dropsAfter(row, e));
  });

  // Runs when a drag ends anywhere, including outside the list.
  badgeList.addEventListener('dragend', () => {
    draggingKind = null;
    clearDropHints();
    for (const row of badgeList.querySelectorAll('.dragging')) {
      row.classList.remove('dragging');
    }
  });

  function syncPanel() {
    for (const el of controls) {
      const value = settings[el.dataset.setting];
      if (el.type === 'checkbox') el.checked = value;
      else el.value = value;
    }
    // Rebuilds the rows, which also sets each checkbox from the settings.
    buildBadgeList();
    // A checkbox against a three-state value: "ask" reads as off, and the
    // banner is what turns it into a real answer.
    const statsEl = panel.querySelector('[data-stats]');
    if (statsEl) statsEl.checked = settings.stats === 'on';
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
      const hidden = badgeChecks().filter((c) => !c.checked).map((c) => c.dataset.badge);
      replaceSettings({ ...settings, hiddenBadges: hidden });
      return;
    }

    if (el.hasAttribute('data-stats')) {
      // Either way this is an answer, so the banner has nothing left to ask.
      replaceSettings({ ...settings, stats: el.checked ? 'on' : 'off' });
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
    // Read when the tab is opened rather than at startup: a deploy can land
    // while the panel is closed, and this is the one place that would then be
    // showing something that is no longer true.
    if (name === 'about') showBuild();
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
    const shareable = { ...settings };
    for (const key of NOT_SHAREABLE) delete shareable[key];
    const blob = new Blob([JSON.stringify(shareable, null, 2)], { type: 'application/json' });
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
      // An imported file never speaks for the viewer on consent.
      replaceSettings({ ...raw, stats: settings.stats });
      note('Settings imported.');
    } catch (_e) {
      note('That file is not a valid settings export.', true);
    }
  });

  document.getElementById('resetSettings').addEventListener('click', () => {
    if (!window.confirm('Reset all chat settings to their defaults?')) return;
    // Same rule: resetting the look of the chat is not a privacy decision.
    replaceSettings({ stats: settings.stats });
    note('Settings reset.');
  });

  // ---- About: which build is this ----------------------------------------
  //
  // There is no version number to show: nothing is bundled and no filename
  // carries a hash, so what identifies a build is the hash of the site's
  // files that the server computes and the service worker names its cache
  // after. Showing it turns "it's broken on the live site" into something
  // that names a build.
  //
  // Two hashes, not one. The server says what it is serving now; the cache
  // name says what this tab is actually running, which after a deploy is the
  // older of the two until the new worker takes over. Saying so is the point:
  // "I'm on the latest" is the question being asked.

  const buildIdEl = document.getElementById('buildId');
  const buildNoteEl = document.getElementById('buildNote');
  const copyBuildBtn = document.getElementById('copyBuild');
  const recheckBuildBtn = document.getElementById('recheckBuild');

  // What this tab is running, read from the cache the worker filled. Null
  // where there is no worker at all (a fresh load, or an unsupported
  // browser), which is not the same as being out of date.
  async function runningBuild() {
    if (!('caches' in window)) return null;
    try {
      const names = await caches.keys();
      const mine = names.filter((n) => n.startsWith('betterchat-'));
      // More than one only while an activate is in flight, and the worker
      // drops the rest; with none to choose from there is nothing to report.
      return mine.length === 1 ? mine[0].slice('betterchat-'.length) : null;
    } catch (_e) {
      return null;
    }
  }

  async function showBuild() {
    let served = null;
    try {
      const res = await fetch('/api/build', { cache: 'no-store' });
      if (res.ok) served = (await res.json()).build || null;
    } catch (_e) {
      served = null;
    }
    const running = await runningBuild();

    // The one this tab is actually running is the honest answer; the server's
    // is the fallback for a tab with no worker yet.
    const shown = running || served;
    buildIdEl.textContent = shown || 'unknown';
    copyBuildBtn.hidden = !shown;

    if (!served && !running) {
      // A static host with no /api/build, or offline on a first load.
      buildNoteEl.textContent = 'This copy does not report a build.';
    } else if (running && served && running !== served) {
      buildNoteEl.textContent = `A newer build (${served}) is on the server. Reload twice, or close every tab, to move to it.`;
    } else if (running) {
      buildNoteEl.textContent = 'Up to date with the server.';
    } else {
      buildNoteEl.textContent = 'Serving this build now; this tab has not cached one yet.';
    }
  }

  copyBuildBtn.addEventListener('click', async () => {
    if (await copyText(buildIdEl.textContent)) note('Build copied.');
  });

  // Opening the tab asks once, which is the wrong number when you are waiting
  // on a deploy: the answer you want is the one from after it landed, and the
  // panel is already open. /api/ is the one path the worker never answers for,
  // so this really does reach the server every time.
  //
  // What it can tell you is what is being served, not what this tab has got:
  // moving to a new build is the worker's job, and the note says what that
  // takes. So the check can come back "a newer build is on the server" twice
  // running without anything being wrong.
  recheckBuildBtn.addEventListener('click', () => {
    recheckBuildBtn.disabled = true;
    // Said out loud, because an unchanged answer is indistinguishable from a
    // button that did nothing.
    buildNoteEl.textContent = 'Checking...';
    // Let go however it turns out: a check that failed is one worth repeating.
    showBuild().finally(() => {
      recheckBuildBtn.disabled = false;
    });
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

  // Clears what this tab is showing, and nothing more: no request to Kick, no
  // effect on anyone else's chat. A moderator clearing the channel is a
  // different thing entirely, and arrives as an event.
  document.getElementById('clearChat').addEventListener('click', () => {
    // The session forgets its rows (so a later repeat starts a fresh message)
    // and sends a clear - which also drops rows still queued for the next
    // frame - followed by the "chat cleared" line.
    session.clearLocal();
    // Nothing is left to have scrolled up through.
    stickToBottom = true;
    syncHeld();
    updateJumpPill();
    closeUserCard();
  });
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

  // ---------------------------------------------------------------------
  // Following the newest message, and holding still when the viewer scrolls
  // up to read.
  //
  // `stickToBottom` is the viewer's intention, latched rather than measured
  // again on every append (one bad reading used to leave the view off the
  // bottom, which made every later reading bad too). Only the viewer moving
  // the list changes it:
  //   - any movement up lets go. An upward wheel lets go before the scroll
  //     even lands: with smooth scrolling, the first scroll event can arrive
  //     after an append has already pulled the view back down, and on a busy
  //     chat that meant never getting away from the bottom at all. A button
  //     or finger held down on the list (dragging the scrollbar, a touch
  //     scroll, selecting text) holds it for as long as it stays down, for
  //     the same reason.
  //   - reaching the bottom again, or scrolling down to within a line of it,
  //     takes hold again.
  // Scrolls this code makes itself are recognised by where they land, and
  // ignored.
  //
  // Holding also means the list does not move under the reader. Anything
  // that can take rows away or resize them goes through keepingView(), which
  // puts the row being read back where it was on screen. And while held, old
  // rows are kept up to twice the history size instead of being trimmed from
  // under the reader; the first append after they return trims back to size.
  // ---------------------------------------------------------------------

  const NEAR_BOTTOM_PX = 40;
  let stickToBottom = true;
  let pointerDown = false;
  // Where this code last put scrollTop. A scroll event landing there is ours.
  let ownScrollTop = -1;
  let lastScrollTop = 0;

  function following() {
    return !scrollbackEnabled() || (stickToBottom && !pointerDown);
  }

  // The session does the trimming, so it is told whenever the view is held
  // or let go: while held it keeps twice the history size.
  let heldInSession = false;

  function syncHeld() {
    const held = !following();
    if (held === heldInSession) return;
    heldInSession = held;
    session.setHeld(held);
  }

  // The pill that shows while chat is held: how many messages have arrived
  // below since the viewer scrolled up, and a way straight back down to them.
  const jumpBtn = document.getElementById('jumpLatest');
  let unseenMessages = 0;

  function updateJumpPill() {
    const held = scrollbackEnabled() && !stickToBottom;
    if (!held) unseenMessages = 0;
    jumpBtn.hidden = !held;
    if (!held) return;
    // Clear of whatever else shares the bottom centre: the status pill, and
    // the consent banner while it is still waiting for an answer - it sits
    // on top, so the pill would otherwise be hidden under it on a first visit.
    let bottom = 10;
    if (!statusPill.hidden) bottom += 34;
    if (!consentEl.hidden) {
      bottom = Math.max(bottom, window.innerHeight - consentEl.getBoundingClientRect().top + 8);
    }
    jumpBtn.style.bottom = `${bottom}px`;
    const n = unseenMessages;
    jumpBtn.textContent = n
      ? `${n > 999 ? '999+' : n} new message${n === 1 ? '' : 's'} ↓`
      : 'Jump to latest ↓';
  }

  jumpBtn.addEventListener('click', () => {
    stickToBottom = true;
    syncHeld();
    // Trims what was kept while held and lands on the bottom.
    keepingView(() => session.trim());
    updateJumpPill();
  });

  function setScrollTop(top) {
    messagesEl.scrollTop = top;
    ownScrollTop = messagesEl.scrollTop; // as the browser clamped it
    lastScrollTop = ownScrollTop;
  }

  function stickIfFollowing() {
    if (following()) setScrollTop(messagesEl.scrollHeight);
  }

  messagesEl.addEventListener('scroll', () => {
    const top = messagesEl.scrollTop;
    if (Math.abs(top - ownScrollTop) <= 1) return;
    // The position is the viewer's from here on, so coming back to this same
    // spot later is not mistaken for one of ours.
    ownScrollTop = -1;
    const movedUp = top < lastScrollTop;
    lastScrollTop = top;
    const distance = messagesEl.scrollHeight - top - messagesEl.clientHeight;
    if (distance <= 1 || (!movedUp && distance < NEAR_BOTTOM_PX)) stickToBottom = true;
    else if (movedUp) stickToBottom = false;
    syncHeld();
    updateJumpPill();
  }, { passive: true });

  messagesEl.addEventListener('wheel', (e) => {
    // Only when the list can actually go up: a wheel on a list already at its
    // top, or too short to scroll, moves nothing and must not stop following.
    if (e.deltaY < 0 && !e.ctrlKey && messagesEl.scrollTop > 0) {
      stickToBottom = false;
      syncHeld();
      updateJumpPill();
    }
  }, { passive: true });

  function pressList() {
    pointerDown = true;
    syncHeld();
  }

  function releaseList() {
    if (!pointerDown) return;
    pointerDown = false;
    syncHeld();
    // Whatever arrived while it was held lands now, if still following.
    stickIfFollowing();
  }

  messagesEl.addEventListener('mousedown', pressList);
  messagesEl.addEventListener('touchstart', pressList, { passive: true });
  window.addEventListener('mouseup', releaseList);
  window.addEventListener('touchend', releaseList, { passive: true });
  window.addEventListener('touchcancel', releaseList, { passive: true });
  window.addEventListener('blur', releaseList);
  // A release outside the frame may never reach it; the next move with no
  // button down settles that.
  messagesEl.addEventListener('mousemove', (e) => {
    if (pointerDown && e.buttons === 0) releaseList();
  });

  // kick.com resizes the frame - theater mode, a collapsed sidebar, the
  // window itself - which changes clientHeight without firing any scroll
  // event. Re-assert rather than silently drifting off the bottom.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(stickIfFollowing).observe(messagesEl);
  }

  // How many rows from the top of the view are remembered, so the view can
  // still be put back when the row at the very top is the one taken away.
  const ANCHOR_SPAN = 20;

  // Runs a change that may remove or resize rows, then puts the view back:
  // on the bottom when following; otherwise on the same row, at the same
  // height on screen.
  function keepingView(change) {
    if (following()) {
      change();
      stickIfFollowing();
      return;
    }
    const anchors = rowsAtTop();
    change();
    for (const { row, top } of anchors) {
      if (!row.isConnected) continue;
      const moved = row.getBoundingClientRect().top - top;
      if (moved) setScrollTop(messagesEl.scrollTop + moved);
      return;
    }
  }

  // The first row reaching into the view, and a few after it, each with where
  // it is. Rows are stacked in order, so a binary search finds the first.
  function rowsAtTop() {
    const rows = messagesEl.children;
    if (!rows.length) return [];
    const viewTop = messagesEl.getBoundingClientRect().top;
    let lo = 0;
    let hi = rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].getBoundingClientRect().bottom <= viewTop) lo = mid + 1;
      else hi = mid;
    }
    const out = [];
    for (let i = lo; i < rows.length && out.length < ANCHOR_SPAN; i++) {
      out.push({ row: rows[i], top: rows[i].getBoundingClientRect().top });
    }
    return out;
  }

  // Overlay mode: rows fade out and are removed after overlayFadeSec. The
  // session is told, so it stops counting them as there - a repeat of a
  // message that has faded out is drawn again rather than counted onto it.
  function scheduleFade(row) {
    if (!overlayMode || settings.overlayFadeSec <= 0) return;
    setTimeout(() => {
      row.classList.add('fade');
      setTimeout(() => {
        row.remove();
        const id = rowIds.get(row);
        if (id && rowEls.get(id) === row) {
          rowEls.delete(id);
          session.dropRows([id]);
        }
      }, 500);
    }, settings.overlayFadeSec * 1000);
  }

  // Messages arrive in bursts - a busy channel can land several in a single
  // frame - and appending one at a time cost a forced layout each for the
  // scroll that follows. Queue instead and flush once per frame through a
  // fragment, so a burst costs one layout however many messages it carries.
  //
  // The session trims the history as rows arrive, so its trims wait in the
  // queue too: rows already on screen come off in the same flush that adds
  // the new ones, and rows still queued are dropped straight away, which is
  // what keeps a page that isn't being painted from growing the queue
  // without bound.
  let pendingRows = [];
  let pendingTrims = [];
  let flushFrame = 0;
  let flushTimer = 0;

  // Every row the session has sent, by its id, queued or on screen.
  const rowEls = new Map(); // row id -> element
  const rowIds = new WeakMap(); // element -> row id
  // The channel as Kick spells it, once the session has resolved it.
  let joinedSlug = null;

  function flushRows() {
    if (flushFrame) cancelAnimationFrame(flushFrame);
    if (flushTimer) clearTimeout(flushTimer);
    flushFrame = flushTimer = 0;
    if (!pendingRows.length && !pendingTrims.length) return;
    const rows = pendingRows;
    const trims = pendingTrims;
    pendingRows = [];
    pendingTrims = [];
    if (rows.length) {
      const frag = document.createDocumentFragment();
      for (const row of rows) frag.appendChild(row);
      messagesEl.appendChild(frag);
      if (scrollbackEnabled() && !stickToBottom) {
        for (const row of rows) if (row.classList.contains('msg')) unseenMessages++;
        updateJumpPill();
      }
    }
    // New rows go in below the view, so they never move what is being read;
    // trimming old ones off the top can.
    keepingView(() => removeRowEls(trims));
    for (const row of rows) scheduleFade(row);
  }

  function scheduleFlush() {
    if (flushFrame || flushTimer) return;
    flushFrame = requestAnimationFrame(flushRows);
    // A cross-origin iframe that kick.com has scrolled out of view gets no
    // animation frames at all, and nor does a background tab, so rAF on its
    // own can stall the queue indefinitely. Timers are throttled but still
    // fire, so one is always armed underneath as a floor.
    flushTimer = setTimeout(flushRows, 250);
  }

  function appendRow(row) {
    pendingRows.push(row);
    scheduleFlush();
  }

  function removeRowEls(ids) {
    for (const id of ids) {
      const row = rowEls.get(id);
      if (!row) continue;
      rowEls.delete(id);
      row.remove();
    }
  }

  // Takes rows away wherever they are: still queued, or on screen.
  function dropQueued(ids) {
    const gone = new Set();
    for (const id of ids) {
      const row = rowEls.get(id);
      if (row && !row.isConnected) {
        rowEls.delete(id);
        gone.add(row);
      }
    }
    if (gone.size) pendingRows = pendingRows.filter((row) => !gone.has(row));
  }

  function trimRows(ids) {
    dropQueued(ids);
    if (pendingRows.length) {
      // Off in the flush that brings the new rows in.
      pendingTrims.push(...ids.filter((id) => rowEls.has(id)));
      scheduleFlush();
    } else {
      // Nothing waiting to go in (a settings change, the jump button): now.
      keepingView(() => removeRowEls(ids));
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) flushRows();
  });

  // ---------------------------------------------------------------------
  // Drawing the session's operations (core.js, docs/core-protocol.md)
  // ---------------------------------------------------------------------

  function applyOps(ops) {
    // A deletion, a ban or a clear can take rows away from above the view or
    // change their height, and must not move what the viewer is reading.
    const moves = ops.some(
      (op) => op.op === 'remove' || op.op === 'clear' || (op.op === 'update' && op.patch.deleted != null)
    );
    if (moves) keepingView(() => ops.forEach(applyOp));
    else ops.forEach(applyOp);
  }

  function applyOp(op) {
    switch (op.op) {
      case 'append': {
        const row = buildRow(op.row);
        rowEls.set(op.row.id, row);
        rowIds.set(row, op.row.id);
        appendRow(row);
        return;
      }
      case 'update': {
        const row = rowEls.get(op.id);
        if (row) patchRow(row, op.patch);
        return;
      }
      case 'remove':
        dropQueued([op.id]);
        removeRowEls([op.id]);
        return;
      case 'trim':
        trimRows(op.ids);
        return;
      case 'clear':
        // Rows already queued for the next frame would otherwise land right
        // after the list was emptied.
        pendingRows = [];
        pendingTrims = [];
        rowEls.clear();
        messagesEl.replaceChildren();
        return;
      case 'verify':
        markMentionsVerified(op.key);
        return;
      case 'pin':
        if (op.pin) showPin(op.pin);
        else clearPin();
        return;
      case 'status':
        // The viewer count starts the first time the chat subscription is
        // confirmed, and is not restarted by a reconnect.
        if (op.status.subscribed && joinedSlug && !beatChannel) startBeats(joinedSlug);
        showStatus(op.status);
        return;
      case 'channel':
        joinedSlug = op.channel.slug;
        document.title = `${op.channel.slug} - BetterChat`;
        return;
      case 'history':
        if (op.user === openUserKey) appendOpenCardMessage(op.entry, op.count);
        return;
      default:
        // An operation from a newer core than this page knows: nothing to draw.
    }
  }

  function buildRow(row) {
    if (row.kind === 'message') return messageRow(row);
    if (row.kind === 'card') return eventCard(row);
    return lineRow(row);
  }

  function patchRow(row, patch) {
    if (patch.color !== undefined) {
      const user = row.querySelector(':scope > .user');
      if (user) user.style.color = patch.color;
    }
    if (patch.badges) patchBadges(row, patch.badges);
    if (patch.mentionsMe !== undefined) row.classList.toggle('mentions-me', patch.mentionsMe);
    if (patch.repeats !== undefined) showRepeats(row, patch.repeats);
    if (patch.deleted != null) markDeleted(row, patch.deleted);
  }

  // System lines are plain text. Moderation lines carry an icon and segments,
  // so usernames can be styled without innerHTML. A timeout is a record, not
  // an occasion, and is drawn as a line rather than a card.
  function lineRow(line) {
    if (line.style === 'system') {
      const row = document.createElement('div');
      row.className = 'system' + (line.error ? ' error' : '');
      row.textContent = line.segs.map(segText).join('');
      return row;
    }
    const row = document.createElement('div');
    row.className = `event ${line.style}`;
    const ic = document.createElement('span');
    ic.className = 'icon';
    ic.textContent = line.icon;
    row.appendChild(ic);
    fillSegs(row, line.segs);
    return row;
  }

  // Subs, gifts, Kicks, rewards and hosts: the icon larger, who did what on
  // the first line, and the number that actually matters - months, how many
  // were gifted, how many viewers came with a host - on its own beneath it.
  function eventCard(card) {
    const row = el('div', `event card ${card.card}`);
    const ic = el('span', 'icon', card.icon);
    const body = el('div', 'event-body');
    const head = el('div', 'event-head');
    fillSegs(head, card.head);
    body.appendChild(head);
    if (card.detail && card.detail.length) {
      const line = el('div', 'event-detail');
      fillSegs(line, card.detail);
      body.appendChild(line);
    }
    row.append(ic, body);
    return row;
  }

  // Grouped, because a host can bring four figures of viewers and "1204
  // viewers" is a number you have to count the digits of.
  function segText(seg) {
    if (seg.t === 'count') return `${Number(seg.n).toLocaleString()} ${seg.n === 1 ? seg.unit : seg.units}`;
    if (seg.t === 'user') return seg.name;
    return seg.text || '';
  }

  // Segments into a node, a username as a span of its own so it is styled
  // and never built out of innerHTML.
  function fillSegs(into, segs) {
    for (const seg of segs) {
      if (seg.t === 'user') into.appendChild(el('span', 'user', seg.name));
      else into.appendChild(document.createTextNode(segText(seg)));
    }
  }

  function formatTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const two = (n) => String(n).padStart(2, '0');
    const base = `${two(d.getHours())}:${two(d.getMinutes())}`;
    return settings.timestampFormat === 'hms' ? `${base}:${two(d.getSeconds())}` : base;
  }

  // A repeat counted onto this row: the count goes in front of the message
  // itself, after any timestamp.
  function showRepeats(row, total) {
    row.dataset.repeats = String(total);
    let tag = row.querySelector('.repeat-count');
    if (!tag) {
      tag = el('span', 'repeat-count');
      const anchor = row.querySelector('.badges') || row.querySelector('.user');
      row.insertBefore(tag, anchor || null);
    }
    tag.textContent = `×${total}`;
    // "copies", not "posted N times": with an allowance above one, earlier
    // copies got rows of their own and this counts the ones folded into this.
    tag.title = `${total} copies`;
  }

  function markDeleted(row, reason) {
    row.classList.add('deleted');
    const tag = row.querySelector('.deleted-tag');
    if (tag && reason) tag.textContent = reason;
  }

  // ---------------------------------------------------------------------
  // Badges
  //
  // The session works out which badges a message has, their kinds, titles
  // and order, and which are hidden; this only draws them. Hidden badges are
  // still drawn (just not displayed), so a kind switched back on comes back
  // on the messages already there.
  //
  // A drawn badge arrives as a small SVG document. Its shapes are read back
  // out of it - once per distinct drawing - and built with createElementNS,
  // the same nodes the page has always made, rather than handing the markup
  // to an HTML or XML parser. The session writes that markup in one fixed
  // form (one level of shapes, double-quoted attributes, escaped values), so
  // reading it needs nothing more than the two patterns below.
  // ---------------------------------------------------------------------

  const badgeKeys = new WeakMap(); // badge element -> its key in the row
  const svgDrawings = new Map(); // svg markup -> {viewBox, shapes: [[tag, [[name, value]], text?]]}
  const SVG_SHAPE = /<(\w+)((?:\s+[\w:-]+="[^"]*")*)\s*(?:\/>|>([^<]*)<\/\1>)/g;
  const SVG_ATTR = /([\w:-]+)="([^"]*)"/g;
  const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"' };
  const unescapeXml = (text) => text.replace(/&(amp|lt|gt|quot);/g, (_, name) => XML_ENTITIES[name]);

  function svgDrawing(markup) {
    let drawing = svgDrawings.get(markup);
    if (drawing) return drawing;
    const open = /^<svg\b[^>]*>/.exec(markup);
    const viewBox = open && /viewBox="([^"]*)"/.exec(open[0]);
    const inner = markup.slice(open ? open[0].length : 0).replace(/<\/svg>\s*$/, '');
    const shapes = [];
    for (const m of inner.matchAll(SVG_SHAPE)) {
      const attrs = [...m[2].matchAll(SVG_ATTR)].map((a) => [a[1], unescapeXml(a[2])]);
      shapes.push([m[1], attrs, m[3] === undefined ? undefined : unescapeXml(m[3])]);
    }
    drawing = { viewBox: viewBox ? unescapeXml(viewBox[1]) : '0 0 16 16', shapes };
    svgDrawings.set(markup, drawing);
    return drawing;
  }

  function svgBadge(markup, title) {
    const drawing = svgDrawing(markup);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', drawing.viewBox);
    svg.setAttribute('class', 'badge');
    svg.setAttribute('role', 'img');
    if (title) {
      const t = document.createElementNS(SVG_NS, 'title');
      t.textContent = title;
      svg.appendChild(t);
    }
    for (const [tag, attrs, text] of drawing.shapes) {
      const shape = document.createElementNS(SVG_NS, tag);
      for (const [name, value] of attrs) shape.setAttribute(name, value);
      if (text !== undefined) shape.textContent = text;
      svg.appendChild(shape);
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

  function badgeEl(badge) {
    const node = badge.svg ? svgBadge(badge.svg, badge.title) : imgBadge(badge.image, badge.title);
    node.dataset.kind = badge.kind;
    node.toggleAttribute('hidden', badge.hidden);
    badgeKeys.set(node, badge.key);
    return node;
  }

  function isBadgeHidden(kind) {
    return settings.hiddenBadges.includes(kind);
  }

  function renderBadges(badges) {
    const wrap = document.createElement('span');
    wrap.className = 'badges';
    for (const badge of badges) wrap.appendChild(badgeEl(badge));
    return wrap;
  }

  // The viewer moved or hid a kind: the same badge elements, shown or hidden
  // and put in the new order, rather than drawn again.
  function patchBadges(row, badges) {
    const wrap = row.querySelector('.badges');
    if (!wrap) return;
    const byKey = new Map();
    for (const node of wrap.children) byKey.set(badgeKeys.get(node), node);
    const ordered = badges.map((badge) => {
      const node = byKey.get(badge.key) || badgeEl(badge);
      node.toggleAttribute('hidden', badge.hidden);
      return node;
    });
    const current = [...wrap.children];
    if (ordered.length === current.length && ordered.every((node, at) => node === current[at])) return;
    wrap.append(...ordered);
  }

  // ---------------------------------------------------------------------
  // Message content
  //
  // Parts come from the session (or session.parts() for text this page draws
  // on its own), built here as safe DOM nodes - text nodes and <img> elements
  // - rather than via innerHTML: chat content is untrusted, attacker-
  // controllable input (any Kick user can type it), so it must never be
  // parsed as HTML.
  //
  // An "@word" is a mention candidate, only styled as a mention - green, and
  // clickable for a user card - once the session says the name is a real
  // user, either straight away or later with a `verify`.
  // ---------------------------------------------------------------------

  function renderParts(container, parts) {
    for (const part of parts) {
      if (part.t === 'text') {
        container.appendChild(document.createTextNode(part.text));
        continue;
      }
      if (part.t === 'mention') {
        const tag = document.createElement('span');
        tag.className = 'mention-candidate';
        tag.dataset.name = part.key;
        tag.textContent = `@${part.name}`;
        if (part.verified) tag.classList.add('mention');
        container.appendChild(tag);
        continue;
      }
      if (part.t !== 'emote') continue;
      const img = document.createElement('img');
      img.className = 'emote';
      img.src = part.url;
      img.alt = part.name;
      img.title = part.name;
      if (part.count === 1) {
        container.appendChild(img);
        continue;
      }
      // One emote spammed back to back: drawn once, with its count beside it
      // combo-style. Wrapped together so the count can never wrap onto a line
      // of its own, away from its emote.
      const combo = el('span', 'emote-combo');
      combo.appendChild(img);
      combo.appendChild(el('span', 'combo-count', `×${part.count}`));
      container.appendChild(combo);
    }
  }

  function appendMessageContent(container, content) {
    renderParts(container, session.parts(content));
  }

  // Candidates live in the message list, the pinned banner and the user card,
  // so the whole document is searched - and the rows still queued for the
  // next frame, which are not in it yet. The session says this once per name,
  // so a row that missed it would stay unverified for good. Keys only ever
  // hold word characters and hyphens, so the name is always safe in a
  // selector.
  function markMentionsVerified(key) {
    const selector = `.mention-candidate[data-name="${key}"]`;
    for (const node of document.querySelectorAll(selector)) node.classList.add('mention');
    for (const row of pendingRows) {
      for (const node of row.querySelectorAll(selector)) node.classList.add('mention');
    }
  }

  function renderReply(reply) {
    const line = document.createElement('div');
    line.className = 'reply';
    // Full original text for the hover tooltip when the line is truncated.
    line.dataset.full = reply.text;
    line.dataset.user = reply.username || '?';
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '↩';
    line.appendChild(arrow);
    line.append('Replying to ');
    const user = document.createElement('span');
    user.className = 'user';
    user.textContent = `@${reply.username || '?'}`;
    line.appendChild(user);
    line.append(': ');
    renderParts(line, reply.parts);
    return line;
  }

  function messageRow(msg) {
    const row = document.createElement('div');
    row.className = 'msg';
    row.dataset.id = msg.msgId;
    row.dataset.user = msg.user;
    row.dataset.text = msg.text;
    // Replying needs the sender exactly as Kick spells them, where data-user
    // is lowercased for matching, and their numeric id. Both are only set
    // when there is something to set: the reply button reads them, so a row
    // without them offers no button rather than a broken one.
    if (msg.username) row.dataset.username = msg.username;
    if (msg.senderId != null) row.dataset.senderId = String(msg.senderId);
    if (msg.mentionsMe) row.classList.add('mentions-me');

    if (msg.reply) row.appendChild(renderReply(msg.reply));

    const ts = document.createElement('span');
    ts.className = 'ts';
    if (msg.createdAt) {
      ts.dataset.time = msg.createdAt;
      ts.textContent = formatTime(msg.createdAt);
    }
    row.appendChild(ts);

    row.appendChild(renderBadges(msg.badges));

    const user = document.createElement('span');
    user.className = 'user';
    user.textContent = msg.username;
    if (msg.kickColor) user.dataset.kickColor = msg.kickColor;
    user.style.color = msg.color;
    row.appendChild(user);

    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = ': ';
    row.appendChild(sep);

    const body = document.createElement('span');
    body.className = 'content';
    renderParts(body, msg.parts);
    row.appendChild(body);

    const tag = document.createElement('span');
    tag.className = 'deleted-tag';
    row.appendChild(tag);

    // A row is sent as it stands, so a count or a deletion already on it is
    // drawn too (the session never sends one today, but the protocol allows it).
    if (msg.repeats > 1) showRepeats(row, msg.repeats);
    if (msg.deleted) markDeleted(row, msg.deleted);

    // Only where they can actually work, so ordinary viewers carry no extra
    // nodes per message. CSS reveals the bar on hover.
    // Pinning hands Kick the message back whole, so what Kick sent has to be
    // kept, not just the few fields the row carries. The session only sends
    // it while the controls are on, and it lives only as long as the row.
    if (modAvailable && msg.raw) rememberForPin(row, msg.raw);
    fitActions(row);
    return row;
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
  // Profile / follow / sub data comes from Kick's API through the session
  // (cached for a few minutes). Message history is what the session has seen
  // since it started, kept per user regardless of the on-screen history cap
  // or the repeat filter.
  // ---------------------------------------------------------------------

  const userCardEl = document.getElementById('userCard');
  // The most lines a card shows; the session keeps as many per user.
  const HISTORY_PER_USER = 25;
  let userCardRequest = 0;
  // Set while a card is open, so a message from that user can be dropped into
  // the card as it arrives rather than only being there next time it is
  // opened (the session sends those as `history` while it is watching them).
  // Cleared when the card closes or is re-rendered for someone else.
  let openUserKey = null;
  let openUserHistoryEl = null;
  let openUserCountEl = null;

  function watchUser(key) {
    openUserKey = key;
    session.watchUser(key);
  }

  // Newest first, at the top of the list under the header - the same order
  // renderUserCard lays the history out in. Kept to the per-user cap so a card
  // left open on a busy chatter does not grow without bound.
  function appendOpenCardMessage(entry, total) {
    if (userCardEl.hidden || !openUserHistoryEl) return;
    const none = openUserHistoryEl.querySelector('.none');
    if (none) none.remove();
    const header = openUserHistoryEl.querySelector('.k');
    openUserHistoryEl.insertBefore(userHistoryLine(entry), header ? header.nextSibling : null);
    const lines = openUserHistoryEl.querySelectorAll('.line');
    for (let i = HISTORY_PER_USER; i < lines.length; i += 1) lines[i].remove();
    if (openUserCountEl) openUserCountEl.textContent = String(total);
  }

  function userHistoryLine(entry) {
    const line = el('div', 'line');
    line.appendChild(el('span', 't', timeOnly(entry.createdAt)));
    const c = el('span', 'c');
    renderParts(c, entry.parts);
    line.appendChild(c);
    return line;
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
    watchUser(null);
    openUserHistoryEl = null;
    openUserCountEl = null;
  }

  // `card` is the session's card data (docs/core-protocol.md), or null when
  // Kick could not be asked.
  function renderUserCard(username, card) {
    userCardEl.replaceChildren();
    watchUser(username.toLowerCase());
    openUserCountEl = null;
    // Newest first. Read once, for the count and the lines alike.
    const lines = session.userHistory(openUserKey);

    const head = el('div', 'uc-head');
    const avatar = document.createElement('img');
    avatar.className = 'uc-avatar';
    avatar.alt = '';
    if (card && card.profilePic) avatar.src = card.profilePic;
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
    if (card && card.followers != null) {
      who.appendChild(el('div', 'uc-followers', `${Number(card.followers).toLocaleString()} followers`));
    }
    const flags = [];
    if (card && card.isChannelOwner) flags.push('Broadcaster');
    if (card && card.isModerator) flags.push('Moderator');
    if (card && card.isStaff) flags.push('Kick staff');
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
      const months = card.subscribedFor;
      facts.appendChild(fact('Subscribed for', months ? `${months} month${months === 1 ? '' : 's'}` : 'Not subscribed'));
      facts.appendChild(fact('Followed', card.followingSince ? formatDate(card.followingSince) : 'Not following'));
      facts.appendChild(fact('Joined on', card.createdAt ? formatDate(card.createdAt) : '—'));
      const countFact = fact('Messages here', String(lines.length));
      openUserCountEl = countFact.querySelector('.v');
      facts.appendChild(countFact);
      userCardEl.appendChild(facts);

      // The card shows every badge the user has, whatever the chat filter
      // hides: the session sends none of them hidden.
      const badges = renderBadges(card.badges);
      badges.className = 'uc-badges';
      userCardEl.appendChild(badges);

      if (card.bio) userCardEl.appendChild(el('div', 'uc-bio', card.bio));
    }

    if (modAvailable) userCardEl.appendChild(renderModTools((card && card.username) || username, card));

    const history = el('div', 'uc-history');
    history.appendChild(el('div', 'k', 'Recent messages'));
    if (!lines.length) {
      history.appendChild(el('div', 'none', 'Nothing since this page was opened.'));
    }
    for (const m of lines) history.appendChild(userHistoryLine(m));
    userCardEl.appendChild(history);
    // Kept so a message arriving while the card is open lands in this list.
    openUserHistoryEl = history;
  }

  function showUserCardStatus(username, text, isError) {
    userCardEl.replaceChildren();
    // No live history element while loading; renderUserCard sets these again.
    watchUser(null);
    openUserHistoryEl = null;
    openUserCountEl = null;
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
    // A card fetched in the last few minutes is drawn at once, with no
    // "Loading..." in between.
    const cached = session.cachedUserCard(key);
    if (cached) {
      renderUserCard(username, cached);
      placeUserCard(x, y);
      return;
    }

    showUserCardStatus(username, 'Loading...');
    placeUserCard(x, y);

    const { card, error: failure } = await session.userCard(username);
    const error = failure === 'not_found'
      ? 'Kick has no record of this user in this chat.'
      : 'Could not load this user right now.';

    // A newer click (or a close) happened while we were fetching.
    if (requestId !== userCardRequest || userCardEl.hidden) return;

    if (card) {
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
  // Moderation (only inside the KickPlus extension)
  //
  // This page cannot moderate anything by itself: it is on another origin
  // from kick.com, so it has no session to act with, and that is the property
  // that makes it safe to open anywhere. Inside the extension, though, the
  // page framing it is kick.com itself, and the extension will act on the
  // viewer's behalf. So the controls are offered only when a handshake with
  // that parent answers. On betterchat.tech, or in an OBS overlay, nothing
  // answers and nothing appears.
  // ---------------------------------------------------------------------

  const MOD_CHANNEL = 'bck-mod';
  const MOD_PARENT_ORIGIN = 'https://kick.com';
  const MOD_TIMEOUT_MS = 10000;
  const modPending = new Map();
  let modAvailable = false;
  let replyAvailable = false;
  let modRequests = 0;

  function askParent(payload) {
    if (window.parent === window) return Promise.resolve(null);
    const id = `m${++modRequests}`;
    return new Promise((resolve) => {
      modPending.set(id, resolve);
      window.parent.postMessage({ channel: MOD_CHANNEL, id, ...payload }, MOD_PARENT_ORIGIN);
      setTimeout(() => {
        if (modPending.delete(id)) resolve(null);
      }, MOD_TIMEOUT_MS);
    });
  }

  window.addEventListener('message', (e) => {
    if (e.origin !== MOD_PARENT_ORIGIN || e.source !== window.parent) return;
    const msg = e.data;
    if (!msg || msg.channel !== MOD_CHANNEL || typeof msg.id !== 'string') return;
    // The extension also speaks without being asked: a reply can be dropped
    // or fail long after the request that armed it was answered. Those carry
    // their type as the id, so they are handled before the lookup below -
    // nothing is waiting on them.
    if (msg.type === 'reply-state') {
      showReplyArmed(msg.state);
      return;
    }
    if (msg.type === 'reply-failed') {
      replyFailed(msg);
      return;
    }
    const resolve = modPending.get(msg.id);
    if (!resolve) return;
    modPending.delete(msg.id);
    resolve(msg);
  });

  // Only the body classes. Backfilling the buttons onto rows already drawn is
  // restyleRows' job, so that stays one walk of the list rather than two.
  function applyModerationState() {
    document.body.classList.toggle('can-moderate', modAvailable);
    document.body.classList.toggle('can-reply', replyAvailable);
    // Pinning hands Kick back the whole message, so while the controls are
    // on the session sends it with each new row.
    session.setIncludeRaw(modAvailable);
  }

  async function initModeration() {
    if (overlayMode || window.parent === window) return;
    const reply = await parentHello;
    // The extension asks Kick outright - /channels/<slug>/me carries
    // is_moderator, is_broadcaster and is_super_admin - so this is whether
    // this account can moderate this channel, not merely whether it is signed
    // in. There is nothing for the viewer to choose: someone who cannot
    // moderate has no controls to turn off, and someone who can wants them.
    modAvailable = !!(reply && reply.available);
    // Replying is a separate permission from moderating: anyone signed in can
    // reply, and it needs a message box on the Kick page to type into, which
    // the extension answers for. An older extension says nothing here, so it
    // gets no reply button rather than a broken one.
    replyAvailable = !!(reply && reply.canReply);
    applyModerationState();
    // The handshake can land after the first messages are on screen.
    restyleRows();
    if (reply && reply.reply) showReplyArmed(reply.reply);
    adoptParentSettings(reply);
  }

  // The extension is the home for these now, if it says it can be. A link's
  // settings are still the link's: it overrides whatever is stored and saves
  // nothing, which is as true of the extension's copy as of this page's.
  function adoptParentSettings(reply) {
    handshakeSettled = true;
    if (!reply || !reply.storesSettings || settingsFromUrlOnly) {
      // Nothing is holding them, so the banner this was waiting on can ask.
      applySettings();
      return;
    }
    settingsHeldByParent = true;
    if (reply.settings) {
      settings = sanitize(reply.settings);
      syncPanel();
      applySettings();
    } else {
      // First run against an extension that stores them: what this page has
      // is what there is, so it goes up rather than being thrown away. On a
      // browser that has been discarding this page's storage there will be
      // nothing here to send, which is the whole complaint.
      saveSettings();
      applySettings();
    }
  }

  // Success needs no announcement: Kick broadcasts the ban or the deletion,
  // and this page already draws those. Only failure has to be said out loud.
  async function moderate(payload, describe) {
    if (!modAvailable) return false;
    const reply = await askParent({ type: 'action', ...payload });
    if (reply && reply.ok) return true;

    session.note(`could not ${describe}: ${(reply && reply.error) || 'the extension did not answer'}`, true);
    if (reply && reply.status === 403) {
      // Not a moderator here. Stop offering controls that cannot work, and
      // take the setting away with them - there is nothing to configure.
      modAvailable = false;
      applyModerationState();
      closeUserCard();
    }
    return false;
  }

  function modButton(label, title, className) {
    const btn = el('button', className || 'uc-mod-btn', label);
    btn.type = 'button';
    btn.title = title;
    return btn;
  }

  // Timeout lengths, in minutes, matching the ones Kick's own menu offers.
  const TIMEOUT_CHOICES = [
    ['1m', 1], ['5m', 5], ['15m', 15], ['1h', 60], ['1d', 1440],
  ];

  function renderModTools(username, card) {
    const wrap = el('div', 'uc-mod');
    // Who is banned or timed out right now, as the session has seen it. Kick's
    // user card is cached for a few minutes on both sides, so straight after a
    // moderator acts that is the only source that is already right - and a
    // timeout has to offer Unban just as a ban does.
    const banned = !!(card && card.banned) || session.isBanned(username);

    if (banned) {
      const unban = modButton('Unban', `Lift the ban on ${username}`, 'uc-mod-btn danger');
      unban.addEventListener('click', async () => {
        unban.disabled = true;
        const ok = await moderate({ action: 'unban', username }, `unban ${username}`);
        if (ok) closeUserCard();
        else unban.disabled = false;
      });
      wrap.appendChild(unban);
      return wrap;
    }

    wrap.appendChild(el('span', 'uc-mod-label', 'Timeout'));
    for (const [label, minutes] of TIMEOUT_CHOICES) {
      const btn = modButton(label, `Time ${username} out for ${label}`);
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        const ok = await moderate(
          { action: 'timeout', username, duration: minutes },
          `time ${username} out`
        );
        if (ok) closeUserCard();
        else btn.disabled = false;
      });
      wrap.appendChild(btn);
    }

    const ban = modButton('Ban', `Ban ${username} permanently`, 'uc-mod-btn danger');
    ban.addEventListener('click', async () => {
      ban.disabled = true;
      const ok = await moderate({ action: 'ban', username }, `ban ${username}`);
      if (ok) closeUserCard();
      else ban.disabled = false;
    });
    wrap.appendChild(ban);
    return wrap;
  }

  // One delegated handler rather than a listener per message.
  messagesEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.mod-delete');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const row = btn.closest('.msg');
    if (!row || !row.dataset.id) return;
    btn.disabled = true;
    moderate({ action: 'delete', messageId: row.dataset.id }, 'delete that message').then((ok) => {
      if (!ok) btn.disabled = false;
    });
  });

  function deleteButton() {
    const btn = el('button', 'mod-delete', '×');
    btn.type = 'button';
    btn.title = 'Delete this message';
    btn.setAttribute('aria-label', 'Delete this message');
    return btn;
  }

  // ---------------------------------------------------------------------
  // The per-message bar
  //
  // Reply, pin and delete live in one floating bar above the message rather
  // than as buttons laid over it: hovering a message is how you read the
  // thing you are about to act on, so the controls sit clear of the words.
  //
  // Which buttons belong there changes after a row is drawn - the extension's
  // handshake lands late, and the moderation setting can be switched at any
  // time - so this is written to be run again on a row it has already built.
  // It adds what is missing, removes what no longer applies, and drops the
  // bar entirely when nothing is left, so an ordinary viewer carries no extra
  // node per message. CSS orders the buttons, so they need not be added in
  // any particular order.
  // ---------------------------------------------------------------------

  function fitActions(row) {
    const wanted = [];
    if (replyAvailable && canReplyTo(row)) wanted.push(['msg-reply', replyButton]);
    // Wherever the chat is read, and so the one button that gives every
    // message a bar - including on betterchat.tech with no extension at all.
    if (row.dataset.text) wanted.push(['msg-copy', copyButton]);
    if (modAvailable && row.dataset.id) {
      // Pinning needs the whole message, and a row drawn before the controls
      // were on was never kept with one. Those can still be replied to and
      // deleted; the next message along is pinnable.
      if (pinnable.has(row)) wanted.push(['mod-pin', pinButton]);
      wanted.push(['mod-delete', deleteButton]);
    }

    let bar = row.querySelector(':scope > .msg-actions');
    if (!wanted.length) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = el('div', 'msg-actions');
      row.appendChild(bar);
    }
    const keep = new Set(wanted.map(([name]) => name));
    for (const btn of [...bar.children]) {
      if (!keep.has(btn.className)) btn.remove();
    }
    for (const [name, build] of wanted) {
      if (!bar.querySelector(`:scope > .${name}`)) bar.appendChild(build());
    }
  }

  // ---------------------------------------------------------------------
  // Pinning
  //
  // Kick's pin call takes the whole message back - sender, badges and all -
  // and hands that to every viewer as the banner. So what is sent has to be
  // the message as Kick gave it, not the few fields a row carries: a message
  // pinned with its badges thinned out would show everyone the thin version.
  //
  // The messages are held against their rows in a WeakMap, so trimming the
  // list is what frees them; nothing here has to be pruned.
  // ---------------------------------------------------------------------

  const pinnable = new WeakMap(); // row -> the message Kick sent

  function rememberForPin(row, msg) {
    pinnable.set(row, msg);
  }

  // Kick's own default, in minutes (20 hours). Its menu offers others; one
  // button matching the default is what a moderator gets by clicking pin.
  const PIN_DURATION_MIN = 1200;

  // A drawing-pin seen side on: head, shaft, and the point going into the
  // board. Kick's own is a plus tilted 45 degrees, which reads as "add" as
  // easily as "pin"; next to a reply arrow and a cross, the shape of the
  // thing itself is what makes the button obvious without its tooltip.
  // Drawn on a 24-wide grid, which is what it was designed on.
  const PIN_BOX = '0 0 24 24';
  const PIN_PATH =
    'M16 9V4h1a1 1 0 0 0 0-2H7a1 1 0 0 0 0 2h1v5c0 1.66-1.34 3-3 3v2h5.97v7l1 1 1-1v-7H19v-2c-1.66 0-3-1.34-3-3';

  function pinButton() {
    const btn = el('button', 'mod-pin');
    btn.type = 'button';
    btn.title = 'Pin this message';
    btn.setAttribute('aria-label', 'Pin this message');
    btn.appendChild(icon([PIN_PATH], null, PIN_BOX));
    return btn;
  }

  messagesEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.mod-pin');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const row = btn.closest('.msg');
    const raw = row && pinnable.get(row);
    if (!raw) return;
    // Held only while the request is in flight, so a second click cannot send
    // a second pin, and let go however it turns out. Pinning is the one action
    // in this bar that can be taken back: delete can leave its button dead on
    // success because the message is gone for good, but a message that has
    // been pinned and then unpinned is pinnable again, and a button still
    // disabled from the first time is the only thing saying otherwise.
    btn.disabled = true;
    moderate({ action: 'pin', message: raw, duration: PIN_DURATION_MIN }, 'pin that message')
      .finally(() => {
        btn.disabled = false;
      });
  });

  // ---------------------------------------------------------------------
  // Replying (only inside the KickPlus extension)
  //
  // This page has no message box - it cannot send anything, for the same
  // reason it cannot moderate. Kick's own box is still there below the chat,
  // and that is what the viewer types in. So replying is split: the button
  // here says which message, and the extension makes the next message typed
  // into Kick's box a reply to it.
  //
  // Kick's own reply state lives in the message list this extension replaced,
  // so Kick's box knows nothing about any of this; the extension carries it
  // across and sends the reply itself.
  // ---------------------------------------------------------------------

  // Kick's own icons, so the bar reads as the same control its chat has. Both
  // are drawn rather than fetched: two paths weigh less than a request, and
  // they inherit the colour of whatever they sit in.
  const REPLY_ARROW_PATH =
    'M13.33 7.5H4.51l1.07-1.07a.83.83 0 1 0-1.17-1.18l-2.5 2.5a.83.83 0 0 0 0 1.18l2.5 2.5q.26.24.59.24t.6-.24a.83.83 0 0 0 0-1.18L4.51 9.18h8.82a2.5 2.5 0 0 1 2.5 2.5V15a.84.84 0 0 0 1.67 0v-3.33c0-2.3-1.87-4.17-4.17-4.17';
  const CROSS_PATHS = [
    'M15.83 16.67a1 1 0 0 1-.59-.25L3.58 4.77a.83.83 0 1 1 1.17-1.18l11.67 11.67a.83.83 0 0 1-.6 1.42z',
    'M4.17 16.67a.83.83 0 0 1-.6-1.42L15.25 3.58a.83.83 0 1 1 1.18 1.18L4.75 16.43a.8.8 0 0 1-.6.24z',
  ];

  function icon(paths, className, viewBox) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', viewBox || '0 0 20 20');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('aria-hidden', 'true');
    if (className) svg.setAttribute('class', className);
    for (const d of paths) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('fill', 'currentColor');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }
    return svg;
  }

  // Copying a message. Not a moderator's button and not the extension's: it
  // needs no session and nothing outside this page, so it is offered wherever
  // the chat is read - which is why fitActions always has at least this one.
  //
  // Drawn on a 24 grid like the pin; the second path is the hole in the front
  // sheet, which is a hole rather than a shape because it is wound the other
  // way round.
  const COPY_BOX = '0 0 24 24';
  const COPY_PATHS = [
    'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1z',
    'M19 5H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z'
  ];
  const TICK_PATHS = ['M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z'];

  function copyButton() {
    const btn = el('button', 'msg-copy');
    btn.type = 'button';
    btn.title = 'Copy this message';
    btn.setAttribute('aria-label', 'Copy this message');
    btn.appendChild(icon(COPY_PATHS, null, COPY_BOX));
    return btn;
  }

  // What the viewer would read, not what came down the wire: the emote tokens
  // Kick sends are turned back into the names they stand for, so a copied
  // message pastes as "nice KEKW" rather than "nice [emote:37226:KEKW]".
  function messageText(row) {
    const raw = (row && row.dataset.text) || '';
    if (!raw) return '';
    return BetterChatKick.parseContent(raw, { combine: false })
      .map((part) => (part.type === 'text' ? part.text : part.name))
      .join('');
  }

  messagesEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('.msg-copy');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const text = messageText(btn.closest('.msg'));
    if (!text) return;
    const ok = await copyText(text);
    if (!ok) return;
    // Said on the button, because the settings panel's note line is not on
    // screen when the chat is.
    clearTimeout(btn.dataset.timer);
    btn.replaceChildren(icon(TICK_PATHS, null, COPY_BOX));
    btn.classList.add('copied');
    btn.dataset.timer = setTimeout(() => {
      btn.classList.remove('copied');
      btn.replaceChildren(icon(COPY_PATHS, null, COPY_BOX));
    }, 1200);
  });

  function replyButton() {
    const btn = el('button', 'msg-reply');
    btn.type = 'button';
    btn.title = 'Reply to this message';
    btn.setAttribute('aria-label', 'Reply to this message');
    btn.appendChild(icon([REPLY_ARROW_PATH]));
    return btn;
  }

  // A row can only be replied to if it carries everything Kick's send call
  // needs. Rows drawn before the sender id was kept, and anything Kick sent
  // without one, simply get no button.
  function canReplyTo(row) {
    return !!(row && row.dataset.id && row.dataset.username && row.dataset.senderId);
  }

  messagesEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.msg-reply');
    if (!btn) return;
    e.preventDefault();
    // The username-click handler is on this same element, so without this a
    // reply would also open the user card.
    e.stopPropagation();
    const row = btn.closest('.msg');
    if (!canReplyTo(row)) return;
    armReply(row);
  });

  async function armReply(row) {
    if (!replyAvailable) return;
    const reply = await askParent({
      type: 'reply',
      message: {
        id: row.dataset.id,
        // What Kick echoes back on the reply, so it is the displayed text
        // rather than anything this page has collapsed or filtered.
        content: row.dataset.text || '',
        sender: { id: Number(row.dataset.senderId), username: row.dataset.username },
      },
    });
    if (reply && reply.ok) return;
    session.note(
      `could not reply: ${(reply && reply.error) || 'the extension did not answer'}`,
      true
    );
  }

  function cancelReply() {
    // The bar goes at once rather than waiting for the answer. The extension
    // pushes reply-state when it disarms, so this only makes it immediate;
    // if the message never arrives, that push is what puts it right.
    showReplyArmed({ armed: false });
    askParent({ type: 'reply-cancel' });
  }

  // The bar along the bottom saying what the next message will reply to.
  // Drawn from what the extension says is armed, never from the click, so it
  // cannot claim a reply the extension has already dropped - on a channel
  // switch, or once the message has gone out.
  //
  // It shows the message itself rather than a line of grey text: the same
  // name colour, badges and emotes it has in the chat above, so what is being
  // replied to is recognised at a glance instead of read.
  function showReplyArmed(state) {
    const armed = !!(state && state.armed);
    // Disarming what is already off changes nothing, and the extension says
    // so on every channel switch, so this keeps it from walking the list.
    if (!armed && replyBarEl.hidden) return;

    // The bar pads the foot of the list, so this puts the view back the way
    // the pin banner does: on the bottom when following, on the same row
    // otherwise.
    keepingView(() => {
      document.body.classList.toggle('replying', armed);
      if (!armed) {
        replyBarEl.hidden = true;
        replyBarEl.replaceChildren();
        return;
      }

      const name = state.username || '?';
      const head = el('div', 'rb-head');
      head.append(icon([REPLY_ARROW_PATH], 'rb-icon'), el('span', 'rb-title', `Replying to ${name}:`));

      const cancel = el('button', 'rb-cancel');
      cancel.type = 'button';
      cancel.title = 'Cancel this reply (Escape)';
      cancel.setAttribute('aria-label', 'Cancel this reply');
      cancel.appendChild(icon(CROSS_PATHS));
      cancel.addEventListener('click', cancelReply);

      const body = el('div', 'rb-body');
      body.append(head, replyPreview(state));
      replyBarEl.replaceChildren(body, cancel);
      replyBarEl.hidden = false;
    });
  }

  // The armed message, drawn the way the chat draws it. The row this came
  // from may already have been trimmed out of history, so it is rebuilt from
  // what the extension reported rather than looked up.
  function replyPreview(state) {
    const preview = el('div', 'rb-msg');

    const row = messagesEl.querySelector(`.msg[data-id="${cssEscape(state.messageId || '')}"]`);
    // The badges and the name colour are only on the row. Without it - trimmed
    // away, or armed before this tab opened - the name still carries, in the
    // colour every other message from them has.
    if (row) {
      const badges = row.querySelector('.badges');
      if (badges) preview.appendChild(badges.cloneNode(true));
    }

    const user = el('span', 'user', state.username || '?');
    const known = row && row.querySelector(':scope > .user');
    user.style.color = known ? known.style.color : usernameColor(null);
    preview.append(user, el('span', 'sep', ': '));

    const body = el('span', 'content');
    appendMessageContent(body, state.content || '');
    preview.appendChild(body);
    return preview;
  }

  // Message ids are uuids, so this only ever guards against a malformed one
  // reaching a selector.
  function cssEscape(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/[^\w-]/g, '');
  }

  // Kick refused the send. The message is no longer in Kick's box - it was
  // cleared as it was sent, the way Kick clears it - so the text comes back
  // here with the reason, rather than being lost.
  function replyFailed(msg) {
    showReplyArmed({ armed: false });
    const reason = msg.error || 'Kick refused it';
    const text = msg.content ? `: ${msg.content}` : '';
    session.note(`reply not sent (${reason})${text}`, true);
  }

  // Escape cancels the reply, but only once the settings panel and the user
  // card have had it: those are on top of the page, and closing what is in
  // front is what Escape is expected to do first.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || replyBarEl.hidden) return;
    if (!overlay.hidden || !userCardEl.hidden) return;
    cancelReply();
  });

  // ---------------------------------------------------------------------
  // Pinned message banner
  // ---------------------------------------------------------------------

  const pinnedEl = document.getElementById('pinned');
  const pinContent = document.getElementById('pinContent');
  const showPinBtn = document.getElementById('showPin');

  // The list's top padding follows the banner's real height, so a pin that
  // runs to several lines never sits over the first messages.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      keepingView(() => {
        document.documentElement.style.setProperty('--pin-height', `${pinnedEl.offsetHeight}px`);
      });
    }).observe(pinnedEl);
  }
  let pinnedActive = false;
  // Collapsed rather than dismissed: the pin is still live and can be brought
  // back. Set afresh by each new pin, either open or collapsed depending on
  // the collapsePinned setting, so the viewer's choice never sticks to a pin
  // they have not seen.
  let pinHidden = false;
  const unpinBtn = document.getElementById('unpinMsg');

  // A pin from the session. It also says when the pin runs out (a `pin` of
  // null), so there is no timer here.
  function showPin(pin) {
    pinContent.replaceChildren();
    const user = document.createElement('span');
    user.className = 'user';
    user.textContent = pin.username || '?';
    user.style.color = pin.color;
    pinContent.appendChild(user);
    pinContent.append(': ');
    renderParts(pinContent, pin.parts);

    pinnedActive = true;
    // Each new pin starts in the state the viewer asked for: open, or
    // collapsed to the pin button under the gear.
    pinHidden = settings.collapsePinned;
    // A new pin is a new thing to unpin, whatever became of the last one.
    unpinBtn.disabled = false;
    applyPinVisibility();
  }

  function clearPin() {
    pinnedActive = false;
    pinHidden = false;
    applyPinVisibility();
  }

  // The banner's own button hides it; the pin stays live either way, so the
  // one under the gear puts it back.
  document.getElementById('closePin').addEventListener('click', () => {
    pinHidden = true;
    applyPinVisibility();
  });

  // Unpinning takes the banner off the channel, not just this tab. Nothing is
  // cleared here on success: Kick broadcasts the removal and clearPin runs
  // from that, the same as it would for a pin someone else took down.
  unpinBtn.addEventListener('click', () => {
    unpinBtn.disabled = true;
    moderate({ action: 'unpin' }, 'unpin that message').then((ok) => {
      if (!ok) unpinBtn.disabled = false;
    });
  });

  showPinBtn.addEventListener('click', () => {
    pinHidden = false;
    applyPinVisibility();
  });

  // ---------------------------------------------------------------------
  // Connection / stream status
  //
  // Three things can make a chat go quiet, and the pill says which (the
  // session works out which, and what to say):
  //   - the WebSocket to Kick's feed is down (kick.js reconnects with backoff)
  //   - the socket is up but Kick hasn't confirmed the chat subscription
  //   - the channel simply isn't live (Kick's StreamerIsLive / StopStream
  //     events, plus the `live` flag from channel resolution)
  // ---------------------------------------------------------------------

  const statusPill = document.getElementById('statusPill');

  function showStatus(status) {
    if (status.state === 'failed') {
      // The channel could not be joined, and the line above says why.
      statusPill.hidden = true;
      return;
    }
    statusPill.textContent = status.text;
    statusPill.className = status.level;
    statusPill.hidden = !status.text;
    updateJumpPill(); // the two pills share the bottom centre
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

  // ---------------------------------------------------------------------
  // Heartbeats for the admin board's viewer count, sent to the server this
  // page came from (betterchat/main.py). Opt-in: nothing is sent until the
  // viewer has answered the banner, and one word from them stops it again.
  //
  // What goes out is a random per-tab id, the channel, how many messages this
  // tab saw since its last beat, and whether it is an embed. No account, no
  // cookies, nothing identifying. The URL is relative on purpose - in an
  // iframe it still resolves to this server, not to the site doing the
  // embedding. Sent as text/plain so neither the keepalive fetch nor
  // sendBeacon needs a preflight.
  // ---------------------------------------------------------------------

  const BEAT_INTERVAL_MS = 5 * 60 * 1000;
  // Which deployment this is. The dev instance reports to the stable board
  // rather than keeping one of its own, so a single board answers "who is
  // watching" for both, with the split shown there.
  const STABLE_ORIGIN = 'https://betterchat.tech';
  const buildName = location.hostname.startsWith('dev.') ? 'dev' : 'stable';
  // Relative for stable, on purpose: inside an iframe it still resolves to
  // this server rather than to the site doing the embedding. Dev is the one
  // case that has to name where it is going.
  const BEAT_URL = buildName === 'dev' ? STABLE_ORIGIN + '/api/beat' : '/api/beat';
  // Overlay mode is the streamer's own OBS source, not a viewer, and a page
  // opened from a file or another static server has no /api/beat to talk to.
  const beatsPossible = /^https?:$/.test(location.protocol) && !overlayMode;
  // The session counts the live messages it has drawn; each beat reports how
  // many came since the one before.
  let messagesAtLastBeat = 0;
  let beatTimer = null;
  let beatChannel = null;
  // Resolved once. sessionStorage can be unavailable (an embed in a browser
  // that blocks third-party storage), and re-rolling the id on the fallback
  // path would make every beat look like another viewer joining.
  let cachedTabId = null;

  function beatsWanted() {
    return beatsPossible && settings.stats === 'on';
  }

  function tabId() {
    if (cachedTabId) return cachedTabId;
    try {
      let id = sessionStorage.getItem('betterchat.tab');
      if (!id || !/^[a-z0-9-]{8,64}$/.test(id)) {
        const bytes = new Uint8Array(12);
        crypto.getRandomValues(bytes);
        id = 'tab-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        sessionStorage.setItem('betterchat.tab', id);
      }
      cachedTabId = id;
    } catch (_e) {
      cachedTabId = 'tab-' + Math.random().toString(16).slice(2, 14).padEnd(12, '0');
    }
    return cachedTabId;
  }

  // Callers decide whether a beat is allowed; this only sends one. That is
  // what lets opting out send its parting "leave" after the answer changed.
  function sendBeat(channelSlug, event) {
    const messagesNow = session.liveMessages();
    const body = JSON.stringify({
      tab: tabId(),
      channel: channelSlug,
      event,
      messages: messagesNow - messagesAtLastBeat,
      source: embedMode ? 'embed' : 'site',
      build: buildName,
    });
    messagesAtLastBeat = messagesNow;
    const url = BEAT_URL;
    if (event === 'leave' && navigator.sendBeacon) {
      navigator.sendBeacon(url, body); // a string body is sent as text/plain
      return;
    }
    fetch(url, { method: 'POST', body, keepalive: true, headers: { 'content-type': 'text/plain' } }).catch(() => {});
  }

  // Starts, stops, or leaves things alone, from the current answer. Called on
  // connect and again whenever the settings change.
  function applyBeats() {
    const wanted = beatsWanted() && !!beatChannel;
    if (wanted && !beatTimer) {
      sendBeat(beatChannel, 'join');
      beatTimer = setInterval(() => sendBeat(beatChannel, 'beat'), BEAT_INTERVAL_MS);
    } else if (!wanted && beatTimer) {
      clearInterval(beatTimer);
      beatTimer = null;
      // Say goodbye so opting out drops this tab from the count now, rather
      // than leaving it there until the session times out.
      if (beatChannel) sendBeat(beatChannel, 'leave');
    }
  }

  function startBeats(channelSlug) {
    beatChannel = channelSlug;
    applyBeats();
  }

  window.addEventListener('pagehide', () => {
    if (beatTimer && beatChannel) sendBeat(beatChannel, 'leave');
  });

  // ---- The consent banner ---------------------------------------------

  const consentEl = document.getElementById('consent');

  function answerConsent(answer) {
    consentEl.hidden = true;
    replaceSettings({ ...settings, stats: answer });
  }

  document.getElementById('consentYes').addEventListener('click', () => answerConsent('on'));
  document.getElementById('consentNo').addEventListener('click', () => answerConsent('off'));

  // Framed, the answer may already be stored in the extension and on its way
  // here. Asking before it lands would show the banner for the length of a
  // round trip to someone who answered it weeks ago.
  let handshakeSettled = window.parent === window || overlayMode;

  function showConsentIfUnanswered() {
    // Nothing to ask about where nothing could be sent anyway, and nothing to
    // ask yet while the answer might be arriving.
    consentEl.hidden = !(beatsPossible && handshakeSettled && settings.stats === 'ask');
  }

  // ---------------------------------------------------------------------
  // The chat feed's socket
  //
  // Kick's realtime server only takes connections from kick.com. Opened on
  // its own, this page reads the feed through this origin's /realtime relay.
  // Inside KickPlus the page framing it is kick.com, and the extension holds
  // that connection itself and speaks the relay's frames over postMessage -
  // so the chat does not go through betterchat.tech at all there. Which one
  // is decided by the extension's answer to the handshake, which says `feed`
  // when it can; an older extension does not, and gets the relay.
  // ---------------------------------------------------------------------

  const FEED_CHANNEL = 'bck-feed';

  // Asked once, for the moderation controls and the feed both. Framed by a
  // page that is plainly not kick.com, nobody will answer, and the feed is
  // not held up for the ten seconds it would take to give up.
  const parentHello = (() => {
    if (overlayMode || window.parent === window) return Promise.resolve(null);
    const ancestors = location.ancestorOrigins;
    if (ancestors && ancestors.length && ancestors[0] !== MOD_PARENT_ORIGIN) return Promise.resolve(null);
    return askParent({ type: 'hello' });
  })();

  const parentFeeds = new Map(); // sid -> ParentFeedSocket
  let parentFeedCount = 0;

  window.addEventListener('message', (e) => {
    if (e.origin !== MOD_PARENT_ORIGIN || e.source !== window.parent) return;
    const msg = e.data;
    if (!msg || msg.channel !== FEED_CHANNEL || typeof msg.sid !== 'string') return;
    const socket = parentFeeds.get(msg.sid);
    if (socket) socket.receive(msg);
  });

  // The extension's side of a feed, shaped like the WebSocket core.js expects.
  class ParentFeedSocket {
    constructor(url) {
      this.readyState = 0;
      this.sid = `f${++parentFeedCount}`;
      parentFeeds.set(this.sid, this);
      const query = new URL(url, location.href).searchParams;
      this.post({
        type: 'open',
        chatroomId: Number(query.get('chatroom')) || null,
        channelId: Number(query.get('channel')) || null,
      });
    }

    post(payload) {
      window.parent.postMessage({ channel: FEED_CHANNEL, sid: this.sid, ...payload }, MOD_PARENT_ORIGIN);
    }

    receive(msg) {
      if (this.readyState === 3) return;
      if (msg.type === 'frame' && typeof msg.data === 'string') {
        if (this.readyState === 0) {
          this.readyState = 1;
          if (this.onopen) this.onopen({});
        }
        if (this.onmessage) this.onmessage({ data: msg.data });
      } else if (msg.type === 'closed') {
        this.finish();
      }
    }

    send(text) {
      if (this.readyState === 1) this.post({ type: 'send', data: String(text) });
    }

    close() {
      if (this.readyState === 3) return;
      this.post({ type: 'close' });
      this.finish();
    }

    finish() {
      this.readyState = 3;
      parentFeeds.delete(this.sid);
      if (this.onclose) this.onclose({ code: 1000 });
    }
  }

  // What core.js is handed: a socket that becomes the extension's or the
  // relay's once the handshake has said which.
  class FeedSocket {
    constructor(url) {
      this.readyState = 0;
      this.inner = null;
      parentHello.then((reply) => {
        if (this.closing) return;
        const Inner = reply && reply.feed ? ParentFeedSocket : WebSocket;
        let inner;
        try {
          inner = new Inner(url);
        } catch (_e) {
          this.finish();
          return;
        }
        this.inner = inner;
        inner.onopen = (e) => {
          this.readyState = 1;
          if (this.onopen) this.onopen(e);
        };
        inner.onmessage = (e) => {
          if (this.onmessage) this.onmessage(e);
        };
        inner.onerror = (e) => {
          if (this.onerror) this.onerror(e);
        };
        inner.onclose = () => this.finish();
      });
    }

    send(text) {
      if (this.inner && this.readyState === 1) this.inner.send(text);
    }

    close() {
      if (this.closing) return;
      this.closing = true;
      if (this.inner) this.inner.close();
      else setTimeout(() => this.finish(), 0);
    }

    finish() {
      if (this.readyState === 3) return;
      this.closing = true;
      this.readyState = 3;
      if (this.onclose) this.onclose({ code: 1000 });
    }
  }

  // ---------------------------------------------------------------------
  // The chat session (core.js): joining the channel, Kick's feed, and every
  // decision about what is shown. This page hands it the browser's own fetch
  // and timers and the feed socket above, and draws what it sends.
  // ---------------------------------------------------------------------

  const session = BetterChatCore.createChatSession({
    slug,
    settings,
    overlay: overlayMode,
    config: CONFIG,
    host: {
      fetch: (url, init) => fetch(url, init),
      WebSocket: FeedSocket,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (id) => clearTimeout(id),
      now: () => Date.now(),
    },
    onOps: applyOps,
    onUnknown: (name, data) => {
      if (query.has('debug')) console.debug('unhandled Kick event', name, data);
    },
  });

  function watch(channelSlug) {
    document.title = `${channelSlug} - BetterChat`;
    session.start();
    window.addEventListener('beforeunload', () => session.stop());
  }

  // Service worker: caches the shell and scripts so the page still loads
  // when this origin is down. The chat itself only needs kick.com, so a
  // cached load is a fully working one - see site/sw.js. Allowed on https
  // and on localhost, which is where the API permits it.
  if (
    'serviceWorker' in navigator &&
    (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))
  ) {
    const register = () => navigator.serviceWorker.register('/sw.js').catch(() => {});
    // This code runs once defaults.json is in, which can be after the load
    // event has already fired.
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register);
  }

  document.body.classList.toggle('overlay', overlayMode);
  applySettings();
  initModeration();
  if (slug) watch(slug);
  else showHint();
}, function (err) {
  // Without defaults.json there are no settings to start from. Say so on the
  // page, where whoever just edited that file is looking, and not only in the
  // console.
  console.error(err);
  const line = document.createElement('div');
  line.className = 'system error';
  line.textContent = `BetterChat could not start: ${(err && err.message) || err}`;
  document.getElementById('messages').appendChild(line);
});
