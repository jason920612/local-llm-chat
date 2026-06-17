# Local LLM Chat

> **Static demo (no install, runs in your browser):** <https://jason920612.github.io/local-llm-chat/>
> — a pure-static GitHub Pages build (`docs/`) that talks directly to the xAI/Grok
> API with your own key (stored only in your browser). Python sandbox via Pyodide.
> The full app below (LM Studio, RAG, server sandbox, etc.) is the Next.js project.


A private-first multimodal chat web app. By default it talks to a model running
in **LM Studio** (or any `llama.cpp` server exposing an OpenAI-compatible API).
Optional xAI/Grok features can be enabled with `XAI_API_KEY` for search, media
generation, cloud STT/TTS, and realtime voice.

> Built with non-Chinese, open models. Recommended chat model is Google **Gemma 4 12B**
> (vision-capable; **Gemma 3 4B** for low VRAM); RAG embeddings use **nomic-embed-text**.

## Features

- 💬 **Streaming chat** with markdown + code rendering
- 🖼️ **Vision / image input** — drop an image and ask about it (multimodal)
- 📄 **RAG** — upload PDF / text / markdown, chat grounded in your documents with citations
- 🎙️ **Voice** — speech-to-text via Whisper (runs in your browser), text-to-speech via OS voices
- 🌐 **Grok search tool** — the local model can borrow Grok's X + web search via a `grok_search` tool and receive only Grok's synthesized answer (saves context)
- 🗂️ **Conversation history** — saved locally in SQLite
- ⚙️ **Background jobs** — local host background commands can run concurrently with limits, log tails, timeout handling, and kill support
- 📋 **Jobs / SOP console** — a sidebar console shows background jobs and recent SOP control events
- 🔐 **Secure remote access helpers** — scripts for LAN HTTPS and Cloudflare Tunnel + mTLS client certificates

Everything runs on a single Next.js app + a local SQLite database. Without an
xAI key, speech-to-text and text-to-speech fall back to client-side/browser
engines. With an xAI key, STT/TTS and realtime voice use xAI APIs.

> Note: browser microphone access requires a secure context. `localhost` works
> on the same machine; phones on LAN need HTTPS (or the Cloudflare mTLS tunnel).
> On mobile, Enter inserts a newline; send with the paper-plane button.

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (App Router) + React 19 + TypeScript |
| Styling | Tailwind CSS v4 |
| LLM transport | `openai` SDK → LM Studio / llama.cpp OpenAI-compatible API |
| Storage | SQLite via `better-sqlite3` (conversations + RAG vectors) |
| Speech-to-text | xAI STT when configured; browser Whisper fallback |
| Text-to-speech | xAI TTS when configured; Web Speech API fallback |

## Code-enforced SOP control layer

Small local models drift and hallucinate, so behavior is **enforced in code**, not
left to a system prompt. Every chat turn runs through a control pipeline
(`src/lib/sop/`):

1. **Intent gate** — a JSON-schema structured call returns `{restatement, ambiguous,
   clarifyingQuestion}`, validated by zod. If the request is ambiguous, code
   **short-circuits the turn** and returns a clarifying question; the answer is never
   generated.
2. **Generation** — streamed by default.
3. **Deterministic validators** — citation whitelist (fabricated `[n]` sources are
   stripped/flagged), disclaimer/flattery stripping, empty-response detection. Pure
   code, no model trust.
4. **Stance gate (default on, `SOP_STANCE_GATE`)** — a structured
   LLM-as-judge check for artificial balance: false equivalence, fake opposing
   views, vague "it depends" caveats, unsupported uncertainty, or over-discussing
   alternatives when the user already chose a direction. The judge always
   evaluates the draft when the gate is enabled, returns structured JSON, and
   code decides whether medium/high severity blocks and enters correction. Real
   tradeoffs, real uncertainty, and genuinely controversial topics still pass.
