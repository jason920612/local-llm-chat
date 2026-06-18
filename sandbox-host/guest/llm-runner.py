#!/usr/bin/env python3
"""Guest job daemon for the microVM sandbox.

The VM is one long-lived session per conversation. Node submits work by creating
`/workspace/.run/jobs/<job-id>/request.json`; this daemon starts each request in
its own subprocess, streams logs into that job directory, and writes
`result.json` when it finishes. Multiple jobs may run concurrently inside the
same VM.
"""

import json
import base64
import math
import os
import random
import shutil
import subprocess
import sys
import threading
import time
import glob
from pathlib import Path

RUN = Path("/workspace/.run")
JOBS = RUN / "jobs"
WS = "/workspace"
POLL_SEC = 0.2
DEFAULT_IDLE_SEC = 30 * 60
COMPUTER = RUN / "computer"
DISPLAY = ":99"
BOOTSTRAP_LOCK = threading.Lock()
OCR_LOCK = threading.Lock()
BROWSER_LOCK = threading.Lock()

# OCR uses PP-OCRv6 (PaddleOCR 3.7.0), medium tier: beats PP-OCRv5_server while
# staying CPU-friendly (~1.4-2s/frame), covers 50 languages with one model (incl.
# zh/en/ja), strong on UI/digital-display text — so the model gets clickable
# element text + centre coordinates.
#
# The VM's system Python is 3.14 (Ubuntu 26.04), which has NO PaddlePaddle wheel.
# So PaddleOCR runs under a separate standalone CPython 3.12 baked into base.img
# (see sandbox-host/build/stage3f-ocr.sh), driven as a long-lived subprocess
# worker (sandbox-host/guest/ocr-worker.py) so the model loads once and stays warm.
PPOCR_PY = "/opt/python/bin/python3.12"
PPOCR_WORKER = "/ocr-worker.py"
PPOCR_WEIGHTS_HOME = "/root"  # PaddleOCR caches weights under $HOME/.paddlex
# Long-lived OCR worker process (lazily started, restarted if it dies).
_OCR_PROC = None


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


def run_cmd(cmd, timeout=30, env=None):
    try:
        p = subprocess.run(
            cmd,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            env=env,
        )
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired as ex:
        return 124, ex.stdout or "", ex.stderr or "timeout"
    except Exception as ex:  # noqa: BLE001
        return 1, "", str(ex)


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


def computer_env():
    env = build_env()
    env["DISPLAY"] = DISPLAY
    env["PLAYWRIGHT_BROWSERS_PATH"] = playwright_browsers_path()
    env["PLAYWRIGHT_HOST_PLATFORM_OVERRIDE"] = "ubuntu24.04-x64"
    return env


def playwright_browsers_path():
    for base in ["/root/.cache/ms-playwright", f"{WS}/.cache/ms-playwright"]:
        if glob.glob(base + "/chromium-*/chrome-linux*/chrome"):
            return base
    return f"{WS}/.cache/ms-playwright"


def chromium_executable():
    for base in ["/root/.cache/ms-playwright", f"{WS}/.cache/ms-playwright"]:
        matches = glob.glob(base + "/chromium-*/chrome-linux*/chrome")
        if matches:
            return matches[0]
    return None


def command_exists(name):
    return shutil.which(name) is not None


def computer_missing():
    required = ["Xvfb", "openbox", "xdotool", "scrot", "wmctrl", "xterm"]
    missing = [x for x in required if not command_exists(x)]
    return missing


def ocr_status():
    return read_json(COMPUTER / "ocr.json", {})


def ocr_available():
    """OCR needs the standalone py3.12 + PaddleOCR worker baked into base.img
    (stage3f-ocr.sh). It cannot be pip-installed at runtime because the VM's
    system Python 3.14 has no PaddlePaddle wheel."""
    return os.path.exists(PPOCR_PY) and os.path.exists(PPOCR_WORKER)


def browser_status():
    return read_json(COMPUTER / "browser.json", {})


def playwright_ready():
    try:
        import playwright.sync_api  # noqa: F401

        return True
    except Exception:  # noqa: BLE001
        return False


def install_browser(auto_install=True):
    COMPUTER.mkdir(parents=True, exist_ok=True)
    status_path = COMPUTER / "browser.json"
    if playwright_ready():
        status = read_json(status_path, {})
        if status.get("status") != "ready":
            write_json(status_path, {"status": "ready", "updatedAt": now_ms()})
        return None
    if not auto_install:
        write_json(
            status_path,
            {
                "status": "missing",
                "error": "python playwright is not installed",
                "updatedAt": now_ms(),
            },
        )
        return "python playwright is not installed"
    write_json(status_path, {"status": "installing", "startedAt": now_ms()})
    env = build_env()
    env["PLAYWRIGHT_BROWSERS_PATH"] = f"{WS}/.cache/ms-playwright"
    env["PLAYWRIGHT_HOST_PLATFORM_OVERRIDE"] = "ubuntu24.04-x64"
    rc1, _out1, err1 = run_cmd(
        [
            "python3",
            "-m",
            "pip",
            "install",
            "--user",
            "--break-system-packages",
            "playwright",
        ],
        timeout=600,
        env=env,
    )
    rc2, _out2, err2 = run_cmd(
        ["python3", "-m", "playwright", "install", "chromium"],
        timeout=900,
        env=env,
    )
    ok = rc1 == 0 and rc2 == 0 and playwright_ready()
    write_json(
        status_path,
        {
            "status": "ready" if ok else "failed",
            "pipCode": rc1,
            "installCode": rc2,
            "error": (err1 + "\n" + err2)[-4000:],
            "updatedAt": now_ms(),
        },
    )
    return None if ok else "failed to install Playwright Chromium"


