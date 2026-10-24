import json
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path


class RevisionConflict(Exception):
    pass


class ProjectNotFound(Exception):
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
            db.execute("DELETE FROM projects WHERE created < ?", (time.time() - 24 * 3600,))
            db.execute(
                "INSERT INTO projects VALUES (?, ?, ?, ?)",
                (project["id"], session, time.time(), json.dumps(project, ensure_ascii=False)),
            )
        return project

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
            db.execute(
                "UPDATE projects SET payload=? WHERE id=?",
                (json.dumps(project, ensure_ascii=False), project_id),
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


def summary(project: dict) -> dict:
    return {key: value for key, value in project.items() if key != "graphs"}
