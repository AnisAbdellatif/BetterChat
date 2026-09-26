"""BetterChat server: serves the chat site, takes heartbeats, shows the stats.

    GET  /, /<channel>, ...  the chat page (site/), real files served as-is
    GET  /privacy            the privacy policy (site/privacy.html)
    GET  /sw.js              the service worker, with the site's build hash written in
    GET  /api/build          that same hash, for the About tab to show
    POST /api/beat           heartbeat from an open chat tab
    GET  /admin              the stats board (HTTP Basic Auth)
    GET  /admin/api/stats    the JSON the board polls (HTTP Basic Auth)
    GET  /health             liveness

One process behind one hostname (betterchat.tech, through the host's Caddy
and kamal-proxy): the chat itself runs in the browser (site/kick.js talks to Kick
directly), so this server only hands out files and counts viewers.

Configuration is environment variables:

    ADMIN_USER / ADMIN_PASSWORD  both required or /admin is a 404
    STATS_PATH                   JSON file for persisted stats (data/stats.json)
    SITE_DIR                     the static site (default: ./site next to this package)
    FRAME_ANCESTORS              CSP frame-ancestors for the site (unset: no header)
    HOST / PORT                  listen address for `betterchat` (0.0.0.0:8010)
"""

import asyncio
import contextlib
import hashlib
import json
import logging
import os
import re
import secrets
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Request, Response, status
from fastapi.responses import FileResponse, JSONResponse
from fastapi.security import HTTPBasic, HTTPBasicCredentials

from .stats import VALID_BUILDS, VALID_EVENTS, VALID_SOURCES, Stats

log = logging.getLogger("betterchat")

HERE = Path(__file__).resolve().parent


def load_dotenv(path: Path | None = None) -> int:
    """Loads KEY=VALUE lines from a .env file into the environment.

    Variables already set win, so a real environment (Docker, systemd) is
    never overridden. Looks in the current directory, then next to the
    package. Returns how many variables were set.
    """
    candidates = [path] if path else [Path.cwd() / ".env", HERE.parent / ".env"]
    for candidate in candidates:
        if not candidate or not candidate.is_file():
            continue
        count = 0
        for line in candidate.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip().removeprefix("export ").strip()
            value = value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            if key and key not in os.environ:
                os.environ[key] = value
                count += 1
        log.info("loaded %d variables from %s", count, candidate)
        return count
    return 0


load_dotenv()
ADMIN_PAGE = HERE / "admin.html"
DEFAULT_SITE_DIR = HERE.parent / "site"

SLUG_RE = re.compile(r"^[a-z0-9_\-.]{1,40}$")
TAB_RE = re.compile(r"^[a-z0-9\-]{8,64}$")
MAX_MESSAGES_PER_BEAT = 100_000
SAMPLE_INTERVAL_SEC = 60
# Written in sw.js, and replaced by the site's build hash as it is served.
SW_BUILD_PLACEHOLDER = "'__BETTERCHAT_BUILD__'"

# Module level on purpose: FastAPI resolves dependency annotations by name,
# and a closure-local scheme would not be visible to it.
basic_scheme = HTTPBasic(auto_error=False)


