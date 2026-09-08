import json

from betterchat.stats import Stats


class Clock:
    def __init__(self, t=1_700_000_000):
        self.t = t

    def __call__(self):
        return self.t


def make(tmp_path=None, ttl=420):
    clock = Clock()
    path = str(tmp_path / "stats.json") if tmp_path else None
    return Stats(path=path, session_ttl=ttl, clock=clock), clock


def test_join_beat_leave_tracks_viewers_and_watch_time():
    stats, clock = make()
    stats.beat("tab-aaaaaaaa", "xqc", "join")
    stats.beat("tab-bbbbbbbb", "xqc", "join")
    snap = stats.snapshot()
    assert snap["current"]["viewers"] == 2
    assert snap["current"]["channels_watched"] == 1
    assert snap["channels"][0] == {
        "slug": "xqc",
        "current": 2,
        "peak": 2,
        "joins": 2,
        "watch_hours": 0.0,
        "messages": 0,
        "last_seen": clock.t,
    }

    clock.t += 3600
    stats.beat("tab-aaaaaaaa", "xqc", "leave")
    snap = stats.snapshot()
    assert snap["current"]["viewers"] == 1
    assert snap["channels"][0]["peak"] == 2
    assert snap["channels"][0]["watch_hours"] == 1.0


def test_beat_from_unknown_tab_counts_as_join_and_channel_switch_ends_old_session():
    stats, clock = make()
    stats.beat("tab-aaaaaaaa", "xqc", "beat")
    assert stats.snapshot()["channels"][0]["joins"] == 1

    clock.t += 60
    stats.beat("tab-aaaaaaaa", "clix", "join")
    snap = {c["slug"]: c for c in stats.snapshot()["channels"]}
    assert snap["xqc"]["current"] == 0
    assert snap["clix"]["current"] == 1
    assert stats.snapshot()["current"]["viewers"] == 1


def test_sessions_expire_without_beats():
    stats, clock = make(ttl=100)
    stats.beat("tab-aaaaaaaa", "xqc", "join")
    clock.t += 50
    assert stats.expire() == 0
    clock.t += 60
    assert stats.expire() == 1
    assert stats.snapshot()["current"]["viewers"] == 0
    assert stats.snapshot()["channels"][0]["watch_hours"] == round(110 / 3600, 2)


def test_messages_use_max_per_minute_not_sum_across_viewers():
    stats, clock = make()
    stats.beat("tab-aaaaaaaa", "xqc", "join")
    stats.beat("tab-bbbbbbbb", "xqc", "join")
    stats.beat("tab-aaaaaaaa", "xqc", "beat", messages=40)
    stats.beat("tab-bbbbbbbb", "xqc", "beat", messages=37)
    assert stats.snapshot()["channels"][0]["messages"] == 40  # pending minute counts too

    clock.t += 120
    stats.sample()  # folds the old minute into the total
    assert stats.snapshot()["channels"][0]["messages"] == 40
    assert stats.snapshot()["current"]["messages_total"] == 40


def test_sample_series_and_hourly_joins():
    stats, clock = make()
    stats.beat("tab-aaaaaaaa", "xqc", "join")
    stats.sample()
    snap = stats.snapshot()
    assert snap["samples"] == [{"t": clock.t, "viewers": 1, "channels": 1}]
    assert snap["hourly_joins"] == [{"t": clock.t - clock.t % 3600, "joins": 1}]


def test_persist_and_reload(tmp_path):
    stats, clock = make(tmp_path)
    stats.beat("tab-aaaaaaaa", "xqc", "join")
    stats.beat("tab-aaaaaaaa", "xqc", "beat", messages=5)
    clock.t += 120
    stats.sample()  # saves
    raw = json.loads((tmp_path / "stats.json").read_text())
    assert raw["version"] == 1
    assert raw["channels"]["xqc"]["joins"] == 1

    reloaded = Stats(path=str(tmp_path / "stats.json"), clock=clock)
    snap = reloaded.snapshot()
    assert snap["current"]["viewers"] == 0  # live sessions don't survive
    assert snap["channels"][0]["joins"] == 1
    assert snap["channels"][0]["messages"] == 5
    assert snap["first_started_at"] == 1_700_000_000
    assert len(snap["samples"]) == 1


def test_unknown_event_is_rejected():
    stats, _ = make()
    try:
        stats.beat("tab-aaaaaaaa", "xqc", "explode")
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError")
