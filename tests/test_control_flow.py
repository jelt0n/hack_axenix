import json
import os
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.worker import run_worker

FIXTURES = Path(__file__).parent / "fixtures/control_flow"
CASES = json.loads((FIXTURES / "cases.json").read_text())


def program(body):
    return "public class Flow { public static void main(String[] args) {\n" + body + "\n} }"


def import_flow(client, body):
    return import_source(client, program(body))


def import_source(client, source):
    response = client.post("/api/projects", json={"filename": "Flow.java", "source": source})
    assert response.status_code == 201, response.text
    project = response.json()
    assert project["generatedSource"] == source
    method = next(m for m in project["methods"] if m["name"] == "main")
    graph = client.get(f"/api/projects/{project['id']}/methods/{method['id']}/graph").json()
    return project, graph


def node(graph, code):
    return next(n for n in graph["nodes"] if n["code"] == code)


def edge(graph, source, target, label=None):
    return next(
        e
        for e in graph["edges"]
        if e["source"] == node(graph, source)["id"]
        and e["target"] == node(graph, target)["id"]
        and (label is None or e["label"] == label)
    )


def test_while_routes_continue_to_condition_and_break_out_of_loop(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        project, graph = import_flow(
            client,
            """
int n = 0;
while (n < 3) {
  n++;
  if (n == 1) continue;
  if (n == 2) break;
}
System.out.println(n);
""",
        )
        assert edge(graph, "continue;", "n < 3")["backEdge"]
        assert edge(graph, "break;", "System.out.println(n);")
        assert edge(graph, "n < 3", "System.out.println(n);", "Нет")
        assert not graph["notices"]
        operation = node(graph, "n++;")
        response = client.post(
            f"/api/projects/{project['id']}/graph-edits",
            json={
                "revision": 1,
                "methodId": graph["methodId"],
                "nodeId": operation["id"],
                "action": "replace",
                "code": "n += 1;",
            },
        )
        assert response.status_code == 200, response.text
        assert "n += 1;" in response.json()["generatedSource"]


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
@pytest.mark.skipif(
    not shutil.which(os.environ.get("BLUEPRINTS_DOCKER_BIN", "docker")),
    reason="The control-flow corpus requires actual compilation and Docker execution",
)
def test_control_corpus_roundtrip_edit_compile_and_execute(tmp_path, case):
    source = (FIXTURES / case["name"] / "Flow.java").read_text()
    with TestClient(create_app(tmp_path)) as client:
        project, _ = import_source(client, source)
        exported = client.get(f"/api/projects/{project['id']}/export").text
        assert exported == source
        project, graph = import_source(client, exported)
        assert not graph["notices"]
        operation = node(graph, case["target"])
        prefix = f"/api/projects/{project['id']}"
        edited = client.post(
            prefix + "/graph-edits",
            json={
                "revision": 1,
                "methodId": graph["methodId"],
                "nodeId": operation["id"],
                "action": "replace",
                "code": case["replacement"],
            },
        )
        assert edited.status_code == 200, edited.text
        assert edited.json()["originalSource"] == source
        assert edited.json()["revision"] == edited.json()["graphRevision"] == 2
        job = client.post(
            prefix + "/checks",
            json={
                "revision": 2,
                "scenarios": [{"name": case["name"], "stdin": ""}],
            },
        )
        assert job.status_code == 202, job.text
        run_worker(tmp_path, once=True)
        completed = client.get(f"/api/checks/{job.json()['id']}").json()
        assert completed["result"]["verdict"] == "matched", completed
        result = completed["result"]["cases"][0]
        for version in ("original", "working"):
            assert result[version]["stdout"] == case["stdout"]
            assert result[version]["stderr"] == ""
            assert result[version]["exitCode"] == 0


@pytest.mark.parametrize(
    "body",
    [
        "int n = 1; switch(n) { case 1 -> System.out.println(n); "
        "default -> System.out.println(0); }",
        "int n = switch(1) { case 1 -> 2; default -> 3; }; System.out.println(n);",
        'Object o = "x"; switch(o) { case String s -> { System.out.println(s); } default -> {} }',
        "outer: while(true) { break outer; }",
    ],
)
def test_unexpanded_forms_are_explicit_and_preserve_source(tmp_path, body):
    with TestClient(create_app(tmp_path)) as client:
        project, graph = import_flow(client, body)
        assert graph["notices"]
        opaque = next(n for n in graph["nodes"] if n["kind"] == "opaque")
        assert not opaque["editable"]
        assert client.get(f"/api/projects/{project['id']}/export").text == program(body)


@pytest.mark.parametrize("code", ["break;", "continue;"])
def test_jumps_outside_legal_context_do_not_modify_project(tmp_path, code):
    with TestClient(create_app(tmp_path)) as client:
        project, graph = import_flow(client, "int value = 0; System.out.println(value);")
        prefix = f"/api/projects/{project['id']}"
        response = client.post(
            prefix + "/graph-edits",
            json={
                "revision": 1,
                "methodId": graph["methodId"],
                "nodeId": node(graph, "int value = 0;")["id"],
                "action": "replace",
                "code": code,
            },
        )
        assert response.status_code == 422, response.text
        assert client.get(prefix).json() == project


def test_empty_for_has_no_fabricated_false_exit(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        _, graph = import_flow(client, "for (;;) { break; } System.out.println(1);")
        condition = node(graph, "true")
        assert not condition["editable"]
        assert [e["label"] for e in graph["edges"] if e["source"] == condition["id"]] == ["Да"]


def test_insert_into_unbraced_loop_wraps_body_without_changing_scope(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        project, graph = import_flow(client, "int n = 0; while(n < 3) n++; System.out.println(n);")
        body = next(c for c in graph["containers"] if c["kind"] == "loop")
        response = client.post(
            f"/api/projects/{project['id']}/graph-edits",
            json={
                "revision": 1,
                "methodId": graph["methodId"],
                "action": "insert",
                "containerId": body["id"],
                "index": 1,
                "code": "n += 0;",
            },
        )
        assert response.status_code == 200, response.text
        assert "n += 0;" in response.json()["generatedSource"]


def test_for_initialization_update_and_continue_are_distinct(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        _, graph = import_flow(
            client,
            """
int total = 0;
for (int i = 0; i < 3; i++) {
  if (i == 1) continue;
  total += i;
}
System.out.println(total);
""",
        )
        assert edge(graph, "continue;", "i++")
        assert edge(graph, "i++", "i < 3")["backEdge"]
        assert not edge(graph, "int i = 0", "i < 3")["backEdge"]
        assert edge(graph, "i < 3", "System.out.println(total);", "Нет")
        assert not node(graph, "i++")["editable"]


def test_do_executes_body_before_condition_and_continue_reaches_condition(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        _, graph = import_flow(
            client,
            """
int n = 0;
do {
  n++;
  if (n == 1) continue;
} while (n < 2);
System.out.println(n);
""",
        )
        assert edge(graph, "int n = 0;", "n++;")
        assert not edge(graph, "continue;", "n < 2")["backEdge"]
        assert edge(graph, "n < 2", "n++;", "Да")["backEdge"]
        assert edge(graph, "n < 2", "System.out.println(n);", "Нет")


def test_foreach_binds_each_element_and_continue_advances_iteration(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        _, graph = import_flow(
            client,
            """
int total = 0;
for (int value : new int[]{1, 2, 3}) {
  if (value == 2) continue;
  total += value;
}
System.out.println(total);
""",
        )
        condition = next(n for n in graph["nodes"] if n["code"] == "Есть следующий элемент?")
        binding = next(n for n in graph["nodes"] if n["code"] == "Следующий элемент → int value")
        assert any(
            e["source"] == condition["id"] and e["target"] == binding["id"] for e in graph["edges"]
        )
        assert edge(graph, "continue;", condition["code"])["backEdge"]
        assert edge(graph, condition["code"], "System.out.println(total);", "Нет")
        assert not condition["editable"] and not binding["editable"]


def test_switch_preserves_fallthrough_and_break_exits_only_switch(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        project, graph = import_flow(
            client,
            """
int total = 0;
for (int i = 0; i < 3; i++) {
  switch (i) {
    case 0: total += 1;
    case 1: total += 2; break;
    default: continue;
  }
  total += 10;
}
System.out.println(total);
""",
        )
        assert edge(graph, "total += 1;", "total += 2;")
        assert edge(graph, "break;", "total += 10;")
        assert edge(graph, "continue;", "i++")
        dispatch = next(n for n in graph["nodes"] if n["kind"] == "dispatch")
        assert {e["label"] for e in graph["edges"] if e["source"] == dispatch["id"]} == {
            "case 0",
            "case 1",
            "default",
        }
        branch = next(c for c in graph["containers"] if c["label"].startswith("case 0"))
        response = client.post(
            f"/api/projects/{project['id']}/graph-edits",
            json={
                "revision": 1,
                "methodId": graph["methodId"],
                "action": "insert",
                "containerId": branch["id"],
                "index": 1,
                "code": "total += 0;",
            },
        )
        assert response.status_code == 200, response.text
