"""Java file identities, immutable originals and the active editor projection."""

FILE_KEYS = (
    "filename",
    "originalSource",
    "generatedSource",
    "packageName",
    "methods",
    "graphs",
    "graphRevision",
    "modelSource",
    "originalMethods",
    "originalPackageName",
    "diagnostics",
)
MAX_FILES = 32
MAX_PROJECT_BYTES = 1024 * 1024


class FileNotFound(Exception):
    pass


class InvalidWorkspace(ValueError):
    pass


def java_path(value: str) -> str:
    parts = value.split("/")
    if (
        len(value.encode("utf-8")) > 240
        or not value.endswith(".java")
        or any(not part.isidentifier() for part in parts[:-1])
        or not parts[-1].removesuffix(".java").isidentifier()
        or "\\" in value
        or any(ord(c) < 32 for c in value)
    ):
        raise InvalidWorkspace(
            "Укажите относительный путь Java, например demo/Price.java, "
            "без .. и специальных символов."
        )
    return value


def sync_file(project: dict):
    file = next(f for f in project["files"] if f["id"] == project["fileId"])
    file.update({key: project[key] for key in FILE_KEYS})


def select_file(project: dict, file_id: str | None = None) -> dict:
    if "files" not in project:
        file = {key: project[key] for key in FILE_KEYS}
        file.update(id="file-" + project["id"], originalPath=project["filename"], deleted=False)
        project["files"] = [file]
    active = [f for f in project["files"] if not f["deleted"]]
    file = next((f for f in active if f["id"] == file_id), None) if file_id else active[0]
    if file is None:
        raise FileNotFound("Файл не найден")
    project.update({key: file[key] for key in FILE_KEYS})
    project["fileId"] = file["id"]
    if project["generatedSource"] == project["modelSource"]:
        project["graphRevision"] = project["revision"]
    return project


def validate_workspace(project: dict):
    files = [f for f in project["files"] if not f["deleted"]]
    if not 1 <= len(files) <= MAX_FILES:
        raise InvalidWorkspace("Проект должен содержать от 1 до 32 Java-файлов.")
    if len({f["filename"] for f in files}) != len(files):
        raise InvalidWorkspace("Файл с таким путём уже существует.")
    if sum(len(f["generatedSource"].encode("utf-8")) for f in files) > MAX_PROJECT_BYTES:
        raise InvalidWorkspace("Суммарный размер Java-файлов превышает 1 МиБ UTF-8.")


def sources(project: dict, *, original: bool = False) -> dict[str, str]:
    if original:
        return {
            f["originalPath"]: f["originalSource"]
            for f in project["files"]
            if f["originalPath"] is not None
        }
    return {f["filename"]: f["generatedSource"] for f in project["files"] if not f["deleted"]}


def entry_points(project: dict, *, original: bool = False) -> list[str]:
    return sorted(
        {
            (
                (f["originalPackageName" if original else "packageName"] + ".")
                if f["originalPackageName" if original else "packageName"]
                else ""
            )
            + m["owner"].replace(".", "$")
            for f in project["files"]
            if (f["originalPath"] is not None if original else not f["deleted"])
            for m in f["originalMethods" if original else "methods"]
            if m["name"] == "main" and m["hasBody"]
        }
    )
