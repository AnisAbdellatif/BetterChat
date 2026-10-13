"""The chat relay: Kick's realtime feed, passed on to the chat page.

Kick's chat used to arrive over Pusher, which took a connection from any
origin, so the page subscribed to it itself and this server had nothing to do
with the chat. Kick has since moved to Centrifugo, and that server refuses a
WebSocket whose Origin is not kick.com (betterchat.tech gets a 403 on the
handshake), and the endpoints that hand out its address and tokens answer CORS
for kick.com alone. A page on this origin cannot reach it, so this server does,
and passes on what arrives.

One upstream connection per chatroom, however many viewers have it open, kept
for a little while after the last one leaves so a reload does not cost a new
handshake with Kick. Each viewer gets the frames over /realtime as JSON text:

    {"event": "relay:connected"}                  on accepting the socket
    {"event": "relay:subscribed"}                 Kick confirmed the chat channel
    {"event": "relay:unsubscribed"}               the connection to Kick dropped;
                                                  it is being remade
    {"event": "relay:ping"} / {"event": "relay:pong"}   keepalive, either way
    {"event": "<Kick's event>", "channel": "<Kick's channel>", "data": ...}

The last is Kick's own envelope as it came, `data` usually a JSON string.
Nothing is kept: frames go out as they arrive and are forgotten.
"""

import asyncio
import contextlib
import json
import logging
import time
import uuid
from collections.abc import Awaitable, Callable

log = logging.getLogger("betterchat.relay")

KICK_REALTIME_API = "https://web.kick.com/api/v1/realtime"
KICK_ORIGIN = "https://kick.com"
# Kick's API sits behind Cloudflare, which is wary of a client that does not
# say it is a browser.
USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/130.0.0.0 Safari/537.36"
)
# A connection token lives 45 minutes; a new one is sent this long before.
TOKEN_REFRESH_LEAD_SEC = 120
# Centrifugo pings every `ping` seconds (25 today); a connection silent for
# that long plus this is taken as dead.
PING_GRACE_SEC = 20
CLIENT_PING_SEC = 25
LINGER_SEC = 30
MAX_BACKOFF_SEC = 30
CLIENT_QUEUE = 1000

OnSubscribed = Callable[[bool], None]
OnEvent = Callable[[str, str, object], None]
Upstream = Callable[[int, int | None, OnSubscribed, OnEvent], Awaitable[None]]


def frame(event: str, **fields) -> str:
    return json.dumps({"event": event, **fields}, separators=(",", ":"))


def kick_channels(chatroom_id: int, channel_id: int | None) -> list[str]:
    """The channels Kick's own page joins for one chat, and where each kind of
    event arrives: chat, deletions, bans, subs and clears on chatrooms.<id>.v2;
    gifted subs and rewards on chatroom_<id>; hosts on chatrooms.<id>; Kicks on
    channel_<id>; live and offline on channel.<id>."""
    names = [f"chatrooms.{chatroom_id}.v2", f"chatrooms.{chatroom_id}", f"chatroom_{chatroom_id}"]
    if channel_id:
        names += [f"channel.{channel_id}", f"channel_{channel_id}"]
    return names


