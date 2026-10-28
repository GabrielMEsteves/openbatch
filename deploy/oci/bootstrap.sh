#!/usr/bin/env bash
# Administrative setup only. Application code never executes as host root.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 022
[[ $EUID -eq 0 && $# -eq 0 ]] || {
  echo 'Uso: sudo bash deploy/oci/bootstrap.sh (sem argumento de dominio)' >&2; exit 1;
}
# shellcheck source=/dev/null
source /etc/os-release
case "$ID:$VERSION_ID" in
  ubuntu:24.04)
    apt-get update
    apt-get install -y --no-install-recommends podman uidmap slirp4netns fuse-overlayfs \
      python3-venv dbus-user-session curl ca-certificates git openssl openssh-client util-linux
    ;;
  *) echo 'Bootstrap suportado: Ubuntu 24.04.' >&2; exit 1 ;;
esac
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
python3 -m venv /opt/openbatch-tools
/opt/openbatch-tools/bin/pip install --disable-pip-version-check 'podman-compose==1.5.0'

if ! id openbatch-runner >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash openbatch-runner
fi
runner_uid=$(id -u openbatch-runner)
runner_home=$(getent passwd openbatch-runner | cut -d: -f6)
for mapping in subuid subgid; do
  touch "/etc/$mapping"
  if ! grep -q '^openbatch-runner:' "/etc/$mapping"; then
    first=$(awk -F: 'BEGIN{n=100000} NF==3{end=$2+$3;if(end>n)n=end} END{print n}' "/etc/$mapping")
    usermod "--add-${mapping}s" "$first-$((first + 65535))" openbatch-runner
  fi
done

# Revoke the sudo entry installed by the previous native-deployment bootstrap.
rm -f /etc/sudoers.d/openbatch-deploy /usr/local/sbin/openbatch-deploy
# Keep an existing native service running until the administrator switches the
# external proxy to the new frontend port and verifies the container deployment.

install -d -o openbatch-runner -g openbatch-runner -m 0700 \
  "$runner_home/.local" "$runner_home/.local/share" "$runner_home/.local/share/openbatch" \
  "$runner_home/.local/share/openbatch/releases" "$runner_home/.local/share/openbatch/ssh"
install -d -o root -g root -m 0755 /usr/local/lib/openbatch
install -m 0755 "$script_dir/deploy.sh" /usr/local/bin/openbatch-deploy
install -m 0755 "$script_dir/compose-service.sh" "$script_dir/healthcheck.sh" /usr/local/lib/openbatch/
install -m 0644 "$script_dir/prepare-release.py" "$script_dir/compose.yaml" /usr/local/lib/openbatch/
install -m 0644 "$script_dir/openbatch-compose.service" /etc/systemd/user/openbatch-compose.service

loginctl enable-linger openbatch-runner
systemctl start "user@$runner_uid.service"
runuser -u openbatch-runner -- env XDG_RUNTIME_DIR="/run/user/$runner_uid" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$runner_uid/bus" systemctl --user daemon-reload
runuser -u openbatch-runner -- env XDG_RUNTIME_DIR="/run/user/$runner_uid" \
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$runner_uid/bus" systemctl --user enable openbatch-compose.service
echo "Podman rootless preparado para openbatch-runner (UID $runner_uid)."
echo "Para integrar o cluster depois, instale known_hosts e <usuario>.key em $runner_home/.local/share/openbatch/ssh/"
echo 'Configure production no GitHub. O primeiro deploy iniciara os conteineres.'
echo 'Se houver deploy nativo anterior, migre os dados e o proxy antes de desativar openbatch.service.'
