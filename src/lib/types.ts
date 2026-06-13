export type Role = "user" | "assistant" | "system";

/** A message as used by the UI and persisted to the DB. */
export interface UIMessage {
  id: string;
  role: Role;
  content: string;
  /** Base64 data URLs for attached images (vision), or generated image URLs. */
  images?: string[];
  /** Generated video URLs (Grok Imagine). */
  videos?: string[];
  /** Files produced in the conversation sandbox by code execution. */
  files?: SandboxFileMeta[];
  /** Trace of tools the model invoked this turn (with their arguments). */
  toolCalls?: ToolCallTrace[];
  /** Citations resolved from RAG retrieval, if any. */
  citations?: Citation[];
  createdAt?: number;
}

export interface ToolCallTrace {
  tool: string;
  args?: Record<string, unknown>;
}

export interface SandboxFileMeta {
  name: string;
  size: number;
  isText: boolean;
}

export interface Citation {
  index: number;
  documentId: string;
  documentName: string;
  snippet: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export interface RagDocument {
  id: string;
  name: string;
  type: string;
  size: number;
  chunkCount: number;
  createdAt: number;
}

export interface ChatRequestBody {
  messages: Pick<UIMessage, "role" | "content" | "images">[];
  conversationId?: string;
  /** Whether to ground the answer in uploaded documents. */
  useRag?: boolean;
  /** Whether to expose the Grok X/web search tool to the model. */
  useGrok?: boolean;
}
