"""Prepare pinned Java dependencies, Python, Node and the E2E browser."""

import subprocess
from pathlib import Path

from java_dependencies import prepare_java_dependencies

ROOT = Path(__file__).resolve().parents[1]


def main():
    prepare_java_dependencies()
    subprocess.run(["uv", "sync", "--cache-dir", str(ROOT / ".cache/uv")], cwd=ROOT, check=True)
    subprocess.run(
        ["npm", "ci" if (ROOT / "package-lock.json").exists() else "install"], cwd=ROOT, check=True
    )
    subprocess.run(["npx", "playwright", "install", "chromium"], cwd=ROOT, check=True)


if __name__ == "__main__":
    main()
