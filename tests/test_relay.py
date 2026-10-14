import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from betterchat import relay as relay_mod
from betterchat.main import create_app
from betterchat.relay import Drop, KickUpstream, Relay, kick_channels
from betterchat.stats import Stats


class FakeUpstream:
    """Stands in for Kick: records who asked, and hands the test the callbacks."""

    def __init__(self) -> None:
        self.calls: list[tuple[int, int | None]] = []
        self.live: asyncio.Event | None = None
        self.callbacks = None

    async def __call__(self, chatroom_id, channel_id, client_id, on_subscribed, on_event):
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

        async def flaky(chatroom_id, channel_id, client_id, on_subscribed, on_event):
            attempts.append(chatroom_id)
            on_subscribed(True)
            if len(attempts) == 1:
                raise RuntimeError("Kick went away")
            await asyncio.Event().wait()

        waits = []

        async def no_wait(seconds):
            waits.append(seconds)

        hub = Relay(upstream=flaky, sleep=no_wait, random=lambda: 0.0)
        _feed, queue = hub.join(7, None)
        seen = []
        while len(seen) < 4:
            seen.append(json.loads(await asyncio.wait_for(queue.get(), 1))["event"])
        assert seen == ["relay:connected", "relay:subscribed", "relay:unsubscribed", "relay:subscribed"]
        assert attempts == [7, 7]
        # A failure without a close code: the ordinary backoff (1 s, jittered
        # down to half by random 0), from the start since the chat subscribed.
        assert waits == [0.5]
        await hub.aclose()

    asyncio.run(scenario())


def test_terminal_closes_wait_long_and_come_back_as_a_new_client():
    """KICK.md §6.1: a terminal close waits 5, 10, 20, 30 minutes and makes a
    new client id; the chat feed subscribing starts the waits over; an
    ordinary drop keeps the client id and waits the ordinary backoff."""

    async def scenario():
        banned = Drop(3501, "Kick disconnected: 3501 banned", True, 300_000)
        script = [
            lambda sub: banned,
            lambda sub: banned,
            lambda sub: (sub(True), banned)[1],  # subscribed, then refused again
            lambda sub: (sub(True), Drop(3001, "shutdown"))[1],
            lambda sub: (sub(True), banned)[1],
        ]
        client_ids, waits = [], []
        done = asyncio.Event()

        async def kick(chatroom_id, channel_id, client_id, on_subscribed, on_event):
            client_ids.append(client_id)
            if len(client_ids) > len(script):
                done.set()
                await asyncio.Event().wait()
            return script[len(client_ids) - 1](on_subscribed)

        async def no_wait(seconds):
            waits.append(seconds)

        hub = Relay(upstream=kick, sleep=no_wait, random=lambda: 0.0)
        hub.join(3, 4)
        await asyncio.wait_for(done.wait(), 1)
        await hub.aclose()
        return client_ids, waits

    client_ids, waits = asyncio.run(scenario())
    # 5 min, 10 min; subscribed: 5 min again; subscribed, ordinary: 0.5 s;
    # subscribed, terminal: 5 min.
    assert waits == [300, 600, 300, 0.5, 300]
    a, b, c, d, e, f = client_ids
    assert len({a, b, c, d}) == 4  # a new client after each terminal close
    assert e == d  # not after an ordinary one
    assert f != e


def test_terminal_waits_are_jittered_by_up_to_a_quarter():
    async def scenario():
        waits = []
        calls = 0

        async def kick(chatroom_id, channel_id, client_id, on_subscribed, on_event):
            nonlocal calls
            calls += 1
            if calls > 1:
                await asyncio.Event().wait()
            return Drop(4501, "refused", True, 300_000)

        async def no_wait(seconds):
            waits.append(seconds)

        hub = Relay(upstream=kick, sleep=no_wait, random=lambda: 0.5)
        hub.join(3, None)
        while not waits:
            await asyncio.sleep(0.01)
        await hub.aclose()
        return waits

    assert asyncio.run(scenario()) == [337.5]


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


