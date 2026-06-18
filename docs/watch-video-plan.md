# Plan: `watch_video` — let the model watch video files and web videos

Status: **design finalized (owner-approved in chat); implementation pending**
Scope: one new tool `watch_video`, backed by the per-conversation microVM
sandbox. Author: design agreed with the project owner in chat.

## 1. Core constraint (why this shape)

The xAI API has **no native video-understanding input**. It supports:
- Image understanding — `input_image` (URL or base64; JPEG/PNG; ≤20MiB/image;
  no image-count limit). This is what grok-build-0.1 multimodal already uses.
- Video **generation** (Imagine API, async) — already wired as `generate_video`.

There is no endpoint to hand the model a video to "watch". So watching is
synthesized: **sample frames → feed as a sequence of images** (reusing the
existing vision-injection pipeline), plus **transcribe the audio track** (xAI
batch STT) and feed it as text. All media work runs in the conversation's
microVM; STT (needs the API key) runs host-side.

Refs: docs.x.ai model-capabilities/video (generation only),
model-capabilities/images/understanding (image input spec), `/v1/stt` batch
transcription (file → text, auto language).

## 2. Tool surface

**Single tool** `watch_video` (owner choice — one tool, not two):

```
watch_video({
  source: string,        // sandbox filename / uploaded file  OR  a URL
                         // (direct video file, YouTube, or a web page w/ a player)
  prompt?: string,       // optional focus, e.g. "what happens after the goal?"
  audio?: boolean,       // default true — also transcribe the audio track
})
```

Returns to the model: the sampled **frames as real images** (injected as
`input_image` into the next round, like `send_screenshot`), plus a text result
with **metadata** (duration, frames sampled, per-frame timestamps) and the
**audio transcript** (coarse timestamps). The huge base64 frame data is stripped
from the text result (same pattern as observe/action vision feedback).

Gating: offered when `sandbox.driver === "microvm"`. The browser-fallback
acquisition path additionally requires `microvm.computer.enabled`; without it,
only the file / yt-dlp paths are used.

## 3. Pipeline (in the guest, one VM job)

`source` is auto-routed:

