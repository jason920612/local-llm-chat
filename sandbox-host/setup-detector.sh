#!/usr/bin/env bash
# One-time setup for the host-side GPU UI-detector service (WSL2).
#   - Python venv with PyTorch (CUDA), transformers, ultralytics
#   - OmniParser YOLO interactable-region weights + Florence-2-large caption model
# The microVM has no GPU; this runs on the WSL2 host (RTX 4060 via /dev/dxg) and
# serves all conversation VMs. See docs/computer-use-v3-grounding-plan.md.
set -uo pipefail

DET="$HOME/llm-sandbox/detector"
VENV="$DET/venv"
W="$DET/weights"
mkdir -p "$W"

# The WSL host's system Python is 3.14 (Ubuntu 26.04, PEP 668-managed) and has no
# PyTorch wheels. Provision a standalone CPython 3.12 via uv (which has cu124
# torch wheels) — same rationale as the OCR worker's standalone interpreter.
PY312="$VENV/bin/python"

echo "=== preflight ==="
ls /usr/lib/wsl/lib/libcuda.so* >/dev/null 2>&1 || echo "WARN: WSL CUDA libs not found at /usr/lib/wsl/lib (GPU may be unavailable)"

echo "=== ensure uv ==="
UV="$HOME/.local/bin/uv"
if ! [ -x "$UV" ]; then
  if command -v uv >/dev/null 2>&1; then UV="$(command -v uv)"; else
    curl -LsSf https://astral.sh/uv/install.sh | sh
  fi
fi
[ -x "$UV" ] || { echo "ERR: uv install failed"; exit 1; }
"$UV" python install 3.12

echo "=== venv (CPython 3.12) ==="
rm -rf "$VENV"
"$UV" venv --python 3.12 "$VENV"

echo "=== install torch (CUDA 12.4) ==="
"$UV" pip install --python "$PY312" torch torchvision --index-url https://download.pytorch.org/whl/cu124

echo "=== install detector deps ==="
# Florence-2's remote modeling code targets transformers 4.x; 5.x breaks its
# config init (forced_bos_token_id). Pin to a known-good 4.x.
"$UV" pip install --python "$PY312" \
  "transformers==4.49.0" timm einops pillow numpy accelerate \
  ultralytics opencv-python-headless huggingface_hub

echo "=== verify CUDA visible to torch ==="
"$PY312" - <<'PY'
import torch
print("torch", torch.__version__, "cuda_available", torch.cuda.is_available())
if torch.cuda.is_available():
    print("device:", torch.cuda.get_device_name(0))
PY

echo "=== download weights ==="
"$PY312" - <<'PY'
import os
from huggingface_hub import hf_hub_download, snapshot_download
det = os.path.expanduser("~/llm-sandbox/detector/weights")
# OmniParser v2 YOLO interactable-region detector.
p = hf_hub_download("microsoft/OmniParser-v2.0", "icon_detect/model.pt", local_dir=det)
print("yolo:", p)
# Florence-2-large caption model (trust_remote_code at load time).
d = snapshot_download("microsoft/Florence-2-large", local_dir=os.path.join(det, "florence2-large"))
print("florence2-large:", d)
PY

echo "=== DONE setup-detector ==="
echo "weights under: $W"
