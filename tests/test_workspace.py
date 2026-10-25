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
        for path in ["../Bad.java", "/Bad.java", "a//B.java", "a/../B.java", "a\\B.java"]:
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
