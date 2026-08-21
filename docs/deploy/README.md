# otratickets.com droplet operations runbook

This is the operations runbook for otratickets.com's production infrastructure: a
DigitalOcean droplet (`otratickets-web-1`, `167.71.106.85`, region `nyc3`) that replaced
Cloudflare Pages. It assumes SSH access as `root` (key `brian-do-production`) or as
`deploy` (CI's dedicated key), and `doctl` / `gh` authenticated against the Otra Guide DO
team and the `MariliaBontempo/Otra-Tickets` GitHub repo. It does not assume any prior
experience with Caddy or systemd; both are explained from scratch below.

## 1. The moving parts

```
Browser
  |
  v
Cloudflare (DNS + edge proxy/CDN, orange-cloud)         -- unchanged from before the migration
  |  HTTPS, using a Cloudflare Origin Certificate on our end
  v
Caddy :443 on the droplet
  |  plain HTTP, localhost only
  v
Node service "otratickets" :8788 (managed by systemd)
  |             |                        |
  v             v                        v
Postgres      Spaces                 otraguide.com
(kv table,    (bucket                (Django admin API,
overrides)    otratickets-media,      auth checks)
               uploaded media)
```

**Cloudflare** is the only thing the public internet ever talks to directly. It owns DNS
for otratickets.com, terminates the TLS connection browsers see (the padlock), caches
static assets at the edge, and absorbs abuse traffic before it reaches us. None of that
changed in this migration; only what Cloudflare proxies *to* changed, from a Pages
deployment to our droplet.

**Caddy** is a web server binary installed on the droplet, doing the job something like
nginx would: it listens on ports 80 and 443, holds the TLS certificate our origin
presents back to Cloudflare, and forwards ("reverse proxies") every request to the Node
app over plain HTTP on `127.0.0.1:8788`. Caddy is a system package, not part of this
repo's code; its config file is `/etc/caddy/Caddyfile`.

**systemd** is Ubuntu's process supervisor, the thing that starts programs when the
droplet boots and keeps them running. Instead of running the Node app by hand or under a
tool like pm2, it is registered with systemd as a "unit" named `otratickets.service`.
systemd starts it on boot, restarts it if it ever exits, and gives us the `systemctl`
command to check on it or restart it manually.

**Node service "otratickets"** is the actual application: the same `functions/`
Pages-style code as before, now running under a small router (`server/`) instead of
Cloudflare's edge runtime. It listens only on `127.0.0.1:8788`, unreachable from the
internet except through Caddy.

**Postgres / Spaces / the Django API** are the three things the Node app talks to at
runtime. Postgres (the `otratickets` database inside the existing `otraguide-nyc-pg`
cluster) holds the `kv` table that replaced Cloudflare KV, for admin overrides and hidden
pages. Spaces (bucket `otratickets-media`) replaced Cloudflare R2, for uploaded event
photos. The Django API at `https://otraguide.com` is unchanged and still handles admin
authentication, exactly as it did when the site ran on Pages.

## 2. Where everything lives

| Path | What's there |
| --- | --- |
| `/srv/otratickets` | Deployed code: `dist/`, `functions/`, `server/`, `package.json`, `_headers`. Owned by `deploy`. Written by the CI rsync on every deploy. |
| `/etc/otratickets/env` | Secrets loaded by systemd's `EnvironmentFile`: `PORT`, `DATABASE_URL`, `PGSSLROOTCERT`, `SPACES_ENDPOINT`, `SPACES_BUCKET`, `SPACES_KEY`, `SPACES_SECRET`. Mode 640, owner `root:deploy`. Never committed to git. |
| `/etc/caddy/Caddyfile` | Caddy's config: which cert to use, the reverse proxy target, compression, access log format. The repo's copy is `deploy/Caddyfile`; CI does not sync it, so a change here means copying the file by hand (see section 3). |
| `/etc/caddy/origin-cert/` | `cert.pem` and `key.pem`, the TLS certificate Caddy presents to Cloudflare. Currently a 10-year self-signed pair (see section 9). |
| `/etc/systemd/system/otratickets.service` | The systemd unit that runs the Node app. The repo's copy is `deploy/otratickets.service`; also not synced by CI, also a manual copy on change. |
| `/var/log/caddy/access.log` | JSON access log (one line per request), rotated at 50 MiB with 5 kept. |
| journald | Everything the Node process writes to stdout/stderr, queried with `journalctl -u otratickets`. |

The repo's `deploy/` and `scripts/` directories are intentionally **not** part of the CI
rsync list (see section 3); Caddy config and systemd unit changes are always a deliberate
manual step, never an automatic side effect of merging to main.

## 3. Deploys

**What `.github/workflows/deploy.yml` does, on every push to `main`** (also runnable by
hand via `workflow_dispatch`):

1. Checks out the repo.
2. Installs Node 22 (`actions/setup-node@v4`), matching the droplet's Node version.
3. Runs the server test suite: `cd server && npm ci && cd .. && node --test
   "server/test/*.test.mjs"`. A failing test stops here; nothing touches the droplet.
4. Sets up SSH: writes the `DEPLOY_SSH_KEY` repo secret to a temporary key file, adds
   `DEPLOY_HOST` to `known_hosts` via `ssh-keyscan`.
5. Rsyncs `dist functions server package.json _headers` to
   `deploy@<droplet>:/srv/otratickets/`, with `--delete --exclude node_modules`.
6. SSHes in as `deploy`, runs `npm --prefix server ci --omit=dev`, then
   `sudo systemctl restart otratickets` (the one mutating command the `deploy` user's
   sudoers rule allows; see section 5).
7. Health-checks `http://127.0.0.1:8788/api/homepage-events` from the droplet itself, up
   to 10 attempts 3 seconds apart, and fails the run if none returns 200.

**Watching a run:**

```bash
gh run list --repo MariliaBontempo/Otra-Tickets --workflow=deploy.yml
gh run watch <run-id> --repo MariliaBontempo/Otra-Tickets
```

or the Actions tab: `https://github.com/MariliaBontempo/Otra-Tickets/actions/workflows/deploy.yml`

**Deploying manually** (same steps CI runs, useful if Actions is unavailable or you need
code on the droplet without waiting on a merge):

```bash
rsync -az --delete --exclude node_modules \
  -e "ssh -i ~/.ssh/otratickets_deploy" \
  dist functions server package.json _headers \
  deploy@167.71.106.85:/srv/otratickets/

ssh -i ~/.ssh/otratickets_deploy deploy@167.71.106.85 \
  'cd /srv/otratickets && npm --prefix server ci --omit=dev && sudo systemctl restart otratickets'
```

**Rolling back a bad deploy:**

- Preferred: `git revert <bad-commit>` on `main` (or revert the merge commit), push. The
  Action redeploys the reverted code the normal way. This keeps "merge to main is the
  only deploy step" true, which is the workflow Marilia already uses day to day.
- Manual fallback, if you need the droplet fixed immediately and can't wait on CI:
  check out the previous good commit into a throwaway worktree and rsync straight from
  it, then land the equivalent revert on `main` afterward so the branch and the droplet
  agree again.

```bash
git worktree add /tmp/otratickets-rollback <previous-good-sha>
rsync -az --delete --exclude node_modules -e "ssh -i ~/.ssh/otratickets_deploy" \
  /tmp/otratickets-rollback/dist /tmp/otratickets-rollback/functions \
  /tmp/otratickets-rollback/server /tmp/otratickets-rollback/package.json \
  /tmp/otratickets-rollback/_headers \
  deploy@167.71.106.85:/srv/otratickets/
ssh -i ~/.ssh/otratickets_deploy deploy@167.71.106.85 \
  'cd /srv/otratickets && npm --prefix server ci --omit=dev && sudo systemctl restart otratickets'
git worktree remove /tmp/otratickets-rollback
```

## 4. Reading logs

**The Node app, via journald:**

```bash
journalctl -u otratickets -f                    # follow live
journalctl -u otratickets -n 200                # last 200 lines
journalctl -u otratickets --since "1 hour ago"   # time-windowed
journalctl -u otratickets -p err --since "-10 min"   # errors only, recent
```

**Caddy's access log**, one JSON object per request at `/var/log/caddy/access.log`.
Status-code breakdown with `jq` (not installed by `deploy/setup-droplet.sh`; install once
with `apt-get install -y jq` if you want it):

```bash
ssh root@167.71.106.85 "tail -n 2000 /var/log/caddy/access.log | jq -r '.status' | sort | uniq -c | sort -rn"
```

Equivalent without installing anything (Python 3 ships with Ubuntu 24.04):

```bash
ssh root@167.71.106.85 "tail -n 2000 /var/log/caddy/access.log | python3 -c \"import json,sys,collections; c=collections.Counter(json.loads(l)['status'] for l in sys.stdin if l.strip()); print(dict(c))\""
```

## 5. Restarting and status

```bash
systemctl status otratickets     # current state, recent log lines, PID, restart count
sudo systemctl restart otratickets
systemctl reload caddy           # re-reads /etc/caddy/Caddyfile without dropping connections
```

Use `reload` after editing the Caddyfile; fall back to `sudo systemctl restart caddy` if a
reload doesn't pick up the change (a replaced cert file, for instance, sometimes needs a
full restart).

