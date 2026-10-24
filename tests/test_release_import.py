"""Exercise the offline bundle on a fresh containerd daemon, not the build daemon."""

import os
import shlex
import subprocess
import sys
import time
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
RELEASE = os.environ.get("BLUEPRINTS_RELEASE_DIR")
pytestmark = pytest.mark.skipif(
    not RELEASE, reason="Requires a built release and CI Docker-in-Docker"
)


def test_release_import_pins_runnable_images_in_a_fresh_containerd_store(tmp_path):
    docker = shlex.split(os.environ.get("BLUEPRINTS_DOCKER_BIN", "docker"))
    name = "blueprints-import-" + uuid.uuid4().hex
    subprocess.run(
        [
            *docker,
            "run",
            "-d",
            "--privileged",
            "--network",
            "none",
            "--name",
            name,
            "-e",
            "DOCKER_TLS_CERTDIR=",
            "docker:29-dind",
        ],
        check=True,
        capture_output=True,
    )
    nested = [*docker, "exec", "-i", name, "docker"]
    try:
        deadline = time.monotonic() + 45
        while True:
            ready = subprocess.run(
                [*nested, "info", "--format", "{{json .DriverStatus}}"],
                capture_output=True,
                text=True,
            )
            if ready.returncode == 0:
                break
            if time.monotonic() >= deadline:
                raise AssertionError("Fresh Docker daemon did not become ready")
            time.sleep(0.2)
        assert "io.containerd.snapshotter.v1" in ready.stdout, ready.stdout
        output = tmp_path / "runtime.env"
        imported = subprocess.run(
            [
                sys.executable,
                str(ROOT / "scripts/load_release.py"),
                str(Path(RELEASE).resolve()),
                "--docker",
                shlex.join(nested),
                "--output",
                str(output),
            ],
            capture_output=True,
            text=True,
            timeout=240,
        )
        assert imported.returncode == 0, imported.stdout + imported.stderr
        identities = dict(line.split("=", 1) for line in output.read_text().splitlines())
        assert set(identities) == {
            "BLUEPRINTS_API_IMAGE",
            "BLUEPRINTS_WORKER_IMAGE",
            "BLUEPRINTS_RUNNER_IMAGE",
            "BLUEPRINTS_PROXY_IMAGE",
        }
        for identity in identities.values():
            started = subprocess.run(
                [
                    *nested,
                    "run",
                    "--rm",
                    "--network",
                    "none",
                    "--pull",
                    "never",
                    "--entrypoint",
                    "/bin/true",
                    identity,
                ],
                capture_output=True,
                text=True,
                timeout=30,
            )
            assert started.returncode == 0, started.stderr
    finally:
        subprocess.run([*docker, "rm", "-fv", name], check=True, capture_output=True)