def bootstrap_computer(auto_install=True, ocr=True):
    """Install the VM-side GUI/OCR stack once, then keep it on sys.img."""
    COMPUTER.mkdir(parents=True, exist_ok=True)
    status_path = COMPUTER / "bootstrap.json"
    with BOOTSTRAP_LOCK:
        missing = computer_missing()
        if not missing:
            status = read_json(status_path, {})
            if status.get("status") != "ready":
                write_json(
                    status_path,
                    {"status": "ready", "installedAt": now_ms(), "missing": []},
                )
            return []
        if not auto_install:
            write_json(
                status_path,
                {
                    "status": "missing",
                    "missing": missing,
                    "updatedAt": now_ms(),
                },
            )
            return missing

        write_json(
            status_path,
            {
                "status": "installing",
                "missing": missing,
                "startedAt": now_ms(),
            },
        )
        env = build_env()
        env["DEBIAN_FRONTEND"] = "noninteractive"
        packages = [
            "xvfb",
            "openbox",
            "xdotool",
            "scrot",
            "wmctrl",
            "python3-pil",
            "python3-pip",
            "fonts-noto-cjk",
            "fonts-noto-color-emoji",
            "chromium-browser",
            "xterm",
        ]
        rc1, out1, err1 = run_cmd(["apt-get", "update"], timeout=180, env=env)
        rc2, out2, err2 = run_cmd(
            [
                "apt-get",
                "install",
                "-y",
                "--no-install-recommends",
                *packages,
            ],
            timeout=600,
            env=env,
        )
        if ocr:
            # OCR is a prebaked standalone worker, not a runtime install. Just
            # record whether it's present so observe can warn cleanly if not.
            write_json(
                COMPUTER / "ocr.json",
                {
                    "status": "ready" if ocr_available() else "missing",
                    "engine": "PP-OCRv6_medium (py3.12 worker)",
                    "updatedAt": now_ms(),
                },
            )
        install_browser(auto_install=auto_install)
        missing_after = computer_missing()
        status = {
            "status": "ready" if not missing_after else "missing",
            "missing": missing_after,
            "apt": {"updateCode": rc1, "installCode": rc2},
            "ocr": ocr_status(),
            "browser": browser_status(),
            "updatedAt": now_ms(),
        }
        if rc1 != 0 or rc2 != 0:
            status["apt"]["error"] = (err1 + "\n" + err2)[-4000:]
            status["apt"]["stdout"] = (out1 + "\n" + out2)[-1000:]
        write_json(status_path, status)
        return missing_after


def proc_running(pattern):
    rc, out, _err = run_cmd(["pgrep", "-af", pattern], timeout=5)
    return rc == 0 and bool(out.strip())


def start_computer(width=1280, height=720, auto_install=True, ocr=True):
    missing = bootstrap_computer(auto_install=auto_install, ocr=ocr)
    if missing:
        return missing
    env = computer_env()
    log_path = COMPUTER / "apps.log"
    if not proc_running(r"Xvfb :99"):
        log = open(log_path, "ab", buffering=0)
        subprocess.Popen(
            [
                "Xvfb",
                DISPLAY,
                "-screen",
                "0",
                f"{int(width)}x{int(height)}x24",
                "-nolisten",
                "tcp",
            ],
            stdout=log,
            stderr=log,
            env=env,
        )
        time.sleep(0.5)
    if not proc_running("openbox"):
        log = open(log_path, "ab", buffering=0)
        subprocess.Popen(
            ["openbox"],
            stdout=log,
            stderr=log,
            env=env,
        )
        time.sleep(0.5)
    if not proc_running("remote-debugging-port=9222"):
        chrome = (
            shutil.which("chromium")
            or shutil.which("google-chrome")
            or shutil.which("google-chrome-stable")
        )
        if chrome:
            log = open(log_path, "ab", buffering=0)
            subprocess.Popen(
                [
                    chrome,
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                    "--remote-debugging-address=127.0.0.1",
                    "--remote-debugging-port=9222",
                    "--window-size=%d,%d" % (int(width), int(height)),
                    "about:blank",
                ],
                stdout=log,
                stderr=log,
                env=env,
            )
            time.sleep(1.0)
    if not proc_running("xterm"):
        xterm = shutil.which("xterm")
        if xterm:
            log = open(log_path, "ab", buffering=0)
            subprocess.Popen(
                [xterm, "-geometry", "100x30+80+80", "-title", "VM Terminal"],
                stdout=log,
                stderr=log,
                env=env,
            )
            time.sleep(0.5)
    return []


def screenshot_data_url(path, max_width=640, quality=55):
    try:
        from PIL import Image

        img = Image.open(path).convert("RGB")
        if img.width > max_width:
            h = max(1, int(img.height * (max_width / img.width)))
            img = img.resize((max_width, h))
        out = COMPUTER / "screen-small.jpg"
        img.save(out, format="JPEG", quality=int(quality), optimize=True)
        data = base64.b64encode(out.read_bytes()).decode("ascii")
        return "data:image/jpeg;base64," + data
    except Exception:  # noqa: BLE001
        return None


def read_screen_size(path):
    try:
        from PIL import Image

        img = Image.open(path)
        return {"width": int(img.width), "height": int(img.height)}
    except Exception:  # noqa: BLE001
        return None


def list_windows():
    env = computer_env()
    rc, out, _err = run_cmd(["wmctrl", "-lG"], timeout=5, env=env)
    windows = []
    if rc != 0:
        return windows
    for idx, line in enumerate(out.splitlines()):
        parts = line.split(None, 7)
        if len(parts) < 8:
            continue
        try:
            x, y, w, h = map(int, parts[2:6])
        except ValueError:
            continue
        windows.append(
            {
                "id": parts[0] or f"win_{idx + 1}",
                "title": parts[7],
                "bbox": [x, y, x + w, y + h],
            }
        )
    return windows


def wait_for_cdp(timeout=20.0):
    """Poll the Chromium DevTools endpoint until it accepts connections. On a cold
    first launch the 9222 listener isn't up immediately, so connect_over_cdp would
    hit ECONNREFUSED — wait for /json/version instead of a fixed sleep."""
    import urllib.request

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(
                "http://127.0.0.1:9222/json/version", timeout=2
            ) as r:
                if r.status == 200:
                    return True
        except Exception:  # noqa: BLE001
            time.sleep(0.3)
    return False


