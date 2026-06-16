import type {
  BgStatus,
  Citation,
  Conversation,
  RagDocument,
  SandboxFileMeta,
  ToolCallTrace,
  UIMessage,
  ArtifactMeta,
} from "./types";

export async function fetchConversations(): Promise<Conversation[]> {
  const res = await fetch("/api/conversations");
  if (!res.ok) throw new Error("Failed to load conversations");
  return res.json();
}

export async function createConversationApi(
  title: string,
): Promise<Conversation> {
  const res = await fetch("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error("Failed to create conversation");
  return res.json();
}

export async function fetchConversation(
  id: string,
): Promise<{
  conversation: Conversation;
  messages: UIMessage[];
  rootChildId: string | null;
}> {
  const res = await fetch(`/api/conversations/${id}`);
  if (!res.ok) throw new Error("Failed to load conversation");
  return res.json();
}

/** Repair invalid Mermaid via the model; null if unavailable. */
export async function fixMermaidApi(code: string): Promise<string | null> {
  try {
    const res = await fetch("/api/fix-mermaid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return typeof data.code === "string" ? data.code : null;
  } catch {
    return null;
  }
}

/** Select which child branch is active under a node (or the root if parentId null). */
export async function setActiveBranch(
  conversationId: string,
  parentId: string | null,
  childId: string,
): Promise<void> {
  await fetch(`/api/conversations/${conversationId}/branch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parentId, childId }),
  });
}

export async function renameConversationApi(
  id: string,
  title: string,
): Promise<void> {
  await fetch(`/api/conversations/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title }),
  });
}

export async function deleteConversationApi(id: string): Promise<void> {
  await fetch(`/api/conversations/${id}`, { method: "DELETE" });
}

export async function saveMessage(
  conversationId: string,
  message: UIMessage,
): Promise<void> {
  await fetch(`/api/conversations/${conversationId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });
}

/**
 * Start a server-authoritative generation. Returns the assistant message id the
 * answer will stream into (over the conversation's SSE channel). The generation
 * runs in the background on the server, so it survives this device closing.
 */
export async function startTurn(args: {
  conversationId: string;
  parentId: string;
  assistantMessageId: string;
  useRag?: boolean;
  useGrok?: boolean;
}): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok && res.status !== 202) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
}

/** Best-effort cancel of an in-flight server generation. */
export async function cancelTurn(messageId: string): Promise<void> {
  await fetch("/api/chat/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageId }),
  }).catch(() => {});
}

export async function truncateAfter(
  conversationId: string,
  afterMessageId: string,
): Promise<void> {
  await fetch(`/api/conversations/${conversationId}/truncate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ afterMessageId }),
  });
}

export async function uploadSandboxFiles(
  conversationId: string,
  files: File[],
): Promise<SandboxFileMeta[]> {
  const form = new FormData();
  files.forEach((f) => form.append("files", f));
  const res = await fetch(`/api/sandbox/${conversationId}/upload`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "upload failed");
  }
  const data = await res.json();
  return (data.files ?? []) as SandboxFileMeta[];
}

export async function fetchSandboxFiles(
  conversationId: string,
): Promise<SandboxFileMeta[]> {
  const res = await fetch(`/api/sandbox/${conversationId}/files`);
  if (!res.ok) return [];
  const data = await res.json();
  return (data.files ?? []) as SandboxFileMeta[];
}

/** Download selected sandbox files packed into a tar. */
export async function downloadSandboxArchive(
  conversationId: string,
  names: string[],
): Promise<void> {
  const res = await fetch(`/api/sandbox/${conversationId}/archive`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ names }),
  });
  if (!res.ok) throw new Error("archive failed");
  const blob = await res.blob();
  triggerDownload(blob, "sandbox.tar");
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function forkConversationApi(
  conversationId: string,
  messageId: string,
): Promise<Conversation> {
  const res = await fetch(`/api/conversations/${conversationId}/fork`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageId }),
  });
  if (!res.ok) throw new Error("Fork failed");
  return res.json();
}

