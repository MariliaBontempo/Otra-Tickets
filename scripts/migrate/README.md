# Cloudflare Data Migration Scripts

Idempotent scripts to export Cloudflare KV and R2 data during the otratickets.com migration.

## Environment Variables

All scripts require the following environment variables:

### Cloudflare (from the production account)
- `CLOUDFLARE_API_TOKEN`: API token with scopes Pages:Read, Workers KV Storage:Read, R2:Read
- `CLOUDFLARE_ACCOUNT_ID`: The account ID of the production otratickets.com Pages project

### Database
- `DATABASE_URL`: PostgreSQL connection string (must NOT contain sslmode=require; use PGSSLROOTCERT instead)
- `PGSSLROOTCERT`: Path to CA certificate for TLS connections (optional; if not set, TLS verification is disabled)

### Spaces (for R2 export only)
- `SPACES_KEY`: DigitalOcean Spaces access key
- `SPACES_SECRET`: DigitalOcean Spaces secret key
- `SPACES_ENDPOINT`: Spaces endpoint (default: https://nyc3.digitaloceanspaces.com)
- `SPACES_BUCKET`: Spaces bucket name (default: otratickets-media)

## Running the Scripts

### Location

Scripts must run ON the droplet at /srv/otratickets with node_modules at /srv/otratickets/server/node_modules.

If the cluster's trusted-sources check (Task 1 Step 5) found non-empty rules, the laptop is NOT a trusted source and cannot connect from outside the VPC. In that case:

1. rsync scripts/migrate to the droplet: `rsync -av scripts/migrate/ /srv/otratickets/scripts/migrate/`
2. Add Cloudflare env vars to the droplet environment (already has DATABASE_URL and Spaces credentials in /etc/otratickets/env)
3. Run from the droplet with NODE_PATH configured

### Invocation

From the droplet (with proper env vars set):

```bash
cd /srv/otratickets/server && node ../scripts/migrate/export-kv.mjs
cd /srv/otratickets/server && node ../scripts/migrate/export-r2.mjs
```

## Idempotency

Both scripts are **idempotent and safe to re-run**:

- `export-kv.mjs`: Uses `ON CONFLICT` to update existing keys (compares both value and metadata)
- `export-r2.mjs`: Skips objects that already exist in Spaces with matching size

A final pre-cutover re-run is mandatory to catch any changes since the initial export.

## What These Scripts Do

- `cf-api.mjs`: Minimal Cloudflare REST client (read-only)
- `export-kv.mjs`: Exports all keys from Cloudflare KV to PostgreSQL kv table
- `export-r2.mjs`: Exports all objects from Cloudflare R2 to DigitalOcean Spaces

## Important Notes

- These scripts **never write to Cloudflare** -- only read from it
- They are read-only for the Cloudflare API
- All mutations are to the target systems (PostgreSQL and Spaces)
