"""Validate deployment input and write private env files, without shell evaluation."""
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import shutil
import sys
from urllib.parse import urlsplit


def require_pattern(name, value, pattern):
    if not isinstance(value, str) or not re.fullmatch(pattern, value):
        raise ValueError(f"{name} ausente ou invalido")
    return value


def validate(metadata, env, machine):
    if not isinstance(metadata, dict):
        raise ValueError("Manifesto de release deve ser um objeto JSON")
    revision = require_pattern("revision", metadata.get("revision"), r"[a-f0-9]{40}")
    if env.get("GITHUB_SHA") and env["GITHUB_SHA"] != revision:
        raise ValueError("Revisao do artefato diferente da execucao")
    run_id = require_pattern("run_id", metadata.get("run_id"), r"[1-9][0-9]*")
    attempt = require_pattern("run_attempt", metadata.get("run_attempt"), r"[1-9][0-9]*")
    architecture = {"aarch64": "arm64", "arm64": "arm64", "x86_64": "amd64", "amd64": "amd64"}.get(machine.lower())
    if architecture is None or metadata.get("architecture") != architecture:
        raise ValueError("Arquitetura da imagem diferente da VM")
    for name in ("backend_image", "frontend_image"):
        require_pattern(name, metadata.get(name), r"ghcr\.io/[a-z0-9][a-z0-9._/-]+@sha256:[a-f0-9]{64}")

    secret = require_pattern("JWT_SECRET", env.get("JWT_SECRET"), r"[A-Za-z0-9_+./=-]{32,512}")
    if secret.startswith("REPLACE_"):
        raise ValueError("Configure o secret JWT_SECRET no environment production")
    # Starting the portal does not require a provisioned Slurm cluster. When a
    # host is configured, validate its address and require SSH credentials below.
    host = env.get("SLURM_SSH_HOST") or ""
    if host:
        require_pattern("SLURM_SSH_HOST", host, r"[A-Za-z0-9][A-Za-z0-9._-]*")
    expires = require_pattern("JWT_EXPIRES_IN", env.get("JWT_EXPIRES_IN") or "1h", r"[1-9][0-9]*[smhd]")
    port = int(require_pattern("FRONTEND_PORT", env.get("FRONTEND_PORT") or "8081", r"[0-9]{4,5}"))
    if not 1024 <= port <= 65535:
        raise ValueError("FRONTEND_PORT deve estar entre 1024 e 65535 para Podman rootless")
    bind = env.get("FRONTEND_BIND") or "127.0.0.1"
    if bind not in ("127.0.0.1", "0.0.0.0"):
        raise ValueError("FRONTEND_BIND deve ser 127.0.0.1 ou 0.0.0.0")
    ipaddress.ip_address(bind)
    upload = int(require_pattern("UPLOAD_MAX_SIZE_MB", env.get("UPLOAD_MAX_SIZE_MB") or "50", r"[1-9][0-9]{0,3}"))
    if upload > 1024:
        raise ValueError("UPLOAD_MAX_SIZE_MB deve ser no maximo 1024")
    origins = env.get("CORS_ORIGIN", "")
    for origin in origins.split(",") if origins else []:
        if re.search(r"[\s'\"$#\\]", origin):
            raise ValueError("CORS_ORIGIN deve conter origens HTTP/HTTPS sem espacos")
        url = urlsplit(origin)
        if url.scheme not in ("http", "https") or not url.hostname or url.username or url.password or url.path or url.query or url.fragment:
            raise ValueError("CORS_ORIGIN deve conter somente esquema, host e porta opcional")
        _ = url.port
    return {
        "release_id": f"{revision}-{run_id}-{attempt}",
        "architecture": architecture,
        "backend_image": metadata["backend_image"],
        "frontend_image": metadata["frontend_image"],
        "frontend_port": port,
        "frontend_bind": bind,
        "backend_env": {
            "JWT_SECRET": secret,
            "JWT_EXPIRES_IN": expires,
            "SLURM_SSH_HOST": host,
            "CORS_ORIGIN": origins,
            "UPLOAD_MAX_SIZE_MB": str(upload),
        },
    }


def write_private(path, text):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w", encoding="utf-8") as output:
        output.write(text)


def env_text(values):
    # All values are validated; escape quotes for the Compose dotenv parser.
    lines = []
    for key, value in values.items():
        value = str(value)
        if any(char in value for char in ("\n", "\r", "\0", "$")):
            raise ValueError(f"Valor invalido em {key}")
        escaped = value.replace("\\", "\\\\").replace("'", "\\'")
        lines.append(f"{key}='{escaped}'\n")
    return "".join(lines)


def prepare(manifest, base, compose):
    config = validate(json.loads(manifest.read_text(encoding="utf-8")), os.environ, platform.machine())
    ssh = base / "ssh"
    if not ssh.is_dir():
        raise ValueError("Diretorio SSH ausente; execute o bootstrap da VM")
    if config["backend_env"]["SLURM_SSH_HOST"]:
        if not (ssh / "known_hosts").is_file() or (ssh / "known_hosts").stat().st_size == 0:
            raise ValueError(f"Instale known_hosts com chaves de host verificadas em {ssh}")
        keys = list(ssh.glob("*.key"))
        if not keys:
            raise ValueError(f"Instale pelo menos uma chave <usuario>.key em {ssh}")
        if any(key.stat().st_mode & 0o077 for key in keys):
            raise ValueError("As chaves SSH devem ter permissao 600")
    compose_values = {
        "BACKEND_IMAGE": config["backend_image"],
        "FRONTEND_IMAGE": config["frontend_image"],
        "SLURM_SSH_MOUNT": str(ssh),
        "FRONTEND_BIND": config["frontend_bind"],
        "FRONTEND_PORT": config["frontend_port"],
        "NGINX_CLIENT_MAX_BODY_SIZE": f"{int(config['backend_env']['UPLOAD_MAX_SIZE_MB']) + 1}m",
        "UPLOAD_TMP_SIZE_MB": int(config["backend_env"]["UPLOAD_MAX_SIZE_MB"]) + 64,
    }
    # Validate/serialize everything before creating the release directory.
    compose_text = env_text(compose_values)
    backend_text = env_text(config.pop("backend_env"))
    target = base / "releases" / config["release_id"]
    target.mkdir(mode=0o700)
    shutil.copyfile(compose, target / "compose.yaml")
    (target / "compose.yaml").chmod(0o600)
    write_private(target / "compose.env", compose_text)
    write_private(target / "backend.env", backend_text)
    write_private(target / "release.json", json.dumps(config, indent=2) + "\n")
    return config["release_id"]


if __name__ == "__main__":
    try:
        if len(sys.argv) != 4:
            raise ValueError("Uso: prepare-release.py release.json diretorio-base compose.yaml")
        print(prepare(*(Path(value) for value in sys.argv[1:])))
    except (ValueError, KeyError, OSError) as error:
        # Validation errors identify the field, never its secret value.
        print(f"Falha ao preparar release: {error}", file=sys.stderr)
        sys.exit(1)