def ensure_browser(auto_install=True, width=1280, height=720):
    missing = start_computer(width, height, auto_install=auto_install, ocr=False)
    if missing:
        return None, f"missing computer dependencies: {', '.join(missing)}"
    err = install_browser(auto_install=auto_install)
    if err:
        return None, err
    exe = chromium_executable()
    if not exe:
        return None, "Playwright Chromium executable is missing"
    with BROWSER_LOCK:
        if not proc_running("remote-debugging-port=9222"):
            log = open(COMPUTER / "browser.log", "ab", buffering=0)
            env = computer_env()
            subprocess.Popen(
                [
                    exe,
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-gpu",
                    "--remote-debugging-address=127.0.0.1",
                    "--remote-debugging-port=9222",
                    "--window-size=%d,%d" % (int(width), int(height)),
                    "--user-data-dir=%s" % str(COMPUTER / "browser-profile"),
                    "about:blank",
                ],
                stdout=log,
                stderr=log,
                env=env,
            )
        # Wait for the DevTools endpoint to actually accept connections (cold
        # launch can take several seconds) instead of a fixed, racy sleep.
        if not wait_for_cdp(timeout=25.0):
            return None, "Chromium DevTools endpoint (127.0.0.1:9222) not ready"
    try:
        from playwright.sync_api import sync_playwright

        os.environ["PLAYWRIGHT_HOST_PLATFORM_OVERRIDE"] = "ubuntu24.04-x64"
        pw = sync_playwright().start()
        # Retry the CDP connect briefly: the listener may accept /json/version a
        # moment before it's ready for a full CDP handshake.
        last = None
        for _ in range(5):
            try:
                browser = pw.chromium.connect_over_cdp("http://127.0.0.1:9222")
                context = (
                    browser.contexts[0] if browser.contexts else browser.new_context()
                )
                page = context.pages[0] if context.pages else context.new_page()
                return {"pw": pw, "browser": browser, "page": page}, None
            except Exception as ex:  # noqa: BLE001
                last = ex
                time.sleep(1.0)
        try:
            pw.stop()
        except Exception:  # noqa: BLE001
            pass
        return None, str(last)
    except Exception as ex:  # noqa: BLE001
        return None, str(ex)


def close_browser_handle(handle):
    try:
        handle.get("pw").stop()
    except Exception:  # noqa: BLE001
        pass


def browser_elements(page, limit=200):
    script = """
    (limit) => {
      const out = [];
      const seen = new Set();
      const isVisible = (el) => {
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style && style.visibility !== 'hidden' && style.display !== 'none' &&
          rect.width > 2 && rect.height > 2 && rect.bottom >= 0 && rect.right >= 0 &&
          rect.top <= innerHeight && rect.left <= innerWidth;
      };
      const textOf = (el) => {
        const aria = el.getAttribute('aria-label') || el.getAttribute('title') || '';
        const val = 'value' in el ? (el.value || '') : '';
        const txt = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
        return (aria || val || txt || '').slice(0, 240);
      };
      const kindOf = (el) => {
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role') || '';
        if (tag === 'input' || tag === 'textarea' || el.isContentEditable) return 'input';
        if (tag === 'button' || role === 'button' || tag === 'select') return 'button';
        if (tag === 'a' || role === 'link') return 'button';
        if (tag === 'img' || tag === 'svg' || tag === 'canvas') return 'image';
        return 'text';
      };
      const selectorOf = (el) => {
        if (el.id) return '#' + CSS.escape(el.id);
        const testId = el.getAttribute('data-testid') || el.getAttribute('data-test');
        if (testId) return `[data-testid="${CSS.escape(testId)}"]`;
        const tag = el.tagName.toLowerCase();
        const name = el.getAttribute('name');
        if (name) return `${tag}[name="${CSS.escape(name)}"]`;
        return tag;
      };
      const candidates = Array.from(document.querySelectorAll(
        'a,button,input,textarea,select,[role],label,img,svg,canvas,[contenteditable],summary,h1,h2,h3,h4,p,span,div'
      ));
      for (const el of candidates) {
        if (out.length >= limit) break;
        if (!isVisible(el)) continue;
        const rect = el.getBoundingClientRect();
        const text = textOf(el);
        const kind = kindOf(el);
        if (!text && kind === 'text') continue;
        const key = `${Math.round(rect.left)}:${Math.round(rect.top)}:${Math.round(rect.width)}:${Math.round(rect.height)}:${text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const id = `dom_${out.length + 1}`;
        el.setAttribute('data-llm-element-id', id);
        out.push({
          id,
          kind,
          text,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || '',
          href: el.href || '',
          selector: selectorOf(el),
          bbox: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.right), Math.round(rect.bottom)],
          center: [Math.round(rect.left + rect.width / 2), Math.round(rect.top + rect.height / 2)],
          source: 'dom',
          confidence: 1
        });
      }
      return out;
    }
    """
    try:
        return page.evaluate(script, limit)
    except Exception as ex:  # noqa: BLE001
        return {"error": str(ex)}


def observe_browser(req):
    width = int(req.get("width") or 1280)
    height = int(req.get("height") or 720)
    auto_install = bool(req.get("autoInstall", True))
    include_screenshot = bool(req.get("includeScreenshot"))
    handle, err = ensure_browser(auto_install=auto_install, width=width, height=height)
    if err or handle is None:
        return {
            "ok": False,
            "browser": browser_status(),
            "windows": list_windows(),
            "elements": [],
            "error": err or "browser unavailable",
        }
    page = handle["page"]
    elements = browser_elements(page)
    warnings = []
    if isinstance(elements, dict) and elements.get("error"):
        warnings.append(f"DOM extraction failed: {elements.get('error')[-500:]}")
        elements = []
    shot_info = None
    if include_screenshot:
        shot = COMPUTER / f"browser-{now_ms()}.png"
        try:
            page.screenshot(path=str(shot), full_page=False)
            shot_info = {
                "path": str(shot).replace(WS + "/", ""),
                "dataUrl": screenshot_data_url(shot),
            }
        except Exception as ex:  # noqa: BLE001
            warnings.append(f"browser screenshot failed: {str(ex)[-500:]}")
    result = {
        "ok": True,
        "screen": {"width": width, "height": height},
        "url": page.url,
        "title": page.title(),
        "windows": list_windows(),
        "elements": elements[:200],
        "screenshot": shot_info,
        "warnings": warnings,
    }
    close_browser_handle(handle)
    return result


def browser_open_url(req):
    width = int(req.get("width") or 1280)
    height = int(req.get("height") or 720)
    handle, err = ensure_browser(
        auto_install=bool(req.get("autoInstall", True)),
        width=width,
        height=height,
    )
    if err or handle is None:
        return {"ok": False, "action": "browser_open_url", "error": err or "browser unavailable", "durationMs": 0}
    page = handle["page"]
    start = time.time()
    url = str(req.get("url") or "about:blank")
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=45000)
        result = {
            "ok": True,
            "action": "browser_open_url",
            "url": page.url,
            "title": page.title(),
            "durationMs": int((time.time() - start) * 1000),
        }
        close_browser_handle(handle)
        return result
    except Exception as ex:  # noqa: BLE001
        result = {
            "ok": False,
            "action": "browser_open_url",
            "url": page.url if page else url,
            "durationMs": int((time.time() - start) * 1000),
            "error": str(ex),
        }
        close_browser_handle(handle)
        return result


