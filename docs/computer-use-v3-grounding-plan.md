# Plan: Computer-use v3 — visual grounding + human-like real input

Status: **design finalized (owner-approved in chat); implementation pending**
Scope: `computer_observe` / `computer_action` / `browser_*` (microVM sandbox).
Builds on v1/v2 (see computer-use-action-plan.md). Author: design agreed with
the project owner in chat.

## 1. Why (the flexibility ceiling v2 still hits)

v2 gave a strong action-program engine (multi-step, condition gates, on_fail,
vision feedback, page-eval). But two limits remain:

1. **Grounding** — on the desktop, observable elements come ONLY from OCR text
   boxes + the window list. Anything without text (icons, sliders, checkboxes,
   canvas, image buttons, toolbar glyphs) has **no handle**, so the model must
   guess raw pixels — which multimodal models do unreliably.
2. **Input realism** — clicks are dispatched synthetically (Playwright /
   coordinate teleport). Many sites/apps behave differently under, or detect,
   synthetic/JS-driven input, and a teleported cursor never triggers
   hover/focus/move handlers a real user would.

v3 fixes both, as **general** capabilities.

## 2. Decisions (owner-approved)

- **Grounding via an OmniParser-style detector**: YOLO interactable-region
  detection **+ Florence-2-large icon captioning** (each mark gets a short text
  description).
- **Detection runs on the GPU, host-side in WSL2 — NOT in the microVM.** The
  Cloud Hypervisor microVM has no GPU passthrough (infeasible on WSL2), but WSL2
  itself has CUDA via `/dev/dxg` on the host's **RTX 4060 (8GB)**. So the heavy
  models run in a persistent WSL2 GPU service that serves all conversation VMs;
  the VM only captures frames and draws the overlay. (Owner: GPU required.)
- **Service lifecycle: on-demand start + idle shutdown** (frees VRAM; avoids
  clashing with any local LM Studio model).
- **Set-of-Mark**: overlay numbered marks on the screenshot; the model targets
  `mark: N`; the server resolves N → exact center. (`id`/`text`/`x,y` kept.)
- **Smart re-marking**: re-run detection only when a **new window appears** or
  the **screen changes beyond a visual-diff threshold**; otherwise reuse cached
  marks. The model can also force a refresh.
- **Human-like real cursor input via xdotool**, unified for desktop AND browser:
  move the REAL X pointer along a smooth, eased, slightly-jittered trajectory
  with variable timing, then a real press/release. No synthetic/JS clicks. For
  the browser, DOM/viewport coords are mapped to absolute screen coords so the
  same real-cursor path drives the page.

## 3. Components

### 3.1 GPU detector service (host-side, WSL2)

- A **persistent WSL2 process** (`sandbox-host/detector-service.py`) that loads
  the YOLO interactable-region model + **Florence-2-large** on **CUDA** once and
  serves every conversation VM. NOT baked into base.img; not in the VM.
- Setup script `sandbox-host/setup-detector.sh`: create a venv with
  PyTorch (CUDA build), `ultralytics`/`transformers`, download the OmniParser
  YOLO weights + Florence-2-large. (WSL2 ships `libcuda`; no nvcc needed —
  PyTorch bundles its CUDA runtime.)
- **Transport (file-based over the existing virtiofs share).** The VM already
  writes screenshots under `/workspace/.run/...`. For detection the guest writes
  `/workspace/.run/detect/req-<id>.json` (`{ image: "<ws-rel png>", caption: true }`);
  the service watches all `/srv/llm-sandboxes/*/ws/.run/detect/`, runs GPU
  inference, and writes `res-<id>.json` = `[{bbox, center, caption, score}]`.
  The guest polls for the result. No per-request Node round-trip.
- **Lifecycle**: `src/lib/sandbox/detector.ts` (Node) ensures the service is up
  (spawns it via `wsl.exe` on the first marked observe) and the service
  idle-exits after `idleMs` with no requests, freeing VRAM.
- GPU cost on the 4060: YOLO ~tens of ms; Florence-2-large captioning is the
  driver but fast on GPU — still gated behind **smart re-marking** + caching so
  captions aren't recomputed on unchanged frames.

### 3.2 Marking + Set-of-Mark overlay

- On observe/after-action, build the element set by merging: **detector boxes**
  (+captions) ⊕ **OCR text boxes** (v2) ⊕ **browser DOM boxes** (browser only).
  De-duplicate overlapping boxes (prefer the one with text/caption).
- Assign stable **mark numbers**; draw numbered labels on a copy of the
  screenshot (the image the model sees). Return a `marks` map:
  `{ n: { center:[x,y], bbox, source:"detector|ocr|dom", text? } }`.
- **Stable numbering across re-marks**: match new boxes to previous marks by
  IoU/center so a given control keeps its number when possible.

### 3.3 Smart re-marking trigger

- Keep a cheap **frame signature** (downscaled grayscale hash) + the window list
  from the last marked frame.
