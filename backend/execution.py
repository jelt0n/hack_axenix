"""Trusted Docker executor. The web API deliberately does not import this module."""

import hashlib
import hmac
import io
import json
import os
import selectors
import subprocess
import tarfile
import time
import uuid
from dataclasses import dataclass
from pathlib import PurePosixPath

IMAGE = "java-blueprints-runner:dev"
OUTPUT_LIMIT = 65_536
COMPILE_TIMEOUT = 25
RUN_TIMEOUT = 5


class RunnerError(Exception):
    pass


class OutcomeError(Exception):
    pass


@dataclass
class ProcessResult:
    stdout: bytes
    stderr: bytes
    code: int
    status: str
    duration_ms: int


def bounded_process(
    command: list[str], *, stdin: bytes = b"", timeout: float = 15, limit: int = OUTPUT_LIMIT
) -> ProcessResult:
    """Drain both channels while enforcing one wall-clock and combined output budget."""
    started = time.monotonic()
    try:
        process = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
    except OSError as exc:
        raise RunnerError("Не удалось запустить Docker CLI") from exc
    output = {"stdout": bytearray(), "stderr": bytearray()}
    status = "finished"
    offset = 0
    with selectors.DefaultSelector() as selector:
        for name, stream in (("stdout", process.stdout), ("stderr", process.stderr)):
            os.set_blocking(stream.fileno(), False)
            selector.register(stream, selectors.EVENT_READ, name)
        if stdin:
            os.set_blocking(process.stdin.fileno(), False)
            selector.register(process.stdin, selectors.EVENT_WRITE, "stdin")
        else:
            process.stdin.close()
        try:
            while selector.get_map():
                remaining = timeout - (time.monotonic() - started)
                if remaining <= 0:
                    status = "timeout"
                    break
                for key, _ in selector.select(min(remaining, 0.1)):
                    if key.data == "stdin":
                        try:
                            offset += os.write(key.fd, stdin[offset : offset + 8192])
                        except BlockingIOError:
                            continue
                        except BrokenPipeError:
                            offset = len(stdin)
                        if offset == len(stdin):
                            selector.unregister(key.fileobj)
                            key.fileobj.close()
                        continue
                    try:
                        chunk = os.read(key.fd, 8192)
                    except BlockingIOError:
                        continue
                    if not chunk:
                        selector.unregister(key.fileobj)
                        key.fileobj.close()
                        continue
                    used = sum(len(data) for data in output.values())
                    output[key.data].extend(chunk[: max(0, limit - used)])
                    if used + len(chunk) > limit:
                        status = "output_limit"
                        break
                if status != "finished":
                    break
        finally:
            if status == "finished":
                try:
                    process.wait(timeout=max(0.01, timeout - (time.monotonic() - started)))
                except subprocess.TimeoutExpired:
                    status = "timeout"
            if process.poll() is None:
                process.kill()
            process.wait()
            for stream in (process.stdin, process.stdout, process.stderr):
                if not stream.closed:
                    stream.close()
    return ProcessResult(
        bytes(output["stdout"]),
        bytes(output["stderr"]),
        process.returncode,
        status,
        int((time.monotonic() - started) * 1000),
    )


@dataclass
class ProgramResult:
    status: str
    stdout: bytes = b""
    stderr: bytes = b""
    exit_code: int | None = None
    duration_ms: int = 0
    exception: dict | None = None
    stack_traces: tuple[bytes, ...] = ()

    @classmethod
    def from_process(cls, process: ProcessResult, status: str):
        return cls(status, process.stdout, process.stderr, process.code, process.duration_ms)

    def public(self) -> dict:
        return {
            "status": self.status,
            "stdout": self.stdout.decode("utf-8", errors="replace"),
            "stderr": self.stderr.decode("utf-8", errors="replace"),
            "exitCode": self.exit_code,
            "durationMs": self.duration_ms,
            "exception": self.exception,
            "stackTrace": b"".join(self.stack_traces).decode("utf-8", errors="replace"),
        }

    def observations(self) -> tuple:
        return self.stdout, self.stderr, self.exit_code, self.exception