def browser_act(req):
    width = int(req.get("width") or 1280)
    height = int(req.get("height") or 720)
    handle, err = ensure_browser(
        auto_install=bool(req.get("autoInstall", True)),
        width=width,
        height=height,
    )
    action = str(req.get("action") or "")
    start = time.time()
    if err or handle is None:
        return {"ok": False, "action": action, "durationMs": 0, "error": err or "browser unavailable"}
    page = handle["page"]
    try:
        element_id = str(req.get("elementId") or "")
        if element_id:
            loc = page.locator(f'[data-llm-element-id="{element_id}"]')
        else:
            loc = None
        if action == "click_element":
            if loc is None:
                raise ValueError("click_element requires elementId")
            loc.click(timeout=10000)
        elif action == "type_element":
            if loc is None:
                raise ValueError("type_element requires elementId")
            text = str(req.get("text") or "")
            loc.fill(text, timeout=10000)
        elif action == "press":
            page.keyboard.press(str(req.get("key") or "Enter"))
        elif action == "scroll":
            amount = int(req.get("amount") or 600)
            page.mouse.wheel(0, amount)
        elif action == "wait_for_text":
            text = str(req.get("text") or "")
            page.get_by_text(text).wait_for(timeout=int(req.get("timeoutMs") or 10000))
        else:
            raise ValueError(f"unknown browser action: {action}")
        result = {
            "ok": True,
            "action": action,
            "url": page.url,
            "title": page.title(),
            "durationMs": int((time.time() - start) * 1000),
        }
        close_browser_handle(handle)
        return result
    except Exception as ex:  # noqa: BLE001
        result = {
            "ok": False,
            "action": action,
            "url": page.url,
            "durationMs": int((time.time() - start) * 1000),
            "error": str(ex),
        }
        close_browser_handle(handle)
        return result


def infer_kind(text):
    t = (text or "").strip().lower()
    if t in {"ok", "cancel", "send", "search", "submit", "login", "sign in"}:
        return "button"
    if t in {"username", "password", "email"}:
        return "input"
    return "text" if t else "unknown"


def _ocr_worker_proc():
    """Return a live OCR worker subprocess (py3.12 + PaddleOCR), starting it on
    first use and restarting it if it died. Caller must hold OCR_LOCK."""
    global _OCR_PROC
    if _OCR_PROC is not None and _OCR_PROC.poll() is None:
        return _OCR_PROC
    _OCR_PROC = None
    if not ocr_available():
        return None
    COMPUTER.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ)
    env["HOME"] = PPOCR_WEIGHTS_HOME  # PaddleOCR reads weights from $HOME/.paddlex
    env["PYTHONUNBUFFERED"] = "1"
    proc = subprocess.Popen(
        [PPOCR_PY, PPOCR_WORKER],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,  # worker redirects its own noise to a log file
        env=env,
        text=True,
        bufsize=1,
    )
    # The worker prints one readiness line once the model is loaded.
    ready = _ocr_read_line(proc, timeout=180)
    if not ready:
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass
        raise RuntimeError("OCR worker did not become ready (model load timeout)")
    info = json.loads(ready)
    if not info.get("ready"):
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass
        raise RuntimeError(f"OCR worker failed to load: {info.get('error')}")
    _OCR_PROC = proc
    return proc


def _ocr_read_line(proc, timeout):
    """Read one response line from the worker's stdout, with a wall-clock timeout
    so a hung predict can't block the daemon forever."""
    import select

    r, _, _ = select.select([proc.stdout], [], [], timeout)
    if not r:
        return None
    return proc.stdout.readline().strip()


def run_ppocr(path):
    """Run PP-OCRv6 (medium) on a screenshot via the standalone py3.12 worker.
    Returns (elements, error). The worker returns raw text items; we attach
    element kind/center here so it reuses the same heuristics as window elements."""
    if not ocr_available():
        return [], (
            "OCR engine not installed: bake the PP-OCRv6 worker into base.img "
            "with sandbox-host/build/stage3f-ocr.sh"
        )
    try:
        with OCR_LOCK:
            proc = _ocr_worker_proc()
            if proc is None:
                return [], "OCR worker unavailable"
            proc.stdin.write(str(path) + "\n")
            proc.stdin.flush()
            line = _ocr_read_line(proc, timeout=90)
        if not line:
            # Worker hung or died; drop it so the next call respawns cleanly.
            _reset_ocr_proc()
            return [], "OCR worker timed out"
        data = json.loads(line)
        if not data.get("ok"):
            return [], str(data.get("error", "OCR failed"))
        elements = []
        for idx, item in enumerate(data.get("items", []), start=1):
            text = str(item.get("text", "")).strip()
            box = item.get("bbox")
            if not text or not box or len(box) < 4:
                continue
            x1, y1, x2, y2 = int(box[0]), int(box[1]), int(box[2]), int(box[3])
            conf = item.get("score")
            elements.append(
                {
                    "id": f"ocr_{idx}",
                    "kind": infer_kind(text),
                    "text": text,
                    "bbox": [x1, y1, x2, y2],
                    "center": [int((x1 + x2) / 2), int((y1 + y2) / 2)],
                    "confidence": float(conf) if isinstance(conf, (int, float)) else None,
                    "source": "ocr",
                }
            )
        return elements, None
    except Exception as ex:  # noqa: BLE001
        _reset_ocr_proc()
        return [], str(ex)


def _reset_ocr_proc():
    global _OCR_PROC
    if _OCR_PROC is not None:
        try:
            _OCR_PROC.kill()
        except Exception:  # noqa: BLE001
            pass
    _OCR_PROC = None


def observe_computer(req):
    width = int(req.get("width") or 1280)
    height = int(req.get("height") or 720)
    include_screenshot = bool(req.get("includeScreenshot"))
    # OCR is opt-in: the model requests it (ocr=true) only when it needs on-screen
    # text + clickable element coordinates, since PP-OCRv6 medium adds ~1-2s/frame.
    use_ocr = bool(req.get("ocr", False))
    auto_install = bool(req.get("autoInstall", True))
    missing = start_computer(width, height, auto_install=auto_install, ocr=use_ocr)
    if missing:
        return {
            "ok": False,
            "display": DISPLAY,
            "windows": [],
            "elements": [],
            "missing": missing,
            "error": "computer use dependencies are missing and could not be installed",
        }

    shot = COMPUTER / f"screen-{now_ms()}.png"
    env = computer_env()
    rc, _out, err = run_cmd(["scrot", str(shot)], timeout=10, env=env)
    if rc != 0 or not shot.exists():
        return {
            "ok": False,
            "display": DISPLAY,
            "windows": list_windows(),
            "elements": [],
            "error": f"screenshot failed: {err[-500:]}",
        }
    windows = list_windows()
    elements = [
        {
            "id": f"win_{i + 1}",
            "kind": "unknown",
            "text": w.get("title", ""),
            "bbox": w["bbox"],
            "center": [
                int((w["bbox"][0] + w["bbox"][2]) / 2),
                int((w["bbox"][1] + w["bbox"][3]) / 2),
            ],
            "confidence": 1,
            "source": "window",
        }
        for i, w in enumerate(windows)
    ]
    warnings = []
    if use_ocr:
        ocr_elements, ocr_error = run_ppocr(shot)
        elements.extend(ocr_elements)
        if ocr_error:
            warnings.append(f"PP-OCR unavailable or failed: {ocr_error[-500:]}")
    return {
        "ok": True,
        "display": DISPLAY,
        "screen": read_screen_size(shot) or {"width": width, "height": height},
        "screenshot": {
            "path": str(shot).replace(WS + "/", ""),
            **(
                {"dataUrl": screenshot_data_url(shot)}
                if include_screenshot
                else {}
            ),
        },
        "windows": windows,
        "elements": elements[:200],
        "warnings": warnings,
    }


