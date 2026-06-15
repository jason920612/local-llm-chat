# Local LLM Chat

> **Static demo (no install, runs in your browser):** <https://jason920612.github.io/local-llm-chat/>
> — a pure-static GitHub Pages build (`docs/`) that talks directly to the xAI/Grok
> API with your own key (stored only in your browser). Python sandbox via Pyodide.
> The full app below (LM Studio, RAG, server sandbox, etc.) is the Next.js project.


A private, fully-local multimodal chat web app. It talks to a model running in
**LM Studio** (or any `llama.cpp` server exposing an OpenAI-compatible API) — no
data leaves your machine, no cloud API keys.

> Built with non-Chinese, open models. Recommended chat model is Google **Gemma 4 12B**
> (vision-capable; **Gemma 3 4B** for low VRAM); RAG embeddings use **nomic-embed-text**.

## Features

- 💬 **Streaming chat** with markdown + code rendering
- 🖼️ **Vision / image input** — drop an image and ask about it (multimodal)
- 📄 **RAG** — upload PDF / text / markdown, chat grounded in your documents with citations
- 🎙️ **Voice** — speech-to-text via Whisper (runs in your browser), text-to-speech via OS voices
- 🌐 **Grok search tool** — the local model can borrow Grok's X (Twitter) + web search via a `grok_search` tool and receive only Grok's synthesized answer (saves context)
- 🗂️ **Conversation history** — saved locally in SQLite

Everything runs on a single Next.js app + a local SQLite database. Speech-to-text
and text-to-speech run entirely client-side (no extra services).

> Note: the Whisper model (~150MB) is downloaded from the Hugging Face hub on the
> first voice recording, then cached in your browser. Transcription itself runs
> locally. TTS uses your OS voices (fully offline).

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 15 (App Router) + React 19 + TypeScript |
| Styling | Tailwind CSS v4 |
| LLM transport | `openai` SDK → LM Studio / llama.cpp OpenAI-compatible API |
| Storage | SQLite via `better-sqlite3` (conversations + RAG vectors) |
| Speech-to-text | `@huggingface/transformers` (Whisper, WASM/WebGPU, in-browser) |
| Text-to-speech | Web Speech API (OS voices, offline) |

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
4. **Strict monitor (default on)** — the governing path. Generate → monitor
   (deterministic checks) → on failure, issue a **harsh internal scold-correction**
   that forces a fixed answer → **sanitize so the scolding never leaks to the user** →
   refuse if still non-compliant. **Concrete citations are mandatory** whenever sources
   exist (RAG/Grok): every `[n]` must map to a real source, fabricated ones are stripped,
   and an uncited answer is rejected. The user only ever sees the corrected answer plus a
   neutral control note — never the reprimand.
5. **Verify gate (opt-in, `SOP_VERIFY_GATE`)** — an extra LLM self-audit that can also
   trigger corrections. Off by default because a small model auditing itself is noisy;
   useful with a larger model.

Toggle via env (`SOP_INTENT_GATE`, `SOP_STRICT_MONITOR`, `SOP_BLOCKING`,
`SOP_VERIFY_GATE`). The system prompt states the rules, but the gates above are what
actually enforce them — in code, not on trust.

## Grok search tool (xAI)

The local model can call a `grok_search` function-tool that borrows Grok's
**server-side X (Twitter) + web search** (via xAI's Responses API
`POST /v1/responses` with `web_search` + `x_search` tools). Grok runs the whole
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

- **X + web search** run server-side automatically (no toggle needed).
- **Image generation** (`generate_image` → Grok Imagine, `/v1/images/generations`)
  and **video generation** (`generate_video` → `grok-imagine-video-1.5-preview`,
  `/v1/videos/generations`, async) are client-side function tools — the model calls
  them and the result is shown inline.
- **Voice**: TTS via `/v1/tts` (natural voices) and STT via `/v1/stt` replace the
  browser engines when a key is present (falling back to browser TTS/Whisper otherwise).
- **Realtime voice agent**: the **Voice** button opens a speech-to-speech session
  over WebSocket (`wss://api.x.ai/v1/realtime`) using an ephemeral token.
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
`/etc/sudoers.d/llm-sandbox` so the per-run boot needs no password. Tune via the
`SANDBOX_VM_*` / `SANDBOX_WSL_*` env vars (see `.env.example`). Background jobs
(`start_background`) are disabled under this driver (they would run on the host,
outside the VM boundary).

Inside the VM the model runs as **root** on a **writable** filesystem: a tmpfs
overlay over the read-only base, with the upper layer + `/tmp` backed by a
per-conversation **sparse system disk** (`SANDBOX_VM_SYSDISK_GIB`, default 100 GiB
apparent / thin on the host) that **persists** across runs — so `apt-get install`
works and stays installed. `/workspace` remains the file/document layer.

> Even here, treat the model as untrusted only up to the VM boundary: the VM has
> outbound network (NAT) by default and runs as root inside its own kernel. Set
> `SANDBOX_VM_MAX_CONCURRENT` to cap how many VMs run at once.

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

### Configuration

All settings come from environment variables (see `.env.example`):

| Variable | Default | Notes |
|---|---|---|
| `LLM_BASE_URL` | `http://localhost:1234/v1` | LM Studio server URL |
| `LLM_API_KEY` | `lm-studio` | any non-empty string |
| `LLM_MODEL` | `gemma-3-4b-it` | must match the loaded chat model |
| `EMBEDDING_MODEL` | `text-embedding-nomic-embed-text-v1.5` | must match the loaded embedding model |

## Project layout

```
src/
  app/
    api/            route handlers (chat, rag, conversations)
    page.tsx        chat UI
  components/        React UI components
  lib/              server logic (llm client, db, rag, config)
data/                SQLite DB + uploaded files (git-ignored)
```

## Roadmap / build phases

- [x] Phase 0 — project scaffold
- [x] Phase 1 — streaming chat + code-enforced SOP control layer
- [x] Phase 2 — conversation history (SQLite)
- [x] Phase 3 — image / vision input
- [x] Phase 4 — RAG (document upload + retrieval + citations)
- [x] Phase 5 — voice in (Whisper) / out (TTS)
- [x] Phase 6 — settings, health check & polish

## License

MIT