def test_kick_upstream_speaks_centrifugo():
    """KickUpstream against a stand-in Centrifugo: the connect with the token
    and Kick's Origin, the five subscriptions, pings answered, publications
    passed on, a token refresh before expiry, and a disconnect push ending it.
    The protocol itself is kicksdk's; this checks the carrying."""
    from websockets.asyncio.server import serve

    received: list[dict] = []
    origins: list[str | None] = []

    async def kick(ws):
        origins.append(ws.request.headers.get("Origin"))
        received.append(json.loads(await ws.recv()))
        # ttl 1: kicksdk asks for a new token halfway through a short one.
        await ws.send(json.dumps({"id": 1, "connect": {"client": "c", "expires": True, "ttl": 1, "ping": 25}}))
        subs = [json.loads(line) for line in (await ws.recv()).split("\n")]
        received.extend(subs)
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
            asked: list[str] = []

            async def fake_send(req):
                asked.append(req.url)
                if req.url.endswith("/auth/connection"):
                    return 200, json.dumps({"data": {"token": next(tokens)}, "message": "success"})
                url = f"ws://127.0.0.1:{port}/connection/websocket"
                return 200, json.dumps(
                    {"data": {"connections": [{"provider": "centrifugo", "credentials": {"url": url}}]}}
                )

            up._send = fake_send
            states, events = [], []
            drop = await asyncio.wait_for(
                up(5, 6, "client-1", states.append, lambda c, e, d: events.append((c, e, d))), 5
            )
            await up.aclose()
            return drop, states, events, asked

    drop, states, events, asked = asyncio.run(scenario())
    # 3001 (shutdown) may pass: an ordinary reconnect, the same client.
    assert (drop.code, drop.terminal, drop.retry_after_ms) == (3001, False, 0)
    assert asked[0].endswith("/channels/6/chat/connection")
    assert origins == ["https://kick.com"]
    assert received[0] == {"id": 1, "connect": {"token": "t1", "name": "js"}}
    assert [r["subscribe"]["channel"] for r in received[1:6]] == kick_channels(5, 6)
    assert received[6]["refresh"] == {"token": "t2"}
    assert states == [True]
    assert events == [("chatrooms.5.v2", "App\\Events\\ChatMessageEvent", '{"id":"x"}')]


def run_against(kick, channel_id=6):
    """KickUpstream for chatroom 5 against a stand-in Centrifugo `kick`;
    returns (drop, subscribed states, events, the client ids asked for)."""
    from websockets.asyncio.server import serve

    async def scenario():
        async with serve(kick, "127.0.0.1", 0) as server:
            port = server.sockets[0].getsockname()[1]
            up = KickUpstream()
            ids: list[str] = []

            async def fake_send(req):
                body = json.loads(req.body)
                ids.append(body["client_id"] if "client_id" in body else body["client"]["id"])
                if req.url.endswith("/auth/connection"):
                    return 200, json.dumps({"data": {"token": "t"}, "message": "success"})
                url = f"ws://127.0.0.1:{port}/connection/websocket"
                return 200, json.dumps({"data": {"connections": [{"provider": "centrifugo", "credentials": {"url": url}}]}})

            up._send = fake_send
            states, events = [], []
            drop = await asyncio.wait_for(up(5, channel_id, "client-1", states.append, lambda c, e, d: events.append(e)), 5)
            await up.aclose()
            return drop, states, events, ids

    return asyncio.run(scenario())


def test_kick_upstream_takes_kicks_socket_close_code():
    """No ping announced (the session has no deadline then, and must not give
    up on a quiet feed), an unsubscribe Kick asks to resubscribe after
    (2500-2999), then the socket closed with a terminal code: retry_after_ms
    of that code, and terminal."""

    async def kick(ws):
        await ws.recv()
        await ws.send(json.dumps({"id": 1, "connect": {"client": "c"}}))  # no ping
        subs = [json.loads(line) for line in (await ws.recv()).split("\n")]
        await ws.send("\n".join(json.dumps({"id": s["id"], "subscribe": {}}) for s in subs))
        await asyncio.sleep(0.3)  # quiet
        await ws.send(json.dumps({"push": {"channel": "chatrooms.5.v2", "unsub": {"code": 2500, "reason": "resub"}}}))
        again = json.loads(await ws.recv())
        assert again["subscribe"]["channel"] == "chatrooms.5.v2"
        await ws.send(json.dumps({"id": again["id"], "subscribe": {}}))
        pub = {"event": "App\\Events\\ChatMessageEvent", "data": "{}"}
        await ws.send(json.dumps({"push": {"channel": "chatrooms.5.v2", "pub": {"data": pub}}}))
        await ws.close(4501, "banned")

    drop, states, events, _ids = run_against(kick)
    assert states == [True, False, True]
    assert events == ["App\\Events\\ChatMessageEvent"]
    assert drop == Drop(4501, "banned", True, 300_000)


def test_kick_upstream_takes_a_terminal_disconnect_and_ordinary_socket_closes():
    async def banned(ws):
        await ws.recv()
        await ws.send(json.dumps({"id": 1, "connect": {"client": "c", "ping": 25}}))
        await ws.recv()
        await ws.send(json.dumps({"push": {"disconnect": {"code": 3501, "reason": "banned"}}}))
        await asyncio.sleep(0.2)

    drop, states, _events, ids = run_against(banned)
    assert (drop.code, drop.terminal, drop.retry_after_ms) == (3501, True, 300_000)
    assert states == []
    assert set(ids) == {"client-1"}  # the connection and token requests use the id given

    async def dropped(ws):
        await ws.recv()
        await ws.close(1011, "")

    drop, _states, _events, _ids = run_against(dropped)
    assert (drop.code, drop.terminal, drop.retry_after_ms) == (1011, False, 0)
