from fastapi.testclient import TestClient

from backend.app import create_app

SOURCE = """class Demo {
 static int run(int n) {
  int doubled = n * 2;
  int result = doubled + 1;
  return result;
 }
 int untouched() { return 42; }
}
"""


def import_method(client, source=SOURCE):
    response = client.post("/api/projects", json={"filename": "Demo.java", "source": source})
    assert response.status_code == 201, response.text
    project = response.json()
    method = next(m for m in project["methods"] if m["name"] == "run")
    selection = {
        "revision": project["revision"],
        "methodId": method["id"],
        "startIndex": 0,
        "endIndex": 2,
        "methodName": "calculate",
    }
    return project, f"/api/projects/{project['id']}", selection


def test_extract_preview_defines_parameters_and_result_before_atomic_confirmation(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        project, prefix, selection = import_method(client)
        response = client.post(prefix + "/transformations/extract-method/preview", json=selection)
        assert response.status_code == 200, response.text
        preview = response.json()
        assert preview["parameters"] == [{"name": "n", "type": "int"}]
        assert preview["returnType"] == "int" and preview["outputName"] == "result"
        assert "int result = calculate(n);" in preview["after"]
        assert "private static int calculate(int n)" in preview["newMethod"]
        assert "return result;" in preview["newMethod"]
        assert client.get(prefix).json() == project
        response = client.post(
            prefix + "/transformations/extract-method/apply",
            json={**selection, "previewHash": preview["previewHash"]},
        )
        assert response.status_code == 200, response.text
        changed = response.json()
        assert changed["revision"] == changed["graphRevision"] == 2
        assert changed["originalSource"] == SOURCE
        assert "int untouched() { return 42; }" in changed["generatedSource"]
        helper = next(m for m in changed["methods"] if m["name"] == "calculate")
        graph = client.get(f"{prefix}/methods/{helper['id']}/graph").json()
        assert any(n["code"] == "return result;" for n in graph["nodes"])


def test_single_external_output_and_void_fragments_have_explicit_signatures(tmp_path):
    variants = [
        (
            "class Demo { int run(int n){int value=1; value+=n; value*=2; return value;} }",
            1,
            3,
            "int",
            "value",
            "value = calculate(value, n);",
        ),
        (
            "class Demo { int run(int n){int unused=n+1; unused++; return n;} }",
            0,
            2,
            "void",
            "",
            "calculate(n);",
        ),
    ]
    with TestClient(create_app(tmp_path)) as client:
        for source, start, end, result, output, call in variants:
            project, prefix, selection = import_method(client, source)
            selection.update(startIndex=start, endIndex=end)
            response = client.post(
                prefix + "/transformations/extract-method/preview", json=selection
            )
            assert response.status_code == 200, response.text
            preview = response.json()
            assert preview["returnType"] == result and preview["outputName"] == output
            assert preview["after"] == call
            assert "private " + result + " calculate(" in preview["newMethod"]


def test_ambiguous_dependencies_types_jumps_and_multiple_outputs_are_rejected(tmp_path):
    variants = [
        ("class Demo { static int run(int n){int value=n+1;return value;} }", 0, 1, "yield"),
        (
            "class Demo { int x=1; int run(){int result=x; int x=2; return result;} }",
            0,
            2,
            "calculate",
        ),
        ("class Demo { int field=1; int run(){int x=field+1; return x;} }", 0, 1, "calculate"),
        ("class Demo { int run(String text){int x=text.length(); return x;} }", 0, 1, "calculate"),
        ("class Demo { int run(int n){var x=n+1; return x;} }", 0, 1, "calculate"),
        ("class Demo { int run(int n){if(n>0)return n; return 0;} }", 0, 1, "calculate"),
        ("class Demo { int run(int n){return n;} }", 0, 1, "calculate"),
        ("class Demo { int run(int n){int x=n; int y=n+1; return x+y;} }", 0, 2, "calculate"),
        ("class Demo { int run(int n){int x; x=n; return x;} }", 1, 2, "calculate"),
        (
            "class Demo { int run(int n){int x=n; return x;} int calculate(){return 0;} }",
            0,
            1,
            "calculate",
        ),
        ("class Demo { int run(int n){int x=n; return x;} }", 0, 1, "return"),
        ("class Demo extends Object { int run(int n){int x=n; return x;} }", 0, 1, "calculate"),
    ]
    with TestClient(create_app(tmp_path)) as client:
        for source, start, end, name in variants:
            project, prefix, selection = import_method(client, source)
            selection.update(startIndex=start, endIndex=end, methodName=name)
            response = client.post(
                prefix + "/transformations/extract-method/preview", json=selection
            )
            assert response.status_code == 422, response.text
            assert response.json()["detail"]["errors"][0]["message"]
            assert client.get(prefix).json() == project


def test_extract_preview_is_private_and_revision_hash_verified(tmp_path):
    with TestClient(create_app(tmp_path)) as owner, TestClient(create_app(tmp_path)) as outsider:
        project, prefix, selection = import_method(owner)
        assert (
            outsider.post(
                prefix + "/transformations/extract-method/preview", json=selection
            ).status_code
            == 404
        )
        preview = owner.post(
            prefix + "/transformations/extract-method/preview", json=selection
        ).json()
        assert (
            owner.post(
                prefix + "/transformations/extract-method/apply",
                json={**selection, "previewHash": "0" * 64},
            ).status_code
            == 409
        )
        assert owner.get(prefix).json() == project
        owner.post(prefix + "/source", json={"revision": 1, "source": SOURCE + "// edit"})
        assert (
            owner.post(
                prefix + "/transformations/extract-method/apply",
                json={**selection, "previewHash": preview["previewHash"]},
            ).status_code
            == 409
        )


def test_extraction_preserves_utf16_crlf_comments_and_other_methods(tmp_path):
    source = (
        'class Demo {\r\n static int run(int n){String marker="😀 Кириллица"; '
        "int x=n*2; /* keep */ int result=x+1; return result;}\r\n "
        "int untouched(){int x=6; return x;}\r\n}\r\n"
    )
    with TestClient(create_app(tmp_path)) as client:
        project, prefix, selection = import_method(client, source)
        selection.update(startIndex=1, endIndex=3)
        preview = client.post(prefix + "/transformations/extract-method/preview", json=selection)
        assert preview.status_code == 200, preview.text
        preview = preview.json()
        assert "/* keep */" in preview["newMethod"]
        applied = client.post(
            prefix + "/transformations/extract-method/apply",
            json={**selection, "previewHash": preview["previewHash"]},
        ).json()
        assert (
            'String marker="😀 Кириллица"; int result = calculate(n); return result;'
            in applied["generatedSource"]
        )
        assert "int untouched(){int x=6; return x;}\r\n" in applied["generatedSource"]
        assert applied["generatedSource"].endswith("}\r\n")
        assert applied["originalSource"] == source


def test_extracted_methods_compile_and_match_real_execution(tmp_path):
    import os
    import shutil

    import pytest

    from backend.worker import run_worker

    if not shutil.which(os.environ.get("BLUEPRINTS_DOCKER_BIN", "docker")):
        pytest.skip("Требуется настоящий Docker")
    variants = [
        (
            "static double run(int n, boolean ok, double scale){double temp=n*scale;"
            "double result=ok?temp:0;return result;}",
            0,
            2,
            "run(3,true,2.5)",
            "7.5\n",
        ),
        (
            "static int run(int n){final int constant=1;byte result=constant;return result+n;}",
            0,
            2,
            "run(3)",
            "4\n",
        ),
        (
            "static int run(int n){int doubled=n*2; int result=doubled+1; return result;}",
            0,
            2,
            "run(3)",
            "7\n",
        ),
        (
            "int run(int n){int value=1; value+=n; value*=2; return value;}",
            1,
            3,
            "new Demo().run(3)",
            "8\n",
        ),
        ("static int run(){int result=3;result++;return result;}", 0, 2, "run()", "4\n"),
        ("static int run(int n){int unused=n+1;unused++;return n;}", 0, 2, "run(3)", "3\n"),
        ("static int run(int n){int unused=10/n;unused++;return n;}", 0, 2, "run(0)", ""),
    ]
    with TestClient(create_app(tmp_path)) as client:
        for method, start, end, call, stdout in variants:
            source = (
                "class Demo { "
                + method
                + " public static void main(String[] args){System.out.println("
                + call
                + ");} }"
            )
            project, prefix, selection = import_method(client, source)
            selection.update(startIndex=start, endIndex=end)
            response = client.post(
                prefix + "/transformations/extract-method/preview", json=selection
            )
            assert response.status_code == 200, response.text
            preview = response.json()
            changed = client.post(
                prefix + "/transformations/extract-method/apply",
                json={**selection, "previewHash": preview["previewHash"]},
            )
            assert changed.status_code == 200, changed.text
            queued = client.post(
                prefix + "/checks",
                json={
                    "revision": changed.json()["revision"],
                    "scenarios": [{"name": "Выделение метода", "stdin": ""}],
                },
            ).json()
            run_worker(tmp_path, once=True)
            job = client.get("/api/checks/" + queued["id"]).json()
            assert job["result"]["verdict"] == "matched", job["result"]
            assert job["result"]["cases"][0]["working"]["stdout"] == stdout


def test_final_constant_boundaries_are_rejected_without_breaking_narrowing(tmp_path):
    source = "class Demo { int run(){final int n=1; byte result=n; return result;} }"
    with TestClient(create_app(tmp_path)) as client:
        project, prefix, selection = import_method(client, source)
        for start, end in [(0, 1), (1, 2)]:
            selection.update(startIndex=start, endIndex=end)
            response = client.post(
                prefix + "/transformations/extract-method/preview", json=selection
            )
            assert response.status_code == 422, response.text
            assert "final" in response.json()["detail"]["errors"][0]["message"]
            assert client.get(prefix).json() == project


def test_jvm_parameter_slot_limit_is_checked_before_preview(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        for static, count, extra_int, expected in [
            (True, 127, False, 200),
            (False, 127, False, 200),
            (True, 127, True, 200),
            (False, 127, True, 422),
            (True, 128, False, 422),
        ]:
            variables = " ".join(f"double v{i}={i};" for i in range(count))
            expression = "+".join(f"v{i}" for i in range(count))
            if extra_int:
                variables += " int extra=1;"
                expression += "+extra"
            source = (
                "class Demo { "
                + ("static " if static else "")
                + "double run(){"
                + variables
                + " double result="
                + expression
                + "; return result;} }"
            )
            project, prefix, selection = import_method(client, source)
            index = count + int(extra_int)
            selection.update(startIndex=index, endIndex=index + 1)
            response = client.post(
                prefix + "/transformations/extract-method/preview", json=selection
            )
            assert response.status_code == expected, response.status_code
            if expected == 422:
                assert "255" in response.json()["detail"]["errors"][0]["message"]
            else:
                assert len(response.json()["parameters"]) == index
            assert client.get(prefix).json() == project