class DockerExecutor:
    def __init__(self, deployment: str, image: str | None = None):
        self.deployment = deployment
        self.docker = os.environ.get("BLUEPRINTS_DOCKER_BIN", "docker")
        image = image or os.environ.get("BLUEPRINTS_RUNNER_IMAGE", IMAGE)
        result = self.control(["image", "inspect", image, "--format", "{{.Id}}"])
        self.image = result.stdout.decode().strip()
        if not self.image.startswith("sha256:"):
            raise RunnerError("Образ исполнителя не подготовлен")

    def control(
        self,
        arguments: list[str],
        *,
        timeout: int = 15,
        stdin: bytes = b"",
        limit: int = OUTPUT_LIMIT,
    ) -> ProcessResult:
        result = bounded_process(
            [self.docker, *arguments], timeout=timeout, stdin=stdin, limit=limit
        )
        if result.status != "finished" or result.code != 0:
            raise RunnerError(
                "Ошибка управления контейнером: "
                + result.stderr.decode("utf-8", errors="replace")[:500]
            )
        return result

    def cleanup_orphans(self):
        ids = (
            self.control(
                ["ps", "-aq", "--filter", f"label=dev.blueprints.deployment={self.deployment}"]
            )
            .stdout.decode()
            .split()
        )
        for container_id in ids:
            self.control(["rm", "-f", container_id])

    def run(
        self,
        filename: str,
        source: str,
        main_class: str,
        stdin: str,
        *,
        files: dict[str, str] | None = None,
    ) -> ProgramResult:
        files = files if files is not None else {filename: source}
        if (
            not files
            or len(files) > 32
            or sum(len(s.encode("utf-8")) for s in files.values()) > 1024 * 1024
        ):
            raise RunnerError("Некорректный размер снимка проекта")
        for path in files:
            if (
                not path.endswith(".java")
                or path.startswith("/")
                or "\\" in path
                or any(p in ("", ".", "..") for p in path.split("/"))
                or "\0" in path
            ):
                raise RunnerError("Некорректный путь снимка исходника")
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode="w") as bundle:
            for path, content in files.items():
                encoded = content.encode("utf-8")
                member = tarfile.TarInfo(path)
                member.size = len(encoded)
                member.mode = 0o600
                bundle.addfile(member, io.BytesIO(encoded))
        name = "blueprints-" + uuid.uuid4().hex
        created = False
        try:
            self.control(
                [
                    "create",
                    "--pull=never",
                    "--name",
                    name,
                    "--label",
                    f"dev.blueprints.deployment={self.deployment}",
                    "--network=none",
                    "--read-only",
                    "--user=1000:1000",
                    "--cap-drop=ALL",
                    "--security-opt=no-new-privileges=true",
                    "--pids-limit=64",
                    "--cpus=1",
                    "--memory=512m",
                    "--memory-swap=512m",
                    "--ulimit=nofile=128:128",
                    "--tmpfs=/work:rw,nosuid,nodev,size=64m,mode=1777",
                    "--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777",
                    "--log-driver=none",
                    "--entrypoint=/usr/bin/sleep",
                    self.image,
                    "infinity",
                ]
            )
            created = True
            self.control(["start", name])
            self.control(
                ["exec", "-i", name, "tar", "-xf", "-", "-C", "/work"],
                stdin=archive.getvalue(),
            )
            compiled = bounded_process(
                [
                    self.docker,
                    "exec",
                    name,
                    "javac",
                    "-J-Xmx192m",
                    "-J-XX:ActiveProcessorCount=1",
                    "-J-XX:+UseSerialGC",
                    "-proc:none",
                    "-encoding",
                    "UTF-8",
                    "-d",
                    "/work/classes",
                    *[str(PurePosixPath("/work") / path) for path in files],
                ],
                timeout=COMPILE_TIMEOUT,
            )
            if compiled.status != "finished":
                return ProgramResult.from_process(compiled, compiled.status)
            if compiled.code:
                status = (
                    "resource_limit"
                    if compiled.code >= 128 or b"OutOfMemoryError" in compiled.stderr
                    else "compile_error"
                )
                return ProgramResult.from_process(compiled, status)
            key = os.urandom(32)
            input_bytes = stdin.encode("utf-8")
            envelope = key + len(input_bytes).to_bytes(4, "big") + input_bytes
            executed = bounded_process(
                [
                    self.docker,
                    "exec",
                    "-i",
                    name,
                    "java",
                    "-Xmx128m",
                    "-XX:ActiveProcessorCount=1",
                    "-XX:+UseSerialGC",
                    "-XX:+DisableAttachMechanism",
                    "-Dfile.encoding=UTF-8",
                    "-Duser.home=/work",
                    "--module-path",
                    "/opt/blueprints/launcher",
                    "--limit-modules=java.se,dev.blueprints.runtime",
                    "--add-modules=java.se",
                    "-cp",
                    "/work/classes",
                    "-m",
                    "dev.blueprints.runtime/dev.blueprints.runtime.Bootstrap",
                    main_class,
                ],
                stdin=envelope,
                timeout=RUN_TIMEOUT,
            )
            if executed.status != "finished":
                return ProgramResult.from_process(executed, executed.status)
            try:
                metadata = self.read_outcome(name, key)
            except OutcomeError:
                status = "resource_limit" if executed.code >= 128 else "execution_error"
                return ProgramResult.from_process(executed, status)
            stage = metadata.get("stage")
            if stage != "finished":
                if stage != "entrypoint_error":
                    status = "resource_limit" if executed.code >= 128 else "execution_error"
                    return ProgramResult.from_process(executed, status)
                return ProgramResult(
                    "entrypoint_error",
                    executed.stdout,
                    executed.stderr
                    + str(metadata.get("message", "Точка входа недоступна")).encode(),
                    executed.code,
                    executed.duration_ms,
                )
            if metadata.get("resourceLimit") or contains_truncation(metadata.get("exception")):
                return ProgramResult.from_process(executed, "resource_limit")
            return ProgramResult(
                "finished",
                executed.stdout,
                executed.stderr,
                executed.code,
                executed.duration_ms,
                metadata.get("exception"),
                tuple(stack.encode() for stack in metadata.get("stackTraces", [])),
            )
        finally:
            if created:
                self.control(["rm", "-f", name])

    def read_outcome(self, name: str, key: bytes) -> dict:
        result = bounded_process(
            [self.docker, "exec", name, "/bin/cat", "/work/outcome.json"], limit=16_384, timeout=5
        )
        if result.status != "finished" or result.code:
            raise OutcomeError("Отчёт JVM недоступен")
        try:
            envelope = json.loads(result.stdout)
            payload = envelope["payload"]
            expected = hmac.new(key, payload.encode("utf-8"), hashlib.sha256).hexdigest()
            if not hmac.compare_digest(envelope["signature"], expected):
                raise ValueError("Подпись отчёта JVM не совпала")
            report = json.loads(payload)
            if not isinstance(report, dict):
                raise ValueError("Некорректный отчёт JVM")
            return report
        except (ValueError, RecursionError, KeyError, TypeError, AttributeError) as exc:
            raise OutcomeError("Исполнитель не получил корректный отчёт JVM") from exc


