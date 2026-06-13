export type Role = "user" | "assistant" | "system";

/** A message as used by the UI and persisted to the DB. */
export interface UIMessage {
  id: string;
  role: Role;
  content: string;
  /** Base64 data URLs for attached images (vision). */
  images?: string[];
  /** Citations resolved from RAG retrieval, if any. */
  citations?: Citation[];
  createdAt?: number;
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
}
