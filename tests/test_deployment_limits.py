"""Measure enforcement through the actual Docker executor, not just configured flags."""

import os
import shutil
import uuid

import pytest

from backend.execution import DockerExecutor

pytestmark = pytest.mark.skipif(
    not shutil.which(os.environ.get("BLUEPRINTS_DOCKER_BIN", "docker")),
    reason="Real Docker and the prepared runner image are required",
)


def run_probe(body: str, extra: str = "") -> str:
    executor = DockerExecutor("deployment-test-" + uuid.uuid4().hex)
    source = "public class Probe { public static void main(String[] a) throws Exception {"
    source += body + "}}" + extra
    result = executor.run("Probe.java", source, "Probe", "")
    assert result.status == "finished", result.public()
    assert result.exit_code == 0, result.public()
    remaining = executor.control(
        ["ps", "-aq", "--filter", f"label=dev.blueprints.deployment={executor.deployment}"]
    )
    assert not remaining.stdout.strip(), "Completed probe left a container or its tmpfs behind"
    return result.stdout.decode() + result.stderr.decode()


def test_cpu_quota_throttles_busy_threads():
    output = run_probe("""
        var path = java.nio.file.Path.of("/sys/fs/cgroup/cpu.stat");
        String before = java.nio.file.Files.readString(path);
        var threads = new java.util.ArrayList<Thread>();
        for (int i = 0; i < 4; i++) {
            Thread t = new Thread(() -> {
                long end = System.nanoTime() + 1_500_000_000L;
                while (System.nanoTime() < end) { Thread.onSpinWait(); }
            });
            threads.add(t); t.start();
        }
        for (Thread t : threads) t.join();
        String after = java.nio.file.Files.readString(path);
        long initial = before.lines().filter(s -> s.startsWith("nr_throttled "))
            .mapToLong(s -> Long.parseLong(s.split(" ")[1])).findFirst().orElseThrow();
        long actual = after.lines().filter(s -> s.startsWith("nr_throttled "))
            .mapToLong(s -> Long.parseLong(s.split(" ")[1])).findFirst().orElseThrow();
        System.out.println("THROTTLED=" + (actual > initial));
    """)
    assert "THROTTLED=true" in output


def test_pid_limit_rejects_excess_threads():
    output = run_probe("""
        int started = 0;
        var threads = new java.util.ArrayList<Thread>();
        try {
            for (; started < 100; started++) {
                Thread t = new Thread(() -> {
                    try { Thread.sleep(30000); } catch (InterruptedException e) {}
                });
                t.setDaemon(true); t.start(); threads.add(t);
            }
        } catch (OutOfMemoryError expected) {}
        String events = java.nio.file.Files.readString(
            java.nio.file.Path.of("/sys/fs/cgroup/pids.events"));
        long failures = events.lines().filter(s -> s.startsWith("max "))
            .mapToLong(s -> Long.parseLong(s.split(" ")[1])).findFirst().orElseThrow();
        for (Thread t : threads) t.interrupt();
        for (Thread t : threads) t.join();
        System.out.println("PIDS_ENFORCED=" + (started < 64 && failures > 0));
    """)
    assert "PIDS_ENFORCED=true" in output


def test_container_memory_limit_kills_a_child_that_exceeds_the_jvm_heap_budget():
    output = run_probe(
        """
        Process child = new ProcessBuilder("java", "-Xmx768m", "-XX:+UseSerialGC",
            "-XX:ActiveProcessorCount=1", "-cp", "/work/classes", "MemoryHog")
            .inheritIO().start();
        int code = child.waitFor();
        String events = java.nio.file.Files.readString(
            java.nio.file.Path.of("/sys/fs/cgroup/memory.events"));
        long killed = events.lines().filter(s -> s.startsWith("oom_kill "))
            .mapToLong(s -> Long.parseLong(s.split(" ")[1])).findFirst().orElseThrow();
        System.out.println("CHILD_EXIT=" + code + " EVENTS=" + events);
        System.out.println("MEMORY_ENFORCED=" + (code == 137 && killed > 0));
    """,
        """
        class MemoryHog {
            public static void main(String[] a) {
                    var held = new java.util.ArrayList<byte[]>();
                    for (int i = 0; i < 90; i++) {
                        byte[] value = new byte[8 * 1024 * 1024];
                        java.util.Arrays.fill(value, (byte) 42);
                        held.add(value);
                    }
                    System.out.println(held.size());
            }
        }
    """,
    )
    assert "MEMORY_ENFORCED=true" in output


@pytest.mark.parametrize("directory,limit", [("/work", 64), ("/tmp", 16)])
def test_temporary_storage_is_bounded_and_removed(directory, limit):
    output = run_probe(f"""
        int written = 0;
        try (var stream = java.nio.file.Files.newOutputStream(
            java.nio.file.Path.of("{directory}/fill"))) {{
            byte[] chunk = new byte[1024 * 1024];
            for (; written <= {limit}; written++) stream.write(chunk);
        }} catch (java.io.IOException expected) {{}}
        java.nio.file.Files.deleteIfExists(java.nio.file.Path.of("{directory}/fill"));
        System.out.println("STORAGE_ENFORCED=" + (written <= {limit}));
    """)
    assert "STORAGE_ENFORCED=true" in output