def create_app(stats: Stats | None = None, sample_loop: bool = True) -> FastAPI:
    stats = stats or Stats(path=os.environ.get("STATS_PATH", "data/stats.json"))

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI):
        task = asyncio.create_task(_sampler(stats)) if sample_loop else None
        try:
            yield
        finally:
            if task:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
            stats.save()

    app = FastAPI(title="BetterChat", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.stats = stats

    def admin_auth(
        credentials: Annotated[HTTPBasicCredentials | None, Depends(basic_scheme)],
    ) -> None:
        user = os.environ.get("ADMIN_USER", "")
        password = os.environ.get("ADMIN_PASSWORD", "")
        if not user or not password:
            # Disabled until configured - indistinguishable from an unknown page.
            raise HTTPException(status.HTTP_404_NOT_FOUND)
        ok = (
            credentials is not None
            and secrets.compare_digest(credentials.username.encode(), user.encode())
            and secrets.compare_digest(credentials.password.encode(), password.encode())
        )
        if not ok:
            raise HTTPException(
                status.HTTP_401_UNAUTHORIZED,
                headers={"WWW-Authenticate": 'Basic realm="BetterChat admin"'},
            )

    # ------------------------------------------------------------ heartbeat --

    # Origins allowed to post heartbeats cross-origin, so the dev deployment
    # can report to this board instead of keeping its own. Space or comma
    # separated, e.g. BEAT_ORIGINS="https://dev.betterchat.tech". Unset means
    # same-origin only, which is what a lone instance wants.
    beat_origins = {
        o for o in os.environ.get("BEAT_ORIGINS", "").replace(",", " ").split() if o
    }
    if beat_origins:
        log.info("accepting heartbeats from %s", ", ".join(sorted(beat_origins)))

    @app.post("/api/beat", status_code=status.HTTP_204_NO_CONTENT)
    async def beat(request: Request) -> Response:
        # The page sends text/plain (sendBeacon / keepalive fetch need no
        # preflight that way), so parse the body ourselves.
        raw = await request.body()
        if len(raw) > 1024:
            raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE)
        try:
            payload = json.loads(raw or b"{}")
        except ValueError:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "body must be JSON")
        if not isinstance(payload, dict):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "body must be an object")

        tab = str(payload.get("tab", ""))
        channel = str(payload.get("channel", "")).lower()
        event = str(payload.get("event", ""))
        messages = payload.get("messages", 0)
        # Absent on beats from an older cached page; those are plain site tabs
        # on the stable build.
        source = str(payload.get("source", "site")) or "site"
        build = str(payload.get("build", "stable")) or "stable"
        if (
            not TAB_RE.match(tab)
            or not SLUG_RE.match(channel)
            or event not in VALID_EVENTS
            or source not in VALID_SOURCES
            or build not in VALID_BUILDS
        ):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "invalid heartbeat")
        if not isinstance(messages, int) or isinstance(messages, bool):
            messages = 0
        messages = max(0, min(messages, MAX_MESSAGES_PER_BEAT))

        stats.beat(tab, channel, event, messages, source, build)
        # The dev instance's page posts here rather than to its own board, so
        # one board answers for both. A text/plain POST is a CORS-simple
        # request and is delivered either way; naming the origin back only
        # spares the dev console a rejected-response error every five minutes.
        origin = request.headers.get("origin", "")
        headers = {"Access-Control-Allow-Origin": origin} if origin in beat_origins else {}
        return Response(status_code=status.HTTP_204_NO_CONTENT, headers=headers)

    # ---------------------------------------------------------------- admin --

    @app.get("/admin", dependencies=[Depends(admin_auth)])
    async def admin_page() -> FileResponse:
        return FileResponse(ADMIN_PAGE, media_type="text/html", headers={"Cache-Control": "no-store"})

    @app.get("/admin/api/stats", dependencies=[Depends(admin_auth)])
    async def admin_stats() -> JSONResponse:
        return JSONResponse(stats.snapshot(), headers={"Cache-Control": "no-store"})

    @app.get("/health")
    async def health() -> dict:
        return {"status": "ok", "viewers": len(stats.sessions)}

    # ----------------------------------------------------------------- site --

    site = Path(os.environ.get("SITE_DIR") or DEFAULT_SITE_DIR).resolve()
    index = site / "index.html"
    if not index.is_file():
        raise RuntimeError(f"no chat site at {site} (set SITE_DIR)")
    log.info("serving the chat site from %s", site)

    # Who may put the chat page in an iframe. Unset (the default) sends no
    # header at all, which is what a direct visit wants and leaves embedding
    # open; set it to pin embedding to the sites meant to do it, e.g.
    # FRAME_ANCESTORS="'self' https://kick.com".
    frame_ancestors = os.environ.get("FRAME_ANCESTORS", "").strip()
    frame_headers = (
        {"Content-Security-Policy": f"frame-ancestors {frame_ancestors}"} if frame_ancestors else {}
    )
    if frame_ancestors:
        log.info("restricting frame-ancestors to %s", frame_ancestors)

    # The service worker names its cache after a hash of the site, written into
    # the script here as it is served, so a change to any file under site/
    # retires every viewer's old cache without anything being bumped - see
    # site/sw.js. sw.js is left out of its own hash: a change to it already
    # changes the bytes the browser compares.
    sw_script = site / "sw.js"
    build_memo: dict = {"signature": None, "hash": ""}

    def site_build() -> str:
        files = sorted(p for p in site.rglob("*") if p.is_file() and p != sw_script)
        signature = tuple(
            (p.relative_to(site).as_posix(), st.st_size, st.st_mtime_ns)
            for p in files
            for st in (p.stat(),)
        )
        # Rehashed only when a file's size or modification time moves, so a
        # request normally costs a stat per file. In the image nothing ever
        # moves, and this hashes once.
        if signature != build_memo["signature"]:
            digest = hashlib.sha256()
            for p in files:
                digest.update(p.relative_to(site).as_posix().encode())
                digest.update(b"\0")
                digest.update(p.read_bytes())
                digest.update(b"\0")
            build_memo.update(signature=signature, hash=digest.hexdigest()[:16])
        return build_memo["hash"]

    @app.get("/sw.js")
    async def service_worker() -> Response:
        if not sw_script.is_file():
            raise HTTPException(status.HTTP_404_NOT_FOUND)
        body = sw_script.read_text(encoding="utf-8").replace(
            SW_BUILD_PLACEHOLDER, f"'{site_build()}'", 1
        )
        # no-cache: a new hash has to reach the browser as soon as there is one.
        return Response(
            body, media_type="application/javascript", headers={"Cache-Control": "no-cache"}
        )

    # The same hash the service worker names its cache after, for the About
    # tab to show. "Which build am I actually looking at" is otherwise a
    # question only the browser's cache storage can answer, and a viewer
    # reporting something is on a build neither of us can name.
    #
    # Under /api/ so the worker leaves it alone: cached, it would report the
    # build it was cached under forever, which is the one thing it must not do.
    @app.get("/api/build")
    async def build_id() -> JSONResponse:
        return JSONResponse({"build": site_build()}, headers={"Cache-Control": "no-store"})

    # Registered before the catch-all on purpose: every unknown path is the
    # chat page, so without this /privacy would be read as a channel slug and
    # the viewer would go looking for a Kick channel called "privacy".
    privacy = site / "privacy.html"

    @app.get("/privacy")
    async def privacy_page() -> FileResponse:
        if not privacy.is_file():
            raise HTTPException(status.HTTP_404_NOT_FOUND)
        return FileResponse(
            privacy,
            media_type="text/html",
            headers={"Cache-Control": "public, max-age=0, must-revalidate", **frame_headers},
        )

    @app.get("/{path:path}")
    async def site_file(path: str) -> FileResponse:
        # Real files as-is, never cached for long (no build step means the
        # names never change); anything else is the chat page, which reads
        # the channel from the URL (/xqc).
        candidate = (site / path).resolve() if path else index
        if candidate.is_file() and site in candidate.parents:
            return FileResponse(
                candidate,
                headers={"Cache-Control": "public, max-age=0, must-revalidate", **frame_headers},
            )
        return FileResponse(
            index, media_type="text/html", headers={"Cache-Control": "no-cache", **frame_headers}
        )

    return app


async def _sampler(stats: Stats) -> None:
    while True:
        await asyncio.sleep(SAMPLE_INTERVAL_SEC)
        try:
            await asyncio.to_thread(stats.sample)
        except Exception:  # noqa: BLE001 - never let the sampler die
            log.exception("stats sample failed")


def run() -> None:
    """`betterchat` console script."""
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    # factory=True: the app is built when the server starts, not when this
    # module is imported, so a bad SITE_DIR fails loudly at startup instead
    # of breaking every import (tests included).
    uvicorn.run(
        "betterchat.main:create_app",
        factory=True,
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8010")),
        proxy_headers=True,
        forwarded_allow_ips="*",
    )
