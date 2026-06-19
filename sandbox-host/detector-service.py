#!/usr/bin/env python3
"""Host-side GPU UI-detector service (WSL2).

Loads the OmniParser YOLO interactable-region detector + Florence-2-large caption
model ONCE on CUDA (the RTX 4060 via WSL /dev/dxg) and serves every conversation
microVM. The VM has no GPU, so it writes a detect request onto the shared
virtio-fs workspace and this host process answers it.

Transport (file-based over the shared workspace):
  request : /srv/llm-sandboxes/<conv>/ws/.run/detect/req-<id>.json
            { "image": "<ws-relative png>", "caption": true, "conf": 0.05, "max": 120 }
  response: /srv/llm-sandboxes/<conv>/ws/.run/detect/res-<id>.json
            { "ok": true, "w":W, "h":H,
              "elements": [ { "bbox":[x1,y1,x2,y2], "center":[cx,cy], "caption":"", "score":0.0 } ] }

Idle-exits after --idle seconds with no requests, freeing VRAM. Single instance
guarded by a flock. See docs/computer-use-v3-grounding-plan.md.
"""
import argparse
import fcntl
import glob
import json
import os
import sys
import time
import traceback

DET = os.path.expanduser("~/llm-sandbox/detector")
WEIGHTS = os.path.join(DET, "weights")
SANDBOX_ROOT = os.environ.get("LLM_SANDBOX_ROOT", "/srv/llm-sandboxes")
YOLO_PATH = os.path.join(WEIGHTS, "icon_detect", "model.pt")
FLORENCE_PATH = os.path.join(WEIGHTS, "florence2-large")

_yolo = None
_flo_model = None
_flo_proc = None
_device = "cuda"
_dtype = None


def log(*a):
    print("[detector]", *a, file=sys.stderr, flush=True)


def load_models(want_caption=True):
    global _yolo, _flo_model, _flo_proc, _dtype
    import torch
    from ultralytics import YOLO

    _dtype = torch.float16 if torch.cuda.is_available() else torch.float32
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    globals()["_device"] = dev
    log("device", dev, "dtype", _dtype)
    _yolo = YOLO(YOLO_PATH)
    if want_caption:
        from transformers import AutoModelForCausalLM, AutoProcessor

        _flo_model = AutoModelForCausalLM.from_pretrained(
            FLORENCE_PATH,
            torch_dtype=_dtype,
            trust_remote_code=True,
            attn_implementation="sdpa",
        ).to(dev)
        _flo_model.eval()
        _flo_proc = AutoProcessor.from_pretrained(
            FLORENCE_PATH, trust_remote_code=True
        )
    log("models loaded")


def _iou(a, b):
    ix1, iy1 = max(a[0], b[0]), max(a[1], b[1])
    ix2, iy2 = min(a[2], b[2]), min(a[3], b[3])
    iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
    inter = iw * ih
    if inter == 0:
        return 0.0
    aa = max(0, a[2] - a[0]) * max(0, a[3] - a[1])
    bb = max(0, b[2] - b[0]) * max(0, b[3] - b[1])
    return inter / float(aa + bb - inter + 1e-6)


def _opencv_small_boxes(image_path, existing, min_px=8, max_px=72, cap=60):
    """Cheap contour-based proposals for tiny text-less icons YOLO may miss
    (e.g. an upvote triangle). Bounded + filtered to icon-like shapes; the model
    can ignore irrelevant marks."""
    try:
        import cv2
        import numpy as np

        img = cv2.imread(image_path)
        if img is None:
            return []
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        edges = cv2.Canny(gray, 60, 160)
        edges = cv2.dilate(edges, np.ones((2, 2), np.uint8))
        cnts, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        out = []
        for c in cnts:
            x, y, w, h = cv2.boundingRect(c)
            if not (min_px <= w <= max_px and min_px <= h <= max_px):
                continue
            if not (0.4 <= (w / max(1, h)) <= 2.5):
                continue
            box = [int(x), int(y), int(x + w), int(y + h)]
            if any(_iou(box, e["bbox"]) > 0.3 for e in existing):
                continue
            if any(_iou(box, o["bbox"]) > 0.5 for o in out):
                continue
            out.append({"bbox": box, "center": [int(x + w / 2), int(y + h / 2)], "score": 0.0, "source": "opencv"})
            if len(out) >= cap:
                break
        return out
    except Exception:  # noqa: BLE001
        return []


def detect(image_path, conf, max_boxes, imgsz=1280, use_opencv=True):
    res = _yolo.predict(source=image_path, conf=conf, iou=0.1, imgsz=imgsz, verbose=False)
    r = res[0]
    xyxy = r.boxes.xyxy.cpu().numpy()
    confs = r.boxes.conf.cpu().numpy()
    out = []
    for (x1, y1, x2, y2), c in zip(xyxy, confs):
        out.append(
            {
                "bbox": [int(x1), int(y1), int(x2), int(y2)],
                "center": [int((x1 + x2) / 2), int((y1 + y2) / 2)],
                "score": float(c),
                "source": "detector",
            }
        )
    out.sort(key=lambda e: e["score"], reverse=True)
    out = out[:max_boxes]
    if use_opencv:
        out.extend(_opencv_small_boxes(image_path, out))
    return out


