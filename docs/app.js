/* Static Grok chat — browser-only. Talks directly to the xAI API with a
 * user-supplied key. Tools: web/x search (server-side), generate_image, and
 * run_code via Pyodide (Python WASM). History in localStorage. */
"use strict";

const XAI = "https://api.x.ai/v1";
const LS = {
  key: "xai_key",
  model: "xai_model",
  sandbox: "xai_sandbox",
  convos: "xai_convos",
  rag: "xai_rag",
};
const MEDIA_RE = /\[\[(image|video|file):([^\]\n]+)\]\]/g;

const $ = (id) => document.getElementById(id);
const state = {
  key: localStorage.getItem(LS.key) || "",
  model: localStorage.getItem(LS.model) || "grok-build-0.1",
  sandbox: localStorage.getItem(LS.sandbox) === "1",
  useRag: localStorage.getItem(LS.rag) === "1",
  convos: JSON.parse(localStorage.getItem(LS.convos) || "[]"),
  activeId: null,
  recorder: null,
  recording: false,
  curAudio: null,
  rt: null,
  attachments: [], // {dataUrl} images for vision
  uploads: [], // {name} files written to pyodide FS
  streaming: false,
  abort: null,
};

const SYSTEM = `You are Grok, a helpful AI assistant running in a static web app.
- Reply in the user's language.
- You can search X and the web automatically when a question needs real-time info; cite sources with [n].
- generate_image: create an image from a prompt. After it succeeds, place it inline by writing a marker on its own line: [[image:N]] (N = the image number from the tool result). Do not output image markdown yourself.
- run_code: execute Python in a sandbox; files you create are shown to the user (place inline with [[file:name]]).
Be direct and useful.`;

/* ---------- Skills framework (Claude-style) ----------
 * The model sees a compact list (name + description) appended to its
 * instructions, and loads a full playbook ON DEMAND via the use_skill tool.
 * Static flavor: Python (Pyodide) instead of ripgrep/bash; clone via GitHub API. */
const SKILLS = {
  "explore-codebase": {
    description:
      "Efficiently explore a code/text repo in the sandbox using structured search (Python os.walk + re), not by reading every file. Use to find where something is defined/used across many files.",
    body: `# Explore a codebase efficiently (Python sandbox)

There is no shell here — use the run_code Python tool to search. NEVER read files
one by one. Search first, then read only matching lines.

1. Map the tree (no file contents yet):
\`\`\`python
import os
for root, dirs, files in os.walk("repo"):
    dirs[:] = [d for d in dirs if d != ".git"]
    print(root + "/", len(files), "files")
\`\`\`

2. Grep by content with a regex, printing file:line:
\`\`\`python
import os, re
pat = re.compile(r"search_term")
for root, dirs, files in os.walk("repo"):
    dirs[:] = [d for d in dirs if d != ".git"]
    for f in files:
        p = os.path.join(root, f)
        try:
            for i, line in enumerate(open(p, encoding="utf-8", errors="ignore"), 1):
                if pat.search(line):
                    print(f"{p}:{i}: {line.rstrip()[:160]}")
        except Exception:
            pass
\`\`\`

3. Read ONLY the relevant slice of a file (e.g. lines 120-180):
\`\`\`python
print("".join(open("repo/path.py", encoding="utf-8", errors="ignore").readlines()[119:180]))
\`\`\`

4. Read the README / package.json / pyproject first to understand structure.
5. Narrow iteratively: list files → grep → read exact lines. Cap output (slice
   lines, limit matches) so you don't flood context.

Rules: structured search only; if a repo is on GitHub and not local yet, use the
clone-github skill first.`,
  },
  "clone-github": {
    description:
      "Fetch a GitHub repo into the sandbox (via the GitHub API) so you can explore its real files, instead of guessing. Use when the user gives a repo URL or asks you to look at a project.",
    body: `# Clone a GitHub repo, then explore it

When the user points you at a repository, bring the real files into the sandbox —
do not answer from memory or web snippets.

1. Use the clone_repo tool with the repo URL (https://github.com/owner/repo or
   owner/repo). It downloads the files into the Python sandbox under a folder named
   after the repo and returns the file tree. (It uses the GitHub API; very large
   repos are truncated.)
2. Then use the explore-codebase skill: run_code Python to os.walk + regex-search
   the cloned folder, reading only relevant lines.
3. Answer from what you actually read, citing concrete files and line numbers. If
   something isn't in the repo, say so.

Rules: after cloning, immediately switch to efficient structured search — the
point of cloning is local search, not reading everything.`,
  },
};

/** Compact skills list appended to instructions when the sandbox is on. */
function skillsBlock() {
  const names = Object.keys(SKILLS);
  if (!names.length) return "";
  const list = names.map((n) => `- ${n}: ${SKILLS[n].description}`).join("\n");
  return `

# SKILLS — load a playbook before doing the matching task
When the request matches a skill, FIRST call use_skill with its name to load the
full playbook, THEN follow it. Available skills:
${list}

Hard rules:
- Search/explore a codebase or many files → load "explore-codebase" and search structurally (Python os.walk + re via run_code), never read every file.
- User gives a GitHub repo / asks to look at a project → load "clone-github", then clone_repo it, then explore.`;
}

/* ---------- persistence ---------- */
function saveConvos() {
  localStorage.setItem(LS.convos, JSON.stringify(state.convos));
}
function activeConvo() {
  return state.convos.find((c) => c.id === state.activeId) || null;
}
function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ---------- markdown rendering ---------- */
marked.setOptions({ breaks: false, gfm: true });

function mdToHtml(text) {
  return DOMPurify.sanitize(marked.parse(text || ""), {
    ADD_ATTR: ["target"],
  });
}

function enhance(container, onImg) {
  container.querySelectorAll("pre").forEach((pre) => {
    pre.querySelectorAll("code").forEach((c) => {
      try {
        window.hljs.highlightElement(c);
      } catch {}
    });
    const codeText = pre.innerText; // capture before adding the button
    const btn = document.createElement("button");
    btn.className = "copy-btn";
    btn.textContent = "複製";
    btn.onclick = () => {
      navigator.clipboard.writeText(codeText);
      btn.textContent = "已複製";
      setTimeout(() => (btn.textContent = "複製"), 1200);
    };
    pre.appendChild(btn);
  });
  container.querySelectorAll("img").forEach((img) => {
    img.onclick = () => onImg(img.src);
  });
}

