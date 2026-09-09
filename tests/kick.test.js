'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeMessage, normalizeEvent, buildPin, KickApi, PusherRelay, EVENTS } = require('../site/kick.js');

// Payloads captured live from chatrooms.668.v2 on 2026-09-08.
const reply = {
  chatroom_id: 668,
  content: 'no they all metagaming and sniping like leeches',
  created_at: '2026-09-08T18:45:28+00:00',
  id: 'eea9cbc0-6a36-46a2-a8da-ad38bd918c2b',
  metadata: {
    message_ref: '1788893121168',
    original_message: { content: 'are they supposed to remember', id: 'dd4156fd-3d5b-464d-9b72-15642fb9394b' },
    original_sender: { id: 20631072, username: 'Kreygasmo' },
  },
  sender: {
    id: 105312993,
    identity: {
      badges: [{ count: 39, sort_order: 9, text: 'Subscriber', type: 'subscriber' }],
      badges_v2: [
        { badge_type: 'global', image_url: 'https://ext.cdn.kick.com/chat/badges/29.png', metadata: { level: 29 }, name: 'level', selected: false, sort_order: 1 },
        { badge_type: 'global', image_url: 'https://ext.cdn.kick.com/chat/badges/founder.png', name: 'kick_founder22', selected: true, sort_order: 2 },
      ],
      color: '#FFFFFF',
    },
    slug: 'xqcs-driving-instructor',
    username: 'Xqcs_Driving_Instructor',
  },
  type: 'reply',
};

const banned = {
  id: 'a1fa57d1-4cf5-484e-8948-c0f8fc49f27e',
  user: { id: 128560582, username: 'sha6yy', slug: 'sha6yy' },
  banned_by: { id: 0, username: 'moderator', slug: 'moderator' },
  permanent: false,
  duration: 1,
  expires_at: '2026-09-08T18:29:25+00:00',
};

test('normalizeMessage: reply metadata, badges, deselected v2 badge dropped', () => {
  const m = normalizeMessage(reply);
  assert.equal(m.type, 'reply');
  assert.deepEqual(m.reply_to, {
    id: 'dd4156fd-3d5b-464d-9b72-15642fb9394b',
    username: 'Kreygasmo',
    content: 'are they supposed to remember',
  });
  assert.deepEqual(m.badges, [{ type: 'subscriber', text: 'Subscriber', count: 39, sort_order: 9 }]);
  assert.deepEqual(m.badges_v2.map((b) => b.name), ['kick_founder22']);
  assert.equal(m.color, '#FFFFFF');
});

test('normalizeMessage: malformed payloads are null, not crashes', () => {
  assert.equal(normalizeMessage(null), null);
  assert.equal(normalizeMessage({ id: 1 }), null);
  assert.equal(normalizeMessage({ id: 1, sender: { username: 'a' }, content: 5 }), null);
  const bare = normalizeMessage({ id: 7, sender: { username: 'a' }, content: 'hi' });
  assert.equal(bare.id, '7');
  assert.equal(bare.type, 'message');
  assert.equal(bare.reply_to, null);
  assert.deepEqual(bare.badges, []);
});

test('normalizeEvent: timeout and permanent ban', () => {
  assert.deepEqual(normalizeEvent(EVENTS.banned, banned), {
    type: 'user_banned',
    username: 'sha6yy',
    permanent: false,
    duration_min: 1,
    expires_at: '2026-09-08T18:29:25+00:00',
    by: 'moderator',
  });
  const perm = normalizeEvent(EVENTS.banned, { ...banned, permanent: true, duration: undefined, expires_at: undefined });
  assert.equal(perm.permanent, true);
  assert.equal(perm.duration_min, null);
});

test('normalizeEvent: deletion, clear, subs, gifts, host, live/offline, unknown', () => {
  assert.deepEqual(normalizeEvent(EVENTS.deleted, { message: { id: 'abc' } }), { type: 'message_deleted', message_id: 'abc' });
  assert.equal(normalizeEvent(EVENTS.deleted, {}), null);
  assert.deepEqual(normalizeEvent(EVENTS.cleared, {}), { type: 'chat_cleared' });
  assert.deepEqual(normalizeEvent(EVENTS.subscription, { username: 'u', months: '3' }), { type: 'subscription', username: 'u', months: 3 });
  assert.deepEqual(normalizeEvent(EVENTS.gifted, { gifter_username: 'g', gifted_usernames: ['a', 2, 'b'] }), { type: 'gifted_subs', gifter: 'g', recipients: ['a', 'b'] });
  assert.deepEqual(normalizeEvent(EVENTS.host, { host_username: 'h', number_viewers: 12, optional_message: 'hi' }), { type: 'host', host_username: 'h', viewers: 12, message: 'hi' });
  assert.deepEqual(normalizeEvent(EVENTS.live, { livestream: { session_title: 'T' } }), { type: 'stream_live', title: 'T' });
  assert.deepEqual(normalizeEvent(EVENTS.offline, {}), { type: 'stream_offline' });
  assert.equal(normalizeEvent('App\\Events\\SomethingNew', {}), null);
});

