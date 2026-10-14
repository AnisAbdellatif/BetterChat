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
    {"event": "relay:unsubscribed"}               the connection to Kick (or Kick's
                                                  chat feed) dropped; it is being remade
    {"event": "relay:ping"} / {"event": "relay:pong"}   keepalive, either way
    {"event": "<Kick's event>", "channel": "<Kick's channel>", "data": ...}

The last is Kick's own envelope as it came, `data` usually a JSON string
(kicksdk strips any `playback_url` from it). Nothing is kept: frames go out
as they arrive and are forgotten.

The connection to Kick never gives up while anyone reads it (KICK.md §6.1 in
kicksdk): an ordinary drop is retried after 1 s doubling to 30 s, jittered;
a terminal close (Kick refusing this client: a ban, a connection limit, a
refused token; close codes 3500-3999 and 4500-4999) waits 5, 10, 20, then 30
minutes, plus up to a quarter at random, and comes back as a new guest client.
The chat feed subscribing starts both over.
"""

import asyncio
import contextlib
import json
import logging
import random
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

import kicksdk

log = logging.getLogger("betterchat.relay")

# Kick's API sits behind Cloudflare, which is wary of a client that claims to
# be a browser and is not one; a bare product token passes.
USER_AGENT = "Mozilla/5.0"
CLIENT_PING_SEC = 25
LINGER_SEC = 30
CLIENT_QUEUE = 1000


@dataclass(frozen=True)
class Drop:
    """How a connection to Kick ended, when it ended with a close code: the
    session's `close` action, or the socket's own close code."""

    code: int
    reason: str
    terminal: bool = False  # Kick refused this client: come back as a new one
    retry_after_ms: int = 0  # the least wait Kick's close asks for


OnSubscribed = Callable[[bool], None]
OnEvent = Callable[[str, str, object], None]
# (chatroom id, channel id, client id, on_subscribed, on_event) -> how it ended.
# Raises for a failure without a close code (a request, the handshake).
Upstream = Callable[[int, int | None, str, OnSubscribed, OnEvent], Awaitable[Drop | None]]


def frame(event: str, **fields) -> str:
    return json.dumps({"event": event, **fields}, separators=(",", ":"))


def kick_channels(chatroom_id: int, channel_id: int | None) -> list[str]:
    """The feeds Kick's own page joins for one chat (kicksdk knows which)."""
    return kicksdk.realtime.chat_channels(chatroom_id, channel_id)


def _now() -> int:
    return int(time.monotonic() * 1000)


def new_client_id() -> str:
    """A guest identity: Kick issues the token to it, and every refreshed one."""
    return str(uuid.uuid4())


