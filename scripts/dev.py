"""Run the API and frontend together; Ctrl+C stops both process groups."""

import os
import signal
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    commands = [
        [
            str(ROOT / ".venv/bin/uvicorn"),
            "backend.app:create_app",
            "--factory",
            "--host",
            "127.0.0.1",
            "--port",
            "8000",
        ],
        ["npm", "run", "dev", "--", "--port", "5173", "--strictPort"],
    ]
    processes = []
    try:
        for command in commands:
            processes.append(subprocess.Popen(command, cwd=ROOT, start_new_session=True))
        print(
            "\nJava Blueprints: http://127.0.0.1:5173\nAPI: http://127.0.0.1:8000/docs\n",
            flush=True,
        )
        while all(process.poll() is None for process in processes):
            time.sleep(0.3)
    except KeyboardInterrupt:
        pass
    finally:
        for process in processes:
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
        for process in processes:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()


if __name__ == "__main__":
    main()