/* Build the interleaved body (text + inline media) for an assistant message. */
function renderAssistantBody(bodyEl, msg) {
  bodyEl.innerHTML = "";

  if (msg.thinking && msg.thinking.trim()) {
    const d = document.createElement("details");
    d.className = "panel";
    d.innerHTML = `<summary>💭 思考過程</summary><div class="panel-body"></div>`;
    d.querySelector(".panel-body").textContent = msg.thinking;
    bodyEl.appendChild(d);
  }
  if (msg.toolCalls && msg.toolCalls.length) {
    const labels = {
      web_search: "🔍 網路搜尋",
      x_search: "𝕏 搜尋",
      search: "🔍 搜尋",
      generate_image: "🖼 生成圖片",
      generate_video: "🎬 生成影片",
      run_code: "▶ 執行 Python",
      use_skill: "📖 載入技能",
      clone_repo: "📦 拉取倉庫",
    };
    const d = document.createElement("details");
    d.className = "panel";
    const names = msg.toolCalls.map((t) => labels[t.tool] || t.tool).join("、");
    d.innerHTML = `<summary>🔧 已呼叫 ${msg.toolCalls.length} 個工具：${names}</summary><div class="panel-body"></div>`;
    const pb = d.querySelector(".panel-body");
    msg.toolCalls.forEach((t) => {
      const pre = document.createElement("pre");
      pre.textContent =
        (labels[t.tool] || t.tool) +
        (t.args && Object.keys(t.args).length
          ? "\n" + JSON.stringify(t.args, null, 2).slice(0, 1200)
          : "");
      pb.appendChild(pre);
    });
    bodyEl.appendChild(d);
  }

  const usedImg = new Set(),
    usedVid = new Set(),
    usedFile = new Set();
  const text = msg.content || "";
  let last = 0,
    m;
  MEDIA_RE.lastIndex = 0;
  const pushText = (seg) => {
    seg = seg.replace(/(?:image|video|file)\s*[:：]\s*$/i, "");
    if (!seg.trim()) return;
    const div = document.createElement("div");
    div.className = "md";
    div.innerHTML = mdToHtml(seg);
    enhance(div, openLightbox);
    bodyEl.appendChild(div);
  };
  while ((m = MEDIA_RE.exec(text))) {
    pushText(text.slice(last, m.index));
    const ref = m[2].trim();
    if (m[1] === "image") {
      const i = parseInt(ref, 10) - 1;
      if (msg.images && msg.images[i]) {
        usedImg.add(i);
        bodyEl.appendChild(imgEl(msg.images[i]));
      }
    } else if (m[1] === "video") {
      const i = parseInt(ref, 10) - 1;
      if (msg.videos && msg.videos[i]) {
        usedVid.add(i);
        bodyEl.appendChild(vidEl(msg.videos[i]));
      }
    } else {
      const f = (msg.files || []).find((x) => x.name === ref);
      if (f) {
        usedFile.add(f.name);
        bodyEl.appendChild(fileEl(f));
      }
    }
    last = m.index + m[0].length;
  }
  pushText(text.slice(last));
  if (!bodyEl.childNodes.length && msg.content === "" && state.streaming) {
    // placeholder while streaming
  }
  // leftover media
  (msg.images || []).forEach((s, i) => {
    if (!usedImg.has(i)) bodyEl.appendChild(imgEl(s));
  });
  (msg.videos || []).forEach((s, i) => {
    if (!usedVid.has(i)) bodyEl.appendChild(vidEl(s));
  });
  (msg.files || []).forEach((f) => {
    if (!usedFile.has(f.name)) bodyEl.appendChild(fileEl(f));
  });
}

function imgEl(src) {
  const img = document.createElement("img");
  img.src = src;
  img.className = "gen-img";
  img.style.cssText =
    "max-height:18rem;border-radius:10px;border:1px solid var(--border);cursor:zoom-in;margin:.5rem 0;display:block";
  img.onclick = () => openLightbox(src);
  return img;
}
function vidEl(src) {
  const v = document.createElement("video");
  v.src = src;
  v.controls = true;
  v.style.cssText =
    "max-height:18rem;border-radius:10px;border:1px solid var(--border);margin:.5rem 0;display:block";
  return v;
}
function fileEl(f) {
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "display:flex;gap:8px;align-items:center;border:1px solid var(--border);background:var(--surface2);border-radius:10px;padding:6px 10px;font-size:12px;margin:.4rem 0";
  wrap.innerHTML = `<span style="color:var(--accent)">📄</span><span style="flex:1;font-family:monospace;overflow:hidden;text-overflow:ellipsis">${f.name}</span>`;
  const a = document.createElement("a");
  a.textContent = "下載";
  a.style.color = "var(--accent)";
  a.href = URL.createObjectURL(
    new Blob([f.bytes || f.text || ""], { type: "application/octet-stream" }),
  );
  a.download = f.name;
  wrap.appendChild(a);
  if (f.text != null) {
    const v = document.createElement("button");
    v.textContent = "檢視";
    v.style.cssText = "background:none;border:none;color:var(--accent)";
    v.onclick = () => alert(f.text.slice(0, 5000));
    wrap.appendChild(v);
  }
  return wrap;
}

/* ---------- conversation list + messages ---------- */
function renderSidebar() {
  const list = $("convo-list");
  list.innerHTML = "";
  state.convos.forEach((c) => {
    const el = document.createElement("div");
    el.className = "convo" + (c.id === state.activeId ? " active" : "");
    el.innerHTML = `<span class="title">💬 ${c.title || "新對話"}</span><button class="del">🗑</button>`;
    el.querySelector(".title").onclick = () => selectConvo(c.id);
    el.querySelector(".del").onclick = (e) => {
      e.stopPropagation();
      state.convos = state.convos.filter((x) => x.id !== c.id);
      if (state.activeId === c.id) state.activeId = null;
      saveConvos();
      renderSidebar();
      renderMessages();
    };
    list.appendChild(el);
  });
}

