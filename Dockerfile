FROM eclipse-temurin:21-jdk-jammy AS jdk
FROM ghcr.io/astral-sh/uv:0.13.1 AS uv
FROM docker:29-cli AS docker-cli

FROM python:3.14-slim AS runtime
COPY --from=jdk /opt/java/openjdk /opt/java/openjdk
COPY --from=uv /uv /usr/local/bin/uv
ENV JAVA_HOME=/opt/java/openjdk PATH="/opt/java/openjdk/bin:/app/.venv/bin:$PATH" \
    BLUEPRINTS_DATA_DIR=/data UV_LINK_MODE=copy
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev
COPY backend ./backend
COPY java ./java
COPY dist ./dist
COPY scripts/java_dependencies.py ./scripts/java_dependencies.py
RUN python scripts/java_dependencies.py
RUN groupadd -g 1000 blueprints && useradd -u 1000 -g 1000 -M blueprints \
    && mkdir -p /data && chown -R 1000:1000 /data /app/.cache
USER 1000:1000

FROM runtime AS api
EXPOSE 8000
CMD ["uvicorn", "backend.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000", "--limit-concurrency", "32"]

FROM runtime AS worker
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
CMD ["python", "-m", "backend.worker"]
