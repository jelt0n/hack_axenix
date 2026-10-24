from fastapi.testclient import TestClient

from backend.app import create_app


def test_analysis_explains_long_method_and_links_to_its_graph(tmp_path):
    source = "class Demo {\n int run(int n) {\n int x = 0;\n" + " x++;\n" * 40 + " return x;\n }\n}"
    with TestClient(create_app(tmp_path)) as client:
        project = client.post(
            "/api/projects", json={"filename": "Demo.java", "source": source}
        ).json()
        response = client.post(f"/api/projects/{project['id']}/analysis", json={"revision": 1})
        assert response.status_code == 200, response.text
        analysis = response.json()
        assert analysis["sourceRevision"] == 1
        finding = next(f for f in analysis["findings"] if f["rule"] == "long-method")
        assert finding["range"]["startLine"] == 2
        assert finding["message"] and finding["recommendation"]
        graph = client.get(
            f"/api/projects/{project['id']}/methods/{finding['methodId']}/graph"
        ).json()
        assert finding["nodeId"] in {n["id"] for n in graph["nodes"]}
        assert analysis["methods"][0]["complexity"]["label"] == "O(1)"


def test_rules_find_nesting_literal_conditions_and_nested_loops_without_false_positives(tmp_path):
    source = """class Demo {
 int run(int n) {
  int sum = 0;
  if (true) {
   for (int i=0; i<n; i++) {
    for (int j=0; j<n; j++) {
     sum++;
    }
   }
  }
  return sum;
 }
 int clean(int n) { if (n > 0) return n; return 0; }
} """
    with TestClient(create_app(tmp_path)) as client:
        project = client.post(
            "/api/projects", json={"filename": "Demo.java", "source": source}
        ).json()
        response = client.post(f"/api/projects/{project['id']}/analysis", json={"revision": 1})
        assert response.status_code == 200, response.text
        analysis = response.json()
        assert {f["rule"] for f in analysis["findings"]} == {
            "deep-nesting",
            "constant-condition",
            "nested-loops",
        }
        clean_id = project["methods"][1]["id"]
        assert all(f["methodId"] != clean_id for f in analysis["findings"])
        for finding in analysis["findings"]:
            graph = client.get(
                f"/api/projects/{project['id']}/methods/{finding['methodId']}/graph"
            ).json()
            assert finding["nodeId"] in {n["id"] for n in graph["nodes"]}
        assert analysis["methods"][0]["complexity"]["label"] == "O(n²)"
        assert analysis["methods"][1]["complexity"]["label"] == "O(1)"


def test_complexity_is_unknown_for_calls_and_unsupported_or_mutated_loops(tmp_path):
    bodies = [
        ("int x=0; for(int i=0;i<n;i++) x++; return x;", "O(n)"),
        ("int x=0; for(int i=0;i<10;i++) x++; return x;", "O(1)"),
        ("return helper(n);", "не определена"),
        ("while(n>0) n--; return n;", "не определена"),
        ("for(int i=0;i<n;i++) { n++; } return n;", "не определена"),
        ("for(int i=0;i<n;i++) { (n)++; } return n;", "не определена"),
        ("for(int i=0;i<n;i++) { i--; } return n;", "не определена"),
        ("int x=0; for(int i=0;i<n;i++) for(int j=0;j<i;j++) x++; return x;", "не определена"),
        ('return "abc".length();', "не определена"),
        ("Runnable r=()->{for(int i=0;i<n;i++) {}}; return n;", "не определена"),
    ]
    with TestClient(create_app(tmp_path)) as client:
        for body, expected in bodies:
            source = f"class Demo {{ int run(int n) {{ {body} }} int helper(int n) {{return n;}} }}"
            project = client.post(
                "/api/projects", json={"filename": "Demo.java", "source": source}
            ).json()
            response = client.post(f"/api/projects/{project['id']}/analysis", json={"revision": 1})
            assert response.status_code == 200, response.text
            estimate = response.json()["methods"][0]["complexity"]
            assert estimate["label"] == expected, (body, estimate)
            assert estimate["explanation"]
            if expected != "не определена":
                assert estimate["assumptions"]