function renderMessages() {
  const root = $("messages");
  root.innerHTML = "";
  const convo = activeConvo();
  $("convo-title").textContent = convo ? convo.title || "新對話" : "新對話";
  if (!convo || !convo.messages.length) {
    root.innerHTML = `<div class="empty"><h2>Grok Chat（純靜態）</h2><p>瀏覽器直連 xAI。先到 ⚙ 設定填入你的 API key，再開始對話。</p></div>`;
    return;
  }
  convo.messages.forEach((msg) => root.appendChild(renderMsg(msg)));
  root.scrollTop = root.scrollHeight;
}

function renderMsg(msg) {
  const el = document.createElement("div");
  el.className = "msg " + msg.role;
  el.innerHTML = `<div class="avatar">${msg.role === "user" ? "🧑" : "🤖"}</div><div class="body"><div class="role">${msg.role === "user" ? "You" : "Grok"}</div><div class="content"></div></div>`;
  const content = el.querySelector(".content");
  if (msg.role === "user") {
    if (msg.images && msg.images.length) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px";
      msg.images.forEach((s) => row.appendChild(imgEl(s)));
      content.appendChild(row);
    }
    const p = document.createElement("div");
    p.className = "md";
    p.innerHTML = mdToHtml(msg.content);
    enhance(p, openLightbox);
    content.appendChild(p);
  } else {
    renderAssistantBody(content, msg);
    if (msg.content && !state.streaming) {
      const rb = document.createElement("button");
      rb.className = "read-btn";
      rb.textContent = "🔊";
      rb.title = "朗讀";
      rb.onclick = () =>
        speakText(msg.content.replace(MEDIA_RE, "").replace(/\[\d+\]/g, ""), rb);
      el.querySelector(".role").appendChild(rb);
    }
  }
  msg._el = content; // for live updates
  return el;
}

/* ---------- xAI Responses agent (streaming + tools) ---------- */
function toInput(messages) {
  return messages.map((m) => {
    if (m.role === "user" && m.images && m.images.length) {
      return {
        role: "user",
        content: [
          { type: "input_text", text: m.content },
          ...m.images.map((url) => ({ type: "input_image", image_url: url })),
        ],
      };
    }
    return { role: m.role, content: m.content };
  });
}

function tools() {
  const t = [{ type: "web_search" }, { type: "x_search" }];
  t.push({
    type: "function",
    name: "generate_image",
    description:
      "Generate an image from a text prompt. Returns an image shown to the user.",
    parameters: {
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
    },
  });
  t.push({
    type: "function",
    name: "generate_video",
    description:
      "Generate a short (~6s) video from a text prompt (auto-creates a still image then animates it). Use only when the user explicitly asks for a video. Takes a couple of minutes.",
    parameters: {
      type: "object",
      properties: { prompt: { type: "string" } },
      required: ["prompt"],
    },
  });
  if (state.sandbox) {
    t.push({
      type: "function",
      name: "run_code",
      description:
        "Execute Python code in a browser sandbox (Pyodide). Returns stdout/stderr; files you create are shown to the user.",
      parameters: {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"],
      },
    });
    t.push({
      type: "function",
      name: "clone_repo",
      description:
        "Download a GitHub repository into the sandbox (via the GitHub API) and get back its file tree, so you can explore the real files with run_code. Use when the user gives a repo URL or asks you to look at a project.",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description:
              "Repo reference: https://github.com/owner/repo or owner/repo.",
          },
        },
        required: ["url"],
      },
    });
    t.push({
      type: "function",
      name: "use_skill",
      description:
        "Load the full step-by-step playbook for a named skill before doing the matching task. Call this FIRST when the request matches an available skill (see the SKILLS section of your instructions).",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    });
  }
  return t;
}

async function* sse(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("");
      if (!data || data === "[DONE]") continue;
      try {
        yield JSON.parse(data);
      } catch {}
    }
  }
}

async function generateImage(prompt) {
  const r = await fetch(`${XAI}/images/generations`, {
    method: "POST",
    headers: authJson(),
    body: JSON.stringify({ model: "grok-imagine-image-quality", prompt, n: 1 }),
  });
  if (!r.ok) throw new Error("images " + r.status);
  const d = await r.json();
  const it = d.data[0];
  return it.url || "data:image/jpeg;base64," + it.b64_json;
}

function authJson() {
  return {
    "Content-Type": "application/json",
    Authorization: "Bearer " + state.key,
  };
}

