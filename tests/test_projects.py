import json

from fastapi.testclient import TestClient

from backend.app import create_app

SOURCE = """package demo;

// Комментарии и кириллица должны сохраниться.
public class Orders {
    private final int minimum = 10;

    public int total(int amount) {
        int result = amount * 2;
        if (result >= minimum) {
            return result;
        } else {
            return 0;
        }
    }

    public static void main(String[] args) {
        System.out.println(new Orders().total(12));
    }
}
"""


def test_import_respects_utf8_limit_with_escaped_json_and_rejects_oversized_text(tmp_path):
    declaration = "class A {} //"
    source = declaration + "ж" * ((256_000 - len(declaration.encode())) // 2)
    source += " " * (256_000 - len(source.encode()))
    with TestClient(create_app(tmp_path)) as client:
        imported = client.post(
            "/api/projects",
            content=json.dumps({"filename": "A.java", "source": source}),
            headers={"content-type": "application/json"},
        )
        assert imported.status_code == 201, imported.text
        project = imported.json()
        assert project["originalSource"] == source
        rejected = client.post("/api/projects", json={"filename": "A.java", "source": source + " "})
        assert rejected.status_code == 422
        assert client.get("/api/projects/current").json() == project


def test_import_rejects_multibyte_source_over_the_byte_budget(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        response = client.post(
            "/api/projects", json={"filename": "A.java", "source": "//" + "ж" * 128_000}
        )
        assert response.status_code == 422, response.text[:300]
        assert client.get("/api/projects/current").status_code == 404


def test_import_java_exposes_methods_graph_and_regenerated_source(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        response = client.post("/api/projects", json={"filename": "Orders.java", "source": SOURCE})
        assert response.status_code == 201, response.text
        project = response.json()
        assert project["originalSource"] == SOURCE
        assert project["generatedSource"] == SOURCE
        assert {m["name"] for m in project["methods"]} == {"total", "main"}
        total = next(m for m in project["methods"] if m["name"] == "total")
        graph = client.get(f"/api/projects/{project['id']}/methods/{total['id']}/graph").json()
        assert any(n["kind"] == "condition" and "minimum" in n["code"] for n in graph["nodes"])
        assert {e.get("label") for e in graph["edges"]} >= {"Да", "Нет"}
        assert all(n["range"]["startLine"] >= 6 for n in graph["nodes"])


def test_export_can_be_reimported_without_losing_other_methods_or_comments(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        project = client.post(
            "/api/projects", json={"filename": "Orders.java", "source": SOURCE}
        ).json()
        for method in reversed(project["methods"]):
            assert (
                client.get(
                    f"/api/projects/{project['id']}/methods/{method['id']}/graph"
                ).status_code
                == 200
            )
        exported = client.get(f"/api/projects/{project['id']}/export")
        assert exported.text == SOURCE
        assert "attachment" in exported.headers["content-disposition"]
        reimported = client.post(
            "/api/projects", json={"filename": "Orders.java", "source": exported.text}
        ).json()
        assert [m["signature"] for m in reimported["methods"]] == ["total(int)", "main(String[])"]


def test_browser_project_survives_restart_but_is_not_accessible_to_other_visitors(tmp_path):
    with TestClient(create_app(tmp_path)) as first, TestClient(create_app(tmp_path)) as other:
        project = first.post(
            "/api/projects", json={"filename": "Orders.java", "source": SOURCE}
        ).json()
        cookie = dict(first.cookies)
        assert other.get("/api/projects/current").status_code == 404
        assert other.get(f"/api/projects/{project['id']}").status_code == 404
        assert other.get(f"/api/projects/{project['id']}/export").status_code == 404
        method_id = project["methods"][0]["id"]
        assert (
            other.get(f"/api/projects/{project['id']}/methods/{method_id}/graph").status_code == 404
        )
    with TestClient(create_app(tmp_path), cookies=cookie) as restored:
        response = restored.get("/api/projects/current")
        assert response.json()["id"] == project["id"]
        assert response.json()["originalSource"] == SOURCE


def test_syntax_error_reports_location_without_replacing_current_project(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        project = client.post(
            "/api/projects", json={"filename": "Orders.java", "source": SOURCE}
        ).json()
        response = client.post(
            "/api/projects",
            json={"filename": "Broken.java", "source": "class Broken { void main( }"},
        )
        assert response.status_code == 422
        assert response.json()["detail"]["errors"][0]["line"] == 1
        assert client.get("/api/projects/current").json()["id"] == project["id"]


def test_file_paths_and_oversized_requests_are_rejected(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        assert (
            client.post(
                "/api/projects", json={"filename": "../Orders.java", "source": SOURCE}
            ).status_code
            == 422
        )
        assert (
            client.post(
                "/api/projects",
                content=b" " * (2 * 1024 * 1024 + 1),
                headers={"Content-Type": "application/json"},
            ).status_code
            == 413
        )


def test_overloads_constructors_and_bodyless_methods_have_distinct_graphs(tmp_path):
    source = """interface Action { void run(); }
class Sample implements Action {
  Sample() {}
  public void run() {}
  int run(int n) { return n; }
}"""
    with TestClient(create_app(tmp_path)) as client:
        project = client.post(
            "/api/projects", json={"filename": "Sample.java", "source": source}
        ).json()
        assert len({m["id"] for m in project["methods"]}) == 4
        declaration = next(m for m in project["methods"] if m["owner"] == "Action")
        assert declaration["hasBody"] is False
        assert (
            client.get(f"/api/projects/{project['id']}/methods/{declaration['id']}/graph").json()[
                "nodes"
            ]
            == []
        )
        assert any(m["kind"] == "constructor" for m in project["methods"])


def test_cr_line_endings_and_tabs_keep_exact_export_and_character_ranges(tmp_path):
    source = (
        "class Tabs {\r\tint value(int n) {\r\t\tif (n > 0) { return n; }\r\t\treturn 0;\r\t}\r}\r"
    )
    with TestClient(create_app(tmp_path)) as client:
        project = client.post(
            "/api/projects", json={"filename": "Tabs.java", "source": source}
        ).json()
        method = project["methods"][0]
        graph = client.get(f"/api/projects/{project['id']}/methods/{method['id']}/graph").json()
        condition = next(node for node in graph["nodes"] if node["kind"] == "condition")
        assert condition["range"] == {
            "startLine": 3,
            "startColumn": 7,
            "endLine": 3,
            "endColumn": 11,
        }
        assert client.get(f"/api/projects/{project['id']}/export").text == source
