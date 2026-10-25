import io
import zipfile

from fastapi.testclient import TestClient

from backend.app import create_app

MAIN = (
    'public class Main { public static void main(String[] args) { System.out.println("Привет"); } }'
)


def test_files_share_a_revision_and_keep_the_original_project(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        original = client.post(
            "/api/projects", json={"filename": "Main.java", "source": MAIN}
        ).json()
        url = f"/api/projects/{original['id']}"
        added = client.post(
            url + "/files",
            json={
                "revision": 1,
                "path": "demo/Price.java",
                "source": "package demo; public class Price {}",
            },
        )
        assert added.status_code == 201, added.text
        helper = added.json()
        assert helper["revision"] == 2
        assert len(helper["files"]) == 2
        assert helper["filename"] == "demo/Price.java"
        assert helper["originalSource"] == ""
        assert helper["entryPoints"] == ["Main"]
        file_id = helper["fileId"]
        assert client.get(url + "?fileId=" + file_id).json()["filename"] == "demo/Price.java"
        renamed = client.patch(
            url + "/files/" + file_id, json={"revision": 2, "path": "demo/Cost.java"}
        )
        assert renamed.status_code == 200, renamed.text
        assert renamed.json()["revision"] == 3
        archive = client.get(url + "/export.zip")
        assert archive.status_code == 200
        with zipfile.ZipFile(io.BytesIO(archive.content)) as bundle:
            assert bundle.namelist() == ["Main.java", "demo/Cost.java"]
            assert bundle.read("Main.java").decode() == MAIN
        assert client.post(url + "/source", json={"revision": 1, "source": MAIN}).status_code == 409
        removed = client.delete(url + "/files/" + file_id + "?revision=3")
        assert removed.status_code == 200, removed.text
        assert removed.json()["revision"] == 4
        assert len(removed.json()["files"]) == 1
        assert removed.json()["originalSource"] == MAIN
        assert client.get(url + "?fileId=" + file_id).status_code == 404


def test_selected_file_edits_do_not_touch_siblings_and_are_private(tmp_path):
    with TestClient(create_app(tmp_path)) as client, TestClient(create_app(tmp_path)) as other:
        project = client.post(
            "/api/projects", json={"filename": "Main.java", "source": MAIN}
        ).json()
        url = f"/api/projects/{project['id']}"
        added = client.post(
            url + "/files",
            json={
                "revision": 1,
                "path": "Price.java",
                "source": "class Price { int value() { return 5; } }",
            },
        ).json()
        file_id = added["fileId"]
        selected = url + "?fileId=" + file_id
        assert other.get(selected).status_code == 404
        for path in [
            "../Bad.java",
            "/Bad.java",
            "a//B.java",
            "a/../B.java",
            "a\\B.java",
            "A.java.java",
            "Main.java/Helper.java",
            "ж" * 126 + ".java",
            "ж" * 130 + "/A.java",
        ]:
            assert (
                client.post(url + "/files", json={"revision": 2, "path": path}).status_code == 422
            )
        assert (
            client.post(url + "/files", json={"revision": 2, "path": "Main.java"}).status_code
            == 422
        )
        modified = client.post(
            url + "/source?fileId=" + file_id,
            json={"revision": 2, "source": "class Price { int value() { return 6; } }"},
        )
        assert modified.status_code == 200, modified.text
        rebuilt = client.post(url + "/rebuild?fileId=" + file_id, json={"revision": 3})
        assert rebuilt.status_code == 200, rebuilt.text
        assert rebuilt.json()["graphRevision"] == 3
        assert client.get(url).json()["generatedSource"] == MAIN
        assert client.get(url).json()["graphRevision"] == 3
        method = rebuilt.json()["methods"][0]
        graph = client.get(url + f"/methods/{method['id']}/graph?fileId={file_id}").json()
        assert any(n["code"] == "return 6;" for n in graph["nodes"])
        assert client.delete(url + "/files/" + project["fileId"] + "?revision=3").status_code == 200
        assert client.delete(url + "/files/" + file_id + "?revision=4").status_code == 422


def test_project_utf8_budget_rejects_a_file_without_partial_creation(tmp_path):
    source = "class C {} //" + "ж" * 115000
    with TestClient(create_app(tmp_path)) as client:
        project = client.post("/api/projects", json={"filename": "C.java", "source": source}).json()
        url = f"/api/projects/{project['id']}"
        for revision, name in [(1, "D.java"), (2, "E.java"), (3, "F.java")]:
            response = client.post(
                url + "/files", json={"revision": revision, "path": name, "source": source}
            )
            assert response.status_code == 201, response.text
        rejected = client.post(
            url + "/files", json={"revision": 4, "path": "G.java", "source": source}
        )
        assert rejected.status_code == 422, rejected.text
        current = client.get(url).json()
        assert current["revision"] == 4
        assert [f["path"] for f in current["files"]] == ["C.java", "D.java", "E.java", "F.java"]


def test_pre_workspace_project_is_readable_and_file_identity_survives_restart(tmp_path):
    import json
    import sqlite3
    import time

    create_app(tmp_path)
    source = "class Legacy {}"
    legacy = {
        "id": "legacy-project",
        "filename": "Legacy.java",
        "revision": 1,
        "originalSource": source,
        "generatedSource": source,
        "packageName": "",
        "methods": [],
        "graphs": {},
    }
    with sqlite3.connect(tmp_path / "projects.sqlite3") as db:
        db.execute(
            "INSERT INTO projects VALUES (?, ?, ?, ?)",
            ("legacy-project", "legacy-session", time.time(), json.dumps(legacy)),
        )
    with TestClient(
        create_app(tmp_path), cookies={"blueprints_session": "legacy-session"}
    ) as client:
        first = client.get("/api/projects/current").json()
        second = client.get("/api/projects/legacy-project").json()
        assert first["fileId"] == second["fileId"]
        assert second["generatedSource"] == source
        added = client.post(
            "/api/projects/legacy-project/files",
            json={"revision": 1, "path": "Helper.java", "source": "class Helper {}"},
        )
        assert added.status_code == 201, added.text
    with TestClient(
        create_app(tmp_path), cookies={"blueprints_session": "legacy-session"}
    ) as restored:
        after = restored.get("/api/projects/current").json()
        assert after["fileId"] == first["fileId"]
        assert len(after["files"]) == 2
        assert after["originalSource"] == source