async function runAgent(convo, assistant, instructions) {
  const cacheKey = "conv:" + convo.id;
  let body = {
    model: state.model,
    instructions: instructions || SYSTEM,
    input: toInput(convo.messages.filter((m) => m !== assistant)),
    tools: tools(),
    stream: true,
    prompt_cache_key: cacheKey,
  };
  const seenServer = new Set();
  let answered = false;

  for (let round = 0; round < 6; round++) {
    const res = await fetch(`${XAI}/responses`, {
      method: "POST",
      headers: authJson(),
      body: JSON.stringify(body),
      signal: state.abort.signal,
    });
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => "");
      throw new Error(`xAI ${res.status}: ${t.slice(0, 200)}`);
    }
    const fns = {};
    let respId;
    for await (const ev of sse(res.body)) {
      const ty = ev.type;
      if (ty === "response.output_text.delta") {
        assistant.content += ev.delta || "";
        updateLive(assistant);
      } else if (
        ty === "response.reasoning_text.delta" ||
        ty === "response.reasoning_summary_text.delta"
      ) {
        assistant.thinking = (assistant.thinking || "") + (ev.delta || "");
        updateLive(assistant);
      } else if (ty === "response.output_item.added") {
        const it = ev.item;
        if (it && it.type === "function_call" && it.id)
          fns[it.id] = { call_id: it.call_id || "", name: it.name, args: "" };
        else if (it && it.type === "web_search_call") traceTool(assistant, "web_search");
        else if (it && it.type === "x_search_call") traceTool(assistant, "x_search");
      } else if (ty === "response.function_call_arguments.delta") {
        if (fns[ev.item_id]) fns[ev.item_id].args += ev.delta || "";
      } else if (ty === "response.completed") {
        respId = ev.response && ev.response.id;
        const cites = ev.response && ev.response.citations;
        if (Array.isArray(cites) && cites.length) {
          // append a sources list to the answer
          assistant._cites = cites;
        }
        const out = (ev.response && ev.response.output) || [];
        out.forEach((it) => {
          if (it.type === "web_search_call") traceTool(assistant, "web_search");
          else if (it.type === "x_search_call") traceTool(assistant, "x_search");
        });
        const used =
          ev.response &&
          ev.response.usage &&
          ev.response.usage.num_server_side_tools_used;
        if (used > 0 && !seenServer.has("web_search") && !seenServer.has("x_search"))
          traceTool(assistant, "search");
      }
    }

    const calls = Object.values(fns);
    if (!calls.length) {
      answered = true;
      break;
    }
    const outputs = [];
    for (const c of calls) {
      let args = {};
      try {
        args = JSON.parse(c.args || "{}");
      } catch {}
      let out = "";
      if (c.name === "generate_image") {
        traceTool(assistant, "generate_image", { prompt: args.prompt });
        try {
          assistant.images = assistant.images || [];
          assistant.images.push(await generateImage(args.prompt || ""));
          out = `Image #${assistant.images.length} generated. Place it with [[image:${assistant.images.length}]].`;
        } catch (e) {
          out = "generate_image failed: " + e.message;
        }
      } else if (c.name === "generate_video") {
        traceTool(assistant, "generate_video", { prompt: args.prompt });
        try {
          assistant.videos = assistant.videos || [];
          assistant.videos.push(await generateVideo(args.prompt || ""));
          out = `Video #${assistant.videos.length} generated. Place it with [[video:${assistant.videos.length}]].`;
        } catch (e) {
          out = "generate_video failed: " + e.message;
        }
      } else if (c.name === "run_code") {
        traceTool(assistant, "run_code", { code: args.code });
        const r = await runPython(args.code || "");
        assistant.files = (assistant.files || []).concat(r.files);
        out =
          `exit: ${r.error ? "error" : 0}\n` +
          (r.stdout ? "stdout:\n" + r.stdout : "stdout: (empty)") +
          (r.stderr ? "\nstderr:\n" + r.stderr : "") +
          (r.error ? "\nerror: " + r.error : "") +
          (r.files.length
            ? "\nfiles: " +
              r.files.map((f) => f.name).join(", ") +
              " (place with [[file:NAME]])"
            : "");
      } else if (c.name === "use_skill") {
        traceTool(assistant, "use_skill", { name: args.name });
        const sk = SKILLS[(args.name || "").trim()];
        out = sk
          ? `Skill "${args.name}" loaded. Follow this playbook:\n\n${sk.body}`
          : `Unknown skill: ${args.name || ""}`;
      } else if (c.name === "clone_repo") {
        traceTool(assistant, "clone_repo", { url: args.url });
        const r = await cloneRepoBrowser(args.url || "");
        out = r.ok
          ? `Cloned into "${r.dir}/". Top-level tree:\n${r.tree}\n\nNow explore it with run_code (os.walk + regex over "${r.dir}"). Do NOT read every file.`
          : `clone_repo failed: ${r.error || "error"}`;
      } else out = "unknown tool";
      outputs.push({ type: "function_call_output", call_id: c.call_id, output: out });
      updateLive(assistant);
    }
    body = {
      model: state.model,
      tools: tools(),
      input: outputs,
      previous_response_id: respId,
      stream: true,
      prompt_cache_key: cacheKey,
    };
  }

  // Hit the round cap still calling tools → force one final answer (no tools).
  if (!answered && !assistant.content) {
    body.tool_choice = "none";
    try {
      const res = await fetch(`${XAI}/responses`, {
        method: "POST",
        headers: authJson(),
        body: JSON.stringify(body),
        signal: state.abort.signal,
      });
      if (res.ok && res.body) {
        for await (const ev of sse(res.body)) {
          if (ev.type === "response.output_text.delta") {
            assistant.content += ev.delta || "";
            updateLive(assistant);
          } else if (
            ev.type === "response.reasoning_text.delta" ||
            ev.type === "response.reasoning_summary_text.delta"
          ) {
            assistant.thinking = (assistant.thinking || "") + (ev.delta || "");
            updateLive(assistant);
          } else if (ev.type === "response.completed") {
            const c = ev.response && ev.response.citations;
            if (Array.isArray(c) && c.length) assistant._cites = c;
          }
        }
      }
    } catch {}
  }
  if (
    !assistant.content &&
    !(assistant.images && assistant.images.length) &&
    !(assistant.videos && assistant.videos.length)
  ) {
    assistant.content = "（未取得回覆，請再試一次或換個說法）";
  }

  if (assistant._cites && assistant._cites.length) {
    const lines = assistant._cites
      .map((c, i) => `[${i + 1}] ${typeof c === "string" ? c : c.url || ""}`)
      .join("\n");
    assistant.content += `\n\n---\n**Sources**\n${lines}`;
  }
}

function traceTool(assistant, tool, args) {
  assistant.toolCalls = assistant.toolCalls || [];
  if (tool === "web_search" || tool === "x_search" || tool === "search") {
    if (assistant.toolCalls.some((t) => t.tool === tool)) return;
  }
  assistant.toolCalls.push({ tool, args });
  updateLive(assistant);
}

let liveRaf = 0;
function updateLive(assistant) {
  if (liveRaf) return;
  liveRaf = requestAnimationFrame(() => {
    liveRaf = 0;
    if (assistant._el) renderAssistantBody(assistant._el, assistant);
    const root = $("messages");
    root.scrollTop = root.scrollHeight;
  });
}

/* ---------- Pyodide (Python sandbox) ---------- */
let pyodidePromise = null;
function loadPyodide_() {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      await new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/pyodide/v0.26.2/full/pyodide.js";
        s.onload = res;
        s.onerror = rej;
        document.head.appendChild(s);
      });
      return window.loadPyodide({
        indexURL: "https://cdn.jsdelivr.net/pyodide/v0.26.2/full/",
      });
    })();
  }
  return pyodidePromise;
}

