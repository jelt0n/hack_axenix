from fastapi.testclient import TestClient

from backend.app import create_app


def test_project_limit_is_global_and_preserves_existing_visitors(tmp_path, monkeypatch):
    monkeypatch.setenv("BLUEPRINTS_PROJECT_LIMIT", "2")
    app = create_app(tmp_path)
    payload = {"filename": "Capacity.java", "source": "class Capacity {}"}
    with TestClient(app) as first, TestClient(app) as second, TestClient(app) as third:
        one = first.post("/api/projects", json=payload)
        two = second.post("/api/projects", json=payload)
        assert one.status_code == two.status_code == 201
        rejected = third.post("/api/projects", json=payload)
        assert rejected.status_code == 429, rejected.text
        assert "проект" in rejected.json()["detail"].lower()
        assert first.get("/api/projects/current").json() == one.json()
        assert second.get("/api/projects/current").json() == two.json()
    with TestClient(create_app(tmp_path)) as after_restart:
        assert after_restart.post("/api/projects", json=payload).status_code == 429


def test_utf8_storage_budget_rejects_save_atomically(tmp_path, monkeypatch):
    monkeypatch.setenv("BLUEPRINTS_PROJECT_BYTES", "4096")
    with TestClient(create_app(tmp_path)) as client:
        response = client.post(
            "/api/projects",
            json={
                "filename": "Capacity.java",
                "source": "class Capacity {}",
            },
        )
        assert response.status_code == 201, response.text
        project = response.json()
        prefix = f"/api/projects/{project['id']}"
        rejected = client.post(
            prefix + "/source",
            json={
                "revision": 1,
                "source": "class Capacity {} //" + "Я" * 3000,
            },
        )
        assert rejected.status_code == 429, rejected.text
        assert client.get(prefix).json() == project
        assert client.get(prefix + "/export").text == "class Capacity {}"


def test_storage_budget_counts_all_visitors_and_imported_models(tmp_path, monkeypatch):
    monkeypatch.setenv("BLUEPRINTS_PROJECT_BYTES", "4096")
    app = create_app(tmp_path)
    payload = {"filename": "Capacity.java", "source": "class Capacity {} //" + "Я" * 400}
    with TestClient(app) as first, TestClient(app) as second:
        accepted = first.post("/api/projects", json=payload)
        assert accepted.status_code == 201, accepted.text
        rejected = second.post("/api/projects", json=payload)
        assert rejected.status_code == 429, rejected.text
        assert first.get("/api/projects/current").json() == accepted.json()
        assert second.get("/api/projects/current").status_code == 404
