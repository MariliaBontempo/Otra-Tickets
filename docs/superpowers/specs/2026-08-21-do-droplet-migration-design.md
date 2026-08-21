# otratickets.com: Cloudflare Pages to DigitalOcean droplet

Date: 2026-08-21
Status: Approved (Brian, in-chat, 2026-08-21)
Notion task: https://app.notion.com/p/3c38bd985cfb8170b789f77c9196b6e4

## Summary

Move otratickets.com off Cloudflare Pages onto a dedicated droplet on the
DigitalOcean **Otra Guide team**, so the site runs next to the resources it
already depends on (the Django API on otraguide.com, managed Postgres, Spaces).
Cloudflare keeps DNS and its proxy/CDN role. Traffic cuts over the same day;
the Pages project stays alive as an instant rollback target.

## Goals

- otratickets.com served from DO (nyc3), sharing the Otra Guide team's VPC.
- All current behavior preserved: event page HTML injection, feed snapshot
  fast path, sitemap/robots/llms.txt, admin API, media uploads and serving.
- Marilia's workflow unchanged: merge to main is still the only deploy step.
- Rollback to Cloudflare Pages is a single DNS record flip.
- otraguide.com is never in the blast radius at any step.

## Non-goals

- Leaving Cloudflare entirely (DNS/proxy stays; separate decision later).
- Retiring the sfo3 stack or touching any existing droplet or database
  contents.
- Any change to the Django API or the Flutter apps.

## Decisions (locked)

1. **New dedicated droplet**, not co-hosting on otraguide-nyc-web-1.
   Separate but connected: same VPC, isolated fate.
2. **State backends**: Cloudflare KV moves to a `kv` table in a new logical
   database `otratickets` inside the existing `otraguide-nyc-pg` managed
   cluster; R2 media moves to a new Space `otratickets-media` (nyc3).
3. **Stack**: Caddy + Node 22 under systemd, deployed by GitHub Actions.
4. **Cloudflare proxy stays ON** (orange cloud) with a Cloudflare Origin
   Certificate on the droplet.

## Architecture

```
Browser
  |
Cloudflare (DNS, proxy, edge cache, DDoS)      [unchanged]
  |  HTTPS to origin (Cloudflare Origin Certificate)
Droplet otratickets-web-1 (nyc3, VPC otraguide-nyc3)
  |
  Caddy :443
    - TLS termination (origin cert)
    - compression, access logs
    - reverse_proxy -> 127.0.0.1:8788
  |
  Node 22 service "otratickets" (systemd)
    - Pages-compatibility router over the existing functions/ code (unchanged)
    - env.OVERRIDES        -> Postgres kv table (private VPC hostname)
    - env.OVERRIDE_IMAGES  -> Spaces bucket otratickets-media (S3 API)
    - env.ASSETS           -> static serving of dist/
    - env.OTRA_API_URL     -> https://otraguide.com (admin auth, unchanged)
```

Caddy proxies **everything** to Node rather than serving static files itself.
This preserves Cloudflare Pages routing semantics exactly (function routes
first, static assets as fallback), which is what keeps `[slug].js` HTML
injection working for every event page with zero routing surprises. Node
serves dist/ through the ASSETS shim; Cloudflare's edge does the heavy
caching above us.

## Components

### Node service (new code, lives in `server/` in this repo)

- **Router**: maps requests to the existing `functions/` modules using
  Cloudflare Pages conventions: exact file routes (`api/homepage-events.js`),
  dynamic segments (`[slug].js`), catch-alls (`override-images/[[path]].js`),
  and `_lib/` excluded from routing. Builds a Pages-shaped `context`
  (`request`, `env`, `params`, `next`, `waitUntil`).
- **KV shim** (`env.OVERRIDES`): implements `get`, `getWithMetadata`, `put`
  (with `metadata`), `delete`, `list` against Postgres table
  `kv(key text primary key, value bytea, metadata jsonb, updated_at)`.
  Supports the `"text"`, `"json"`, and `"arrayBuffer"` read types the
  functions use.
- **R2 shim** (`env.OVERRIDE_IMAGES`): implements `put(key, stream, opts)`
  and `get(key)` returning `{ body, contentType, httpMetadata }` against
  Spaces via the AWS S3 SDK.
- **ASSETS shim**: `env.ASSETS.fetch(request)` serves files from `dist/`
  with correct content types, honoring the repo's `_headers` file.
- Listens on 127.0.0.1:8788. No TLS, no privileged port.

### Droplet provisioning (doctl, Otra Guide team)

- Droplet `otratickets-web-1`: nyc3, `s-1vcpu-2gb`, Ubuntu 24.04 LTS,
  VPC `otraguide-nyc3` (22422c51-0979-4ea5-a6fd-5313aed983ab), SSH key
  `brian-do-production` (55555158), weekly backups enabled, monitoring agent on.
