import os
import shutil
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.worker import run_worker

SOURCE = """public class Demo {
  // Keep this method and its formatting.
  static int untouched() { return 42; }
  public static void main(String[] args) {
    int value = 1;
    if (value > 0) {
      value += 2;
    } else {
      value -= 2;
    }
    System.out.println(value);
  }
}
"""


def import_graph(client, source=SOURCE):
    response = client.post("/api/projects", json={"filename": "Demo.java", "source": source})
    assert response.status_code == 201, response.text
    project = response.json()
    return project, graph_for(client, project)


def graph_for(client, project):
    method = next(m for m in project["methods"] if m["name"] == "main")
    graph = client.get(f"/api/projects/{project['id']}/methods/{method['id']}/graph").json()
    return graph


def test_block_edit_atomically_updates_code_graph_and_revision(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        project, graph = import_graph(client)
        node = next(n for n in graph["nodes"] if n["code"] == "value += 2;")
        response = client.post(
            f"/api/projects/{project['id']}/graph-edits",
            json={
                "revision": 1,
                "methodId": graph["methodId"],
                "nodeId": node["id"],
                "action": "replace",
                "code": "value += 3;",
            },
        )
        assert response.status_code == 200, response.text
        changed = response.json()
        assert changed["revision"] == changed["graphRevision"] == 2
        assert changed["generatedSource"] == SOURCE.replace("value += 2;", "value += 3;")
        assert changed["modelSource"] == changed["generatedSource"]
        assert changed["originalSource"] == SOURCE
        assert changed["originalMethods"] == project["methods"]
        method = next(m for m in changed["methods"] if m["name"] == "main")
        fresh = client.get(f"/api/projects/{project['id']}/methods/{method['id']}/graph").json()
        assert not fresh["stale"]
        assert any(n["code"] == "value += 3;" for n in fresh["nodes"])
        assert (
            client.get(f"/api/projects/{project['id']}/export").text == changed["generatedSource"]
        )


def test_delete_operation_from_branch(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        project, graph = import_graph(client)
        node = next(n for n in graph["nodes"] if n["code"] == "value -= 2;")
        response = client.post(
            f"/api/projects/{project['id']}/graph-edits",
            json={
                "revision": 1,
                "methodId": graph["methodId"],
                "nodeId": node["id"],
                "action": "delete",
            },
        )
        assert response.status_code == 200, response.text
        changed = response.json()
        assert "value -= 2;" not in changed["generatedSource"]
        assert "value += 2;" in changed["generatedSource"]
        assert changed["revision"] == changed["graphRevision"] == 2


def test_insert_operation_into_if_branch(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        project, graph = import_graph(client)
        branch = next(c for c in graph["containers"] if c["kind"] == "then")
        response = client.post(
            f"/api/projects/{project['id']}/graph-edits",
            json={
                "revision": 1,
                "methodId": graph["methodId"],
                "action": "insert",
                "containerId": branch["id"],
                "index": 0,
                "code": "value += 0;",
            },
        )
        assert response.status_code == 200, response.text
        changed = response.json()
        assert changed["revision"] == changed["graphRevision"] == 2
        assert "value += 0;" in changed["generatedSource"]
        assert changed["generatedSource"].index("value += 0;") < changed["generatedSource"].index(
            "value += 2;"
        )
        assert "static int untouched() { return 42; }" in changed["generatedSource"]
        assert changed["originalSource"] == SOURCE


def test_move_an_operation_within_its_sequence(tmp_path):
    source = SOURCE.replace("value += 2;", "value += 2;\n      value *= 3;")
    with TestClient(create_app(tmp_path)) as client:
        project, graph = import_graph(client, source)
        node = next(n for n in graph["nodes"] if n["code"] == "value *= 3;")
        response = client.post(
            f"/api/projects/{project['id']}/graph-edits",
            json={
                "revision": 1,
                "methodId": graph["methodId"],
                "action": "move",
                "nodeId": node["id"],
                "containerId": node["containerId"],
                "index": 0,
            },
        )
        assert response.status_code == 200, response.text
        changed = response.json()
        assert changed["generatedSource"].index("value *= 3;") < changed["generatedSource"].index(
            "value += 2;"
        )
        assert changed["revision"] == changed["graphRevision"] == 2
        assert changed["originalSource"] == source


@pytest.mark.parametrize("code", ["value += ;", "value++; value++;", "while (true) {}", "return;"])
def test_invalid_block_edit_leaves_the_project_unchanged(tmp_path, code):
    with TestClient(create_app(tmp_path)) as client:
        project, graph = import_graph(client)
        node = next(n for n in graph["nodes"] if n["code"] == "int value = 1;")
        response = client.post(
            f"/api/projects/{project['id']}/graph-edits",
            json={
                "revision": 1,
                "methodId": graph["methodId"],
                "nodeId": node["id"],
                "action": "replace",
                "code": code,
            },
        )
        assert response.status_code == 422, response.text
        assert response.json()["detail"]
        assert client.get(f"/api/projects/{project['id']}").json() == project


@pytest.mark.parametrize("kind", ["then", "else"])
def test_insert_into_unbraced_or_missing_branch(tmp_path, kind):
    source = SOURCE.replace(
        "if (value > 0) {\n      value += 2;\n    } else {\n      value -= 2;\n    }",
        "if (value > 0) value += 2;",
    )
    with TestClient(create_app(tmp_path)) as client:
        project, graph = import_graph(client, source)
        branch = next(c for c in graph["containers"] if c["kind"] == kind)
        response = client.post(
            f"/api/projects/{project['id']}/graph-edits",
            json={
                "revision": 1,
                "methodId": graph["methodId"],
                "action": "insert",
                "containerId": branch["id"],
                "index": branch["size"],
                "code": "value += 0;",
            },
        )
        assert response.status_code == 200, response.text
        assert "value += 0;" in response.json()["generatedSource"]
        assert response.json()["originalSource"] == source


def test_condition_edit_preserves_branches(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        project, graph = import_graph(client)
        node = next(n for n in graph["nodes"] if n["kind"] == "condition")
        response = client.post(
            f"/api/projects/{project['id']}/graph-edits",
            json={
                "revision": 1,
                "methodId": graph["methodId"],
                "nodeId": node["id"],
                "action": "replace",
                "code": "value < 0",
            },
        )
        assert response.status_code == 200, response.text
        assert response.json()["generatedSource"] == SOURCE.replace("value > 0", "value < 0")


def test_graph_edit_checks_ownership_revision_and_model_freshness(tmp_path):
    with TestClient(create_app(tmp_path)) as client, TestClient(create_app(tmp_path)) as guest:
        project, graph = import_graph(client)
        url = f"/api/projects/{project['id']}/graph-edits"
        node = next(n for n in graph["nodes"] if n["code"] == "value += 2;")
        edit = {
            "revision": 1,
            "methodId": graph["methodId"],
            "nodeId": node["id"],
            "action": "replace",
            "code": "value += 0;",
        }
        assert guest.post(url, json=edit).status_code == 404
        assert client.post(url, json={**edit, "revision": 2}).status_code == 409
        assert client.post(url, json={**edit, "nodeId": "unknown"}).status_code == 422
        assert client.post(url, json={**edit, "methodId": "unknown"}).status_code == 422
        assert client.get(f"/api/projects/{project['id']}").json() == project
        client.post(
            f"/api/projects/{project['id']}/source",
            json={"revision": 1, "source": SOURCE + "// draft"},
        )
        assert client.post(url, json={**edit, "revision": 2}).status_code == 409
        assert (
            client.get(f"/api/projects/{project['id']}")
            .json()["generatedSource"]
            .endswith("// draft")
        )


def test_competing_graph_edits_cannot_overwrite_each_other(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        project, graph = import_graph(client)
        node = next(n for n in graph["nodes"] if n["code"] == "value += 2;")
        cookies = dict(client.cookies)

        def replace(code):
            with TestClient(create_app(tmp_path), cookies=cookies) as tab:
                return tab.post(
                    f"/api/projects/{project['id']}/graph-edits",
                    json={
                        "revision": 1,
                        "methodId": graph["methodId"],
                        "nodeId": node["id"],
                        "action": "replace",
                        "code": code,
                    },
                )

        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(replace, ["value += 3;", "value += 4;"]))
        assert sorted(r.status_code for r in responses) == [200, 409]
        current = client.get(f"/api/projects/{project['id']}").json()
        assert current["revision"] == current["graphRevision"] == 2


def test_empty_method_accepts_an_operation(tmp_path):
    source = "public class Demo { public static void main(String[] a) {} }"
    with TestClient(create_app(tmp_path)) as client:
        project, graph = import_graph(client, source)
        root = graph["containers"][0]
        response = client.post(
            f"/api/projects/{project['id']}/graph-edits",
            json={
                "revision": 1,
                "methodId": graph["methodId"],
                "action": "insert",
                "containerId": root["id"],
                "index": 0,
                "code": 'System.out.println("hello");',
            },
        )
        assert response.status_code == 200, response.text
        assert 'System.out.println("hello");' in response.json()["generatedSource"]


def test_move_distinguishes_repeated_identical_operations(tmp_path):
    source = (
        "class Demo { public static void main(String[] a) {"
        'System.out.print("x");System.out.print("y");System.out.print("x");} }'
    )
    with TestClient(create_app(tmp_path)) as client:
        project, graph = import_graph(client, source)
        nodes = [n for n in graph["nodes"] if n["code"] == 'System.out.print("x");']
        last = max(nodes, key=lambda n: n["range"]["startColumn"])
        response = client.post(
            f"/api/projects/{project['id']}/graph-edits",
            json={
                "revision": 1,
                "methodId": graph["methodId"],
                "action": "move",
                "nodeId": last["id"],
                "containerId": last["containerId"],
                "index": 1,
            },
        )
        assert response.status_code == 200, response.text
        code = response.json()["generatedSource"]
        assert code.rfind('System.out.print("x");') < code.index('System.out.print("y");')


def test_cross_scope_and_opaque_edits_are_rejected(tmp_path):
    source = SOURCE.replace("value += 2;", "while (false) { value++; }")
    with TestClient(create_app(tmp_path)) as client:
        project, graph = import_graph(client, source)
        prefix = f"/api/projects/{project['id']}"
        opaque = next(n for n in graph["nodes"] if n["kind"] == "opaque")
        node = next(n for n in graph["nodes"] if n["code"] == "value -= 2;")
        root = next(c for c in graph["containers"] if c["kind"] == "method")
        for action in [
            {"action": "replace", "nodeId": opaque["id"], "code": "value++;"},
            {"action": "delete", "nodeId": opaque["id"]},
            {"action": "move", "nodeId": node["id"], "containerId": root["id"], "index": 0},
            {"action": "insert", "containerId": root["id"], "index": 999, "code": "value++;"},
        ]:
            response = client.post(
                prefix + "/graph-edits",
                json={
                    "revision": 1,
                    "methodId": graph["methodId"],
                    **action,
                },
            )
            assert response.status_code == 422, response.text
            assert client.get(prefix).json() == project


@pytest.mark.skipif(
    not shutil.which(os.environ.get("BLUEPRINTS_DOCKER_BIN", "docker")),
    reason="Real Docker is required for graph → generated Java → compiler → execution",
)
def test_graph_actions_compile_and_compare_actual_behavior(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        project, graph = import_graph(client)
        prefix = f"/api/projects/{project['id']}"

        def edit(action, code=None, text=None, **fields):
            nonlocal project, graph
            payload = {
                "revision": project["revision"],
                "methodId": graph["methodId"],
                "action": action,
                **fields,
            }
            if text is not None:
                payload["nodeId"] = next(n["id"] for n in graph["nodes"] if n["code"] == text)
            if code is not None:
                payload["code"] = code
            response = client.post(prefix + "/graph-edits", json=payload)
            assert response.status_code == 200, response.text
            project = response.json()
            graph = graph_for(client, project)

        def compare(verdict, working="3\n"):
            response = client.post(
                prefix + "/checks",
                json={
                    "revision": project["revision"],
                    "scenarios": [{"name": "Граф и Java", "stdin": ""}],
                },
            )
            assert response.status_code == 202, response.text
            run_worker(tmp_path, once=True)
            completed = client.get(f"/api/checks/{response.json()['id']}").json()
            assert completed["sourceRevision"] == project["revision"]
            assert completed["result"]["verdict"] == verdict, completed
            case = completed["result"]["cases"][0]
            assert case["original"]["stdout"] == "3\n"
            assert case["working"]["stdout"] == working
            assert case["original"]["exitCode"] == case["working"]["exitCode"] == 0

        compare("matched")
        edit("replace", text="value += 2;", code="value += 1 + 1;")
        previous = client.get(prefix + "/checks/latest").json()
        assert previous["sourceRevision"] < project["revision"]
        compare("matched")
        branch = next(c for c in graph["containers"] if c["kind"] == "then")
        edit("insert", code="value += 0;", containerId=branch["id"], index=branch["size"])
        compare("matched")
        node = next(n for n in graph["nodes"] if n["code"] == "value += 0;")
        edit("move", text="value += 0;", containerId=node["containerId"], index=0)
        compare("matched")
        edit("delete", text="value += 0;")
        compare("matched")
        edit("replace", text="value += 1 + 1;", code="value += 3;")
        compare("different", "4\n")