test('buildPin: minutes from the event, absolute finish_at from history', () => {
  const fromEvent = buildPin({ message: { ...reply, type: 'message' }, duration: '1200', pinnedBy: { username: 'mod' } });
  assert.equal(fromEvent.type, 'pin_created');
  assert.equal(fromEvent.duration_min, 1200);
  assert.equal(fromEvent.by, 'mod');
  const minutesAhead = (new Date(fromEvent.expires_at) - Date.now()) / 60000;
  assert.ok(minutesAhead > 1199 && minutesAhead <= 1200);

  // Shape captured from /api/v2/channels/1764849/messages on 2026-09-08.
  const fromHistory = buildPin({ duration: 1155, finish_at: '2026-09-09T14:32:47.597067Z', message: { ...reply, type: 'message' }, pinned_by: { username: 'Joshthemex' } });
  assert.equal(fromHistory.expires_at, '2026-09-09T14:32:47.597067Z');
  assert.equal(fromHistory.by, 'Joshthemex');
  assert.equal(buildPin({ message: null }), null);
});

function fakeFetch(routes) {
  return async (url) => {
    for (const [pattern, body] of routes) {
      if (url.includes(pattern)) {
        return { ok: true, status: 200, json: async () => body };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

test('KickApi.resolveChannel: shape, badge tiers sorted, live flag, cached', async () => {
  let calls = 0;
  const api = new KickApi({
    fetchImpl: async (url) => {
      calls++;
      return fakeFetch([
        ['/channels/xqc', {
          id: 668,
          chatroom: { id: 668 },
          livestream: { id: 1 },
          subscriber_badges: [
            { months: 6, badge_image: { src: 'https://x/6' } },
            { months: 1, badge_image: { src: 'https://x/1' } },
            { months: 'bad', badge_image: { src: 'https://x/bad' } },
          ],
        }],
      ])(url);
    },
  });
  const info = await api.resolveChannel('XQC ');
  assert.equal(info.slug, 'xqc');
  assert.equal(info.chatroom_id, 668);
  assert.equal(info.live, true);
  assert.deepEqual(info.subscriber_badges.map((b) => b.months), [1, 6]);
  await api.resolveChannel('xqc');
  assert.equal(calls, 1, 'second lookup served from cache');
  await assert.rejects(api.resolveChannel('nobody-here'), (e) => e.status === 404);
});

test('KickApi.pinnedAndHistory: messages oldest-first, pin normalized', async () => {
  const api = new KickApi({
    fetchImpl: fakeFetch([
      ['/channels/668/messages', {
        data: {
          messages: [
            { id: 'b', content: 'second', created_at: '2026-09-08T18:00:02+00:00', sender: { username: 'u' } },
            { id: 'a', content: 'first', created_at: '2026-09-08T18:00:01+00:00', sender: { username: 'u' } },
            { id: 'broken' },
          ],
          pinned_message: { message: { ...reply, type: 'message' }, finish_at: '2026-09-09T00:00:00Z' },
        },
      }],
    ]),
  });
  const { pinned, messages } = await api.pinnedAndHistory(668);
  assert.deepEqual(messages.map((m) => m.id), ['a', 'b']);
  assert.equal(pinned.type, 'pin_created');
  assert.equal(pinned.expires_at, '2026-09-09T00:00:00Z');
});

test('KickApi.userCard: merges both endpoints and survives a missing second one', async () => {
  const api = new KickApi({
    fetchImpl: fakeFetch([
      ['/channels/xqc/users/epicnoob', {
        id: 61289, username: 'epicnoob', slug: 'epicnoob', profile_pic: 'p', created_at: '2022-12-05T23:35:47.000000Z',
        following_since: '2023-03-30T18:55:56.000000Z', subscribed_for: 39, is_moderator: false, is_staff: false,
        is_channel_owner: false, banned: null, badges: [{ type: 'subscriber', count: 39 }], badges_v2: [],
      }],
      ['/channels/epicnoob', { followers_count: 148, verified: false, user: { bio: 'hey' } }],
    ]),
  });
  const card = await api.userCard('xqc', 'epicnoob');
  assert.equal(card.followers_count, 148);
  assert.equal(card.bio, 'hey');
  assert.equal(card.subscribed_for, 39);
  assert.deepEqual(card.badges.map((b) => b.type), ['subscriber']);

  const lonely = new KickApi({ fetchImpl: fakeFetch([['/channels/xqc/users/ghost', { id: 1, username: 'ghost', slug: 'ghost', badges: [], badges_v2: [] }]]) });
  const ghost = await lonely.userCard('xqc', 'ghost');
  assert.equal(ghost.followers_count, null);
});

test('PusherRelay: handshake subscribes to both channels and routes frames', () => {
  const sent = [];
  const messages = [];
  const events = [];
  const subscribed = [];
  const relay = new PusherRelay({
    appKey: 'k', cluster: 'us2', chatroomId: 668, channelId: 999,
    onMessage: (m) => messages.push(m), onEvent: (e) => events.push(e), onSubscribed: (ok) => subscribed.push(ok),
  });
  relay.ws = { readyState: 1, send: (s) => sent.push(JSON.parse(s)) };

  relay.handleFrame(JSON.stringify({ event: 'pusher:connection_established', data: JSON.stringify({ socket_id: '1.2', activity_timeout: 120 }) }));
  assert.deepEqual(sent.map((f) => f.data.channel), ['chatrooms.668.v2', 'channel.999']);
  assert.equal(relay.activityTimeoutMs, 120000);

  relay.handleFrame(JSON.stringify({ event: 'pusher_internal:subscription_succeeded', channel: 'channel.999', data: '{}' }));
  assert.deepEqual(subscribed, [], 'only the chatroom subscription counts');
  relay.handleFrame(JSON.stringify({ event: 'pusher_internal:subscription_succeeded', channel: 'chatrooms.668.v2', data: '{}' }));
  assert.deepEqual(subscribed, [true]);

  relay.handleFrame(JSON.stringify({ event: EVENTS.message, channel: 'chatrooms.668.v2', data: JSON.stringify(reply) }));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].username, 'Xqcs_Driving_Instructor');

  relay.handleFrame(JSON.stringify({ event: EVENTS.banned, data: JSON.stringify(banned) }));
  assert.equal(events[0].type, 'user_banned');

  relay.handleFrame(JSON.stringify({ event: 'pusher:ping', data: {} }));
  assert.equal(sent[sent.length - 1].event, 'pusher:pong');

  relay.handleFrame('not json at all');
  relay.clearTimers();
});

test('KickApi.verifyUser: real name, unknown name, and both answers cached', async () => {
  let calls = 0;
  const api = new KickApi({
    fetchImpl: async (url) => {
      calls++;
      return fakeFetch([
        ['/channels/xqc/users/epicnoob', { id: 1, username: 'EpicNoob', slug: 'epicnoob' }],
      ])(url);
    },
  });

  // Kick's own spelling comes back, not whatever was typed.
  assert.equal(await api.verifyUser('xqc', 'epicnoob'), 'EpicNoob');
  assert.equal(calls, 1);
  // The name is asked about as typed, but cached case-insensitively.
  assert.equal(await api.verifyUser('xqc', 'EpicNoob'), 'EpicNoob', 'served from cache');
  assert.equal(calls, 1);

  // "@everyone" is not a user: a 404 is a real answer, and it is remembered.
  assert.equal(await api.verifyUser('xqc', 'everyone'), null);
  assert.equal(calls, 2);
  assert.equal(await api.verifyUser('xqc', 'everyone'), null);
  assert.equal(calls, 2, 'the "no" is cached too');
});

test('KickApi.verifyUser: a failing request throws instead of caching a "no"', async () => {
  let calls = 0;
  const api = new KickApi({
    fetchImpl: async () => {
      calls++;
      return { ok: false, status: 500, json: async () => ({}) };
    },
  });

  await assert.rejects(() => api.verifyUser('xqc', 'someone'));
  await assert.rejects(() => api.verifyUser('xqc', 'someone'));
  assert.equal(calls, 2, 'asked again rather than remembered as "not a user"');
});
