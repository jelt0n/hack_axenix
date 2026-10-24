"""Build an offline, image-ID-pinned release on a Linux/amd64 Docker build host."""

import argparse
import gzip
import hashlib
import io
import json
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def build_release(destination: Path) -> None:
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    subprocess.run(["git", "diff", "--exit-code", "HEAD"], cwd=ROOT, check=True)
    platform = subprocess.check_output(
        ["docker", "info", "--format", "{{.OSType}}/{{.Architecture}}"], text=True
    ).strip()
    if platform not in {"linux/x86_64", "linux/amd64"}:
        raise SystemExit("Use a Linux/amd64 Docker build host, outside the demo server")
    destination.mkdir(parents=True, exist_ok=False)
    # Export only committed sources; local untracked files never enter the build context.
    source = subprocess.check_output(["git", "archive", revision], cwd=ROOT)
    with tempfile.TemporaryDirectory(prefix="blueprints-build-") as directory:
        with tarfile.open(fileobj=io.BytesIO(source)) as archive:
            archive.extractall(directory, filter="data")
        build_bundle(Path(directory), destination, revision)


def build_bundle(root: Path, destination: Path, revision: str) -> None:
    def run(*command: str) -> None:
        subprocess.run(command, cwd=root, check=True)

    def output(*command: str) -> str:
        return subprocess.check_output(command, cwd=root, text=True).strip()

    run("npm", "ci")
    run("npm", "run", "build")
    images = {
        name: f"java-blueprints-{name}:{revision}" for name in ("api", "worker", "runner", "proxy")
    }
    base = f"java-blueprints-api:build-{revision}"
    run("docker", "build", "--target", "api", "-t", base, ".")
    run(
        "docker",
        "build",
        "-f",
        "deploy/precompile.Dockerfile",
        "--build-arg",
        f"BASE_IMAGE={base}",
        "-t",
        images["api"],
        ".",
    )
    run("docker", "build", "--target", "worker", "-t", images["worker"], ".")
    run("docker", "build", "-t", images["runner"], "runner")
    run("docker", "build", "-f", "deploy/proxy.Dockerfile", "-t", images["proxy"], ".")
    identities = {
        name: output("docker", "image", "inspect", tag, "--format", "{{.Id}}")
        for name, tag in images.items()
    }
    manifest = {"revision": revision, "platform": "linux/amd64", "images": identities}
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (destination / "release.env").write_text(
        "".join(
            f"BLUEPRINTS_{name.upper()}_IMAGE={identity}\n" for name, identity in identities.items()
        )
    )
    shutil.copyfile(root / "deploy/compose.yaml", destination / "compose.yaml")
    shutil.copyfile(root / "deploy/README.md", destination / "README.md")
    with subprocess.Popen(
        ["docker", "image", "save", *identities.values()], stdout=subprocess.PIPE
    ) as save:
        with gzip.open(destination / "images.tar.gz", "wb", compresslevel=1) as archive:
            shutil.copyfileobj(save.stdout, archive)
        if save.wait():
            raise SystemExit("docker image save failed; discard the incomplete release")
    with (destination / "SHA256SUMS").open("w") as checksums:
        for path in sorted(destination.iterdir()):
            if path.name != "SHA256SUMS":
                with path.open("rb") as stream:
                    digest = hashlib.file_digest(stream, "sha256").hexdigest()
                checksums.write(f"{digest}  {path.name}\n")
    print(f"Release prepared: {destination}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", type=Path, help="New directory for the release bundle")
    build_release(parser.parse_args().destination.resolve())
