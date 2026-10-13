"""The chat relay: Kick's realtime feed, passed on to the chat page.

Kick's chat used to arrive over Pusher, which took a connection from any
origin, so the page subscribed to it itself and this server had nothing to do
with the chat. Kick has since moved to Centrifugo, and that server refuses a
WebSocket whose Origin is not kick.com (betterchat.tech gets a 403 on the
handshake), and the endpoints that hand out its address and tokens answer CORS
for kick.com alone. A page on this origin cannot reach it, so this server does,
and passes on what arrives. Kick's side of it - where to connect, the token,
the protocol - is kicksdk's (https://github.com/AnisAbdellatif/kicksdk); this
file holds the connections and hands the frames on.

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

import kicksdk

log = logging.getLogger("betterchat.relay")

# Kick's API sits behind Cloudflare, which is wary of a client that claims to
# be a browser and is not one; a bare product token passes.
USER_AGENT = "Mozilla/5.0"
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
    """The feeds Kick's own page joins for one chat (kicksdk knows which)."""
    return kicksdk.realtime.chat_channels(chatroom_id, channel_id)


def _now() -> int:
    return int(time.monotonic() * 1000)


class KickUpstream:
    """One connection to Kick's realtime feed, held for as long as it lasts.

    kicksdk speaks Kick: where to connect, the guest token, and the Centrifugo
    protocol as a state machine (kicksdk.realtime.Session). This only carries
    its requests and frames. Called once per attempt; returns (or raises) when
    the connection is gone, and the feed decides when to try again."""

    def __init__(self) -> None:
        import httpx

        self.http = httpx.AsyncClient(timeout=10, headers={"user-agent": USER_AGENT})

    async def aclose(self) -> None:
        await self.http.aclose()

    async def _send(self, req: kicksdk.Request) -> tuple[int, str]:
        res = await self.http.request(req.method, req.url, headers=req.headers, content=req.body)
        return res.status_code, res.text

    async def __call__(
        self, chatroom_id: int, channel_id: int | None, on_subscribed: OnSubscribed, on_event: OnEvent
    ) -> None:
        from websockets.asyncio.client import connect

        rt = kicksdk.realtime
        # A guest identity: the token is issued to this id, and so is every
        # refreshed one for this connection.
        client_id = str(uuid.uuid4())
        where = (
            rt.chat_connection_request(channel_id, client_id)
            if channel_id
            else rt.connection_request(client_id)
        )
        servers = [c for c in rt.parse_connection(*await self._send(where)) if c.get("provider") == "centrifugo"]
        if not servers:
            raise RuntimeError("Kick offered no Centrifugo server")
        token = rt.parse_token(*await self._send(rt.token_request(client_id)))
        channels = kick_channels(chatroom_id, channel_id)
        session = rt.Session(channels)

        async with connect(
            servers[0]["url"],
            origin=rt.REQUIRED_ORIGIN,
            user_agent_header=USER_AGENT,
            ping_interval=None,  # Kick pings in the protocol itself
            max_size=2**22,
            open_timeout=15,
        ) as ws:

            async def carry_out(actions: list[dict]) -> None:
                for a in actions:
                    kind = a["action"]
                    if kind == "send":
                        await ws.send(a["text"])
                    elif kind == "close":
                        raise RuntimeError(a["reason"])
                    elif kind == "refresh_token":
                        fresh = rt.parse_token(*await self._send(rt.token_request(client_id)))
                        await carry_out(session.refresh(fresh, _now()))
                    elif kind == "subscribed" and a["channel"] == channels[0]:
                        on_subscribed(True)
                    elif kind == "subscribe_failed":
                        log.warning("Kick refused %s: %s", a["channel"], a["message"])
                    elif kind == "event":
                        on_event(a["channel"], a["name"], a["data"])

            await carry_out(session.open(token, _now()))
            while True:
                deadline = session.deadline
                timeout = None if deadline is None else max(0.0, (deadline - _now()) / 1000)
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout)
                except TimeoutError:
                    await carry_out(session.tick(_now()))
                    continue
                if isinstance(raw, bytes):
                    raw = raw.decode("utf-8", "replace")
                await carry_out(session.receive(raw, _now()))


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
