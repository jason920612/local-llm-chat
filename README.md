# Local LLM Chat

A private, fully-local multimodal chat web app. It talks to a model running in
**LM Studio** (or any `llama.cpp` server exposing an OpenAI-compatible API) — no
data leaves your machine, no cloud API keys.

> Built with non-Chinese, open models. Default chat model is Google **Gemma 3 4B**
> (vision-capable); RAG embeddings use **nomic-embed-text**.

## Features

- 💬 **Streaming chat** with markdown + code rendering
- 🖼️ **Vision / image input** — drop an image and ask about it (multimodal)
- 📄 **RAG** — upload PDF / text / markdown, chat grounded in your documents with citations
- 🎙️ **Voice** — speech-to-text via Whisper (runs in your browser), text-to-speech via OS voices
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
4. **Verify gate (optional, blocking mode)** — a structured audit of the draft against
   the SOP checklist, with one corrective regeneration before output.

Toggle via env (`SOP_INTENT_GATE`, `SOP_BLOCKING`, `SOP_VERIFY_GATE`). The system
prompt still states the rules, but the gates above are what actually enforce them.

## Prerequisites

1. **[LM Studio](https://lmstudio.ai/)** (or `llama.cpp` server).
2. In LM Studio, download and load:
   - A chat model — recommended **`gemma-3-4b-it`** (vision-capable, ~8GB VRAM friendly).
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
