#!/usr/bin/python3 -I
"""Slurm epilog: remove only this job's rootless containers on its compute node.

Slurmd invokes the entry point as root. All Podman operations and receipt writes
run in a separate process after switching to the job owner and clearing the env.
No Slurm RPCs or user shell scripts are executed by the privileged entry point.
"""
import datetime
import json
import os
from pathlib import Path
import pwd
import re
import socket
import subprocess
import sys


def cleanup(job_id):
    result = subprocess.run(
        ["/usr/bin/podman", "ps", "-aq", "--filter", f"label=io.openbatch.slurm-job={job_id}"],
        check=True, capture_output=True, text=True, timeout=15,
    )
    ids = result.stdout.split()
    if any(not re.fullmatch(r"[a-f0-9]{12,64}", value) for value in ids):
        raise ValueError("Invalid container ID")
    if ids:
        subprocess.run(["/usr/bin/podman", "rm", "-f", "--ignore", *ids], check=True, timeout=25)
    receipts = Path.home() / ".openbatch_jobs" / ".cleanup"
    receipts.mkdir(parents=True, exist_ok=True, mode=0o700)
    target = receipts / f"{job_id}.json"
    temporary = receipts / f"{job_id}.{os.getpid()}.tmp"
    temporary.write_text(json.dumps({
        "jobId": job_id, "node": socket.gethostname(), "status": "done",
        "finishedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    }) + "\n", encoding="utf-8")
    temporary.replace(target)


def main():
    os.umask(0o077)
    if os.geteuid() != 0:
        if len(sys.argv) != 3 or sys.argv[1] != "--user-cleanup" or not sys.argv[2].isdigit():
            raise ValueError("Invalid cleanup invocation")
        cleanup(sys.argv[2])
        return
    job_id = os.environ.get("SLURM_JOB_ID", "")
    user = os.environ.get("SLURM_JOB_USER", "")
    if not re.fullmatch(r"[0-9]+", job_id) or not re.fullmatch(r"[a-z_][a-z0-9_-]*", user):
        raise ValueError("Missing or invalid Slurm job identity")
    account = pwd.getpwnam(user)
    if str(account.pw_uid) != os.environ.get("SLURM_JOB_UID") or account.pw_uid < 1000:
        raise ValueError("Slurm UID does not match the local account")
    # Other cluster users without an OpenBatch rootless store need no cleanup.
    if not Path(f"/var/lib/openbatch-podman/{account.pw_uid}").is_dir():
        return
    subprocess.run([
        "/usr/sbin/runuser", "-u", user, "--", "/usr/bin/env", "-i",
        f"HOME={account.pw_dir}", f"USER={user}", f"LOGNAME={user}",
        "PATH=/usr/bin:/bin", f"XDG_RUNTIME_DIR=/run/user/{account.pw_uid}",
        "/usr/bin/python3", "-I", "/usr/local/lib/openbatch/slurm-epilog.py", "--user-cleanup", job_id,
    ], check=True, timeout=60)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, subprocess.SubprocessError) as error:
        print(f"OpenBatch epilog failed: {error}", file=sys.stderr)
        sys.exit(1)
