#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -ne 0 ]] || { echo 'Execute no systemd do usuario, sem sudo.' >&2; exit 1; }
export PODMAN_COMPOSE_PROVIDER=/opt/openbatch-tools/bin/podman-compose
release=$(readlink -e "$HOME/.local/share/openbatch/current")
cd "$release"
compose=(podman compose --env-file compose.env -f compose.yaml -p openbatch)
case "${1:-}" in
  start) "${compose[@]}" up -d --no-build --force-recreate ;;
  stop) "${compose[@]}" stop ;;
  *) echo 'Uso: compose-service.sh start|stop' >&2; exit 1 ;;
esac
