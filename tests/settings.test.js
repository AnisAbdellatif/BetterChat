'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../site/settings.js');

test('sanitize: rubbish in, a usable settings object out', () => {
  assert.deepEqual(S.sanitize(null), S.sanitize({}), 'no input is the defaults');

  const s = S.sanitize({
    fontSize: 999,          // clamped
    messageGap: -5,         // clamped
    fontFamily: 'nonsense', // not an offered stack
    timestampFormat: 'iso', // not an option
    deletedMessages: 'burn',
    dedupeMode: 'shout',
    bgColor: 'red',         // not a hex triple
    monocolorValue: '#ABCDEF',
    mentionMe: '@Some.User!!',
    unknownKey: 'dropped',
  });

  assert.equal(s.fontSize, 40);
  assert.equal(s.messageGap, 0);
  assert.equal(s.fontFamily, S.DEFAULTS.fontFamily);
  assert.equal(s.timestampFormat, S.DEFAULTS.timestampFormat);
  assert.equal(s.deletedMessages, S.DEFAULTS.deletedMessages);
  assert.equal(s.dedupeMode, S.DEFAULTS.dedupeMode);
  assert.equal(s.bgColor, S.DEFAULTS.bgColor, 'a bad colour keeps the default');
  assert.equal(s.monocolorValue, '#abcdef', 'a good one is lowercased');
  assert.equal(s.mentionMe, 'SomeUser', 'the @ and punctuation go');
  assert.equal('unknownKey' in s, false);
});

test('sanitize: badgeOrder always comes back a full permutation', () => {
  const fromNothing = S.sanitize({}).badgeOrder;
  assert.deepEqual(fromNothing, S.DEFAULTS.badgeOrder, 'no order stored -> the default one');

  // Stale, short, duplicated and junk entries all have to survive a reload.
  const messy = S.sanitize({ badgeOrder: ['vip', 'vip', 'nope', 42, null, 'level'] }).badgeOrder;
  assert.equal(messy.length, S.BADGE_KINDS.length);
  assert.equal(new Set(messy).size, S.BADGE_KINDS.length, 'no duplicates');
  assert.deepEqual(messy.slice(0, 2), ['vip', 'level'], 'what was named keeps its order');
  for (const kind of S.BADGE_KINDS) assert.ok(messy.includes(kind), `${kind} is still there`);

  // A viewer's own full order is left exactly as they arranged it.
  const mine = [...S.BADGE_KINDS].reverse();
  assert.deepEqual(S.sanitize({ badgeOrder: mine }).badgeOrder, mine);
});

test('sanitize: hiddenBadges keeps only real kinds', () => {
  const s = S.sanitize({ hiddenBadges: ['level', 'made-up', 'vip'] });
  assert.deepEqual(s.hiddenBadges, ['vip', 'level'], 'in BADGE_KINDS order, unknowns dropped');
});

test('sanitize: the stats answer is three-state, not a boolean', () => {
  assert.equal(S.sanitize({}).stats, 'ask', 'unanswered by default');
  assert.equal(S.sanitize({ stats: 'on' }).stats, 'on');
  assert.equal(S.sanitize({ stats: 'off' }).stats, 'off');
  assert.equal(S.sanitize({ stats: 'yes' }).stats, 'ask', 'anything else is still unanswered');
});

test('consent never travels: not in a link, not in an export', () => {
  assert.ok(S.NOT_SHAREABLE.has('stats'));

  // Out: a settings link carries the differences, but never the answer.
  const params = S.settingsAsParams({ ...S.DEFAULTS, fontSize: 22, stats: 'on' });
  assert.equal(params.get('fontSize'), '22');
  assert.equal(params.has('stats'), false);

  // In: a link that names it anyway is ignored.
  const fromUrl = S.settingsFromQuery(new URLSearchParams('fontSize=22&stats=on'));
  assert.equal(fromUrl.fontSize, 22);
  assert.equal('stats' in fromUrl, false);
});

test('settingsAsParams: only what differs, in the shapes the URL uses', () => {
  assert.equal([...S.settingsAsParams({ ...S.DEFAULTS })].length, 0, 'defaults produce no query');

  const params = S.settingsAsParams({
    ...S.DEFAULTS,
    monocolor: true,
    timestamps: false,
    hiddenBadges: ['level', 'event'],
  });
  assert.equal(params.get('monocolor'), '1', 'booleans as 1/0');
  assert.equal(params.has('timestamps'), false, 'unchanged booleans stay out');
  assert.equal(params.get('hiddenBadges'), 'level,event', 'arrays comma-separated');
});

test('settingsFromQuery: parses by the type of the default', () => {
  const out = S.settingsFromQuery(
    new URLSearchParams('fontSize=16&monocolor=on&scrollback=0&hiddenBadges=level,+event&nope=1')
  );
  assert.equal(out.fontSize, 16, 'numbers');
  assert.equal(out.monocolor, true, '1/true/on all mean true');
  assert.equal(out.scrollback, false);
  assert.deepEqual(out.hiddenBadges, ['level', 'event'], 'trimmed, empties dropped');
  assert.equal('nope' in out, false, 'unknown parameters are not settings');
});

test('fontFamilyCss: a preset, or a cleaned custom name with a fallback', () => {
  assert.equal(S.fontFamilyCss({ fontFamily: 'mono' }), S.FONT_STACKS.mono);
  // The system stack is the fallback everywhere here, not the default
  // setting: whatever went wrong, something universally installed is safe.
  assert.equal(
    S.fontFamilyCss({ fontFamily: 'nonsense' }),
    S.FONT_STACKS.system,
    'an unknown key falls back rather than emitting nothing'
  );
  assert.equal(
    S.fontFamilyCss({ fontFamily: 'custom', customFont: '' }),
    S.FONT_STACKS.system,
    'so does "custom" with nothing typed in'
  );

  const custom = S.fontFamilyCss({ fontFamily: 'custom', customFont: 'Comic Neue' });
  assert.match(custom, /Comic Neue/);
  assert.ok(custom.includes(','), 'a custom font still has something to fall back to');

  // The name lands inside a CSS value, so it must not be able to close it.
  // Cleaning happens in sanitize, not here, so this goes the whole way round
  // rather than handing fontFamilyCss something no caller would give it.
  const cleaned = S.sanitize({
    fontFamily: 'custom',
    customFont: 'Evil"; } body { display:none } /*',
  });
  assert.equal(/[";{}]/.test(cleaned.customFont), false, 'sanitize strips CSS punctuation');
  assert.equal(/[;{}]/.test(S.fontFamilyCss(cleaned)), false, 'so the value cannot be closed early');
});
