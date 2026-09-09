// BetterChat - the browser-side "backend": everything the former Elixir
// server did, running in the viewer's browser instead.
//
//   KickApi      - Kick's unofficial REST API (channel resolution, pinned
//                  message + recent history, user cards), with a small TTL
//                  cache. Kick answers cross-origin requests with CORS.
//   PusherRelay  - one WebSocket to Kick's Pusher feed, subscribed to the
//                  chatroom (chat) and channel (live/offline) channels,
//                  with ping/pong keepalive and reconnect with backoff.
//   normalize*   - turn Kick's raw payloads into the shapes app.js renders.
//
// Loaded as a classic <script>; also require()-able from Node for tests.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BetterChatKick = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Normalization (port of chat_message.ex / chat_event.ex)
  // ---------------------------------------------------------------------

  const EV = {
    message: 'App\\Events\\ChatMessageEvent',
    deleted: 'App\\Events\\MessageDeletedEvent',
    cleared: 'App\\Events\\ChatroomClearEvent',
    banned: 'App\\Events\\UserBannedEvent',
    unbanned: 'App\\Events\\UserUnbannedEvent',
    pinCreated: 'App\\Events\\PinnedMessageCreatedEvent',
    pinDeleted: 'App\\Events\\PinnedMessageDeletedEvent',
    subscription: 'App\\Events\\SubscriptionEvent',
    gifted: 'App\\Events\\GiftedSubscriptionsEvent',
    host: 'App\\Events\\StreamHostEvent',
    live: 'App\\Events\\StreamerIsLive',
    offline: 'App\\Events\\StopStreamBroadcast',
  };

  const list = (v) => (Array.isArray(v) ? v : []);
  const str = (v) => (typeof v === 'string' ? v : null);

  // Kick is inconsistent about numbers-as-strings ("duration": "1200").
  function integer(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
    if (typeof v === 'string') {
      const n = parseInt(v, 10);
      return Number.isNaN(n) ? null : n;
    }
    return null;
  }

  function parseBadges(raw) {
    return list(raw)
      .filter((b) => b && typeof b.type === 'string')
      .map((b) => ({
        type: b.type,
        text: str(b.text),
        count: integer(b.count),
        sort_order: integer(b.sort_order) || 0,
      }));
  }

  // `selected: false` means the user has the badge but chose not to show it.
  function parseBadgesV2(raw) {
    return list(raw)
      .filter((b) => b && typeof b.name === 'string' && typeof b.image_url === 'string' && b.selected !== false)
      .map((b) => ({
        name: b.name,
        image_url: b.image_url,
        level: b.metadata && integer(b.metadata.level),
        sort_order: integer(b.sort_order) || 0,
      }));
  }

  function parseReply(metadata) {
    const original = metadata && metadata.original_message;
    if (!original || typeof original !== 'object') return null;
    return {
      id: original.id != null ? String(original.id) : null,
      username: (metadata.original_sender && str(metadata.original_sender.username)) || null,
      content: str(original.content),
    };
  }

  // A chat message as app.js expects it, or null for anything malformed.
  function normalizeMessage(data) {
    if (!data || typeof data !== 'object') return null;
    const sender = data.sender || {};
    if (data.id == null || typeof sender.username !== 'string' || typeof data.content !== 'string') return null;
    const identity = sender.identity || {};
    return {
      id: String(data.id),
      username: sender.username,
      content: data.content,
      created_at: str(data.created_at),
      color: str(identity.color),
      type: typeof data.type === 'string' ? data.type : 'message',
      reply_to: parseReply(data.metadata),
      badges: parseBadges(identity.badges),
      badges_v2: parseBadgesV2(identity.badges_v2),
    };
  }

  // Pin durations from Kick are MINUTES (default pin = 1200 = 20h); the
  // history endpoint also gives an absolute `finish_at`.
  function buildPin(data) {
    const message = normalizeMessage(data && data.message);
    if (!message) return null;
    const durationMin = integer(data.duration);
    let expiresAt = str(data.finish_at);
    if (!expiresAt && durationMin && durationMin > 0) {
      expiresAt = new Date(Date.now() + durationMin * 60000).toISOString();
    }
    const by = (data.pinnedBy && str(data.pinnedBy.username)) || (data.pinned_by && str(data.pinned_by.username)) || null;
    return { type: 'pin_created', message, duration_min: durationMin, expires_at: expiresAt, by };
  }

  // Non-message Pusher events -> {type, ...} for app.js, or null to ignore.
  function normalizeEvent(name, data) {
    data = data && typeof data === 'object' ? data : {};
    switch (name) {
      case EV.deleted: {
        const id = (data.message && data.message.id) || data.message_id;
        return id == null ? null : { type: 'message_deleted', message_id: String(id) };
      }
      case EV.cleared:
        return { type: 'chat_cleared' };
      case EV.banned:
        return {
          type: 'user_banned',
          username: data.user && str(data.user.username),
          permanent: data.permanent === true,
          duration_min: integer(data.duration),
          expires_at: str(data.expires_at),
          by: data.banned_by && str(data.banned_by.username),
        };
      case EV.unbanned:
        return {
          type: 'user_unbanned',
          username: data.user && str(data.user.username),
          permanent: data.permanent === true,
          by: data.unbanned_by && str(data.unbanned_by.username),
        };
      case EV.pinCreated:
        return buildPin(data);
      case EV.pinDeleted:
        return { type: 'pin_deleted' };
      case EV.subscription:
        return { type: 'subscription', username: str(data.username), months: integer(data.months) || 1 };
      case EV.gifted:
        return {
          type: 'gifted_subs',
          gifter: str(data.gifter_username),
          recipients: list(data.gifted_usernames).filter((u) => typeof u === 'string'),
        };
      case EV.host:
        return {
          type: 'host',
          host_username: str(data.host_username),
          viewers: integer(data.number_viewers),
          message: str(data.optional_message),
        };
      case EV.live:
        return { type: 'stream_live', title: data.livestream && str(data.livestream.session_title) };
      case EV.offline:
        return { type: 'stream_offline' };
      default:
        return null;
    }
  }

  // ---------------------------------------------------------------------
  // Kick REST API
  // ---------------------------------------------------------------------

  class KickApiError extends Error {
    constructor(message, status) {
      super(message);
      this.name = 'KickApiError';
      this.status = status;
    }
  }

  const MAX_CACHE_ENTRIES = 200;

  class KickApi {
    constructor({ baseUrl = 'https://kick.com/api/v2', fetchImpl } = {}) {
      this.baseUrl = baseUrl.replace(/\/+$/, '');
      this.fetch = fetchImpl || ((...a) => fetch(...a));
      this.cache = new Map(); // key -> {value, expiresAt}
    }

    async get(path) {
      const res = await this.fetch(`${this.baseUrl}${path}`, { headers: { accept: 'application/json' } });
      if (res.status === 404) throw new KickApiError('not found', 404);
      if (!res.ok) throw new KickApiError(`Kick API returned ${res.status}`, res.status);
      const body = await res.json();
      if (!body || typeof body !== 'object') throw new KickApiError('unexpected response', 502);
      return body;
    }

    // Expired entries used to sit in the map forever: the TTL was only
    // checked on read, and user-card keys are unbounded (one per distinct
    // username looked up). Drop stale hits and keep the map to a fixed size,
    // oldest first - Map iterates in insertion order.
    async cached(key, ttlMs, load) {
      const hit = this.cache.get(key);
      if (hit && hit.expiresAt > Date.now()) return hit.value;
      if (hit) this.cache.delete(key);
      const value = await load();
      this.cache.set(key, { value, expiresAt: Date.now() + ttlMs });
      while (this.cache.size > MAX_CACHE_ENTRIES) {
        this.cache.delete(this.cache.keys().next().value);
      }
      return value;
    }

    // slug -> {slug, channel_id, chatroom_id, subscriber_badges, live}
    resolveChannel(slug) {
      slug = String(slug || '').trim().toLowerCase();
      if (!slug) return Promise.reject(new KickApiError('not found', 404));
      return this.cached(`channel:${slug}`, 5 * 60000, async () => {
        const body = await this.get(`/channels/${encodeURIComponent(slug)}`);
        if (!body.id || !body.chatroom || body.chatroom.id == null) {
          throw new KickApiError('unexpected channel shape', 502);
        }
        return {
          slug,
          channel_id: body.id,
          chatroom_id: body.chatroom.id,
          subscriber_badges: list(body.subscriber_badges)
            .filter((b) => b && Number.isInteger(b.months) && b.badge_image && typeof b.badge_image.src === 'string')
            .map((b) => ({ months: b.months, src: b.badge_image.src }))
            .sort((a, b) => a.months - b.months),
          live: !!(body.livestream && typeof body.livestream === 'object'),
        };
      });
    }

    // channel_id -> {pinned: pin_created event | null, messages: [...oldest first]}
    async pinnedAndHistory(channelId) {
      const body = await this.get(`/channels/${encodeURIComponent(channelId)}/messages`);
      const data = body.data || {};
      const messages = list(data.messages)
        .map(normalizeMessage)
        .filter(Boolean)
        .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
      const pinned = data.pinned_message && typeof data.pinned_message === 'object' ? buildPin(data.pinned_message) : null;
      return { pinned, messages };
    }

    // The data behind a user card: who they are + their relationship to the
    // channel. Merges Kick's per-channel user endpoint with the user's own
    // channel record (follower count, bio); the latter is optional.
    // Does this channel know a user by this name? Answers an "@something" in
    // a message, where "something" is just as likely to be a word as a
    // username. Only the channel-user endpoint is asked - no profile merge,
    // since nothing is displayed from it - and the answer is cached either
    // way, so a name typed over and over costs one request. A 404 is a real
    // "no"; anything else throws so a network blip is not remembered as one.
    // Resolves to Kick's own spelling of the name, or null.
    verifyUser(channelSlug, username) {
      channelSlug = String(channelSlug || '').trim().toLowerCase();
      username = String(username || '').trim();
      const key = `exists:${channelSlug}:${username.toLowerCase()}`;
      return this.cached(key, 10 * 60000, async () => {
        try {
          const user = await this.get(
            `/channels/${encodeURIComponent(channelSlug)}/users/${encodeURIComponent(username)}`
          );
          return str(user.username) || username;
        } catch (e) {
          if (e && e.status === 404) return null;
          throw e;
        }
      });
    }

    userCard(channelSlug, username) {
      channelSlug = String(channelSlug || '').trim().toLowerCase();
      username = String(username || '').trim();
      const key = `user:${channelSlug}:${username.toLowerCase()}`;
      return this.cached(key, 3 * 60000, async () => {
        const user = await this.get(`/channels/${encodeURIComponent(channelSlug)}/users/${encodeURIComponent(username)}`);
        let own = {};
        try {
          own = await this.get(`/channels/${encodeURIComponent(user.slug || username)}`);
        } catch (_e) {
          /* follower count / bio are nice-to-have */
        }
        const ownUser = own.user || {};
        return {
          id: user.id,
          username: user.username,
          slug: user.slug,
          profile_pic: user.profile_pic || ownUser.profile_pic || null,
          bio: str(ownUser.bio),
          followers_count: integer(own.followers_count),
          verified: own.verified === true,
          created_at: str(user.created_at),
          following_since: str(user.following_since),
          subscribed_for: integer(user.subscribed_for),
          is_moderator: user.is_moderator === true,
          is_staff: user.is_staff === true,
          is_channel_owner: user.is_channel_owner === true,
          banned: user.banned || null,
          badges: parseBadges(user.badges),
          badges_v2: parseBadgesV2(user.badges_v2),
        };
      });
    }
  }

  // ---------------------------------------------------------------------
  // Pusher relay (port of pusher_relay.ex)
  // ---------------------------------------------------------------------

  const MAX_BACKOFF_MS = 30000;
  const PONG_TIMEOUT_MS = 30000;

  class PusherRelay {
    /**
     * @param {object} opts
     * @param {string} opts.appKey        Kick's public Pusher app key
     * @param {string} opts.cluster       e.g. "us2"
     * @param {number} opts.chatroomId    subscribes to chatrooms.<id>.v2
     * @param {number} [opts.channelId]   also subscribes to channel.<id> (live/offline)
     * @param {(msg) => void} opts.onMessage
     * @param {(ev) => void}  opts.onEvent
     * @param {(open: boolean) => void} [opts.onSocket]      socket opened / closed
     * @param {(ok: boolean) => void}   [opts.onSubscribed]  chatroom subscription confirmed / lost
     * @param {(name, data) => void}    [opts.onUnknown]     events we don't recognize (for debugging)
     */
    constructor(opts) {
      this.o = opts;
      this.ws = null;
      this.backoffMs = 1000;
      this.closed = false;
      this.subscribed = false;
      this.pingTimer = null;
      this.pongTimer = null;
      this.reconnectTimer = null;
      this.activityTimeoutMs = 120000;
    }

    url() {
      return `wss://ws-${this.o.cluster}.pusher.com/app/${this.o.appKey}?protocol=7&client=js&version=8.4.0&flash=false`;
    }

    channels() {
      const list = [`chatrooms.${this.o.chatroomId}.v2`];
      if (this.o.channelId) list.push(`channel.${this.o.channelId}`);
      return list;
    }

    connect() {
      if (this.closed) return;
      this.clearTimers();
      let ws;
      try {
        ws = new WebSocket(this.url());
      } catch (_e) {
        this.scheduleReconnect();
        return;
      }
      this.ws = ws;
      ws.onopen = () => {
        this.backoffMs = 1000;
        if (this.o.onSocket) this.o.onSocket(true);
      };
      ws.onmessage = (e) => this.handleFrame(e.data);
      ws.onerror = () => {
        /* onclose follows */
      };
      ws.onclose = () => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.setSubscribed(false);
        if (this.o.onSocket) this.o.onSocket(false);
        this.scheduleReconnect();
      };
    }

    close() {
      this.closed = true;
      this.clearTimers();
      if (this.ws) {
        const ws = this.ws;
        this.ws = null;
        ws.onclose = null;
        ws.close();
      }
    }

    send(obj) {
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
    }

    setSubscribed(ok) {
      if (this.subscribed === ok) return;
      this.subscribed = ok;
      if (this.o.onSubscribed) this.o.onSubscribed(ok);
    }

    scheduleReconnect() {
      if (this.closed) return;
      this.clearTimers();
      this.reconnectTimer = setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    }

    clearTimers() {
      clearTimeout(this.pingTimer);
      clearTimeout(this.pongTimer);
      clearTimeout(this.reconnectTimer);
      this.pingTimer = this.pongTimer = this.reconnectTimer = null;
    }

    // Keepalive: after activity_timeout with no traffic we ping; if nothing
    // comes back in time the socket is considered dead and we reconnect.
    armPing() {
      clearTimeout(this.pingTimer);
      clearTimeout(this.pongTimer);
      this.pingTimer = setTimeout(() => {
        this.send({ event: 'pusher:ping', data: {} });
        this.pongTimer = setTimeout(() => {
          if (this.ws) this.ws.close();
        }, PONG_TIMEOUT_MS);
      }, this.activityTimeoutMs);
    }

    handleFrame(raw) {
      let frame;
      try {
        frame = JSON.parse(raw);
      } catch (_e) {
        return;
      }
      // Any traffic proves the connection is alive.
      this.armPing();

      const name = frame.event;
      let data = frame.data;
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data);
        } catch (_e) {
          /* leave as string */
        }
      }

      switch (name) {
        case 'pusher:connection_established': {
          const t = data && integer(data.activity_timeout);
          if (t && t > 0) this.activityTimeoutMs = t * 1000;
          this.armPing();
          for (const channel of this.channels()) {
            this.send({ event: 'pusher:subscribe', data: { channel } });
          }
          return;
        }
        case 'pusher_internal:subscription_succeeded':
          if (frame.channel === `chatrooms.${this.o.chatroomId}.v2`) this.setSubscribed(true);
          return;
        case 'pusher:ping':
          this.send({ event: 'pusher:pong', data: {} });
          return;
        case 'pusher:pong':
          return;
        case 'pusher:error':
          // e.g. 4201 "Pong reply not received": let onclose drive reconnect.
          return;
        case EV.message: {
          const msg = normalizeMessage(data);
          if (msg) this.o.onMessage(msg);
          return;
        }
        default: {
          if (typeof name !== 'string' || name.startsWith('pusher')) return;
          const ev = normalizeEvent(name, data);
          if (ev) this.o.onEvent(ev);
          else if (this.o.onUnknown) this.o.onUnknown(name, data);
        }
      }
    }
  }

  return {
    EVENTS: EV,
    KickApi,
    KickApiError,
    PusherRelay,
    normalizeMessage,
    normalizeEvent,
    buildPin,
    parseBadges,
    parseBadgesV2,
  };
});