1. **Sandbox file / uploaded file** → use directly (resolve under `/workspace`).
2. **URL** → acquire, two paths, best-fidelity first:
   - **(a) yt-dlp download** (preferred): grab the video incl. audio, capped at
     **≤720p**. Works for YouTube and most mainstream sites; gives a clean file
     for offline frame + audio extraction.
   - **(b) browser-playback fallback** (any site, incl. stream-only players
     yt-dlp can't fetch): play in the existing computer-use Chromium under Xvfb
     and capture in real time — see §4. Used only when (a) fails.

Then, for the obtained file (paths a/1) or the live capture (path b):

### 3.1 Frame sampling — scene-change detection + duration-scaled budget

Owner choice: sample by **magnitude of visual change** (ffmpeg scene score),
not fixed/even spacing, with a budget that **scales with length** so long videos
aren't under-sampled, and a hard ceiling for cost.

- ffmpeg computes a scene score (0–1) per frame; candidates are frames whose
  score `> threshold` (default **0.3**).
- **Budget** = `clamp(ceil(minutes × 6), 8, 120)` frames.
  - e.g. 1m→8 (floor), 5m→30, 10m→60, ≥20m→120 (ceiling).
- **candidates > budget** → keep the `budget` highest-scoring frames.
- **candidates < budget** → add evenly-spaced fill frames up to a sensible
  coverage floor (so a static long video still gets frames), never exceeding
  budget.
- The **first frame is always included**.
- Frames downscaled to **long edge 768px**, JPEG — far under the 20MiB cap.

### 3.2 Audio → transcript (owner choice: frames + transcript)

- ffmpeg extracts the audio track to a file in `/workspace`.
- Host reads it (virtiofs share) and transcribes via xAI **batch STT**
  (`/v1/stt`, auto language). `/stt` returns whole text only, so for **coarse
  timestamps** the audio is split into ~60s chunks, each transcribed and
  prefixed with its start time. Transcript is aligned to the frame timeline.

## 4. Browser-playback fallback with system-audio capture (§ owner-approved)

The microVM has no sound hardware, but audio capture needs none:

- Bake **PulseAudio** into base.img; on session start create a **null sink**
  (virtual speaker) as the default output; point Chromium at it.
- To watch: load the page → start recording the sink's **`.monitor`** source
  with ffmpeg → play the `<video>` → simultaneously capture frames and audio →
  stop when playback ends. This yields **clean, in-sync system audio** for ANY
  site (fixing the earlier "fallback has no audio" gap).
- **2× playback** (`video.playbackRate = 2`) to halve real-time capture; the
  sped audio is transcribed by STT afterward.
- **Cap ~15 min** of (sped) capture; anything beyond is not recorded and noted
  in the result.
- Playback end detected via `eval` on `<video>.ended` / `duration`; a max-time
  guard backstops it.

## 5. Long videos (owner choice)

No special limit / no chunked-watch for v1: rely on the **frame ceiling (120)**
plus the **full transcript** — watch the whole thing. (Cost is bounded by frame
count, not duration.) Auto-segmented watching can be added later if needed.

## 6. Defaults (all configurable via `config.ts`)

| Knob | Default |
|---|---|
| frames/min | 6 |
| frame floor / ceiling | 8 / 120 |
| scene threshold | 0.3 |
| frame long edge | 768px |
| audio transcript | on |
| yt-dlp max quality | ≤720p |
| browser playback rate | 2× |
| browser capture cap | ~15 min |
| STT chunk size | ~60s |

## 7. Files to change

- **`sandbox-host/build/stage3g-video.sh`** (new) — bake `ffmpeg`, `yt-dlp`,
  `pulseaudio` into base.img; install null-sink autostart for the X session.
- **`sandbox-host/guest/llm-runner.py`** — new `watch_video` job: source
  routing, yt-dlp download, browser-playback capture (Pulse monitor + frames),
  scene-detect frame extraction with budget, audio extraction; returns frame
  file paths + audio file path + metadata.
- **`sandbox-host/build/stage3e-browser.sh`** (or session launcher) — start
  PulseAudio + create null sink in the computer-use session; Chromium → Pulse.
- **`src/lib/grok/stt.ts`** (new) — `transcribeAudioFile()` host helper (chunked,
  coarse timestamps); `/api/stt/route.ts` refactored to reuse it.
- **`src/lib/sandbox/driver.ts`** — `watchVideo()` interface + `WatchVideoResult`
  / `WatchVideoFrame` types.
- **`src/lib/sandbox/microvm.ts`** — `watchVideo()` impl (one VM job; longer
  timeout for download/real-time capture).
- **`src/lib/sandbox/local.ts`** (if present) — stub/unsupported.
- **`src/lib/config.ts`** — `microvm.video` knobs (table above).
- **`src/lib/grok/responses.ts`** — `WATCH_VIDEO_TOOL` schema; add to `toolset()`;
  dispatch: call `watchVideo`, push each frame via `pushVision`, run host STT on
  the returned audio file, assemble transcript + metadata as the text result.

## 8. Deploy

Code-only parts ship via `next build` + restart. The base.img parts
(`ffmpeg`/`yt-dlp`/`pulseaudio` + null-sink autostart) require stopping VMs and
`update-guest-runner.sh` / a base.img rebuild stage — done as a discrete step
with no VM in flight.

## 9. Test plan

- Direct file: upload a short clip → `watch_video(file)` → frames + transcript
  returned; model answers a content question.
- yt-dlp: a YouTube URL → ≤720p download → frames + audio transcript.
- Browser fallback: a stream-only player → Pulse-monitor audio + frames at 2×,
  ≤15min cap respected.
- Scene budget: verify 5m→~30, long static video still gets fill frames, busy
  video caps at 120 by top scene score.
