from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient

from backend.app import create_app

SOURCE = """class Demo {
  int first() { return 1; }
  int second() { return 2; }
}
"""


def test_saved_working_source_has_a_new_revision_and_survives_reload(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        project = client.post(
            "/api/projects", json={"filename": "Demo.java", "source": SOURCE}
        ).json()
        changed = SOURCE.replace("return 1;", "return 10;")
        response = client.post(
            f"/api/projects/{project['id']}/source", json={"revision": 1, "source": changed}
        )
        assert response.status_code == 200, response.text
        saved = response.json()
        assert saved["revision"] == 2
        assert saved["graphRevision"] == 1
        assert saved["generatedSource"] == changed
        assert saved["originalSource"] == SOURCE
        assert saved["modelSource"] == SOURCE
        cookies = dict(client.cookies)
    with TestClient(create_app(tmp_path), cookies=cookies) as restored:
        saved = restored.get("/api/projects/current").json()
        assert saved["revision"] == 2
        assert saved["generatedSource"] == changed
        assert restored.get(f"/api/projects/{project['id']}/export").text == changed


def test_rebuild_replaces_only_the_valid_model_and_preserves_invalid_text(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        project = client.post(
            "/api/projects", json={"filename": "Demo.java", "source": SOURCE}
        ).json()
        prefix = f"/api/projects/{project['id']}"
        first = project["methods"][0]
        graph = client.get(f"{prefix}/methods/{first['id']}/graph").json()
        invalid = SOURCE.replace("return 1;", "return ; }")
        saved = client.post(prefix + "/source", json={"revision": 1, "source": invalid}).json()
        failed = client.post(prefix + "/rebuild", json={"revision": saved["revision"]})
        assert failed.status_code == 200, failed.text
        failed = failed.json()
        assert failed["generatedSource"] == invalid
        assert failed["revision"] == 2 and failed["graphRevision"] == 1
        assert failed["diagnostics"][0]["line"] >= 1
        stale = client.get(f"{prefix}/methods/{first['id']}/graph").json()
        assert stale["nodes"] == graph["nodes"] and stale["stale"]
        assert stale["projectRevision"] == 2 and stale["sourceRevision"] == 1
        corrected = SOURCE.replace("return 1;", "return 10;")
        client.post(prefix + "/source", json={"revision": 2, "source": corrected})
        rebuilt = client.post(prefix + "/rebuild", json={"revision": 3}).json()
        assert rebuilt["revision"] == rebuilt["graphRevision"] == 3
        assert rebuilt["diagnostics"] == []
        assert rebuilt["originalSource"] == SOURCE
        assert rebuilt["originalMethods"] == project["methods"]
        assert rebuilt["generatedSource"] == corrected
        assert rebuilt["methods"][1]["signature"] == "second()"
        fresh = client.get(f"{prefix}/methods/{rebuilt['methods'][0]['id']}/graph").json()
        assert not fresh["stale"] and fresh["sourceRevision"] == 3
        assert any(n["code"] == "return 10;" for n in fresh["nodes"])
        assert client.get("/api/projects/current").json() == rebuilt


def test_conflicting_tabs_and_stale_rebuild_cannot_overwrite_newer_source(tmp_path):
    with TestClient(create_app(tmp_path)) as owner:
        project = owner.post(
            "/api/projects", json={"filename": "Demo.java", "source": SOURCE}
        ).json()
        prefix = f"/api/projects/{project['id']}"
        cookies = dict(owner.cookies)

        def save(value):
            with TestClient(create_app(tmp_path), cookies=cookies) as tab:
                return tab.post(prefix + "/source", json={"revision": 1, "source": value})

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(save, [SOURCE + "// One", SOURCE + "// Two"]))
        assert sorted(r.status_code for r in results) == [200, 409]
        current = owner.get(prefix).json()
        assert current["revision"] == 2
        assert current["generatedSource"] in (SOURCE + "// One", SOURCE + "// Two")
        assert owner.post(prefix + "/rebuild", json={"revision": 1}).status_code == 409
        assert owner.get(prefix).json() == current
        same = owner.post(
            prefix + "/source", json={"revision": 2, "source": current["generatedSource"]}
        ).json()
        assert same["revision"] == 2
        with TestClient(create_app(tmp_path)) as outsider:
            assert (
                outsider.post(prefix + "/source", json={"revision": 2, "source": ""}).status_code
                == 404
            )
            assert outsider.post(prefix + "/rebuild", json={"revision": 2}).status_code == 404


def test_empty_source_is_saved_and_large_inputs_do_not_replace_project(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        project = client.post(
            "/api/projects", json={"filename": "Demo.java", "source": SOURCE}
        ).json()
        prefix = f"/api/projects/{project['id']}"
        assert (
            client.post(
                prefix + "/source", json={"revision": 1, "source": "я" * 128_001}
            ).status_code
            == 422
        )
        assert client.get(prefix).json()["revision"] == 1
        empty = client.post(prefix + "/source", json={"revision": 1, "source": ""}).json()
        assert empty["generatedSource"] == "" and empty["revision"] == 2
        assert client.get(prefix + "/export").text == ""
