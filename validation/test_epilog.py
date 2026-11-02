"""Exercise identity boundaries, job filtering and cleanup receipts without Podman."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[1] / 'ansible/roles/slurm_podman_lab/files/slurm-epilog.py'
# The production helper is Linux-only. Stub the account lookup on Windows tests.
try:
    import pwd
except ImportError:
    pwd = types.ModuleType('pwd')
    pwd.getpwnam = lambda user: None
    sys.modules['pwd'] = pwd
spec = importlib.util.spec_from_file_location('epilog', SOURCE)
epilog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(epilog)


class EpilogTests(unittest.TestCase):
    def test_cleanup_filters_by_job_and_removes_only_returned_ids(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(epilog.Path, 'home', return_value=Path(directory)), \
                patch.object(epilog.subprocess, 'run') as run:
            run.return_value.stdout = 'abcdef012345\n'
            epilog.cleanup('42')
            self.assertEqual(run.call_args_list[0].args[0], [
                '/usr/bin/podman', 'ps', '-aq', '--filter', 'label=io.openbatch.slurm-job=42'])
            self.assertEqual(run.call_args_list[1].args[0], [
                '/usr/bin/podman', 'rm', '-f', '--ignore', 'abcdef012345'])
            receipt = json.loads((Path(directory) / '.openbatch_jobs/.cleanup/42.json').read_text())
            self.assertEqual(receipt['jobId'], '42')
            self.assertEqual(receipt['status'], 'done')
            self.assertTrue(receipt['finishedAt'])

    def test_failed_removal_does_not_claim_success(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(epilog.Path, 'home', return_value=Path(directory)), \
                patch.object(epilog.subprocess, 'run') as run:
            run.side_effect = [types.SimpleNamespace(stdout='abcdef012345'), subprocess.CalledProcessError(1, 'podman')]
            with self.assertRaises(subprocess.CalledProcessError):
                epilog.cleanup('42')
            self.assertFalse((Path(directory) / '.openbatch_jobs/.cleanup/42.json').exists())

    def test_invalid_container_output_cannot_become_a_cli_option(self):
        with patch.object(epilog.subprocess, 'run') as run:
            run.return_value.stdout = '--all'
            with self.assertRaises(ValueError):
                epilog.cleanup('42')
            self.assertEqual(run.call_count, 1)

    def test_root_entry_drops_privileges_and_clears_environment(self):
        account = types.SimpleNamespace(pw_uid=2000, pw_dir='/srv/openbatch/users/pesquisador')
        with patch.dict(os.environ, {'SLURM_JOB_ID': '42', 'SLURM_JOB_USER': 'pesquisador', 'SLURM_JOB_UID': '2000', 'CONTAINER_HOST': 'malicious'}), \
                patch.object(epilog.os, 'geteuid', return_value=0, create=True), \
                patch.object(epilog.os, 'umask'), patch.object(epilog.pwd, 'getpwnam', return_value=account), \
                patch.object(epilog.Path, 'is_dir', return_value=True), patch.object(epilog.subprocess, 'run') as run:
            epilog.main()
            argv = run.call_args.args[0]
            self.assertEqual(argv[:6], ['/usr/sbin/runuser', '-u', 'pesquisador', '--', '/usr/bin/env', '-i'])
            self.assertIn('XDG_RUNTIME_DIR=/run/user/2000', argv)
            self.assertNotIn('CONTAINER_HOST=malicious', argv)
            self.assertIn('-I', argv)
            self.assertEqual(argv[-2:], ['--user-cleanup', '42'])

    def test_root_entry_rejects_mismatched_uid(self):
        with patch.dict(os.environ, {'SLURM_JOB_ID': '42', 'SLURM_JOB_USER': 'pesquisador', 'SLURM_JOB_UID': '1000'}), \
                patch.object(epilog.os, 'geteuid', return_value=0, create=True), patch.object(epilog.os, 'umask'), \
                patch.object(epilog.pwd, 'getpwnam', return_value=types.SimpleNamespace(pw_uid=2000)), \
                patch.object(epilog.subprocess, 'run') as run:
            with self.assertRaises(ValueError):
                epilog.main()
            run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
