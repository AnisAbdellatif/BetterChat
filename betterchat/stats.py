"""Usage statistics built from viewer heartbeats.

The chat page runs in the browser and talks to Kick directly, so nothing
sees viewers pass through anymore. Instead every open chat tab sends small
heartbeats here: `join` when it subscribes to a channel, `beat` every few
minutes while open, and `leave` when the tab closes (via `sendBeacon`).

From those we keep:

* live sessions (tab -> channel), expiring after `session_ttl` without a
  beat, so a crashed tab still drops out;
* per-channel totals: peak concurrent viewers, joins, watch time, messages;
* a 1-minute time series of viewers / channels watched (last 24h);
* joins per hour (last 24h).

Message counts: every viewer of a channel sees the same messages, so the
per-minute count is the MAX delta any viewer reported for that minute, not
the sum - the sum would multiply the real rate by the viewer count.

Everything is persisted to a JSON file once a minute and on shutdown (atomic
rename), and loaded on start, so restarts only lose the live session set.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from typing import Callable

log = logging.getLogger(__name__)

SESSION_TTL_SEC = 7 * 60  # heartbeats come every 5 min
MAX_SAMPLES = 24 * 60
HOUR = 3600
VALID_EVENTS = ("join", "beat", "leave")
# Where the tab is running: the site itself, or the chat page embedded in an
# iframe on kick.com. Beats without a source are counted as "site".
VALID_SOURCES = ("site", "embed")


class Stats:
    def __init__(
        self,
        path: str | None,
        session_ttl: int = SESSION_TTL_SEC,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._lock = threading.Lock()
        self.path = path
        self.session_ttl = session_ttl
        self.clock = clock
        now = int(clock())
        self.started_at = now
        self.first_started_at = now
        self.sessions: dict[str, dict] = {}  # tab -> {channel, joined_at, last_seen}
        self.channels: dict[str, dict] = {}  # slug -> {peak, joins, watch_seconds, messages, last_seen}
        self.samples: list[dict] = []  # oldest first
        self.hourly_joins: dict[int, int] = {}  # hour start (epoch sec) -> joins
        self.minute_messages: dict[tuple[str, int], int] = {}  # (slug, minute) -> max delta
        self.load()

    # ---------------------------------------------------------------- input --

    def beat(self, tab: str, channel: str, event: str, messages: int = 0, source: str = "site") -> None:
        """Record one heartbeat. `messages` is the viewer's count since its last beat."""
        if event not in VALID_EVENTS:
            raise ValueError(f"unknown event {event!r}")
        if source not in VALID_SOURCES:
            raise ValueError(f"unknown source {source!r}")
        now = int(self.clock())
        with self._lock:
            session = self.sessions.get(tab)

            if event == "leave":
                if session is not None:
                    self._note_messages(session["channel"], now, messages)
                    self._end_session(tab, now)
                return

            if session is None or session["channel"] != channel:
                # A beat from a tab we don't know (we restarted, or it changed
                # channel without leaving) counts as a fresh join.
                if session is not None:
                    self._end_session(tab, now)
                self._start_session(tab, channel, now, source)
            else:
                session["last_seen"] = now
                self.channels[channel]["last_seen"] = now

            self._note_messages(channel, now, messages)

    def _start_session(self, tab: str, channel: str, now: int, source: str = "site") -> None:
        self.sessions[tab] = {"channel": channel, "joined_at": now, "last_seen": now, "source": source}
        c = self.channels.setdefault(
            channel, {"peak": 0, "joins": 0, "watch_seconds": 0, "messages": 0, "last_seen": now}
        )
        c["joins"] += 1
        c["last_seen"] = now
        c["peak"] = max(c["peak"], self._viewers_of(channel))
        hour = now - now % HOUR
        self.hourly_joins[hour] = self.hourly_joins.get(hour, 0) + 1

    def _end_session(self, tab: str, now: int) -> None:
        session = self.sessions.pop(tab, None)
        if session is None:
            return
        c = self.channels.get(session["channel"])
        if c is not None:
            c["watch_seconds"] += max(0, now - session["joined_at"])
            c["last_seen"] = now

    def _note_messages(self, channel: str, now: int, messages: int) -> None:
        if messages <= 0 or channel not in self.channels:
            return
        key = (channel, now - now % 60)
        self.minute_messages[key] = max(self.minute_messages.get(key, 0), messages)

    def _viewers_of(self, channel: str) -> int:
        return sum(1 for s in self.sessions.values() if s["channel"] == channel)

    # -------------------------------------------------------- housekeeping --

    def expire(self) -> int:
        """Drops sessions that stopped beating. Returns how many."""
        now = int(self.clock())
        with self._lock:
            stale = [tab for tab, s in self.sessions.items() if now - s["last_seen"] > self.session_ttl]
            for tab in stale:
                self._end_session(tab, now)
            return len(stale)

    def sample(self) -> None:
        """Once a minute: expire, fold message minutes, append a sample, save."""
        self.expire()
        now = int(self.clock())
        with self._lock:
            current_minute = now - now % 60
            for (slug, minute), count in list(self.minute_messages.items()):
                if minute < current_minute:
                    if slug in self.channels:
                        self.channels[slug]["messages"] += count
                    del self.minute_messages[(slug, minute)]

            self.samples.append(
                {"t": now, "viewers": len(self.sessions), "channels": self._active_channel_count()}
            )
            del self.samples[:-MAX_SAMPLES]

            cutoff = now - 25 * HOUR
            self.hourly_joins = {h: n for h, n in self.hourly_joins.items() if h >= cutoff}
        self.save()

    def _active_channel_count(self) -> int:
        return len({s["channel"] for s in self.sessions.values()})

    # --------------------------------------------------------------- output --

    def snapshot(self) -> dict:
        now = int(self.clock())
        with self._lock:
            live: dict[str, int] = {}
            embedded: dict[str, int] = {}
            by_source = dict.fromkeys(VALID_SOURCES, 0)
            for s in self.sessions.values():
                live[s["channel"]] = live.get(s["channel"], 0) + 1
                source = s.get("source", "site")
                by_source[source] = by_source.get(source, 0) + 1
                if source == "embed":
                    embedded[s["channel"]] = embedded.get(s["channel"], 0) + 1

            pending: dict[str, int] = {}
            for (slug, _minute), count in self.minute_messages.items():
                pending[slug] = pending.get(slug, 0) + count

            channels = [
                {
                    "slug": slug,
                    "current": live.get(slug, 0),
                    "embedded": embedded.get(slug, 0),
                    "peak": c["peak"],
                    "joins": c["joins"],
                    "watch_hours": round(c["watch_seconds"] / 3600, 2),
                    "messages": c["messages"] + pending.get(slug, 0),
                    "last_seen": c["last_seen"],
                }
                for slug, c in self.channels.items()
            ]
            channels.sort(key=lambda c: (-c["current"], -c["joins"], c["slug"]))

            return {
                "now": now,
                "started_at": self.started_at,
                "first_started_at": self.first_started_at,
                "uptime_sec": now - self.started_at,
                "current": {
                    "viewers": len(self.sessions),
                    "channels_watched": len(live),
                    "by_source": by_source,
                    "messages_total": sum(c["messages"] for c in channels),
                },
                "totals": {
                    "joins": sum(c["joins"] for c in self.channels.values()),
                    "channels_seen": len(self.channels),
                    "watch_hours": round(
                        sum(c["watch_seconds"] for c in self.channels.values()) / 3600, 2
                    ),
                },
                "channels": channels,
                "samples": list(self.samples),
                "hourly_joins": [
                    {"t": h, "joins": n} for h, n in sorted(self.hourly_joins.items())
                ],
            }

    # ---------------------------------------------------------- persistence --

    def save(self) -> None:
        if not self.path:
            return
        with self._lock:
            data = {
                "version": 1,
                "first_started_at": self.first_started_at,
                "channels": self.channels,
                "samples": self.samples,
                "hourly_joins": [[h, n] for h, n in self.hourly_joins.items()],
            }
        tmp = self.path + ".tmp"
        try:
            os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f)
            os.replace(tmp, self.path)
        except OSError as e:
            log.warning("could not persist stats to %s: %s", self.path, e)

    def load(self) -> None:
        if not self.path:
            return
        try:
            with open(self.path, encoding="utf-8") as f:
                data = json.load(f)
        except FileNotFoundError:
            return
        except (OSError, ValueError) as e:
            log.warning("ignoring unreadable stats file %s: %s", self.path, e)
            return
        if not isinstance(data, dict) or data.get("version") != 1:
            log.warning("ignoring stats file %s with unknown format", self.path)
            return
        with self._lock:
            self.channels = {
                slug: {
                    "peak": int(c.get("peak", 0)),
                    "joins": int(c.get("joins", 0)),
                    "watch_seconds": int(c.get("watch_seconds", 0)),
                    "messages": int(c.get("messages", 0)),
                    "last_seen": c.get("last_seen"),
                }
                for slug, c in (data.get("channels") or {}).items()
            }
            self.samples = [
                {"t": s["t"], "viewers": s["viewers"], "channels": s["channels"]}
                for s in (data.get("samples") or [])
            ][-MAX_SAMPLES:]
            self.hourly_joins = {int(h): int(n) for h, n in (data.get("hourly_joins") or [])}
            self.first_started_at = int(data.get("first_started_at") or self.first_started_at)
        log.info("loaded persisted stats from %s (%d channels)", self.path, len(self.channels))