class KickUpstream:
    """One connection to Kick's realtime feed, held for as long as it lasts.

    kicksdk speaks Kick: where to connect, the guest token, and the Centrifugo
    protocol as a state machine (kicksdk.realtime.Session). This only carries
    its requests and frames. Called once per attempt, with the client id the
    feed keeps until a terminal close; returns how the connection ended (the
    session's close, or the socket's close code), or raises for a failure
    without one, and the feed decides when to try again."""

    def __init__(self) -> None:
        import httpx

        self.http = httpx.AsyncClient(timeout=10, headers={"user-agent": USER_AGENT})

    async def aclose(self) -> None:
        await self.http.aclose()

    async def _send(self, req: kicksdk.Request) -> tuple[int, str]:
        res = await self.http.request(req.method, req.url, headers=req.headers, content=req.body)
        return res.status_code, res.text

    async def __call__(
        self,
        chatroom_id: int,
        channel_id: int | None,
        client_id: str,
        on_subscribed: OnSubscribed,
        on_event: OnEvent,
    ) -> Drop:
        from websockets.asyncio.client import connect
        from websockets.exceptions import ConnectionClosed

        rt = kicksdk.realtime
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
        # One session per connection: nothing of it outlives the socket.
        session = rt.Session(channels)

        async with connect(
            servers[0]["url"],
            origin=rt.REQUIRED_ORIGIN,
            user_agent_header=USER_AGENT,
            ping_interval=None,  # Kick pings in the protocol itself
            max_size=2**22,
            open_timeout=15,
        ) as ws:

            async def carry_out(actions: list[dict]) -> dict | None:
                """Carries out the session's actions; returns a `close`."""
                for a in actions:
                    kind = a["action"]
                    if kind == "send":
                        await ws.send(a["text"])
                    elif kind == "close":
                        return a
                    elif kind == "refresh_token":
                        try:
                            fresh = rt.parse_token(*await self._send(rt.token_request(client_id)))
                        except Exception as e:  # noqa: BLE001 - kicksdk: carry on
                            # Kick ends the connection when the old token runs
                            # out, and the reconnect gets a new one.
                            log.warning("chatroom %s: token refresh failed: %s", chatroom_id, e)
                            continue
                        close = await carry_out(session.refresh(fresh, _now()))
                        if close:
                            return close
                    elif kind == "subscribed" and a["channel"] == channels[0]:
                        on_subscribed(True)
                    elif kind == "unsubscribed" and a["channel"] == channels[0]:
                        # Kick dropped the chat feed (2500-2999: the session
                        # subscribes again, and `subscribed` follows).
                        on_subscribed(False)
                    elif kind == "subscribe_failed":
                        log.warning("Kick refused %s: %s", a["channel"], a["message"])
                    elif kind == "event":
                        on_event(a["channel"], a["name"], a["data"])
                return None

            try:
                close = await carry_out(session.open(token, _now()))
                while close is None:
                    # None while connected too, when Kick announced no ping.
                    deadline = session.deadline
                    timeout = None if deadline is None else max(0.0, (deadline - _now()) / 1000)
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout)
                    except TimeoutError:
                        close = await carry_out(session.tick(_now()))
                        continue
                    if isinstance(raw, bytes):
                        raw = raw.decode("utf-8", "replace")
                    close = await carry_out(session.receive(raw, _now()))
            except ConnectionClosed as e:
                # The socket closed by itself (Kick, or the network: 1006);
                # its close code says how long to wait.
                code, reason = (e.rcvd.code, e.rcvd.reason) if e.rcvd else (1006, "")
                retry_after = rt.retry_after_ms(code)
                return Drop(code, reason or f"the socket closed ({code})", retry_after > 0, retry_after)
            return Drop(close["code"], close["reason"], close["terminal"], close["retry_after_ms"])


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
        hub = self.hub
        backoff = hub.backoff()
        # Kept across reconnects; a terminal close makes a new one.
        client_id = new_client_id()

        def on_subscribed(ok: bool) -> None:
            if ok:
                backoff.reset()  # the chat feed is up: both stages start over
            self._set_subscribed(ok)

        while True:
            try:
                drop = await hub.upstream(chatroom_id, channel_id, client_id, on_subscribed, self._on_event)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - every failure is a reconnect
                drop = Drop(0, str(e) or type(e).__name__)
            drop = drop or Drop(0, "the connection ended")
            self._set_subscribed(False)
            if drop.terminal:
                client_id = new_client_id()
            wait = backoff.next_delay_for(drop.retry_after_ms, hub.random()) / 1000
            if drop.terminal:
                log.warning(
                    "chatroom %s: Kick closed the chat to this client (%s: %s); reconnecting as a new client in %.0f s",
                    chatroom_id,
                    drop.code,
                    drop.reason,
                    wait,
                )
            else:
                log.info("chatroom %s: %s; reconnecting in %.1f s", chatroom_id, drop.reason, wait)
            await hub.sleep(wait)

    async def stop(self) -> None:
        if self.linger:
            self.linger.cancel()
        if self.task:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.task


class Relay:
    """Every feed this server holds, keyed by (chatroom id, channel id)."""

    def __init__(
        self,
        upstream: Upstream | None = None,
        max_feeds: int = 500,
        max_clients: int = 5000,
        *,
        backoff: Callable[[], "kicksdk.realtime.Backoff"] | None = None,
        random: Callable[[], float] = random.random,
        sleep: Callable[[float], Awaitable[object]] | None = None,
    ) -> None:
        self._own_upstream = upstream is None
        self.upstream: Upstream = upstream or KickUpstream()
        # Each feed's reconnect delays (kicksdk's: 1 s doubling to 30 s, and
        # 5 to 30 minutes after terminal closes), its jitter, and its wait;
        # tests put their own here.
        self.backoff = backoff or kicksdk.realtime.Backoff
        self.random = random
        self.sleep = sleep or asyncio.sleep
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
