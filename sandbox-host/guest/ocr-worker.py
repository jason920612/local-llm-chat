#!/opt/python/bin/python3.12
"""Standalone PP-OCRv6 (medium) worker for the microVM.

The VM's system Python is 3.14 (no PaddlePaddle wheel), so PaddleOCR runs here
under a separate standalone CPython 3.12 baked into base.img. The guest daemon
(llm-runner.py) starts this once and keeps it warm, talking to it over pipes:

  daemon -> worker (stdin):  one image path per line
  worker -> daemon (stdout): one JSON line per request

Protocol (newline-delimited JSON on the worker's ORIGINAL stdout):
  on start:   {"ready": true}  (or {"ready": false, "error": ...} then exit)
  per image:  {"ok": true, "items": [{"text","bbox":[x1,y1,x2,y2],"score"}]}
              {"ok": false, "error": "..."}

PaddleOCR / Paddle print a lot of noise to stdout/stderr, which would corrupt the
protocol, so we dup the real stdout to a private fd for responses and redirect
fd 1/2 to a log file before importing anything heavy.
"""
import json
import os
import sys

# --- private response channel; quarantine library noise to a log -------------
_RESP_FD = os.dup(1)
try:
    _log = open("/workspace/.run/computer/ocr-worker.log", "ab", buffering=0)
    os.dup2(_log.fileno(), 1)
    os.dup2(_log.fileno(), 2)
except Exception:  # noqa: BLE001
    pass


def respond(obj):
    os.write(_RESP_FD, (json.dumps(obj) + "\n").encode("utf-8"))


def _as_list(val):
    """Coerce a PaddleOCR field (maybe numpy) to a plain list."""
    if val is None:
        return []
    if hasattr(val, "tolist"):
        try:
            val = val.tolist()
        except Exception:  # noqa: BLE001
            pass
    try:
        return list(val)
    except Exception:  # noqa: BLE001
        return []


def res_dict(res):
    """PaddleOCR 3.7 OCRResult stores fields under .json["res"] (and is also a
    dict with a top-level "res" key). Return that inner dict of fields."""
    j = getattr(res, "json", None)
    if isinstance(j, dict) and isinstance(j.get("res"), dict):
        return j["res"]
    try:
        inner = res["res"]
        if isinstance(inner, dict):
            return inner
    except Exception:  # noqa: BLE001
        pass
    return res if isinstance(res, dict) else {}


def field(d, name):
    return _as_list(d.get(name) if isinstance(d, dict) else None)


def main():
    os.environ.setdefault("HOME", "/root")  # weights baked under /root/.paddlex
    try:
        from paddleocr import PaddleOCR

        engine = PaddleOCR(
            ocr_version="PP-OCRv6",
            text_detection_model_name="PP-OCRv6_medium_det",
            text_recognition_model_name="PP-OCRv6_medium_rec",
            use_doc_orientation_classify=False,
            use_doc_unwarping=False,
            use_textline_orientation=False,
            # paddle 3.3.1's oneDNN/PIR CPU path crashes on PP-OCRv6
            # (ConvertPirAttribute2RuntimeAttribute); plain CPU kernels work.
            enable_mkldnn=False,
        )
    except Exception as ex:  # noqa: BLE001
        respond({"ready": False, "error": repr(ex)})
        return 1

    respond({"ready": True})

    for line in sys.stdin:
        path = line.strip()
        if not path:
            continue
        try:
            result = engine.predict(path)
            items = []
            for res in result or []:
                d = res_dict(res)
                texts = field(d, "rec_texts")
                scores = field(d, "rec_scores")
                boxes = field(d, "rec_boxes")  # n x [x1, y1, x2, y2]
                polys = field(d, "rec_polys")  # n x 4 x 2 (fallback)
                for i, text in enumerate(texts):
                    text = str(text or "").strip()
                    if not text:
                        continue
                    bbox = None
                    if i < len(boxes) and boxes[i] is not None and len(boxes[i]) >= 4:
                        b = boxes[i]
                        bbox = [int(b[0]), int(b[1]), int(b[2]), int(b[3])]
                    elif i < len(polys) and polys[i]:
                        xs = [float(p[0]) for p in polys[i] if len(p) >= 2]
                        ys = [float(p[1]) for p in polys[i] if len(p) >= 2]
                        if xs and ys:
                            bbox = [
                                int(min(xs)),
                                int(min(ys)),
                                int(max(xs)),
                                int(max(ys)),
                            ]
                    if not bbox:
                        continue
                    score = scores[i] if i < len(scores) else None
                    items.append(
                        {
                            "text": text,
                            "bbox": bbox,
                            "score": float(score)
                            if isinstance(score, (int, float))
                            else None,
                        }
                    )
            respond({"ok": True, "items": items})
        except Exception as ex:  # noqa: BLE001
            respond({"ok": False, "error": repr(ex)})
    return 0


if __name__ == "__main__":
    sys.exit(main())