// --- Skills ----------------------------------------------------------------

export interface SkillInfo {
  name: string;
  description: string;
  body: string;
}

export async function fetchSkills(): Promise<SkillInfo[]> {
  try {
    const res = await fetch("/api/skills");
    if (!res.ok) return [];
    return res.json();
  } catch {
    return [];
  }
}

// --- Documents (RAG) -------------------------------------------------------

export async function fetchDocuments(): Promise<RagDocument[]> {
  const res = await fetch("/api/documents");
  if (!res.ok) throw new Error("Failed to load documents");
  return res.json();
}

export async function uploadDocuments(
  files: File[],
): Promise<{ documents: RagDocument[]; errors: { name: string; error: string }[] }> {
  const form = new FormData();
  files.forEach((f) => form.append("files", f));
  const res = await fetch("/api/documents", { method: "POST", body: form });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Upload failed");
  }
  return res.json();
}

export async function deleteDocumentApi(id: string): Promise<void> {
  await fetch(`/api/documents/${id}`, { method: "DELETE" });
}

// --- Health & config -------------------------------------------------------

export interface HealthStatus {
  ok: boolean;
  target?: "local" | "grok";
  models?: string[];
  chatModel?: string;
  embeddingModel?: string;
  chatLoaded?: boolean;
  embedLoaded?: boolean;
  error?: string;
  baseURL?: string;
}

export async function fetchHealth(): Promise<HealthStatus> {
  try {
    const res = await fetch("/api/health");
    return res.json();
  } catch {
    return { ok: false, error: "network error" };
  }
}

export interface AppConfig {
  baseURL: string;
  chatModel: string;
  embeddingModel: string;
  rag: { chunkSize: number; chunkOverlap: number; topK: number };
  background: {
    maxConcurrentGlobal: number;
    maxConcurrentPerConversation: number;
  };
  sop: {
    intentGate: boolean;
    verifyGate: boolean;
    blocking: boolean;
    strictMonitor: boolean;
    maxCorrections: number;
    maxStructuredRetries: number;
  };
  grok: { enabled: boolean; model: string };
}

export async function fetchAppConfig(): Promise<AppConfig> {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error("Failed to load config");
  return res.json();
}

// --- Background jobs & SOP console ----------------------------------------

export interface BackgroundJob {
  id: string;
  conversationId: string;
  command: string;
  status: BgStatus;
  exitCode: number | null;
  log: string | null;
  logTail?: string;
  startedAt: number;
  timeoutAt: number;
  endedAt: number | null;
}

export interface SopControlEvent {
  id: string;
  conversationId: string | null;
  messageId: string | null;
  phase:
    | "intent_check"
    | "tool_policy_check"
    | "execution_check"
    | "answer_check"
    | "correction_loop"
    | "emit"
    | "refuse";
  status: "pass" | "fail";
  violations: string[];
  correctionRounds: number;
  action: string;
  createdAt: number;
}

export async function fetchBackgroundJobs(params: {
  conversationId?: string | null;
  status?: BgStatus | null;
  limit?: number;
} = {}): Promise<BackgroundJob[]> {
  const q = new URLSearchParams();
  if (params.conversationId) q.set("conversationId", params.conversationId);
  if (params.status) q.set("status", params.status);
  if (params.limit) q.set("limit", String(params.limit));
  const res = await fetch(`/api/background/jobs${q.size ? `?${q}` : ""}`);
  if (!res.ok) throw new Error("Failed to load background jobs");
  const data = await res.json();
  return (data.jobs ?? []) as BackgroundJob[];
}

