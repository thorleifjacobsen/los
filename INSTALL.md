# Installing los on a machine

los runs as a small Docker Compose stack: the app (`los`), a private search engine (`los-searxng`) and, optionally,
a headless browser for pages that need JavaScript (`los-browser`). Everything it keeps is in two folders, `config/`
and `data/`, next to `docker-compose.yml`. Moving los means moving this folder.

> Planned: los will later run as its own machine that it manages itself (installing software with apt and so on),
> not just a container. This guide covers the Docker setup used today.

## What you need

- Linux with Docker Engine and the Compose plugin (`docker compose version`).
- About 1 GB of free RAM (los ~150 MB, SearXNG ~120 MB, the optional browser 40 MB idle and a few hundred MB while
  rendering). Claude Code, Codex and opencode run inside the los container.
- A user with **uid 1000** that owns the los folder. The container runs as `node` (uid 1000), so `data/` must be
  writable by uid 1000. Check with `id -u`.
- HTTPS in front of it, or open it as `http://localhost:7001` only. The login cookie is `Secure`: over plain http
  from another machine the browser won't keep it and you can't stay logged in.
- At least one brain:
  - **Claude** (Los uses it): a Claude subscription logged in with Claude Code, either on the host (shared login,
    see step 4) or from the Brains page inside los.
  - **opencode's free models** (Mira and Finn use them): nothing to set up.
  - Optional: an API key (OpenAI-compatible, Anthropic) or a local Ollama.

## 1. Get the files

