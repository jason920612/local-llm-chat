#!/usr/bin/env python3
"""Guest runner: read /workspace/.run/in.json, execute, write /workspace/.run/out.json.

Runs as the VM's payload. A per-workspace venv (/workspace/.venv) persists pip
installs across runs (the workspace is a persistent virtio-fs share). For both
python and bash, the venv's bin is on PATH so `pip`/`python` hit the venv.
"""
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

RUN = Path("/workspace/.run")
WS = "/workspace"


def read_in():
    try:
        return json.loads((RUN / "in.json").read_text())
    except Exception as e:  # noqa: BLE001
        return {"language": "bash", "code": f"echo bad in.json: {e} >&2; exit 2"}


def drop_privileges():
    """Run user code as uid/gid 1000 so workspace files are owned by the WSL
    user (jason) on the host — keeps file ops/cleanup working and runs the
    payload non-root inside the VM. Network/mounts were set up by init as root."""
    try:
        os.setgroups([])
    except Exception:  # noqa: BLE001
        pass
    try:
        os.setgid(1000)
        os.setuid(1000)
    except Exception:  # noqa: BLE001
        pass


def build_env():
    """Persistent pip without a venv: HOME on the workspace means `pip --user`
    installs land in /workspace/.local (kept across runs on the virtio-fs share)
    and Python auto-adds that user-site to sys.path. --break-system-packages
    sidesteps PEP 668 (safe — this is a throwaway isolated VM)."""
    env = dict(os.environ)
    env["HOME"] = WS
    env["PYTHONUNBUFFERED"] = "1"
    env["PIP_USER"] = "1"
    env["PIP_BREAK_SYSTEM_PACKAGES"] = "1"
    env["PIP_DISABLE_PIP_VERSION_CHECK"] = "1"
    # init (PID 1) hands us little/no PATH, so set a deterministic one that
    # includes the persistent user-script dir plus the standard system paths.
    env["PATH"] = f"{WS}/.local/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
    return env


def run_capped(cmd, env, timeout_s, cap):
    """Run cmd, streaming stdout/stderr but keeping at most ~cap bytes of each.
    Once a stream exceeds the cap the process is killed, so unbounded producers
    (e.g. `yes`) can't exhaust the VM's RAM. Returns (out, err, rc, timed_out, start)."""
    start = time.time()
    try:
        p = subprocess.Popen(
            cmd, cwd=WS, env=env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
    except Exception as ex:  # noqa: BLE001
        return "", f"runner error: {ex}", None, False, start

    bufs = {"out": [], "err": []}
    counts = {"out": 0, "err": 0}
    state = {"killed": False}
    lock = threading.Lock()
    limit = max(1, cap)

    def reader(stream, key):
        try:
            while True:
                chunk = stream.read(65536)
                if not chunk:
                    break
                with lock:
                    if counts[key] < limit:
                        bufs[key].append(chunk)
                        counts[key] += len(chunk)
                    elif not state["killed"]:
                        state["killed"] = True
                        try:
                            p.kill()
                        except Exception:  # noqa: BLE001
                            pass
        except Exception:  # noqa: BLE001
            pass

    t1 = threading.Thread(target=reader, args=(p.stdout, "out"), daemon=True)
    t2 = threading.Thread(target=reader, args=(p.stderr, "err"), daemon=True)
    t1.start()
    t2.start()

    timed_out = False
    try:
        rc = p.wait(timeout=timeout_s)
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            p.kill()
        except Exception:  # noqa: BLE001
            pass
        rc = None
    t1.join(2)
    t2.join(2)

    out = b"".join(bufs["out"]).decode("utf-8", "replace")
    err = b"".join(bufs["err"]).decode("utf-8", "replace")
    if state["killed"]:
        err += f"\n[output exceeded {cap} chars — process killed]"
    if timed_out:
        err += f"\n[timed out after {int(timeout_s*1000)} ms]"
    return out, err, rc, timed_out, start


def main():
    inp = read_in()
    # Payload runs as root inside the VM (full root in an isolated guest kernel).
    # virtiofsd's uid/gid translation maps guest root -> host user, so files in
    # /workspace are still owned by the host user. (drop_privileges() kept for
    # opt-out but intentionally NOT called.)
    lang = "bash" if inp.get("language") == "bash" else "python"
    code = inp.get("code", "")
    timeout_s = max(1, int(inp.get("timeoutMs", 30000)) / 1000.0)
    cap = int(inp.get("maxOutputChars", 20000))

    env = build_env()
    cmd = ["python3", "-c", code] if lang == "python" else ["bash", "-c", code]

    out, err, rc, timed_out, start = run_capped(cmd, env, timeout_s, cap)

    res = {
        "stdout": out[:cap],
        "stderr": err[:cap],
        "exitCode": rc,
        "durationMs": int((time.time() - start) * 1000),
        "timedOut": timed_out,
    }
    tmp = RUN / "out.json.tmp"
    tmp.write_text(json.dumps(res))
    os.replace(tmp, RUN / "out.json")


if __name__ == "__main__":
    try:
        main()
    except Exception as ex:  # noqa: BLE001
        try:
            (RUN / "out.json").write_text(
                json.dumps(
                    {
                        "stdout": "",
                        "stderr": f"runner fatal: {ex}",
                        "exitCode": None,
                        "durationMs": 0,
                        "timedOut": False,
                    }
                )
            )
        except Exception:  # noqa: BLE001
            pass
        sys.exit(1)
