# BetterChat: the chat site + admin/stats server, one container.
#
#   docker compose up -d --build      (see docker-compose.yml + .env.example)
#
# No apt-get anywhere: the uv base image already has Python, and every
# dependency is a pure wheel.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy PYTHONUNBUFFERED=1

WORKDIR /app

# Dependencies first so they cache independently of the app code.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY betterchat betterchat
COPY site site
COPY README.md ./
RUN uv sync --frozen --no-dev

RUN mkdir -p /app/data && chown -R nobody /app/data
USER nobody

ENV STATS_PATH=/app/data/stats.json
ENV SITE_DIR=/app/site
ENV PORT=8010
EXPOSE 8010

# Run the installed entry point directly: no uv at runtime, so the
# unprivileged user needs no uv cache directory.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/app/.venv/bin/python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8010/health', timeout=4).status==200 else 1)"]

CMD ["/app/.venv/bin/betterchat"]
