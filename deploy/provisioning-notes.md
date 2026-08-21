# Provisioning notes (2026-08-21)

All resources on the DigitalOcean "Otra" team, region nyc3, assigned to the
**otra-guide project** (fcb9d774-07cd-4dc3-aea5-40cb8b20dc67). Note: the
team's DEFAULT project is `otra-card`, so freshly created resources land
there until explicitly assigned; the droplet and Space below were moved to
otra-guide with `doctl projects resources assign` on 2026-08-21. Any future
resource creation for this site must include that assignment step.

- Droplet: `otratickets-web-1`, ID `594088118`, public IP `167.71.106.85`,
  size s-1vcpu-2gb, Ubuntu 24.04, weekly backups on, monitoring agent on,
  VPC `otraguide-nyc3` (`22422c51-0979-4ea5-a6fd-5313aed983ab`), tag `otratickets`.
- Firewall: `otratickets-fw` (`f78fbc09-08eb-446e-b8f7-8e8f34ee14d1`),
  inbound 22/80/443, attached by tag `otratickets`.
- Postgres: logical database `otratickets` and user `otratickets` created in
  cluster `otraguide-nyc-pg` (`17b10f37-8ebf-4ca5-b3b2-0f027a00c3fb`).
  Private host `private-otraguide-nyc-pg-do-user-14322077-0.e.db.ondigitalocean.com`,
  port 25060. Cluster trusted sources were already NON-EMPTY (droplets
  576309749, 576419564); this droplet (594088118) was APPENDED, nothing removed.
  Consequence: the cluster only accepts connections from trusted droplets, so
  the data migration scripts run ON the droplet, not from a laptop.
  User grants (GRANT ALL on database otratickets) are applied from the droplet
  during setup because no laptop can reach the cluster.
- Spaces: bucket `otratickets-media` (nyc3), private. Runtime key
  `otratickets-media-rw` (bucket-scoped readwrite; access key id and secret
  stored only in the droplet env file). The temporary `otratickets-bootstrap`
  full-access key used to create the bucket was deleted.
- Secrets live in `/etc/otratickets/env` on the droplet. Nothing secret is in
  this repo.