def caption(crops):
    """Batch-caption a list of PIL crops with Florence-2 (<CAPTION>)."""
    import torch

    if not crops or _flo_model is None:
        return ["" for _ in crops]
    prompt = "<CAPTION>"
    texts = []
    # Chunk to bound peak VRAM.
    CH = 16
    for i in range(0, len(crops), CH):
        batch = crops[i : i + CH]
        inputs = _flo_proc(text=[prompt] * len(batch), images=batch, return_tensors="pt")
        input_ids = inputs["input_ids"].to(_device)
        pixel_values = inputs["pixel_values"].to(_device, _dtype)
        with torch.no_grad():
            gen = _flo_model.generate(
                input_ids=input_ids,
                pixel_values=pixel_values,
                max_new_tokens=48,
                num_beams=1,
                do_sample=False,
            )
        decoded = _flo_proc.batch_decode(gen, skip_special_tokens=False)
        for t, crop in zip(decoded, batch):
            try:
                parsed = _flo_proc.post_process_generation(
                    t, task="<CAPTION>", image_size=(crop.width, crop.height)
                )
                cap = str(parsed.get("<CAPTION>", ""))
                for tok in ("<pad>", "</s>", "<s>"):
                    cap = cap.replace(tok, "")
                texts.append(cap.strip())
            except Exception:  # noqa: BLE001
                texts.append("")
    return texts


def handle(req_path):
    from PIL import Image

    with open(req_path) as f:
        req = json.load(f)
    ws = os.path.dirname(os.path.dirname(os.path.dirname(req_path)))  # .../ws
    img_rel = str(req.get("image", "")).lstrip("/")
    img_abs = os.path.join(ws, img_rel)
    conf = float(req.get("conf", 0.05))
    max_boxes = int(req.get("max", 120))
    want_caption = bool(req.get("caption", True))

    imgsz = int(req.get("imgsz", 1280))
    use_opencv = bool(req.get("opencv", True))
    ocr_boxes = req.get("ocr_boxes", []) or []
    min_caption_area = int(req.get("min_caption_area", 24 * 24))
    max_captions = int(req.get("max_captions", 40))

    img = Image.open(img_abs).convert("RGB")
    W, H = img.size
    elements = detect(img_abs, conf, max_boxes, imgsz, use_opencv)
    # Caption only when asked, and only boxes worth it: big enough AND not already
    # covered by an OCR text box (those get text from OCR anyway). Bounded count.
    if want_caption and elements:
        to_cap = []
        for e in elements:
            x1, y1, x2, y2 = e["bbox"]
            if (x2 - x1) * (y2 - y1) < min_caption_area:
                continue
            if any(_iou(e["bbox"], ob) > 0.5 for ob in ocr_boxes):
                continue
            to_cap.append(e)
            if len(to_cap) >= max_captions:
                break
        crops = []
        for e in to_cap:
            x1, y1, x2, y2 = e["bbox"]
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(W, x2), min(H, y2)
            crops.append(img.crop((x1, y1, max(x1 + 1, x2), max(y1 + 1, y2))))
        caps = caption(crops)
        for e, c in zip(to_cap, caps):
            e["caption"] = c
    return {"ok": True, "w": W, "h": H, "elements": elements}


def write_atomic(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--idle", type=int, default=600, help="idle seconds before exit")
    ap.add_argument("--no-caption", action="store_true")
    args = ap.parse_args()

    os.makedirs(DET, exist_ok=True)
    lock_path = os.path.join(DET, "service.lock")
    lock_fd = open(lock_path, "w")
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        log("another instance is running; exiting")
        return
    with open(os.path.join(DET, "service.pid"), "w") as f:
        f.write(str(os.getpid()))

    load_models(want_caption=not args.no_caption)
    alive_path = os.path.join(DET, "service.alive")
    last_active = time.time()
    log("ready; watching", SANDBOX_ROOT)

    while True:
        now = time.time()
        write_atomic(alive_path, {"pid": os.getpid(), "ts": int(now * 1000), "ready": True})
        reqs = sorted(glob.glob(os.path.join(SANDBOX_ROOT, "*", "ws", ".run", "detect", "req-*.json")))
        did = False
        for req_path in reqs:
            res_path = req_path.replace("req-", "res-", 1)
            if os.path.exists(res_path):
                continue
            did = True
            last_active = now
            try:
                t0 = time.time()
                out = handle(req_path)
                log(
                    "processed",
                    os.path.basename(req_path),
                    "elements=%d" % len(out.get("elements", [])),
                    "in %.2fs" % (time.time() - t0),
                )
            except Exception as ex:  # noqa: BLE001
                out = {"ok": False, "error": str(ex)}
                log("handle error:", ex)
                traceback.print_exc()
            try:
                write_atomic(res_path, out)
                os.remove(req_path)
            except Exception:  # noqa: BLE001
                pass
        if not did:
            if now - last_active > args.idle:
                log("idle timeout; exiting")
                break
            time.sleep(0.2)


if __name__ == "__main__":
    main()