def mouse_position():
    rc, out, _err = run_cmd(["xdotool", "getmouselocation", "--shell"], timeout=3, env=computer_env())
    if rc != 0:
        return 0, 0
    vals = {}
    for line in out.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            vals[k] = v
    try:
        return int(vals.get("X", "0")), int(vals.get("Y", "0"))
    except ValueError:
        return 0, 0


def smooth_move(x, y):
    sx, sy = mouse_position()
    dx, dy = x - sx, y - sy
    dist = math.hypot(dx, dy)
    steps = max(8, min(90, int(dist / 12)))
    duration = max(0.18, min(1.2, dist / 900.0 + random.random() * 0.15))
    c1 = (sx + dx * 0.25 + random.uniform(-20, 20), sy + dy * 0.1 + random.uniform(-20, 20))
    c2 = (sx + dx * 0.75 + random.uniform(-20, 20), sy + dy * 0.9 + random.uniform(-20, 20))
    env = computer_env()
    for i in range(1, steps + 1):
        t = i / steps
        eased = 3 * t * t - 2 * t * t * t
        bx = (
            (1 - eased) ** 3 * sx
            + 3 * (1 - eased) ** 2 * eased * c1[0]
            + 3 * (1 - eased) * eased**2 * c2[0]
            + eased**3 * x
        )
        by = (
            (1 - eased) ** 3 * sy
            + 3 * (1 - eased) ** 2 * eased * c1[1]
            + 3 * (1 - eased) * eased**2 * c2[1]
            + eased**3 * y
        )
        run_cmd(["xdotool", "mousemove", str(int(bx)), str(int(by))], timeout=2, env=env)
        time.sleep(duration / steps)