async function runPython(code) {
  let py;
  try {
    py = await loadPyodide_();
  } catch (e) {
    return { stdout: "", stderr: "", error: "Pyodide 載入失敗", files: [] };
  }
  // write any uploaded files into the FS
  for (const u of state.uploads) {
    try {
      py.FS.writeFile("/home/pyodide/" + u.name, u.bytes);
    } catch {}
  }
  const before = new Set(listPyFiles(py));
  let stdout = "",
    stderr = "",
    error = "";
  py.setStdout({ batched: (s) => (stdout += s + "\n") });
  py.setStderr({ batched: (s) => (stderr += s + "\n") });
  try {
    await py.runPythonAsync(code);
  } catch (e) {
    error = String(e.message || e).slice(0, 2000);
  }
  const files = [];
  for (const name of listPyFiles(py)) {
    if (before.has(name)) continue;
    try {
      const bytes = py.FS.readFile("/home/pyodide/" + name);
      let text = null;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        text = null;
      }
      files.push({ name, bytes, text });
    } catch {}
  }
  return { stdout: stdout.slice(0, 20000), stderr: stderr.slice(0, 20000), error, files };
}
function listPyFiles(py) {
  try {
    return py.FS.readdir("/home/pyodide").filter((n) => n !== "." && n !== "..");
  } catch {
    return [];
  }
}

/* Normalize a repo reference into {owner, repo, branch?}. */
function parseRepo(input) {
  let s = (input || "").trim().replace(/\.git$/, "");
  const m = s.match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\/tree\/([^/]+))?\/?$/);
  if (m) return { owner: m[1], repo: m[2], branch: m[3] };
  const short = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (short) return { owner: short[1], repo: short[2] };
  return null;
}

/* Download a GitHub repo into the Pyodide FS (via the GitHub API) and return its
 * tree. Limits file count/size so the browser and context stay sane. */
async function cloneRepoBrowser(url) {
  const r = parseRepo(url);
  if (!r) return { ok: false, dir: "", tree: "", error: "invalid repo: " + url };
  let py;
  try {
    py = await loadPyodide_();
  } catch {
    return { ok: false, dir: "", tree: "", error: "Pyodide 載入失敗" };
  }
  const api = `https://api.github.com/repos/${r.owner}/${r.repo}`;
  try {
    let branch = r.branch;
    if (!branch) {
      const meta = await fetch(api);
      if (!meta.ok) throw new Error("repo not found (" + meta.status + ")");
      branch = (await meta.json()).default_branch || "main";
    }
    const tr = await fetch(`${api}/git/trees/${branch}?recursive=1`);
    if (!tr.ok) throw new Error("tree fetch " + tr.status);
    const data = await tr.json();
    const blobs = (data.tree || []).filter(
      (n) => n.type === "blob" && n.size != null && n.size < 200000,
    );
    const MAX = 250;
    const picked = blobs.slice(0, MAX);
    const dir = r.repo.replace(/[^A-Za-z0-9._-]/g, "_") || "repo";
    const base = "/home/pyodide/" + dir;
    // Fetch raw file contents in parallel batches and write into the FS.
    let written = 0;
    const batch = 12;
    for (let i = 0; i < picked.length; i += batch) {
      const slice = picked.slice(i, i + batch);
      await Promise.all(
        slice.map(async (n) => {
          try {
            const raw = await fetch(
              `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${branch}/${n.path}`,
            );
            if (!raw.ok) return;
            const buf = new Uint8Array(await raw.arrayBuffer());
            const full = base + "/" + n.path;
            const parts = full.split("/");
            let cur = "";
            for (let k = 1; k < parts.length - 1; k++) {
              cur += "/" + parts[k];
              try {
                py.FS.mkdir(cur);
              } catch {}
            }
            py.FS.writeFile(full, buf);
            written++;
          } catch {}
        }),
      );
    }
    // Build a compact top-level tree from the API listing.
    const top = new Set();
    (data.tree || []).forEach((n) => {
      const seg = n.path.split("/");
      top.add(seg[0] + (seg.length > 1 || n.type === "tree" ? "/" : ""));
    });
    const tree =
      `${dir}/\n` +
      [...top]
        .sort()
        .slice(0, 60)
        .map((t) => "  " + t)
        .join("\n") +
      (data.truncated || blobs.length > MAX
        ? `\n  …(truncated; ${written}/${blobs.length} files downloaded)`
        : `\n  (${written} files downloaded)`);
    return { ok: true, dir, tree };
  } catch (e) {
    return { ok: false, dir: "", tree: "", error: String(e.message || e) };
  }
}

/* ---------- send flow ---------- */
async function send() {
  const inputEl = $("input");
  const text = inputEl.value.trim();
  if ((!text && !state.attachments.length) || state.streaming) return;
  if (!state.key) {
    openSettings();
    return;
  }
  let convo = activeConvo();
  if (!convo) {
    convo = { id: newId(), title: text.slice(0, 40) || "新對話", messages: [] };
    state.convos.unshift(convo);
    state.activeId = convo.id;
  }
  const fileNote = state.uploads.length
    ? `\n\n[已上傳檔案（工作目錄）：${state.uploads.map((u) => u.name).join(", ")}]`
    : "";
  const userMsg = {
    role: "user",
    content: text + fileNote,
    images: state.attachments.map((a) => a.dataUrl),
  };
  convo.messages.push(userMsg);
  const assistant = { role: "assistant", content: "" };
  convo.messages.push(assistant);
  inputEl.value = "";
  inputEl.style.height = "auto";
  state.attachments = [];
  renderAttachments();
  if (!convo.title || convo.title === "新對話")
    convo.title = text.slice(0, 40) || "新對話";

  state.streaming = true;
  state.abort = new AbortController();
  $("send-btn").hidden = true;
  $("stop-btn").hidden = false;
  renderSidebar();
  renderMessages();

  // Skills depend on the sandbox tools (run_code/clone_repo), so only advertise
  // them when the sandbox is enabled.
  let instructions = state.sandbox ? SYSTEM + skillsBlock() : SYSTEM;
  if (state.useRag) {
    try {
      const ctx = await retrieveRag(text);
      if (ctx)
        instructions +=
          `\n\n# RETRIEVED CONTEXT (use ONLY this for facts; cite [n]; if it lacks the answer, say so)\n${ctx}`;
    } catch (e) {
      console.warn("RAG retrieve failed", e);
    }
  }

  try {
    await runAgent(convo, assistant, instructions);
  } catch (e) {
    if (e.name !== "AbortError")
      assistant.content += `\n\n> ⚠️ 錯誤：${e.message}`;
  } finally {
    state.streaming = false;
    state.uploads = [];
    $("send-btn").hidden = false;
    $("stop-btn").hidden = true;
    if (assistant._el) renderAssistantBody(assistant._el, assistant);
    saveConvos();
  }
}

