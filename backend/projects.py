import json
import os
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path


class RevisionConflict(Exception):
    pass


class ProjectNotFound(Exception):
    pass


class ProjectCapacityExceeded(Exception):
    pass


def editor_state(project: dict) -> dict:
    """Load older imported projects without changing their sources or model."""
    project.setdefault("graphRevision", project["revision"])
    project.setdefault("modelSource", project["generatedSource"])
    project.setdefault("originalMethods", project["methods"])
    project.setdefault("originalPackageName", project["packageName"])
    project.setdefault("diagnostics", [])
    return project


class ProjectStore:
    """Only opaque browser capabilities can read projects; IDs are not credentials."""

    def __init__(self, directory: Path):
        directory.mkdir(parents=True, exist_ok=True)
        self.path = directory / "projects.sqlite3"
        self.project_limit = int(os.environ.get("BLUEPRINTS_PROJECT_LIMIT", "100"))
        self.byte_limit = int(os.environ.get("BLUEPRINTS_PROJECT_BYTES", str(64 * 1024 * 1024)))
        if self.project_limit < 1 or self.byte_limit < 1:
            raise ValueError("Project count and byte limits must be positive")
        with self.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS projects (
                id TEXT PRIMARY KEY, session TEXT NOT NULL, created REAL NOT NULL,
                payload TEXT NOT NULL
            )""")
            db.execute("CREATE INDEX IF NOT EXISTS projects_session ON projects(session, created)")

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.path)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def create(self, session: str, filename: str, source: str, parsed: dict) -> dict:
        project = {
            "id": secrets.token_urlsafe(18),
            "filename": filename,
            "revision": 1,
            "originalSource": source,
            "generatedSource": parsed["generatedSource"],
            "packageName": parsed["packageName"],
            "methods": parsed["methods"],
            "graphs": parsed["graphs"],
            "graphRevision": 1,
            "modelSource": parsed["generatedSource"],
            "originalMethods": parsed["methods"],
            "originalPackageName": parsed["packageName"],
            "diagnostics": [],
        }
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM projects WHERE created < ?", (time.time() - 24 * 3600,))
            if db.execute("SELECT COUNT(*) FROM projects").fetchone()[0] >= self.project_limit:
                raise ProjectCapacityExceeded(
                    "Достигнут общий лимит временных проектов. Повторите позже."
                )
            db.execute(
                "INSERT INTO projects VALUES (?, ?, ?, ?)",
                (project["id"], session, time.time(), self._payload(db, project)),
            )
        return project

    def _payload(self, db: sqlite3.Connection, project: dict) -> str:
        payload = json.dumps(project, ensure_ascii=False)
        occupied = db.execute(
            "SELECT COALESCE(SUM(length(CAST(payload AS BLOB))), 0) FROM projects WHERE id != ?",
            (project["id"],),
        ).fetchone()[0]
        if occupied + len(payload.encode("utf-8")) > self.byte_limit:
            raise ProjectCapacityExceeded(
                "Хранилище временных проектов заполнено. Изменение не сохранено; уменьшите исходник или повторите позже."
            )
        return payload

    def get(self, session: str, project_id: str | None = None) -> dict | None:
        with self.connect() as db:
            if project_id is None:
                row = db.execute(
                    "SELECT payload FROM projects WHERE session = ? AND created > ? "
                    "ORDER BY created DESC LIMIT 1",
                    (session, time.time() - 24 * 3600),
                ).fetchone()
            else:
                row = db.execute(
                    "SELECT payload FROM projects WHERE id = ? AND session = ? AND created > ?",
                    (project_id, session, time.time() - 24 * 3600),
                ).fetchone()
        return editor_state(json.loads(row[0])) if row else None

    def _update(self, session: str, project_id: str, revision: int, change) -> dict:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute(
                "SELECT payload FROM projects WHERE id=? AND session=? AND created>?",
                (project_id, session, time.time() - 86400),
            ).fetchone()
            if row is None:
                raise ProjectNotFound
            project = editor_state(json.loads(row[0]))
            if project["revision"] != revision:
                raise RevisionConflict
            change(project)
            db.execute("DELETE FROM projects WHERE created < ?", (time.time() - 86400,))
            db.execute(
                "UPDATE projects SET payload=? WHERE id=?",
                (self._payload(db, project), project_id),
            )
        return project

    def save_source(self, session: str, project_id: str, revision: int, source: str) -> dict:
        def change(project):
            if project["generatedSource"] != source:
                project["generatedSource"] = source
                project["revision"] += 1
                project["diagnostics"] = []

        return self._update(session, project_id, revision, change)

    def rebuild(self, session: str, project_id: str, revision: int, parsed: dict) -> dict:
        def change(project):
            project["diagnostics"] = parsed.get("errors", [])
            if parsed["ok"]:
                project.update(
                    packageName=parsed["packageName"],
                    methods=parsed["methods"],
                    graphs=parsed["graphs"],
                    graphRevision=project["revision"],
                    modelSource=project["generatedSource"],
                )

        return self._update(session, project_id, revision, change)

    def apply_graph_edit(self, session: str, project_id: str, revision: int, parsed: dict) -> dict:
        def change(project):
            if project["graphRevision"] != revision:
                raise RevisionConflict
            if project["generatedSource"] != parsed["generatedSource"]:
                project["revision"] += 1
            project.update(
                generatedSource=parsed["generatedSource"],
                modelSource=parsed["generatedSource"],
                methods=parsed["methods"],
                graphs=parsed["graphs"],
                packageName=parsed["packageName"],
                graphRevision=project["revision"],
                diagnostics=[],
            )

        return self._update(session, project_id, revision, change)


def summary(project: dict) -> dict:
    return {key: value for key, value in project.items() if key != "graphs"}
