import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from betterchat import relay as relay_mod
from betterchat.main import create_app
from betterchat.relay import KickUpstream, Relay, kick_channels
from betterchat.stats import Stats


class FakeUpstream:
    """Stands in for Kick: records who asked, and hands the test the callbacks."""

    def __init__(self) -> None:
        self.calls: list[tuple[int, int | None]] = []
        self.live: asyncio.Event | None = None
        self.callbacks = None

    async def __call__(self, chatroom_id, channel_id, on_subscribed, on_event):
        self.calls.append((chatroom_id, channel_id))
        self.callbacks = (on_subscribed, on_event)
        on_subscribed(True)
        on_event("chatrooms.1.v2", "App\\Events\\ChatMessageEvent", '{"id":"m1"}')
        await asyncio.Event().wait()  # holds until cancelled


@pytest.fixture
def site(tmp_path, monkeypatch):
    site = tmp_path / "site"
    site.mkdir()
    (site / "index.html").write_text("<title>BetterChat</title>")
    monkeypatch.setenv("SITE_DIR", str(site))
    return site


def make_client(tmp_path, upstream, **limits):
    hub = Relay(upstream=upstream, **limits)
    app = create_app(Stats(path=str(tmp_path / "stats.json")), sample_loop=False, relay=hub)
    return TestClient(app), hub


def test_kick_channels_are_the_five_kicks_page_joins():
    assert kick_channels(668, 999) == [
        "chatrooms.668.v2",
        "chatrooms.668",
        "chatroom_668",
        "channel.999",
        "channel_999",
    ]
    assert kick_channels(668, None) == ["chatrooms.668.v2", "chatrooms.668", "chatroom_668"]


def test_realtime_relays_kicks_frames_and_shares_one_upstream(tmp_path, site):
    upstream = FakeUpstream()
    client, hub = make_client(tmp_path, upstream)
    with client:
        with client.websocket_connect("/realtime?chatroom=1&channel=2") as a:
            assert json.loads(a.receive_text()) == {"event": "relay:connected"}
            assert json.loads(a.receive_text()) == {"event": "relay:subscribed"}
            assert json.loads(a.receive_text()) == {
                "event": "App\\Events\\ChatMessageEvent",
                "channel": "chatrooms.1.v2",
                "data": '{"id":"m1"}',
            }
            with client.websocket_connect("/realtime?chatroom=1&channel=2") as b:
                # Joining an upstream already subscribed says so straight away.
                assert json.loads(b.receive_text()) == {"event": "relay:connected"}
                assert json.loads(b.receive_text()) == {"event": "relay:subscribed"}
                assert client.get("/health").json()["relay"] == {"feeds": 1, "clients": 2}

                b.send_text('{"event":"relay:ping"}')
                assert json.loads(b.receive_text()) == {"event": "relay:pong"}
        assert upstream.calls == [(1, 2)]


def test_realtime_rejects_bad_ids(tmp_path, site):
    client, _hub = make_client(tmp_path, FakeUpstream())
    with client:
        for query in ("", "?chatroom=abc", "?chatroom=0", "?chatroom=1&channel=-4"):
            with pytest.raises(Exception):
                with client.websocket_connect(f"/realtime{query}") as ws:
                    ws.receive_text()


def test_realtime_turns_away_past_the_cap(tmp_path, site):
    client, _hub = make_client(tmp_path, FakeUpstream(), max_feeds=1)
    with client:
        with client.websocket_connect("/realtime?chatroom=1") as a:
            a.receive_text()
            with client.websocket_connect("/realtime?chatroom=2") as b:
                with pytest.raises(Exception) as caught:
                    b.receive_text()
                assert getattr(caught.value, "code", None) == 1013


def test_feed_lingers_then_retires(monkeypatch):
    monkeypatch.setattr(relay_mod, "LINGER_SEC", 0.05)

    async def scenario():
        upstream = FakeUpstream()
        hub = Relay(upstream=upstream)
        feed, queue = hub.join(1, None)
        await asyncio.sleep(0.01)
        hub.leave(feed, queue)
        assert hub.snapshot() == {"feeds": 1, "clients": 0}

        # Back within the linger: the same upstream, no new handshake.
        feed2, queue2 = hub.join(1, None)
        assert feed2 is feed
        hub.leave(feed2, queue2)
        await asyncio.sleep(0.1)
        assert hub.snapshot() == {"feeds": 0, "clients": 0}
        assert upstream.calls == [(1, None)]
        await hub.aclose()

    asyncio.run(scenario())


