"""Public-API integration with the real worker and real isolated Java execution."""

import os
import shutil
import time
import uuid
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.execution import DockerExecutor, RunnerError, check_snapshot
from backend.worker import run_worker

pytestmark = pytest.mark.skipif(
    not shutil.which(os.environ.get("BLUEPRINTS_DOCKER_BIN", "docker")),
    reason="Real Docker is required; run scripts/test_runner.py on a Docker host",
)

ECHO = """public class Echo {
    public static void main(String[] args) {
        System.out.println(new java.util.Scanner(System.in).nextLine());
    }
}
"""


def test_real_worker_compiles_and_compares_utf8_inputs(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        project = client.post(
            "/api/projects", json={"filename": "Echo.java", "source": ECHO}
        ).json()
        job = client.post(
            f"/api/projects/{project['id']}/checks",
            json={
                "revision": 1,
                "scenarios": [
                    {"name": "Русский ввод", "stdin": "Привет, мир\n"},
                    {"name": "Другой вход", "stdin": "Other input\n"},
                ],
            },
        ).json()
        run_worker(tmp_path, once=True)
        result = client.get(f"/api/checks/{job['id']}").json()
        assert result["status"] == "completed", result
        assert result["result"]["verdict"] == "matched"
        assert [case["original"]["stdout"] for case in result["result"]["cases"]] == [
            "Привет, мир\n",
            "Other input\n",
        ]
        assert all(case["original"]["exitCode"] == 0 for case in result["result"]["cases"])


@pytest.mark.parametrize(
    "body,kind",
    [
        ("int value = missingSymbol;", "compile_error"),
        ("while (true) {}", "timeout"),
        ('while (true) { System.out.print("0123456789"); }', "output_limit"),
        ("byte[] memory = new byte[512 * 1024 * 1024];", "resource_limit"),
        (
            "var held = new java.util.ArrayList<byte[]>(); while (true) held.add(new byte[1024]);",
            "resource_limit",
        ),
        (
            "Thread t = new Thread(() -> { byte[] b = new byte[512 * 1024 * 1024]; }); "
            "t.start(); try { t.join(); } catch (InterruptedException e) { throw new Error(e); }",
            "resource_limit",
        ),
        (
            "Runtime.getRuntime().addShutdownHook(new Thread(() -> { "
            "byte[] b = new byte[512 * 1024 * 1024]; }));",
            "resource_limit",
        ),
    ],
)
def test_failed_or_unfinished_execution_never_reports_a_match(tmp_path, body, kind):
    source = "public class Failure { public static void main(String[] args) { " + body + " } }"
    with TestClient(create_app(tmp_path)) as client:
        project = client.post(
            "/api/projects", json={"filename": "Failure.java", "source": source}
        ).json()
        job = client.post(
            f"/api/projects/{project['id']}/checks",
            json={
                "revision": 1,
                "scenarios": [{"name": "Граница исполнения", "stdin": ""}],
            },
        ).json()
        run_worker(tmp_path, once=True)
        result = client.get(f"/api/checks/{job['id']}").json()
        assert result["status"] == "failed", result
        assert result["result"]["verdict"] == "inconclusive"
        assert result["result"]["error"]["kind"] == kind
        assert result["result"]["cases"][0]["working"] is None
        if kind == "output_limit":
            assert len(result["result"]["cases"][0]["original"]["stdout"]) <= 65_536


def compare(original, working, name="Comparison"):
    executor = DockerExecutor("test-" + uuid.uuid4().hex)
    snapshot = {
        "filename": name + ".java",
        "mainClass": name,
        "sourceOriginal": original,
        "sourceWorking": working,
        "scenarios": [{"name": "Сравнение наблюдений", "stdin": ""}],
    }
    result = check_snapshot(executor, snapshot, lambda phase: None)
    remaining = executor.control(
        ["ps", "-aq", "--filter", f"label=dev.blueprints.deployment={executor.deployment}"]
    ).stdout
    assert remaining.strip() == b"", "Контейнеры проверки должны удаляться после выполнения"
    return result


def test_uncaught_exception_ignores_only_its_stack_lines():
    original = """public class Comparison {
      public static void main(String[] args) {
        System.err.print("ordinary stderr\\n");
        throw new IllegalStateException("Ошибка");
      }
    }"""
    working = original.replace("throw new", "\n\n\nthrow new")
    result = compare(original, working)
    assert result["verdict"] == "matched", result
    assert result["cases"][0]["original"]["stderr"] == "ordinary stderr\n"
    assert result["cases"][0]["working"]["stderr"] == "ordinary stderr\n"
    assert (
        result["cases"][0]["original"]["stackTrace"] != result["cases"][0]["working"]["stackTrace"]
    )
    assert result["cases"][0]["original"]["exception"]["message"] == "Ошибка"


def test_uncaught_thread_exception_ignores_stack_lines():
    original = """public class Comparison {
      public static void main(String[] args) throws Exception {
        Thread t = new Thread(() -> { throw new IllegalStateException("Ошибка потока"); });
        t.start(); t.join();
      }
    }"""
    result = compare(original, original.replace("Thread t", "\n\nThread t"))
    assert result["verdict"] == "matched", result
    assert result["cases"][0]["original"]["exception"]["message"] == "Ошибка потока"
    changed = original.replace("t.start();", 'System.err.print("ordinary stderr"); t.start();')
    assert compare(original, changed)["verdict"] == "different"


def test_explicit_high_exit_code_remains_an_observable_result():
    source = "public class Comparison { public static void main(String[] a) {System.exit(255);} }"
    result = compare(source, source)
    assert result["verdict"] == "matched", result
    assert result["cases"][0]["original"]["exitCode"] == 255


def test_exception_stack_copy_cannot_hide_reordered_ordinary_stderr():
    template = r"""public class Comparison {
      static volatile IllegalStateException saved;
      public static void main(String[] args) throws Exception {
        Thread t = new Thread(() -> {
          saved = new IllegalStateException("x");
          saved.setStackTrace(new StackTraceElement[]{
            new StackTraceElement("C", "run", "C.java", LINE)});
          throw saved;
        });
        t.start(); t.join();
        saved.setStackTrace(new StackTraceElement[]{
          new StackTraceElement("C", "run", "C.java", 1)});
        var buffer = new java.io.StringWriter();
        buffer.append("Exception in thread \"Thread-0\" ");
        saved.printStackTrace(new java.io.PrintWriter(buffer));
        String copy = buffer.toString();
        ORDINARY
      }
    }"""
    original = template.replace("LINE", "1").replace(
        "ORDINARY", r'System.err.print("ordinary text\n" + copy);'
    )
    working = template.replace("LINE", "9").replace(
        "ORDINARY", r'System.err.print(copy + "ordinary text\n");'
    )
    result = compare(original, working)
    assert result["verdict"] == "different", result
    assert result["cases"][0]["original"]["stderr"].startswith("ordinary text\n")
    assert result["cases"][0]["working"]["stderr"].endswith("ordinary text\n")


def test_abrupt_halt_without_final_report_never_matches():
    source = (
        "public class Comparison { public static void main(String[] a) {"
        "Runtime.getRuntime().halt(0);} }"
    )
    result = compare(source, source)
    assert result["verdict"] == "inconclusive", result
    assert result["error"]["kind"] == "execution_error"


def test_unavailable_main_is_an_entrypoint_error():
    source = "public class Comparison { public void main(String[] args) {} }"
    result = compare(source, source)
    assert result["verdict"] == "inconclusive", result
    assert result["error"]["kind"] == "entrypoint_error"


@pytest.mark.parametrize(
    "before,after",
    [
        ('System.out.print("A");', 'System.out.print("B");'),
        ('throw new IllegalArgumentException("A");', 'throw new IllegalArgumentException("B");'),
        ('System.err.print("ordinary A");', 'System.err.print("ordinary B");'),
        (
            'System.err.print("java.lang.RuntimeException: test\\n'
            '\\tat Comparison.main(Comparison.java:1)\\n");System.exit(1);',
            'System.err.print("java.lang.RuntimeException: test\\n'
            '\\tat Comparison.main(Comparison.java:999)\\n");System.exit(1);',
        ),
    ],
)
def test_changed_observations_are_reported_as_different(before, after):
    prefix = "public class Comparison { public static void main(String[] args) { "
    result = compare(prefix + before + " } }", prefix + after + " } }")
    assert result["verdict"] == "different", result


def test_sandbox_is_nonroot_readonly_networkless_and_resource_bounded(tmp_path):
    source = """public class Security {
      public static void main(String[] args) throws Exception {
        String status = java.nio.file.Files.readString(java.nio.file.Path.of("/proc/self/status"));
        System.out.println(status.lines().filter(s -> s.startsWith("Uid:")).findFirst().orElse(""));
        var memory = java.nio.file.Path.of("/sys/fs/cgroup/memory.max");
        var pids = java.nio.file.Path.of("/sys/fs/cgroup/pids.max");
        System.out.println("MEM=" + java.nio.file.Files.readString(memory).trim());
        System.out.println("PIDS=" + java.nio.file.Files.readString(pids).trim());
        try { java.nio.file.Files.writeString(java.nio.file.Path.of("/var/tmp/proof"), "x");
          System.out.println("ROOT_WRITABLE");
        } catch (java.io.IOException e) { System.out.println("ROOT_READONLY"); }
        var target = new java.net.InetSocketAddress("198.51.100.1", 80);
        try { new java.net.Socket().connect(target, 1000);
          System.out.println("NETWORK_OPEN");
        } catch (java.io.IOException e) { System.out.println("NETWORK_BLOCKED"); }
      }
    }"""
    result = compare(source, source, "Security")
    assert result["verdict"] == "matched", result
    output = result["cases"][0]["original"]["stdout"]
    assert "Uid:\t1000\t1000\t1000\t1000" in output
    assert "MEM=536870912" in output
    assert "PIDS=64" in output
    assert "ROOT_READONLY" in output
    assert "NETWORK_BLOCKED" in output


def test_malformed_jvm_outcome_never_matches(tmp_path):
    source = """public class Forgery {
      public static void main(String[] args) throws Exception {
        java.nio.file.Files.writeString(java.nio.file.Path.of("/work/outcome.json"), "{}");
        Runtime.getRuntime().halt(0);
      }
    }"""
    with TestClient(create_app(tmp_path)) as client:
        project = client.post(
            "/api/projects", json={"filename": "Forgery.java", "source": source}
        ).json()
        job = client.post(
            f"/api/projects/{project['id']}/checks",
            json={
                "revision": 1,
                "scenarios": [{"name": "Защита результата", "stdin": ""}],
            },
        ).json()
        run_worker(tmp_path, once=True)
        result = client.get(f"/api/checks/{job['id']}").json()
        assert result["status"] == "failed"
        assert result["result"]["verdict"] == "inconclusive"
        assert result["result"]["error"]["kind"] == "execution_error"


def test_launcher_state_is_not_open_to_user_reflection():
    source = """public class Comparison {
      public static void main(String[] args) throws Exception {
        var handler = Thread.getDefaultUncaughtExceptionHandler();
        for (var field : handler.getClass().getDeclaredFields()) {
          if (field.trySetAccessible()) throw new AssertionError("Launcher state is open");
        }
        try { Class.forName("sun.misc.Unsafe"); throw new AssertionError("Unsafe is visible"); }
        catch (ClassNotFoundException expected) {}
        System.out.println("Launcher module is closed");
      }
    }"""
    result = compare(source, source)
    assert result["verdict"] == "matched", result
    assert result["cases"][0]["original"]["stdout"] == "Launcher module is closed\n"


def test_one_worker_keeps_the_next_job_queued(tmp_path):
    with TestClient(create_app(tmp_path)) as client:
        project = client.post(
            "/api/projects", json={"filename": "Echo.java", "source": ECHO}
        ).json()

        def enqueue(text):
            return client.post(
                f"/api/projects/{project['id']}/checks",
                json={
                    "revision": 1,
                    "scenarios": [{"name": text, "stdin": text + "\n"}],
                },
            ).json()

        first, second = enqueue("Первый"), enqueue("Второй")
        with ThreadPoolExecutor(max_workers=1) as pool:
            running = pool.submit(run_worker, tmp_path, once=True)
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                if client.get(f"/api/checks/{first['id']}").json()["status"] == "running":
                    break
                time.sleep(0.05)
            assert client.get(f"/api/checks/{first['id']}").json()["status"] == "running"
            assert client.get(f"/api/checks/{second['id']}").json()["status"] == "queued"
            with pytest.raises(RunnerError, match="уже запущен"):
                run_worker(tmp_path, once=True)
            running.result(timeout=60)
        assert client.get(f"/api/checks/{first['id']}").json()["result"]["verdict"] == "matched"
        assert client.get(f"/api/checks/{second['id']}").json()["status"] == "queued"
        run_worker(tmp_path, once=True)
        assert client.get(f"/api/checks/{second['id']}").json()["result"]["verdict"] == "matched"
