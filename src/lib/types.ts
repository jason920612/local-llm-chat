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
  /** Validated rich artifacts (mermaid/chart/html) placed via [[artifact:N]]. */
  artifacts?: ArtifactMeta[];
  /** Trace of tools the model invoked this turn (with their arguments). */
  toolCalls?: ToolCallTrace[];
  /** Citations resolved from RAG retrieval, if any. */
  citations?: Citation[];
  createdAt?: number;
  /** Message-tree links: the message this one follows (null/undefined = a root). */
  parentId?: string | null;
  /** Which child branch is currently selected under this message (remembered). */
  activeChildId?: string | null;
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

export interface ArtifactMeta {
  /** Renderer to use for this artifact. */
  type: "mermaid" | "chart" | "html";
  /** The validated source (mermaid text / Vega-Lite JSON / HTML document). */
  spec: string;
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