/* ---------- files / attachments ---------- */
function fileToDataUrl(file) {
  return new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.readAsDataURL(file);
  });
}
async function handleFiles(files) {
  for (const f of files) {
    if (f.type.startsWith("image/")) {
      state.attachments.push({ dataUrl: await fileToDataUrl(f) });
    } else {
      const buf = new Uint8Array(await f.arrayBuffer());
      state.uploads.push({ name: f.name.replace(/[^\w.-]/g, "_"), bytes: buf });
    }
  }
  renderAttachments();
}
function renderAttachments() {
  const root = $("attachments");
  root.innerHTML = "";
  state.attachments.forEach((a, i) => {
    const img = document.createElement("img");
    img.src = a.dataUrl;
    img.title = "點擊移除";
    img.onclick = () => {
      state.attachments.splice(i, 1);
      renderAttachments();
    };
    root.appendChild(img);
  });
  state.uploads.forEach((u, i) => {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.innerHTML = `📄 ${u.name} `;
    const b = document.createElement("button");
    b.textContent = "✕";
    b.onclick = () => {
      state.uploads.splice(i, 1);
      renderAttachments();
    };
    chip.appendChild(b);
    root.appendChild(chip);
  });
}

/* ---------- settings / lightbox ---------- */
function openSettings() {
  $("key-input").value = state.key;
  $("model-input").value = state.model;
  $("sandbox-toggle").checked = state.sandbox;
  $("settings-modal").hidden = false;
}
function openLightbox(src) {
  $("lightbox-img").src = src;
  $("lightbox").hidden = false;
}
function selectConvo(id) {
  state.activeId = id;
  renderSidebar();
  renderMessages();
  closeSidebar();
}
function closeSidebar() {
  $("sidebar").classList.remove("open");
  $("sb-backdrop").classList.remove("show");
}

/* ---------- helpers ---------- */
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = res;
    s.onerror = rej;
    document.head.appendChild(s);
  });
}

/* ---------- video generation (image -> video, async poll) ---------- */
async function generateVideo(prompt) {
  const image = await generateImage(prompt); // grok video is image-to-video
  const start = await fetch(`${XAI}/videos/generations`, {
    method: "POST",
    headers: authJson(),
    body: JSON.stringify({
      model: "grok-imagine-video-1.5-preview",
      prompt,
      image: { url: image },
      duration: 6,
      resolution: "720p",
      aspect_ratio: "16:9",
    }),
  });
  if (!start.ok) throw new Error("videos " + start.status);
  const { request_id } = await start.json();
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5000));
    const p = await fetch(`${XAI}/videos/${request_id}`, { headers: authJson() });
    if (!p.ok) continue;
    const d = await p.json();
    if (d.status === "done" && d.video && d.video.url) return d.video.url;
    if (d.status === "failed" || d.status === "expired")
      throw new Error("video " + d.status);
  }
  throw new Error("video timed out");
}

/* ---------- TTS ---------- */
async function speakText(text, btn) {
  if (!text || !text.trim()) return;
  stopSpeaking();
  if (btn) btn.textContent = "⏳";
  try {
    const r = await fetch(`${XAI}/tts`, {
      method: "POST",
      headers: authJson(),
      body: JSON.stringify({ text: text.slice(0, 8000), voice_id: "eve", language: "auto" }),
    });
    if (!r.ok) throw new Error("tts " + r.status);
    const url = URL.createObjectURL(await r.blob());
    const audio = new Audio(url);
    state.curAudio = audio;
    audio.onended = audio.onerror = () => {
      URL.revokeObjectURL(url);
      if (btn) btn.textContent = "🔊";
    };
    audio.onplay = () => btn && (btn.textContent = "⏹");
    await audio.play();
  } catch (e) {
    if (btn) btn.textContent = "🔊";
    console.warn("TTS failed", e);
  }
}
function stopSpeaking() {
  if (state.curAudio) {
    state.curAudio.pause();
    state.curAudio = null;
  }
}

/* ---------- STT (record -> WAV -> /v1/stt) ---------- */
function encodeWav(samples, sr) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); ws(8, "WAVE");
  ws(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, "data"); v.setUint32(40, samples.length * 2, true);
  let o = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
  }
  return new Blob([v], { type: "audio/wav" });
}
async function blobToWav(blob) {
  const buf = await blob.arrayBuffer();
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const decoded = await ctx.decodeAudioData(buf);
  await ctx.close();
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
  const src = off.createBufferSource();
  src.buffer = decoded; src.connect(off.destination); src.start();
  const rendered = await off.startRendering();
  return encodeWav(rendered.getChannelData(0), 16000);
}
async function transcribeAudio(blob) {
  let wav;
  try { wav = await blobToWav(blob); } catch { wav = blob; }
  const fd = new FormData();
  fd.append("file", wav, "audio.wav");
  const r = await fetch(`${XAI}/stt`, {
    method: "POST",
    headers: { Authorization: "Bearer " + state.key },
    body: fd,
  });
  if (!r.ok) throw new Error("stt " + r.status);
  const d = await r.json();
  return (d.text || "").trim();
}
async function toggleRecording() {
  const btn = $("mic-btn");
  if (state.recording) {
    state.recorder && state.recorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mr = new MediaRecorder(stream);
    const chunks = [];
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      state.recording = false;
      btn.classList.remove("rec");
      btn.textContent = "⏳";
      try {
        const txt = await transcribeAudio(new Blob(chunks, { type: mr.mimeType || "audio/webm" }));
        if (txt) {
          const inp = $("input");
          inp.value = inp.value ? inp.value + " " + txt : txt;
          inp.dispatchEvent(new Event("input"));
        }
      } catch (e) {
        alert("語音辨識失敗：" + e.message);
      }
      btn.textContent = "🎙";
    };
    mr.start();
    state.recorder = mr;
    state.recording = true;
    btn.classList.add("rec");
  } catch {
    alert("無法存取麥克風（需 https 或 localhost，並允許權限）");
  }
}

