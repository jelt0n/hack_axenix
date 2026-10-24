"""One trusted worker owns Docker; API processes only use the SQLite queue."""

import fcntl
import logging
import os
import secrets
import threading
import time
from pathlib import Path

from backend.checks import CheckQueue
from backend.execution import DockerExecutor, RunnerError, check_snapshot


def run_worker(directory: Path, *, once: bool = False):
    queue = CheckQueue(directory)
    with (directory / "worker.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise RunnerError("Исполнитель для этой очереди уже запущен") from exc
        deployment_file = directory / "runner-deployment"
        if not deployment_file.exists():
            deployment_file.write_text(secrets.token_hex(16))
        executor = DockerExecutor(deployment_file.read_text().strip())
        executor.cleanup_orphans()
        queue.recover()
        stopped = threading.Event()

        def heartbeat():
            while not stopped.is_set():
                queue.heartbeat()
                stopped.wait(2)

        thread = threading.Thread(target=heartbeat, daemon=True)
        thread.start()
        try:
            while True:
                job = queue.claim()
                if job is None:
                    if once:
                        return
                    time.sleep(0.3)
                    continue
                try:
                    result = check_snapshot(
                        executor, job, lambda phase: queue.progress(job["id"], phase)
                    )
                except RunnerError as exc:
                    logging.error("Docker runner failed: %s", exc)
                    queue.complete(
                        job["id"],
                        {
                            "verdict": "inconclusive",
                            "cases": [],
                            "error": {
                                "kind": "runner_error",
                                "message": (
                                    "Исполнитель временно недоступен. "
                                    "Повторите проверку после восстановления."
                                ),
                            },
                        },
                    )
                    raise
                queue.complete(job["id"], result)
                if once:
                    return
        finally:
            stopped.set()
            thread.join(timeout=3)
            queue.offline()


if __name__ == "__main__":
    import argparse
    import signal

    parser = argparse.ArgumentParser(description="Java Blueprints Docker worker")
    parser.add_argument("--once", action="store_true", help="Process at most one queued check")
    options = parser.parse_args()

    def stop(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    try:
        run_worker(Path(os.environ.get("BLUEPRINTS_DATA_DIR", ".data")), once=options.once)
    except KeyboardInterrupt:
        pass