`Restart=always` in `otratickets.service` means systemd relaunches the Node process
whenever it exits, for any reason (crash, uncaught exception, manual kill), waiting
`RestartSec=2` between attempts. This makes the service self-healing for transient
failures like a dropped Postgres connection, but it is not a substitute for reading the
logs if it's restarting in a loop; an elevated restart count in `systemctl status` is the
tell.

**Sudoers warning:** the `deploy` user (the identity CI and manual deploys use) has a
narrow rule in `/etc/sudoers.d/otratickets-deploy` allowing exactly two commands, matched
literally: `sudo systemctl restart otratickets` and `sudo systemctl status otratickets`.
No extra flags. `sudo systemctl status otratickets --no-pager`, for example, does **not**
match that literal string and falls through to asking for a password the `deploy` user
doesn't have, which just looks like a hang. If you need `--no-pager` or any other flag,
pipe through `cat` instead (`sudo systemctl status otratickets | cat`), or SSH in as
`root`.

## 6. DNS rollback to Cloudflare Pages

Before cutover, `otratickets.com` and `www` point via CNAME at the Cloudflare Pages
project. Cutover flips `otratickets.com` to an A record at the droplet IP
(`167.71.106.85`) and `www` to a CNAME at `otratickets.com`, both still proxied
(orange cloud, so Cloudflare's edge is unchanged either way).

The exact pre-cutover records are captured immediately before the flip: a full JSON dump
of the zone from the Cloudflare API, saved to `$SCRATCHPAD/dns-before-cutover.json`, then
copied into `deploy/cutover-log.md` in this repo (that file holds no secrets) alongside
the exact rollback `PUT` bodies for each record. Once cutover has happened,
`deploy/cutover-log.md` is the source of truth for rollback: read it, copy the `PUT`
commands it lists, run them.

If that file is ever missing or you need to reconstruct it, use the Cloudflare API
directly with a production-account token:

```bash
ZONE_ID=$(curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?name=otratickets.com" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['result'][0]['id'])")
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records?per_page=100" \
  | python3 -m json.tool
```

Find the `otratickets.com` and `www` records in that output, then for each one `PUT` back
the pre-cutover body from the snapshot:

```bash
curl -X PUT -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/dns_records/<record-id>" \
  --data '{"type":"CNAME","name":"otratickets.com","content":"<pages-project>.pages.dev","proxied":true,"ttl":1}'
```

(the exact type and content per record come from the snapshot; an apex CNAME can be
represented in more than one way depending on how Cloudflare flattens it, which is exactly
why the snapshot matters more than remembering the shape from memory.)

**Caveat:** rollback is a safety net, not a lossless undo. The Pages project's KV/R2 data
is frozen at whatever the last `export-kv.mjs` / `export-r2.mjs` re-sync captured before
cutover; those scripts only ever write into Postgres and Spaces, never back to
Cloudflare. Any admin edits made after cutover, meaning new events, overrides, or
uploaded photos, exist only in Postgres and Spaces and will **not** appear if you roll
back to Pages.

## 7. Resizing the droplet

```bash
doctl compute droplet-action resize 594088118 --size s-2vcpu-4gb --wait
```

Droplet ID `594088118`, currently sized `s-1vcpu-2gb`. List other slugs with
`doctl compute size list`. Without `--resize-disk`, this only changes CPU and RAM and is
reversible later; DigitalOcean powers the droplet off automatically before resizing and
back on afterward, so expect a few minutes of full downtime for the whole droplet (not
just the Node app) while it happens. Schedule it, don't run it unannounced. Adding
`--resize-disk=true` also grows the disk and is permanent (disk cannot be shrunk back
down later); only use that if you're deliberately adding storage.

## 8. Rotating secrets

**Spaces key** (create new, update env, delete old, in that order):

```bash
doctl spaces keys create otratickets-media-rw-2 --grants "bucket=otratickets-media;permission=readwrite"
```

Copy the new access key ID and secret from the output, SSH in and edit `SPACES_KEY` /
`SPACES_SECRET` in `/etc/otratickets/env`, `sudo systemctl restart otratickets`, confirm
the app is healthy and a media upload/serve round-trip still works, then delete the old
key: `doctl spaces keys list` to find its name, `doctl spaces keys delete <old-access-id>`.

**PG password:**

```bash
doctl databases user reset 17b10f37-8ebf-4ca5-b3b2-0f027a00c3fb otratickets
```

**Warning:** this command executes immediately and irreversibly the moment you run it.
There is no confirmation prompt and no dry-run flag; it does not just validate arguments
or print help if the invocation is slightly off, it rotates the live password on the spot
and prints the new one once, in cleartext, in the terminal. The instant it runs, the old
password in `/etc/otratickets/env` stops working; the site keeps serving on already-open
database connections for a while, but starts failing as soon as the pool needs to
reconnect. Treat it as a two-step operation done back to back, not a "let me see what
this does" check: capture the new password from the output, then immediately update
`DATABASE_URL` in `/etc/otratickets/env` on the droplet and `sudo systemctl restart
otratickets` in the same sitting, and confirm `curl -s -o /dev/null -w '%{http_code}'
http://127.0.0.1:8788/api/homepage-events` returns 200 before walking away.

**Deploy key** (regenerate, install the new one, confirm it works, then swap CI over):

```bash
ssh-keygen -t ed25519 -N "" -C "otratickets-deploy-$(date +%Y%m%d)" -f /tmp/otratickets_deploy_new
cat /tmp/otratickets_deploy_new.pub | ssh root@167.71.106.85 'cat >> /home/deploy/.ssh/authorized_keys'
ssh -i /tmp/otratickets_deploy_new deploy@167.71.106.85 'echo deploy-login-ok'
gh secret set DEPLOY_SSH_KEY --repo MariliaBontempo/Otra-Tickets < /tmp/otratickets_deploy_new
```

Once the next Actions run succeeds with the new key, remove the old public key's line
from `/home/deploy/.ssh/authorized_keys` on the droplet and delete the local private key
files.

## 9. TLS

Currently live: Caddy holds a self-signed certificate at
`/etc/caddy/origin-cert/{cert,key}.pem`, 10-year validity, generated with:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -subj "/CN=otratickets.com" -addext "subjectAltName=DNS:otratickets.com,DNS:www.otratickets.com" \
  -keyout /etc/caddy/origin-cert/key.pem -out /etc/caddy/origin-cert/cert.pem
```

This works because Cloudflare's connection to our origin only requires *a* certificate
when the zone's SSL/TLS mode is **Full**; at that mode Cloudflare does not check the cert
against a public CA, it just requires HTTPS with something presented. It does **not**
work under **Strict**, which rejects a self-signed cert outright and breaks the site. It
also does not work under **Flexible**, for a different reason: Flexible means Cloudflare
talks plain HTTP to the origin, and our Caddyfile's `:80` block redirects every request to
`https://`, so Flexible plus this Caddyfile is an infinite redirect loop. Confirming the
zone is set to Full, and not Flexible or Strict, is a hard precondition of cutover. As of
this migration, the production Cloudflare account holding that setting was still pending
access (Marilia holds it), so treat "Full" as unverified until confirmed with a
production-account token:

```bash
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE_ID/settings/ssl" | python3 -m json.tool
```

**Upgrading to Strict** (worth doing once things are stable, since it removes the
"any certificate will do" weak point): generate a CSR on the droplet, request a
Cloudflare Origin CA certificate, install the result, reload Caddy, and only then flip the
zone's mode:

```bash
POST https://api.cloudflare.com/client/v4/certificates
  {"hostnames":["otratickets.com","www.otratickets.com"],
   "request_type":"origin-rsa","requested_validity":5475,"csr":"<csr-pem>"}
```

(needs a production API token; Origin CA certificate creation may require a separate
Origin CA Key rather than the regular API token, since Cloudflare scopes that endpoint
differently). Install the returned cert and key at `/etc/caddy/origin-cert/`,
`systemctl reload caddy`, confirm the site still serves correctly, and only then
`PATCH .../settings/ssl {"value":"strict"}`. Installing the cert before flipping the mode
avoids a window where Strict is active but the origin still only has a certificate Strict
would reject.

## 10. Costs and monthly review

New spend from this migration is about $14.40/month: droplet `otratickets-web-1`
(`s-1vcpu-2gb`) at $12/mo, plus weekly backups at roughly $2.40/mo (about 20% of droplet
cost). The Spaces bucket `otratickets-media` rides the existing $5/mo Spaces subscription
(shared with any other buckets already on that plan; no incremental cost per bucket). The
`otratickets` database rides the existing `otraguide-nyc-pg` cluster (shared compute, no
incremental cost for one more logical database).

**Monthly review:**

- Check the DO invoice against the numbers above; a mismatch usually means an
  accidental resize or an extra backup snapshot lingering.
- Check the DO monitoring agent's CPU and memory graphs for `otratickets-web-1`; resize
  ahead of a problem rather than during one (section 7).
- Once the droplet has run stably for about a week post-cutover, work through the Pages
  retirement checklist:
  1. Confirm no rollback has been needed and DNS has held on the droplet the whole week.
  2. Confirm the final `export-kv.mjs` / `export-r2.mjs` re-sync ran clean with nothing
     new found, meaning nothing is still writing to the old KV/R2 through a path we
     missed.
  3. Only then delete the Cloudflare Pages project (and its KV namespace / R2 bucket, if
     unused elsewhere). This permanently removes the rollback safety net, so treat it as
     a deliberate, separate decision, never something automated or bundled into another
     change.
