import json
import os
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.worker import run_worker

FIXTURES = Path(__file__).parent / "fixtures/java_coverage"
CASES = json.loads((FIXTURES / "cases.json").read_text())


def test_resources_remain_explicit_and_cannot_be_replaced_as_operation(tmp_path):
    source = """class Coverage { void run() throws Exception {
      try (java.io.StringReader input = new java.io.StringReader("x")) {
        System.out.println(input.read());
      }
    } }"""
    with TestClient(create_app(tmp_path)) as client:
        project = client.post(
            "/api/projects", json={"filename": "Coverage.java", "source": source}
        ).json()
        method = project["methods"][0]
        prefix = f"/api/projects/{project['id']}"
        graph = client.get(prefix + f"/methods/{method['id']}/graph").json()
        opaque = next(n for n in graph["nodes"] if n["kind"] == "opaque")
        assert any("try-with-resources" in notice for notice in graph["notices"])
        assert not opaque["editable"]
        rejected = client.post(
            prefix + "/graph-edits",
            json={
                "revision": 1,
                "methodId": method["id"],
                "nodeId": opaque["id"],
                "action": "replace",
                "code": "System.out.println(1);",
            },
        )
        assert rejected.status_code == 422
        assert client.get(prefix + "/export").text == source


def test_nested_cleanup_has_separate_pending_completion_frames(tmp_path):
    source = (FIXTURES / "nested_cleanup/Coverage.java").read_text()
    with TestClient(create_app(tmp_path)) as client:
        project = client.post(
            "/api/projects", json={"filename": "Coverage.java", "source": source}
        ).json()
        method = next(m for m in project["methods"] if m["name"] == "calculate")
        graph = client.get(f"/api/projects/{project['id']}/methods/{method['id']}/graph").json()
        frames = {
            e["label"].split("[finally ")[1].split("]")[0]
            for e in graph["edges"]
            if "[finally " in e["label"]
        }
        assert len(frames) == 2
        assert sum(n["kind"] == "completion" for n in graph["nodes"]) == 2


