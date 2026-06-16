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
  /** Server-side generation state for streaming assistant messages. */
  status?: "streaming" | "done" | "error";
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
  type: "mermaid" | "chart" | "html" | "tradingview";
  /**
   * The validated source: mermaid text / Vega-Lite JSON / HTML document, or for
   * "tradingview" a JSON config { mode, symbol, widget?, interval?, candles?, … }.
   */
  spec: string;
}

export interface Citation {
  index: number;
  documentId: string;
  documentName: string;
  snippet: string;
  /** Real web page <title> (web/x search sources), fetched best-effort. */
  title?: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

export type BgStatus =
  | "running"
  | "exited"
  | "killed"
  | "timeout"
  | "terminated";

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
  /** Assistant message id for SOP/job telemetry correlation. */
  messageId?: string;
  /** Whether to ground the answer in uploaded documents. */
  useRag?: boolean;
  /** Whether to expose the Grok X/web search tool to the model. */
  useGrok?: boolean;
}
