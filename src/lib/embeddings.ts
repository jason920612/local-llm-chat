import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { llm } from "./llm";
import { config } from "./config";

type WorkerResponse =
  | { id: string; ok: true; vectors: number[][] }
  | { id: string; ok: false; error: string };

type PendingRequest = {
  resolve: (vectors: number[][]) => void;
  reject: (err: Error) => void;
};

let worker: ChildProcessWithoutNullStreams | null = null;
let workerSeq = 0;
const pending = new Map<string, PendingRequest>();

function embeddingProvider(): "local" | "lmstudio" | "auto" {
  const provider = config.llm.embeddingProvider;
  if (provider === "local" || provider === "lmstudio" || provider === "auto") {
    return provider;
  }
  return "local";
}

async function embedWithLmStudio(texts: string[]): Promise<number[][]> {
  const res = await llm.embeddings.create({
    model: config.llm.embeddingModel,
    input: texts,
  });
  // Preserve input order (the API returns an `index` per item).
  return res.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding as number[]);
}

function rejectPending(err: Error): void {
  for (const request of pending.values()) request.reject(err);
  pending.clear();
}

function localWorker(): ChildProcessWithoutNullStreams {
  if (worker && !worker.killed) return worker;
  const script = path.join(process.cwd(), "scripts", "local-embedder.mjs");
  worker = spawn(process.execPath, [script], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  const lines = readline.createInterface({ input: worker.stdout });
  lines.on("line", (line) => {
    let msg: WorkerResponse;
    try {
      msg = JSON.parse(line) as WorkerResponse;
    } catch {
      return;
    }
    const request = pending.get(msg.id);
    if (!request) return;
    pending.delete(msg.id);
    if (msg.ok) request.resolve(msg.vectors);
    else request.reject(new Error(msg.error));
  });

  worker.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) console.warn(`[local-embedder] ${text}`);
  });
  worker.on("exit", (code, signal) => {
    const err = new Error(
      `local embedder exited (${signal ?? code ?? "unknown"})`,
    );
    worker = null;
    rejectPending(err);
  });
  return worker;
}

async function embedWithLocalModel(texts: string[]): Promise<number[][]> {
  const proc = localWorker();
  const id = `embed-${Date.now()}-${++workerSeq}`;
  const payload = {
    id,
    texts,
    model: config.llm.localEmbeddingModel,
    cacheDir: config.llm.localEmbeddingCacheDir,
  };
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    proc.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
      if (!err) return;
      pending.delete(id);
      reject(err);
    });
  });
}

/**
 * Embed one or more strings. Default provider starts a local Transformers.js
 * worker automatically; LM Studio remains available through EMBEDDING_PROVIDER.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const provider = embeddingProvider();
  if (provider === "local") return embedWithLocalModel(texts);
  if (provider === "lmstudio") return embedWithLmStudio(texts);

  try {
    return await embedWithLmStudio(texts);
  } catch {
    return embedWithLocalModel(texts);
  }
}

export async function embedOne(text: string): Promise<number[]> {
  const [v] = await embed([text]);
  return v;
}

/** Pack a float vector into a Buffer for BLOB storage. */
export function vectorToBlob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

/** Unpack a BLOB back into a Float32Array. */
export function blobToVector(blob: Buffer): Float32Array {
  return new Float32Array(
    blob.buffer,
    blob.byteOffset,
    blob.byteLength / 4,
  );
}

/** Cosine similarity between a query vector and a stored vector. */
export function cosineSimilarity(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
