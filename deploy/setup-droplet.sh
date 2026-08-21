#!/usr/bin/env bash
set -euo pipefail
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 DEBIAN_FRONTEND=noninteractive

# Node 22 (NodeSource) and Caddy (official repo), unattended upgrades, rsync
apt-get update -y
apt-get install -y ca-certificates curl gnupg unattended-upgrades rsync
if ! command -v node >/dev/null || ! node -v | grep -q '^v22'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

# deploy user + directories
id deploy >/dev/null 2>&1 || adduser --disabled-password --gecos "" deploy
mkdir -p /srv/otratickets /etc/otratickets /etc/caddy/origin-cert /var/log/caddy
chown -R deploy:deploy /srv/otratickets
chown caddy:caddy /var/log/caddy || true

# deploy user may restart only this service
cat > /etc/sudoers.d/otratickets-deploy <<'SUDO'
deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart otratickets, /usr/bin/systemctl status otratickets
SUDO
chmod 440 /etc/sudoers.d/otratickets-deploy

echo "setup-droplet.sh done. Next: /etc/otratickets/env, origin cert, authorized_keys for deploy, install unit + Caddyfile."