def contains_truncation(value, depth: int = 0) -> bool:
    if depth > 32:
        return True
    if isinstance(value, dict):
        return bool(value.get("truncated")) or any(
            contains_truncation(v, depth + 1) for v in value.values()
        )
    return isinstance(value, list) and any(contains_truncation(v, depth + 1) for v in value)


def check_snapshot(executor: DockerExecutor, snapshot: dict, progress) -> dict:
    cases = []
    for index, scenario in enumerate(snapshot["scenarios"]):
        case = {
            "name": scenario["name"],
            "stdin": scenario["stdin"],
            "original": None,
            "working": None,
            "matches": False,
        }
        for version, key in (("original", "sourceOriginal"), ("working", "sourceWorking")):
            progress(f"{version}:{index + 1}")
            result = executor.run(
                snapshot["filename"],
                snapshot[key],
                snapshot.get("originalMainClass", snapshot["mainClass"])
                if version == "original"
                else snapshot["mainClass"],
                scenario["stdin"],
                files=snapshot.get("filesOriginal" if version == "original" else "filesWorking"),
            )
            case[version] = result.public()
            if result.status != "finished":
                cases.append(case)
                return {
                    "verdict": "inconclusive",
                    "cases": cases,
                    "error": {
                        "kind": result.status,
                        "message": "Проверка не завершена: " + result.status,
                    },
                }
            if version == "original":
                original = result
            else:
                case["matches"] = original.observations() == result.observations()
        cases.append(case)
    return {
        "verdict": "matched" if all(c["matches"] for c in cases) else "different",
        "cases": cases,
    }