export async function fetchBackgroundJob(id: string): Promise<BackgroundJob> {
  const res = await fetch(`/api/background/jobs/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error("Failed to load background job");
  const data = await res.json();
  return data.job as BackgroundJob;
}

export async function killBackgroundJobApi(id: string): Promise<void> {
  const res = await fetch(
    `/api/background/jobs/${encodeURIComponent(id)}/kill`,
    { method: "POST" },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to kill job");
  }
}

export async function fetchSopEvents(params: {
  conversationId?: string | null;
  limit?: number;
} = {}): Promise<SopControlEvent[]> {
  const q = new URLSearchParams();
  if (params.conversationId) q.set("conversationId", params.conversationId);
  if (params.limit) q.set("limit", String(params.limit));
  const res = await fetch(`/api/sop/events${q.size ? `?${q}` : ""}`);
  if (!res.ok) throw new Error("Failed to load SOP events");
  const data = await res.json();
  return (data.events ?? []) as SopControlEvent[];
}

// --- Runtime settings ------------------------------------------------------

export interface RuntimeSettings {
  chatTarget: "local" | "grok";
  chatModel: string;
  grokModel: string;
  grokAvailable: boolean;
  strictMonitor: boolean;
  availableModels: string[];
  systemPrompt: string;
  defaultSystemPrompt: string;
}

export async function fetchSettings(): Promise<RuntimeSettings> {
  const res = await fetch("/api/settings");
  if (!res.ok) throw new Error("Failed to load settings");
  return res.json();
}

export async function updateSettings(
  patch: {
    chatModel?: string;
    strictMonitor?: boolean;
    chatTarget?: "local" | "grok";
    systemPrompt?: string;
  },
): Promise<void> {
  await fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

function decodeB64Json<T>(header: string | null, fallback: T): T {
  if (!header) return fallback;
  try {
    const bytes = Uint8Array.from(atob(header), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return fallback;
  }
}

/** Decode the base64(UTF-8 JSON) X-Citations response header. */
export function parseCitationsHeader(header: string | null): Citation[] {
  return decodeB64Json<Citation[]>(header, []);
}

/** Decode the base64(UTF-8 JSON) X-Images response header (generated images). */
export function parseImagesHeader(header: string | null): string[] {
  return decodeB64Json<string[]>(header, []);
}

/** Decode the base64(UTF-8 JSON) X-Videos response header (generated videos). */
export function parseVideosHeader(header: string | null): string[] {
  return decodeB64Json<string[]>(header, []);
}

// Markers on streamed Grok responses (kept in sync with grok/responses.ts).
export const MEDIA_MARKER = "<<<XAI_MEDIA>>>";
export const TOOL_MARKER = "<<<XAI_TOOL>>>";

/** Extract live tool-call traces from the stream and return clean text. */
export function parseStreamingText(raw: string): {
  text: string;
  toolCalls: ToolCallTrace[];
} {
  const beforeMedia = raw.split(MEDIA_MARKER)[0];
  const toolCalls: ToolCallTrace[] = [];
  const re = new RegExp(`\\n?${TOOL_MARKER}([A-Za-z0-9+/=]+)\\n?`, "g");
  const text = beforeMedia.replace(re, (_full, b64: string) => {
    const t = decodeB64Json<ToolCallTrace | null>(b64, null);
    if (t) toolCalls.push(t);
    return "";
  });
  return { text, toolCalls };
}

export interface StreamMedia {
  text: string;
  citations: Citation[];
  images: string[];
  videos: string[];
  files: SandboxFileMeta[];
  artifacts: ArtifactMeta[];
}

/** Split a streamed body into answer text and trailing media metadata. */
export function parseMediaSentinel(full: string): StreamMedia {
  const idx = full.indexOf(MEDIA_MARKER);
  if (idx < 0)
    return {
      text: full,
      citations: [],
      images: [],
      videos: [],
      files: [],
      artifacts: [],
    };
  const text = full.slice(0, idx).replace(/\s+$/, "");
  const media = decodeB64Json<{
    citations?: Citation[];
    images?: string[];
    videos?: string[];
    files?: SandboxFileMeta[];
    artifacts?: ArtifactMeta[];
  }>(full.slice(idx + MEDIA_MARKER.length), {});
  return {
    text,
    citations: media.citations ?? [],
    images: media.images ?? [],
    videos: media.videos ?? [],
    files: media.files ?? [],
    artifacts: media.artifacts ?? [],
  };
}
