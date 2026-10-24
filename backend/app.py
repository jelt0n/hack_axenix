import os
import secrets
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from backend.checks import CheckQueue, CheckRequest, QueueFull
from backend.java_parser import ParserUnavailable, parse_java
from backend.projects import ProjectStore, summary

ROOT = Path(__file__).resolve().parents[1]
COOKIE = "blueprints_session"
MAX_BODY = 512 * 1024


class ImportProject(BaseModel):
    filename: str = Field(min_length=6, max_length=120)
    source: str = Field(min_length=1, max_length=256_000)

    @field_validator("filename")
    @classmethod
    def java_filename(cls, value: str) -> str:
        if not value.endswith(".java") or any(c in value for c in "/\\\r\n"):
            raise ValueError("Загрузите файл с расширением .java без пути к каталогу")
        if not value.isprintable():
            raise ValueError("Недопустимое имя файла")
        return value


def create_app(data_dir: Path | None = None) -> FastAPI:
    app = FastAPI(title="Java Blueprints", version="0.1.0")
    directory = data_dir or Path(os.environ.get("BLUEPRINTS_DATA_DIR", ROOT / ".data"))
    store = ProjectStore(directory)
    checks = CheckQueue(directory)

    @app.middleware("http")
    async def limit_request(request: Request, call_next):
        if request.method == "POST" and request.url.path.startswith("/api/"):
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > MAX_BODY:
                    return JSONResponse(
                        {"detail": "Файл слишком большой. Лимит запроса — 512 КБ."}, 413
                    )
            # Starlette forwards the cached body to downstream JSON validation.
            request._body = bytes(body)
        return await call_next(request)

    def owned(request: Request, project_id: str | None = None) -> dict:
        project = store.get(request.cookies.get(COOKIE, ""), project_id)
        if project is None:
            raise HTTPException(404, "Проект не найден или срок хранения истёк")
        return project

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    @app.get("/api/runner")
    def runner_status():
        return {"available": checks.available()}

    @app.post("/api/projects/{project_id}/checks", status_code=202)
    def create_check(project_id: str, payload: CheckRequest, request: Request):
        project = owned(request, project_id)
        if payload.revision != project["revision"]:
            raise HTTPException(409, "Версия проекта изменилась. Обновите проект перед проверкой.")
        candidates = sorted(
            {
                ((project["packageName"] + ".") if project["packageName"] else "")
                + method["owner"].replace(".", "$")
                for method in project["methods"]
                if method["name"] == "main" and method["hasBody"]
            }
        )
        main_class = payload.mainClass or (candidates[0] if len(candidates) == 1 else None)
        if main_class is None:
            raise HTTPException(422, "Укажите класс с public static void main(String[] args)")
        try:
            CheckRequest.class_name(main_class)
            return checks.enqueue(request.cookies.get(COOKIE, ""), project, payload, main_class)
        except QueueFull as exc:
            raise HTTPException(429, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.get("/api/checks/{job_id}")
    def get_check(job_id: str, request: Request):
        job = checks.get(request.cookies.get(COOKIE, ""), job_id)
        if job is None:
            raise HTTPException(404, "Проверка не найдена")
        return job

    @app.get("/api/projects/{project_id}/checks/latest")
    def latest_check(project_id: str, request: Request):
        owned(request, project_id)
        job = checks.latest(request.cookies.get(COOKIE, ""), project_id)
        if job is None:
            raise HTTPException(404, "Проверок пока нет")
        return job

    @app.post("/api/projects", status_code=201)
    def import_project(payload: ImportProject, request: Request, response: Response):
        try:
            parsed = parse_java(payload.source)
        except ParserUnavailable as exc:
            raise HTTPException(503, str(exc)) from exc
        if not parsed["ok"]:
            raise HTTPException(
                422, {"message": "Java содержит синтаксические ошибки", "errors": parsed["errors"]}
            )
        session = request.cookies.get(COOKIE) or secrets.token_urlsafe(32)
        project = store.create(session, payload.filename, payload.source, parsed)
        response.set_cookie(
            COOKIE,
            session,
            max_age=24 * 3600,
            httponly=True,
            samesite="strict",
            secure=request.url.scheme == "https",
        )
        return summary(project)

    @app.get("/api/projects/current")
    def current_project(request: Request):
        return summary(owned(request))

    @app.get("/api/projects/{project_id}")
    def get_project(project_id: str, request: Request):
        return summary(owned(request, project_id))

    @app.get("/api/projects/{project_id}/methods/{method_id}/graph")
    def get_graph(project_id: str, method_id: str, request: Request):
        project = owned(request, project_id)
        graph = project["graphs"].get(method_id)
        if graph is None:
            raise HTTPException(404, "Метод не найден")
        return graph

    @app.get("/api/projects/{project_id}/export")
    def export_project(project_id: str, request: Request):
        project = owned(request, project_id)
        filename = quote(project["filename"], safe="")
        return Response(
            project["generatedSource"],
            media_type="text/plain; charset=utf-8",
            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
        )

    if (ROOT / "dist").is_dir():
        app.mount("/", StaticFiles(directory=ROOT / "dist", html=True), name="frontend")
    return app
