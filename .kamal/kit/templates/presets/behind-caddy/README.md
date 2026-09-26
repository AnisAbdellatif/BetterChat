# Preset: kamal-proxy behind Caddy

For a server whose own Caddy already holds ports 80/443 (for other sites,
or because you want Caddy's features), with Kamal's proxy doing the
zero-downtime swaps behind it:

```
Internet ─443─► Caddy (TLS, the host's) ─► 127.0.0.1:8080 kamal-proxy ─► the app's containers
                                          (routes by Host header)      (swapped with no downtime)
```

`kit init --preset behind-caddy` copies these files into
`.kamal/presets/behind-caddy/`, and `deploy.yml` to `config/deploy.yml`
if the project has none yet.

| File | Goes |
|---|---|
| `deploy.yml` | `config/deploy.yml`: the `proxy:` block is the preset; fill the placeholders |
| `Caddyfile.host` | the host's Caddyfile (or a file it imports) |
| `Caddyfile.container` | instead of the above, when Caddy runs in a container |
| `kit.env` | appended to `.kamal/kit.env` (the smoke test URL) |

## Four things to get right

1. **One kamal-proxy per server**, shared by every Kamal app deployed
   there. Its `proxy.run` settings (ports, bind address) are the server's,
   not the app's: every project on that server must use the same `run`
   block. Each adds its own `host`, and kamal-proxy routes between them.
2. **The app is behind two proxies.** `X-Forwarded-For` reaches it as
   `<visitor>, <Caddy>`: the visitor is the second entry from the right.
   Tell the app to trust both proxies when it reads the address, or every
   visitor looks like Caddy's to rate limits and logs. Rails:
   `config.action_dispatch.trusted_proxies` (loopback and the Docker
   network are trusted by default); Phoenix: whatever reads the header
   (e.g. `RemoteIp` with its proxies, or a hop count of 2); Django:
   `SECURE_PROXY_SSL_HEADER` and your X-Forwarded-For handling.
3. **HTTPS is Caddy's.** The app sees plain HTTP from kamal-proxy with
   `X-Forwarded-Proto: https`; an app that forces SSL must trust that
   header, or it redirects forever. Keep its health check path out of any
   redirect (`/up` is exempt in Rails; exempt yours in Phoenix's
   `force_ssl`).
4. **Only 22, 80 and 443 are open.** kamal-proxy's ports are bound to
   loopback (`bind_ips: [127.0.0.1]`), so the firewall of deploy-kit's
   host setup needs no change. Docker would publish past `ufw` otherwise.

## With deploy-kit

Roles behind kamal-proxy are plain roles: kamal-proxy does their swap, so
they need no group. `kit deploy` runs `kamal deploy` for them with the
checks before and the smoke tests after; point `KIT_SMOKE_URLS` at the
public URL so the check goes through Caddy and kamal-proxy as a visitor
does. Groups remain for what kamal-proxy can't do: a standby group for a
worker where exactly one may be active, a rolling group for roles on
fixed ports behind Caddy directly.

## Versus the app behind Caddy directly

| | Behind kamal-proxy (this preset) | Behind Caddy directly (rolling group) |
|---|---|---|
| Web containers | one, swapped by kamal-proxy | two or more, replaced one at a time |
| Load balancing, stickiness | kamal-proxy's (per host) | Caddy's (`lb_policy`, `ip_hash`, active health checks) |
| Proxy hops to the app | two | one |
| Moving parts | fewer | more, but all in Caddy |

Take this preset unless you need Caddy's load balancing across several
containers (visitor stickiness, a failover order between upstreams).