Copy the los folder to the new machine, without `node_modules/` (it's rebuilt in the image):

```bash
# on the old machine
cd /var/www && tar --exclude=los/node_modules -czf los.tgz los
# on the new machine
mkdir -p ~/apps && tar -xzf los.tgz -C ~/apps && cd ~/apps/los
```

For a fresh install (no old data), leave out `data/` and `config/`. On first start los fills `config/` from the
shipped defaults in `config.example/` (the brains, the agents `config/agents/*.md` and the MCP servers). `config/` is
this installation's own setup (edited from the UI) and isn't in git; existing files are never overwritten.

## 2. (Nothing to do here any more)

The stack creates its own network (`los`) on `docker compose up`. Older versions needed a shared `infra` network;
not any more.

## 3. `.env`

Create `.env` next to `docker-compose.yml`, readable only by you:

```bash
umask 077
cat > .env <<EOF
SEARXNG_SECRET=$(openssl rand -hex 32)
CLAUDE_DIR=$HOME/.claude
EOF
```

- `SEARXNG_SECRET` is required (compose refuses to start without it).
- `CLAUDE_DIR` is the host's Claude Code folder, shared with the container so los can use that login. Default:
  `/home/deploy/.claude`. If the folder doesn't exist yet, create it (`mkdir -p ~/.claude`).

## 4. Claude login (for Los)

Pick one:

- **Share the host's login:** install Claude Code on the host (`npm i -g @anthropic-ai/claude-code`), run `claude`
  once and log in. The `claude-code` brain uses it. Don't log out on the host casually: los would be logged out too.
- **Log in from los:** after step 6, open **Brains**, pick a Claude brain with its own `account`
  (e.g. `claude-2`) and use **Log in**. It's kept in `data/accounts/<brain>/`. Point Los at that brain on the
  **Team** page.

## 5. Start it

```bash
docker compose up -d --build                     # los + searxng
docker compose --profile browser up -d browser   # optional: headless Chrome for JavaScript pages
```

Check: `curl -s localhost:7001/api/health` prints `ok`. Logs: `docker logs -f los`.

`config/settings.yaml` should point at the two services (it does in the shipped defaults):

```yaml
web:
  searxng_url: http://searxng:8080
  browser_url: http://browser:9222   # remove this line if you don't run the browser
timezone: Europe/Oslo
default_agent: los
```

### Workspace pages that save things (optional)

Pages in the workspace (a tracker, a small app an agent built) are shown sandboxed from los's own address, where the
browser blocks `localStorage`. To let them keep data, give them their own address, a second hostname pointing to the
same container:

**With a second hostname** (if you have DNS/subdomains):

1. DNS: e.g. `los-files.example.lan` → the same machine (one level below your domain if it sits behind Cloudflare).
2. Caddy: a site for it, the same as los's (`reverse_proxy localhost:7001`, `tls internal`).
3. `config/settings.yaml`: `web: files_url: https://los-files.example.lan`.

**With a second port** (no subdomains, e.g. everything on `localhost`; another port is another origin):

1. `.env`: `FILES_PORT=7002`, and uncomment the `127.0.0.1:7002:7002` line in `docker-compose.yml`.
2. `config/settings.yaml`: `web: files_url: http://localhost:7002` (or your HTTPS proxy for that port).
3. `docker compose up -d`.

Workspace links then open there. That address serves only workspace files, never los itself, and your login doesn't
apply there. It's also where **share links** point: a file or folder you mark 🌐 shared on the Workspace page gets a permanent
link with a random id that anyone can open, until you switch sharing off.

## 6. Set the login password

```bash
docker exec -it los npm run password -- toffe
```

(Any username works; there's one user.) Running it again changes the password, logs every session out and turns
two-factor login off (your way back in if you lose your phone).

Then log in and open **Profile**: set the name the agents call you (their personalities say `{{name}}`), and turn on
**two-factor login** (scan the QR code with an authenticator app, save the recovery codes).

Agents can only fetch from the public internet. To let them reach something on your own network (a NAS, a Home
Assistant), list its host name in `config/settings.yaml` under `web: allow_internal: [nas.lan]`.

## 7. Reach it

The app listens on `127.0.0.1:7001` only. Put a reverse proxy with HTTPS in front of it. With Caddy:

```caddyfile
los.example.lan {
    reverse_proxy localhost:7001
    tls internal
}
```

`tls internal` uses Caddy's own certificate authority (trust it once on your devices). On a home network that's
enough; nothing has to be reachable from the internet.

## 8. Check that it works

- Open los, start a chat: Los should answer.
- Ask `@mira what does a Raspberry Pi 5 cost at komplett.no?`: she should search (SearXNG), read the shop page
  and give a price. Open **Inspect** under her answer to see every call and result.
- Smoke test (no real brains needed): `docker run --rm -v $PWD/config.example:/app/config:ro --entrypoint node_modules/.bin/tsx los test/smoke.ts`

## Moving from the old server

1. Stop los there so nothing writes while you copy: `docker compose stop los`.
2. Copy the database safely and the rest of `data/`:
   ```bash
   sqlite3 data/los.db ".backup /tmp/los.db"     # a consistent copy, even with WAL
   ```
   Take `/tmp/los.db` (as `data/los.db`), `data/workspace/`, `data/accounts/`, `data/auth.json`,
   `data/brain-env.json` (both 0600: they hold the login secret and API keys), `config/` and `.env`.
3. On the new machine: steps 2, 3 (keep the copied `.env`, adjust `CLAUDE_DIR`), 5 and 7. The password and all
   chats come along. Database migrations run on start.

## Updating

Code changes (`src/`, `web/`) need a rebuild: `docker compose up -d --build los`. `config/` and `data/` are mounted,
so they survive. Before a big change, back up the database:
`sqlite3 data/los.db ".backup data/backups/los-$(date +%F).db"`.

## Where things are

| Path | What |
|---|---|
| `config/settings.yaml` | brains, timezone, web search/browser, privacy |
| `config/agents/<name>.md` | one agent each: `brain`, optional `emoji`, and the personality |
| `config/mcp.json` | external MCP servers |
| `config.example/` | the shipped defaults `config/` is filled from on first start (in git; `config/` isn't) |
| `services/searxng/settings.yml` | SearXNG config (JSON API on, limiter off) |
| `data/los.db` | everything said and done (SQLite) |
| `data/workspace/` | files you and the agents share |
| `data/accounts/` | logins for brains that have their own account |
| `data/auth.json`, `data/brain-env.json` | login secret, brain API keys (keep private) |
| `.env` | `SEARXNG_SECRET`, `CLAUDE_DIR` |