- Re-run detection when: a new/closed window is detected, OR the frame-diff
  magnitude exceeds `markDiffThreshold`, OR the model passes `remark:true`.
- Otherwise reuse cached marks (re-projected). Keeps Florence-2 cost bounded.

### 3.4 Human-like real cursor input (xdotool)

- New low-level move: `human_move(x, y)` — read the current pointer
  (`xdotool getmouselocation`), generate an eased path (ease-in-out) of N
  intermediate points with small Gaussian jitter and variable per-step sleep
  (speed scales with distance), issuing `xdotool mousemove` per point; then a
  short settle.
- Clicks = `human_move` → `xdotool click` (real press/release). Drag =
  human_move to source → `mousedown` → human_move along path to dest →
  `mouseup`. Hover = human_move + dwell.
- **Browser unification**: resolve a DOM target's viewport box (Playwright
  `boundingBox`), then map to screen coords using the Chromium window position +
  chrome offset read once via
  `page.evaluate(() => ({sx:screenX, sy:screenY, ox:outerWidth-innerWidth, oy:outerHeight-innerHeight}))`.
  Drive the SAME xdotool human cursor over the page. (Playwright stays for DOM
  reads / page-eval / scrolling, not for clicking.)
- A `precise:false` / `fast:true` escape hatch keeps the old instant path for
  cases where speed matters more than realism.

### 3.5 Targeting + schema additions

- New target: `mark: <number>` on any pointer step (and `to_mark` for drag dest).
- `computer_observe` / `browser_observe`: `mark?: boolean` (request a marked
  view) and `remark?: boolean` (force re-detect). Marked observe returns the
  marks map; the screenshot pushed to vision is the overlaid one.
- Movement style knobs on a step: `fast?: boolean` (skip human path).

## 4. Files to change

Host GPU service (NOT in base.img):
- `sandbox-host/detector-service.py` (new) — persistent WSL2 CUDA service: load
  YOLO + Florence-2-large once, watch `/srv/llm-sandboxes/*/ws/.run/detect/`,
  infer on GPU, write results; idle-exit.
- `sandbox-host/setup-detector.sh` (new) — venv + torch(CUDA) + transformers +
  ultralytics + weight download.
- `src/lib/sandbox/detector.ts` (new) — Node lifecycle: ensure the WSL2 service
  is running (spawn via `wsl.exe`), health/idle handling.

Guest + wiring:
- `sandbox-host/guest/llm-runner.py` — detect-request plumbing (write req / poll
  res over the share); mark building + overlay + stable numbering; merge with OCR
  + DOM boxes; frame-signature/window re-mark trigger; `human_move` and human
  click/drag/hover (xdotool eased trajectory); DOM→screen coord mapping;
  `mark`/`to_mark` target resolution in the action engine; `mark`/`remark` in
  observe.
- `src/lib/sandbox/driver.ts` — observe opts (`mark`,`remark`), step fields
  (`mark`,`to_mark`,`fast`), marks in the observation type.
- `src/lib/sandbox/microvm.ts` — pass new fields through; ensure detector service
  via `detector.ts` before a marked job.
- `src/lib/grok/responses.ts` — schema: `mark`/`to_mark`/`fast` step props,
  observe `mark`/`remark`; tool-description guidance ("prefer mark targeting;
  request a marked observe to point precisely; clicks move a real cursor").
- `src/lib/config.ts` — knobs: `marking.enabled`, `markDiffThreshold`,
  `detector` (host service idleMs, model sizes, caption toggle), `humanMouse`
  defaults (steps, jitter, speed).
- `.env.example`, `sandbox-host/README.md`, docs — document the GPU service +
  setup + knobs.

## 5. Performance & safety

- GPU (RTX 4060, 8GB): Florence-2-large + YOLO load once in the host service;
  captioning is the cost driver but fast on GPU and gated behind smart re-marking
  + caching (no recompute on unchanged frames). YOLO-only fallback if captions
  are disabled.
- VRAM: service idle-exits to free ~2-3GB; avoids clashing with a local LM Studio
  model. One service instance shared across all VMs (single model load).
- The microVM has NO GPU — only frame capture + overlay + xdotool run in it.
- Human movement adds latency per click (hundreds of ms); `fast:true` bypasses.
- Deploy: app code via build+restart; the GPU service via `setup-detector.sh`
  (one-time) and is launched on demand; guest runner via `update-guest-runner.sh`
  with no VM in flight (no base.img model bake needed).

## 6. Test plan

- Grounding: open an app/page with text-less icons → marked observe → model
  clicks an icon by `mark` → correct action.
- Stable numbering: minor change keeps numbers; new window re-marks.
- Human input: verify real cursor travels (not teleport) via the live VM Console;
  hover reveals a menu; a site that ignores synthetic clicks responds.
- Browser mapping: a DOM button resolved by mark is clicked at the right screen
  spot across scroll positions.
- Cost: confirm detection re-runs only on significant change.
