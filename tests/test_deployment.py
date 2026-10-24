"""Validate the operator-facing Compose contract using the real Compose CLI."""

import json
import os
import shlex
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
COMPOSE = shlex.split(os.environ.get("BLUEPRINTS_COMPOSE_BIN", "docker compose"))
pytestmark = pytest.mark.skipif(not shutil.which(COMPOSE[0]), reason="Compose CLI is required")


def test_release_only_publishes_proxy_and_keeps_docker_with_the_worker():
    env = {
        **os.environ,
        "BLUEPRINTS_API_IMAGE": "java-blueprints-api:release-test",
        "BLUEPRINTS_WORKER_IMAGE": "java-blueprints-worker:release-test",
        "BLUEPRINTS_RUNNER_IMAGE": "java-blueprints-runner:release-test",
        "BLUEPRINTS_PROXY_IMAGE": "java-blueprints-proxy:release-test",
        "DOCKER_GID": "999",
    }
    result = subprocess.run(
        [*COMPOSE, "-f", str(ROOT / "deploy/compose.yaml"), "config", "--format", "json"],
        env=env,
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    config = json.loads(result.stdout)
    services = config["services"]
    assert set(services) == {"api", "worker", "proxy"}
    assert services["proxy"]["ports"][0]["published"] == "80"
    for name, service in services.items():
        assert "build" not in service
        assert service["pull_policy"] == "never"
        assert service["read_only"] is True
        assert int(service["mem_limit"]) > 0
        assert service["pids_limit"] > 0
        if name != "proxy":
            assert not service.get("ports")
        sockets = [v for v in service.get("volumes", []) if "docker.sock" in v["target"]]
        assert len(sockets) == (1 if name == "worker" else 0)
    assert services["worker"]["network_mode"] == "none"
    assert services["worker"]["environment"]["BLUEPRINTS_RUNNER_IMAGE"].endswith("release-test")
    assert config["networks"]["backend"]["internal"] is True
    assert set(services["api"]["networks"]) == {"backend"}
