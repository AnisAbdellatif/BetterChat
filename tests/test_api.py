import base64
import os

import pytest
from fastapi.testclient import TestClient

from betterchat.main import create_app
from betterchat.stats import Stats


@pytest.fixture
def site(tmp_path, monkeypatch):
    site = tmp_path / "site"
    site.mkdir()
    (site / "index.html").write_text("<title>BetterChat</title>")
    (site / "app.js").write_text("// js")
    monkeypatch.setenv("SITE_DIR", str(site))
    return site


@pytest.fixture
def client(monkeypatch, tmp_path, site):
    monkeypatch.setenv("ADMIN_USER", "me")
    monkeypatch.setenv("ADMIN_PASSWORD", "s3cret")
    app = create_app(Stats(path=str(tmp_path / "stats.json")), sample_loop=False)
    with TestClient(app) as c:
        yield c


def auth(user="me", password="s3cret"):
    token = base64.b64encode(f"{user}:{password}".encode()).decode()
    return {"Authorization": f"Basic {token}"}


def test_beat_is_accepted_as_text_plain_and_counted(client):
    body = '{"tab":"tab-aaaaaaaa","channel":"XQC","event":"join","messages":0}'
    r = client.post("/api/beat", content=body, headers={"content-type": "text/plain"})
    assert r.status_code == 204
    r = client.post(
        "/api/beat",
        content='{"tab":"tab-aaaaaaaa","channel":"xqc","event":"beat","messages":12}',
        headers={"content-type": "text/plain"},
    )
    assert r.status_code == 204
    snap = client.get("/admin/api/stats", headers=auth()).json()
    assert snap["current"]["viewers"] == 1
    assert snap["channels"][0]["slug"] == "xqc"
    assert snap["channels"][0]["messages"] == 12


def test_beat_rejects_garbage(client):
    assert client.post("/api/beat", content="not json").status_code == 400
    assert client.post("/api/beat", content='{"tab":"x","channel":"xqc","event":"join"}').status_code == 400
    assert client.post("/api/beat", content='{"tab":"tab-aaaaaaaa","channel":"../etc","event":"join"}').status_code == 400
    assert client.post("/api/beat", content='{"tab":"tab-aaaaaaaa","channel":"xqc","event":"nope"}').status_code == 400
    assert (
        client.post(
            "/api/beat",
            content='{"tab":"tab-aaaaaaaa","channel":"xqc","event":"join","source":"nope"}',
        ).status_code
        == 400
    )
    assert client.post("/api/beat", content="x" * 2000).status_code == 413


def test_admin_requires_credentials(client):
    assert client.get("/admin").status_code == 401
    assert client.get("/admin", headers=auth(password="nope")).status_code == 401
    r = client.get("/admin", headers=auth())
    assert r.status_code == 200
    assert "BetterChat admin" in r.text
    assert "/admin/api/stats" in r.text  # absolute: /admin has no trailing slash
    assert client.get("/admin/api/stats", headers=auth()).status_code == 200


def test_shutdown_persists_stats(monkeypatch, tmp_path, site):
    path = tmp_path / "stats.json"
    app = create_app(Stats(path=str(path)), sample_loop=False)
    with TestClient(app) as c:
        c.post("/api/beat", content='{"tab":"tab-aaaaaaaa","channel":"xqc","event":"join"}')
        assert not path.exists()
    # Leaving the context runs the lifespan shutdown, which saves.
    assert path.exists()
    assert '"xqc"' in path.read_text()


def test_admin_is_404_when_not_configured(monkeypatch, tmp_path, site):
    monkeypatch.delenv("ADMIN_USER", raising=False)
    monkeypatch.delenv("ADMIN_PASSWORD", raising=False)
    app = create_app(Stats(path=None), sample_loop=False)
    with TestClient(app) as c:
        assert c.get("/admin").status_code == 404
        assert c.get("/admin/api/stats", headers=auth()).status_code == 404
        assert c.get("/health").json()["status"] == "ok"


def test_serves_the_site_with_spa_fallback(client):
    assert client.get("/app.js").text == "// js"
    assert "<title>BetterChat</title>" in client.get("/xqc").text
    assert "<title>BetterChat</title>" in client.get("/").text
    assert client.get("/xqc").headers["cache-control"] == "no-cache"
    # Path traversal never escapes the site directory.
    assert "<title>BetterChat</title>" in client.get("/../pyproject.toml").text


def test_dotenv_sets_missing_variables_only(monkeypatch, tmp_path):
    from betterchat.main import load_dotenv

    env = tmp_path / ".env"
    env.write_text('# comment\nADMIN_USER=fromfile\nADMIN_PASSWORD="quoted value"\nexport PORT=9999\n\nbroken line\n')
    monkeypatch.delenv("ADMIN_USER", raising=False)
    monkeypatch.delenv("ADMIN_PASSWORD", raising=False)
    monkeypatch.setenv("PORT", "1234")
    assert load_dotenv(env) == 2
    assert os.environ["ADMIN_USER"] == "fromfile"
    assert os.environ["ADMIN_PASSWORD"] == "quoted value"
    assert os.environ["PORT"] == "1234"  # real environment wins
    assert load_dotenv(tmp_path / "missing.env") == 0


def test_refuses_to_start_without_a_site(monkeypatch, tmp_path):
    monkeypatch.setenv("SITE_DIR", str(tmp_path / "nowhere"))
    with pytest.raises(RuntimeError):
        create_app(Stats(path=None), sample_loop=False)


def test_default_site_dir_is_the_repo_site(monkeypatch):
    monkeypatch.delenv("SITE_DIR", raising=False)
    app = create_app(Stats(path=None), sample_loop=False)
    with TestClient(app) as c:
        assert "<title>BetterChat</title>" in c.get("/xqc").text
        assert c.get("/kick.js").status_code == 200


def test_embedded_beat_is_counted_separately(client):
    """The chat page in an iframe on kick.com reports source=embed."""
    client.post("/api/beat", content='{"tab":"tab-aaaaaaaa","channel":"xqc","event":"join"}')
    client.post(
        "/api/beat",
        content='{"tab":"tab-bbbbbbbb","channel":"xqc","event":"join","source":"embed"}',
    )
    snap = client.get("/admin/api/stats", headers=auth()).json()
    assert snap["current"]["viewers"] == 2
    assert snap["current"]["by_source"] == {"site": 1, "embed": 1}
    assert snap["channels"][0]["embedded"] == 1


def test_frame_ancestors_header_is_opt_in(monkeypatch, tmp_path, site):
    # Not just unset in this process - a developer's own .env is loaded at import.
    monkeypatch.delenv("FRAME_ANCESTORS", raising=False)
    app = create_app(Stats(path=None), sample_loop=False)
    with TestClient(app) as c:
        assert "content-security-policy" not in c.get("/xqc").headers

    monkeypatch.setenv("FRAME_ANCESTORS", "'self' https://kick.com")
    app = create_app(Stats(path=None), sample_loop=False)
    with TestClient(app) as c:
        for path in ("/xqc", "/app.js"):
            assert c.get(path).headers["content-security-policy"] == (
                "frame-ancestors 'self' https://kick.com"
            )
