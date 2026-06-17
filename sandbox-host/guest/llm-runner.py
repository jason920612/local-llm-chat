#!/usr/bin/env python3
"""Guest job daemon for the microVM sandbox.

The VM is one long-lived session per conversation. Node submits work by creating
`/workspace/.run/jobs/<job-id>/request.json`; this daemon starts each request in
its own subprocess, streams logs into that job directory, and writes
`result.json` when it finishes. Multiple jobs may run concurrently inside the
same VM.
"""

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

RUN = Path("/workspace/.run")
JOBS = RUN / "jobs"
WS = "/workspace"
POLL_SEC = 0.2
DEFAULT_IDLE_SEC = 30 * 60


def now_ms():
    return int(time.time() * 1000)


def read_json(path, fallback):
    try:
        return json.loads(path.read_text())
    except Exception:  # noqa: BLE001
        return fallback


def write_json(path, obj):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj))
    os.replace(tmp, path)


def build_env():
    """Persistent pip without a venv: HOME on the workspace means `pip --user`
    installs land in /workspace/.local (kept across runs on the virtio-fs share)
    and Python auto-adds that user-site to sys.path."""
    env = dict(os.environ)
    env["HOME"] = WS
    env["PYTHONUNBUFFERED"] = "1"
    env["PIP_USER"] = "1"
    env["PIP_BREAK_SYSTEM_PACKAGES"] = "1"
    env["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
    env["PATH"] = f"{WS}/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    return env


def append(fp, chunk):
    fp.write(chunk)
    fp.flush()
    try:
        os.fsync(fp.fileno())
    except Exception:  # noqa: BLE001
        pass


def run_job(job_dir, req):
    job_id = req.get("id") or job_dir.name
    lang = "bash" if req.get("language") == "bash" else "python"
    code = req.get("code", "")
    timeout_s = max(1, int(req.get("timeoutMs", 30000)) / 1000.0)
    cap = max(1, int(req.get("maxOutputChars", 20000)))
    cmd = ["python3", "-c", code] if lang == "python" else ["bash", "-c", code]
    start = time.time()
    status_path = job_dir / "status.json"
    result_path = job_dir / "result.json"
    stdout_path = job_dir / "stdout.log"
    stderr_path = job_dir / "stderr.log"
    live_path = job_dir / "live.log"
    kill_path = job_dir / "kill"

    write_json(
        status_path,
        {
            "id": job_id,
            "status": "running",
            "startedAt": now_ms(),
            "exitCode": None,
            "timedOut": False,
        },
    )

    try:
        p = subprocess.Popen(
            cmd,
            cwd=WS,
            env=build_env(),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
    except Exception as ex:  # noqa: BLE001
        ended = now_ms()
        result = {
            "stdout": "",
            "stderr": f"runner error: {ex}",
            "exitCode": None,
            "durationMs": int((time.time() - start) * 1000),
            "timedOut": False,
            "status": "error",
        }
        write_json(result_path, result)
        write_json(
            status_path,
            {**result, "id": job_id, "startedAt": int(start * 1000), "endedAt": ended},
        )
        return

    bufs = {"stdout": [], "stderr": []}
    counts = {"stdout": 0, "stderr": 0}
    state = {"killed": False, "timedOut": False}
    lock = threading.Lock()

    live_fp = open(live_path, "wb", buffering=0)
    out_fp = open(stdout_path, "wb", buffering=0)
    err_fp = open(stderr_path, "wb", buffering=0)

    def reader(stream, key, fp):
        try:
            while True:
                # BufferedReader.read(size) can wait for `size` bytes or EOF,
                # which hides small live writes from long-running jobs.
                chunk = os.read(stream.fileno(), 65536)
                if not chunk:
                    break
                with lock:
                    append(fp, chunk)
                    append(live_fp, chunk)
                    if counts[key] < cap:
                        take = chunk[: cap - counts[key]]
                        bufs[key].append(take)
                        counts[key] += len(take)
                    elif not state["killed"]:
                        state["killed"] = True
                        try:
                            p.kill()
                        except Exception:  # noqa: BLE001
                            pass
        except Exception:  # noqa: BLE001
            pass

    t1 = threading.Thread(target=reader, args=(p.stdout, "stdout", out_fp), daemon=True)
    t2 = threading.Thread(target=reader, args=(p.stderr, "stderr", err_fp), daemon=True)
    t1.start()
    t2.start()

    rc = None
    deadline = time.time() + timeout_s
    try:
        while True:
            rc = p.poll()
            if rc is not None:
                break
            if kill_path.exists():
                state["killed"] = True
                try:
                    p.kill()
                except Exception:  # noqa: BLE001
                    pass
                rc = p.wait(timeout=5)
                break
            if time.time() >= deadline:
                state["timedOut"] = True
                try:
                    p.kill()
                except Exception:  # noqa: BLE001
                    pass
                rc = p.wait(timeout=5)
                break
            time.sleep(0.1)
    except subprocess.TimeoutExpired:
        rc = None

    t1.join(2)
    t2.join(2)
    for fp in (out_fp, err_fp, live_fp):
        try:
            fp.close()
        except Exception:  # noqa: BLE001
            pass

    stdout = b"".join(bufs["stdout"]).decode("utf-8", "replace")
    stderr = b"".join(bufs["stderr"]).decode("utf-8", "replace")
    if state["killed"] and kill_path.exists():
        stderr += "\n[killed]"
        status = "killed"
    elif state["timedOut"]:
        stderr += f"\n[timed out after {int(timeout_s * 1000)} ms]"
        status = "timeout"
    elif state["killed"]:
        stderr += f"\n[output exceeded {cap} chars - process killed]"
        status = "error"
    else:
        status = "exited"

    result = {
        "stdout": stdout[:cap],
        "stderr": stderr[:cap],
        "exitCode": rc,
        "durationMs": int((time.time() - start) * 1000),
        "timedOut": state["timedOut"],
        "status": status,
    }
    ended = now_ms()
    write_json(result_path, result)
    write_json(
        status_path,
        {
            **result,
            "id": job_id,
            "startedAt": int(start * 1000),
            "endedAt": ended,
        },
    )


def daemon():
    RUN.mkdir(parents=True, exist_ok=True)
    JOBS.mkdir(parents=True, exist_ok=True)
    session = read_json(RUN / "session.json", {})
    idle_sec = int(session.get("idleSeconds") or DEFAULT_IDLE_SEC)
    write_json(
        RUN / "daemon.json",
        {"status": "running", "pid": os.getpid(), "startedAt": now_ms()},
    )

    active = {}
    launched = set()
    last_work = time.time()

    while True:
        for job_dir in sorted(JOBS.iterdir() if JOBS.exists() else []):
            if not job_dir.is_dir() or job_dir.name in launched:
                continue
            if (job_dir / "result.json").exists():
                launched.add(job_dir.name)
                continue
            req_path = job_dir / "request.json"
            if not req_path.exists():
                continue
            req = read_json(req_path, None)
            if not isinstance(req, dict):
                continue
            launched.add(job_dir.name)
            last_work = time.time()
            t = threading.Thread(target=run_job, args=(job_dir, req), daemon=True)
            active[job_dir.name] = t
            t.start()

        for job_id, t in list(active.items()):
            if not t.is_alive():
                del active[job_id]
                last_work = time.time()

        if not active and time.time() - last_work > idle_sec:
            write_json(
                RUN / "daemon.json",
                {
                    "status": "idle-exit",
                    "pid": os.getpid(),
                    "endedAt": now_ms(),
                },
            )
            return

        time.sleep(POLL_SEC)


if __name__ == "__main__":
    try:
        daemon()
    except Exception as ex:  # noqa: BLE001
        try:
            write_json(
                RUN / "daemon.json",
                {"status": "fatal", "error": str(ex), "endedAt": now_ms()},
            )
        except Exception:  # noqa: BLE001
            pass
        sys.exit(1)
