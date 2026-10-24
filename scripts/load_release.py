"""Load an offline release and pin identities resolved by this Docker image store."""

import argparse
import hashlib
import json
import re
import shlex
import subprocess
import tarfile
from pathlib import Path


def config_id(path: str) -> str:
    digest = path.rsplit("/", 1)[-1].removesuffix(".json")
    if not re.fullmatch(r"[a-f0-9]{64}", digest):
        raise ValueError("Invalid image configuration digest")
    return "sha256:" + digest


def tag_configs(records: list[dict], tags: dict[str, str]) -> dict[str, str]:
    by_tag = {
        tag.removeprefix("docker.io/library/"): config_id(record["Config"])
        for record in records
        for tag in record.get("RepoTags") or []
    }
    try:
        return {name: by_tag[tag] for name, tag in tags.items()}
    except KeyError as error:
        raise ValueError("Archive must retain every release tag; rebuild the release") from error


def archive_configs(path: Path, tags: dict[str, str]) -> dict[str, str]:
    with tarfile.open(path) as archive:
        records = json.load(archive.extractfile("manifest.json"))
        identities = tag_configs(records, tags)
        for record in records:
            stream = archive.extractfile(record["Config"])
            actual = "sha256:" + hashlib.file_digest(stream, "sha256").hexdigest()
            if actual != config_id(record["Config"]):
                raise ValueError("Image configuration digest does not match its content")
    return identities


def verify_checksums(directory: Path) -> None:
    checked = set()
    for line in (directory / "SHA256SUMS").read_text().splitlines():
        digest, name = line.split("  ", 1)
        if Path(name).name != name:
            raise ValueError("Checksum paths must be plain filenames")
        with (directory / name).open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != digest:
                raise ValueError(f"Checksum mismatch: {name}")
        checked.add(name)
    if not {"images.tar.gz", "manifest.json", "compose.yaml", "load_release.py"} <= checked:
        raise ValueError("Incomplete release checksums")


def verify_loaded_configs(docker: list[str], tags: dict, expected: dict) -> None:
    # IDs differ between classic and containerd stores. The raw image configuration
    # contains both runtime settings and RootFS diff_ids and is portable between them.
    seen = set()
    process = subprocess.Popen([*docker, "image", "save", *tags.values()], stdout=subprocess.PIPE)
    try:
        with tarfile.open(fileobj=process.stdout, mode="r|") as archive:
            records = None
            for member in archive:
                if member.name == "manifest.json":
                    records = json.load(archive.extractfile(member))
                elif member.name.rsplit("/", 1)[-1].removesuffix(".json") in {
                    value.removeprefix("sha256:") for value in expected.values()
                }:
                    actual = (
                        "sha256:"
                        + hashlib.file_digest(archive.extractfile(member), "sha256").hexdigest()
                    )
                    if actual != config_id(member.name):
                        raise ValueError("Loaded image configuration was changed")
                    seen.add(actual)
        while process.stdout.read(1024 * 1024):
            pass
        if process.wait() or records is None or tag_configs(records, tags) != expected:
            raise ValueError("Loaded tags do not refer to the verified configurations")
        if seen != set(expected.values()):
            raise ValueError("Loaded image configuration is missing")
    except BaseException:
        process.kill()
        process.wait()
        raise
    finally:
        process.stdout.close()


def load_release(directory: Path, docker: list[str], output: Path) -> dict[str, str]:
    verify_checksums(directory)
    manifest = json.loads((directory / "manifest.json").read_text())
    tags = manifest["tags"]
    expected = archive_configs(directory / "images.tar.gz", tags)
    if expected != manifest["configs"]:
        raise ValueError("Release image configurations do not match the archive")
    with (directory / "images.tar.gz").open("rb") as stream:
        subprocess.run([*docker, "image", "load"], stdin=stream, check=True)
    identities = {
        name: subprocess.check_output(
            [*docker, "image", "inspect", tag, "--format", "{{.Id}}"], text=True
        ).strip()
        for name, tag in tags.items()
    }
    if not all(re.fullmatch(r"sha256:[a-f0-9]{64}", value) for value in identities.values()):
        raise ValueError("Docker did not return valid image identities")
    verify_loaded_configs(docker, tags, expected)
    temporary = output.with_suffix(output.suffix + ".tmp")
    temporary.write_text(
        "".join(
            f"BLUEPRINTS_{name.upper()}_IMAGE={identity}\n" for name, identity in identities.items()
        )
    )
    temporary.replace(output)
    print(f"Loaded configurations verified; host image identities written to {output}")
    return identities


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--docker", default="docker", help="Trusted operator Docker command")
    parser.add_argument("--output", type=Path, help="Default: DIRECTORY/runtime.env")
    options = parser.parse_args()
    load_release(
        options.directory,
        shlex.split(options.docker),
        options.output or options.directory / "runtime.env",
    )
