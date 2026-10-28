#!/bin/bash
# Execute como root dentro do WSL: sudo bash setup-wsl-compose.sh julia
set -euo pipefail
user=${1:?Informe o usuário Linux}
home=$(getent passwd "$user" | cut -d: -f6)
test -n "$home"
keydir="$home/.openbatch-ssh"
install -d -m 700 -o "$user" -g "$(id -gn "$user")" "$keydir" "$home/.ssh"
if [ ! -f "$keydir/$user.key" ]; then
  runuser -u "$user" -- ssh-keygen -q -t ed25519 -N '' -C openbatch-compose -f "$keydir/$user.key"
fi
touch "$home/.ssh/authorized_keys"
public=$(cat "$keydir/$user.key.pub")
grep -qF "$public" "$home/.ssh/authorized_keys" || printf '%s\n' "$public" >> "$home/.ssh/authorized_keys"
chmod 600 "$home/.ssh/authorized_keys"
chown "$user:$(id -gn "$user")" "$home/.ssh/authorized_keys"
# Chave de host obtida diretamente do servidor local, sem confiar em keyscan.
awk '{print "host.docker.internal " $1 " " $2}' /etc/ssh/ssh_host_ed25519_key.pub > "$keydir/known_hosts"
chmod 600 "$keydir/known_hosts"
chown "$user:$(id -gn "$user")" "$keydir/known_hosts"
export OPENBATCH_SETUP_KEYDIR="$keydir"
python3 - <<'PY'
import os, pathlib, secrets
p = pathlib.Path('.env')
lines = p.read_text().splitlines() if p.exists() else []
values = {'SLURM_SSH_HOST': 'host.docker.internal', 'SLURM_SSH_MOUNT': os.environ['OPENBATCH_SETUP_KEYDIR']}
if not any(line.startswith('JWT_SECRET=') for line in lines):
    values['JWT_SECRET'] = secrets.token_hex(32)
lines = [line for line in lines if not any(line.startswith(k + '=') for k in values)]
p.write_text('\n'.join(lines + [k + '=' + v for k, v in values.items()]) + '\n')
PY
echo 'Credenciais e .env preparados. Nenhum segredo foi exibido.'
