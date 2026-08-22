# Cutover log: otratickets.com to DigitalOcean droplet

## Pre-cutover state (2026-08-21, from the Cloudflare dashboard)

Zone otratickets.com, SSL/TLS mode: **Full**. 4 DNS records:

| Name | Type | Content | Proxy |
| --- | --- | --- | --- |
| _domainconnect.otratickets.com | CNAME | _domainconnect.gd.domaincontrol.com | Proxied |
| otratickets.com | CNAME | otra-tickets.pages.dev | Proxied |
| www.otratickets.com | CNAME | otra-tickets.pages.dev | Proxied |
| _dmarc.otratickets.com | TXT | "v=DMARC1; p=quarantine; adkim=r; aspf=r; ..." | DNS only |

## The flip

Only the two `otra-tickets.pages.dev` CNAMEs change; `_domainconnect` and
`_dmarc` are untouched:

- `otratickets.com`: CNAME -> **A 167.71.106.85**, Proxied, TTL Auto
- `www.otratickets.com`: content -> **CNAME otratickets.com**, Proxied, TTL Auto

## Rollback (undoes the cutover in one edit each)

- `otratickets.com`: A 167.71.106.85 -> CNAME `otra-tickets.pages.dev`, Proxied
- `www.otratickets.com`: CNAME otratickets.com -> CNAME `otra-tickets.pages.dev`, Proxied

The Pages project `otra-tickets` stays alive and untouched. Post-cutover
admin edits live in the droplet's Postgres/Spaces only, so a rollback shows
pre-cutover override data.

## Data state at flip time

- Final re-sync completed immediately before the flip: KV 214/214 keys,
  R2 111/111 objects (3.08 GB), verified idempotent (re-run: 0 copied).
- Pre-cutover verification: /, /robots.txt, /sitemap.xml, /llms.txt, event
  page all 200 via curl --resolve; event-page injected title identical to
  production; feed serves x-feed-source: kv-stale from the droplet's own
  Postgres snapshot; media byte-for-byte parity spot-checked.

## Cutover result (2026-08-21, ~12:30 PT)

- Records flipped by Brian in the Cloudflare dashboard (apex A 167.71.106.85,
  www CNAME otratickets.com, both proxied). _domainconnect and _dmarc untouched.
- Origin confirmed within a minute: a marked uncacheable /api/homepage-events
  request appeared in the droplet's Caddy access log (cf-cache-status DYNAMIC,
  x-feed-source kv-stale).
- First live sample (60s window): 41 requests, 100 percent HTTP 200, zero
  otratickets service errors, both services active. Public home load 0.195s.
- Cloudflare Pages project left untouched as the rollback target; retire per
  the runbook checklist after roughly a week of stable operation.

## Post-cutover incident (2026-08-22): admin writes leaked to the old stack

The Kaya Kaya Festival 2026 videos 404'd on the live site (browsers surface
this as a MIME error, since the 404 body is text/plain). Six mp4 uploads made
the evening of cutover day (21:00-23:15 UTC) landed in the OLD Cloudflare R2
bucket, not Spaces: someone was editing through the Pages admin (pages.dev
URL or a pre-flip tab) after the final re-sync had already run. Resolved by
re-running `scripts/migrate/export-r2.mjs` on the droplet (6 copied, 111
already present) with the read-only CF token from Proton Pass.

Hazards until the Pages project is retired:

- The Pages admin still accepts logins and writes to CF KV/R2, which the
  droplet never reads. Anything saved there silently vanishes from prod.
  Retiring the Pages project (or at least its admin access) closes the hole.
- `export-r2.mjs` is safe to re-run any time (keys are write-once UUIDs).
  `export-kv.mjs` is NOT: it blindly upserts every CF value over Postgres and
  would clobber all post-cutover droplet edits. Never re-run it while both
  stacks are writable without first diffing keys.
