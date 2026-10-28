#!/usr/bin/env bash
set -euo pipefail
port=${1:-8081}
if [[ ! "$port" =~ ^[1-9][0-9]{3,4}$ ]] || ((port < 1024 || port > 65535)); then
  echo 'Porta de health check invalida.' >&2; exit 1
fi
for ((attempt=1; attempt<=30; attempt++)); do
  if curl --fail --silent --max-time 2 "http://127.0.0.1:$port/health" >/dev/null &&
     response=$(curl --fail --silent --max-time 2 "http://127.0.0.1:$port/api/health") &&
     [[ "$response" == *'"service":"openbatch-backend"'* ]] &&
     curl --fail --silent --max-time 2 "http://127.0.0.1:$port/" | grep -q '<div id="root">' &&
     [[ $(curl --silent --max-time 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/container-jobs") == 401 ]]; then
    echo 'Frontend, proxy, backend e protecao de endpoint: OK'
    exit 0
  fi
  sleep 2
done
echo 'Os conteineres nao ficaram saudaveis dentro do prazo.' >&2
exit 1
