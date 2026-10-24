import json
import subprocess
from pathlib import Path
from threading import Lock

ROOT = Path(__file__).resolve().parents[1]
JAVA_CACHE = ROOT / ".cache/java"
CLASSES = JAVA_CACHE / "classes"
COMPILE_LOCK = Lock()
PARSE_LOCK = Lock()


class ParserUnavailable(Exception):
    pass


def prepare_parser():
    sources = sorted((ROOT / "java/src").glob("*.java"))
    dependencies = json.loads((ROOT / "java/dependencies.json").read_text())
    jars = [JAVA_CACHE / name for name in dependencies]
    if not all(jar.exists() for jar in jars):
        raise ParserUnavailable("Подготовьте Java-зависимости: python3 scripts/setup.py")
    with COMPILE_LOCK:
        targets = [CLASSES / f"{source.stem}.class" for source in sources]
        if all(target.exists() for target in targets) and min(
            target.stat().st_mtime for target in targets
        ) >= max(source.stat().st_mtime for source in sources):
            return
        CLASSES.mkdir(parents=True, exist_ok=True)
        try:
            result = subprocess.run(
                [
                    "java",
                    "-m",
                    "jdk.compiler/com.sun.tools.javac.Main",
                    "-encoding",
                    "UTF-8",
                    "-cp",
                    ":".join(str(jar) for jar in jars),
                    "-d",
                    str(CLASSES),
                    *[str(source) for source in sources],
                ],
                capture_output=True,
                text=True,
                timeout=30,
                check=False,
            )
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise ParserUnavailable("Не удалось подготовить JavaParser") from exc
        if result.returncode:
            raise ParserUnavailable(f"Не удалось собрать Java-модуль: {result.stderr[:2000]}")


def parse_java(source: str, *, edit: dict | None = None, analyze: bool = False) -> dict:
    prepare_parser()
    try:
        # Keep concurrent parse requests within the memory budget of the demo server.
        with PARSE_LOCK:
            result = subprocess.run(
                [
                    "java",
                    "-Xmx128m",
                    "-Xss512k",
                    "-cp",
                    f"{CLASSES}:{JAVA_CACHE}/*",
                    "BlueprintParser",
                ],
                input=json.dumps({"source": source, "edit": edit, "analyze": analyze}),
                capture_output=True,
                encoding="utf-8",
                timeout=15,
                check=False,
            )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ParserUnavailable("JavaParser недоступен или превысил время разбора") from exc
    if result.returncode or len(result.stdout) > 8 * 1024 * 1024:
        raise ParserUnavailable("JavaParser не смог обработать этот исходник")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ParserUnavailable("JavaParser вернул некорректный ответ") from exc
