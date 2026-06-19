import { NextRequest } from "next/server";
import { nanoid } from "nanoid";
import { historyThrough } from "@/lib/repo";
import { startGeneration } from "@/lib/live/generations";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // background generation (video polling) can be long

/**
 * Start a server-authoritative generation. Unlike the old streaming handler,
 * this does NOT stream the answer back on the request — it kicks off a
 * background generation (which persists to the DB and broadcasts tokens over
 * SSE) and returns immediately. Every device receives the output via the
 * conversation's SSE stream, and closing a device never interrupts it.
 *
 * Body: { conversationId, parentId, assistantMessageId?, useRag?, useGrok? }
 *   - parentId: the message the answer follows (usually the user turn). Must
 *     already be persisted; the server rebuilds the prompt history from the DB.
 */
export async function POST(req: NextRequest) {
  let body: {
    conversationId?: string;
    parentId?: string | null;
    assistantMessageId?: string;
    useRag?: boolean;
    useGrok?: boolean;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const conversationId = body.conversationId;
  const parentId = body.parentId ?? null;
  if (!conversationId || !parentId) {
    return Response.json(
      { error: "conversationId and parentId are required." },
      { status: 400 },
    );
  }

  // Rebuild the prompt history from the DB (server is the source of truth).
  const history = historyThrough(conversationId, parentId);
  if (history.length === 0) {
    return Response.json(
      { error: "parent message not found." },
      { status: 404 },
    );
  }

  const assistantMessageId = body.assistantMessageId || nanoid();
  const started = startGeneration({
    conversationId,
    assistantMessageId,
    parentId,
    body: {
      conversationId,
      useRag: body.useRag,
      useGrok: body.useGrok,
      messages: history.map((m) => ({
        role: m.role,
        content: m.content,
        images: m.images,
      })),
    },
  });
  if (!started) {
    return Response.json(
      { error: "A generation is already running for this conversation." },
      { status: 409 },
    );
  }

  return Response.json(
    { ok: true, generationId: assistantMessageId },
    { status: 202 },
  );
}
