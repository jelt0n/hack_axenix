import os
import secrets
from pathlib import Path
from urllib.parse import quote

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.checks import CheckQueue, CheckRequest, QueueFull
from backend.java_parser import ParserUnavailable, parse_java
from backend.projects import ProjectNotFound, ProjectStore, RevisionConflict, summary

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


class RevisionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    revision: int = Field(ge=1)


class SourceRequest(RevisionRequest):
    source: str = Field(max_length=256_000)

    @field_validator("source")
    @classmethod
    def source_size(cls, value: str) -> str:
        if len(value.encode("utf-8")) > 256_000:
            raise ValueError("Исходник превышает 256 КБ UTF-8")
        return value


def create_app(data_dir: Path | None = None) -> FastAPI:
    app = FastAPI(title="Java Blueprints", version="0.1.0")
    directory = data_dir or Path(os.environ.get("BLUEPRINTS_DATA_DIR", ROOT / ".data"))
    store = ProjectStore(directory)
    checks = CheckQueue(directory)

    @app.exception_handler(RevisionConflict)
    async def revision_conflict(request: Request, exc: RevisionConflict):
        return JSONResponse(
            {"detail": "Версия проекта изменилась. Загрузите актуальную версию перед сохранением."},
            409,
        )

    @app.exception_handler(ProjectNotFound)
    async def project_not_found(request: Request, exc: ProjectNotFound):
        return JSONResponse({"detail": "Проект не найден или срок хранения истёк"}, 404)

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

    @app.post("/api/projects/{project_id}/source")
    def save_source(project_id: str, payload: SourceRequest, request: Request):
        project = store.save_source(
            request.cookies.get(COOKIE, ""), project_id, payload.revision, payload.source
        )
        return summary(project)

    @app.post("/api/projects/{project_id}/rebuild")
    def rebuild(project_id: str, payload: RevisionRequest, request: Request):
        project = owned(request, project_id)
        if project["revision"] != payload.revision:
            raise RevisionConflict
        try:
            parsed = parse_java(project["generatedSource"])
        except ParserUnavailable as exc:
            raise HTTPException(503, str(exc)) from exc
        return summary(
            store.rebuild(request.cookies.get(COOKIE, ""), project_id, payload.revision, parsed)
        )

    @app.post("/api/projects/{project_id}/analysis")
    def analyze_project(project_id: str, payload: RevisionRequest, request: Request):
        project = owned(request, project_id)
        if project["revision"] != payload.revision or project["graphRevision"] != payload.revision:
            raise HTTPException(409, "Обновите граф по текущей версии перед анализом.")
        try:
            parsed = parse_java(project["generatedSource"], analyze=True)
        except ParserUnavailable as exc:
            raise HTTPException(503, str(exc)) from exc
        latest = owned(request, project_id)
        if latest["revision"] != payload.revision:
            raise RevisionConflict
        if not parsed["ok"]:
            raise HTTPException(422, "Исправьте синтаксические ошибки перед анализом.")
        return {"projectId": project_id, "sourceRevision": payload.revision, **parsed["analysis"]}

    @app.get("/api/projects/{project_id}/methods/{method_id}/graph")
    def get_graph(project_id: str, method_id: str, request: Request):
        project = owned(request, project_id)
        graph = project["graphs"].get(method_id)
        if graph is None:
            raise HTTPException(404, "Метод не найден")
        return {
            **graph,
            "sourceRevision": project["graphRevision"],
            "projectRevision": project["revision"],
            "stale": project["graphRevision"] != project["revision"],
        }

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
