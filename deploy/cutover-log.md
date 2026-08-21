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