5. **Strict monitor (default on, local backend only)** — the governing path. Generate → monitor
   (deterministic checks) → on failure, issue a **harsh internal scold-correction**
   that forces a fixed answer → **sanitize so the scolding never leaks to the user** →
   refuse if still non-compliant. **Concrete citations are mandatory** whenever sources
   exist (RAG/local Grok tool): every `[n]` must map to a real source, fabricated ones are stripped,
   and an uncited answer is rejected. The user only ever sees the corrected answer plus a
   neutral control note — never the reprimand.
6. **Verify gate (opt-in, `SOP_VERIFY_GATE`)** — an extra LLM self-audit that can also
   trigger corrections. Off by default because a small model auditing itself is noisy;
   useful with a larger model.

Toggle via env (`SOP_INTENT_GATE`, `SOP_STRICT_MONITOR`, `SOP_BLOCKING`,
`SOP_STANCE_GATE`, `SOP_VERIFY_GATE`). The system prompt states the rules, but the
gates above are what actually enforce them — in code, not on trust.

Recent SOP events are recorded in SQLite and shown in the **Console** sidebar
view alongside background job telemetry.

The **Grok (cloud)** chat backend intentionally bypasses the SOP correction
monitor. Native Grok responses are streamed through directly so xAI's own tool
syntax, citations, media metadata, and token-by-token behavior are preserved.
When strict monitoring is enabled globally, Grok turns still record a
`stream_grok_responses_sop_disabled` event for observability, but no
post-stream correction is applied.

## Grok search tool (xAI)

The local model can call a `grok_search` function-tool that borrows Grok's
**server-side X + web search** (via xAI's Responses API
`POST /v1/responses` with `web_search` + `x_search` tools). Web Search is
configured with image search and image understanding enabled by default, so Grok
can find real web images when the user asks for real visual references. Grok runs the whole
search→read→synthesize loop on its servers and returns one answer; the local
model receives **only that synthesized answer + sources**, not raw results — so
its context stays small.

Flow: local model emits a `grok_search` tool call → pipeline calls xAI →
Grok's answer is fed back as the tool result → local model writes the final
reply with `[n]` citations.

