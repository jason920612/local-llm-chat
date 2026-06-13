import type { Citation, Conversation, RagDocument, UIMessage } from "./types";

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
): Promise<{ conversation: Conversation; messages: UIMessage[] }> {
  const res = await fetch(`/api/conversations/${id}`);
  if (!res.ok) throw new Error("Failed to load conversation");
  return res.json();
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

/** Decode the base64(UTF-8 JSON) X-Citations response header. */
export function parseCitationsHeader(header: string | null): Citation[] {
  if (!header) return [];
  try {
    const bytes = Uint8Array.from(atob(header), (c) => c.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);
    return JSON.parse(json) as Citation[];
  } catch {
    return [];
  }
}