def action_computer(req):
    start = time.time()
    missing = start_computer(
        int(req.get("width") or 1280),
        int(req.get("height") or 720),
        auto_install=bool(req.get("autoInstall", True)),
        ocr=False,
    )
    if missing:
        return {
            "ok": False,
            "action": str(req.get("action") or ""),
            "durationMs": int((time.time() - start) * 1000),
            "error": f"missing dependencies: {', '.join(missing)}",
        }
    action = str(req.get("action") or "")
    env = computer_env()
    try:
        if action in {"move_mouse", "left_click", "right_click"}:
            x = int(req.get("x"))
            y = int(req.get("y"))
            smooth_move(x, y)
            if action == "left_click":
                run_cmd(["xdotool", "click", "1"], timeout=5, env=env)
            elif action == "right_click":
                run_cmd(["xdotool", "click", "3"], timeout=5, env=env)
        elif action == "type_text":
            text = str(req.get("text") or "")
            run_cmd(["xdotool", "type", "--clearmodifiers", "--delay", "18", text], timeout=max(5, len(text) // 10), env=env)
        elif action == "key":
            key = str(req.get("key") or "")
            run_cmd(["xdotool", "key", "--clearmodifiers", key], timeout=5, env=env)
        elif action == "scroll":
            amount = int(req.get("amount") or 0)
            button = "5" if amount < 0 else "4"
            for _ in range(min(20, abs(amount))):
                run_cmd(["xdotool", "click", button], timeout=2, env=env)
        elif action == "wait":
            ms = max(0, min(10000, int(req.get("ms") or 1000)))
            time.sleep(ms / 1000)
        else:
            raise ValueError(f"unknown action: {action}")
        return {
            "ok": True,
            "action": action,
            "durationMs": int((time.time() - start) * 1000),
        }
    except Exception as ex:  # noqa: BLE001
        return {
            "ok": False,
            "action": action,
            "durationMs": int((time.time() - start) * 1000),
            "error": str(ex),
        }


# ===== Action sequence engine (computer + browser) ==========================
# Runs a model-authored action program in one VM round-trip: targeting by handle
# id / visible text / raw coords, rich verbs, recursive declarative condition
# gates (all/any/not/none/nand) for when/wait_for, on_fail recovery branches, and
# an execution-time observation. See docs/computer-use-action-plan.md.

_SEQ_POLL_SEC = 0.4
_SEQ_DEFAULT_TIMEOUT_MS = 8000
_LEAF_KINDS = ("text", "gone", "id_present", "id_gone", "clickable", "url_contains", "ms")


def _cond_leaves(cond):
    """Flatten a condition tree to a list of (label, leaf_dict)."""
    out = []
    if not isinstance(cond, dict):
        return out
    for gate in ("all", "any", "none", "nand"):
        if isinstance(cond.get(gate), list):
            for sub in cond[gate]:
                out.extend(_cond_leaves(sub))
            return out
    if isinstance(cond.get("not"), dict):
        return _cond_leaves(cond["not"])
    for kind in _LEAF_KINDS:
        if kind in cond:
            out.append((cond.get("label") or f"{kind}:{cond[kind]}", cond))
            break
    return out


def _cond_needs_text(cond):
    return any(
        any(k in leaf for k in ("text", "gone", "clickable"))
        for _lbl, leaf in _cond_leaves(cond)
    )


def _leaf_true(snap, leaf, t0):
    els = snap.get("elements", [])
    blob = (snap.get("text", "") or "").lower()

    def has_text(v):
        v = str(v).lower()
        return v in blob or any(v in str(e.get("text", "")).lower() for e in els)

    def has_id(v):
        return any(e.get("id") == v for e in els)

    if "text" in leaf:
        return has_text(leaf["text"])
    if "gone" in leaf:
        return not has_text(leaf["gone"]) and not has_id(leaf["gone"])
    if "id_present" in leaf:
        return has_id(leaf["id_present"])
    if "id_gone" in leaf:
        return not has_id(leaf["id_gone"])
    if "clickable" in leaf:
        v = leaf["clickable"]
        return has_id(v) or has_text(v)
    if "url_contains" in leaf:
        return str(leaf["url_contains"]).lower() in str(snap.get("url") or "").lower()
    if "ms" in leaf:
        return (time.time() - t0) * 1000 >= float(leaf["ms"])
    return False


def _eval_cond(snap, cond, t0):
    if not isinstance(cond, dict):
        return True
    if isinstance(cond.get("all"), list):
        return all(_eval_cond(snap, c, t0) for c in cond["all"])
    if isinstance(cond.get("any"), list):
        return any(_eval_cond(snap, c, t0) for c in cond["any"])
    if isinstance(cond.get("none"), list):
        return not any(_eval_cond(snap, c, t0) for c in cond["none"])
    if isinstance(cond.get("nand"), list):
        return not all(_eval_cond(snap, c, t0) for c in cond["nand"])
    if isinstance(cond.get("not"), dict):
        return not _eval_cond(snap, cond["not"], t0)
    return _leaf_true(snap, cond, t0)


def _snapshot_computer(width, height, need_text):
    env = computer_env()
    shot = COMPUTER / "seq-snap.png"
    run_cmd(["scrot", "-o", str(shot)], timeout=8, env=env)
    windows = list_windows()
    elements = [
        {
            "id": f"win_{i + 1}",
            "kind": "window",
            "text": w.get("title", ""),
            "bbox": w["bbox"],
            "center": [
                int((w["bbox"][0] + w["bbox"][2]) / 2),
                int((w["bbox"][1] + w["bbox"][3]) / 2),
            ],
            "source": "window",
        }
        for i, w in enumerate(windows)
    ]
    blob = " ".join(w.get("title", "") for w in windows)
    if need_text and shot.exists():
        ocr_els, _err = run_ppocr(shot)
        elements.extend(ocr_els)
        blob += " " + " ".join(str(e.get("text", "")) for e in ocr_els)
    return {"kind": "computer", "text": blob, "elements": elements, "url": None}


def _snapshot_browser(page):
    els = browser_elements(page)
    if isinstance(els, dict):
        els = []
    blob = " ".join(str(e.get("text", "")) for e in els)
    try:
        url = page.url
    except Exception:  # noqa: BLE001
        url = ""
    return {"kind": "browser", "text": blob, "elements": els, "url": url}


def _resolve_center(snap, want):
    if want.get("id"):
        for e in snap["elements"]:
            if e.get("id") == want["id"]:
                return e.get("center")
        return None
    if want.get("text"):
        v = str(want["text"]).strip().lower()
        for e in snap["elements"]:
            if str(e.get("text", "")).strip().lower() == v:
                return e.get("center")
        for e in snap["elements"]:
            if v and v in str(e.get("text", "")).lower():
                return e.get("center")
        return None
    if want.get("x") is not None and want.get("y") is not None:
        return [int(want["x"]), int(want["y"])]
    return None


def _exec_computer_step(step, snap):
    env = computer_env()
    action = step.get("action")
    mods = [str(m) for m in (step.get("modifiers") or [])]
    pointer = action in (
        "move", "left_click", "right_click", "middle_click", "double_click",
        "mouse_down", "mouse_up", "drag",
    )
    center = _resolve_center(snap, step) if (pointer or action == "scroll") else None
    if pointer and center is None and action != "mouse_up":
        raise ValueError("target not found (id/text/x,y)")

    def with_mods(fn):
        for m in mods:
            run_cmd(["xdotool", "keydown", m], timeout=2, env=env)
        try:
            fn()
        finally:
            for m in mods:
                run_cmd(["xdotool", "keyup", m], timeout=2, env=env)

    if action == "move":
        smooth_move(*center)
    elif action in ("left_click", "right_click", "middle_click", "double_click"):
        smooth_move(*center)
        btn = {"left_click": "1", "right_click": "3", "middle_click": "2", "double_click": "1"}[action]
        if action == "double_click":
            with_mods(lambda: run_cmd(["xdotool", "click", "--repeat", "2", "--delay", "120", btn], timeout=5, env=env))
        else:
            with_mods(lambda: run_cmd(["xdotool", "click", btn], timeout=5, env=env))
    elif action == "mouse_down":
        smooth_move(*center)
        run_cmd(["xdotool", "mousedown", "1"], timeout=3, env=env)
    elif action == "mouse_up":
        if center:
            smooth_move(*center)
        run_cmd(["xdotool", "mouseup", "1"], timeout=3, env=env)
    elif action == "drag":
        dest = _resolve_center(snap, {
            "id": step.get("to_id"), "text": step.get("to_text"),
            "x": step.get("to_x"), "y": step.get("to_y"),
        })
        if dest is None:
            raise ValueError("drag destination not found (to_id/to_text/to_x,to_y)")
        smooth_move(*center)
        run_cmd(["xdotool", "mousedown", "1"], timeout=3, env=env)
        smooth_move(*dest)
        run_cmd(["xdotool", "mouseup", "1"], timeout=3, env=env)
    elif action == "type_text":
        text = str(step.get("text") or "")
        run_cmd(["xdotool", "type", "--clearmodifiers", "--delay", "18", text], timeout=max(5, len(text) // 10), env=env)
    elif action == "key":
        run_cmd(["xdotool", "key", "--clearmodifiers", str(step.get("key") or "")], timeout=5, env=env)
    elif action == "key_down":
        run_cmd(["xdotool", "keydown", str(step.get("key") or "")], timeout=3, env=env)
    elif action == "key_up":
        run_cmd(["xdotool", "keyup", str(step.get("key") or "")], timeout=3, env=env)
    elif action == "scroll":
        if center:
            smooth_move(*center)
        amount = int(step.get("amount") or 0)
        button = "5" if amount < 0 else "4"
        for _ in range(min(30, abs(amount) or 3)):
            run_cmd(["xdotool", "click", button], timeout=2, env=env)
    elif action == "wait":
        pass
    else:
        raise ValueError(f"unknown action: {action}")


def _exec_browser_step(page, step, _snap):
    action = step.get("action")
    mods = [m.capitalize() for m in (step.get("modifiers") or [])]  # Control/Shift/Alt/Meta

    def locator():
        if step.get("id"):
            return page.locator(f'[data-llm-element-id="{step["id"]}"]').first
        if step.get("text"):
            return page.get_by_text(str(step["text"]), exact=False).first
        return None

    if action in ("left_click", "right_click", "middle_click", "double_click", "move", "mouse_down", "mouse_up"):
        loc = None if (step.get("x") is not None and not step.get("id") and not step.get("text")) else locator()
        if loc is None:
            x, y = int(step.get("x") or 0), int(step.get("y") or 0)
            page.mouse.move(x, y)
            if action == "double_click":
                page.mouse.dblclick(x, y)
            elif action == "left_click":
                page.mouse.click(x, y)
            elif action == "right_click":
                page.mouse.click(x, y, button="right")
            elif action == "middle_click":
                page.mouse.click(x, y, button="middle")
            elif action == "mouse_down":
                page.mouse.down()
            elif action == "mouse_up":
                page.mouse.up()
        else:
            kw = {"timeout": 10000}
            if mods:
                kw["modifiers"] = mods
            if action == "double_click":
                loc.dblclick(**kw)
            elif action == "left_click":
                loc.click(**kw)
            elif action == "right_click":
                loc.click(button="right", **kw)
            elif action == "middle_click":
                loc.click(button="middle", **kw)
            elif action == "move":
                loc.hover(timeout=10000)
            else:
                loc.scroll_into_view_if_needed(timeout=10000)
    elif action == "drag":
        loc = locator()
        if step.get("to_id"):
            dest = page.locator(f'[data-llm-element-id="{step["to_id"]}"]').first
        elif step.get("to_text"):
            dest = page.get_by_text(str(step["to_text"]), exact=False).first
        else:
            dest = None
        if loc is not None and dest is not None:
            loc.drag_to(dest, timeout=10000)
        elif step.get("to_x") is not None:
            box = loc.bounding_box() if loc is not None else None
            sx, sy = ((box["x"] + box["width"] / 2, box["y"] + box["height"] / 2) if box else (int(step.get("x") or 0), int(step.get("y") or 0)))
            page.mouse.move(sx, sy)
            page.mouse.down()
            page.mouse.move(int(step["to_x"]), int(step.get("to_y") or 0))
            page.mouse.up()
        else:
            raise ValueError("drag needs a destination (to_id/to_text/to_x,to_y)")
    elif action == "type_text":
        text = str(step.get("text") or "")
        if step.get("id"):
            page.locator(f'[data-llm-element-id="{step["id"]}"]').first.fill(text, timeout=10000)
        else:
            page.keyboard.type(text)
    elif action in ("key", "key_down", "key_up"):
        key = str(step.get("key") or "")
        if action == "key":
            page.keyboard.press(key)
        elif action == "key_down":
            page.keyboard.down(key)
        else:
            page.keyboard.up(key)
    elif action == "scroll":
        page.mouse.wheel(0, int(step.get("amount") or 600))
    elif action == "wait":
        pass
    else:
        raise ValueError(f"unknown browser action: {action}")


def _wait_for(get_snap, cond, timeout_ms):
    t0 = time.time()
    deadline = t0 + (timeout_ms or _SEQ_DEFAULT_TIMEOUT_MS) / 1000.0
    need_text = _cond_needs_text(cond)
    snap = get_snap(need_text)
    while True:
        if _eval_cond(snap, cond, t0):
            by = [lbl for lbl, leaf in _cond_leaves(cond) if _leaf_true(snap, leaf, t0)]
            return True, {"outcome": "matched", "by": by, "waited_ms": int((time.time() - t0) * 1000)}, snap
        if time.time() >= deadline:
            unmet = [lbl for lbl, leaf in _cond_leaves(cond) if not _leaf_true(snap, leaf, t0)]
            return False, {"outcome": "timeout", "unmet": unmet, "waited_ms": int((time.time() - t0) * 1000)}, snap
        time.sleep(_SEQ_POLL_SEC)
        snap = get_snap(need_text)


def _run_steps(ctx, steps):
    results = []
    stopped = False
    handled = False
    for i, step in enumerate(steps or []):
        r = {"i": i, "action": step.get("action")}
        if isinstance(step.get("when"), dict):
            snap = ctx["snap"](_cond_needs_text(step["when"]))
            if not _eval_cond(snap, step["when"], time.time()):
                r["skipped"] = True
                r["ok"] = True
                results.append(r)
                continue
        failed = False
        err = None
        if isinstance(step.get("wait_for"), dict):
            ok, wres, _snap = _wait_for(ctx["snap"], step["wait_for"], step.get("timeout_ms"))
            r["wait_result"] = wres
            r["waitedMs"] = wres.get("waited_ms")
            if not ok:
                failed = True
                err = f"wait_for timed out; unmet={wres.get('unmet')}"
        if not failed:
            try:
                snap = ctx["snap"](bool(step.get("id") or step.get("text")))
                ctx["exec"](step, snap)
            except Exception as ex:  # noqa: BLE001
                failed = True
                err = str(ex)
        if not failed and step.get("delay_ms"):
            time.sleep(min(10000, int(step["delay_ms"])) / 1000.0)
        if not failed:
            r["ok"] = True
            results.append(r)
            continue
        # failed → on_fail
        r["ok"] = False
        r["error"] = err
        onf = step.get("on_fail", "stop")
        if isinstance(onf, dict) and isinstance(onf.get("do"), list):
            fb_results, fb_stopped, _fb_handled = _run_steps(ctx, onf["do"])
            then = onf.get("then", "return")
            r["fallback"] = {"then": then, "steps": fb_results}
            results.append(r)
            recovered = not fb_stopped
            if recovered:
                handled = True
            if then == "continue" and recovered:
                continue
            stopped = True
            break
        if onf == "continue":
            results.append(r)
            continue
        results.append(r)
        stopped = True
        break
    return results, stopped, handled


def action_sequence(req, mode):
    start = time.time()
    steps = req.get("steps") or []
    include_screenshot = bool(req.get("includeScreenshot"))
    width = int(req.get("width") or 1280)
    height = int(req.get("height") or 720)
    auto_install = bool(req.get("autoInstall", True))

    if mode == "computer":
        missing = start_computer(width, height, auto_install=auto_install, ocr=False)
        if missing:
            return {"ok": False, "error": f"missing dependencies: {', '.join(missing)}", "steps": [], "observation": {}}
        ctx = {
            "snap": lambda need_text: _snapshot_computer(width, height, need_text),
            "exec": _exec_computer_step,
        }
        results, stopped, handled = _run_steps(ctx, steps)
        obs = observe_computer({
            "includeScreenshot": include_screenshot, "ocr": True,
            "width": width, "height": height, "autoInstall": False,
        })
        observation = {
            "screen": obs.get("screen"),
            "elements": obs.get("elements", []),
            "screenshot": obs.get("screenshot"),
        }
    else:
        handle, err = ensure_browser(auto_install=auto_install, width=width, height=height)
        if err or handle is None:
            return {"ok": False, "error": err or "browser unavailable", "steps": [], "observation": {}}
        page = handle["page"]
        ctx = {
            "snap": lambda _need_text: _snapshot_browser(page),
            "exec": lambda step, snap: _exec_browser_step(page, step, snap),
        }
        try:
            results, stopped, handled = _run_steps(ctx, steps)
            els = browser_elements(page)
            if isinstance(els, dict):
                els = []
            shot = None
            if include_screenshot:
                p = COMPUTER / f"browser-{now_ms()}.png"
                try:
                    page.screenshot(path=str(p), full_page=False)
                    shot = {"path": str(p).replace(WS + "/", ""), "dataUrl": screenshot_data_url(p)}
                except Exception:  # noqa: BLE001
                    pass
            try:
                title = page.title()
            except Exception:  # noqa: BLE001
                title = ""
            observation = {
                "url": page.url, "title": title,
                "screen": {"width": width, "height": height},
                "elements": els[:200], "screenshot": shot,
            }
        finally:
            close_browser_handle(handle)

    stopped_at = None
    if stopped:
        stopped_at = next((r["i"] for r in reversed(results) if not r.get("ok")), None)
    return {
        "ok": not stopped,
        "handled": handled,
        "stoppedAt": stopped_at,
        "durationMs": int((time.time() - start) * 1000),
        "steps": results,
        "observation": observation,
    }


def append(fp, chunk):
    fp.write(chunk)
    fp.flush()
    try:
        os.fsync(fp.fileno())
    except Exception:  # noqa: BLE001
        pass


def run_job(job_dir, req):
    job_id = req.get("id") or job_dir.name
    req_type = req.get("type") or "run_code"
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
            "type": req_type,
            "startedAt": now_ms(),
            "exitCode": None,
            "timedOut": False,
        },
    )

    if req_type in {
        "computer_observe",
        "computer_action",
        "browser_observe",
        "browser_open_url",
        "browser_action",
    }:
        try:
            if req_type == "computer_observe":
                data = observe_computer(req)
            elif req_type == "computer_action":
                data = (
                    action_sequence(req, "computer")
                    if isinstance(req.get("steps"), list)
                    else action_computer(req)
                )
            elif req_type == "browser_observe":
                data = observe_browser(req)
            elif req_type == "browser_open_url":
                data = browser_open_url(req)
            else:
                data = (
                    action_sequence(req, "browser")
                    if isinstance(req.get("steps"), list)
                    else browser_act(req)
                )
            status = "exited" if data.get("ok") else "error"
            result = {
                "stdout": json.dumps(data, ensure_ascii=False),
                "stderr": "",
                "exitCode": 0 if data.get("ok") else 1,
                "durationMs": int((time.time() - start) * 1000),
                "timedOut": False,
                "status": status,
            }
        except Exception as ex:  # noqa: BLE001
            result = {
                "stdout": "",
                "stderr": f"{req_type} error: {ex}",
                "exitCode": 1,
                "durationMs": int((time.time() - start) * 1000),
                "timedOut": False,
                "status": "error",
            }
        ended = now_ms()
        write_json(result_path, result)
        write_json(
            status_path,
            {
                **result,
                "id": job_id,
                "type": req_type,
                "startedAt": int(start * 1000),
                "endedAt": ended,
            },
        )
        return

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


def capture_stream_frame(width, height):
    """Grab the VM screen and write a downscaled JPEG for the live VM Console.
    Uses a dedicated file so it never races observe's screen-small.jpg."""
    env = computer_env()
    full = COMPUTER / "stream-full.png"
    rc, _out, _err = run_cmd(["scrot", "-o", str(full)], timeout=8, env=env)
    if rc != 0 or not full.exists():
        return False
    try:
        from PIL import Image

        img = Image.open(full).convert("RGB")
        max_w = 960
        if img.width > max_w:
            h = max(1, int(img.height * (max_w / img.width)))
            img = img.resize((max_w, h))
        tmp = COMPUTER / "screen-stream.tmp.jpg"
        final = COMPUTER / "screen-stream.jpg"
        img.save(tmp, format="JPEG", quality=60, optimize=True)
        os.replace(tmp, final)
        return True
    except Exception:  # noqa: BLE001
        return False


def screen_stream_loop(computer_cfg):
    """Live VM Console capture loop. Captures ~2-3 fps ONLY while the server keeps
    `.run/computer/stream.on` fresh (a heartbeat it refreshes per SSE subscriber);
    when nobody is watching it idles so it never burns VM CPU. Brings the desktop
    up on first demand so opening the console auto-starts the screen."""
    flag = COMPUTER / "stream.on"
    auto = bool(computer_cfg.get("autoInstall", True))
    width = int(computer_cfg.get("width") or 1280)
    height = int(computer_cfg.get("height") or 720)
    booted = False
    while True:
        try:
            fresh = flag.exists() and (time.time() - flag.stat().st_mtime) < 6
        except Exception:  # noqa: BLE001
            fresh = False
        if not fresh:
            booted = False
            time.sleep(0.5)
            continue
        try:
            if not booted:
                # Ensure Xvfb/openbox/Chromium/xterm are up (no OCR needed).
                start_computer(width, height, auto_install=auto, ocr=False)
                booted = True
            capture_stream_frame(width, height)
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.35)


def daemon():
    RUN.mkdir(parents=True, exist_ok=True)
    JOBS.mkdir(parents=True, exist_ok=True)
    session = read_json(RUN / "session.json", {})
    idle_sec = int(session.get("idleSeconds") or DEFAULT_IDLE_SEC)
    write_json(
        RUN / "daemon.json",
        {"status": "running", "pid": os.getpid(), "startedAt": now_ms()},
    )
    computer_cfg = session.get("computer") if isinstance(session.get("computer"), dict) else {}
    if computer_cfg.get("enabled", True):
        threading.Thread(
            target=bootstrap_computer,
            kwargs={
                "auto_install": bool(computer_cfg.get("autoInstall", True)),
                "ocr": bool(computer_cfg.get("ocr", True)),
            },
            daemon=True,
        ).start()
        # Live VM Console capture loop (idle until the server requests frames).
        threading.Thread(
            target=screen_stream_loop,
            args=(computer_cfg,),
            daemon=True,
        ).start()

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