@pytest.mark.parametrize(
    ("name", "method_name"),
    [("nested_finally", "main"), ("finally_override", "calculate"), ("multi_catch", "main")],
)
def test_exception_graph_preserves_abrupt_completion_context(tmp_path, name, method_name):
    source = (FIXTURES / name / "Coverage.java").read_text()
    with TestClient(create_app(tmp_path)) as client:
        project = client.post(
            "/api/projects", json={"filename": "Coverage.java", "source": source}
        ).json()
        method = next(m for m in project["methods"] if m["name"] == method_name)
        graph = client.get(f"/api/projects/{project['id']}/methods/{method['id']}/graph").json()
        nodes = {n["id"]: n for n in graph["nodes"]}
        edges = graph["edges"]
        assert not any(n["kind"] == "opaque" for n in nodes.values())
        if name == "nested_finally":
            for jump in ("break;", "continue;"):
                origin = next(n for n in nodes.values() if n["code"] == jump)
                outgoing = [e for e in edges if e["source"] == origin["id"]]
                assert len(outgoing) == 1
                assert nodes[outgoing[0]["target"]]["code"] == 'System.out.println("шаг " + i);'
                assert jump[:-1] in outgoing[0]["label"]
            assert any(
                e["label"].startswith("Если ожидается: continue-")
                and nodes[e["target"]]["code"] == "i++"
                for e in edges
            )
        elif name == "finally_override":
            first = next(n for n in nodes.values() if n["code"] == "return 1;")
            overriding = next(n for n in nodes.values() if n["code"] == "return 2;")
            assert any(
                e["source"] == first["id"] and e["target"] == overriding["id"] for e in edges
            )
            assert all(
                nodes[e["target"]]["kind"] == "exit"
                for e in edges
                if e["source"] == overriding["id"]
            )
        else:
            thrown = next(
                n
                for n in nodes.values()
                if n["code"] == "throw new IllegalStateException(error.getMessage());"
            )
            targets = [nodes[e["target"]] for e in edges if e["source"] == thrown["id"]]
            assert targets and all(
                n["code"] == 'System.out.println("первый " + value);' for n in targets
            )
            assert any("IOException | IllegalArgumentException" in e["label"] for e in edges)


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
@pytest.mark.skipif(
    not shutil.which(os.environ.get("BLUEPRINTS_DOCKER_BIN", "docker")),
    reason="The Java coverage corpus requires actual compilation and Docker execution",
)
def test_java_corpus_roundtrip_structural_edit_and_behavior(tmp_path, case):
    source = (FIXTURES / case["name"] / "Coverage.java").read_text()
    with TestClient(create_app(tmp_path)) as client:
        request = {"filename": "Coverage.java", "source": source}
        imported = client.post("/api/projects", json=request)
        assert imported.status_code == 201, imported.text
        first = imported.json()
        exported = client.get(f"/api/projects/{first['id']}/export").text
        assert exported == source
        request["source"] = exported
        project = client.post("/api/projects", json=request).json()
        assert project["methods"] == first["methods"]
        method = next(
            m
            for m in project["methods"]
            if m["name"] == case["method"]
            and ("signature" not in case or m["signature"] == case["signature"])
        )
        prefix = f"/api/projects/{project['id']}"
        graph = client.get(prefix + f"/methods/{method['id']}/graph").json()
        operation = next(n for n in graph["nodes"] if n["code"] == case["target"])
        assert operation["editable"]
        edited = client.post(
            prefix + "/graph-edits",
            json={
                "revision": 1,
                "methodId": method["id"],
                "nodeId": operation["id"],
                "action": "replace",
                "code": case["replacement"],
            },
        )
        assert edited.status_code == 200, edited.text
        changed = edited.json()
        assert changed["originalSource"] == source
        lines = source.splitlines(keepends=True)
        before = "".join(lines[: method["range"]["startLine"] - 1])
        after = "".join(lines[method["range"]["endLine"] :])
        assert changed["generatedSource"].startswith(before)
        assert changed["generatedSource"].endswith(after)
        job = client.post(
            prefix + "/checks",
            json={
                "revision": 2,
                "scenarios": [{"name": case["name"], "stdin": case.get("stdin", "")}],
            },
        )
        assert job.status_code == 202, job.text
        run_worker(tmp_path, once=True)
        completed = client.get(f"/api/checks/{job.json()['id']}").json()
        assert completed["result"]["verdict"] == "matched", completed
        for version in ("original", "working"):
            result = completed["result"]["cases"][0][version]
            assert result["stdout"] == case["stdout"]
            assert result["stderr"] == case.get("stderr", "")
            assert result["exception"] == case.get("exception")
            assert result["exitCode"] == (1 if case.get("exception") else 0)


def test_try_finally_preserves_pending_return_and_exposes_editable_body(tmp_path):
    source = """public class Coverage {
  static int value() {
    try { return 1; }
    catch (RuntimeException error) { throw error; }
    finally { System.out.println("finally"); }
  }
  public static void main(String[] args) { System.out.println(value()); }
}
"""
    with TestClient(create_app(tmp_path)) as client:
        response = client.post(
            "/api/projects", json={"filename": "Coverage.java", "source": source}
        )
        assert response.status_code == 201, response.text
        project = response.json()
        method = next(m for m in project["methods"] if m["name"] == "value")
        graph = client.get(f"/api/projects/{project['id']}/methods/{method['id']}/graph").json()
        assert project["generatedSource"] == source
        assert not any(n["kind"] == "opaque" for n in graph["nodes"])
        returned = next(n for n in graph["nodes"] if n["code"] == "return 1;")
        final = next(n for n in graph["nodes"] if n["code"] == 'System.out.println("finally");')
        assert any(
            e["source"] == returned["id"] and e["target"] == final["id"] and "return" in e["label"]
            for e in graph["edges"]
        )
        assert {c["kind"] for c in graph["containers"]} >= {"try", "catch", "finally"}
        edited = client.post(
            f"/api/projects/{project['id']}/graph-edits",
            json={
                "revision": 1,
                "methodId": method["id"],
                "nodeId": returned["id"],
                "action": "replace",
                "code": "return 1 + 0;",
            },
        )
        assert edited.status_code == 200, edited.text
        assert 'finally { System.out.println("finally"); }' in edited.json()["generatedSource"]
