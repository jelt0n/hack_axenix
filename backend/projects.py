import json
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path


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
        return json.loads(row[0]) if row else None


def summary(project: dict) -> dict:
    return {key: value for key, value in project.items() if key != "graphs"}
