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


def detect(image_path, conf, max_boxes):
    res = _yolo.predict(source=image_path, conf=conf, iou=0.1, verbose=False)
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
            }
        )
    out.sort(key=lambda e: e["score"], reverse=True)
    return out[:max_boxes]


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

    img = Image.open(img_abs).convert("RGB")
    W, H = img.size
    elements = detect(img_abs, conf, max_boxes)
    if want_caption and elements:
        crops = []
        for e in elements:
            x1, y1, x2, y2 = e["bbox"]
            x1, y1 = max(0, x1), max(0, y1)
            x2, y2 = min(W, x2), min(H, y2)
            crops.append(img.crop((x1, y1, max(x1 + 1, x2), max(y1 + 1, y2))))
        caps = caption(crops)
        for e, c in zip(elements, caps):
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
                out = handle(req_path)
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
