"""Persistent, capability-owned check queue. This module never accesses Docker."""

import hashlib
import json
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.workspace import sources


class Scenario(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=80)
    stdin: str = Field(max_length=32_768)

    @field_validator("stdin")
    @classmethod
    def bounded_input(cls, value: str) -> str:
        if len(value.encode("utf-8")) > 32_768:
            raise ValueError("Ввод сценария превышает 32 КБ")
        return value


class CheckRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=1)
    scenarios: list[Scenario] = Field(min_length=1, max_length=5)
    mainClass: str | None = Field(default=None, min_length=1, max_length=200)

    originalMainClass: str | None = Field(default=None, min_length=1, max_length=200)

    @field_validator("mainClass", "originalMainClass")
    @classmethod
    def class_name(cls, value: str | None) -> str | None:
        if value is not None and not all(
            part.replace("$", "_").isidentifier() for part in value.split(".")
        ):
            raise ValueError("Укажите полное имя Java-класса без аргументов командной строки")
        if value and value.startswith("dev.blueprints.runtime."):
            raise ValueError("Это пространство имён зарезервировано исполнителем")
        return value


class QueueFull(Exception):
    pass


class CheckQueue:
    def __init__(self, directory: Path):
        directory.mkdir(parents=True, exist_ok=True)
        self.directory = directory
        self.path = directory / "checks.sqlite3"
        with self.connect() as db:
            db.execute("""CREATE TABLE IF NOT EXISTS checks (
                id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session TEXT NOT NULL,
                created REAL NOT NULL, updated REAL NOT NULL, status TEXT NOT NULL,
                phase TEXT NOT NULL, payload TEXT NOT NULL, result TEXT
            )""")
            db.execute("CREATE INDEX IF NOT EXISTS checks_queue ON checks(status, created)")
            db.execute("""CREATE TABLE IF NOT EXISTS worker (
                singleton INTEGER PRIMARY KEY CHECK (singleton=1), seen REAL NOT NULL
            )""")

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        try:
            with db:
                yield db
        finally:
            db.close()

    def enqueue(
        self,
        session: str,
        project: dict,
        request: CheckRequest,
        main_class: str,
        original_main: str | None = None,
    ) -> dict:
        now = time.time()
        payload = {
            "sourceRevision": project["revision"],
            "filename": project["filename"],
            "mainClass": main_class,
            "originalMainClass": original_main or main_class,
            "scenarios": [s.model_dump() for s in request.scenarios],
            "sourceOriginal": project["originalSource"],
            "sourceWorking": project["generatedSource"],
            "filesOriginal": sources(project, original=True),
            "filesWorking": sources(project),
            "originalHash": hashlib.sha256(
                json.dumps(
                    sources(project, original=True), sort_keys=True, ensure_ascii=False
                ).encode()
            ).hexdigest(),
            "workingHash": hashlib.sha256(
                json.dumps(sources(project), sort_keys=True, ensure_ascii=False).encode()
            ).hexdigest(),
        }
        job_id = secrets.token_urlsafe(18)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute(
                "DELETE FROM checks WHERE created < ? AND status != 'running'", (now - 86400,)
            )
            total = db.execute(
                "SELECT COUNT(*) FROM checks WHERE status IN ('queued','running')"
            ).fetchone()[0]
            own = db.execute(
                "SELECT COUNT(*) FROM checks WHERE session=? AND status IN ('queued','running')",
                (session,),
            ).fetchone()[0]
            if total >= 20 or own >= 2:
                raise QueueFull("Очередь заполнена. Дождитесь завершения текущих проверок.")
            db.execute(
                "INSERT INTO checks VALUES (?, ?, ?, ?, ?, 'queued', 'queued', ?, NULL)",
                (job_id, project["id"], session, now, now, json.dumps(payload, ensure_ascii=False)),
            )
        return self.get(session, job_id)

    def get(self, session: str, job_id: str) -> dict | None:
        with self.connect() as db:
            row = db.execute(
                "SELECT * FROM checks WHERE id=? AND session=? AND created>?",
                (job_id, session, time.time() - 86400),
            ).fetchone()
            if row is None:
                return None
            position = (
                db.execute(
                    "SELECT COUNT(*) FROM checks WHERE status='queued' AND created<=?",
                    (row["created"],),
                ).fetchone()[0]
                if row["status"] == "queued"
                else None
            )
        payload = json.loads(row["payload"])
        return {
            "id": row["id"],
            "projectId": row["project_id"],
            "sourceRevision": payload["sourceRevision"],
            "createdAt": row["created"],
            "status": row["status"],
            "phase": row["phase"],
            "queuePosition": position,
            "mainClass": payload["mainClass"],
            "originalMainClass": payload.get("originalMainClass", payload["mainClass"]),
            "scenarios": payload["scenarios"],
            "originalHash": payload["originalHash"],
            "workingHash": payload["workingHash"],
            "result": json.loads(row["result"]) if row["result"] else None,
        }

    def latest(self, session: str, project_id: str) -> dict | None:
        with self.connect() as db:
            row = db.execute(
                "SELECT id FROM checks WHERE project_id=? AND session=? AND created>? "
                "ORDER BY created DESC LIMIT 1",
                (project_id, session, time.time() - 86400),
            ).fetchone()
        return self.get(session, row[0]) if row else None

    def heartbeat(self):
        with self.connect() as db:
            db.execute("INSERT OR REPLACE INTO worker VALUES (1, ?)", (time.time(),))

    def available(self) -> bool:
        with self.connect() as db:
            row = db.execute("SELECT seen FROM worker WHERE singleton=1").fetchone()
        return bool(row and row[0] > time.time() - 12)

    def offline(self):
        with self.connect() as db:
            db.execute("UPDATE worker SET seen=0 WHERE singleton=1")

    def claim(self) -> dict | None:
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM checks WHERE status='running'").fetchone():
                return None
            row = db.execute(
                "SELECT id,payload FROM checks WHERE status='queued' ORDER BY created LIMIT 1"
            ).fetchone()
            if row is None:
                return None
            db.execute(
                "UPDATE checks SET status='running', phase='preparing', updated=? WHERE id=?",
                (time.time(), row["id"]),
            )
        return {"id": row["id"], **json.loads(row["payload"])}

    def progress(self, job_id: str, phase: str):
        with self.connect() as db:
            db.execute(
                "UPDATE checks SET phase=?,updated=? WHERE id=? AND status='running'",
                (phase, time.time(), job_id),
            )

    def complete(self, job_id: str, result: dict):
        with self.connect() as db:
            row = db.execute("SELECT payload FROM checks WHERE id=?", (job_id,)).fetchone()
            payload = json.loads(row[0])
            payload.pop("sourceOriginal", None)
            payload.pop("sourceWorking", None)
            payload.pop("filesOriginal", None)
            payload.pop("filesWorking", None)
            status = "failed" if result["verdict"] == "inconclusive" else "completed"
            db.execute(
                "UPDATE checks SET status=?,phase='finished',result=?,payload=?,updated=? "
                "WHERE id=?",
                (
                    status,
                    json.dumps(result, ensure_ascii=False),
                    json.dumps(payload, ensure_ascii=False),
                    time.time(),
                    job_id,
                ),
            )
            db.execute(
                "DELETE FROM checks WHERE id IN (SELECT id FROM checks "
                "WHERE status IN ('completed','failed') ORDER BY created DESC LIMIT -1 OFFSET 500)"
            )

    def recover(self):
        with self.connect() as db:
            rows = db.execute("SELECT id FROM checks WHERE status='running'").fetchall()
        for row in rows:
            self.complete(
                row[0],
                {
                    "verdict": "inconclusive",
                    "cases": [],
                    "error": {
                        "kind": "interrupted",
                        "message": "Исполнитель был перезапущен. Запустите проверку снова.",
                    },
                },
            )
