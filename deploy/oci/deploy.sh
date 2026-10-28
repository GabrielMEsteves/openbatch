#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $EUID -ne 0 && $(id -un) == openbatch-runner ]] || {
  echo 'Execute como openbatch-runner, sem sudo.' >&2; exit 1;
}
[[ $# -eq 2 && "$1" =~ ^(deploy|rollback)$ ]] || {
  echo 'Uso: openbatch-deploy deploy /caminho/release.json | rollback SHA-RUN-TENTATIVA' >&2; exit 1;
}
XDG_RUNTIME_DIR="/run/user/$(id -u)"
export XDG_RUNTIME_DIR
export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
export PODMAN_COMPOSE_PROVIDER=/opt/openbatch-tools/bin/podman-compose
base="$HOME/.local/share/openbatch"
lib=/usr/local/lib/openbatch
exec 9>"$base/deploy.lock"
flock -n 9 || { echo 'Outro deploy esta em andamento.' >&2; exit 1; }
[[ $(podman info --format '{{.Host.Security.Rootless}}') == true ]] || {
  echo 'Podman precisa operar em modo rootless.' >&2; exit 1;
}
systemctl --user is-enabled --quiet openbatch-compose.service
previous=''
if [[ -L "$base/current" ]]; then
  previous=$(readlink -e "$base/current")
  [[ "$previous" == "$base/releases/"* ]] || { echo 'Release atual fora de releases.' >&2; exit 1; }
elif [[ -e "$base/current" ]]; then
  echo 'current precisa ser um link simbolico.' >&2; exit 1
fi

if [[ "$1" == deploy ]]; then
  release_id=$(python3 "$lib/prepare-release.py" "$2" "$base" "$lib/compose.yaml")
else
  release_id=$2
fi
[[ "$release_id" =~ ^[a-f0-9]{40}-[0-9]+-[0-9]+$ ]] || { echo 'Release invalida.' >&2; exit 1; }
target="$base/releases/$release_id"
[[ -d "$target" && ! -L "$target" && -f "$target/release.json" ]] || { echo 'Release inexistente.' >&2; exit 1; }
[[ "$target" != "$previous" ]] || { echo 'Release ja esta ativa.' >&2; exit 1; }

value() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$1/release.json" "$2"; }
backend_image=$(value "$target" backend_image)
frontend_image=$(value "$target" frontend_image)
architecture=$(value "$target" architecture)
# Pull both images before stopping any running container. A failed pull keeps
# production running. Rollback uses retained local images, without registry access.
for image in "$backend_image" "$frontend_image"; do
  if [[ "$1" == deploy ]]; then podman pull "$image"; fi
  [[ $(podman image inspect --format '{{.Architecture}}' "$image") == "$architecture" ]] || {
    echo 'Arquitetura da imagem incorreta.' >&2; exit 1;
  }
done
podman compose --env-file "$target/compose.env" -f "$target/compose.yaml" -p openbatch config >/dev/null

activate() {
  ln -sfn "$1" "$base/.current-next"
  mv -Tf "$base/.current-next" "$base/current"
}
healthy() { bash "$lib/healthcheck.sh" "$(value "$1" frontend_port)"; }
switched=false
completed=false
on_exit() {
  local status=$?
  trap - EXIT INT TERM HUP
  if [[ "$switched" == true && "$completed" != true ]]; then
    echo 'Falha na ativacao; revertendo os conteineres.' >&2
    journalctl --user -u openbatch-compose -n 40 --no-pager >&2 || true
    if [[ -n "$previous" ]]; then
      if activate "$previous" && systemctl --user restart openbatch-compose && healthy "$previous"; then
        echo "Release anterior restaurada: $(basename "$previous")" >&2
      else
        echo 'Rollback falhou; verifique podman ps e o journal do usuario.' >&2
      fi
    else
      systemctl --user stop openbatch-compose || true
      podman compose --env-file "$target/compose.env" -f "$target/compose.yaml" -p openbatch stop || true
      rm -f -- "$base/current"
      echo 'Primeiro deploy falhou; nao existe release anterior.' >&2
    fi
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT TERM HUP
switched=true
activate "$target"
systemctl --user restart openbatch-compose
healthy "$target"
if [[ -n "$previous" ]]; then ln -sfn "$previous" "$base/previous"; fi
completed=true
echo "Release ativa com Podman Compose rootless: $release_id"