Enable it by setting `XAI_API_KEY` in `.env.local` (get one at
<https://console.x.ai>), then toggle **Grok** in the chat header. The model is
configurable via `GROK_MODEL` (default `grok-build-0.1`). The legacy Live Search
`search_parameters` API is retired — this uses the current Agent Tools API.

### Cloud backend + xAI media

In Settings you can switch the **chat backend** from local to **Grok (cloud)**.
On the Grok backend the app uses xAI's native **Responses API** (`/v1/responses`):

- **X + web search** run server-side automatically (no toggle needed), including
  image search / image understanding when enabled by env.
- **Image generation** (`generate_image` → Grok Imagine, `/v1/images/generations`)
  and **video generation** (`generate_video` → `grok-imagine-video-1.5-preview`,
  `/v1/videos/generations`, async) are client-side function tools — the model calls
  them and the result is shown inline.
- **Voice**: TTS via `/v1/tts` (natural voices), REST STT via `/v1/stt`, and
  streaming STT via the local WebSocket proxy `/api/stt/stream` replace the
  browser engines when a key is present (falling back to browser TTS/Whisper otherwise).
  Streaming STT uses xAI Smart Turn to avoid cutting users off mid-sentence.
- **Realtime voice agent**: the **Voice** button opens a speech-to-speech session
  over WebSocket (`wss://api.x.ai/v1/realtime`) using an ephemeral token.
- **Cost tracking**: streamed Responses API calls capture xAI
  `usage.cost_in_usd_ticks` and show it in the message tool/metadata panel.
- **Searched image rendering**: xAI Web Search image results are expected to
  appear as Markdown image embeds (`![alt](url)`), which the frontend renders
  directly. Legacy/internal Grok `render_searched_image` markers are parsed only
  as a compatibility/debug path because xAI does not guarantee public
  image-id-to-URL metadata for them.
- **Priority processing**: set `XAI_SERVICE_TIER=priority` to request priority
  scheduling for xAI text/image/video/voice inference. The default stays normal
  scheduling/cost.
- **Code sandbox** (`run_code`, opt-in via `SANDBOX_ENABLED`): the model runs
  bash/python in a per-conversation workspace (timeout + auto-cleanup), and files
  it creates appear in the chat — text files open in a viewer, others download.
  ⚠️ With the default `local` driver this runs real code on the host with the
  server's permissions; it is workspace isolation, **not** a security boundary.
  For true isolation use the **microVM driver** below.

### Isolated microVM sandbox (per-conversation, own kernel)

Set `SANDBOX_DRIVER=microvm` to run every conversation's `run_code` in its **own
Cloud Hypervisor microVM** — a real, separate Linux kernel, not a container.
Each VM is ephemeral (booted per run, ~2s, torn down after) and mounts that
conversation's **persistent** workspace over virtio-fs at `/workspace`; pip
installs persist there (`pip --user` → `/workspace/.local`) and the VM has NAT
egress so `pip`/`git` work. The whole sandbox subsystem runs inside **WSL2**, so
this backend is Windows + WSL2 only; other hosts fall back to `local`.

One-time host setup (inside WSL2 Ubuntu) provisions cloud-hypervisor + virtiofsd,
a guest kernel, and a base rootfs under `~/llm-sandbox/`, plus a scoped
`/etc/sudoers.d/llm-sandbox` so the per-conversation VM bridge needs no
password. Tune via the `SANDBOX_VM_*` / `SANDBOX_WSL_*` env vars (see
`.env.example`). Background jobs
(`start_background`) run **inside** the conversation's microVM under this driver
(not as host processes), so they stay within the VM isolation boundary. The
conversation VM runs a guest daemon that can execute multiple `run_code` and
`start_background` jobs concurrently. The model can tail each background job's
live log under `.run/jobs/<id>/live.log` and is woken with the full output on
completion.

Inside the VM the model runs as **root** on a **writable** filesystem: a tmpfs
overlay over the read-only base, with the upper layer + `/tmp` backed by a
per-conversation **sparse system disk** (`SANDBOX_VM_SYSDISK_GIB`, default 100 GiB
apparent / thin on the host) that **persists** across runs — so `apt-get install`
works and stays installed. `/workspace` remains the file/document layer.

> Even here, treat the model as untrusted only up to the VM boundary: the VM has
> outbound network (NAT) by default and runs as root inside its own kernel. Set
> `SANDBOX_VM_MAX_CONCURRENT` to cap how many VMs run at once.

Background jobs are available through model tools (`start_background`,
`read_background_log`, `list_background`, `kill_background`). On the **local**
driver they run as host processes with multiple concurrent jobs and
per-conversation / global concurrency limits; on the **microVM** driver they run
inside the conversation's single VM session and can coexist with other
background jobs and `run_code` jobs. Different conversations can have different
VMs alive at the same time, bounded by `SANDBOX_VM_MAX_CONCURRENT`.

> Updating the guest runner: after editing `sandbox-host/guest/llm-runner.py`,
> re-bake it into the base image with `sandbox-host/update-guest-runner.sh`
> (copies it into `~/llm-sandbox/` and re-runs the debugfs inject). No VM may be
> running during the inject.

Code blocks have syntax highlighting, a copy button, and auto-collapse when long;
images open in a lightbox.

**File upload & drag-and-drop:** attach files with the paperclip or drag them onto
the chat. Images become vision attachments; other files upload into the
conversation's sandbox workspace so `run_code` can read/process them.

## Prerequisites

1. **[LM Studio](https://lmstudio.ai/)** (or `llama.cpp` server).
2. In LM Studio, download and load:
   - A chat model — recommended **`google/gemma-4-12b`** (vision-capable, non-Chinese,
     best quality on ~8GB VRAM). For low VRAM / faster responses use
     **`google/gemma-3-4b`**. Use the exact key shown by `lms ls`.
   - An embedding model — recommended **`nomic-embed-text-v1.5`** (for RAG).
3. Start the **Local Server** in LM Studio (default `http://localhost:1234`).
4. Node.js 20+.

## Getting started

```bash
npm install
cp .env.example .env.local   # adjust model names to match LM Studio
npm run dev
```

Open <http://localhost:3000>.

### Remote access without port forwarding

This repo includes helper scripts for two secure local-to-remote setups:

1. **LAN HTTPS** for phone testing on the same network:

   ```powershell
   npm run https:setup -- --ip 192.168.1.2
   npm run https:proxy
   ```

   This exposes `https://<LAN-IP>:3443` through a local HTTPS proxy. Install the
   generated root CA on the phone if you use this route.

2. **Cloudflare named tunnel + mTLS** for public access without exposing your
   origin or using router port forwarding:

   ```powershell
   cloudflared tunnel login
   cloudflared tunnel create local-llm-chat
   cloudflared tunnel route dns local-llm-chat grok.coderyo.com
   npm run mtls:p12 -- --cert certs/cf-client.crt --key certs/cf-client.key --out certs/grok-phone.p12
   npm run tunnel:named
   ```

   Configure Cloudflare mTLS/WAF to block requests where
   `not cf.tls_client_auth.cert_verified` for the hostname. Without the client
   certificate, Cloudflare returns 403 before traffic reaches the local app.
   Chrome/Edge may need QUIC disabled for reliable client-certificate selection;
   `scripts/open-grok-chrome-mtls.ps1` launches a dedicated Chrome profile with
   HTTP/3/QUIC disabled.

### Configuration

All settings come from environment variables (see `.env.example`):

| Variable | Default | Notes |
|---|---|---|
| `LLM_BASE_URL` | `http://localhost:1234/v1` | LM Studio server URL |
| `LLM_API_KEY` | `lm-studio` | any non-empty string |
| `LLM_MODEL` | `gemma-3-4b-it` | must match the loaded chat model |
| `EMBEDDING_MODEL` | `text-embedding-nomic-embed-text-v1.5` | must match the loaded embedding model |
| `BACKGROUND_MAX_CONCURRENT_GLOBAL` | `8` | local background job global limit |
| `BACKGROUND_MAX_CONCURRENT_PER_CONVERSATION` | `5` | local background job per-conversation limit |
| `SOP_STRICT_MONITOR` | `true` | enable strict SOP monitor for local-model turns; Grok cloud backend bypasses correction monitoring |
| `SOP_STANCE_GATE` | `true` | block artificial balance / false-equivalence drafts |
| `SOP_BLOCKING` | `true` | block unsafe/non-compliant output instead of warning only |
| `XAI_SERVICE_TIER` | `default` | set `priority` only when latency matters |
| `XAI_WEB_SEARCH_IMAGE_SEARCH` | `true` | enable real image results in xAI web search |
| `XAI_WEB_SEARCH_IMAGE_UNDERSTANDING` | `true` | let xAI inspect images found while browsing |
| `XAI_STT_STREAMING` | `true` | prefer streaming STT over record-then-upload |
| `XAI_STT_SMART_TURN` | `0.7` | Smart Turn confidence threshold |

## Project layout

```
src/
  app/
    api/            route handlers (chat, rag, conversations)
    page.tsx        chat UI
  components/        React UI components
  lib/              server logic (llm client, db, rag, config)
  lib/live/         streaming generation + background job manager
  lib/sop/          code-enforced SOP gates, monitor, validators
data/                SQLite DB + uploaded files (git-ignored)
certs/               local certificates (git-ignored)
logs/                server/tunnel logs (git-ignored)
```

## Roadmap / build phases

- [x] Phase 0 — project scaffold
- [x] Phase 1 — streaming chat + code-enforced SOP control layer
- [x] Phase 2 — conversation history (SQLite)
- [x] Phase 3 — image / vision input
- [x] Phase 4 — RAG (document upload + retrieval + citations)
- [x] Phase 5 — voice in (Whisper) / out (TTS)
- [x] Phase 6 — settings, health check & polish
- [x] Phase 7 — background jobs + Jobs/SOP console
- [x] Phase 8 — secure phone/remote access helpers (LAN HTTPS, Cloudflare mTLS)

## License

MIT
