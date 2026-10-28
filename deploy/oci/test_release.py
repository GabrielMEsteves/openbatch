import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("prepare-release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseConfigTests(unittest.TestCase):
    def setUp(self):
        self.metadata = {
            "revision": "a" * 40, "run_id": "123", "run_attempt": "1", "architecture": "arm64",
            "backend_image": "ghcr.io/example/openbatch-backend@sha256:" + "b" * 64,
            "frontend_image": "ghcr.io/example/openbatch-frontend@sha256:" + "c" * 64,
        }
        self.env = {"JWT_SECRET": "d" * 64, "SLURM_SSH_HOST": "10.0.0.10"}

    def test_requires_production_secret_but_allows_initial_deploy_without_cluster(self):
        with self.assertRaises(ValueError):
            release.validate(self.metadata, {"SLURM_SSH_HOST": "10.0.0.10"}, "aarch64")
        config = release.validate(self.metadata, {"JWT_SECRET": self.env["JWT_SECRET"]}, "aarch64")
        self.assertEqual(config["backend_env"]["SLURM_SSH_HOST"], "")
        with self.assertRaises(ValueError):
            release.validate(self.metadata, self.env | {"SLURM_SSH_HOST": "host;command"}, "aarch64")

    def test_production_defaults_and_explicit_variables(self):
        defaults = release.validate(self.metadata, self.env, "aarch64")
        self.assertEqual(defaults["frontend_bind"], "127.0.0.1")
        self.assertEqual(defaults["frontend_port"], 8081)
        self.assertEqual(defaults["backend_env"]["JWT_EXPIRES_IN"], "1h")
        changed = release.validate(self.metadata, self.env | {
            "FRONTEND_BIND": "0.0.0.0", "FRONTEND_PORT": "9090", "UPLOAD_MAX_SIZE_MB": "75",
            "CORS_ORIGIN": "https://portal.example.com", "JWT_EXPIRES_IN": "30m",
        }, "aarch64")
        self.assertEqual(changed["frontend_port"], 9090)
        self.assertEqual(changed["backend_env"]["UPLOAD_MAX_SIZE_MB"], "75")
        self.assertEqual(changed["backend_env"]["CORS_ORIGIN"], "https://portal.example.com")
        with self.assertRaises(ValueError):
            release.validate([], self.env, "aarch64")

    def test_rejects_mutable_images_wrong_revision_and_wrong_architecture(self):
        for changes in ({"backend_image": "ghcr.io/example/backend:latest"}, {"architecture": "amd64"}, {"run_id": "../other"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                release.validate(self.metadata | changes, self.env, "aarch64")
        with self.assertRaises(ValueError):
            release.validate(self.metadata, self.env | {"GITHUB_SHA": "f" * 40}, "aarch64")

    def test_rejects_env_injection_without_exposing_secret(self):
        secret = "e" * 40 + "\nENABLE_DEV_LOGIN=true"
        with self.assertRaises(ValueError) as result:
            release.validate(self.metadata, self.env | {"JWT_SECRET": secret}, "aarch64")
        self.assertNotIn(secret, str(result.exception))
        with self.assertRaises(ValueError):
            release.env_text({"JWT_SECRET": "${OTHER_SECRET}"})

    def test_rejects_invalid_ports_origins_and_upload_limits(self):
        for change in ({"FRONTEND_PORT": "80"}, {"FRONTEND_BIND": "::"}, {"CORS_ORIGIN": "https://example.com/path"}, {"UPLOAD_MAX_SIZE_MB": "0"}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                release.validate(self.metadata, self.env | change, "aarch64")

    @unittest.skipIf(os.name == "nt", "POSIX permissions are verified on Linux CI")
    def test_writes_secret_only_to_private_backend_env_and_preserves_existing_release(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            (base / "releases").mkdir()
            (base / "ssh").mkdir()
            (base / "ssh/known_hosts").write_text("# fixture: SSH connectivity is not tested here\n")
            key = base / "ssh/user.key"
            key.write_text("fixture")
            key.chmod(0o600)
            manifest = base / "manifest.json"
            manifest.write_text(json.dumps(self.metadata))
            compose = base / "compose.yaml"
            compose.write_text("services: {}\n")
            with patch.dict(os.environ, self.env, clear=True), patch.object(release.platform, "machine", return_value="aarch64"):
                identifier = release.prepare(manifest, base, compose)
                target = base / "releases" / identifier
                self.assertIn(self.env["JWT_SECRET"], (target / "backend.env").read_text())
                for name in ("release.json", "compose.env", "compose.yaml"):
                    self.assertNotIn(self.env["JWT_SECRET"], (target / name).read_text())
                self.assertEqual((target / "backend.env").stat().st_mode & 0o777, 0o600)
                with self.assertRaises(FileExistsError):
                    release.prepare(manifest, base, compose)

    @unittest.skipIf(os.name == "nt", "POSIX file generation is verified on Linux CI")
    def test_initial_deploy_without_ssh_files_and_configured_cluster_requires_them(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            (base / "releases").mkdir()
            (base / "ssh").mkdir()
            manifest = base / "manifest.json"
            manifest.write_text(json.dumps(self.metadata))
            compose = base / "compose.yaml"
            compose.write_text("services: {}\n")
            with patch.dict(os.environ, self.env, clear=True), patch.object(release.platform, "machine", return_value="aarch64"):
                with self.assertRaisesRegex(ValueError, "known_hosts"):
                    release.prepare(manifest, base, compose)
                os.environ.pop("SLURM_SSH_HOST")
                identifier = release.prepare(manifest, base, compose)
                backend = (base / "releases" / identifier / "backend.env").read_text()
                self.assertIn("SLURM_SSH_HOST=''", backend)
                self.assertNotIn("ENABLE_DEV_LOGIN=true", backend)


if __name__ == "__main__":
    unittest.main()