- Firewall: inbound 22 (SSH) and 443 (HTTPS); 80 open only for redirect.
- Postgres: new logical database `otratickets` + user `otratickets` in the
  `otraguide-nyc-pg` cluster (17b10f37-8ebf-4ca5-b3b2-0f027a00c3fb), connected
  via the cluster's **private** hostname. Add the droplet to the cluster's
  trusted sources.
- Spaces: new bucket `otratickets-media` (nyc3), private ACL, with a
  bucket-scoped read-write key.

### Droplet configuration

- User `deploy` (no root SSH), code at `/srv/otratickets`.
- Secrets in `/etc/otratickets/env` (mode 600, root-owned), loaded via
  systemd `EnvironmentFile`: `DATABASE_URL`, `SPACES_ENDPOINT`, `SPACES_KEY`,
  `SPACES_SECRET`, `SPACES_BUCKET`, `OTRA_API_URL`, `PORT`.
- systemd unit `otratickets.service`: `Restart=always`, `Node 22` from
  NodeSource, journald logging.
- Caddy from the official apt repo; Cloudflare Origin Certificate + key at
  `/etc/caddy/origin-cert/`; Caddyfile reverse-proxies to 127.0.0.1:8788.
- Unattended-upgrades enabled for security patches.

### Deploy pipeline (GitHub Actions)

- Workflow `.github/workflows/deploy.yml`, triggered on push to `main`
  (and manually via `workflow_dispatch`).
- Steps: checkout, rsync repo (dist/, functions/, server/, package files) to
  `/srv/otratickets`, `npm ci --omit=dev` for server deps, restart the
  systemd unit, then curl the health check and **fail the run** if it fails.
- Repo secrets: `DEPLOY_HOST`, `DEPLOY_SSH_KEY` (dedicated deploy keypair,
  not the personal key).

## Data migration (one-time)

Read-only against Cloudflare; writes only into the brand-new database and
bucket. otraguide.com's resources are not touched.

1. Discover the Pages project's KV namespace and R2 bucket IDs via the
   Cloudflare API (token + account ID already present in the local env).
2. Export every KV key + value + metadata via the Cloudflare REST API into
   the Postgres `kv` table (script in `scripts/migrate/`).
3. Copy every R2 object into `otratickets-media` preserving keys and
   content types.
4. Re-run both scripts just before DNS cutover to catch writes made in
   between (both scripts are idempotent upserts).

## Cutover (same day) and rollback

1. Deploy code to the droplet, import data, set secrets.
2. **Verify before DNS**: `curl --resolve otratickets.com:443:<droplet-ip>`
   against the real hostname; run the repo's check scripts
   (`check:feed-fast-path`, `check:seo`, `check:slug-override`,
   `check:events-retired`) pointed at the droplet; manual admin login +
   upload test.
3. Final data re-sync (step 4 above).
4. Flip Cloudflare DNS for `otratickets.com` (and `www`) from the Pages
   CNAME to an A record on the droplet IP. Proxy stays orange.
5. Watch `x-feed-source`, error logs, and admin flows.
6. **Rollback**: flip the DNS record back to the Pages target. Pages project
   and its KV/R2 remain untouched until we retire them deliberately (roughly
   a week of stable operation). Post-cutover admin edits live in
   Postgres/Spaces only, so a rollback shows pre-cutover override data;
   acceptable for a safety net.

## Error handling and operations

- systemd auto-restarts the Node service; Caddy retries upstream briefly.
- Health endpoint: `/api/homepage-events` (exercises Postgres path end to
  end).
- DO monitoring alert on CPU/memory; droplet weekly backups.
- Logs: `journalctl -u otratickets` for the app, Caddy JSON access logs.

## Testing

- Unit tests for the KV shim, R2 shim, and router (run in CI before deploy).
- The repo's existing `check:*` scripts run against the droplet before
  cutover and stay usable afterward.
- Post-cutover smoke: homepage, an event page (override injection), feed
  API header, sitemap, admin login, media upload, uploaded-media serving.

## Documentation deliverable

`docs/deploy/README.md`: a runbook written for a first-time Caddy/systemd
user. How the pieces fit, every config file location on the droplet, reading
logs, restarting, deploying, rolling back a deploy, rolling back DNS,
resizing the droplet, rotating secrets, and what the GitHub Action does step
by step.

## Cost

About $14.40/mo new spend: droplet $12 + weekly backups ~$2.40. The Space
rides the existing $5 Spaces subscription; the Postgres database rides the
existing otraguide-nyc-pg cluster.

## Prerequisites and open items

- Cloudflare API token scopes must cover: Pages read, KV read, R2 read,
  DNS edit. Verified at first use; if a scope is missing, Brian generates a
  token with the missing scope.
- Cloudflare Origin Certificate creation (API or dashboard) during setup.
- The exact Pages project name, KV namespace ID, and R2 bucket name are
  discovered via the API during migration.
