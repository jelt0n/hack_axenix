import json
import os
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.worker import run_worker

EXAMPLES = Path(__file__).resolve().parents[1] / "examples"
CASES = json.loads((EXAMPLES / "scenarios.json").read_text())


def graph_for(client, prefix, project, name):
    method = next(
        m for m in project["methods"] if m["owner"] == "BlueprintDemo" and m["name"] == name
    )
    graph = client.get(prefix + f"/methods/{method['id']}/graph").json()
    return method, graph


def compare(client, directory, prefix, project, different=False):
    response = client.post(
        prefix + "/checks",
        json={
            "revision": project["revision"],
            "scenarios": [{"name": case["name"], "stdin": case["stdin"]} for case in CASES],
        },
    )
    assert response.status_code == 202, response.text
    run_worker(directory, once=True)
    finished = client.get(f"/api/checks/{response.json()['id']}").json()
    assert finished["result"]["verdict"] == ("different" if different else "matched"), finished
    for observed, expected in zip(finished["result"]["cases"], CASES, strict=True):
        for version in ("original", "working"):
            output = (
                expected["changedStdout"]
                if different and version == "working"
                else expected["stdout"]
            )
            assert observed[version]["stdout"] == output
            assert observed[version]["stderr"] == ""
            assert observed[version]["exception"] is None
            assert observed[version]["exitCode"] == 0
    return finished


@pytest.mark.skipif(
    not shutil.which(os.environ.get("BLUEPRINTS_DOCKER_BIN", "docker")),
    reason="The final demo requires actual compilation and Docker execution",
)
def test_final_demo_pipeline(tmp_path):
    source = (EXAMPLES / "BlueprintDemo.java").read_text()
    assert 850 <= len(source.splitlines()) <= 1150
    with TestClient(create_app(tmp_path)) as client:
        response = client.post(
            "/api/projects", json={"filename": "BlueprintDemo.java", "source": source}
        )
        assert response.status_code == 201, response.text
        project = response.json()
        prefix = f"/api/projects/{project['id']}"
        assert client.get(prefix + "/export").text == source
        analysis = client.post(prefix + "/analysis", json={"revision": 1})
        assert analysis.status_code == 200, analysis.text
        report = analysis.json()
        assert {f["rule"] for f in report["findings"]} >= {
            "long-method",
            "constant-condition",
            "nested-loops",
        }
        summed, _ = graph_for(client, prefix, project, "sum")
        assert (
            next(m for m in report["methods"] if m["methodId"] == summed["id"])["complexity"][
                "label"
            ]
            == "O(n)"
        )
        compare(client, tmp_path, prefix, project)

        method, graph = graph_for(client, prefix, project, "calculateTotal")
        operation = next(
            n for n in graph["nodes"] if n["code"] == "int subtotal = amount * quantity;"
        )
        response = client.post(
            prefix + "/graph-edits",
            json={
                "revision": project["revision"],
                "methodId": method["id"],
                "nodeId": operation["id"],
                "action": "replace",
                "code": "int subtotal = amount * quantity + 0;",
            },
        )
        assert response.status_code == 200, response.text
        project = response.json()
        compare(client, tmp_path, prefix, project)

        method, graph = graph_for(client, prefix, project, "calculateTotal")
        condition = next(
            n for n in graph["nodes"] if n["kind"] == "condition" and n["code"] == "true"
        )
        selection = {
            "revision": project["revision"],
            "methodId": method["id"],
            "nodeId": condition["id"],
        }
        preview = client.post(prefix + "/transformations/constant-branch/preview", json=selection)
        assert preview.status_code == 200, preview.text
        assert client.get(prefix).json() == project
        applied = client.post(
            prefix + "/transformations/constant-branch/apply",
            json={**selection, "previewHash": preview.json()["previewHash"]},
        )
        assert applied.status_code == 200, applied.text
        project = applied.json()
        compare(client, tmp_path, prefix, project)

        method, _ = graph_for(client, prefix, project, "calculateTotal")
        selection = {
            "revision": project["revision"],
            "methodId": method["id"],
            "startIndex": 0,
            "endIndex": 1,
            "methodName": "subtotalForOrder",
        }
        preview = client.post(prefix + "/transformations/extract-method/preview", json=selection)
        assert preview.status_code == 200, preview.text
        applied = client.post(
            prefix + "/transformations/extract-method/apply",
            json={**selection, "previewHash": preview.json()["previewHash"]},
        )
        assert applied.status_code == 200, applied.text
        project = applied.json()
        assert project["originalSource"] == source
        compare(client, tmp_path, prefix, project)

        helper, graph = graph_for(client, prefix, project, "subtotalForOrder")
        operation = next(
            n for n in graph["nodes"] if n["code"] == "int subtotal = amount * quantity + 0;"
        )
        applied = client.post(
            prefix + "/graph-edits",
            json={
                "revision": project["revision"],
                "methodId": helper["id"],
                "nodeId": operation["id"],
                "action": "replace",
                "code": "int subtotal = amount * quantity + 1;",
            },
        )
        assert applied.status_code == 200, applied.text
        project = applied.json()
        compare(client, tmp_path, prefix, project, different=True)
        assert project["originalSource"] == source

        helper, graph = graph_for(client, prefix, project, "subtotalForOrder")
        operation = next(
            n for n in graph["nodes"] if n["code"] == "int subtotal = amount * quantity + 1;"
        )
        invalid = client.post(
            prefix + "/graph-edits",
            json={
                "revision": project["revision"],
                "methodId": helper["id"],
                "nodeId": operation["id"],
                "action": "replace",
                "code": "int subtotal = missingValue;",
            },
        )
        assert invalid.status_code == 200, invalid.text
        job = client.post(
            prefix + "/checks",
            json={
                "revision": invalid.json()["revision"],
                "scenarios": [{"name": "Ошибка компиляции", "stdin": ""}],
            },
        )
        assert job.status_code == 202, job.text
        run_worker(tmp_path, once=True)
        failed = client.get(f"/api/checks/{job.json()['id']}").json()
        assert failed["status"] == "failed"
        assert failed["result"]["verdict"] == "inconclusive"
        assert failed["result"]["error"]["kind"] == "compile_error"