def test_feed_reports_a_lost_upstream_and_reconnects(monkeypatch):
    async def scenario():
        attempts = []

        async def flaky(chatroom_id, channel_id, on_subscribed, on_event):
            attempts.append(chatroom_id)
            on_subscribed(True)
            if len(attempts) == 1:
                raise RuntimeError("Kick went away")
            await asyncio.Event().wait()

        real_sleep = asyncio.sleep
        monkeypatch.setattr(relay_mod.asyncio, "sleep", lambda s: real_sleep(0))
        hub = Relay(upstream=flaky)
        _feed, queue = hub.join(7, None)
        seen = []
        while len(seen) < 4:
            seen.append(json.loads(await asyncio.wait_for(queue.get(), 1))["event"])
        assert seen == ["relay:connected", "relay:subscribed", "relay:unsubscribed", "relay:subscribed"]
        assert attempts == [7, 7]
        await hub.aclose()

    asyncio.run(scenario())


def test_a_reader_that_falls_behind_is_cut_loose(monkeypatch):
    monkeypatch.setattr(relay_mod, "CLIENT_QUEUE", 3)

    async def scenario():
        upstream = FakeUpstream()
        hub = Relay(upstream=upstream)
        feed, queue = hub.join(1, None)
        await asyncio.sleep(0.01)
        _on_subscribed, on_event = upstream.callbacks
        for i in range(5):
            on_event("chatrooms.1.v2", "App\\Events\\ChatMessageEvent", str(i))
        assert queue not in feed.clients
        assert queue.get_nowait() is None  # the endpoint's cue to hang up
        hub.leave(feed, queue)
        await hub.aclose()

    asyncio.run(scenario())


def test_kick_upstream_speaks_centrifugo(monkeypatch):
    """KickUpstream against a stand-in Centrifugo: the connect with the token
    and Kick's Origin, the five subscriptions, pings answered, publications
    passed on, a token refresh before expiry, and a disconnect push ending it."""
    from websockets.asyncio.server import serve

    monkeypatch.setattr(relay_mod, "TOKEN_REFRESH_LEAD_SEC", 0)
    received: list[dict] = []
    origins: list[str | None] = []

    async def kick(ws):
        origins.append(ws.request.headers.get("Origin"))
        hello = json.loads(await ws.recv())
        received.append(hello)
        # ttl 1: a refresh is due almost at once.
        await ws.send(json.dumps({"id": 1, "connect": {"client": "c", "expires": True, "ttl": 1, "ping": 25}}))
        subs = [json.loads(await ws.recv()) for _ in range(5)]
        received.extend(subs)
        # Replies batched into one message, a line each, as Centrifugo does.
        await ws.send("\n".join(json.dumps({"id": s["id"], "subscribe": {}}) for s in subs))
        await ws.send("{}")
        assert await ws.recv() == "{}"
        pub = {"event": "App\\Events\\ChatMessageEvent", "data": '{"id":"x"}'}
        await ws.send(json.dumps({"push": {"channel": "chatrooms.5.v2", "pub": {"data": pub}}}))
        refresh = json.loads(await ws.recv())
        received.append(refresh)
        await ws.send(json.dumps({"id": refresh["id"], "refresh": {"expires": True, "ttl": 3600}}))
        await ws.send(json.dumps({"push": {"disconnect": {"code": 3001, "reason": "shutdown"}}}))
        await asyncio.sleep(0.2)

    async def scenario():
        async with serve(kick, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            up = KickUpstream()
            tokens = iter(["t1", "t2"])

            async def fake_url(channel_id, client_id):
                return f"ws://127.0.0.1:{port}/connection/websocket"

            async def fake_token(client_id):
                return next(tokens)

            up._url = fake_url
            up._token = fake_token
            states, events = [], []
            with pytest.raises(RuntimeError, match="disconnected"):
                await asyncio.wait_for(
                    up(5, 6, states.append, lambda c, e, d: events.append((c, e, d))), 5
                )
            await up.aclose()
            return states, events

    states, events = asyncio.run(scenario())
    assert origins == ["https://kick.com"]
    assert received[0] == {"id": 1, "connect": {"token": "t1", "name": "js"}}
    assert [r["subscribe"]["channel"] for r in received[1:6]] == kick_channels(5, 6)
    assert received[6]["refresh"] == {"token": "t2"}
    assert states == [True]
    assert events == [("chatrooms.5.v2", "App\\Events\\ChatMessageEvent", '{"id":"x"}')]