def test_analysis_is_private_revision_bound_and_does_not_change_source(tmp_path):
    with TestClient(create_app(tmp_path)) as owner, TestClient(create_app(tmp_path)) as stranger:
        source = "class Demo { int run(){if(false) return 1; return 0;} }"
        project = owner.post(
            "/api/projects", json={"filename": "Demo.java", "source": source}
        ).json()
        prefix = f"/api/projects/{project['id']}"
        assert stranger.post(prefix + "/analysis", json={"revision": 1}).status_code == 404
        assert owner.post(prefix + "/analysis", json={"revision": 2}).status_code == 409
        assert owner.post(prefix + "/analysis", json={"revision": 1}).status_code == 200
        assert owner.get(prefix).json() == project
        saved = owner.post(prefix + "/source", json={"revision": 1, "source": source + "\n"}).json()
        assert (
            owner.post(prefix + "/analysis", json={"revision": saved["revision"]}).status_code
            == 409
        )


def test_rule_boundaries_do_not_report_short_shallow_or_computed_conditions(tmp_path):
    source = (
        "class Demo {\n int run(int n) {\n"
        + "// padding\n" * 36
        + " if(n>0) { if(1==1) return 1; } return 0;\n }\n}"
    )
    with TestClient(create_app(tmp_path)) as client:
        project = client.post(
            "/api/projects", json={"filename": "Demo.java", "source": source}
        ).json()
        report = client.post(f"/api/projects/{project['id']}/analysis", json={"revision": 1}).json()
        assert report["findings"] == []
        assert report["thresholds"] == {"longMethodLines": 40, "deepNesting": 3}


def test_array_size_and_independent_dimensions_have_explicit_bounds(tmp_path):
    source = """class Demo {
 int run(int[] items, int m) {
  int x=0;
  for(int i=0;i<items.length;i++) {
   for(int j=0;j<m;j++) { x+=items[i]; }
  }
  return x;
 }
} """
    with TestClient(create_app(tmp_path)) as client:
        project = client.post(
            "/api/projects", json={"filename": "Demo.java", "source": source}
        ).json()
        report = client.post(f"/api/projects/{project['id']}/analysis", json={"revision": 1}).json()
        estimate = report["methods"][0]["complexity"]
        assert estimate["label"] == "O(items.length + items.length · m)"
        assert estimate["assumptions"]


def test_implicit_constructor_work_is_not_reported_as_constant(tmp_path):
    source = "class Base { Base(){while(true){}} } class Demo extends Base { Demo(){} }"
    with TestClient(create_app(tmp_path)) as client:
        project = client.post(
            "/api/projects", json={"filename": "Demo.java", "source": source}
        ).json()
        report = client.post(f"/api/projects/{project['id']}/analysis", json={"revision": 1}).json()
        assert all(m["complexity"]["label"] == "не определена" for m in report["methods"])


def test_nesting_points_to_condition_and_does_not_cross_deferred_lambda_boundary(tmp_path):
    source = """class Demo {
 int run(int n){if(n>0){if(n>1){if(n>2)return 1;}}return 0;}
 void deferred(int n){for(int i=0;i<n;i++){Runnable r=()->{for(int j=0;j<n;j++) {}};}}
} """
    with TestClient(create_app(tmp_path)) as client:
        project = client.post(
            "/api/projects", json={"filename": "Demo.java", "source": source}
        ).json()
        report = client.post(f"/api/projects/{project['id']}/analysis", json={"revision": 1}).json()
        assert [f["rule"] for f in report["findings"]] == ["deep-nesting"]
        finding = report["findings"][0]
        graph = client.get(
            f"/api/projects/{project['id']}/methods/{finding['methodId']}/graph"
        ).json()
        block = next(n for n in graph["nodes"] if n["id"] == finding["nodeId"])
        assert block["kind"] == "condition"
        assert block["code"] == "n > 2"