/* ---------- Realtime voice (WebSocket) ---------- */
function f32ToPcm16B64(input) {
  const b = new ArrayBuffer(input.length * 2);
  const v = new DataView(b);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    v.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  let bin = "";
  const u = new Uint8Array(b);
  for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]);
  return btoa(bin);
}
function b64ToF32(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  const v = new DataView(u.buffer);
  const out = new Float32Array(u.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = v.getInt16(i * 2, true) / 0x8000;
  return out;
}
async function openVoice() {
  if (!state.key) return openSettings();
  $("voice-modal").hidden = false;
  const setStatus = (s) => ($("voice-status").textContent = s);
  const orb = $("voice-orb");
  const tr = $("voice-transcript");
  tr.textContent = "";
  setStatus("連線中…");
  const SR = 24000;
  let ws, ctx, playCtx, playHead = 0, stream, node;
  const close = () => {
    try { node && node.disconnect(); } catch {}
    try { stream && stream.getTracks().forEach((t) => t.stop()); } catch {}
    try { ctx && ctx.close(); } catch {}
    try { playCtx && playCtx.close(); } catch {}
    try { ws && ws.close(); } catch {}
    state.rt = null;
  };
  state.rt = { close };
  try {
    const tk = await fetch(`${XAI}/realtime/client_secrets`, {
      method: "POST",
      headers: authJson(),
      body: JSON.stringify({ expires_after: { seconds: 300 } }),
    }).then((r) => r.json());
    if (!tk.value) throw new Error("no token");
    ws = new WebSocket("wss://api.x.ai/v1/realtime", ["xai-client-secret." + tk.value]);
    ws.onopen = async () => {
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          model: "grok-voice-latest", voice: "eve",
          modalities: ["audio", "text"],
          input_audio_format: "pcm16", output_audio_format: "pcm16",
          turn_detection: { type: "server_vad" },
        },
      }));
      const Ctx = window.AudioContext || window.webkitAudioContext;
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      ctx = new Ctx({ sampleRate: SR });
      const srcNode = ctx.createMediaStreamSource(stream);
      node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (e) => {
        if (ws.readyState === 1)
          ws.send(JSON.stringify({ type: "input_audio_buffer.append", audio: f32ToPcm16B64(e.inputBuffer.getChannelData(0)) }));
      };
      srcNode.connect(node); node.connect(ctx.destination);
      setStatus("聆聽中…請說話"); orb.className = "voice-orb listening";
    };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "response.output_audio.delta" && m.delta) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!playCtx) playCtx = new Ctx({ sampleRate: SR });
        const data = b64ToF32(m.delta);
        const bufr = playCtx.createBuffer(1, data.length, SR);
        bufr.getChannelData(0).set(data);
        const s = playCtx.createBufferSource(); s.buffer = bufr; s.connect(playCtx.destination);
        playHead = Math.max(playHead, playCtx.currentTime); s.start(playHead); playHead += bufr.duration;
        setStatus("Grok 回應中…"); orb.className = "voice-orb speaking";
      } else if (m.type === "response.output_audio_transcript.delta" && m.delta) {
        tr.textContent += m.delta;
      } else if (m.type === "response.done") {
        setStatus("聆聽中…"); orb.className = "voice-orb listening";
      } else if (m.type === "error") {
        setStatus("錯誤：" + (m.error && m.error.message || ""));
      }
    };
    ws.onerror = () => setStatus("WebSocket 錯誤");
    ws.onclose = () => setStatus("已結束");
  } catch (e) {
    setStatus("無法連線：" + e.message);
  }
}
function closeVoice() {
  if (state.rt) state.rt.close();
  $("voice-modal").hidden = true;
}

