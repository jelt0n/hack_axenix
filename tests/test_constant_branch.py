import os
import shutil

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.worker import run_worker

SOURCE = """class Demo {
 int untouched() { return 42; }
 int run() {
  int x = 1;
  if (true) { int inner = 2; x += inner; } else { x = 99; }
  return x;
 }
}
"""


def import_condition(client, source=SOURCE):
    response = client.post("/api/projects", json={"filename": "Demo.java", "source": source})
    assert response.status_code == 201, response.text
    project = response.json()
    method = next(m for m in project["methods"] if m["name"] == "run")
    prefix = f"/api/projects/{project['id']}"
    graph = client.get(f"{prefix}/methods/{method['id']}/graph").json()
    condition = next(n for n in graph["nodes"] if n["kind"] == "condition")
    return (
        project,
        prefix,
        {"revision": project["revision"], "methodId": method["id"], "nodeId": condition["id"]},
    )


def test_preview_does_not_change_project_and_confirm_preserves_scope(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        project, prefix, selection = import_condition(client)
        response = client.post(prefix + "/transformations/constant-branch/preview", json=selection)
        assert response.status_code == 200, response.text
        preview = response.json()
        assert "if (true)" in preview["before"]
        assert "int inner = 2;" in preview["after"] and "99" not in preview["after"]
        assert preview["after"].strip().startswith("{")
        assert client.get(prefix).json() == project
        applied = client.post(
            prefix + "/transformations/constant-branch/apply",
            json={**selection, "previewHash": preview["previewHash"]},
        )
        assert applied.status_code == 200, applied.text
        changed = applied.json()
        assert changed["revision"] == changed["graphRevision"] == 2
        assert changed["originalSource"] == SOURCE
        assert "int untouched() { return 42; }" in changed["generatedSource"]
        assert (
            "if (true)" not in changed["generatedSource"]
            and "x = 99;" not in changed["generatedSource"]
        )
        assert "int inner = 2;" in changed["generatedSource"]


def test_false_parenthesized_unbraced_and_empty_branches_preserve_surrounding_text(tmp_path):
    variants = [
        ("if ((false)) x = 99; else x = 2;", "{\nx = 2;\n}"),
        ("if (false) { x = 99; }", "{}"),
        ("if (true) { if(false) x=99; else x=2; } else x=3;", "{ if(false) x=99; else x=2; }"),
    ]
    with TestClient(create_app(tmp_path)) as client:
        for before, after in variants:
            source = (
                'class Demo {\r\n\tint run(){ String s="😀 Кириллица"; int x=0; '
                + before
                + " return x; }\r\n}\r\n"
            )
            project, prefix, selection = import_condition(client, source)
            response = client.post(
                prefix + "/transformations/constant-branch/preview", json=selection
            )
            assert response.status_code == 200, response.text
            preview = response.json()
            assert preview["before"] == before and preview["after"] == after
            changed = client.post(
                prefix + "/transformations/constant-branch/apply",
                json={**selection, "previewHash": preview["previewHash"]},
            ).json()
            assert changed["generatedSource"] == source.replace(before, after)
            assert changed["originalSource"] == source


def test_unsupported_conditions_jumps_and_exception_regions_explain_refusal(tmp_path):
    variants = [
        "if (1==1) x++;",
        "if (true) return 1;",
        "if (true) throw new RuntimeException();",
        "for(int i=0;i<2;i++){if(true) break;}",
        "for(int i=0;i<2;i++){if(true) continue;}",
        "if(true) { while(true) {} }",
        "try { if(false) x++; } finally {x++;}",
        "while(true) {x++;}",
    ]
    with TestClient(create_app(tmp_path)) as client:
        for body in variants:
            source = "class Demo { int run(){ int x=0; " + body + " return x; } }"
            project, prefix, selection = import_condition(client, source)
            # Select the literal if inside a surrounding loop, rather than its nonliteral condition.
            graph = client.get(f"{prefix}/methods/{selection['methodId']}/graph").json()
            literal = next((n for n in graph["nodes"] if n.get("constantBranch")), None)
            if literal:
                selection["nodeId"] = literal["id"]
            response = client.post(
                prefix + "/transformations/constant-branch/preview", json=selection
            )
            assert response.status_code == 422, response.text
            assert response.json()["detail"]["errors"][0]["message"]
            assert client.get(prefix).json() == project


def test_preview_is_owned_hash_verified_and_invalidated_by_a_new_revision(tmp_path):
    with TestClient(create_app(tmp_path)) as owner, TestClient(create_app(tmp_path)) as outsider:
        project, prefix, selection = import_condition(owner)
        assert (
            outsider.post(
                prefix + "/transformations/constant-branch/preview", json=selection
            ).status_code
            == 404
        )
        preview = owner.post(
            prefix + "/transformations/constant-branch/preview", json=selection
        ).json()
        assert (
            owner.post(
                prefix + "/transformations/constant-branch/apply",
                json={**selection, "previewHash": "0" * 64},
            ).status_code
            == 409
        )
        assert owner.get(prefix).json() == project
        owner.post(
            prefix + "/source", json={"revision": 1, "source": SOURCE + "// another revision"}
        )
        assert (
            owner.post(
                prefix + "/transformations/constant-branch/apply",
                json={**selection, "previewHash": preview["previewHash"]},
            ).status_code
            == 409
        )
        assert owner.get(prefix).json()["generatedSource"] == SOURCE + "// another revision"


def test_confirmed_transformations_compile_and_match_in_real_docker(tmp_path):
    if not shutil.which(os.environ.get("BLUEPRINTS_DOCKER_BIN", "docker")):
        pytest.skip("Требуется настоящий Docker")
    variants = [
        ("if(true){ int inner=2; x+=inner; }else{x=99;} int inner=5; x+=inner;", "8\n"),
        ("if(false) x=99; else x=2;", "2\n"),
        ("if(false) x=99;", "1\n"),
        ("if(true){if(false)x=99;else x=2;}else x=3;", "2\n"),
    ]
    with TestClient(create_app(tmp_path)) as client:
        for body, expected in variants:
            source = (
                "class Demo { static int run(){int x=1; "
                + body
                + " return x;} public static void main(String[] args){System.out.println(run());}}"
            )
            project, prefix, selection = import_condition(client, source)
            preview = client.post(
                prefix + "/transformations/constant-branch/preview", json=selection
            ).json()
            response = client.post(
                prefix + "/transformations/constant-branch/apply",
                json={**selection, "previewHash": preview["previewHash"]},
            )
            assert response.status_code == 200, response.text
            changed = response.json()
            queued = client.post(
                prefix + "/checks",
                json={
                    "revision": changed["revision"],
                    "scenarios": [{"name": "После упрощения", "stdin": ""}],
                },
            ).json()
            run_worker(tmp_path, once=True)
            job = client.get("/api/checks/" + queued["id"]).json()
            assert job["result"]["verdict"] == "matched", job["result"]
            assert job["sourceRevision"] == 2
            assert job["result"]["cases"][0]["working"]["stdout"] == expected


def test_compilation_failure_after_confirmation_cannot_be_a_match(tmp_path):
    if not shutil.which(os.environ.get("BLUEPRINTS_DOCKER_BIN", "docker")):
        pytest.skip("Требуется настоящий Docker")
    source = (
        "class Demo { static int run(){if(true){System.out.println(missing);} return 0;} "
        "public static void main(String[] args){run();}}"
    )
    with TestClient(create_app(tmp_path)) as client:
        _, prefix, selection = import_condition(client, source)
        preview = client.post(
            prefix + "/transformations/constant-branch/preview", json=selection
        ).json()
        changed = client.post(
            prefix + "/transformations/constant-branch/apply",
            json={**selection, "previewHash": preview["previewHash"]},
        ).json()
        queued = client.post(
            prefix + "/checks",
            json={
                "revision": changed["revision"],
                "scenarios": [{"name": "Ошибка компиляции", "stdin": ""}],
            },
        ).json()
        run_worker(tmp_path, once=True)
        job = client.get("/api/checks/" + queued["id"]).json()
        assert job["result"]["verdict"] == "inconclusive"
        assert job["result"]["error"]["kind"] == "compile_error"
