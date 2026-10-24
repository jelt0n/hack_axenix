"""Download the trusted Java toolchain libraries using the committed checksums."""

import hashlib
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def prepare_java_dependencies():
    target = ROOT / ".cache/java"
    target.mkdir(parents=True, exist_ok=True)
    dependencies = json.loads((ROOT / "java/dependencies.json").read_text())
    for name, item in dependencies.items():
        destination = target / name
        if destination.exists():
            data = destination.read_bytes()
        else:
            print(f"Downloading {name}", flush=True)
            with urllib.request.urlopen(item["url"], timeout=60) as response:
                data = response.read()
        if hashlib.sha256(data).hexdigest() != item["sha256"]:
            raise RuntimeError(f"Checksum mismatch: {name}")
        if not destination.exists():
            destination.write_bytes(data)


if __name__ == "__main__":
    prepare_java_dependencies()