class KickUpstream:
    """One connection to Kick's Centrifugo, held for as long as it lasts.

    Called once per attempt; returns (or raises) when the connection is gone,
    and the feed decides when to try again."""

    def __init__(self) -> None:
        import httpx

        self.http = httpx.AsyncClient(
            timeout=10,
            headers={
                "user-agent": USER_AGENT,
                "accept": "application/json",
                "origin": KICK_ORIGIN,
                "referer": KICK_ORIGIN + "/",
            },
        )

    async def aclose(self) -> None:
        await self.http.aclose()

    async def _post(self, path: str, body: dict) -> dict:
        res = await self.http.post(KICK_REALTIME_API + path, json=body)
        res.raise_for_status()
        data = res.json().get("data")
        if not isinstance(data, dict):
            raise RuntimeError(f"Kick answered {path} without data")
        return data

    async def _url(self, channel_id: int | None, client_id: str) -> str:
        # Kick places each channel's chat on a region of its own and says
        # which; the general endpoint is for a chatroom with no channel id.
        body = {
            "client": {"id": client_id, "type": "web"},
            "capabilities": {"accepted_providers": [{"provider": "centrifugo"}]},
        }
        path = f"/channels/{channel_id}/chat/connection" if channel_id else "/connection"
        data = await self._post(path, body)
        for conn in data.get("connections") or []:
            url = (conn.get("credentials") or {}).get("url")
            if conn.get("provider") == "centrifugo" and isinstance(url, str) and url.startswith("wss://"):
                return url
        raise RuntimeError(f"Kick offered no Centrifugo connection: {data!r}")

    async def _token(self, client_id: str) -> str:
        token = (await self._post("/auth/connection", {"client_id": client_id})).get("token")
        if not isinstance(token, str) or not token:
            raise RuntimeError("Kick returned no connection token")
        return token

    async def __call__(
        self, chatroom_id: int, channel_id: int | None, on_subscribed: OnSubscribed, on_event: OnEvent
    ) -> None:
        from websockets.asyncio.client import connect

        # A guest identity: the token's subject is guest:<client_id>, and a
        # refreshed token has to carry the same one.
        client_id = str(uuid.uuid4())
        url = await self._url(channel_id, client_id)
        token = await self._token(client_id)
        channels = kick_channels(chatroom_id, channel_id)
        chat_channel = channels[0]

        async with connect(
            url,
            origin=KICK_ORIGIN,
            user_agent_header=USER_AGENT,
            ping_interval=None,  # Centrifugo pings in the protocol itself
            max_size=2**22,
            open_timeout=15,
        ) as ws:
            next_id = 1

            async def command(body: dict) -> int:
                nonlocal next_id
                next_id += 1
                await ws.send(json.dumps({"id": next_id, **body}))
                return next_id

            await ws.send(json.dumps({"id": 1, "connect": {"token": token, "name": "js"}}))
            pending_subs: dict[int, str] = {}
            ping_sec = 25
            refresh_at: float | None = None
            connected = False

            while True:
                timeout = ping_sec + PING_GRACE_SEC
                if refresh_at is not None:
                    timeout = max(0.0, min(timeout, refresh_at - time.monotonic()))
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout)
                except TimeoutError:
                    if refresh_at is not None and time.monotonic() >= refresh_at:
                        refresh_at = None
                        await command({"refresh": {"token": await self._token(client_id)}})
                        continue
                    raise RuntimeError("Kick went quiet") from None
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8", "replace")

                # Several replies can share one message, a line each.
                for line in raw.split("\n"):
                    if not line:
                        continue
                    if line == "{}":
                        await ws.send("{}")
                        continue
                    try:
                        msg = json.loads(line)
                    except ValueError:
                        continue
                    if not isinstance(msg, dict):
                        continue

                    if "error" in msg:
                        if msg.get("id") == 1:
                            raise RuntimeError(f"Kick refused the connection: {msg['error']}")
                        name = pending_subs.pop(msg.get("id"), None)
                        log.warning("Kick refused %s: %s", name or msg.get("id"), msg["error"])
                        if name == chat_channel:
                            raise RuntimeError("Kick refused the chat channel")
                        continue

                    reply = msg.get("connect") if msg.get("id") == 1 else msg.get("refresh")
                    if isinstance(reply, dict):
                        if isinstance(reply.get("ping"), int) and reply["ping"] > 0:
                            ping_sec = reply["ping"]
                        ttl = reply.get("ttl")
                        if reply.get("expires") and isinstance(ttl, int) and ttl > 0:
                            refresh_at = time.monotonic() + max(ttl - TOKEN_REFRESH_LEAD_SEC, ttl / 2)
                        if not connected:
                            connected = True
                            for name in channels:
                                pending_subs[await command({"subscribe": {"channel": name}})] = name
                        continue

                    if "subscribe" in msg:
                        if pending_subs.pop(msg.get("id"), None) == chat_channel:
                            on_subscribed(True)
                        continue

                    push = msg.get("push")
                    if not isinstance(push, dict):
                        continue
                    if "disconnect" in push:
                        raise RuntimeError(f"Kick disconnected: {push['disconnect']}")
                    if "unsub" in push and push.get("channel") == chat_channel:
                        raise RuntimeError("Kick unsubscribed the chat channel")
                    pub = push.get("pub")
                    data = pub.get("data") if isinstance(pub, dict) else None
                    if isinstance(data, dict) and isinstance(data.get("event"), str):
                        on_event(push.get("channel", ""), data["event"], data.get("data"))


