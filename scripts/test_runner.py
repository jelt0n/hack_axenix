"""Run real Docker integration tests, optionally through the operator's SSH Unix tunnel."""

import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    args = sys.argv[1:]
    env = os.environ.copy()
    if "--remote" in args:
        args.remove("--remote")
        socket = ROOT / ".cache/ssh/docker.sock"
        docker = ROOT / ".cache/bin/docker"
        if not socket.is_socket() or not docker.is_file():
            sys.exit("Сначала откройте операторский SSH-канал к Docker")
        env["DOCKER_HOST"] = "unix://" + str(socket)
        env["BLUEPRINTS_DOCKER_BIN"] = str(docker)
    docker = env.get("BLUEPRINTS_DOCKER_BIN", "docker")
    env["BLUEPRINTS_DOCKER_BIN"] = docker
    subprocess.run([docker, "info", "--format", "{{.ServerVersion}}"], env=env, check=True)
    if "--browser" in args:
        args.remove("--browser")
        command = ["npm", "run", "test:e2e", "--", *args]
    else:
        command = [str(ROOT / ".venv/bin/pytest"), "tests/test_docker_checks.py", "-q", *args]
    raise SystemExit(subprocess.call(command, cwd=ROOT, env=env))


if __name__ == "__main__":
    main()
