from fastapi.testclient import TestClient

from backend.app import create_app

SOURCE = """public class Hello {
    public static void main(String[] args) {
        System.out.println(new java.util.Scanner(System.in).nextLine());
    }
}
"""


def test_check_is_queued_for_an_owned_immutable_revision(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        project = client.post(
            "/api/projects", json={"filename": "Hello.java", "source": SOURCE}
        ).json()
        response = client.post(
            f"/api/projects/{project['id']}/checks",
            json={"revision": 1, "scenarios": [{"name": "Кириллица", "stdin": "Привет\n"}]},
        )
        assert response.status_code == 202, response.text
        job = response.json()
        assert job["status"] == "queued"
        assert job["sourceRevision"] == 1
        assert job["projectId"] == project["id"]
        assert job["mainClass"] == "Hello"
        assert job["result"] is None
        assert job["scenarios"] == [{"name": "Кириллица", "stdin": "Привет\n"}]
        assert client.get(f"/api/checks/{job['id']}").json()["id"] == job["id"]


def test_checks_are_private_bounded_and_reject_wrong_revisions(tmp_path):
    with TestClient(create_app(tmp_path)) as client, TestClient(create_app(tmp_path)) as other:
        project = client.post(
            "/api/projects", json={"filename": "Hello.java", "source": SOURCE}
        ).json()
        url = f"/api/projects/{project['id']}/checks"
        payload = {"revision": 1, "scenarios": [{"name": "Обычный вход", "stdin": "Hello\n"}]}
        assert other.post(url, json=payload).status_code == 404
        assert client.post(url, json={**payload, "revision": 2}).status_code == 409
        assert client.post(url, json={**payload, "scenarios": []}).status_code == 422
        assert client.post(url, json={**payload, "image": "arbitrary-image"}).status_code == 422
        assert client.post(url, json={**payload, "mainClass": "--help"}).status_code == 422
        first = client.post(url, json=payload).json()
        assert other.get(f"/api/checks/{first['id']}").status_code == 404
        assert client.post(url, json=payload).status_code == 202
        assert client.post(url, json=payload).status_code == 429
        assert client.get(f"/api/checks/{first['id']}").json()["result"] is None


def test_latest_check_and_inputs_survive_api_restart(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        project = client.post(
            "/api/projects", json={"filename": "Hello.java", "source": SOURCE}
        ).json()
        job = client.post(
            f"/api/projects/{project['id']}/checks",
            json={
                "revision": 1,
                "scenarios": [{"name": "Пустой", "stdin": ""}],
            },
        ).json()
        cookies = dict(client.cookies)
    with TestClient(create_app(tmp_path), cookies=cookies) as client:
        restored = client.get(f"/api/projects/{project['id']}/checks/latest").json()
        assert restored["id"] == job["id"]
        assert restored["scenarios"] == [{"name": "Пустой", "stdin": ""}]
        assert restored["status"] == "queued"
        assert "sourceOriginal" not in restored
