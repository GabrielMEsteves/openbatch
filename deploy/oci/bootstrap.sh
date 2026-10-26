#!/usr/bin/env bash
# Run once as an administrator, from a reviewed repository checkout.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 022

[[ $EUID -eq 0 ]] || { echo 'Execute com sudo.' >&2; exit 1; }
domain=${1:-}
[[ $# -eq 1 && "$domain" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*$ ]] || {
  echo 'Uso: sudo bash deploy/oci/bootstrap.sh openbatch.seudominio.com' >&2; exit 1;
}
# shellcheck source=/dev/null
source /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 ]] || {
  echo 'Este bootstrap requer Ubuntu 24.04.' >&2; exit 1;
}
[[ -x /usr/bin/node && $(/usr/bin/node -p 'process.versions.node.split(".")[0]') == 22 ]] || {
  echo 'Instale Node.js 22 em /usr/bin/node antes do bootstrap.' >&2; exit 1;
}
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

apt-get update
apt-get install -y --no-install-recommends \
  nginx build-essential python3 libpam0g-dev libpam-modules libpam-runtime \
  clamav clamav-freshclam unzip openssh-client curl ca-certificates git rsync sudo openssl util-linux

if ! id openbatch-runner >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash openbatch-runner
fi
install -d -o root -g root -m 0755 /opt/openbatch /opt/openbatch/releases
install -d -o root -g root -m 0700 /etc/openbatch /var/lib/openbatch
install -d -o openbatch-runner -g openbatch-runner -m 0700 /var/lib/openbatch-delivery
if [[ ! -e /etc/openbatch/openbatch.env ]]; then
  install -o root -g root -m 0600 "$script_dir/openbatch.env.example" /etc/openbatch/openbatch.env
  secret=$(openssl rand -hex 32)
  sed -i "s/REPLACE_WITH_OPENSSL_RAND_HEX_32/$secret/" /etc/openbatch/openbatch.env
fi

install -o root -g root -m 0755 "$script_dir/deploy.sh" /usr/local/sbin/openbatch-deploy
install -o root -g root -m 0644 "$script_dir/openbatch.service" /etc/systemd/system/openbatch.service
sudoers_tmp=$(mktemp)
trap 'rm -f -- "$sudoers_tmp"' EXIT
printf '%s\n' 'openbatch-runner ALL=(root) NOPASSWD: /usr/local/sbin/openbatch-deploy *' > "$sudoers_tmp"
visudo -cf "$sudoers_tmp"
install -o root -g root -m 0440 "$sudoers_tmp" /etc/sudoers.d/openbatch-deploy

sed "s/__SERVER_NAME__/$domain/" "$script_dir/nginx.conf" > /etc/nginx/sites-available/openbatch
ln -sfn /etc/nginx/sites-available/openbatch /etc/nginx/sites-enabled/openbatch
nginx -t
systemctl daemon-reload
systemctl enable openbatch nginx clamav-freshclam
systemctl restart clamav-freshclam
systemctl reload-or-restart nginx
echo 'Base instalada. Configure o runner e execute o workflow; depois habilite HTTPS conforme o guia.'