/* ---------- RAG (transformers.js embeddings + pdf.js + IndexedDB) ---------- */
let embedderPromise = null;
async function getEmbedder() {
  if (!embedderPromise) {
    embedderPromise = (async () => {
      const mod = await import("https://esm.sh/@huggingface/transformers@3.3.3");
      mod.env.allowLocalModels = false;
      return mod.pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    })();
  }
  return embedderPromise;
}
async function embedText(text) {
  const ex = await getEmbedder();
  const out = await ex(text, { pooling: "mean", normalize: true });
  return Array.from(out.data);
}
function cosine(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d; // vectors are normalized
}
function chunkText(text, size = 1000, overlap = 150) {
  const clean = text.replace(/\s+\n/g, "\n").trim();
  const out = [];
  for (let i = 0; i < clean.length; i += size - overlap)
    out.push(clean.slice(i, i + size));
  return out.filter((c) => c.trim());
}
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open("xai_rag", 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains("chunks"))
        db.createObjectStore("chunks", { keyPath: "id", autoIncrement: true }).createIndex("doc", "docId");
      if (!db.objectStoreNames.contains("docs"))
        db.createObjectStore("docs", { keyPath: "id" });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function idbAll(store) {
  return idb().then((db) => new Promise((res) => {
    const out = [];
    db.transaction(store).objectStore(store).openCursor().onsuccess = (e) => {
      const c = e.target.result;
      if (c) { out.push(c.value); c.continue(); } else res(out);
    };
  }));
}
async function ragDeleteDoc(docId) {
  const db = await idb();
  await new Promise((res) => { const t = db.transaction("docs", "readwrite"); t.objectStore("docs").delete(docId); t.oncomplete = res; });
  await new Promise((res) => {
    const t = db.transaction("chunks", "readwrite");
    const idx = t.objectStore("chunks").index("doc");
    idx.openCursor(IDBKeyRange.only(docId)).onsuccess = (e) => {
      const c = e.target.result;
      if (c) { c.delete(); c.continue(); } else {}
    };
    t.oncomplete = res;
  });
}
async function loadPdfjs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  await loadScript("https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js");
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  return window.pdfjsLib;
}
async function extractText(file) {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
    const pdfjs = await loadPdfjs();
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    let text = "";
    for (let p = 1; p <= pdf.numPages; p++) {
      const page = await pdf.getPage(p);
      const c = await page.getTextContent();
      text += c.items.map((i) => i.str).join(" ") + "\n";
    }
    return text;
  }
  return file.text();
}
async function ingestFiles(files) {
  const st = $("kb-status");
  const db = await idb();
  for (const file of files) {
    st.textContent = `處理中：${file.name}…`;
    let text;
    try { text = await extractText(file); } catch (e) { st.textContent = `${file.name} 解析失敗`; continue; }
    const chunks = chunkText(text);
    const docId = newId();
    await new Promise((res) => { const t = db.transaction("docs", "readwrite"); t.objectStore("docs").put({ id: docId, name: file.name, chunks: chunks.length }); t.oncomplete = res; });
    for (let i = 0; i < chunks.length; i++) {
      st.textContent = `${file.name}：向量化 ${i + 1}/${chunks.length}…`;
      const vec = await embedText(chunks[i]);
      await new Promise((res) => { const t = db.transaction("chunks", "readwrite"); t.objectStore("chunks").add({ docId, docName: file.name, text: chunks[i], vec }); t.oncomplete = res; });
    }
  }
  st.textContent = "完成。";
  renderKbList();
}
async function retrieveRag(query, topK = 4) {
  const chunks = await idbAll("chunks");
  if (!chunks.length || !query.trim()) return "";
  const qv = await embedText(query);
  const scored = chunks
    .map((c) => ({ c, s: cosine(qv, c.vec) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, topK);
  return scored
    .map((x, i) => `[${i + 1}] (來源：${x.c.docName})\n${x.c.text}`)
    .join("\n\n");
}
async function renderKbList() {
  const docs = await idbAll("docs");
  const list = $("kb-list");
  list.innerHTML = "";
  if (!docs.length) { list.innerHTML = '<div class="note">尚無文件。</div>'; return; }
  docs.forEach((d) => {
    const el = document.createElement("div");
    el.className = "doc";
    el.innerHTML = `<span class="name">📄 ${d.name}</span><span class="note">${d.chunks} 塊</span><button>🗑</button>`;
    el.querySelector("button").onclick = async () => { await ragDeleteDoc(d.id); renderKbList(); };
    list.appendChild(el);
  });
}

/* ---------- wiring ---------- */
function init() {
  $("send-btn").onclick = send;
  $("stop-btn").onclick = () => state.abort && state.abort.abort();
  $("new-chat").onclick = () => {
    state.activeId = null;
    renderSidebar();
    renderMessages();
    closeSidebar();
  };
  $("menu-btn").onclick = () => {
    $("sidebar").classList.toggle("open");
    $("sb-backdrop").classList.toggle("show");
  };
  $("sb-backdrop").onclick = closeSidebar;
  $("open-settings").onclick = openSettings;
  $("save-settings").onclick = () => {
    state.key = $("key-input").value.trim();
    state.model = $("model-input").value.trim() || "grok-build-0.1";
    state.sandbox = $("sandbox-toggle").checked;
    localStorage.setItem(LS.key, state.key);
    localStorage.setItem(LS.model, state.model);
    localStorage.setItem(LS.sandbox, state.sandbox ? "1" : "0");
    $("settings-modal").hidden = true;
    updateStatus();
  };
  document.querySelectorAll(".modal-close").forEach((b) => {
    b.onclick = () => {
      const id = b.dataset.close;
      if (id === "voice-modal") return closeVoice();
      if (id) $(id).hidden = true;
      else $("settings-modal").hidden = true;
    };
  });
  $("lightbox").onclick = () => ($("lightbox").hidden = true);

  // voice / STT / RAG
  $("mic-btn").onclick = toggleRecording;
  $("voice-btn").onclick = openVoice;
  $("voice-end").onclick = closeVoice;
  $("rag-btn").onclick = () => {
    $("rag-toggle").checked = state.useRag;
    renderKbList();
    $("kb-modal").hidden = false;
  };
  $("rag-toggle").onchange = (e) => {
    state.useRag = e.target.checked;
    localStorage.setItem(LS.rag, state.useRag ? "1" : "0");
    updateRagBtn();
  };
  $("kb-upload").onclick = () => $("kb-file").click();
  $("kb-file").onchange = (e) => {
    ingestFiles([...e.target.files]);
    e.target.value = "";
  };
  updateRagBtn();

  const inp = $("input");
  inp.addEventListener("input", () => {
    inp.style.height = "auto";
    inp.style.height = Math.min(inp.scrollHeight, 200) + "px";
  });
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  $("attach-btn").onclick = () => $("file-input").click();
  $("file-input").onchange = (e) => {
    handleFiles([...e.target.files]);
    e.target.value = "";
  };

  const main = $("main");
  let depth = 0;
  main.addEventListener("dragenter", (e) => {
    if (e.dataTransfer.types.includes("Files")) {
      depth++;
      main.classList.add("dragging");
    }
  });
  main.addEventListener("dragover", (e) => {
    if (e.dataTransfer.types.includes("Files")) e.preventDefault();
  });
  main.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (!depth) main.classList.remove("dragging");
  });
  main.addEventListener("drop", (e) => {
    e.preventDefault();
    depth = 0;
    main.classList.remove("dragging");
    handleFiles([...e.dataTransfer.files]);
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());

  updateStatus();
  renderSidebar();
  renderMessages();
  if (!state.key) openSettings();
}
function updateStatus() {
  $("status").innerHTML = state.key
    ? `<span class="dot ok"></span>${state.model}`
    : `<span class="dot bad"></span>未設定 API key`;
}
function updateRagBtn() {
  $("rag-btn").classList.toggle("on", state.useRag);
}

init();
