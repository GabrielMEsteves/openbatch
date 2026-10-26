#!/usr/bin/env bash
# Root-owned entry point. Never run a script from the runner checkout with sudo.
set -euo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
umask 022

[[ $EUID -eq 0 ]] || { echo 'Execute com sudo.' >&2; exit 1; }
action=${1:-}
release_id=${2:-}
[[ $# -eq 2 && "$action" =~ ^(deploy|rollback)$ && "$release_id" =~ ^[a-f0-9]{40}-[0-9]+-[0-9]+$ ]] || {
  echo 'Uso: openbatch-deploy deploy|rollback SHA40-RUN_ID-ATTEMPT' >&2; exit 1;
}
exec 9>/run/lock/openbatch-deploy.lock
flock -n 9 || { echo 'Outro deploy esta em andamento.' >&2; exit 1; }

base=/opt/openbatch
target="$base/releases/$release_id"
previous=''
if [[ -L "$base/current" ]]; then
  previous=$(readlink -e "$base/current")
  [[ "$previous" == "$base/releases/"* ]] || { echo 'Release atual fora de releases.' >&2; exit 1; }
elif [[ -e "$base/current" ]]; then
  echo '/opt/openbatch/current precisa ser um link simbolico.' >&2; exit 1
fi
[[ "$previous" != "$target" ]] || { echo 'Release ja esta ativa.' >&2; exit 1; }

[[ -f /etc/openbatch/openbatch.env ]] || { echo 'Arquivo de ambiente ausente.' >&2; exit 1; }
nginx -t
if [[ "$action" == deploy ]]; then
  incoming="/var/lib/openbatch-delivery/$release_id"
  [[ -d "$incoming" && ! -L "$incoming" && ! -e "$target" && ! -L "$target" ]] || {
    echo 'Entrega ausente ou release de destino ja existe.' >&2; exit 1;
  }
  [[ $(cat "$incoming/REVISION") == "${release_id:0:40}" ]] || {
    echo 'Revisao da entrega nao corresponde ao identificador.' >&2; exit 1;
  }
  for file in server.js podman-jobs.js ssh-askpass.sh package.json package-lock.json dist/index.html node_modules/express/package.json; do
    [[ -f "$incoming/$file" ]] || { echo "Arquivo ausente: $file" >&2; exit 1; }
  done
  # Do not expose partially copied releases through current.
  install -d -m 0755 "$target"
  rsync -a --safe-links --chown=root:root --chmod=Du=rwx,Dgo=rx,Fu+rw,Fgo+r,Fgo-w "$incoming/" "$target/"
  chmod 0755 "$target/ssh-askpass.sh"
else
  [[ -d "$target" && ! -L "$target" && -f "$target/dist/index.html" ]] || {
    echo 'Release de rollback nao encontrada.' >&2; exit 1;
  }
fi

activate() {
  ln -sfn "$1" "$base/.current-next"
  mv -Tf "$base/.current-next" "$base/current"
}
healthy() {
  local attempt
  for ((attempt=1; attempt<=30; attempt++)); do
    if systemctl is-active --quiet openbatch && \
       curl --fail --silent --max-time 2 http://127.0.0.1:8080/api/health >/dev/null && \
       curl --fail --silent --max-time 2 http://127.0.0.1:8080/ >/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

switched=false
completed=false
on_exit() {
  local status=$?
  trap - EXIT INT TERM HUP
  if [[ "$switched" == true && "$completed" != true ]]; then
    echo 'Falha na ativacao; revertendo a versao.' >&2
    journalctl -u openbatch -n 40 --no-pager >&2 || true
    if [[ -n "$previous" ]]; then
      if activate "$previous" && systemctl restart openbatch && healthy; then
        echo "Versao anterior restaurada: $(basename "$previous")" >&2
      else
        echo 'Rollback falhou. Intervencao do administrador necessaria.' >&2
      fi
    else
      systemctl stop openbatch || true
      rm -f -- "$base/current"
      echo 'Primeiro deploy falhou; nao existe versao anterior.' >&2
    fi
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' INT TERM HUP

# Set the flag first so a signal between the switch and restart also rolls back.
switched=true
activate "$target"
systemctl restart openbatch
healthy || { echo 'Health check da nova versao falhou.' >&2; exit 1; }
# Verify Nginx -> backend, using the configured virtual host, after local health.
site_host=$(awk '/^[[:space:]]*server_name / {gsub(/;/, "", $2); print $2; exit}' /etc/nginx/sites-available/openbatch)
# Resolve locally but preserve Host/SNI. After Certbot, follow the redirect and
# validate the certificate too; a redirect alone is not a successful API probe.
proxy_response=$(curl --fail --silent --show-error --max-time 10 --location --max-redirs 3 \
  --proto-redir '=https' --noproxy '*' \
  --resolve "$site_host:80:127.0.0.1" --resolve "$site_host:443:127.0.0.1" \
  "http://$site_host/api/health")
[[ "$proxy_response" == *'"service":"openbatch-backend"'* ]] || {
  echo 'Proxy nao retornou a resposta esperada da API.' >&2; exit 1;
}
if [[ -n "$previous" ]]; then
  ln -sfn "$previous" "$base/previous"
fi
completed=true
echo "Release ativa: $release_id"
