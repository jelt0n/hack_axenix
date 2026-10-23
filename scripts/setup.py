"""Prepare pinned Java dependencies, Python, Node and the E2E browser."""

import hashlib
import json
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = {
    "javaparser-core-3.27.1.jar": "com/github/javaparser/javaparser-core/3.27.1",
    "gson-2.13.2.jar": "com/google/code/gson/gson/2.13.2",
}


def main():
    target = ROOT / ".cache/java"
    target.mkdir(parents=True, exist_ok=True)
    lock_path = ROOT / "java/dependencies.json"
    known = json.loads(lock_path.read_text()) if lock_path.exists() else {}
    locked = {}
    for name, artifact in ARTIFACTS.items():
        url = f"https://repo.maven.apache.org/maven2/{artifact}/{name}"
        destination = target / name
        if not destination.exists():
            print(f"Downloading {name}", flush=True)
            with urllib.request.urlopen(url, timeout=60) as response:
                destination.write_bytes(response.read())
        digest = hashlib.sha256(destination.read_bytes()).hexdigest()
        if name in known and known[name]["sha256"] != digest:
            sys.exit(f"Checksum mismatch: {name}")
        locked[name] = {"url": url, "sha256": digest}
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path.write_text(json.dumps(locked, indent=2) + "\n")
    subprocess.run(["uv", "sync", "--cache-dir", str(ROOT / ".cache/uv")], cwd=ROOT, check=True)
    subprocess.run(
        ["npm", "ci" if (ROOT / "package-lock.json").exists() else "install"], cwd=ROOT, check=True
    )
    subprocess.run(["npx", "playwright", "install", "chromium"], cwd=ROOT, check=True)


if __name__ == "__main__":
    main()