class Feed:
    """One chatroom: the upstream connection and the viewers reading it."""

    def __init__(self, hub: "Relay", key: tuple[int, int | None]) -> None:
        self.hub = hub
        self.key = key
        self.clients: set[asyncio.Queue] = set()
        self.subscribed = False
        self.task: asyncio.Task | None = None
        self.linger: asyncio.TimerHandle | None = None

    def start(self) -> None:
        self.task = asyncio.create_task(self._run(), name=f"relay:{self.key}")

    def broadcast(self, text: str) -> None:
        for queue in list(self.clients):
            try:
                queue.put_nowait(text)
            except asyncio.QueueFull:
                # A viewer this far behind is not reading; it is cut loose
                # rather than held in memory, and its page reconnects.
                self.clients.discard(queue)
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait(None)

    def _set_subscribed(self, ok: bool) -> None:
        if self.subscribed == ok:
            return
        self.subscribed = ok
        self.broadcast(frame("relay:subscribed" if ok else "relay:unsubscribed"))

    def _on_event(self, channel: str, event: str, data: object) -> None:
        self.broadcast(frame(event, channel=channel, data=data))

    async def _run(self) -> None:
        chatroom_id, channel_id = self.key
        backoff = 1.0
        while True:
            reached = False

            def on_subscribed(ok: bool) -> None:
                nonlocal reached
                reached = reached or ok
                self._set_subscribed(ok)

            try:
                await self.hub.upstream(chatroom_id, channel_id, on_subscribed, self._on_event)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - every failure is a reconnect
                log.info("chatroom %s: %s", chatroom_id, e)
            self._set_subscribed(False)
            if reached:
                backoff = 1.0
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, MAX_BACKOFF_SEC)

    async def stop(self) -> None:
        if self.linger:
            self.linger.cancel()
        if self.task:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.task


class Relay:
    """Every feed this server holds, keyed by (chatroom id, channel id)."""

    def __init__(self, upstream: Upstream | None = None, max_feeds: int = 500, max_clients: int = 5000) -> None:
        self._own_upstream = upstream is None
        self.upstream: Upstream = upstream or KickUpstream()
        self.max_feeds = max_feeds
        self.max_clients = max_clients
        self.feeds: dict[tuple[int, int | None], Feed] = {}
        self.clients = 0

    def join(self, chatroom_id: int, channel_id: int | None) -> tuple[Feed, asyncio.Queue] | None:
        key = (chatroom_id, channel_id)
        feed = self.feeds.get(key)
        if self.clients >= self.max_clients or (feed is None and len(self.feeds) >= self.max_feeds):
            return None
        if feed is None:
            feed = self.feeds[key] = Feed(self, key)
            feed.start()
        if feed.linger:
            feed.linger.cancel()
            feed.linger = None
        queue: asyncio.Queue = asyncio.Queue(CLIENT_QUEUE)
        queue.put_nowait(frame("relay:connected"))
        if feed.subscribed:
            queue.put_nowait(frame("relay:subscribed"))
        feed.clients.add(queue)
        self.clients += 1
        return feed, queue

    def leave(self, feed: Feed, queue: asyncio.Queue) -> None:
        self.clients -= 1
        feed.clients.discard(queue)
        if not feed.clients and self.feeds.get(feed.key) is feed and not feed.linger:
            feed.linger = asyncio.get_running_loop().call_later(LINGER_SEC, self._retire, feed)

    def _retire(self, feed: Feed) -> None:
        feed.linger = None
        if feed.clients or self.feeds.get(feed.key) is not feed:
            return
        del self.feeds[feed.key]
        asyncio.create_task(feed.stop())

    def snapshot(self) -> dict:
        return {"feeds": len(self.feeds), "clients": self.clients}

    async def aclose(self) -> None:
        feeds = list(self.feeds.values())
        self.feeds.clear()
        for feed in feeds:
            await feed.stop()
        if self._own_upstream and isinstance(self.upstream, KickUpstream):
            await self.upstream.aclose()
