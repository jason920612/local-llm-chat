#!/usr/bin/env bash
# Phase 0 - stage 3f: bake the PP-OCRv6 (medium) OCR stack into base.img.
#
# The VM's system Python is 3.14 (Ubuntu 26.04) and PaddlePaddle has no 3.14
# wheel, so we bake a standalone CPython 3.12 under /opt/python, install
# paddlepaddle + paddleocr==3.7.0 into it, and pre-download the PP-OCRv6 medium
# weights to /root/.paddlex. At runtime the guest daemon (system py3.14) drives
# PaddleOCR through /ocr-worker.py run by /opt/python/bin/python3.12 (see
# sandbox-host/guest/ocr-worker.py), kept warm as a long-lived subprocess.
#
# Prereq: base.img needs ~1.5 GiB free. Grow it first if tight:
#   truncate -s 6G ~/llm-sandbox/images/base.img
#   e2fsck -fy   ~/llm-sandbox/images/base.img && resize2fs ~/llm-sandbox/images/base.img
set -uo pipefail
LSB="$HOME/llm-sandbox"
BUILD="$LSB/rootfs-build"
IMG="$LSB/images/base.img"
case "$BUILD" in "$HOME/llm-sandbox/"*) : ;; *) echo "REFUSE: $BUILD"; exit 1;; esac

# Standalone CPython 3.12 (python-build-standalone). install_only.tar.gz unpacks
# to a top-level python/ dir -> /opt/python/bin/python3.12.
PY_URL="https://github.com/astral-sh/python-build-standalone/releases/download/20260610/cpython-3.12.13+20260610-x86_64-unknown-linux-gnu-install_only.tar.gz"

cleanup() {
  for m in "$BUILD/dev/pts" "$BUILD/dev" "$BUILD/proc" "$BUILD/sys"; do
    mountpoint -q "$m" 2>/dev/null && sudo umount -l "$m" 2>/dev/null
  done
  mountpoint -q "$BUILD" 2>/dev/null && sudo umount "$BUILD" 2>/dev/null
}
trap cleanup EXIT

sudo mount -o loop "$IMG" "$BUILD"
sudo cp /etc/resolv.conf "$BUILD/etc/resolv.conf"
sudo mount --bind /dev "$BUILD/dev"
sudo mount --bind /proc "$BUILD/proc"
sudo mount --bind /sys "$BUILD/sys"

sudo chroot "$BUILD" /bin/bash -c "
  set -e
  export DEBIAN_FRONTEND=noninteractive HOME=/root
  echo '--- runtime libs for paddle/opencv ---'
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends \
    libgl1 libglib2.0-0 libgomp1 libsm6 libxext6 libxrender1 2>&1 | tail -6

  if [ ! -x /opt/python/bin/python3.12 ]; then
    echo '--- fetch standalone CPython 3.12 ---'
    curl -fsSL '$PY_URL' -o /tmp/py312.tar.gz
    mkdir -p /opt
    tar -C /opt -xzf /tmp/py312.tar.gz
    rm -f /tmp/py312.tar.gz
  fi
  /opt/python/bin/python3.12 --version

  echo '--- install paddlepaddle + paddleocr==3.7.0 (py3.12) ---'
  /opt/python/bin/python3.12 -m pip install --no-cache-dir --upgrade pip
  if ! /opt/python/bin/python3.12 -m pip install --no-cache-dir paddlepaddle 'paddleocr==3.7.0'; then
    echo '--- PyPI paddlepaddle failed; retry via official CPU index ---'
    /opt/python/bin/python3.12 -m pip install --no-cache-dir \
      -i https://www.paddlepaddle.org.cn/packages/stable/cpu/ paddlepaddle
    /opt/python/bin/python3.12 -m pip install --no-cache-dir 'paddleocr==3.7.0'
  fi

  echo '--- warm-up: download PP-OCRv6 medium weights + smoke predict ---'
  /opt/python/bin/python3.12 - <<'PY'
from PIL import Image, ImageDraw
img = '/tmp/_ocr_warm.png'
im = Image.new('RGB', (480, 120), 'white')
ImageDraw.Draw(im).text((20, 40), 'Hello OCR 12345', fill='black')
im.save(img)
from paddleocr import PaddleOCR
ocr = PaddleOCR(
    ocr_version='PP-OCRv6',
    text_detection_model_name='PP-OCRv6_medium_det',
    text_recognition_model_name='PP-OCRv6_medium_rec',
    use_doc_orientation_classify=False,
    use_doc_unwarping=False,
    use_textline_orientation=False,
    enable_mkldnn=False,  # paddle 3.3.1 oneDNN/PIR CPU path crashes on PP-OCRv6
)
res = ocr.predict(img)
for r in res:
    print('warm-up rec_texts:', r.json.get('res', {}).get('rec_texts'))
print('PP-OCRv6 medium ready')
PY
  rm -f /tmp/_ocr_warm.png
  apt-get clean
  rm -rf /var/lib/apt/lists/*
  echo '--- sizes ---'
  du -sh /opt/python /root/.paddlex 2>/dev/null || true
"

echo 'nameserver 1.1.1.1' | sudo tee "$BUILD/etc/resolv.conf" >/dev/null

cleanup
trap - EXIT
du -h "$IMG" | cut -f1
echo "=== DONE stage3f-ocr ==="
